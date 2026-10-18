@app.cli.command('db-upgrade')
@with_appcontext
def db_upgrade():
    """Create missing tables, add missing columns, and run one-time data migrations."""
    _run_schema_upgrades()
    _run_post_schema_data_migrations()

@app.cli.command('startup-maintenance')
@with_appcontext
def startup_maintenance():
    """Run non-schema startup maintenance exactly once before the app starts serving."""
    if not _can_run_startup_maintenance():
        raise click.ClickException(
            f'Schema not initialized yet for {redact_database_uri()} -- run `flask --app app db-upgrade` first'
        )
    _run_startup_maintenance()

# BUG FIX M1: known FK relations to re-validate after a copy that ran with
# foreign key checks disabled. Includes logical relations that the models do
# not declare as DB-level FOREIGN KEYs (replica tables reference file/note ids
# as plain indexed columns, so MySQL could never enforce them anyway).
_COPY_FK_RELATIONS = (
    # (child_table, child_column, parent_table, parent_column)
    ('folder', 'parent_id', 'folder', 'id'),
    ('file', 'folder_id', 'folder', 'id'),
    ('note', 'notebook_id', 'notebook', 'id'),
    ('file_replica', 'file_id', 'file', 'id'),
    ('file_replica', 'node_id', 'storage_node', 'id'),
    ('note_replica', 'note_id', 'note', 'id'),
    ('note_replica', 'node_id', 'storage_node', 'id'),
    ('thumbnail_replica', 'file_id', 'file', 'id'),
    ('thumbnail_replica', 'node_id', 'storage_node', 'id'),
    ('music_playlist_song', 'playlist_id', 'music_playlist', 'id'),
    ('pending_note', 'sender_id', 'user', 'id'),
    ('pending_note', 'recipient_id', 'user', 'id'),
)


def _validate_copy_foreign_keys(conn, table_names):
    """Detect FK-orphaned rows after a copy ran with FK checks disabled.

    BUG FIX M1: `SET FOREIGN_KEY_CHECKS=0` imports FK-violating rows silently and
    MySQL never re-validates existing rows when checks are re-enabled. LEFT-JOINs
    each known relation and returns `[(relation_label, orphan_count, sample_ids), ...]`;
    an empty list means clean. Read-only -- violations are reported by the caller,
    never repaired here.
    """
    present = set(table_names)
    preparer = conn.engine.dialect.identifier_preparer
    violations = []
    for child_table, child_column, parent_table, parent_column in _COPY_FK_RELATIONS:
        if child_table not in present or parent_table not in present:
            continue
        child_q = preparer.quote(child_table)
        parent_q = preparer.quote(parent_table)
        child_col_q = preparer.quote(child_column)
        parent_col_q = preparer.quote(parent_column)
        orphan_sql = text(
            f'SELECT COUNT(*) FROM {child_q} AS c '
            f'LEFT JOIN {parent_q} AS p ON c.{child_col_q} = p.{parent_col_q} '
            f'WHERE c.{child_col_q} IS NOT NULL AND p.{parent_col_q} IS NULL'
        )
        orphan_count = int(conn.execute(orphan_sql).scalar() or 0)
        if not orphan_count:
            continue
        sample_sql = text(
            f'SELECT DISTINCT c.{child_col_q} FROM {child_q} AS c '
            f'LEFT JOIN {parent_q} AS p ON c.{child_col_q} = p.{parent_col_q} '
            f'WHERE c.{child_col_q} IS NOT NULL AND p.{parent_col_q} IS NULL '
            f'LIMIT 5'
        )
        sample_ids = [str(value) for value in conn.execute(sample_sql).scalars()]
        violations.append((
            f'{child_table}.{child_column} -> {parent_table}.{parent_column}',
            orphan_count,
            sample_ids,
        ))
    return violations


