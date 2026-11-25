'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gtk = require('../src/main/shell-gtk');

const FMS = ['nautilus-python', 'nemo-python', 'caja-python'];
const hasPython = (() => { try { execFileSync('python3', ['-c', '']); return true; } catch { return false; } })();

test('install copies the extension with the app path for each file manager; uninstall removes only it', async () => {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onegy-gtk-'));
  const exe = '/opt/ONE GY/it\'s "here"\\ünï.AppImage';
  await gtk.install({ exe, dataHome });
  for (const fm of FMS) {
    const file = path.join(dataHome, fm, 'extensions', 'onegy_fm.py');
    assert.match(fs.readFileSync(file, 'utf8'), /^EXE = "\/opt\/ONE GY\/it's \\"here\\"\\\\ünï\.AppImage"$/m);
    if (hasPython) {
      // the Python reading of the copy is the app path exactly
      const got = execFileSync('python3', ['-c', 'import ast,sys; t=ast.parse(open(sys.argv[1]).read()); print(next(n.value.value for n in t.body if isinstance(n, ast.Assign) and n.targets[0].id == "EXE"), end="")', file], { encoding: 'utf8' });
      assert.equal(got, exe);
    }
    fs.mkdirSync(path.join(dataHome, fm, 'extensions', '__pycache__'));
    fs.writeFileSync(path.join(dataHome, fm, 'extensions', '__pycache__', 'onegy_fm.cpython-312.pyc'), '');
    fs.writeFileSync(path.join(dataHome, fm, 'extensions', '__pycache__', 'other.cpython-312.pyc'), '');
    fs.writeFileSync(path.join(dataHome, fm, 'extensions', 'other.py'), '');
  }
  await gtk.install({ exe: '/usr/bin/onegy-desktop', dataHome }); // again: overwrites
  assert.match(fs.readFileSync(path.join(dataHome, 'nemo-python', 'extensions', 'onegy_fm.py'), 'utf8'), /^EXE = "\/usr\/bin\/onegy-desktop"$/m);
  await gtk.uninstall({ dataHome });
  for (const fm of FMS) {
    const dir = path.join(dataHome, fm, 'extensions');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['__pycache__', 'other.py']);
    assert.deepEqual(fs.readdirSync(path.join(dir, '__pycache__')), ['other.cpython-312.pyc']);
  }
  await gtk.uninstall({ dataHome }); // nothing left: no error
  await gtk.uninstall({ dataHome: path.join(dataHome, 'missing') });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test('the extension source compiles and loads outside a file manager', { skip: !hasPython }, () => {
  const src = path.join(__dirname, '..', 'src', 'shell', 'onegy_fm.py');
  execFileSync('python3', ['-c', 'import importlib.util,sys; s=importlib.util.spec_from_file_location("onegy_fm", sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert m.FM is None', src]);
});
