// Renders every icon from one geometry, the one.gy key mark ("Keycut": a 1
// cut like a key; the bitting reads 0011 0001 = 0x31, ASCII "1"): build/icon.svg
// (source), build/icons/*.png and build/icon.ico for electron-builder,
// src/assets/icon.png for the window, src/assets/tray/*.png for the tray
// states, and the site favicons in static/logos/. The inline marks in
// templates/_nav.html, templates/landing_frost_hybrid.html and src/ui/nav.js
// use the 24-unit outline this script prints. No dependencies:
//   node scripts/make-icons.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DARK = [11, 11, 14];
const CYAN = [55, 182, 255];
const WHITE = [255, 255, 255];

// The mark in a 100 x 100 box. Outline corners are [x, y, cut]: cut > 0 rounds
// the corner with a quadratic that starts `cut` units before it.
const DX = 1.26; const DY = -1.5; // centres the mark's bounding box
const OUTLINE = (() => {
  const L = 43; const R = 59; const T = 12; const Y0 = 26; const ST = 4.8;
  const a = (36 * Math.PI) / 180; const len = 13; const t = 11; const cut = 2.2; const bit = 0.8;
  const C = [L - len * Math.cos(a), T + len * Math.sin(a)]; // flag tip, top
  const D = [C[0] + t * Math.sin(a), C[1] + t * Math.cos(a)]; // flag tip, bottom
  const E = [L, D[1] - (L - D[0]) * Math.tan(a)]; // flag meets the stem
  const pts = [[R, T, cut], [R, Y0, 0]];
  [0, 0, 1, 1, 0, 0, 0, 1].forEach((b, i) => {
    const y = Y0 + i * ST;
    pts.push([R - (b ? 6.5 : 2.5), y + ST / 2, bit], [R, y + ST, i < 7 ? bit : 0]);
  });
  pts.push([R, 70, 0], [L, 70, 0], [...E, cut * 0.6], [...D, cut], [...C, cut], [L, T, cut]);
  return pts.map(([x, y, c]) => [x + DX, y + DY, c]);
})();
const RING = { cx: 51 + DX, cy: 77 + DY, r: 10, w: 8, dot: 3 };

// Outline as segments: ['L', p] for corners and straight runs, ['Q', ctrl, end] for rounded corners.
const SEGS = [];
OUTLINE.forEach(([x, y, c], i) => {
  if (!c) { SEGS.push(['L', [x, y]]); return; }
  const toward = ([ox, oy]) => {
    const k = Math.min(c, Math.hypot(ox - x, oy - y) / 2) / Math.hypot(ox - x, oy - y);
    return [x + (ox - x) * k, y + (oy - y) * k];
  };
  SEGS.push(['L', toward(OUTLINE[(i + OUTLINE.length - 1) % OUTLINE.length])], ['Q', [x, y], toward(OUTLINE[(i + 1) % OUTLINE.length])]);
});
const num = (v) => String(+v.toFixed(2));
const pathD = (s, o) => SEGS.map(([cmd, ...ps], i) => (i ? cmd : 'M') + ps.map(([x, y]) => `${num(x * s + o)} ${num(y * s + o)}`).join(' ')).join('') + 'Z';

const POLY = [];
for (const [cmd, a, b] of SEGS) {
  if (cmd === 'L') { POLY.push(a); continue; }
  const [x0, y0] = POLY[POLY.length - 1];
  for (let k = 1; k <= 6; k++) {
    const t = k / 6; const u = 1 - t;
    POLY.push([u * u * x0 + 2 * u * t * a[0] + t * t * b[0], u * u * y0 + 2 * u * t * a[1] + t * t * b[1]]);
  }
}
function inPoly(x, y) {
  let inside = false;
  for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
    const [xi, yi] = POLY[i]; const [xj, yj] = POLY[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inKey = (x, y) => {
  const d = Math.hypot(x - RING.cx, y - RING.cy);
  return (d >= RING.r - RING.w / 2 && d <= RING.r + RING.w / 2) || (x > 30 && x < 62 && y > 8 && y < 70 && inPoly(x, y));
};
const inDot = (x, y) => Math.hypot(x - RING.cx, y - RING.cy) <= RING.dot;

// Shapes in a 512 x 512 box. Each returns true when (x, y) is inside.
const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 512 - r);
  const cy = Math.min(Math.max(y, r), 512 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// Paint list for one icon: [[test(x, y), [r, g, b]], ...], later wins. The
// mark spans `scale` of the box, moved `shift` px left; radius 0 is a
// full-bleed square.
const APP_SCALE = 0.72;
function keycut({ bg = DARK, radius = 80, scale = APP_SCALE, shift = 0, dot = CYAN, badge = null }) {
  const k = (512 * scale) / 100; const o = 256 - 50 * k; const ox = o - shift;
  const layers = [
    [(x, y) => inRoundRect(x, y, radius), bg],
    [(x, y) => inKey((x - ox) / k, (y - o) / k), WHITE],
    [(x, y) => inDot((x - ox) / k, (y - o) / k), dot],
  ];
  if (badge) {
    layers.push([(x, y) => inCircle(x, y, 404, 404, 120), null]); // cut-out ring
    layers.push([(x, y) => inCircle(x, y, 404, 404, 92), badge.outer]);
    if (badge.inner) layers.push([(x, y) => inCircle(x, y, 404, 404, 44), badge.inner]);
  }
  return layers;
}

function rasterize(layers, size, ss = 4) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxi + (sx + 0.5) / ss) * scale;
          const y = (py + (sy + 0.5) / ss) * scale;
          let color;
          for (const [inside, c] of layers) if (inside(x, y)) color = c;
          if (color) { r += color[0]; g += color[1]; b += color[2]; a += 1; }
        }
      }
      const i = (py * size + pxi) * 4;
      if (a) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Classic 32-bit DIB entry (BGRA, bottom-up, plus an empty AND mask).