@app.cli.command('db-copy-from-sqlite')
@click.option('--source-path', default=DEFAULT_SQLITE_DB_PATH, show_default=True, help='Path to the source SQLite database file.')
@click.option('--allow-nonempty', is_flag=True, help='Allow copying into a target database that already has rows.')
@click.option('--chunk-size', default=500, show_default=True, type=int, help='Rows to insert per batch.')
@with_appcontext
def db_copy_from_sqlite(source_path, allow_nonempty, chunk_size):
    """Copy all app tables from a SQLite database into the configured target database.

    BUG FIX M1: per-table row counts are verified on EVERY run (also under
    --allow-nonempty); a retry with --allow-nonempty resumes past tables whose
    target count already matches the source and refuses partially copied tables;
    after the copy, known FK relations are re-validated (the import disables FK
    checks). Any mismatch exits nonzero.
    """
    if chunk_size < 1:
        raise click.ClickException('chunk-size must be at least 1')

    source_path = os.path.abspath(source_path)
    if not os.path.exists(source_path):
        raise click.ClickException(f'Source SQLite database not found: {source_path}')

    source_uri = f'sqlite:///{source_path}'
    target_uri = app.config['SQLALCHEMY_DATABASE_URI']
    if source_uri == target_uri:
        raise click.ClickException('Source SQLite database and target database are the same')

    print(f'[DB] Source SQLite database: {source_path}')
    print(f'[DB] Target database: {redact_database_uri(target_uri)}')

    _run_schema_upgrades()

    source_engine = create_engine(source_uri)
    source_metadata = MetaData()
    source_metadata.reflect(bind=source_engine)
    target_backend = get_database_backend_name(target_uri)
    target_table_names = [table.name for table in db.metadata.sorted_tables]

    with source_engine.connect() as source_conn, db.engine.connect() as target_conn:
        if not allow_nonempty:
            nonempty_tables = [
                table_name for table_name in target_table_names
                if _database_row_count(target_conn, table_name) > 0
            ]
            if nonempty_tables:
                joined_tables = ', '.join(nonempty_tables)
                raise click.ClickException(f'Target database is not empty: {joined_tables}. Re-run with --allow-nonempty if this is intentional.')

        if target_backend == 'mysql':
            target_conn.execute(text('SET FOREIGN_KEY_CHECKS=0'))
            target_conn.commit()
        elif target_backend == 'sqlite':
            target_conn.execute(text('PRAGMA foreign_keys=OFF'))

        try:
            copied_tables = 0
            copied_rows = 0
            resumed_tables = []
            for table in db.metadata.sorted_tables:
                table_name = table.name
                if table_name not in source_metadata.tables:
                    print(f'[DB] Skipping {table_name}: table not present in source SQLite database')
                    continue

                source_table = source_metadata.tables[table_name]
                source_columns = {column.name for column in source_table.columns}
                target_columns = [column.name for column in table.columns if column.name in source_columns]
                source_total = _database_row_count(source_conn, table_name)

                if source_total == 0:
                    print(f'[DB] Skipping {table_name}: source table is empty')
                    continue

                # BUG FIX M1: make --allow-nonempty retries safe. Re-inserting into a
                # partially-copied table caused duplicate-PK IntegrityErrors or silent
                # duplication. A table whose target count already equals the source
                # count is resumed past; a partially copied table is a hard error
                # (row counts cannot tell which rows landed, so auto-resume would guess).
                target_total_before = _database_row_count(target_conn, table_name)
                if allow_nonempty and target_total_before > 0:
                    if target_total_before == source_total:
                        print(f'[DB] Skipping {table_name}: target already holds {target_total_before} row(s), matching source (resume)')
                        resumed_tables.append(table_name)
                        continue
                    raise click.ClickException(
                        f'Table {table_name} is partially copied: source has {source_total} row(s), target has {target_total_before}. '
                        'Cannot resume safely -- truncate the affected table (or restore a clean target) and re-run with --allow-nonempty.'
                    )

                print(f'[DB] Copying {source_total} row(s) into {table_name}')
                batch = []
                inserted = 0
                for row in source_conn.execute(source_table.select()).mappings():
                    batch.append({column_name: row[column_name] for column_name in target_columns})
                    if len(batch) >= chunk_size:
                        target_conn.execute(table.insert(), batch)
                        inserted += len(batch)
                        batch = []
                if batch:
                    target_conn.execute(table.insert(), batch)
                    inserted += len(batch)
                target_conn.commit()
                copied_tables += 1
                copied_rows += inserted
                print(f'[DB] Copied {inserted} row(s) into {table_name}')

            if resumed_tables:
                print(f'[DB] Resumed past {len(resumed_tables)} already-complete table(s): {", ".join(resumed_tables)}')

            # BUG FIX M1: verification used to be skipped entirely under --allow-nonempty
            # (expected_total=None), so a partial copy could exit success. Verify EVERY
            # non-empty source table on EVERY run, including resumed tables.
            count_mismatches = []
            for table in db.metadata.sorted_tables:
                table_name = table.name
                if table_name not in source_metadata.tables:
                    continue
                source_total = _database_row_count(source_conn, table_name)
                if source_total == 0:
                    continue
                target_total = _database_row_count(target_conn, table_name)
                if target_total != source_total:
                    count_mismatches.append((table_name, source_total, target_total))
            if count_mismatches:
                details = ', '.join(
                    f'{name} (source={source_total}, target={target_total})'
                    for name, source_total, target_total in count_mismatches
                )
                raise click.ClickException(
                    f'Row count verification FAILED for {len(count_mismatches)} table(s): {details}'
                )
            print('[DB] Row count verification passed for all non-empty source tables')

            print(f'[DB] Copied {copied_rows} row(s) across {copied_tables} table(s)')
        finally:
            if target_backend == 'mysql':
                target_conn.execute(text('SET FOREIGN_KEY_CHECKS=1'))
                target_conn.commit()
            elif target_backend == 'sqlite':
                target_conn.execute(text('PRAGMA foreign_keys=ON'))

        # BUG FIX M1: the copy ran with FK checks disabled, so FK-violating rows
        # would have been imported silently (MySQL never re-validates existing rows
        # when checks are turned back on). LEFT-JOIN the known relations and fail
        # loudly if any parent row is missing; no automatic repair is attempted.
        fk_violations = _validate_copy_foreign_keys(target_conn, target_table_names)
        if fk_violations:
            details = '; '.join(
                f'{relation}: {orphan_count} orphaned row(s), sample ids={sample}'
                for relation, orphan_count, sample in fk_violations
            )
            raise click.ClickException(f'Foreign key orphan validation FAILED: {details}')
        print(f'[DB] Foreign key orphan validation passed ({len(_COPY_FK_RELATIONS)} relation(s) checked)')

    source_engine.dispose()
    _run_post_schema_data_migrations()

