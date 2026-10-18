def _run_startup_maintenance():
    print('[STORAGE] Initial storage check:')
    check_storage()
    storage.init()

    # DEPLOYMENT NOTE (residual audit item l): the aggregate cap on anonymous
    # temp uploads is an OPERATOR SETTING (`temp_total_max_gb`), surfaced at
    # every boot by _warn_if_guest_temp_cap_disabled() below.
    _warn_if_guest_temp_cap_disabled()

    # AUDIT FIX (upload/download integrity): release any prepared-download slot
    # (and any decrypted plaintext temp file) left behind by a previous process.
    # Startup maintenance runs before gunicorn binds the port, so nothing can be
    # in flight and every surviving state file is residue.
    try:
        purge_all_prep_states()
    except Exception as e:
        print(f'[ERROR] Failed to purge leftover prepared-download states at startup: {e}')

    # AUDIT FIX A2: these two backfills used to commit inside the loop and at the
    # end with NO try/except and no rollback, unlike every later block in this
    # function. A single lost connection or deadlock propagated out of the
    # `startup-maintenance` CLI, and `set -euo pipefail` in start.sh aborted
    # before `exec gunicorn` -- with Restart=always that is an unattended crash
    # loop until StartLimitBurst trips, leaving the service DEAD. Startup
    # maintenance is best-effort and must NEVER prevent the service starting.
    try:
        thumb_replicas_missing_size = ThumbnailReplica.query.filter(
            ThumbnailReplica.status == 'synced',
            ThumbnailReplica.size_bytes.is_(None)
        ).all()
        if thumb_replicas_missing_size:
            thumb_sizes_backfilled = 0
            for thumb_replica in thumb_replicas_missing_size:
                ext = '.e2e' if thumb_replica.thumb_type == 'e2e' else '.jpg'
                disk_path = os.path.join(THUMBNAILS_DIR, f'{thumb_replica.file_id}{ext}')
                size_bytes = None
                if os.path.exists(disk_path):
                    try:
                        size_bytes = os.path.getsize(disk_path)
                    except Exception:
                        size_bytes = None
                # AUDIT FIX: legacy DB thumbnail blob columns are dead; do not fall
                # back to them. If the disk file is missing, leave size_bytes None
                # so the scrub/replication loop can heal it from another node.
                if size_bytes is not None:
                    thumb_replica.size_bytes = size_bytes
                    thumb_sizes_backfilled += 1
                    if thumb_sizes_backfilled % 200 == 0:
                        db.session.commit()
            if thumb_sizes_backfilled > 0:
                db.session.commit()
                print(f'[DB] Backfilled thumbnail sizes for {thumb_sizes_backfilled} replica rows')
    except Exception as e:
        print(f'[DB] Thumbnail replica size backfill failed (non-critical): {e}')
        try:
            db.session.rollback()
        except Exception:
            pass

    try:
        file_replicas_missing_size = FileReplica.query.filter(
            FileReplica.status == 'synced',
            FileReplica.size_bytes.is_(None)
        ).all()
        if file_replicas_missing_size:
            file_sizes_backfilled = 0
            for file_replica in file_replicas_missing_size:
                size_bytes = storage._tracked_file_size_bytes(file_replica.file_id)
                if size_bytes is not None:
                    file_replica.size_bytes = size_bytes
                    file_sizes_backfilled += 1
                    if file_sizes_backfilled % 200 == 0:
                        db.session.commit()
            if file_sizes_backfilled > 0:
                db.session.commit()
                print(f'[DB] Backfilled file sizes for {file_sizes_backfilled} replica rows')
    except Exception as e:
        print(f'[DB] File replica size backfill failed (non-critical): {e}')
        try:
            db.session.rollback()
        except Exception:
            pass

    uploads_dir = app.config['UPLOAD_FOLDER']
    file_replication_requeue_ids = set()
    staged_recovered = 0
    staged_discarded = 0
    try:
        for staged_file in os.listdir(uploads_dir):
            if staged_file.endswith('.new'):
                base_filename = staged_file[:-4]
                staged_path = os.path.join(uploads_dir, staged_file)
                committed_path = os.path.join(uploads_dir, base_filename + '.committed')
                meta_path = os.path.join(uploads_dir, base_filename + '.meta')
                if _staged_file_matches_committed_checksum(base_filename, staged_path):
                    final_path = os.path.join(uploads_dir, base_filename)
                    try:
                        os.replace(staged_path, final_path)
                        staged_recovered += 1
                        if base_filename.endswith('.enc'):
                            file_replication_requeue_ids.add(base_filename[:-4])
                        reason = 'checksum'
                        if os.path.exists(committed_path):
                            reason = 'marker+checksum'
                        print(f'[STARTUP] Recovered staged file: {base_filename} ({reason}; finalized .new -> original)')
                    except OSError as e:
                        print(f'[STARTUP] Failed to recover staged file {base_filename}: {e}')
                    try:
                        os.remove(committed_path)
                    except OSError:
                        pass
                    try:
                        if os.path.exists(meta_path):
                            os.remove(meta_path)
                    except OSError:
                        pass
                else:
                    if os.path.exists(committed_path):
                        print(f'[STARTUP] Ignoring leftover .committed for {base_filename}: '
                              f'staged .new does not match the committed row (checksum/metadata/marker)')
                    try:
                        os.remove(staged_path)
                        staged_discarded += 1
                        print(f'[STARTUP] Discarded uncommitted staged file: {base_filename} (checksum mismatch or uncommitted)')
                    except OSError as e:
                        print(f'[STARTUP] Failed to discard staged file {base_filename}: {e}')
                    try:
                        if os.path.exists(meta_path):
                            os.remove(meta_path)
                    except OSError:
                        pass
            elif staged_file.endswith('.committed'):
                # The matching .new branch consumes its marker; only remove orphans.
                if not os.path.exists(os.path.join(uploads_dir, staged_file[:-10] + '.new')):
                    try:
                        os.remove(os.path.join(uploads_dir, staged_file))
                    except OSError:
                        pass
            elif staged_file.endswith('.meta'):
                # The matching .new file handles metadata cleanup above. Remove stale leftovers.
                base_filename = staged_file[:-5]
                if not os.path.exists(os.path.join(uploads_dir, base_filename + '.new')):
                    try:
                        os.remove(os.path.join(uploads_dir, staged_file))
                    except OSError:
                        pass
    except Exception as e:
        print(f'[STARTUP] Error during staged file recovery scan: {e}')
    if staged_recovered > 0:
        print(f'[STARTUP] Recovered {staged_recovered} interrupted staged file operation(s)')
    if staged_discarded > 0:
        print(f'[STARTUP] Discarded {staged_discarded} uncommitted staged file(s) (DB commit had failed)')

    note_staged_recovered = 0
    note_staged_discarded = 0
    try:
        for staged_note in os.listdir(NOTES_DIR):
            if staged_note.endswith('.new'):
                staged_base = staged_note[:-4]
                note_id = staged_base.rsplit('.', 1)[0]
                staged_note_path = os.path.join(NOTES_DIR, staged_note)
                committed_note_path = os.path.join(NOTES_DIR, staged_base + '.committed')
                meta_note_path = os.path.join(NOTES_DIR, staged_base + '.meta')
                if _staged_note_metadata_matches(note_id, staged_note_path, meta_note_path):
                    final_note_path = os.path.join(NOTES_DIR, note_id)
                    try:
                        os.replace(staged_note_path, final_note_path)
                        note_staged_recovered += 1
                        print(f'[STARTUP] Recovered staged note: {note_id} (metadata; finalized .new -> original)')
                    except OSError as e:
                        print(f'[STARTUP] Failed to recover staged note {note_id}: {e}')
                    try:
                        os.remove(committed_note_path)
                    except OSError:
                        pass
                    try:
                        if os.path.exists(meta_note_path):
                            os.remove(meta_note_path)
                    except OSError:
                        pass
                else:
                    try:
                        os.remove(staged_note_path)
                        note_staged_discarded += 1
                        print(f'[STARTUP] Discarded uncommitted staged note: {note_id} (no .committed marker)')
                    except OSError as e:
                        print(f'[STARTUP] Failed to discard staged note {note_id}: {e}')
                    try:
                        if os.path.exists(meta_note_path):
                            os.remove(meta_note_path)
                    except OSError:
                        pass
            elif staged_note.endswith('.committed'):
                try:
                    os.remove(os.path.join(NOTES_DIR, staged_note))
                except OSError:
                    pass
            elif staged_note.endswith('.meta'):
                staged_base = staged_note[:-5]
                if not os.path.exists(os.path.join(NOTES_DIR, staged_base + '.new')):
                    try:
                        os.remove(os.path.join(NOTES_DIR, staged_note))
                    except OSError:
                        pass
    except Exception as e:
        print(f'[STARTUP] Error during staged note recovery scan: {e}')
    if note_staged_recovered > 0:
        print(f'[STARTUP] Recovered {note_staged_recovered} interrupted staged note operation(s)')
    if note_staged_discarded > 0:
        print(f'[STARTUP] Discarded {note_staged_discarded} uncommitted staged note(s) (DB commit had failed)')

    # AUDIT FIX A3: this pass used to load EVERY Note as a full ORM row and call
    # queue_note_replication() on all of them -- a SHA-256 of each note file plus
    # 1 + N_nodes queries each -- on EVERY boot, synchronously before gunicorn
    # binds the port. Restart downtime therefore grew linearly with the corpus
    # until merge-to-prod.sh's health check false-negatived a healthy deploy.
    # It is now incremental: a persisted watermark records the point up to which
    # every note has already been reconciled, so a boot only pays for notes
    # written/changed since the last successful pass (plus any note whose content
    # state is still incomplete). Notes below the watermark are owned by the
    # periodic integrity scrub, which already audits and repairs replica rows.
    note_state_backfilled = 0
    note_replication_requeued = 0
    note_pass_started_at = time.time()
    try:
        note_watermark_epoch = _load_job_timestamp('startup_note_reconcile_at')
        note_cursor_epoch = _load_job_timestamp('startup_note_reconcile_cursor')
        # Only the columns actually used -- never the full ORM row.
        note_query = db.session.query(
            Note.id, Note.size, Note.content_version, Note.content_checksum, Note.created_at
        )
        if note_watermark_epoch > 0:
            # Steady state: only notes touched since the last complete pass, plus
            # any note whose content state is still incomplete.
            watermark_dt = datetime.fromtimestamp(
                max(0.0, note_watermark_epoch - STARTUP_RECONCILE_GRACE_SECONDS), tz=timezone.utc
            )
            note_query = note_query.filter(db.or_(
                Note.updated_at.is_(None),
                Note.updated_at >= watermark_dt,
                Note.content_checksum.is_(None),
                Note.size.is_(None),
                Note.content_version < 1,
            ))
        elif note_cursor_epoch > 0:
            # Cold start that was capped on a previous boot: resume where it
            # stopped so successive boots make guaranteed forward progress
            # instead of re-walking the same first N rows forever.
            note_query = _startup_cursor_resume(
                note_query, Note.created_at, Note.id, 'startup_note_reconcile_cursor', note_cursor_epoch)
        note_rows = note_query.order_by(Note.created_at.asc(), Note.id.asc()).limit(
            STARTUP_RECONCILE_MAX_ROWS + 1).all()
        note_pass_complete = len(note_rows) <= STARTUP_RECONCILE_MAX_ROWS
        if not note_pass_complete:
            note_rows = note_rows[:STARTUP_RECONCILE_MAX_ROWS]
            print(f'[STARTUP] Note reconcile capped at {STARTUP_RECONCILE_MAX_ROWS} row(s) this boot; '
                  f'it will resume from the cursor on the next boot')
        last_note_created_at = None
        last_note_id = None
        for idx, (note_id, note_size, note_version, note_checksum, note_created_at) in enumerate(note_rows, start=1):
            last_note_created_at = note_created_at
            last_note_id = note_id
            source_path = storage.get_note_path(note_id)
            if source_path and os.path.isfile(source_path):
                disk_size = os.path.getsize(source_path)
                checksum = note_checksum
                if not checksum or note_size is None or int(note_size or 0) != int(disk_size):
                    checksum = storage._sha256_file(source_path)
                needs_version = (not note_version) or int(note_version) < 1
                needs_checksum = (note_checksum != checksum)
                needs_size = (note_size is None or int(note_size) != int(disk_size))
                if needs_version or needs_checksum or needs_size:
                    # Only materialise the ORM row when something actually changes.
                    note_obj = db.session.get(Note, note_id)
                    if note_obj:
                        if needs_version:
                            note_obj.content_version = 1
                        if needs_checksum:
                            note_obj.content_checksum = checksum
                        if needs_size:
                            note_obj.size = int(disk_size)
                        note_state_backfilled += 1
            repaired = storage.queue_note_replication(note_id, verified_at=datetime.now(timezone.utc))
            if repaired and (repaired['remote_reset'] > 0 or repaired.get('source_node_id') is not None):
                note_replication_requeued += 1
            if idx % 100 == 0:
                db.session.commit()
        db.session.commit()
        if note_state_backfilled > 0 or note_replication_requeued > 0:
            print(
                f'[DB] Backfilled {note_state_backfilled} note content state row(s) '
                f'and reconciled replication state for {note_replication_requeued} note(s)'
            )
        if note_pass_complete:
            _persist_job_timestamp('startup_note_reconcile_at', note_pass_started_at)
            if note_cursor_epoch > 0:
                _persist_job_timestamp('startup_note_reconcile_cursor', 0)
        elif last_note_created_at is not None:
            _persist_startup_cursor('startup_note_reconcile_cursor', last_note_created_at, last_note_id)
    except Exception as e:
        print(f'[DB] Note replication backfill failed (non-critical): {e}')
        try:
            db.session.rollback()
        except Exception:
            pass

    # AUDIT FIX A3: this pass used to load EVERY is_e2e_encrypted row as a full
    # ORM object -- INCLUDING the undeferred LargeBinary legacy thumbnail columns
    # -- and stat() every payload on every boot. It is now split in two:
    #   Phase 1 is pure SQL. The two E2EE reconciliations (content_hash mirrors
    #     payload_checksum; File.size mirrors the authoritative disk_size) compare
    #     only DB columns, so they never needed the disk at all.
    #   Phase 2 touches the disk, but ONLY for rows whose disk_size/payload_checksum
    #     is still NULL, only for columns actually needed, and only above a
    #     persisted watermark -- every older row has already been examined, and a
    #     value that is set is never cleared, so re-examining it is pure waste.
    e2e_size_fixed = 0
    file_disk_state_fixed = 0
    try:
        # --- Phase 1: column-only fixes, no disk I/O, no ORM materialisation ---
        content_hash_ids = [row[0] for row in db.session.query(File.id).filter(
            File.is_e2e_encrypted == True,
            File.content_hash.is_(None),
            File.payload_checksum.isnot(None),
        ).all()]
        if content_hash_ids:
            # content_hash mirrors payload_checksum for E2EE files (the server
            # only ever sees ciphertext), so this copies an already-authoritative
            # value.
            File.query.filter(File.id.in_(content_hash_ids)).update(
                {File.content_hash: File.payload_checksum}, synchronize_session=False)
            file_disk_state_fixed += len(content_hash_ids)
            file_replication_requeue_ids.update(content_hash_ids)

        size_mismatch_ids = [row[0] for row in db.session.query(File.id).filter(
            File.is_e2e_encrypted == True,
            File.disk_size.isnot(None),
            File.size.isnot(None),
            File.size != File.disk_size,
        ).all()]
        if size_mismatch_ids:
            # For E2EE files File.size mirrors the on-disk ciphertext length.
            # Reconcile it against the AUTHORITATIVE disk_size only -- never
            # against the raw local file length.
            File.query.filter(File.id.in_(size_mismatch_ids)).update(
                {File.size: File.disk_size}, synchronize_session=False)
            e2e_size_fixed += len(size_mismatch_ids)
            file_replication_requeue_ids.update(size_mismatch_ids)
            print(f'[DB] Fixing E2EE file size for {len(size_mismatch_ids)} file(s) from the authoritative disk_size')
        if content_hash_ids or size_mismatch_ids:
            db.session.commit()

        # --- Phase 2: disk-touching fill of still-unset payload state ---
        # AUDIT FIX (upload/download integrity): this loop used to OVERWRITE an
        # existing authoritative File.disk_size with whatever the local file
        # happened to be, and to adopt the local SHA-256 as File.payload_checksum
        # with no corroboration at all. _current_file_read_replicas() filters
        # healthy remote replicas by exactly those two fields, so poisoning them
        # from a truncated/bit-rotted local copy turns a recoverable local
        # corruption into an unreadable file on every node. We only FILL a
        # field that is unset, only when a replica on another node corroborates
        # the local bytes, and we never silently rewrite a differing value.
        file_pass_started_at = time.time()
        file_watermark_epoch = _load_job_timestamp('startup_file_state_reconcile_at')
        file_cursor_epoch = _load_job_timestamp('startup_file_state_reconcile_cursor')
        payload_query = db.session.query(
            File.id, File.filename, File.disk_size, File.payload_checksum, File.upload_time
        ).filter(db.or_(File.disk_size.is_(None), File.payload_checksum.is_(None)))
        if file_watermark_epoch > 0:
            # Steady state: everything below the watermark has already been
            # examined, and neither field is ever cleared once set, so a row that
            # is still NULL down there is one the scrub owns -- not one a boot
            # should re-hash.
            file_watermark_dt = datetime.fromtimestamp(
                max(0.0, file_watermark_epoch - STARTUP_RECONCILE_GRACE_SECONDS), tz=timezone.utc
            )
            payload_query = payload_query.filter(db.or_(
                File.upload_time.is_(None),
                File.upload_time >= file_watermark_dt,
            ))
        elif file_cursor_epoch > 0:
            # Cold start resumed from where a previous capped boot stopped.
            payload_query = _startup_cursor_resume(
                payload_query, File.upload_time, File.id, 'startup_file_state_reconcile_cursor', file_cursor_epoch)
        payload_rows = payload_query.order_by(File.upload_time.asc(), File.id.asc()).limit(
            STARTUP_RECONCILE_MAX_ROWS + 1).all()
        file_pass_complete = len(payload_rows) <= STARTUP_RECONCILE_MAX_ROWS
        if not file_pass_complete:
            payload_rows = payload_rows[:STARTUP_RECONCILE_MAX_ROWS]
            print(f'[STARTUP] File payload-state reconcile capped at {STARTUP_RECONCILE_MAX_ROWS} row(s) '
                  f'this boot; it will resume from the cursor on the next boot')
        last_upload_time = None
        last_upload_id = None
        for file_id, stored_filename, known_disk_size, known_checksum, row_upload_time in payload_rows:
            last_upload_time = row_upload_time
            last_upload_id = file_id
            file_path = storage.get_file_path(stored_filename)
            if not file_path or not os.path.exists(file_path):
                continue
            disk_size = os.path.getsize(file_path)
            local_checksum = storage._sha256_file(file_path)
            corroborated = storage._local_payload_corroborated(file_id, local_checksum, disk_size)
            fill_disk_size = (known_disk_size is None and corroborated)
            fill_checksum = (not known_checksum and corroborated)
            if known_disk_size is None and not corroborated:
                print(f'[WARNING] File {file_id} has no disk_size and no replica corroborates the '
                      f'local copy ({disk_size} bytes); leaving it NULL for the integrity scrub')
            elif known_disk_size is not None and int(known_disk_size or 0) != int(disk_size):
                print(f'[WARNING] Local copy of {file_id} is {disk_size} bytes but the authoritative '
                      f'disk_size is {known_disk_size}; refusing to adopt the local size')
            if not known_checksum and not corroborated:
                print(f'[WARNING] File {file_id} has no payload_checksum and no replica corroborates '
                      f'the local copy; leaving it NULL for the integrity scrub')
            if not (fill_disk_size or fill_checksum):
                continue
            file_row = db.session.get(File, file_id)
            if not file_row:
                continue
            if fill_disk_size:
                file_row.disk_size = disk_size
                file_disk_state_fixed += 1
            if fill_checksum:
                file_row.payload_checksum = local_checksum
                file_disk_state_fixed += 1
            if file_row.is_e2e_encrypted and not file_row.content_hash and file_row.payload_checksum:
                file_row.content_hash = file_row.payload_checksum
                file_disk_state_fixed += 1
            if (file_row.is_e2e_encrypted and file_row.disk_size is not None
                    and file_row.size != file_row.disk_size):
                file_row.size = file_row.disk_size
                e2e_size_fixed += 1
            file_replication_requeue_ids.add(file_id)
        db.session.commit()
        if file_pass_complete:
            _persist_job_timestamp('startup_file_state_reconcile_at', file_pass_started_at)
            if file_cursor_epoch > 0:
                _persist_job_timestamp('startup_file_state_reconcile_cursor', 0)
        elif last_upload_time is not None:
            _persist_startup_cursor('startup_file_state_reconcile_cursor', last_upload_time, last_upload_id)
        if e2e_size_fixed > 0 or file_disk_state_fixed > 0:
            print(f'[DB] Fixed file disk state for {file_disk_state_fixed} file(s); file.size for {e2e_size_fixed} E2EE file(s)')
    except Exception as e:
        print(f'[DB] E2EE file size fix failed (non-critical): {e}')
        try:
            db.session.rollback()
        except Exception:
            pass

    file_replication_requeued = 0
    try:
        for idx, file_id in enumerate(sorted(file_replication_requeue_ids), start=1):
            repaired = storage.queue_file_replication(file_id, verified_at=datetime.now(timezone.utc))
            if repaired and (repaired['remote_reset'] > 0 or repaired.get('local_marked')):
                file_replication_requeued += 1
            if idx % 100 == 0:
                db.session.commit()
        if file_replication_requeue_ids:
            db.session.commit()
        if file_replication_requeued > 0:
            print(f'[DB] Reconciled file replication state for {file_replication_requeued} file(s) after staged recovery/state backfill')
    except Exception as e:
        print(f'[DB] File replication backfill failed (non-critical): {e}')
        db.session.rollback()


def _can_run_startup_maintenance():
    inspector = inspect(db.engine)
    table_names = set(inspector.get_table_names())
    return all(table_name in table_names for table_name in _DB_STARTUP_TABLES)

