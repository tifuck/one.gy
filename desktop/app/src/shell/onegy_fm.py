# ONE.GY Desktop in Nautilus, Nemo and Caja (nautilus-python, nemo-python,
# caja-python): sync status emblems, a "ONE.GY" list view column and "Open on
# one.gy". The app copies this file into each file manager's per-user
# extension folder and fills in EXE (desktop/app/src/main/shell-gtk.js).
# Engine protocol: desktop/docs/engine-ipc.md "File manager integration".
# Everything runs on the file manager's main loop: answers come from a cache,
# misses are asked in batches and the file manager is told to ask again once
# the engine answered; no call waits on the engine for more than TIMEOUT.
import hashlib
import hmac
import json
import os
import socket
import struct
import subprocess
import sys

EXE = ''

_here = os.path.abspath(__file__)
FM = next((name for name in ('Nautilus', 'Nemo', 'Caja') if '/%s-python/' % name.lower() in _here), None)

STATE_DIR = os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'), 'onegy')
LABELS = {'synced': 'Synced', 'syncing': 'Syncing', 'paused': 'Paused', 'error': 'Error'}
STATES = set(LABELS) | {'none'}
BATCH_MS = 50
TIMEOUT = 0.3
HELLO_MS = 2000
MAX_PATHS = 1000  # files.status limit
MAX_ITEMS = 20000  # items remembered to re-ask on a files event
MAX_LINE = 16 << 20


def _log(msg):
    print('[ONEGY] %s' % msg, file=sys.stderr, flush=True)


def _path(info):
    # local items only
    if info.get_uri_scheme() != 'file':
        return None
    path = Gio.File.new_for_uri(info.get_uri()).get_path()
    return path if path and os.path.isabs(path) else None