function dib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; pixels[d + 1] = rgba[s + 1]; pixels[d + 2] = rgba[s]; pixels[d + 3] = rgba[s + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, pixels, mask]);
}

function ico(layers, sizes) {
  const images = sizes.map((s) => (s >= 256 ? png(rasterize(layers, s), s) : dib(rasterize(layers, s), s)));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

const rgb = (c) => `rgb(${c.join(',')})`;
const K = (512 * APP_SCALE) / 100; const O = 256 - 50 * K;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="80" fill="${rgb(DARK)}"/>
  <path d="${pathD(K, O)}" fill="#fff"/>
  <circle cx="${num(RING.cx * K + O)}" cy="${num(RING.cy * K + O)}" r="${num(RING.r * K)}" fill="none" stroke="#fff" stroke-width="${num(RING.w * K)}"/>
  <circle cx="${num(RING.cx * K + O)}" cy="${num(RING.cy * K + O)}" r="${num(RING.dot * K)}" fill="${rgb(CYAN)}"/>
</svg>
`;

function write(rel, data) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`${rel} (${data.length} bytes)`);
}

const app = keycut({});
write('build/icon.svg', SVG);
write('build/icons/512x512.png', png(rasterize(app, 512, 3), 512));
write('build/icons/256x256.png', png(rasterize(app, 256), 256));
write('build/icon.ico', ico(app, [16, 24, 32, 48, 64, 128, 256]));
write('src/assets/icon.png', png(rasterize(app, 256), 256));

const GREY = [142, 142, 150];
const DIM = [92, 92, 100];
// The mark sits left of centre in every state so the badge never cuts the ring.
const tray = (o) => keycut({ radius: 96, scale: 0.76, shift: 46, ...o });
const TRAY = {
  synced: tray({}),
  syncing: tray({ badge: { outer: WHITE, inner: CYAN } }),
  paused: tray({ bg: GREY, dot: GREY, badge: { outer: WHITE, inner: GREY } }),
  issue: tray({ badge: { outer: [240, 180, 90] } }),
  offline: tray({ bg: DIM, dot: DIM }),
};
for (const [name, layers] of Object.entries(TRAY)) {
  write(`src/assets/tray/tray-${name}.png`, png(rasterize(layers, 16, 8), 16));
  write(`src/assets/tray/tray-${name}@2x.png`, png(rasterize(layers, 32, 8), 32));
}
// Linux panels show the bare square, so badge-free states centre the mark
// there; badged ones keep the shift. Windows keeps the set above.
for (const [name, o] of Object.entries({ synced: {}, offline: { bg: DIM, dot: DIM } })) {
  write(`src/assets/tray/tray-${name}-linux.png`, png(rasterize(tray({ ...o, shift: 0 }), 32, 8), 32));
}
for (const name of ['syncing', 'paused', 'issue']) {
  write(`src/assets/tray/tray-${name}-linux.png`, png(rasterize(TRAY[name], 32, 8), 32));
}

const SITE = '../../static/logos';
const favicon = keycut({ radius: 96, scale: 0.9 });
const square = keycut({ radius: 0, scale: 0.7 }); // iOS masks its own corners
write(`${SITE}/favicon.ico`, ico(favicon, [16, 32, 48]));
write(`${SITE}/favicon-32x32.png`, png(rasterize(favicon, 32, 8), 32));
write(`${SITE}/apple-touch-icon.png`, png(rasterize(square, 180), 180));
write(`${SITE}/icon-512.png`, png(rasterize(square, 512, 3), 512));

const s = 0.24;
console.log(`\n24-unit mark for the inline SVGs:\n  path d="${pathD(s, 0)}"\n  ring cx="${num(RING.cx * s)}" cy="${num(RING.cy * s)}" r="${num(RING.r * s)}" stroke-width="${num(RING.w * s)}", dot r="${num(RING.dot * s)}"`);
