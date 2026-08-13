'use strict';
/**
 * 像素级验证：检查卡片 PNG 中头像区域与正文起始位置
 * 用法: node scripts/verify-pixels.js <png路径>
 * 输出 JSON：头像区域是否有非背景像素、正文首行起始 x、文本行像素占比
 */
const fs = require('fs');
const zlib = require('zlib');

function parsePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      bitDepth = buf[off + 16];
      colorType = buf[off + 17];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(off + 8, off + 8 + len));
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`unsupported png: bit=${bitDepth} color=${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const px = Buffer.alloc(width * height * 4);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? px[(y - 1) * stride + x - bpp] : 0;
      let v = raw[src++];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      row[x] = v;
    }
  }
  return { width, height, px };
}

function regionStats(px, W, x0, y0, w, h) {
  let n = 0, r = 0, g = 0, b = 0, bright = 0;
  for (let y = y0; y < Math.min(y0 + h, W.height); y++) {
    for (let x = Math.max(0, x0); x < Math.min(x0 + w, W.width); x++) {
      const i = (y * W.width + x) * 4;
      const R = px[i], G = px[i + 1], B = px[i + 2], A = px[i + 3];
      if (A < 128) continue;
      n++; r += R; g += G; b += B;
      if (R + G + B > 400) bright++;
    }
  }
  return { n, bright, avg: n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null };
}

const file = process.argv[2];
const { width, height, px } = parsePng(fs.readFileSync(file));
// 布局常量（与 lib/card.js 一致）
const PAD = 30, INNER_PAD = 22, INNER_X = PAD + INNER_PAD; // 52
const scale = width / 680; // 2x 输出
const s = v => Math.round(v * scale);

// 1. 头像区域：标题栏 y=30+24+18=72，cardTop=72，avatarY=92
const avX = s(INNER_X), avY = s(92), avW = s(46);
const av = regionStats(px, { width, height }, avX, avY, avW, avW);
// 背景色大约 #2b2140~#1a1530（平均约 (36,27,56)），头像应明显不同（肤色/彩色/白色）
const bgDiff = av.avg ? Math.abs(av.avg[0] - 36) + Math.abs(av.avg[1] - 27) + Math.abs(av.avg[2] - 56) : -1;

// 2. 正文首行：baseline = 92+46+15.5*1.8 = 165.9 → 文字像素在 y≈158~166
const bodyY0 = s(158), bodyY1 = s(167);
let firstTextX = -1, lastTextX = -1;
for (let x = s(40); x < s(620); x++) {
  let hit = false;
  for (let y = bodyY0; y <= bodyY1; y++) {
    const i = (y * width + x) * 4;
    if (px[i] + px[i + 1] + px[i + 2] > 500) { hit = true; break; }
  }
  if (hit) { if (firstTextX < 0) firstTextX = x; lastTextX = x; }
}
const expectStart = s(INNER_X); // 文字应从 52 开始
const drift = firstTextX >= 0 ? firstTextX - expectStart : -1;

console.log(JSON.stringify({
  size: `${width}x${height}`,
  avatar: { avgColor: av.avg, brightPixels: av.bright, total: av.n, bgDiff },
  avatarVisible: bgDiff > 30,
  bodyFirstLine: { firstTextX, expectStart, driftPx: drift },
  bodyAligned: drift >= 0 && drift <= 4,
}, null, 2));