@app.cli.command('cleanup')
@with_appcontext
def cleanup():
    cleanup_expired_files()
    cleanup_orphaned_files()
    cleanup_orphaned_notes()
    cleanup_stale_preps()
    cleanup_stale_progress()
    cleanup_stale_security_state()
    cleanup_remote_staging_files()
    cleanup_temp_dirs()
    cleanup_stale_music_sync()

@app.cli.command('storage-remote-cleanup')
@click.option('--node-id', 'node_ids', multiple=True, type=int, help='Limit cleanup to one or more remote storage node IDs.')
@click.option('--apply', is_flag=True, help='Actually delete remote temp objects and stale B2 object versions.')
@with_appcontext
def storage_remote_cleanup(node_ids, apply):
    """Dry-run or execute remote storage cleanup for stale temp keys and B2 history."""
    report = storage.cleanup_remote_storage(node_ids=node_ids, apply=apply)
    mode = 'APPLY' if apply else 'DRY RUN'
    print(f'[STORAGE] Remote cleanup mode: {mode}')
    if not report['nodes']:
        print('[STORAGE] No enabled remote nodes matched the requested scope')
        return

    for node in report['nodes']:
        print(f'[STORAGE] Node {node["node_id"]} ({node["node_name"]}, {node["node_type"]}) mode={node["mode"]} status={node["status"]}')
        for category, category_report in node['categories'].items():
            if node['mode'] == 'b2_versions':
                print(
                    f'[STORAGE]   {category}: keys={category_report["keys_seen"]}, '
                    f'purged={category_report["keys_purged"]}, pruned={category_report["keys_pruned"]}, '
                    f'skipped={category_report["keys_skipped"]}, versions={category_report["versions_deleted"]}'
                )
            else:
                print(
                    f'[STORAGE]   {category}: internal_keys={category_report["artifact_keys_seen"]}, '
                    f'deleted={category_report["artifact_keys_deleted"]}'
                )
            sample_actions = category_report.get('actions', [])[:10]
            for action in sample_actions:
                if node['mode'] == 'b2_versions':
                    print(
                        f'[STORAGE]     {action["action"]}: {category}/{action["file_id"]} '
                        f'({action["reason"]}, versions={len(action.get("delete_version_ids", []))})'
                    )
                else:
                    print(f'[STORAGE]     purge: {category}/{action["file_id"]} ({action["reason"]})')
            hidden_count = max(0, len(category_report.get('actions', [])) - len(sample_actions))
            if hidden_count:
                print(f'[STORAGE]     ... {hidden_count} more action(s) omitted')
        for error in node['errors']:
            print(f'[STORAGE]   ERROR: {error}')

    totals = report['totals']
    print(
        f'[STORAGE] Remote cleanup totals: nodes_seen={totals["nodes_seen"]}, '
        f'nodes_cleaned={totals["nodes_cleaned"]}, keys_with_actions={totals["keys_with_actions"]}, '
        f'versions_deleted={totals["versions_deleted"]}, current_artifacts_deleted={totals["current_artifacts_deleted"]}, '
        f'skipped={totals["skipped"]}, errors={totals["errors"]}'
    )
    if not apply:
        print('[STORAGE] DRY RUN ONLY — re-run with --apply to execute the cleanup')

