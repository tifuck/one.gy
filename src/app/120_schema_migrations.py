_DB_STARTUP_TABLES = (
    'user', 'folder', 'file', 'note', 'storage_node',
    'file_replica', 'note_replica', 'thumbnail_replica',
)

_DB_EXTRA_INDEXES = [
    ('ix_file_user_trash_temp_folder', 'file', ['registered_user_id', 'is_trashed', 'is_temp_upload', 'folder_id']),
    ('ix_folder_parent_trash', 'folder', ['parent_id', 'is_trashed']),
    ('ix_folder_user_trash', 'folder', ['user_id', 'is_trashed']),
    # AUDIT Tier 1 — Composite indexes for hot query patterns.
    # Replication batch query (every 10s, app.py:replication cycle):
    ('ix_filereplica_status_node',  'file_replica',      ['status', 'node_id']),
    ('ix_notereplica_status_node',  'note_replica',      ['status', 'node_id']),
    ('ix_thumbreplica_status_node', 'thumbnail_replica', ['status', 'node_id']),
    # Dashboard sort + temp listing ORDER BY upload_time DESC:
    ('ix_file_user_temp_trash_upload', 'file', ['registered_user_id', 'is_temp_upload', 'is_trashed', 'upload_time']),
    # Guest temp file listing (user_id is the guest session id):
    ('ix_file_userid_temp_expires', 'file', ['user_id', 'is_temp_upload', 'expires_at']),
    # Notes app hot paths:
    ('ix_note_user_trash',          'note', ['user_id', 'is_trashed']),
    ('ix_note_user_notebook_trash', 'note', ['user_id', 'notebook_id', 'is_trashed']),
    ('ix_notebook_user_trash',      'notebook', ['user_id', 'is_trashed']),
    # NotificationDismissal lookups on every page render:
    ('ix_notifdismiss_user_notif',    'notification_dismissal', ['user_id', 'notification_id']),
    ('ix_notifdismiss_visitor_notif', 'notification_dismissal', ['visitor_id', 'notification_id']),
    # AUDIT FIX M1 — PendingRemoteDelete hot paths: the deferred-delete
    # batch query filters on (category, last_attempt) every 10s, and the
    # tombstone guards filter on category. Without these a large backlog
    # table-scans.
    ('ix_pendingdelete_category_lastattempt', 'pending_remote_delete', ['category', 'last_attempt']),
    # API key list-my-keys queries:
    ('ix_apikey_user_active', 'api_key', ['user_id', 'is_active']),
    # Folder duplicate-name collision check on create/rename:
    ('ix_folder_user_parent_name', 'folder', ['user_id', 'parent_id', 'name']),
    # AUDIT FIX (finding 20, perf): tombstone lookups filter on
    # (category, file_id) -- _clear_pending_remote_deletes_for() runs on every
    # upload/create path and the deferred-delete worker's guard joins on the
    # same pair. Without the composite, a backlog table-scans within the
    # category index.
    ('ix_pendingdelete_category_fileid', 'pending_remote_delete', ['category', 'file_id']),
]


def _quote_identifier_for_dialect(dialect, identifier):
    return dialect.identifier_preparer.quote(identifier)


def _quote_identifier(identifier):
    return _quote_identifier_for_dialect(db.engine.dialect, identifier)


def _database_row_count(conn, table_name):
    quoted_table = _quote_identifier_for_dialect(conn.engine.dialect, table_name)
    return int(conn.execute(text(f'SELECT COUNT(*) FROM {quoted_table}')).scalar() or 0)


def _order_by_nulls_first_asc(column):
    return (case((column.is_(None), 0), else_=1), column.asc())


def _column_default_sql(column):
    if column.server_default is not None:
        default_arg = getattr(column.server_default, 'arg', None)
        if default_arg is not None:
            return str(default_arg)
    default = getattr(column, 'default', None)
    if default is None or not getattr(default, 'is_scalar', False):
        return None
    value = default.arg
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return None


