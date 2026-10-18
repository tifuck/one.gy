@app.route('/cli/version')
@csrf.exempt
def cli_version():
    """Return SHA-256 hashes for CLI binaries (auto-update endpoint)."""
    import json as json_mod
    manifest_path = os.path.join(app.static_folder, 'cli', 'manifest.json')
    if not os.path.exists(manifest_path):
        return jsonify({'error': 'CLI binaries not available'}), 404

    try:
        with open(manifest_path, 'r') as f:
            manifest = json_mod.load(f)
    except Exception as e:
        print(f'[CLI] Error reading manifest: {e}')
        return jsonify({'error': 'Could not read manifest'}), 500

    platform = request.args.get('platform', '')
    if platform and platform in manifest:
        return jsonify(manifest[platform])

    return jsonify(manifest)


@app.route('/cli.sh')
@csrf.exempt
def cli_bootstrap():
    """Serve the CLI bootstrap script with the server URL injected."""
    script_path = os.path.join(app.static_folder, 'cli.sh')
    if not os.path.exists(script_path):
        return 'CLI bootstrap script not available', 404

    try:
        with open(script_path, 'r') as f:
            script = f.read()
    except Exception as e:
        print(f'[CLI] Error reading cli.sh: {e}')
        return 'Internal error', 500

    domain = (os.environ.get('DOMAIN', '') or '').strip()
    try:
        parsed_domain = urllib.parse.urlsplit(domain if '://' in domain else f'//{domain}')
        host = parsed_domain.hostname or ''
        port = parsed_domain.port
    except ValueError:
        return 'CLI bootstrap script not available', 404
    if not host or not re.fullmatch(r'[A-Za-z0-9.:-]+', host):
        return 'CLI bootstrap script not available', 404
    authority = f'[{host}]' if ':' in host else host
    if port:
        authority = f'{authority}:{port}'
    server_url = f'https://{authority}'
    script = script.replace('%%SERVER_URL%%', server_url)

    return script, 200, {'Content-Type': 'text/plain; charset=utf-8'}


@app.route('/crypt')
@csrf.exempt
@limiter.limit("30 per minute")
def serve_crypt_script():
    """Serve the crypt.sh AES-256-CBC encrypt/decrypt helper script."""
    script_path = os.path.join(app.static_folder, 'crypt.sh')
    if not os.path.exists(script_path):
        return 'Crypt script not available', 404

    try:
        with open(script_path, 'r') as f:
            script = f.read()
    except Exception as e:
        print(f'[CLI] Error reading crypt.sh: {e}')
        return 'Internal error', 500

    return script, 200, {'Content-Type': 'text/plain; charset=utf-8'}


# ═══════════════════════════════════════════════════════════════════════════════
# MUSIC LIBRARY - Spotify-inspired music browsing for logged-in users
# ═══════════════════════════════════════════════════════════════════════════════