@app.cli.command('purge')
@with_appcontext
def purge():
    import shutil
    import click

    if os.environ.get('ALLOW_DESTRUCTIVE_PURGE', '').lower() not in ('true', '1', 'yes'):
        raise click.ClickException('REFUSING TO PURGE: SET ALLOW_DESTRUCTIVE_PURGE=true TO CONFIRM THIS DESTRUCTIVE DEV-ONLY OPERATION')
    if not os.path.basename(os.path.abspath(basedir)).lower().endswith('_dev'):
        raise click.ClickException(f'REFUSING TO PURGE OUTSIDE DEV WORKTREE: {basedir}')

    # AUDIT FIX D12: purge claimed to wipe "database, uploads and thumbnails" but
    # never touched notes/ -- every encrypted note payload survived on local disk
    # AND on every remote storage node after an operation the operator believes
    # erased everything. Remote copies must be removed BEFORE drop_all(), because
    # a PendingRemoteDelete tombstone queued now would itself be dropped with the
    # rest of the schema (and _remote_delete_target_node_ids() reads StorageNode,
    # which would be gone too). So the remote objects are deleted directly here.
    _remote_note_ids = []
    try:
        _remote_note_ids = [row[0] for row in db.session.query(Note.id).all()]
    except Exception as e:
        print(f'[PURGE] Could not enumerate notes for remote wipe: {e}')
    if _remote_note_ids:
        _remote_backends = [
            (nid, backend) for nid, backend in getattr(storage, '_backends', {}).items()
            if nid != getattr(storage, '_local_node_id', None)
        ]
        _remote_removed = 0
        for note_id in _remote_note_ids:
            for nid, backend in _remote_backends:
                try:
                    backend.delete('notes', note_id)
                    _remote_removed += 1
                except Exception as e:
                    print(f'[PURGE] Failed to remove note {note_id} from node {nid}: {e}')
        if _remote_backends:
            print(f'[PURGE] Removed {_remote_removed} remote note object(s) across {len(_remote_backends)} node(s)')

    db.session.remove()
    db.engine.dispose()
    if get_database_backend_name() == 'sqlite':
        if os.path.exists(DEFAULT_SQLITE_DB_PATH):
            os.remove(DEFAULT_SQLITE_DB_PATH)
            print(f'[PURGE] Deleted database: {DEFAULT_SQLITE_DB_PATH}')
        else:
            print(f'[PURGE] No database file found at {DEFAULT_SQLITE_DB_PATH}')
        db.create_all()
        print(f'[PURGE] Recreated empty database at {DEFAULT_SQLITE_DB_PATH}')
    else:
        db.drop_all()
        db.create_all()
        print(f'[PURGE] Dropped and recreated all tables on {redact_database_uri()}')

    # --- Wipe uploads directory contents ---
    uploads_dir = app.config['UPLOAD_FOLDER']
    if os.path.exists(uploads_dir):
        removed = 0
        for entry in os.listdir(uploads_dir):
            entry_path = os.path.join(uploads_dir, entry)
            try:
                if os.path.isfile(entry_path) or os.path.islink(entry_path):
                    os.remove(entry_path)
                elif os.path.isdir(entry_path):
                    shutil.rmtree(entry_path)
                removed += 1
            except Exception as e:
                print(f'[PURGE] Error removing {entry_path}: {e}')
        print(f'[PURGE] Cleared {removed} entries from uploads directory')

    # --- Wipe thumbnails directory contents ---
    thumbnails_dir = os.path.join(basedir, 'thumbnails')
    if os.path.exists(thumbnails_dir):
        removed = 0
        for entry in os.listdir(thumbnails_dir):
            entry_path = os.path.join(thumbnails_dir, entry)
            try:
                if os.path.isfile(entry_path) or os.path.islink(entry_path):
                    os.remove(entry_path)
                elif os.path.isdir(entry_path):
                    shutil.rmtree(entry_path)
                removed += 1
            except Exception as e:
                print(f'[PURGE] Error removing {entry_path}: {e}')
        print(f'[PURGE] Cleared {removed} entries from thumbnails directory')

    # --- Wipe notes directory contents (AUDIT FIX D12) ---
    if os.path.exists(NOTES_DIR):
        removed = 0
        for entry in os.listdir(NOTES_DIR):
            entry_path = os.path.join(NOTES_DIR, entry)
            try:
                if os.path.isfile(entry_path) or os.path.islink(entry_path):
                    os.remove(entry_path)
                elif os.path.isdir(entry_path):
                    shutil.rmtree(entry_path)
                removed += 1
            except Exception as e:
                print(f'[PURGE] Error removing {entry_path}: {e}')
        print(f'[PURGE] Cleared {removed} entries from notes directory')

    print(f'[PURGE] Complete purge finished — database, uploads, thumbnails, and notes wiped')
    check_storage()

