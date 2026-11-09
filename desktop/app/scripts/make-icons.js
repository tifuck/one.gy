// Renders the app and tray icons from one geometry (the one.gy padlock, as in
// static/logos/icon-512.png): build/icon.svg (source), build/icons/*.png and
// build/icon.ico for electron-builder, src/assets/icon.png for the window,
// src/assets/tray/*.png for the tray states. No dependencies:
//   node scripts/make-icons.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BLUE = [14, 143, 214];
const WHITE = [255, 255, 255];

// Shapes in a 512 x 512 box. Each returns true when (x, y) is inside.
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 512 - r);
  const cy = Math.min(Math.max(y, r), 512 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inShackle = (x, y) => {
  const d = Math.hypot(x - 256, y - 168);
  if (y <= 168) return d <= 110 && d >= 67;
  return y < 240 && (inRect(x, y, 146, 168, 189, 240) || inRect(x, y, 323, 168, 366, 240));
};
const inBody = (x, y) => inRect(x, y, 97, 240, 415, 447);
const inKeyhole = (x, y) => inRect(x, y, 233, 281, 279, 396);
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

// Paint list for one icon: [[test(x, y), [r, g, b]], ...], later wins.
function padlock({ bg = BLUE, radius = 80, badge = null }) {
  const layers = [
    [(x, y) => inRoundRect(x, y, radius), bg],
    [(x, y) => inShackle(x, y) || (inBody(x, y) && !inKeyhole(x, y)), WHITE],
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

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="80" fill="rgb(${BLUE.join(',')})"/>
  <path d="M146 240V168a110 110 0 0 1 220 0v72h-43v-72a67 67 0 0 0-134 0v72z" fill="#fff"/>
  <path fill="#fff" fill-rule="evenodd" d="M97 240h318v207H97zM233 281v115h46V281z"/>
</svg>
`;

function write(rel, data) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`${rel} (${data.length} bytes)`);
}

const app = padlock({});
write('build/icon.svg', SVG);
write('build/icons/512x512.png', png(rasterize(app, 512, 3), 512));
write('build/icons/256x256.png', png(rasterize(app, 256), 256));
write('build/icon.ico', ico(app, [16, 24, 32, 48, 64, 128, 256]));
write('src/assets/icon.png', png(rasterize(app, 256), 256));

const GREY = [142, 142, 150];
const DIM = [92, 92, 100];
const TRAY = {
  synced: padlock({ radius: 96 }),
  syncing: padlock({ radius: 96, badge: { outer: WHITE, inner: BLUE } }),
  paused: padlock({ radius: 96, bg: GREY, badge: { outer: WHITE, inner: GREY } }),
  issue: padlock({ radius: 96, badge: { outer: [240, 180, 90] } }),
  offline: padlock({ radius: 96, bg: DIM }),
};
for (const [name, layers] of Object.entries(TRAY)) {
  write(`src/assets/tray/tray-${name}.png`, png(rasterize(layers, 16, 8), 16));
  write(`src/assets/tray/tray-${name}@2x.png`, png(rasterize(layers, 32, 8), 32));
}