def _ensure_missing_model_columns():
    inspector = inspect(db.engine)
    table_names = set(inspector.get_table_names())
    added_columns = []
    for table in db.metadata.sorted_tables:
        if table.name not in table_names:
            continue
        existing_columns = {col['name'] for col in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in existing_columns:
                continue
            default_sql = _column_default_sql(column)
            if not column.nullable and default_sql is None:
                raise RuntimeError(f'Cannot add non-nullable column without scalar default: {table.name}.{column.name}')
            column_type = column.type.compile(dialect=db.engine.dialect)
            sql = f'ALTER TABLE {_quote_identifier(table.name)} ADD COLUMN {_quote_identifier(column.name)} {column_type}'
            if default_sql is not None:
                sql += f' DEFAULT {default_sql}'
            if not column.nullable:
                sql += ' NOT NULL'
            db.session.execute(text(sql))
            db.session.commit()
            print(f'[DB] Added {column.name} column to {table.name} table')
            added_columns.append((table.name, column.name))
            existing_columns.add(column.name)
            inspector = inspect(db.engine)
    return added_columns


def _widen_longtext_columns():
    """Widen existing TEXT columns that a model now declares as LONGTEXT.

    _ensure_missing_model_columns() only ADDs columns, so a type widened on the
    model never reaches an existing database. MODIFY to a wider text type keeps
    every value (same table collation); nothing is ever narrowed."""
    if get_database_backend_name() != 'mysql':
        return
    inspector = inspect(db.engine)
    table_names = set(inspector.get_table_names())
    for table in db.metadata.sorted_tables:
        if table.name not in table_names:
            continue
        existing = {col['name']: col['type'] for col in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.type.compile(dialect=db.engine.dialect) != 'LONGTEXT':
                continue
            if column.name not in existing or isinstance(existing[column.name], LONGTEXT):
                continue
            sql = (f'ALTER TABLE {_quote_identifier(table.name)} MODIFY COLUMN '
                   f'{_quote_identifier(column.name)} LONGTEXT'
                   f'{"" if column.nullable else " NOT NULL"}')
            db.session.execute(text(sql))
            db.session.commit()
            print(f'[DB] Widened {table.name}.{column.name} to LONGTEXT')


# AUDIT FIX A9/A19: declared on the models (so db.create_all() builds them on a
# fresh database) but applied to an EXISTING database only through
# _ensure_unique_indexes(), which refuses to fail the boot on pre-existing
# duplicate rows.
_MODEL_UNIQUE_INDEX_NAMES = frozenset({
    'uq_notifdismiss_notif_user',
    'uq_notifdismiss_notif_visitor',
    'uq_notebook_user_system_key',
    'uq_file_node',
    'uq_note_node',
    'uq_thumb_node',
    'uq_file_upload_key_registered',
    'uq_file_upload_key_manager',
    'uq_file_upload_key_guest',
    'uq_folder_dedupe_sibling',
})

_UNIQUE_INDEX_SPECS = [
    ('uq_notifdismiss_notif_user', 'notification_dismissal',
     ['notification_id', 'user_id'], 'user_id', None),
    ('uq_notifdismiss_notif_visitor', 'notification_dismissal',
     ['notification_id', 'visitor_id'], 'visitor_id', None),
    ('uq_notebook_user_system_key', 'notebook',
     ['user_id', 'system_key'], 'system_key', None),
    ('uq_file_node', 'file_replica', ['file_id', 'node_id'], 'node_id', FileReplica),
    ('uq_note_node', 'note_replica', ['note_id', 'node_id'], 'node_id', NoteReplica),
    ('uq_thumb_node', 'thumbnail_replica',
     ['file_id', 'thumb_type', 'node_id'], 'node_id', ThumbnailReplica),
    # AUDIT FIX M9: DB-level backstop for the idempotency writers. The key/
    # token columns are CLIENT-SUPPLIED, so uniqueness is scoped per owner to
    # mirror _find_existing_upload_by_key() / _find_live_folder_creation_winner().
    ('uq_file_upload_key_registered', 'file',
     ['registered_user_id', 'upload_idempotency_key'], 'upload_idempotency_key', None),
    ('uq_file_upload_key_manager', 'file',
     ['manager_cookie_id', 'upload_idempotency_key'], 'upload_idempotency_key', None),
    ('uq_file_upload_key_guest', 'file',
     ['user_id', 'upload_idempotency_key'], 'upload_idempotency_key', None),
    ('uq_folder_dedupe_sibling', 'folder',
     ['user_id', 'parent_id', 'client_dedupe_token'], 'client_dedupe_token', None),
]


def _table_exists(inspector, table_name):
    try:
        return table_name in set(inspector.get_table_names())
    except Exception:
        return False


def _ensure_model_indexes():
    """Create every declared index, non-fatally.

    AUDIT FIX A7: the failure policy used to be inconsistent -- model-declared
    indexes were created inside a try/except that only printed, but the
    _DB_EXTRA_INDEXES composites ran as a bare db.session.execute(). Any failure
    there (a partially-created index from a killed DDL, a permissions problem, a
    lock-wait timeout on a large online CREATE INDEX) propagated out of
    `flask db-upgrade` and, via `set -euo pipefail` in start.sh, took the whole
    service down before gunicorn ever bound the port. A missing index is a
    performance problem; a service that will not boot is an outage. Every index
    is now best-effort and a failure is logged LOUDLY as a warning."""
    ensured = 0
    missing = []
    for table in db.metadata.sorted_tables:
        for index in table.indexes:
            # The additive UNIQUE indexes are owned by _ensure_unique_indexes(),
            # which pre-checks existing rows for duplicates first. Creating them
            # blindly here would just produce a confusing duplicate failure.
            if index.name in _MODEL_UNIQUE_INDEX_NAMES:
                continue
            try:
                index.create(bind=db.engine, checkfirst=True)
                ensured += 1
            except Exception as e:
                try:
                    db.session.rollback()
                except Exception:
                    pass
                missing.append(index.name)
                print(f'[WARNING] [DB] Could not ensure index {index.name} on {table.name}: {e}')
    inspector = inspect(db.engine)
    for index_name, table_name, columns in _DB_EXTRA_INDEXES:
        try:
            if not _table_exists(inspector, table_name):
                continue
            existing_indexes = {idx['name'] for idx in inspector.get_indexes(table_name)}
            if index_name in existing_indexes:
                continue
            quoted_columns = ', '.join(_quote_identifier(col) for col in columns)
            sql = f'CREATE INDEX {_quote_identifier(index_name)} ON {_quote_identifier(table_name)} ({quoted_columns})'
            db.session.execute(text(sql))
            db.session.commit()
            ensured += 1
            print(f'[DB] Created index {index_name}')
            inspector = inspect(db.engine)
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            missing.append(index_name)
            print(f'[WARNING] [DB] Could not create index {index_name} on {table_name}: {e}')
    _ensure_unique_indexes()
    if ensured:
        print(f'[DB] Ensured {ensured} index definitions exist')
    if missing:
        print(f'[WARNING] [DB] {len(missing)} index definition(s) are MISSING and queries against them '
              f'will table-scan: {", ".join(sorted(set(missing)))}')


def _collapse_duplicate_replica_rows(rows, model):
    """Keep one replica row, retaining verified evidence only when it agrees."""
    keeper = min(rows, key=lambda row: row.id)
    outstanding = any(row.status in ('pending', 'syncing') for row in rows)
    reliable = [
        row for row in rows
        if row.status == 'synced' and row.checksum_verified is True and row.checksum
    ]
    evidence_fields = ['checksum']
    if model in (FileReplica, ThumbnailReplica):
        evidence_fields.append('size_bytes')
    else:
        evidence_fields.extend(['synced_version', 'target_version'])
    unambiguous = (not outstanding) and bool(reliable) and all(
        len({getattr(row, field) for row in reliable if getattr(row, field) is not None}) <= 1
        for field in evidence_fields
    )

    if unambiguous:
        source = max(reliable, key=lambda row: row.id)
        keeper.status = 'synced'
        keeper.checksum_verified = True
        keeper.verified_at = source.verified_at
        for field in evidence_fields:
            values = [getattr(row, field) for row in reliable if getattr(row, field) is not None]
            setattr(keeper, field, values[0] if values else None)
    else:
        keeper.status = 'pending'
        keeper.checksum = None
        keeper.checksum_verified = None
        keeper.verified_at = None
        if model in (FileReplica, ThumbnailReplica):
            keeper.size_bytes = None
        else:
            keeper.synced_version = None
            versions = [int(row.target_version) for row in rows if row.target_version is not None]
            keeper.target_version = max(versions) if versions else None
    keeper.error_count = 0
    keeper.last_error = None
    return keeper, [row for row in rows if row is not keeper]


def _deduplicate_replica_rows(model, columns):
    column_attrs = [getattr(model, column) for column in columns]
    duplicate_keys = db.session.query(*column_attrs).group_by(*column_attrs).having(
        db.func.count(model.id) > 1
    ).all()
    removed = 0
    for key in duplicate_keys:
        values = tuple(key) if hasattr(key, '_mapping') else tuple(key if isinstance(key, tuple) else (key,))
        rows = model.query.filter_by(**dict(zip(columns, values))).order_by(model.id).all()
        _keeper, extras = _collapse_duplicate_replica_rows(rows, model)
        for row in extras:
            db.session.delete(row)
            removed += 1
    if removed:
        db.session.commit()
        print(f'[DB] Collapsed {removed} duplicate {model.__tablename__} row(s) before enforcing uniqueness')
    return removed


def _deduplicate_identical_rows(model, columns):
    """AUDIT FIX A9 backstop: collapse duplicates that are identical in effect.

    Keep the lowest-id row of each duplicate group and delete the rest
    (mirrors _deduplicate_replica_rows, for tables whose rows carry no state
    to merge -- a dismissal is a boolean). Only fully-NULL-free groups count:
    a group containing NULLs can never violate the unique index (NULLs are
    DISTINCT), so those rows must not be collapsed or swept into a repair."""
    column_attrs = [getattr(model, column) for column in columns]
    duplicate_keys = db.session.query(*column_attrs).filter(
        *[attr.isnot(None) for attr in column_attrs]
    ).group_by(*column_attrs).having(
        db.func.count(model.id) > 1
    ).all()
    removed = 0
    for key in duplicate_keys:
        values = tuple(key) if hasattr(key, '_mapping') else tuple(key if isinstance(key, tuple) else (key,))
        rows = model.query.filter_by(**dict(zip(columns, values))).order_by(model.id).all()
        for row in rows[1:]:
            db.session.delete(row)
            removed += 1
    if removed:
        db.session.commit()
        print(f'[DB] Collapsed {removed} duplicate {model.__tablename__} row(s) before enforcing uniqueness')
    return removed


def _deduplicate_notebook_system_key_rows(model, columns):
    """AUDIT FIX A19 backstop: merge duplicate (user_id, system_key) notebooks.

    Keep the lowest-id notebook of each duplicate group, re-point its notes to
    it, then delete the extras, so uq_notebook_user_system_key can actually be
    created on a database that carries legacy duplicates. Only fully-NULL-free groups count:
    a group containing NULLs can never violate the unique index (NULLs are
    DISTINCT), so those rows must not be collapsed or swept into a repair."""
    column_attrs = [getattr(model, column) for column in columns]
    duplicate_keys = db.session.query(*column_attrs).filter(
        *[attr.isnot(None) for attr in column_attrs]
    ).group_by(*column_attrs).having(
        db.func.count(model.id) > 1
    ).all()
    removed = 0
    re_pointed = 0
    for key in duplicate_keys:
        values = tuple(key) if hasattr(key, '_mapping') else tuple(key if isinstance(key, tuple) else (key,))
        rows = model.query.filter_by(**dict(zip(columns, values))).order_by(model.id).all()
        keeper, extras = rows[0], rows[1:]
        for extra in extras:
            re_pointed += Note.query.filter_by(notebook_id=extra.id).update(
                {'notebook_id': keeper.id}, synchronize_session=False)
            db.session.delete(extra)
            removed += 1
    if removed:
        db.session.commit()
        print(f'[DB] Merged {removed} duplicate system notebook(s) into their lowest-id sibling and '
              f're-pointed {re_pointed} note(s) before enforcing uniqueness')
    return removed


def _release_duplicate_idempotency_tokens(model, columns):
    """AUDIT FIX M9: free duplicate idempotency tokens WITHOUT deleting rows.

    file/folder rows are user data (payloads, share links, children), so unlike
    the replica/dismissal repairs this keeps every row: the lowest-id LIVE row
    of each duplicate group keeps its token (the idempotency anchor) and the
    token is released (set to NULL) on every other row of the group. Released
    rows can no longer be matched by the idempotency lookups -- which is
    exactly the dedup outcome -- and the per-owner UNIQUE index can then be
    created. Trashed rows in a group always lose their token: no lookup can
    ever match them again. Only fully-NULL-free groups count:
    a group containing NULLs can never violate the unique index (NULLs are
    DISTINCT), so those rows must not be collapsed or swept into a repair."""
    token_column = columns[-1]
    column_attrs = [getattr(model, column) for column in columns]
    duplicate_keys = db.session.query(*column_attrs).filter(
        *[attr.isnot(None) for attr in column_attrs]
    ).group_by(*column_attrs).having(
        db.func.count(model.id) > 1
    ).all()
    released = 0
    for key in duplicate_keys:
        values = tuple(key) if hasattr(key, '_mapping') else tuple(key if isinstance(key, tuple) else (key,))
        rows = model.query.filter_by(**dict(zip(columns, values))).order_by(model.id).all()
        live_rows = [row for row in rows if not getattr(row, 'is_trashed', False)]
        keeper = (live_rows or rows)[0]
        for row in rows:
            if row is keeper:
                continue
            setattr(row, token_column, None)
            released += 1
    if released:
        db.session.commit()
        print(f'[DB] Released duplicate {model.__tablename__}.{token_column} value(s) on {released} row(s) '
              f'(kept the lowest-id live row per group; no rows deleted) before enforcing uniqueness')
    return released


# AUDIT FIX M9: repair strategy per non-replica unique index, run by
# _ensure_unique_indexes() before each create attempt (and re-run on every
# startup until the index exists). Values are (repair_function, model); the
# signature mirrors _deduplicate_replica_rows(model, columns).
_UNIQUE_ROW_DEDUPERS = {
    'uq_notifdismiss_notif_user': (_deduplicate_identical_rows, NotificationDismissal),
    'uq_notifdismiss_notif_visitor': (_deduplicate_identical_rows, NotificationDismissal),
    'uq_notebook_user_system_key': (_deduplicate_notebook_system_key_rows, Notebook),
    'uq_file_upload_key_registered': (_release_duplicate_idempotency_tokens, File),
    'uq_file_upload_key_manager': (_release_duplicate_idempotency_tokens, File),
    'uq_file_upload_key_guest': (_release_duplicate_idempotency_tokens, File),
    'uq_folder_dedupe_sibling': (_release_duplicate_idempotency_tokens, Folder),
}


def _warn_unenforced_idempotency_scopes():
    """AUDIT FIX M9: log duplicates in dedup scopes a UNIQUE index CANNOT
    express. Root-level folders have parent_id IS NULL and NULLs are DISTINCT
    in a unique index, so uq_folder_dedupe_sibling cannot cover them; they keep
    relying on the advisory folder creation lock. Anything that slipped past it
    is logged loudly here on every startup so the gap stays visible."""
    try:
        inspector = inspect(db.engine)
        if not _table_exists(inspector, 'folder'):
            return
        rows = db.session.execute(text(
            'SELECT user_id, client_dedupe_token, COUNT(*) AS n, GROUP_CONCAT(id) AS ids '
            'FROM folder '
            'WHERE parent_id IS NULL AND client_dedupe_token IS NOT NULL AND is_trashed = 0 '
            'GROUP BY user_id, client_dedupe_token HAVING n > 1 LIMIT 20'
        )).all()
    except Exception:
        return
    for user_id, token, count, ids in rows:
        print(f'[WARNING] [DB] UNENFORCED idempotency scope: {count} live root-level folders of user '
              f'{user_id} share client_dedupe_token {token!r} (folder ids: {ids}). Root folders are not '
              f'covered by uq_folder_dedupe_sibling because MySQL treats NULL parent_id rows as distinct; '
              f'they rely on the advisory folder creation lock only.')


def _ensure_unique_indexes():
    """Create additive UNIQUE indexes, repairing duplicate rows first.

    AUDIT FIX A9/A19: NotificationDismissal and Notebook.system_key both relied
    on a check-then-insert with no constraint behind it, so two concurrent
    requests could both insert. Uniqueness is enforced in the database now.

    AUDIT FIX M9: File.upload_idempotency_key (three per-owner scopes) and
    Folder.client_dedupe_token relied on advisory locks with no DB-level
    backstop; per-owner UNIQUE indexes close that gap.

    A UNIQUE index cannot be added blindly to a live table: if existing rows
    contain duplicates the CREATE fails. Every spec therefore carries a repair
    strategy that runs BEFORE the create attempt, and the whole attempt
    (repair + create) is retried on EVERY startup until it converges:
    replica duplicates collapse to a conservative pending state unless
    verified evidence agrees; NotificationDismissal duplicates are identical
    in effect (keep lowest id); duplicate system notebooks are merged into the
    lowest-id one with their notes re-pointed; duplicate file/folder
    idempotency tokens are RELEASED (set to NULL) on the non-keeper rows
    rather than deleting user data. Anything still blocking is logged at
    WARNING each boot. NULLs are DISTINCT in MySQL/MariaDB and SQLite unique
    indexes."""
    inspector = inspect(db.engine)
    for index_name, table_name, columns, not_null_column, replica_model in _UNIQUE_INDEX_SPECS:
        try:
            if not _table_exists(inspector, table_name):
                continue
            existing_indexes = {idx['name'] for idx in inspector.get_indexes(table_name)}
            existing_indexes.update(
                constraint['name'] for constraint in inspector.get_unique_constraints(table_name)
                if constraint.get('name')
            )
            if index_name in existing_indexes:
                continue
            quoted_table = _quote_identifier(table_name)
            quoted_columns = ', '.join(_quote_identifier(col) for col in columns)
            # A group only collides in a MySQL/MariaDB unique index when EVERY
            # indexed column is NOT NULL (NULL rows never duplicate), so the
            # pre-check filters every column of the scope.
            not_null_predicates = ' AND '.join(
                f'{_quote_identifier(col)} IS NOT NULL' for col in columns)
            dup_sql = (
                f'SELECT COUNT(*) FROM (SELECT {quoted_columns} FROM {quoted_table} '
                f'WHERE {not_null_predicates} '
                f'GROUP BY {quoted_columns} HAVING COUNT(*) > 1) AS dup_check'
            )
            duplicate_groups = int(db.session.execute(text(dup_sql)).scalar() or 0)
            if duplicate_groups > 0:
                if replica_model is not None:
                    deduper, dedup_model = _deduplicate_replica_rows, replica_model
                else:
                    deduper, dedup_model = _UNIQUE_ROW_DEDUPERS.get(index_name, (None, None))
                if deduper is not None:
                    deduper(dedup_model, columns)
                    duplicate_groups = int(db.session.execute(text(dup_sql)).scalar() or 0)
                if duplicate_groups > 0:
                    print(f'[WARNING] [DB] Skipping UNIQUE index {index_name}: {duplicate_groups} duplicate '
                          f'group(s) still exist in {table_name}. The repair runs on EVERY startup, so the '
                          f'index will be retried automatically; until it can be created uniqueness is NOT '
                          f'enforced and the application-level guard remains the only protection.')
                    continue
            sql = f'CREATE UNIQUE INDEX {_quote_identifier(index_name)} ON {quoted_table} ({quoted_columns})'
            db.session.execute(text(sql))
            db.session.commit()
            print(f'[DB] Created unique index {index_name}')
            inspector = inspect(db.engine)
        except Exception as e:
            try:
                db.session.rollback()
            except Exception:
                pass
            print(f'[WARNING] [DB] Could not create unique index {index_name} on {table_name}: {e}')
    _warn_unenforced_idempotency_scopes()


def _run_schema_upgrades():
    db_backend = get_database_backend_name()
    print(f'[DB] Using database backend: {db_backend} ({redact_database_uri()})')
    db.create_all()
    added_columns = _ensure_missing_model_columns()
    _widen_longtext_columns()
    if ('folder', 'is_link_shared') in added_columns:
        db.session.execute(text("UPDATE folder SET is_link_shared = 1 WHERE link_secret IS NOT NULL AND link_secret != ''"))
        db.session.commit()
        print('[DB] Backfilled folder.is_link_shared from legacy link_secret values')
    if ('file', 'is_link_shared') in added_columns:
        db.session.execute(text("UPDATE file SET is_link_shared = 1 WHERE link_secret IS NOT NULL AND link_secret != ''"))
        db.session.commit()
        print('[DB] Backfilled file.is_link_shared from legacy link_secret values')
    _ensure_model_indexes()
    return added_columns


def _migrate_legacy_thumbnail_blobs(thumb_file):
    local_backend = storage._local_backend or _LocalBackend({'thumbnails': THUMBNAILS_DIR})
    blobs = [
        ('thumbnail_data', f'{thumb_file.id}.jpg', thumb_file.thumbnail_data),
        ('encrypted_thumbnail_data', f'{thumb_file.id}.e2e', thumb_file.encrypted_thumbnail_data),
    ]
    blobs = [blob for blob in blobs if blob[2] is not None]
    try:
        for _attr, thumb_id, source_bytes in blobs:
            local_backend.put_data_atomic('thumbnails', thumb_id, source_bytes)
        if any(
            local_backend.get_data('thumbnails', thumb_id) != source_bytes
            for _attr, thumb_id, source_bytes in blobs
        ):
            raise OSError('destination bytes do not match database source')
    except Exception as e:
        print(f'[DB] Thumbnail migration failed for {thumb_file.id}: {e}')
        return False
    for attr, _thumb_id, _source_bytes in blobs:
        setattr(thumb_file, attr, None)
    return True


def _run_post_schema_data_migrations():
    users_without_color = User.query.filter(User.avatar_color.is_(None)).all()
    if users_without_color:
        for u in users_without_color:
            u.avatar_color = random_avatar_color()
        db.session.commit()
        print(f'[DB] Backfilled avatar colors for {len(users_without_color)} users')

    try:
        cleared_folders = db.session.execute(text(
            "UPDATE folder SET link_secret = NULL WHERE link_secret IS NOT NULL"
        )).rowcount
        cleared_files = db.session.execute(text(
            "UPDATE file SET link_secret = NULL WHERE link_secret IS NOT NULL"
        )).rowcount
        db.session.commit()
        if cleared_folders or cleared_files:
            print(f'[DB] Cleared leftover link_secret values '
                  f'(folders={cleared_folders}, files={cleared_files})')
    except Exception as e:
        db.session.rollback()
        print(f'[WARNING] [DB] Could not clear leftover link_secret values: {e}')

    users_with_legacy_recovery_hash = User.query.filter(User.recovery_key_hash.isnot(None)).all()
    if users_with_legacy_recovery_hash:
        migrated = 0
        cleared = 0
        for u in users_with_legacy_recovery_hash:
            if u.recovery_key_hash:
                if not u.recovery_key_verifier:
                    u.recovery_key_verifier = _recovery_key_server_verifier(u.recovery_key_hash)
                    migrated += 1
                u.recovery_key_hash = None
                cleared += 1
        if migrated or cleared:
            db.session.commit()
            print(f'[DB] Migrated {migrated} recovery verifiers and cleared {cleared} legacy recovery hashes')

    # Legacy thumbnail blob migration — move DB-stored thumbnails to disk.
    #
    # Previously this loaded every File row with a non-null thumbnail blob into
    # memory at once. With LargeBinary columns several MB each, restoring a
    # production database with thousands of legacy thumbnails would OOM the
    # worker on startup. We now:
    #   1. Fetch only the IDs of files with DB-stored thumbnails (small).
    #   2. Process them in fixed-size batches, loading the LargeBinary columns
    #      only for the current batch.
    #   3. Commit + expire_all() between batches so SQLAlchemy releases the
    #      loaded blobs and Python's GC can reclaim the memory before the
    #      next batch is fetched.
    # See AUDIT Tier 0 #10.
    THUMB_MIGRATION_BATCH_SIZE = 50
    thumb_migrated = 0
    try:
        candidate_ids = [
            row[0] for row in db.session.query(File.id).filter(
                db.or_(
                    File.thumbnail_data.isnot(None),
                    File.encrypted_thumbnail_data.isnot(None),
                )
            ).all()
        ]
    except Exception as e:
        print(f'[DB] Failed to enumerate legacy thumbnail rows: {e}')
        candidate_ids = []

    if candidate_ids:
        total_candidates = len(candidate_ids)
        print(f'[DB] Found {total_candidates} legacy DB-stored thumbnails; migrating in batches of {THUMB_MIGRATION_BATCH_SIZE}')
        for batch_start in range(0, total_candidates, THUMB_MIGRATION_BATCH_SIZE):
            batch_ids = candidate_ids[batch_start:batch_start + THUMB_MIGRATION_BATCH_SIZE]
            try:
                batch = File.query.filter(File.id.in_(batch_ids)).all()
            except Exception as e:
                print(f'[DB] Failed to load thumbnail batch starting at {batch_start}: {e}')
                continue
            batch_migrated = 0
            for thumb_file in batch:
                if _migrate_legacy_thumbnail_blobs(thumb_file):
                    batch_migrated += 1
            if batch_migrated:
                try:
                    db.session.commit()
                except Exception as e:
                    print(f'[DB] Failed to commit thumbnail migration batch: {e}')
                    db.session.rollback()
                else:
                    thumb_migrated += batch_migrated
            # Release LargeBinary blobs from the session before fetching the
            # next batch so memory does not accumulate across batches.
            db.session.expire_all()
        if thumb_migrated > 0:
            print(f'[DB] Migrated {thumb_migrated} thumbnails from DB to disk')

    # AUDIT FIX F-2 (5th replication audit): backfill the authoritative
    # thumbnail_checksum / thumbnail_e2e_checksum on existing File rows from the
    # on-disk thumbnail bytes. Hashing only happens once per (file, type) — a
    # checksum that is already set or whose disk file is absent is skipped — so
    # this is a no-op on subsequent startups once populated. Small thumbnail
    # files are hashed in bounded batches to avoid a startup CPU spike.
    THUMB_CSUM_BATCH_SIZE = 200
    try:
        csum_candidate_ids = [
            row[0] for row in db.session.query(File.id).filter(
                File.has_thumbnail.is_(True),
                db.or_(
                    File.thumbnail_checksum.is_(None),
                    File.thumbnail_e2e_checksum.is_(None),
                ),
            ).all()
        ]
    except Exception as e:
        print(f'[DB] Failed to enumerate thumbnails needing checksum backfill: {e}')
        csum_candidate_ids = []

    if csum_candidate_ids:
        thumb_csum_filled = 0
        for batch_start in range(0, len(csum_candidate_ids), THUMB_CSUM_BATCH_SIZE):
            batch_ids = csum_candidate_ids[batch_start:batch_start + THUMB_CSUM_BATCH_SIZE]
            try:
                batch = File.query.filter(File.id.in_(batch_ids)).all()
            except Exception as e:
                print(f'[DB] Failed to load thumbnail-checksum batch at {batch_start}: {e}')
                continue
            batch_changed = False
            for tf in batch:
                for _is_e2e, _attr in ((False, 'thumbnail_checksum'), (True, 'thumbnail_e2e_checksum')):
                    if getattr(tf, _attr) is not None:
                        continue
                    _ext = '.e2e' if _is_e2e else '.jpg'
                    _disk_path = os.path.join(THUMBNAILS_DIR, f'{tf.id}{_ext}')
                    if not os.path.isfile(_disk_path):
                        continue
                    try:
                        setattr(tf, _attr, _sha256_file(_disk_path))
                        batch_changed = True
                        thumb_csum_filled += 1
                    except Exception as e:
                        print(f'[DB] Thumbnail checksum backfill failed for {tf.id}{_ext}: {e}')
            if batch_changed:
                try:
                    db.session.commit()
                except Exception as e:
                    print(f'[DB] Failed to commit thumbnail-checksum batch: {e}')
                    db.session.rollback()
            db.session.expire_all()
        if thumb_csum_filled > 0:
            print(f'[DB] Backfilled {thumb_csum_filled} thumbnail checksum(s)')


def _staged_meta_matches_value(actual, expected):
    if expected is None:
        return True
    try:
        if isinstance(actual, int) or isinstance(expected, int):
            return int(actual or 0) == int(expected)
    except (TypeError, ValueError):
        return False
    return actual == expected


def _read_staged_metadata(meta_path):
    try:
        if not os.path.isfile(meta_path):
            return None
        with open(meta_path, 'r') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception as e:
        print(f'[STARTUP] Failed to read staged metadata {meta_path}: {e}')
        return None


def _staged_file_metadata_matches(base_filename, staged_path, meta_path):
    data = _read_staged_metadata(meta_path)
    if not data:
        return False
    file_id = base_filename[:-4] if base_filename.endswith('.enc') else base_filename
    if data.get('file_id') and data.get('file_id') != file_id:
        return False
    file_obj = db.session.get(File, file_id)
    if not file_obj:
        return False
    try:
        if data.get('disk_size') is not None and os.path.getsize(staged_path) != int(data.get('disk_size')):
            return False
    except Exception:
        return False
    # AUDIT FIX (staged-file payload checksum verification): a same-size stale
    # .new file must NOT be finalized just because its disk_size + metadata
    # match. Hash the staged encrypted payload and require it to equal the
    # committed payload_checksum (the on-disk encrypted hash, identical to what
    # storage._sha256_file produces for replication/scrub). Previously this
    # function checked size/content metadata only, so a same-size stale .new
    # could overwrite the original on restart even though its bytes did not
    # match the committed DB row. Mirrors _staged_note_metadata_matches, which
    # already hash-verifies staged note content. The DB row's payload_checksum
    # is authoritative (reads verify against it); fall back to the staged
    # metadata's payload_checksum, and only skip the hash check entirely for
    # older staged artifacts that carry neither.
    expected_payload_checksum = file_obj.payload_checksum or data.get('payload_checksum')
    if expected_payload_checksum:
        try:
            if storage._sha256_file(staged_path) != expected_payload_checksum:
                return False
        except Exception:
            return False
    checks = (
        ('size', file_obj.size),
        ('disk_size', file_obj.disk_size),
        ('content_hash', file_obj.content_hash),
        ('encrypted_name', file_obj.encrypted_name),
        ('name_nonce', file_obj.name_nonce),
        ('encrypted_file_key', file_obj.encrypted_file_key),
        ('file_key_nonce', file_obj.file_key_nonce),
    )
    return all(_staged_meta_matches_value(actual, data.get(key)) for key, actual in checks)


def _staged_file_matches_committed_checksum(base_filename, staged_path):
    """True when a leftover staged .new payload is safe to finalize over the
    original at startup.

    AUDIT FIX (finding 3): legacy rows carry payload_checksum = NULL, and the
    old check hard-failed on that BEFORE looking at anything else -- so a
    COMMITTED staged rewrite (crash between db.commit() and finalize) had its
    .new discarded while the DB row already described the NEW payload,
    leaving reads to verify the OLD bytes against NEW metadata. For rows with
    no checksum we now fall back to, in order:
      1. the .meta metadata written before the commit (size/hash vs both the
         staged bytes and the committed row -- the same authority the note
         recovery path already uses), then
      2. the .committed marker, which is only ever written AFTER a
         successful db.commit() and is therefore proof the commit happened
         (with a disk_size sanity check whenever the row records one).
    A row that is gone, or a staged file with neither checksum, metadata nor
    marker evidence, still fails closed -> discarded, as before."""
    file_id = base_filename[:-4] if base_filename.endswith('.enc') else base_filename
    file_obj = db.session.get(File, file_id)
    if not file_obj:
        return False
    try:
        if not os.path.isfile(staged_path):
            return False
        staged_size = os.path.getsize(staged_path)
    except OSError:
        return False

    if file_obj.payload_checksum:
        try:
            if file_obj.disk_size is not None and staged_size != int(file_obj.disk_size):
                return False
            return storage._sha256_file(staged_path) == file_obj.payload_checksum
        except Exception:
            return False

    # Legacy row: no committed checksum to compare against.
    meta_path = os.path.join(os.path.dirname(staged_path), base_filename + '.meta')
    if _staged_file_metadata_matches(base_filename, staged_path, meta_path):
        return True

    committed_path = os.path.join(os.path.dirname(staged_path), base_filename + '.committed')
    if not os.path.exists(committed_path):
        return False
    try:
        if file_obj.disk_size is not None and staged_size != int(file_obj.disk_size):
            print(f'[STARTUP] Staged file {base_filename} has a .committed marker but its size '
                  f'({staged_size}) does not match File.disk_size ({file_obj.disk_size}); discarding')
            return False
    except (TypeError, ValueError):
        return False
    print(f'[STARTUP] Staged file {base_filename}: legacy row without checksum; '
          f'accepting via .committed marker (+ .meta) fallback')
    return True


def _staged_note_metadata_matches(note_id, staged_path, meta_path):
    data = _read_staged_metadata(meta_path)
    if not data:
        return False
    if data.get('note_id') and data.get('note_id') != note_id:
        return False
    note_obj = db.session.get(Note, note_id)
    if not note_obj:
        return False
    try:
        if data.get('size') is not None and os.path.getsize(staged_path) != int(data.get('size')):
            return False
        if data.get('content_checksum') and storage._sha256_file(staged_path) != data.get('content_checksum'):
            return False
    except Exception:
        return False
    checks = (
        ('size', note_obj.size),
        ('content_version', note_obj.content_version),
        ('content_checksum', note_obj.content_checksum),
    )
    return all(_staged_meta_matches_value(actual, data.get(key)) for key, actual in checks)


def _staged_note_marker_has_live_row(note_id, marker_path):
    return os.path.exists(marker_path) and db.session.get(Note, note_id) is not None


# AUDIT FIX A3: hard bounds for the incremental startup reconcile passes.
# start.sh runs `flask startup-maintenance` BEFORE gunicorn binds the port, so
# every row examined here is added directly to restart downtime. The watermarks
# make a steady-state boot O(rows changed since the last boot); these caps make
# even a cold first boot (or a watermark reset) bounded rather than O(corpus).
# Anything skipped is owned by the periodic integrity scrub.
STARTUP_RECONCILE_MAX_ROWS = 2000


def _startup_cursor_resume(query, ts_col, id_col, key, cursor_epoch):
    """Continue a capped cold pass strictly after the last (timestamp, id) it
    processed; a timestamp alone never steps past >MAX rows sharing one value.
    Falls back to the legacy inclusive timestamp cursor when no position exists."""
    try:
        row = db.session.get(AppSetting, key + '_pos')
        pos = json.loads(row.value)
        ts = datetime.fromisoformat(pos['ts'])
        return query.filter(db.or_(ts_col > ts, db.and_(ts_col == ts, id_col > pos['id'])))
    except Exception:
        return query.filter(ts_col >= datetime.fromtimestamp(cursor_epoch, tz=timezone.utc))


def _persist_startup_cursor(key, last_ts, last_id):
    _persist_job_timestamp(key, _utc_aware(last_ts).timestamp())
    # Exact DB value (not a float epoch) so the equality branch above matches.
    _persist_job_timestamp(key + '_pos', json.dumps({'ts': last_ts.isoformat(), 'id': last_id}))
# Re-examine a small window below the watermark so a row written in the same
# second the previous pass finished cannot slip through unreconciled.
STARTUP_RECONCILE_GRACE_SECONDS = 300


def _warn_if_guest_temp_cap_disabled():
    """DEPLOYMENT NOTE (residual audit item l).

    The AGGREGATE cap on anonymous temp uploads is the runtime setting
    `temp_total_max_gb`, whose default is 0 = DISABLED. With 0 the only bound
    on guest/temp storage is the PER-FILE `temp_max_gb`, so an anonymous
    client can fill the volume with many sub-limit files. The default is
    deliberately NOT changed in code: flipping it would start returning 507 on
    deployments whose legitimate guest backlog already exceeds any number we
    could pick -- a silent compatibility break. Instead the setting is
    surfaced loudly at every boot so the operator owns the choice. Once set
    (same AppSetting store as temp_max_gb) the cap is enforced by the advisory
    pre-check AND the finalize-time flock reservation."""
    try:
        guest_temp_cap_gb = get_float_setting('temp_total_max_gb')
    except Exception as cap_err:
        print(f'[SETTINGS] Could not read temp_total_max_gb: {cap_err}')
        return False
    if guest_temp_cap_gb <= 0:
        print('[SETTINGS] temp_total_max_gb is 0 (DISABLED): anonymous temp uploads have '
              'NO aggregate storage cap -- only the per-file temp_max_gb limit applies, '
              'so guest uploads can fill the volume. Set temp_total_max_gb to bound '
              'total guest temp storage.')
        return False
    return True