def cleanup_stale_preps():
    """Reap prepared downloads that can no longer make progress, plus their
    decrypted plaintext temp files.

    AUDIT FIX (upload/download integrity): this used to age states ONLY by
    'created_at' and `continue` past any state where that field was missing or
    unparseable -- exactly the states _update_prep_state() produced after a read
    failure -- so those held a concurrency slot forever and, after
    MAX_CONCURRENT_PREPS such events, every large browser download returned 503
    SERVER BUSY until an operator deleted files by hand. Staleness is now
    measured from the state file's mtime as well (which an active prep refreshes
    on every progress tick), an unclaimed 'ready' state is reaped after a much
    shorter TTL so decrypted plaintext does not sit in the clear for 30 minutes,
    and undatable/ownerless states fail CLOSED. See reap_stale_prep_states()."""
    import glob as _glob
    reaped = reap_stale_prep_states()
    if reaped:
        print(f'[CLEANUP] Cleaned up {reaped} stale download preparations')

    # Clean up orphaned temp files left by crashes during atomic writes.
    # Writes now use unique names ('<prep_id>.<rand>.tmp' plus the legacy
    # '<prep_id>.json.tmp'), so both patterns are swept.
    tmp_cutoff = time.time() - 1800  # 30 minutes
    tmp_count = 0
    _stale_tmp_files = list(_glob.glob(os.path.join(_PREP_STATE_DIR, '*.tmp')))
    for tmp_file in _stale_tmp_files:
        try:
            if os.path.getmtime(tmp_file) < tmp_cutoff:
                os.remove(tmp_file)
                tmp_count += 1
        except OSError:
            pass
    if tmp_count:
        print(f'[CLEANUP] Cleaned up {tmp_count} stale prep .tmp files')

def cleanup_stale_progress():
    """Remove stale upload progress JSON files from /tmp/fileshare_progress/ older than 30 minutes."""
    cutoff = time.time() - 1800  # 30 minutes
    count = 0
    try:
        if not os.path.isdir(_PROGRESS_DIR):
            return
        for filename in os.listdir(_PROGRESS_DIR):
            filepath = os.path.join(_PROGRESS_DIR, filename)
            try:
                if os.path.isfile(filepath) and os.path.getmtime(filepath) < cutoff:
                    os.remove(filepath)
                    count += 1
            except OSError:
                pass
    except Exception as e:
        print(f'[CLEANUP] Error cleaning stale progress files: {e}')
    if count:
        print(f'[CLEANUP] Cleaned up {count} stale upload progress files')

def cleanup_remote_staging_files():
    """Remove stale temp cache/staging files from all storage directories."""
    ttl_minutes = get_numeric_setting('storage_cache_ttl_minutes')
    cutoff = time.time() - (ttl_minutes * 60)
    removed = 0
    for directory in [app.config['UPLOAD_FOLDER'], NOTES_DIR, THUMBNAILS_DIR]:
        try:
            for filename in os.listdir(directory):
                if not (
                    filename.startswith('.cache_') or
                    filename.startswith('.remote_') or
                    filename.startswith('repl_') or
                    filename.endswith('.sftp_tmp') or
                    filename.endswith('.s3_tmp') or
                    filename.endswith('.tmp')
                ):
                    continue
                path = os.path.join(directory, filename)
                try:
                    if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                        os.remove(path)
                        removed += 1
                except Exception as e:
                    print(f'[CLEANUP] Error removing staging file {path}: {e}')
        except Exception:
            pass
    if removed:
        print(f'[CLEANUP] Cleaned up {removed} stale cache files (TTL={ttl_minutes}m)')

_cache_purge_single_copy_warned = False

