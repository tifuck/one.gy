'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanNav, avatarDataUrl, isSitePath } = require('../src/main/site-nav');

const NAV = {
  links: [
    { label: 'Files', href: '/files', active: true, badge: 0 },
    { label: 'Notes', href: '/notes', active: false, badge: 3 },
  ],
  username: 'alice',
  role: 'User',
  account: { label: 'Account & settings', short: 'Account', href: '/account' },
  avatar: '/avatar/7.svg',
};

test('keeps a well-formed nav as plain values', () => {
  assert.deepEqual(cleanNav(NAV), NAV);
});

test('drops links that are not same-origin paths or plain text', () => {
  const nav = cleanNav({
    ...NAV,
    links: [
      { label: 'Evil', href: 'https://evil.example/x' },
      { label: 'Proto', href: '//evil.example' },
      { label: 'JS', href: 'javascript:alert(1)' },
      { label: 'Line\nbreak', href: '/ok' },
      { label: 'x'.repeat(41), href: '/long' },
      { label: 'Fine', href: '/fine', active: 'yes', badge: -2 },
    ],
  });
  assert.deepEqual(nav.links, [{ label: 'Fine', href: '/fine', active: false, badge: 0 }]);
});

test('rejects junk and bad account / avatar values', () => {
  assert.equal(cleanNav(null), null);
  assert.equal(cleanNav({ links: 'nope' }), null);
  const nav = cleanNav({ links: [], username: 5, account: { label: 'A', href: 'https://x' }, avatar: 'data:image/svg+xml,<svg>' });
  assert.deepEqual(nav, { links: [], username: '', role: '', account: null, avatar: null });
  assert.equal(isSitePath('/a b'), false);
  assert.equal(isSitePath('/a\\b'), false);
});

const response = (type, body, ok = true) => ({
  ok, headers: { get: () => type }, arrayBuffer: async () => Buffer.from(body),
});

test('avatar becomes a data: URL only for small images', async () => {
  assert.equal(await avatarDataUrl(async () => response('image/svg+xml; charset=utf-8', '<svg/>'), '/a'),
    `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`);
  assert.equal(await avatarDataUrl(async () => response('text/html', '<script>'), '/a'), null);
  assert.equal(await avatarDataUrl(async () => response('image/png', Buffer.alloc(300 * 1024)), '/a'), null);
  assert.equal(await avatarDataUrl(async () => response('image/png', 'x', false), '/a'), null);
});
