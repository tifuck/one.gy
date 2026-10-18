# ONE.GY entrypoint. The application code lives in src/app/ and is executed here, in order, into this module's namespace.
# See AGENTS.md before adding, moving or reordering parts. No module docstring: the original app.py had none and __doc__ must stay None.
# Each part is compiled with its own path, so tracebacks point at src/app/<part>.py and its real line numbers.


def _load_parts():
    import os
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'app')
    for name in (
        '010_imports_config.py',
        '020_download_prep_state.py',
        '030_db_app_setup.py',
        '040_models.py',
        '050_storage_helpers.py',
        '060_storage_backends_local_ssh.py',
        '070_storage_backend_s3.py',
        '071_storage_manager_init.py',
        '072_storage_manager_reads.py',
        '073_storage_manager_files.py',
        '074_storage_manager_notes_thumbnails.py',
        '075_storage_manager_replication.py',
        '076_storage_manager_replication_cycle.py',
        '077_storage_manager_scrub.py',
        '078_storage_manager_nodes.py',
        '079_storage_manager_node_admin.py',
        '080_storage_manager.py',
        '090_helpers_locks_security.py',
        '100_upload_idempotency_prep.py',
        '110_auth_decorators_download_limits.py',
        '120_schema_migrations.py',
        '130_startup_maintenance.py',
        '140_public_landing.py',
        '150_auth_register_login.py',
        '160_auth_2fa_account_keys.py',
        '170_files_folders_routes.py',
        '180_file_manage_routes.py',
        '190_file_content_routes.py',
        '200_thumbnails.py',
        '210_search_bulk_trash.py',
        '220_account_routes.py',
        '230_admin_users_settings.py',
        '240_admin_storage_notifications.py',
        '250_notifications_prompts_docs.py',
        '260_e2ee_share_helpers.py',
        '270_upload.py',
        '280_manage_share_routes.py',
        '290_browse_folder_routes.py',
        '300_share_access_helpers.py',
        '310_link_key_routes.py',
        '320_download_routes.py',
        '330_cleanup_jobs.py',
        '340_cli_commands.py',
        '350_scheduler.py',
        '360_notes.py',
        '370_apiv1.py',
        '380_cli_crypt_routes.py',
        '390_music_library_helpers.py',
        '400_music_browse_routes.py',
        '410_music_api_sync.py',
        '420_main.py',
    ):
        path = os.path.join(here, name)
        with open(path, encoding='utf-8') as fp:
            source = fp.read()
        exec(compile(source, path, 'exec'), globals())


_load_parts()
del _load_parts