def cleanup_local_staged_files():
    """Remove local canonical files that have been fully replicated to verified
    remote nodes and exceed the cache TTL. Only runs in cache mode (no local
    StorageNode configured). Files written to local disk as a staging area are
    cleaned up after they are confirmed synced to at least
    LOCAL_PURGE_MIN_VERIFIED_REMOTE_COPIES verified remote mirrors AND older
    than the TTL."""
    # Only relevant in cache mode (no local node tracked)
    if storage._local_node_id is not None:
        return
    enabled_nodes = StorageNode.query.filter_by(is_enabled=True).all()
    if not enabled_nodes:
        return
    remote_node_ids = [n.id for n in enabled_nodes]
    remote_node_count = len(remote_node_ids)
    if remote_node_count == 0:
        return
    ttl_minutes = get_numeric_setting('storage_cache_ttl_minutes')
    cutoff = time.time() - (ttl_minutes * 60)
    required_verified_copies = min(storage.LOCAL_PURGE_MIN_VERIFIED_REMOTE_COPIES, remote_node_count)
    # AUDIT FIX M10: REFUSE to purge the last LOCAL copy when there are fewer
    # remote nodes than the redundancy floor, unless an admin explicitly opts in
    # via the allow_single_copy_local_purge setting. Previously the floor was
    # silently capped at remote_node_count (min(...)), so a single-remote-node
    # deployment deleted the only local copy after just ONE remote verification —
    # one subsequent remote failure then meant permanent data loss. Retaining the
    # local staging copy keeps redundancy at the cost of disk until another remote
    # node is added.
    global _cache_purge_single_copy_warned
    if remote_node_count < storage.LOCAL_PURGE_MIN_VERIFIED_REMOTE_COPIES:
        if not get_setting('allow_single_copy_local_purge'):
            if not _cache_purge_single_copy_warned:
                _cache_purge_single_copy_warned = True
                print(f'[CLEANUP] [WARNING] Cache-mode local purge SKIPPED: only '
                      f'{remote_node_count} remote storage node(s) configured but the '
                      f'redundancy floor is {storage.LOCAL_PURGE_MIN_VERIFIED_REMOTE_COPIES} '
                      f'verified copies. Local staging copies are RETAINED to avoid a single '
                      f'point of failure. Add another remote node, or set '
                      f'allow_single_copy_local_purge=true to opt in to single-copy purging.')
            return
        if not _cache_purge_single_copy_warned:
            _cache_purge_single_copy_warned = True
            print(f'[CLEANUP] [WARNING] Cache-mode local purge running with only '
                  f'{remote_node_count} remote node(s) and allow_single_copy_local_purge=true — '
                  f'local copies will be reclaimed leaving {remote_node_count} remote copy(ies) '
                  f'(operator-acknowledged single point of failure).')
    removed_files = 0
    removed_notes = 0
    removed_thumbs = 0
    bytes_freed = 0
    # Clean up staged files
    all_files = File.query.with_entities(File.id).all()
    for (fid,) in all_files:
        filename = f'{fid}.enc'
        if not storage._local_backend.exists('files', filename):
            continue
        try:
            mtime = storage._local_backend.getmtime('files', filename)
            if mtime > cutoff:
                continue
        except Exception:
            continue
        # Require a minimum number of *verified* synced copies, not all nodes
        verified_remote = FileReplica.query.filter(
            FileReplica.file_id == fid,
            FileReplica.node_id.in_(remote_node_ids),
            FileReplica.status == 'synced',
            FileReplica.checksum.isnot(None),
            FileReplica.size_bytes.isnot(None),
        ).count()
        if verified_remote < required_verified_copies:
            continue
        # Recompute local checksum fresh from disk (no legacy DB blob fallback)
        local_path = storage._local_backend.get_path('files', filename)
        try:
            local_checksum = storage._sha256_file(local_path)
            local_size = os.path.getsize(local_path)
        except Exception:
            continue
        file_obj = db.session.get(File, fid)
        if not file_obj:
            continue
        if not file_obj.payload_checksum:
            print(f'[CLEANUP] Skipping staged file purge for {fid}: no File.payload_checksum')
            continue
        if local_checksum != file_obj.payload_checksum:
            print(f'[CLEANUP] Skipping staged file purge for {fid}: local checksum mismatch')
            continue
        # Verify enough remote copies match the local checksum
        matching_node_ids = [r.node_id for r in FileReplica.query.filter(
            FileReplica.file_id == fid,
            FileReplica.node_id.in_(remote_node_ids),
            FileReplica.status == 'synced',
            FileReplica.checksum == local_checksum,
        ).all()]
        if len(matching_node_ids) < required_verified_copies:
            continue
        # AUDIT FIX (live verification before destructive local purge): the DB
        # synced rows + recorded checksums can be stale — a remote object may
        # have silently vanished or been corrupted AFTER its row was marked
        # synced. This is the LAST canonical copy (cache mode has no local
        # StorageNode), so re-verify the matching remote replicas LIVE (re-stat
        # + re-hash) before deleting. If any can't be confirmed right now, keep
        # the local copy and retry next cycle — purge is opportunistic, so a
        # temporarily-unverifiable remote just defers reclaim, never risks the
        # only good copy.
        if not storage._all_remote_nodes_verified('files', fid, matching_node_ids):
            print(f'[CLEANUP] Skipping staged file purge for {fid}: live remote verification failed')
            continue
        size = local_size or 0
        # Same fence as the notes branch: a rewrite (save-content, E2E
        # conversion) may have published a new generation after the remote
        # verification above, and that generation has no remote copy yet.
        file_lock = _acquire_file_rewrite_lock(fid)
        try:
            db.session.rollback()
            fresh_file = db.session.get(File, fid)
            fresh_path = storage._local_backend.get_path('files', filename)
            generation_changed = (
                fresh_file is None
                or fresh_file.payload_checksum != local_checksum
                or not os.path.isfile(fresh_path)
                or os.path.getsize(fresh_path) != local_size
                or storage._sha256_file(fresh_path) != local_checksum
            )
            if generation_changed:
                print(f'[CLEANUP] Skipping staged file purge for {fid}: payload generation changed after remote verification')
                continue
            storage._local_backend.delete('files', filename)
            removed_files += 1
            bytes_freed += size
        except Exception as e:
            print(f'[CLEANUP] Error removing staged file {filename}: {e}')
        finally:
            _release_file_rewrite_lock(file_lock)
    # Clean up staged notes
    all_notes = Note.query.with_entities(Note.id).all()
    for (note_id,) in all_notes:
        if not storage._local_backend.exists('notes', note_id):
            continue
        try:
            mtime = storage._local_backend.getmtime('notes', note_id)
            if mtime > cutoff:
                continue
        except Exception:
            continue
        verified_remote = NoteReplica.query.filter(
            NoteReplica.note_id == note_id,
            NoteReplica.node_id.in_(remote_node_ids),
            NoteReplica.status == 'synced',
            NoteReplica.checksum.isnot(None),
        ).count()
        if verified_remote < required_verified_copies:
            continue
        note_obj = db.session.get(Note, note_id)
        if not note_obj:
            continue
        local_path = storage._local_backend.get_path('notes', note_id)
        try:
            local_checksum = storage._sha256_file(local_path)
            local_size = os.path.getsize(local_path)
        except Exception:
            continue
        expected_version = int(note_obj.content_version or 1)
        matching_node_ids = [r.node_id for r in NoteReplica.query.filter(
            NoteReplica.note_id == note_id,
            NoteReplica.node_id.in_(remote_node_ids),
            NoteReplica.status == 'synced',
            NoteReplica.checksum == local_checksum,
            NoteReplica.synced_version == expected_version,
        ).all()]
        if len(matching_node_ids) < required_verified_copies:
            continue
        # AUDIT FIX (live verification before destructive local purge): re-verify
        # the matching remote note replicas LIVE before deleting the last local
        # copy, in case a remote object vanished/corrupted after being marked
        # synced. Defer purge if any can't be confirmed right now.
        if not storage._all_remote_nodes_verified('notes', note_id, matching_node_ids):
            print(f'[CLEANUP] Skipping staged note purge for {note_id}: live remote verification failed')
            continue
        note_lock = _acquire_note_rewrite_lock(note_id)
        try:
            db.session.rollback()
            fresh_note = db.session.get(Note, note_id)
            fresh_path = storage._local_backend.get_path('notes', note_id)
            generation_changed = (
                fresh_note is None
                or int(fresh_note.content_version or 1) != expected_version
                or fresh_note.content_checksum != local_checksum
                or not os.path.isfile(fresh_path)
                or os.path.getsize(fresh_path) != local_size
                or storage._sha256_file(fresh_path) != local_checksum
            )
            if generation_changed:
                print(f'[CLEANUP] Skipping staged note purge for {note_id}: content generation changed after remote verification')
                continue
            storage._local_backend.delete('notes', note_id)
            removed_notes += 1
        except Exception as e:
            print(f'[CLEANUP] Error removing staged note {note_id}: {e}')
        finally:
            _release_note_rewrite_lock(note_lock)
    # Clean up staged thumbnails
    for (fid,) in all_files:
        for thumb_type, ext in [('jpg', '.jpg'), ('e2e', '.e2e')]:
            thumb_id = f'{fid}{ext}'
            if not storage._local_backend.exists('thumbnails', thumb_id):
                continue
            try:
                mtime = storage._local_backend.getmtime('thumbnails', thumb_id)
                if mtime > cutoff:
                    continue
            except Exception:
                continue
            verified_remote = ThumbnailReplica.query.filter(
                ThumbnailReplica.file_id == fid,
                ThumbnailReplica.thumb_type == thumb_type,
                ThumbnailReplica.node_id.in_(remote_node_ids),
                ThumbnailReplica.status == 'synced',
                ThumbnailReplica.checksum.isnot(None),
            ).count()
            if verified_remote < required_verified_copies:
                continue
            local_path = storage._local_backend.get_path('thumbnails', thumb_id)
            try:
                local_checksum = storage._sha256_file(local_path)
                local_size = os.path.getsize(local_path)
            except Exception:
                continue
            matching_node_ids = [r.node_id for r in ThumbnailReplica.query.filter(
                ThumbnailReplica.file_id == fid,
                ThumbnailReplica.thumb_type == thumb_type,
                ThumbnailReplica.node_id.in_(remote_node_ids),
                ThumbnailReplica.status == 'synced',
                ThumbnailReplica.checksum == local_checksum,
            ).all()]
            if len(matching_node_ids) < required_verified_copies:
                continue
            # AUDIT FIX (live verification before destructive local purge):
            # re-verify the matching remote thumbnail replicas LIVE before
            # deleting the last local copy; defer if any can't be confirmed now.
            if not storage._all_remote_nodes_verified('thumbnails', fid, matching_node_ids, thumb_type=thumb_type):
                print(f'[CLEANUP] Skipping staged thumbnail purge for {thumb_id}: live remote verification failed')
                continue
            size = local_size or 0
            try:
                storage._local_backend.delete('thumbnails', thumb_id)
                removed_thumbs += 1
                bytes_freed += size
            except Exception as e:
                print(f'[CLEANUP] Error removing staged thumbnail {thumb_id}: {e}')
    total = removed_files + removed_notes + removed_thumbs
    if total > 0:
        mb_freed = bytes_freed / (1024 * 1024)
        print(f'[CLEANUP] Cleaned up {removed_files} staged files, {removed_notes} notes, {removed_thumbs} thumbnails ({mb_freed:.1f} MB freed, TTL={ttl_minutes}m, required_verified={required_verified_copies})')