def _open(path):
    try:
        child = subprocess.Popen([EXE, '--open-item=' + path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        GLib.child_watch_add(GLib.PRIORITY_DEFAULT, child.pid, lambda *_: None)  # reaps it
    except OSError as err:
        _log('cannot start %s: %s' % (EXE, err))


class _Engine:
    def __init__(self):
        self.sock = None
        self.ready = False  # ipc.hello proven, subscribed
        self.buf = b''
        self.next_id = 1
        self.calls = {}  # id -> callback(result or None)
        self.states = {}  # path -> state, as the engine answered
        self.infos = {}  # path -> FileInfo, least recently asked first
        self.queue = {}  # paths to ask, in order
        self.watch_id = self.flush_id = self.retry_id = self.hello_id = 0
        self.delay = 2
        self.monitor = None
        try:
            self.monitor = Gio.File.new_for_path(os.path.join(STATE_DIR, 'engine.json')).monitor_file(Gio.FileMonitorFlags.NONE, None)
            self.monitor.connect('changed', self._engine_json_changed)
        except GLib.Error:
            pass
        self._connect()

    # file manager side

    def state(self, path, info):
        self.infos.pop(path, None)
        self.infos[path] = info
        if len(self.infos) > MAX_ITEMS:
            old = next(iter(self.infos))
            del self.infos[old]
            self.states.pop(old, None)
        state = self.states.get(path)
        if state is None:
            self.queue[path] = None
            self._schedule_flush()
        return state

    def _schedule_flush(self):
        if self.ready and self.queue and not self.flush_id:
            self.flush_id = GLib.timeout_add(BATCH_MS, self._flush)

    def _flush(self):
        self.flush_id = 0
        while self.ready and self.queue:
            paths = []
            for path in self.queue:
                paths.append(path)
                if len(paths) == MAX_PATHS:
                    break
            for path in paths:
                del self.queue[path]
            self._call('files.status', {'paths': paths}, self._answer)
        return False

    def _answer(self, res):
        items = res.get('items') if isinstance(res, dict) else None
        for item in items if isinstance(items, list) else ():
            if not isinstance(item, dict):
                continue
            path, state = item.get('path'), item.get('state')
            if path not in self.infos or state not in STATES:
                continue
            old = self.states.get(path, 'none')
            self.states[path] = state
            if state != old:
                self.infos[path].invalidate_extension_info()

    def _event(self, params):
        if not isinstance(params, dict) or params.get('type') != 'files' or not isinstance(params.get('data'), dict):
            return
        root = params['data'].get('root')
        if not isinstance(root, str) or not os.path.isabs(root):
            return
        root = root.rstrip('/')
        prefix = root + '/'
        for path in self.infos:
            if path == root or path.startswith(prefix):
                self.queue[path] = None
        self._schedule_flush()

    # connection

    def _engine_json_changed(self, *_):
        if self.sock is None:
            if self.retry_id:
                GLib.source_remove(self.retry_id)
            self.delay = 2
            self.retry_id = GLib.timeout_add(100, self._connect)  # once the writes settle

    def _retry(self):
        if not self.retry_id:
            self.retry_id = GLib.timeout_add_seconds(self.delay, self._connect)
            self.delay = min(self.delay * 2, 30)

    def _connect(self):
        self.retry_id = 0
        sock = None
        try:
            with open(os.path.join(STATE_DIR, 'engine.json')) as f:
                info = json.load(f)
            key, path = info['hello_key'], info['socket']
            if not isinstance(key, str) or not key or not isinstance(path, str) or not os.path.isabs(path):
                raise ValueError('engine.json')
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(TIMEOUT)
            sock.connect(path)
            cred = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            if struct.unpack('3i', cred)[1] != os.getuid():
                raise ValueError('the engine socket belongs to another user')
        except (OSError, ValueError, KeyError, TypeError):
            if sock:
                sock.close()
            self._retry()
            return False
        self.sock = sock
        self.watch_id = GLib.io_add_watch(sock.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._readable)
        self.hello_id = GLib.timeout_add(HELLO_MS, self._hello_timeout)
        nonce = os.urandom(16).hex()
        proof = hmac.new(key.encode(), ('onegy-engine-hello:' + nonce).encode(), hashlib.sha256).hexdigest()
        self._call('ipc.hello', {'nonce': nonce}, lambda res: self._hello(res, proof))
        return False

    def _hello(self, res, proof):
        got = res.get('key_proof') if isinstance(res, dict) else None
        if not isinstance(got, str) or not hmac.compare_digest(got.encode(), proof.encode()):
            _log('the engine socket failed ipc.hello; not using it')
            self._disconnect()
            return
        GLib.source_remove(self.hello_id)
        self.hello_id = 0
        if not self._call('files.subscribe', None, lambda _: None):
            return
        self.ready = True
        self.delay = 2
        _log('connected to the engine')
        for path in self.infos:
            self.queue[path] = None
        self._schedule_flush()

    def _hello_timeout(self):
        self.hello_id = 0
        self._disconnect()
        return False

    def _call(self, method, params, done):
        msg = {'jsonrpc': '2.0', 'id': self.next_id, 'method': method}
        if params is not None:
            msg['params'] = params
        self.calls[self.next_id] = done
        self.next_id += 1
        try:
            self.sock.sendall((json.dumps(msg) + '\n').encode())
            return True
        except OSError:
            self._disconnect()
            return False

    def _readable(self, fd, cond):
        sock = self.sock
        try:
            data = sock.recv(65536)
        except socket.timeout:
            return True
        except OSError:
            data = b''
        if not data or len(self.buf) + len(data) > MAX_LINE:
            self._disconnect()
            return False
        lines = (self.buf + data).split(b'\n')
        self.buf = lines.pop()
        for line in lines:
            if self.sock is not sock:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get('method') == 'event':
                if self.ready:
                    self._event(msg.get('params'))
            elif msg.get('id') in self.calls:
                done = self.calls.pop(msg['id'])
                done(None if 'error' in msg else msg.get('result'))
        return self.sock is sock

    def _disconnect(self):
        if self.sock is None:
            return
        for source in (self.watch_id, self.hello_id, self.flush_id):
            if source:
                GLib.source_remove(source)
        self.watch_id = self.hello_id = self.flush_id = 0
        self.sock.close()
        if self.ready:
            _log('lost the engine')
        self.sock, self.ready, self.buf = None, False, b''
        self.calls.clear()
        # no engine, no emblems
        shown = [path for path, state in self.states.items() if state != 'none']
        self.states.clear()
        for path in shown:
            self.infos[path].invalidate_extension_info()
        self._retry()


_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        _engine = _Engine()
    return _engine


if FM:
    from gi.repository import Gio, GLib, GObject
    import importlib
    _fm = importlib.import_module('gi.repository.' + FM)

    class OnegyExtension(GObject.GObject, _fm.InfoProvider, _fm.MenuProvider, _fm.ColumnProvider):
        def get_columns(self):
            return [_fm.Column(name='OnegyExtension::status', attribute='onegy_status', label='ONE.GY',
                               description='Sync status of the item on one.gy')]

        def update_file_info(self, info):
            path = _path(info)
            state = _get_engine().state(path, info) if path else None
            info.add_string_attribute('onegy_status', LABELS.get(state, ''))  # Nemo and Caja show "unknown" for none
            if state in LABELS:
                info.add_emblem('onegy-' + state)

        # Nautilus 4.0: (files); Nautilus 3.0, Nemo, Caja: (window, files)
        def get_file_items(self, *args):
            files = args[-1]
            if not EXE or len(files) != 1:
                return []
            path = _path(files[0])
            if not path or _get_engine().states.get(path, 'none') == 'none':
                return []
            item = _fm.MenuItem(name='OnegyExtension::open', label='Open on one.gy', tip='Open this item on one.gy')
            item.connect('activate', lambda *_: _open(path))
            return [item]
