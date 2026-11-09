"""
ONE.GY Desktop end-to-end run through the REAL native UI and the REAL engine
against a live DEV server. Not run in CI and never against production.

Electron needs a display, so the native UI (src/ui) runs in Playwright's
Chromium through dev/browser-bridge.js, which proxies to a real onegy-engine.
A second device token (simulating the website and another computer) checks
and changes one.gy directly with the sync API and its own E2EE crypto.

Covered: wizard (authorize, local folder, new one.gy folder, two-way, E2EE,
preview, start) -> local files show up on one.gy (decrypted names + content)
-> one.gy upload/rename/new folder/trash show up locally -> engine restart ->
conflict ("Ask me") resolved in Issues -> backup sync (default target,
read-only for the other device) -> pause/resume -> Settings > Folders ->
remove the backup (release it) and the sync (move the folder to the trash).
Screenshots of each step, dark and light, 1280x800.

Run from the repo root, after `go build -tags devtls -o desktop/engine/bin/onegy-engine ./cmd/onegy-engine`
in desktop/engine:

  ONEGY_E2E=1 ONEGY_E2E_SERVER=https://127.0.0.1:4999 \
    testsv2/venv/bin/python desktop/app/test/e2e_bridge.py

Env: ONEGY_E2E (required), ONEGY_E2E_SERVER (https DEV server; the engine
gets --insecure-tls), ONEGY_E2E_DIR (work dir, default /tmp/fuse/desktop-e2e),
NODE (node binary). A throwaway account is registered on the server's
website (ONEGY_TEST_URL, see testsv2/config.py) for every run.
"""

import base64
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid

if os.environ.get('ONEGY_E2E') != '1':
    sys.exit('Set ONEGY_E2E=1 to run this end-to-end test (live DEV server).')

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(APP_DIR))
sys.path[:0] = [os.path.join(REPO, 'testsv2'), os.path.join(REPO, 'testsv2', 'tests')]

from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

import crypto_helper  # noqa: E402
from conftest import _create_account_via_browser  # noqa: E402
from helpers.utils import new_test_context, random_password  # noqa: E402

SERVER = os.environ.get('ONEGY_E2E_SERVER', 'https://127.0.0.1:4999').rstrip('/')
if SERVER.lower() in ('https://one.gy', 'https://www.one.gy'):
    sys.exit('Refusing to run against production.')
WORK = os.environ.get('ONEGY_E2E_DIR', '/tmp/fuse/desktop-e2e')
NODE = os.environ.get('NODE', shutil.which('node') or 'node')
ENGINE = os.path.join(REPO, 'desktop', 'engine', 'bin', 'onegy-engine')
SHOTS = os.path.join(WORK, 'shots')
DEVICE = 'E2E-PC'


def log(msg):
    print(f'[E2E] {msg}', flush=True)


def wait(what, ok, timeout=120, step=1.0):
    deadline = time.time() + timeout
    while True:
        res = ok()
        if res:
            return res
        if time.time() > deadline:
            raise AssertionError(f'timed out waiting for {what}')
        time.sleep(step)


# ─── Second device: sync API + E2EE ──────────────────────────────────────────

def seal(key, data):
    nonce = os.urandom(12)
    return base64.b64encode(AESGCM(key).encrypt(nonce, data, None)).decode(), base64.b64encode(nonce).decode()


def unseal(key, ct_b64, nonce_b64):
    return AESGCM(key).decrypt(base64.b64decode(nonce_b64), base64.b64decode(ct_b64), None)


def container(plain, key):
    nonce = os.urandom(12)
    aad = bytes([2]) + (1).to_bytes(4, 'big') + (0).to_bytes(4, 'big') + bytes([1])
    ct = AESGCM(key).encrypt(nonce[:8] + (int.from_bytes(nonce[8:], 'big') ^ 0).to_bytes(4, 'big'), plain, aad)
    return bytes([2]) + (1).to_bytes(4, 'big') + nonce + len(ct).to_bytes(4, 'big') + ct