# AUDIT FIX D7: legacy (pre-namespacing) working directories still sitting in
# /tmp are matched by an EXACT name shape, not a bare prefix glob. 'upload_' and
# 'api_upload_' are deliberately absent: those directories are created inside
# UPLOAD_FOLDER, never in /tmp, so any /tmp/upload_* match could only ever have
# belonged to an unrelated process.
_LEGACY_WORK_DIR_PATTERNS = [
    re.compile(r'^(?:reencrypt|blank_e2e|edit_e2e|edit)_[0-9a-fA-F-]{36}_[A-Za-z0-9_]+$'),
    re.compile(r'^(?:browse_all_dl|browse_subfolder_dl|browse_zip|browse_dl|folder_download|audio_preview|vidthumb)_[A-Za-z0-9_]+$'),
]

def _is_legacy_work_dir_name(name):
    return any(pattern.match(name) for pattern in _LEGACY_WORK_DIR_PATTERNS)

def cleanup_temp_dirs():
    """Remove abandoned working directories left by interrupted operations.

    AUDIT FIX D7: a directory is only removed when NOTHING inside it (including
    its liveness marker) has been touched for the whole idle window. The old
    check looked at the directory's own mtime, which does not advance while a
    single large file inside it is being written -- so a long upload or a
    multi-GB ZIP build had its working directory deleted mid-write."""
    idle_seconds = 1800  # 30 minutes with no activity anywhere inside the dir
    cutoff = time.time() - idle_seconds
    removed = 0

    def _maybe_remove(path):
        nonlocal removed
        try:
            if not os.path.isdir(path):
                return
            last_activity = _work_dir_last_activity(path)
            if last_activity is None:
                # Unreadable => cannot prove it is abandoned => leave it alone.
                print(f'[CLEANUP] [WARNING] Could not determine activity for {path}; leaving it in place')
                return
            if last_activity >= cutoff:
                return
            shutil.rmtree(path)
            removed += 1
            print(f'[CLEANUP] Removed abandoned work dir: {path} (idle {int(time.time() - last_activity)}s)')
        except Exception as e:
            print(f'[CLEANUP] Error removing temp dir {path}: {e}')

    # Namespaced working directories (the only place new ones are created).
    try:
        if os.path.isdir(ONEGY_TEMP_ROOT):
            for name in os.listdir(ONEGY_TEMP_ROOT):
                _maybe_remove(os.path.join(ONEGY_TEMP_ROOT, name))
    except Exception as e:
        print(f'[CLEANUP] Error listing work-dir root {ONEGY_TEMP_ROOT}: {e}')

    # Legacy directories created before the namespacing change.
    try:
        tmp_root = tempfile.gettempdir()
        for name in os.listdir(tmp_root):
            if not _is_legacy_work_dir_name(name):
                continue
            _maybe_remove(os.path.join(tmp_root, name))
    except Exception as e:
        print(f'[CLEANUP] Error listing {tempfile.gettempdir()} for legacy work dirs: {e}')

    if removed:
        print(f'[CLEANUP] Cleaned up {removed} abandoned work directories')

