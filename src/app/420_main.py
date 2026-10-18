if __name__ == '__main__':
    cert_file = os.path.join(basedir, 'cert.pem')
    key_file = os.path.join(basedir, 'key.pem')
    
    if not os.path.exists(cert_file) or not os.path.exists(key_file):
        print('Generating self-signed SSL certificate...')
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:4096',
            '-keyout', key_file,
            '-out', cert_file,
            '-days', '365',
            '-nodes',
            '-subj', '/CN=localhost'
        ], check=True)
        try:
            os.chmod(key_file, 0o600)
        except OSError:
            pass
        print(f'SSL certificate created: {cert_file}, {key_file}')

    with app.app_context():
        _run_schema_upgrades()
        _run_post_schema_data_migrations()
        if _can_run_startup_maintenance():
            _run_startup_maintenance()

    start_scheduler()
    print('[WARNING] Running with Flask dev server. For large file uploads (multi-GB), use Gunicorn instead:')
    print('  gunicorn -c gunicorn.conf.py app:app')
    # SECURITY: Use environment variable for debug mode, default to False
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    bind_host = os.environ.get('BIND_HOST', '0.0.0.0')
    web_port = int(os.environ.get('WEB_PORT', '5000'))
    # threaded=True: Handle concurrent requests (required for large uploads that take minutes)
    app.run(debug=debug_mode, host=bind_host, port=web_port, ssl_context=(cert_file, key_file), threaded=True)
