#!/usr/bin/env python3
# Dev-only stand-in for the engine's file manager side (engine-ipc.md "File
# manager integration"), to try the file manager extensions without an
# account: listens on a socket, writes <state dir>/engine.json, answers
# ipc.hello, files.subscribe and files.status. The state of a path under
# --root comes from --overrides (JSON {"<name>": "<state>"}, read on every
# call) or its name: containing error, paused, syncing or synced; anything
# else is none. SIGUSR1 sends a files event for --root. Logs each call.
#   python3 dev/fake-fm-engine.py --root DIR [--overrides FILE] [--wrong-key]
import argparse
import asyncio
import hashlib
import hmac
import json
import os
import signal
import sys

ap = argparse.ArgumentParser()
ap.add_argument('--root', required=True)
ap.add_argument('--overrides')
ap.add_argument('--wrong-key', action='store_true', help='answer ipc.hello with a bad key_proof')
args = ap.parse_args()
root = os.path.abspath(args.root)
state_dir = os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'), 'onegy')
run_dir = os.path.join(os.environ['XDG_RUNTIME_DIR'], 'onegy') if os.environ.get('XDG_RUNTIME_DIR') else os.path.join(state_dir, 'run')
sock_path = os.path.join(run_dir, 'engine.sock')
key = os.urandom(16).hex()
subscribers = set()


def log(msg):
    print('[FAKE] %s' % msg, file=sys.stderr, flush=True)


def state(path):
    if path != root and not path.startswith(root + '/'):
        return 'none'
    name = os.path.basename(path)
    if args.overrides and os.path.exists(args.overrides):
        with open(args.overrides) as f:
            over = json.load(f)
        if name in over:
            return over[name]
    for s in ('error', 'paused', 'syncing', 'synced'):
        if s in name.lower():
            return s
    return 'none'


async def serve(reader, writer):
    def send(msg):
        writer.write((json.dumps(msg) + '\n').encode())
    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            msg = json.loads(line)
            method, params = msg.get('method'), msg.get('params') or {}
            if method == 'ipc.hello':
                proof = hmac.new((key + 'x' if args.wrong_key else key).encode(), ('onegy-engine-hello:' + params['nonce']).encode(), hashlib.sha256).hexdigest()
                result = {'key_proof': proof}
            elif method == 'files.subscribe':
                subscribers.add(send)
                result = {}
            elif method == 'files.status':
                result = {'items': [{'path': p, 'state': state(p)} for p in params['paths']]}
                log('files.status %d paths: %s' % (len(params['paths']), ', '.join('%s=%s' % (os.path.basename(i['path']), i['state']) for i in result['items'])))
                send({'jsonrpc': '2.0', 'id': msg['id'], 'result': result})
                continue
            else:
                send({'jsonrpc': '2.0', 'id': msg['id'], 'error': {'code': -32000, 'message': 'forbidden', 'data': {'code': 'forbidden'}}})
                continue
            log(method)
            send({'jsonrpc': '2.0', 'id': msg['id'], 'result': result})
    finally:
        subscribers.discard(send)
        writer.close()


def event():
    log('files event for %s to %d subscribers' % (root, len(subscribers)))
    for send in list(subscribers):
        send({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'files', 'data': {'sync_id': 's_fake', 'root': root}}})


async def main():
    os.makedirs(run_dir, mode=0o700, exist_ok=True)
    os.makedirs(state_dir, exist_ok=True)
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    server = await asyncio.start_unix_server(serve, sock_path)
    os.chmod(sock_path, 0o600)
    info = os.path.join(state_dir, 'engine.json')
    with open(info + '.tmp', 'w') as f:
        json.dump({'pid': os.getpid(), 'socket': sock_path, 'version': 'fake', 'hello_key': key}, f)
    os.chmod(info + '.tmp', 0o600)
    os.replace(info + '.tmp', info)
    asyncio.get_running_loop().add_signal_handler(signal.SIGUSR1, event)
    log('listening on %s, root %s' % (sock_path, root))
    async with server:
        await server.serve_forever()


asyncio.run(main())