def open_container(data, key):
    count = int.from_bytes(data[1:5], 'big')
    base, off, out = data[5:17], 17, b''
    for i in range(count):
        n = int.from_bytes(data[off:off + 4], 'big')
        ct = data[off + 4:off + 4 + n]
        off += 4 + n
        nonce = base[:8] + (int.from_bytes(base[8:], 'big') ^ i).to_bytes(4, 'big')
        aad = bytes([2]) + count.to_bytes(4, 'big') + i.to_bytes(4, 'big') + bytes([1 if i == count - 1 else 0])
        out += AESGCM(key).decrypt(nonce, ct, aad)
    return out


class Device:
    """Another device of the same account, talking to the sync API."""

    def __init__(self, http, username, password, master_key):
        self.http, self.mk = http, master_key
        pre = http.post(f'{SERVER}/apiv1/devices/pre-login', data={'username': username}).json()
        token = crypto_helper.derive_auth_token(password, pre['auth_token_salt'])['auth_token']
        resp = http.post(f'{SERVER}/apiv1/devices/authorize', data={
            'username': username, 'auth_token': token, 'device_name': 'E2E-OTHER',
            'platform': 'linux', 'client_version': '0.1.0'})
        assert resp.status == 201, resp.text()
        self.id = resp.json()['device_id']
        self.headers = {'Authorization': f'Bearer {resp.json()["device_token"]}'}

    def get(self, path):
        resp = self.http.get(f'{SERVER}{path}', headers=self.headers)
        assert resp.status == 200, f'{path}: {resp.status} {resp.text()}'
        return resp

    def post(self, path, body):
        return self.http.post(f'{SERVER}{path}', headers=self.headers, data=body)

    def key(self, node):
        enc, nonce = (node['encrypted_name_key'], node['name_key_nonce']) if node['type'] == 'folder' \
            else (node['encrypted_file_key'], node['file_key_nonce'])
        return unseal(self.mk, enc, nonce)

    def name(self, node):
        if not node.get('is_e2e'):
            return node['name']
        return unseal(self.key(node), node['encrypted_name'], node['name_nonce']).decode()

    def tree(self, root):
        """{relative path: node} of the live subtree under folder root."""
        folders, files, token = [], [], ''
        while True:
            page = self.get(f'/apiv1/sync/tree?root={root}&page_token={token}').json()
            folders += page['folders']
            files += page['files']
            token = page.get('next_page_token') or ''
            if not token:
                break
        paths = {root: ''}
        out = {}
        pending = folders[:]
        while pending:
            rest = [f for f in pending if f['parent_id'] not in paths]
            for f in pending:
                if f['parent_id'] in paths:
                    p = f'{paths[f["parent_id"]]}{self.name(f)}'
                    paths[f['id']] = p + '/'
                    out[p + '/'] = f
            if len(rest) == len(pending):
                break
            pending = rest
        for f in files:
            if f['folder_id'] in paths:
                out[paths[f['folder_id']] + self.name(f)] = f
        return out

    def content(self, node):
        resp = self.http.get(f'{SERVER}/apiv1/sync/files/{node["id"]}/content', headers=self.headers)
        assert resp.status == 200, resp.text()
        return open_container(resp.body(), self.key(node))

    def meta(self, file_id, key, version, plain):
        m = json.dumps({'v': 1, 'file_id': file_id, 'content_version': version, 'plain_size': len(plain),
                        'plain_sha256': hashlib.sha256(plain).hexdigest(), 'mtime_ns': time.time_ns(), 'mode': 420},
                       separators=(',', ':'))
        enc, nonce = seal(key, m.encode())
        return {'encrypted_meta': enc, 'meta_nonce': nonce}

    def _one_shot(self, form, blob):
        multipart = {k: str(v) for k, v in form.items() if v is not None}
        multipart['file'] = {'name': 'blob', 'mimeType': 'application/octet-stream', 'buffer': blob}
        return self.http.post(f'{SERVER}/apiv1/sync/files', headers=self.headers, multipart=multipart)

    def upload(self, folder_id, name, plain):
        key, fid = os.urandom(32), str(uuid.uuid4())
        wrapped, wn = seal(self.mk, key)
        en, nn = seal(key, name.encode())
        return self._one_shot({'upload_id': secrets.token_hex(16), 'file_id': fid, 'mode': 'e2ee', 'folder_id': folder_id,
                               'encrypted_file_key': wrapped, 'file_key_nonce': wn, 'encrypted_name': en, 'name_nonce': nn,
                               'stored_extension': os.path.splitext(name)[1], **self.meta(fid, key, 1, plain)},
                              container(plain, key))

    def replace(self, node, plain):
        key = self.key(node)
        return self._one_shot({'upload_id': secrets.token_hex(16), 'mode': 'e2ee', 'folder_id': node['folder_id'],
                               'replace_file_id': node['id'], 'base_content_version': node['content_version'],
                               **self.meta(node['id'], key, node['content_version'] + 1, plain)}, container(plain, key))

    def rename(self, node, name):
        en, nn = seal(self.key(node), name.encode())
        return self.post(f'/apiv1/sync/files/{node["id"]}/rename',
                         {'encrypted_name': en, 'name_nonce': nn, 'stored_extension': os.path.splitext(name)[1]})

    def mkdir(self, parent_id, name):
        key = os.urandom(32)
        en, nn = seal(key, name.encode())
        wk, wn = seal(self.mk, key)
        return self.post('/apiv1/folders', {'name': 'encrypted', 'parent_id': parent_id, 'encrypted_name': en, 'name_nonce': nn,
                                            'encrypted_name_key': wk, 'name_key_nonce': wn,
                                            'client_dedupe_token': secrets.token_hex(8)})


# ─── Bridge + UI helpers ─────────────────────────────────────────────────────

class Bridge:
    def __init__(self):
        state = os.path.join(WORK, 'state')
        self.proc = subprocess.Popen(
            [NODE, os.path.join(APP_DIR, 'dev', 'browser-bridge.js'), '--engine', ENGINE, '--state-dir', state,
             '--socket', os.path.join(WORK, 'e.sock'), '--engine-arg=--insecure-tls'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        line = self.proc.stdout.readline()
        assert line.startswith('[BRIDGE] http'), line
        self.url = line.split()[1]
        self.state = state

    def call(self, path, body=None):
        req = urllib.request.Request(self.url.rstrip('/') + path, method='POST' if body is not None else 'GET',
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read())

    def app(self, name, *args):
        res = self.call(f'/app/{name}', {'args': list(args)})
        assert res['ok'], res
        return res['result']

    def rpc(self, method, params=None):
        res = self.call('/rpc', {'method': method, 'params': params})
        assert res['ok'], res
        return res['result']

    def stub(self, **kw):
        return self.call('/stub', kw) if kw else self.call('/stub')

    def engine_pid(self):
        with open(os.path.join(self.state, 'engine.json')) as f:
            return json.load(f)['pid']

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()


shot_no = [0]


def shot(page, bridge, name):
    shot_no[0] += 1
    for theme, suffix in (('frost-dark', 'dark'), ('frost', 'light')):
        bridge.app('appSettings.set', {'theme': theme})
        page.wait_for_function(f'document.documentElement.dataset.theme === "{theme}"')
        page.wait_for_timeout(250)
        page.screenshot(path=os.path.join(SHOTS, f'{shot_no[0]:02d}-{name}-{suffix}.png'))
    bridge.app('appSettings.set', {'theme': 'frost-dark'})


def rail(page, label):
    page.locator('.dk-rail-item', has_text=label).click()


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    old = time.time() - 60  # past the engine's quiet period for fresh writes
    os.utime(path, (old, old))


def read(path):
    try:
        with open(path, 'rb') as f:
            return f.read()
    except OSError:
        return None


# ─── The run ─────────────────────────────────────────────────────────────────

def main():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(SHOTS)
    local = os.path.join(WORK, 'Projects')
    backup_src = os.path.join(WORK, 'Pictures')
    os.makedirs(local)
    os.makedirs(backup_src)
    bridge = Bridge()
    log(f'bridge at {bridge.url}')
    bridge.app('appSettings.set', {'server_url': SERVER})

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            username = f'e2e_{secrets.token_hex(5)}'
            password = random_password()
            resp, keys = _create_account_via_browser(browser, username, password, None)
            assert resp.status == 200, f'registration failed: {resp.status}'
            master_key = base64.b64decode(keys['master_key'])
            log(f'registered throwaway account {username}')
            api_ctx = new_test_context(browser)
            other = Device(api_ctx.request, username, password, master_key)

            ctx = browser.new_context(viewport={'width': 1280, 'height': 800})
            ctx.add_init_script(path=os.path.join(APP_DIR, 'dev', 'bridge-client.js'))
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(bridge.url)
            try:
                run(page, bridge, other, local, backup_src, username, password)
            except Exception:
                page.screenshot(path=os.path.join(WORK, 'failure.png'))
                log(f'failed; screen: {page.locator("body").inner_text()[:1500]!r}')
                log(f'errors shown: {page.locator(".rd-field-error, .toast-message").all_inner_texts()!r}')
                raise
            assert not errors, errors
            browser.close()
    finally:
        bridge.stop()
    log(f'PASS; screenshots in {SHOTS}')


def run(page, bridge, other, local, backup_src, username, password):
    """The steps through the UI; raises on the first failed expectation."""
    # 1. Wizard: sign in step, authorize this computer.
    page.wait_for_selector('text=Sign in to one.gy')
    shot(page, bridge, 'wizard-signin')
    page.get_by_role('button', name='Continue').click()
    page.wait_for_selector('text=Authorize this computer')
    page.get_by_label('Username').fill(username)
    page.get_by_label('Password').fill(password)
    page.get_by_label('Device name').fill(DEVICE)
    shot(page, bridge, 'wizard-authorize')
    page.get_by_role('button', name='Authorize').click()
    page.wait_for_selector('text=What do you want to do?', timeout=60000)
    shot(page, bridge, 'wizard-action')
    page.get_by_role('button', name='Continue').click()

    # Local folder (picker stubbed), then a new one.gy folder.
    bridge.stub(pickFolder=local)
    page.get_by_role('button', name='Choose folder…').click()
    page.wait_for_selector('text=This folder can be used.')
    shot(page, bridge, 'wizard-local')
    page.get_by_role('button', name='Continue').click()
    page.wait_for_selector('text=Choose a folder on one.gy')
    page.get_by_role('button', name='New folder').click()
    page.get_by_label('Folder name').fill('E2E Projects')
    page.get_by_role('button', name='Create').click()
    page.wait_for_selector('text=Selected: one.gy/E2E Projects')
    page.wait_for_selector('text=This folder can be used.')
    shot(page, bridge, 'wizard-remote')
    page.get_by_role('button', name='Continue').click()
    page.wait_for_selector('text=End-to-end encrypted')
    shot(page, bridge, 'wizard-options')
    page.get_by_role('button', name='Continue').click()
    page.wait_for_selector('.dk-preview')
    shot(page, bridge, 'wizard-preview')
    page.get_by_role('button', name='Start sync').click()
    page.wait_for_selector('.dk-sync-name:text("Projects")')
    sync = bridge.rpc('syncs.list')[0]
    assert sync['encryption'] == 'e2ee' and sync['type'] == 'two_way', sync
    root_id = sync['remote_folder_id']
    log(f'sync {sync["id"]} -> folder {root_id}')

    # 2. Local files show up on one.gy, names and content decrypted by the other device.
    files = {'a.txt': b'alpha', 'docs/b.txt': b'bravo', 'docs/sub/c.bin': os.urandom(200 * 1024)}
    for rel, data in files.items():
        write(os.path.join(local, rel), data)
    wait('uploads on one.gy', lambda: all(rel in other.tree(root_id) for rel in files))
    tree = other.tree(root_id)
    for rel, data in files.items():
        assert other.content(tree[rel]) == data, rel
    log('local -> one.gy: names and content verified with the second device')
    page.wait_for_selector('.dk-status-text:text("Up to date")', timeout=60000)
    shot(page, bridge, 'sync-up-to-date')
    rail(page, 'Transfers')
    page.get_by_role('tab', name='Completed').click()
    page.wait_for_selector('td:has-text("c.bin")')
    shot(page, bridge, 'transfers-completed')

    # 3. Changes on one.gy (like the website) follow locally.
    assert other.upload(root_id, 'web.txt', b'from the web').status == 201
    assert other.rename(tree['a.txt'], 'a-renamed.txt').status == 200
    assert other.mkdir(root_id, 'webdir').status in (200, 201)
    assert other.post(f'/apiv1/sync/files/{tree["docs/b.txt"]["id"]}/trash', {}).status == 200
    bridge.rpc('engine.nudge')
    wait('one.gy changes locally', lambda: read(os.path.join(local, 'web.txt')) == b'from the web'
         and read(os.path.join(local, 'a-renamed.txt')) == b'alpha' and read(os.path.join(local, 'a.txt')) is None
         and os.path.isdir(os.path.join(local, 'webdir')) and read(os.path.join(local, 'docs', 'b.txt')) is None)
    log('one.gy -> local: upload, rename, new folder, trash verified')
    page.wait_for_selector('td:has-text("web.txt")')
    shot(page, bridge, 'transfers-after-web-changes')

    # Engine restart: the supervisor brings it back and the UI recovers.
    os.kill(bridge.engine_pid(), 9)
    rail(page, 'Sync')
    page.wait_for_selector('text=Starting sync engine', timeout=15000)
    page.wait_for_selector('.dk-status-text:text-matches("Up to date|Locked")', timeout=90000)
    if page.locator('.dk-status-text:text("Locked")').count():
        # No OS key store (headless Linux): the key was memory-only, so unlock.
        shot(page, bridge, 'locked-after-restart')
        page.locator('.dk-status-action:text("Unlock")').click()
        page.locator('dialog').get_by_label('Password').fill(password)
        page.locator('dialog').get_by_role('button', name='Unlock').click()
    page.wait_for_selector('.dk-status-text:text("Up to date")', timeout=90000)
    log('engine killed and restarted; UI reconnected')

    # 4. Conflict with "Ask me", resolved in Issues.
    page.get_by_role('button', name='Actions for Projects').click()
    page.get_by_role('menuitem', name='Settings').click()
    page.locator('dialog').get_by_label('When a file changed on both sides').select_option('ask')
    page.locator('dialog').get_by_role('button', name='Save').click()
    page.wait_for_selector('dialog', state='detached')
    page.get_by_role('button', name='Pause Projects').click()
    page.wait_for_selector('.dk-sync .rd-pill:text("Paused")')
    shot(page, bridge, 'sync-paused')
    write(os.path.join(local, 'a-renamed.txt'), b'local edit')
    node = other.tree(root_id)['a-renamed.txt']
    assert other.replace(node, b'remote edit').status == 200
    page.get_by_role('button', name='Resume Projects').click()
    bridge.rpc('engine.nudge')
    rail(page, 'Issues')
    page.wait_for_selector('.dk-issue-path:text("a-renamed.txt")', timeout=90000)
    versioning = bridge.rpc('account.status')['versioning']
    if versioning:
        page.wait_for_selector('text=Previous versions are kept on one.gy.')
        page.get_by_role('button', name='View versions on one.gy').click()
        wait('versions opened on the site', lambda: ['openSite', f'/files/folder/{root_id}'] in bridge.stub()['log'], timeout=10)
    shot(page, bridge, 'issues-conflict')
    page.get_by_role('button', name='Keep this computer').click()
    wait('local copy kept', lambda: other.content(other.tree(root_id)['a-renamed.txt']) == b'local edit', timeout=90)
    page.wait_for_selector('text=No issues', timeout=30000)
    if versioning:
        vs = bridge.rpc('versions.list', {'sync_id': sync['id'], 'path': 'a-renamed.txt'})
        assert vs['versions'], vs
        log(f'conflict resolved; {len(vs["versions"])} previous version(s) kept on one.gy')
    else:
        log('conflict resolved (versioning is off on this server)')

    # 5. Backup: default target, read-only for other devices.
    rail(page, 'Sync')
    page.get_by_role('button', name='Add backup').click()
    bridge.stub(pickFolder=backup_src)
    page.get_by_role('button', name='Choose folder…').click()
    page.wait_for_selector('text=This folder can be used.')
    page.get_by_role('button', name='Continue').click()
    page.wait_for_selector(f'text=one.gy/Backups/{DEVICE}/Pictures')
    shot(page, bridge, 'wizard-backup-target')
    page.get_by_role('button', name='Continue').click()
    page.wait_for_selector('text=End-to-end encrypted', timeout=60000)
    page.get_by_role('button', name='Continue').click()
    page.wait_for_selector('.dk-preview')
    page.get_by_role('button', name='Start sync').click()
    page.wait_for_selector('.dk-sync-name:text("Pictures")')
    backup = next(s for s in bridge.rpc('syncs.list') if s['type'] == 'backup')
    assert backup['remote_path'] == f'/Backups/{DEVICE}/Pictures', backup
    write(os.path.join(backup_src, 'IMG_0001.jpg'), os.urandom(50 * 1024))
    bid = backup['remote_folder_id']
    wait('backup upload', lambda: 'IMG_0001.jpg' in other.tree(bid))
    folder = next(f for f in other.get('/apiv1/sync/tree?root=0').json()['folders'] if f['id'] == bid)
    me = bridge.rpc('account.status')['device_id']
    assert folder['is_backup'] and folder['backup_device_id'] == me, folder
    assert other.upload(bid, 'intruder.txt', b'x').status == 403
    assert other.rename(other.tree(bid)['IMG_0001.jpg'], 'renamed.jpg').status == 403
    log('backup: marked for this device, read-only for the other device')
    page.wait_for_selector('.dk-status-text:text("Up to date")', timeout=60000)
    shot(page, bridge, 'sync-with-backup')

    # 6. Pause/resume holds back an upload.
    page.get_by_role('button', name='Pause Projects').click()
    page.wait_for_selector('.dk-sync .rd-pill:text("Paused")')
    write(os.path.join(local, 'while-paused.txt'), b'later')
    time.sleep(8)
    assert 'while-paused.txt' not in other.tree(root_id)
    page.get_by_role('button', name='Resume Projects').click()
    wait('upload after resume', lambda: 'while-paused.txt' in other.tree(root_id))
    log('pause held the upload back; resume sent it')

    # Settings > Folders.
    rail(page, 'Settings')
    page.get_by_role('tab', name='Folders').click()
    page.wait_for_selector('text=Clear debris now')
    shot(page, bridge, 'settings-folders')

    # 7. Remove the backup (make it a normal folder), then the sync with its local folder.
    rail(page, 'Sync')
    page.get_by_role('button', name='Actions for Pictures').click()
    page.get_by_role('menuitem', name='Remove sync').click()
    page.get_by_text('Make it a normal folder').click()
    shot(page, bridge, 'remove-backup-dialog')
    page.locator('dialog').get_by_role('button', name='Remove sync').click()
    wait('backup released', lambda: not next(f for f in other.get('/apiv1/sync/tree?root=0').json()['folders']
                                            if f['id'] == bid)['is_backup'], timeout=30)
    page.get_by_role('button', name='Actions for Projects').click()
    page.get_by_role('menuitem', name='Remove sync').click()
    page.get_by_text('Also move the folder on this computer to the system trash').click()
    page.locator('dialog').get_by_role('button', name='Remove sync').click()
    page.locator('dialog').get_by_label('Type "Projects" to confirm').fill('Projects')
    page.locator('dialog').get_by_role('button', name='Move to trash').click()
    page.wait_for_selector('text=No syncs yet', timeout=30000)
    assert not os.path.exists(local) and bridge.rpc('syncs.list') == []
    assert ['trash', local] in bridge.stub()['log']
    assert read(os.path.join(backup_src, 'IMG_0001.jpg')) is not None
    log('removed: backup released, sync folder moved to the trash')
    shot(page, bridge, 'sync-empty')


if __name__ == '__main__':
    main()
