'use strict';
/**
 * 置顶评论卡片渲染器 —— SVG 手绘布局 + resvg 转 PNG
 * 设计复刻 templates/comment-card-template.html：深色渐变背景 + 粉色点缀
 * 全平台：resvg 预编译二进制，字体用系统字体（macOS PingFang / Win 微软雅黑 / Linux Noto CJK）
 */

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { downloadImage, mimeFromBuffer, normUrl, imageSize } = require('./api');

// ====== 设计常量（逻辑像素 680 宽，渲染时 2x 输出保证清晰度） ======
const W = 680;
const PAD = 30;
const CARD_W = W - PAD * 2;          // 620
const CARD_RX = 18;
const INNER_PAD = 22;                // 卡片内边距
const INNER_X = PAD + INNER_PAD;     // 52
const INNER_W = CARD_W - INNER_PAD * 2; // 576
const TEXT_INNER = '#f5f3fc';
const TEXT_DIM = '#9a93b8';
const TEXT_DIMMER = '#6f6890';
const TEXT_SUB = '#c9c2e0';
const PINK = '#FB7299';
const LINE_H = 1.8;

// ====== 图片下载缓存（有界 LRU，防止监控长跑内存无界增长） ======
const imgCache = new Map();       // url -> data URI（Promise）
const bufCache = new Map();       // url -> Buffer（Promise，供尺寸解析复用）
const CACHE_MAX = 200;            // 单缓存容量上限（超出淘汰最旧）
/** 写入缓存并按容量淘汰最旧条目（两张缓存同步淘汰同 key） */
function cacheSet(map, url, p) {
  if (map.has(url)) map.delete(url); // 重复写入刷新为最近使用
  map.set(url, p);
  if (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
    const other = map === imgCache ? bufCache : imgCache;
    if (other.has(oldest)) other.delete(oldest);
  }
}
/** 下载原始图片 buffer（带缓存；失败返回 null 且不缓存，允许下次重试） */
function fetchBuf(url) {
  if (!url) return Promise.resolve(null);
  if (bufCache.has(url)) return bufCache.get(url);
  const p = downloadImage(url).then(b => {
    if (!b) { // 失败不缓存，避免网络瞬时故障导致图片在本进程内永久缺失
      bufCache.delete(url);
      imgCache.delete(url);
      return null;
    }
    return b;
  });
  cacheSet(bufCache, url, p);
  return p;
}
/** 下载图片并转 data URI（带缓存；失败返回 ''） */
async function dataUri(url) {
  if (!url) return '';
  if (imgCache.has(url)) return imgCache.get(url);
  const p = fetchBuf(url).then(buf => {
    if (!buf) return '';
    return `data:${mimeFromBuffer(buf)};base64,${buf.toString('base64')}`;
  });
  cacheSet(imgCache, url, p);
  return p;
}
/** 解析图片实际尺寸（带缓存；失败返回 null） */
async function picSize(url) {
  const buf = await fetchBuf(url);
  return buf ? imageSize(buf) : null;
}
/** 按原图比例计算单图显示尺寸（不裁剪；超长等比缩到 maxH） */
function fitSinglePic(w, h, maxW, maxH) {
  if (!w || !h) return { w: Math.min(320, maxW), h: Math.min(320, maxW) * 0.75 };
  let iw = Math.min(320, maxW);
  let ih = Math.round(iw * (h / w));
  if (ih > maxH) { ih = maxH; iw = Math.round(ih * (w / h)); }
  return { w: iw, h: ih };
}

function defaultFontFamily() {
  switch (process.platform) {
    case 'darwin': return 'PingFang SC';
    case 'win32':  return 'Microsoft YaHei';
    default:       return 'Noto Sans CJK SC';
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function fmtCount(n) {
  if (n == null) return '0';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ====== 文本度量与换行（CJK 全角近似，够用且跨平台稳定） ======
function charWpx(ch, fs) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x2e80 && cp <= 0x9fff) return fs;         // CJK 统一表意/假名/谚文
  if (cp >= 0xf900 && cp <= 0xfaff) return fs;         // CJK 兼容
  if (cp >= 0xff00 && cp <= 0xffef) return fs;         // 全角符号
  if (cp >= 0x20000 && cp <= 0x2ffff) return fs * 2;   // CJK 扩展
  if (cp >= 0x20 && cp <= 0x7e) return fs * 0.55;      // ASCII
  return fs * 0.6;
}

function measureText(s, fs) {
  let w = 0;
  for (const ch of String(s)) w += charWpx(ch, fs);
  return w;
}

/** 消息 → token 流（文本 / 表情图片） */
function tokenize(message, emoteMap) {
  const tokens = [];
  const msg = String(message || '');
  const keys = Object.keys(emoteMap || {}).filter(k => k && msg.includes(k));
  if (!keys.length) {
    if (msg) tokens.push({ type: 'text', text: msg });
    return tokens;
  }
  let i = 0;
  while (i < msg.length) {
    let best = null;
    for (const key of keys) {
      const idx = msg.indexOf(key, i);
      if (idx >= 0 && (best === null || idx < best.idx)) best = { idx, key };
    }
    if (!best) {
      tokens.push({ type: 'text', text: msg.slice(i) });
      break;
    }
    if (best.idx > i) tokens.push({ type: 'text', text: msg.slice(i, best.idx) });
    const e = emoteMap[best.key];
    tokens.push({ type: 'emote', key: best.key, text: e?.text || best.key, url: normUrl(e?.url || '') });
    i = best.idx + best.key.length;
  }
  return tokens;
}

/** token 流 → 行（支持 '\n' 硬换行与超宽软换行） */
function wrapTokens(tokens, maxW, fs, emoteW = 36) {
  const lines = [];
  let cur = [];
  let curW = 0;
  const flush = () => {
    if (cur.length) { lines.push(cur); cur = []; curW = 0; }
  };
  for (const t of tokens) {
    if (t.type === 'emote') {
      if (cur.length && curW + emoteW + 4 > maxW) flush();
      cur.push({ ...t, w: emoteW + 4 });
      curW += emoteW + 4;
      continue;
    }
    for (const ch of t.text) {
      if (ch === '\n') { flush(); continue; }
      const w = charWpx(ch, fs);
      if (cur.length && curW + w > maxW) flush();
      cur.push({ type: 'char', ch, w });
      curW += w;
    }
  }
  flush();
  return lines;
}

/** 单行 SVG 输出：连续字符合成 <text>，表情插 <image> */
function lineToSvg(line, fs, x0, baseline, emoteImgs) {
  let out = '';
  let buf = '';
  const flushText = () => {
    if (buf) {
      out += `<text x="${x0}" y="${baseline}" font-size="${fs}" fill="${TEXT_INNER}">${esc(buf)}</text>`;
      x0 += measureText(buf, fs);
      buf = '';
    }
  };
  for (const t of line) {
    if (t.type === 'char') {
      buf += t.ch;
    } else {
      flushText();
      const dataUri = emoteImgs[t.key];
      if (dataUri) {
        const size = t.w - 4;
        out += `<image href="${dataUri}" x="${x0}" y="${baseline - fs + (fs - size) / 2}" width="${size}" height="${size}"/>`;
        x0 += t.w;
      } else {
        buf += `[${t.text}]`;
        x0 += measureText(`[${t.text}]`, fs);
      }
    }
  }
  flushText();
  return out;
}

// ====== 卡片组装 ======

/**
 * @param {object} comment getPinnedComment 返回值
 * @param {object[]} replies getReplies 返回值
 * @param {object} opts { upName, upMid, showReplies, oid }
 * @returns {Promise<string>} SVG 字符串
 */
async function buildSvg(comment, replies, opts = {}) {
  const { upName = '', upMid = 0, showReplies = false, oid = 0 } = opts;
  const els = [];
  const defs = defsSvg();
  let y = PAD;

  // 1. 标题栏
  y = renderTitleBar(els, y, '置顶评论', `动态 · ${upName || 'B站动态'}`);

  // 2. 主评论卡片
  const mc = renderMainCard(comment, y, upMid);
  els.push(...mc.els);
  y = mc.cardBottom;

  // 3. 回复区
  if (showReplies && replies.length) {
    y += 16;
    els.push(`<text x="${PAD}" y="${y}" font-size="13" font-weight="600" fill="${TEXT_SUB}">精彩回复</text>`);
    const badgeText = `${replies.length}/${fmtCount(comment.rcount)}`;
    const badgeW2 = measureText(badgeText, 11) + 16;
    els.push(`<rect x="${PAD + measureText('精彩回复', 13) + 8}" y="${y - 12}" width="${badgeW2}" height="18" rx="9" fill="rgba(251,114,153,0.2)"/>`);
    els.push(`<text x="${PAD + measureText('精彩回复', 13) + 8 + badgeW2 / 2}" y="${y + 1}" font-size="11" fill="${PINK}" text-anchor="middle">${badgeText}</text>`);
    y += 8;

    const rw = CARD_W - 28;              // 回复条宽度
    const rInnerW = rw - 34 - 10;        // 去掉头像与间距
    const rFs = 13.5;
    const rLh = rFs * 1.7;
    for (const r of replies) {
      y += 12;
      const rTop = y;
      const lines = wrapTokens(r._tokens, rInnerW, rFs);
      const textH = lines.length * rLh;
      const bodyH = Math.max(textH, 34);
      const itemH = 12 + 12 + bodyH + 16 + 22; // 上内边距 + 文本 + 元信息行 + 下内边距
      els.push(`<rect x="${PAD}" y="${rTop}" width="${rw}" height="${itemH}" rx="12" fill="rgba(255,255,255,0.05)"/>`);
      // 头像
      els.push(`<image href="${esc(r.avatar)}" x="${PAD + 14}" y="${rTop + 12}" width="34" height="34" clip-path="url(#avatarClipSm)" preserveAspectRatio="xMidYMid slice"/>`);
      // 名字
      const nameX = PAD + 14 + 34 + 10;
      let nameEl = `<text x="${nameX}" y="${rTop + 24}" font-size="12.5" font-weight="600" fill="${TEXT_SUB}">${esc(r.author)}</text>`;
      if (String(r.mid) === String(upMid)) {
        const nw = measureText(r.author, 12.5);
        nameEl += `<text x="${nameX + nw + 4}" y="${rTop + 24}" font-size="11" fill="${PINK}">· UP</text>`;
      }
      els.push(nameEl);
      // 正文
      let ly = rTop + 12 + 18 + 4;
      for (const line of lines) {
        ly += rLh;
        els.push(lineToSvg(line, rFs, nameX, ly, r._emoteImgs || {}));
      }
      // 元信息
      const metaY = rTop + itemH - 16;
      els.push(`<text x="${nameX}" y="${metaY}" font-size="11" fill="${TEXT_DIMMER}">${fmtTime(r.ctime)} · ${fmtCount(r.like)} 赞</text>`);
      y = rTop + itemH;
    }
  }

  // 4. 页脚（右下角显示动态完整链接）
  const footRight = oid ? `https://t.bilibili.com/${oid}` : `#${String(comment.rpid).slice(-8)}`;
  y = renderFooter(els, y, 'BILI PINNED COMMENT', footRight);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${y}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
  return svg;
}

/** 渲染 SVG → PNG Buffer（2x 输出保证清晰度） */
function renderPng(svg, scale = 2) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: W * scale },
    font: { loadSystemFonts: true, defaultFontFamily: defaultFontFamily() },
  });
  return r.render().asPng();
}

/**
 * 预下载所有远程图片并注入 comment/replies（下载失败置空，渲染时降级为占位/文本）
 */
async function prepareImages(comment, replies) {
  comment._tokens = tokenize(comment.message, comment.emote);
  comment._emoteImgs = {};
  for (const t of comment._tokens) {
    if (t.type === 'emote' && t.url) comment._emoteImgs[t.key] = await dataUri(t.url);
  }
  comment._picImgs = await Promise.all((comment.pictures || []).map(u => dataUri(u)));
  comment._picSizes = await Promise.all((comment.pictures || []).map(u => picSize(u)));
  if (comment.avatar) comment.avatar = await dataUri(comment.avatar);
  for (const r of replies) {
    r._tokens = tokenize(r.message, r.emote);
    r._emoteImgs = {};
    for (const t of r._tokens) {
      if (t.type === 'emote' && t.url) r._emoteImgs[t.key] = await dataUri(t.url);
    }
    if (r.avatar) r.avatar = await dataUri(r.avatar);
  }
}

/** 废弃：互动链图片下载已并入 prepareChainItems */

function defsSvg() {
  return `
    <linearGradient id="bg" x1="0" y1="0" x2="0.94" y2="1">
      <stop offset="0" stop-color="#2b2140"/>
      <stop offset="0.6" stop-color="#1a1530"/>
      <stop offset="1" stop-color="#141126"/>
    </linearGradient>
    <linearGradient id="pink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FB7299"/>
      <stop offset="1" stop-color="#FF5C8A"/>
    </linearGradient>
    <clipPath id="avatarClip" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath>
    <clipPath id="avatarClipSm" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5"/></clipPath>
    <clipPath id="imgClip" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="1" height="1" rx="0.053"/></clipPath>
    <clipPath id="imgClipBig" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="1" height="1" rx="0.03"/></clipPath>
  `;
}

/** 标题栏：粉色徽标 + 标题文字，返回更新后的 y */
function renderTitleBar(els, y, badge, title) {
  const badgeW = 74, badgeH = 24;
  els.push(`<rect x="${PAD}" y="${y}" width="${badgeW}" height="${badgeH}" rx="12" fill="url(#pink)"/>`);
  els.push(`<text x="${PAD + 12}" y="${y + 16.5}" font-size="12" font-weight="700" fill="#fff" letter-spacing="1">${esc(badge)}</text>`);
  els.push(`<text x="${PAD + badgeW + 10}" y="${y + 18}" font-size="16" font-weight="700" fill="#fff" letter-spacing="0.5">${esc(title)}</text>`);
  return y + badgeH + 18;
}

/** 主评论卡片区域（头像/作者/正文/图片网格/统计栏），返回元素与卡片底边 */
function renderMainCard(comment, startY, upMid = 0) {
  const els = [];
  let y = startY;
  const cardTop = y;
  const avatarY = cardTop + 20;
  const authorX = INNER_X + 46 + 12;
  // mid 统一转 String 比较（API 返回 number，调用方可能是字符串）
  const isUp = !!(comment.mid && upMid) && String(comment.mid) === String(upMid);

  els.push(`<image href="${esc(comment.avatar)}" x="${INNER_X}" y="${avatarY}" width="46" height="46" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="${INNER_X + 23}" cy="${avatarY + 23}" r="23" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>`);
  els.push(`<text x="${authorX}" y="${avatarY + 17}" font-size="14.5" font-weight="700" fill="#fff">${esc(comment.author)}</text>`);
  const authorW = measureText(comment.author, 14.5);
  if (isUp) {
    const tagX = authorX + authorW + 6;
    els.push(`<rect x="${tagX}" y="${avatarY + 3}" width="40" height="16" rx="8" fill="url(#pink)"/>`);
    els.push(`<text x="${tagX + 20}" y="${avatarY + 14}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">UP主</text>`);
  }
  els.push(`<text x="${authorX}" y="${avatarY + 34}" font-size="11.5" fill="${TEXT_DIM}">${fmtTime(comment.ctime)}</text>`);

  y = cardTop + 20 + 46;

  const bodyFs = 15.5;
  const bodyLines = wrapTokens(comment._tokens, INNER_W, bodyFs);
  const bodyLh = bodyFs * LINE_H;
  for (const line of bodyLines) {
    y += bodyLh;
    els.push(lineToSvg(line, bodyFs, INNER_X, y, comment._emoteImgs || {}));
  }

  if (comment.pictures && comment.pictures.length) {
    y += 12;
    const pics = comment.pictures;
    const picImgs = comment._picImgs || [];
    if (pics.length === 1) {
      // 单图：按原图比例完整展开（竖图不再被 320x240 裁剪）
      const sz = (comment._picSizes || [])[0] || null;
      const f = fitSinglePic(sz?.width, sz?.height, INNER_W, 480);
      els.push(`<image href="${esc(picImgs[0] || '')}" x="${INNER_X}" y="${y}" width="${f.w}" height="${f.h}" clip-path="url(#imgClipBig)" preserveAspectRatio="xMidYMid slice"/>`);
      if (!picImgs[0]) els.push(`<rect x="${INNER_X}" y="${y}" width="${f.w}" height="${f.h}" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      y += f.h;
    } else {
      const cell = (INNER_W - 12) / 3;
      pics.forEach((_, i) => {
        const cx = INNER_X + (i % 3) * (cell + 6);
        const cy = y + Math.floor(i / 3) * (cell + 6);
        els.push(`<image href="${esc(picImgs[i] || '')}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" clip-path="url(#imgClip)" preserveAspectRatio="xMidYMid slice"/>`);
        if (!picImgs[i]) els.push(`<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      });
      y += Math.ceil(pics.length / 3) * (cell + 6) - 6;
    }
  }

  y += 18; // 底部留白（统计栏已移除）
  const cardBottom = y;
  els.push(`<rect x="${PAD}" y="${cardTop}" width="${CARD_W}" height="${cardBottom - cardTop}" rx="${CARD_RX}" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`);
  return { els, cardBottom };
}

/** 页脚，返回更新后的 y */
function renderFooter(els, y, left, right) {
  y += 16;
  els.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="4 4"/>`);
  y += 16;
  els.push(`<text x="${PAD}" y="${y}" font-size="11" fill="${TEXT_DIMMER}" letter-spacing="1">${esc(left)}</text>`);
  els.push(`<text x="${W - PAD}" y="${y}" font-size="11" fill="${TEXT_DIMMER}" text-anchor="end">${esc(right)}</text>`);
  return y + PAD;
}

/**
 * 生成置顶评论卡片
 * @returns {Promise<{ file: string, png: Buffer, svg: string }>}
 */
async function generateCard({ comment, replies, opts, outDir }) {
  await prepareImages(comment, replies);
  const svg = await buildSvg(comment, replies, opts);
  const png = renderPng(svg);

  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `pinned-card_${ts}_${comment.rpid}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(outDir, 'latest.png'), png);
  return { file, png, svg };
}

// ====== 取消置顶：UP 互动上下文卡片 ======

/** 互动链中的单个评论块（被UP回复/UP回复/被UP点赞），返回更新后的 y */
function renderChainBlock(els, y, item, role, isUp) {
  y += 12;
  const rTop = y;
  const rw = CARD_W - 28;
  const rInnerW = rw - 34 - 10;
  const rFs = 13.5;
  const rLh = rFs * 1.7;
  const lines = wrapTokens(item._tokens || [], rInnerW, rFs);
  const textH = Math.max(lines.length * rLh, 34);
  const nameX = PAD + 14 + 34 + 10;
  // 评论自带图片（互动链中此前丢失，现补全渲染）
  const pics = item.pictures || [];
  const picImgs = item._picImgs || [];
  let imgH = 0;
  let imgBlock = '';
  if (pics.length) {
    const maxImgW = (PAD + rw - 14) - nameX;   // 图片可用宽度
    const lastBase = rTop + 34 + lines.length * rLh; // 正文最后一行基线
    const imgY = lastBase + 10;
    if (pics.length === 1) {
      const sz = (item._picSizes || [])[0] || null;
      const f = fitSinglePic(sz?.width, sz?.height, maxImgW, 400);
      imgH = f.h;
      imgBlock += `<image href="${esc(picImgs[0] || '')}" x="${nameX}" y="${imgY}" width="${f.w}" height="${f.h}" clip-path="url(#imgClipBig)" preserveAspectRatio="xMidYMid slice"/>`;
      if (!picImgs[0]) imgBlock += `<rect x="${nameX}" y="${imgY}" width="${f.w}" height="${f.h}" rx="10" fill="rgba(255,255,255,0.06)"/>`;
    } else {
      const cell = Math.min(169, (maxImgW - 12) / 3);
      const rows = Math.ceil(pics.length / 3);
      imgH = rows * (cell + 6) - 6;
      pics.forEach((_, i) => {
        const cx = nameX + (i % 3) * (cell + 6);
        const cy = imgY + Math.floor(i / 3) * (cell + 6);
        imgBlock += `<image href="${esc(picImgs[i] || '')}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" clip-path="url(#imgClip)" preserveAspectRatio="xMidYMid slice"/>`;
        if (!picImgs[i]) imgBlock += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="10" fill="rgba(255,255,255,0.06)"/>`;
      });
    }
  }
  // itemH：上边距 + 名字区 + 正文 + 图片(如有) + 元信息行 + 下边距
  const itemH = 12 + 12 + textH + (imgH ? imgH + 10 : 0) + 16 + 22;
  const bg = isUp ? 'rgba(251,114,153,0.08)' : 'rgba(255,255,255,0.05)';
  const border = isUp ? 'rgba(251,114,153,0.35)' : 'rgba(255,255,255,0.08)';
  els.push(`<rect x="${PAD}" y="${rTop}" width="${rw}" height="${itemH}" rx="12" fill="${bg}" stroke="${border}" stroke-width="1"/>`);
  if (isUp) els.push(`<rect x="${PAD}" y="${rTop}" width="3.5" height="${itemH}" rx="1.75" fill="${PINK}"/>`);
  els.push(`<image href="${esc(item.avatar)}" x="${PAD + 14}" y="${rTop + 12}" width="34" height="34" clip-path="url(#avatarClipSm)" preserveAspectRatio="xMidYMid slice"/>`);
  els.push(`<text x="${nameX}" y="${rTop + 24}" font-size="12.5" font-weight="600" fill="${TEXT_SUB}">${esc(item.author)}</text>`);
  const nw = measureText(item.author, 12.5);
  const roleW = measureText(role, 10.5) + 12;
  const roleX = nameX + nw + 6;
  const roleBg = isUp ? 'rgba(251,114,153,0.25)' : 'rgba(153,147,184,0.25)';
  const roleColor = isUp ? PINK : TEXT_SUB;
  els.push(`<rect x="${roleX}" y="${rTop + 12}" width="${roleW}" height="16" rx="8" fill="${roleBg}"/>`);
  els.push(`<text x="${roleX + roleW / 2}" y="${rTop + 23.5}" font-size="10.5" fill="${roleColor}" text-anchor="middle">${esc(role)}</text>`);
  let ly = rTop + 12 + 18 + 4;
  for (const line of lines) {
    ly += rLh;
    els.push(lineToSvg(line, rFs, nameX, ly, item._emoteImgs || {}));
  }
  if (imgBlock) els.push(imgBlock);
  els.push(`<text x="${nameX}" y="${rTop + itemH - 16}" font-size="11" fill="${TEXT_DIMMER}">${fmtTime(item.ctime)} · ${fmtCount(item.like)} 赞</text>`);
  return rTop + itemH;
}

/** 预下载互动链中所有头像/表情/图片 */
async function prepareChainItems(items) {
  for (const it of items) {
    for (const node of [it.parent, it.upReply]) {
      if (!node) continue;
      node._tokens = tokenize(node.message, node.emote);
      node._emoteImgs = {};
      for (const t of node._tokens) {
        if (t.type === 'emote' && t.url) node._emoteImgs[t.key] = await dataUri(t.url);
      }
      if (node.avatar) node.avatar = await dataUri(node.avatar);
      node._picImgs = await Promise.all((node.pictures || []).map(u => dataUri(u)));
      node._picSizes = await Promise.all((node.pictures || []).map(u => picSize(u)));
    }
  }
}

/** 取消置顶 → UP 互动回顾卡片 SVG */
async function buildUnpinnedSvg(comment, items, opts = {}) {
  const { upName = '', oid = 0, upMid = 0 } = opts;
  const els = [];
  const defs = defsSvg();
  let y = PAD;
  y = renderTitleBar(els, y, '置顶评论', `UP互动回顾 · ${upName || comment.author || 'B站动态'}`);

  const mc = renderMainCard(comment, y, upMid);
  els.push(...mc.els);
  y = mc.cardBottom;

  // 互动链区
  y += 16;
  els.push(`<text x="${PAD}" y="${y}" font-size="13" font-weight="600" fill="${TEXT_SUB}">UP互动回顾</text>`);
  const badgeText = `${items.length} 条互动`;
  const badgeW2 = measureText(badgeText, 11) + 16;
  els.push(`<rect x="${PAD + measureText('UP互动回顾', 13) + 8}" y="${y - 12}" width="${badgeW2}" height="18" rx="9" fill="rgba(251,114,153,0.2)"/>`);
  els.push(`<text x="${PAD + measureText('UP互动回顾', 13) + 8 + badgeW2 / 2}" y="${y + 1}" font-size="11" fill="${PINK}" text-anchor="middle">${badgeText}</text>`);
  y += 8;

  if (!items.length) {
    y += 12;
    els.push(`<rect x="${PAD}" y="${y}" width="${CARD_W}" height="42" rx="12" fill="rgba(255,255,255,0.05)"/>`);
    els.push(`<text x="${PAD + 14}" y="${y + 26}" font-size="13" fill="${TEXT_DIM}">该评论区暂无 UP 互动</text>`);
    y += 54;
  } else {
    for (const it of items) {
      if (it.kind === 'reply' && it.parent) {
        y = renderChainBlock(els, y, it.parent, '被UP回复', false);
        y = renderChainBlock(els, y, it.upReply, 'UP回复', true);
      } else if (it.kind === 'reply') {
        y = renderChainBlock(els, y, it.upReply, 'UP回复', true);
      } else {
        y = renderChainBlock(els, y, it.parent, '被UP点赞', false);
      }
    }
  }

  y = renderFooter(els, y, 'BILI UP INTERACTION', oid ? `https://t.bilibili.com/${oid}` : `#${String(comment.rpid).slice(-8)}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${y}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
}

/** 生成取消置顶互动回顾卡片 */
async function generateUnpinnedCard({ comment, items, opts, outDir }) {
  await prepareImages(comment, []);
  await prepareChainItems(items);
  const svg = await buildUnpinnedSvg(comment, items, opts);
  const png = renderPng(svg);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `unpinned-context_${ts}_${comment.rpid}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(outDir, 'latest-unpinned.png'), png);
  return { file, png, svg };
}

// ====== 普通动态更新卡片 ======

async function buildDynamicSvg(dyn, opts = {}) {
  const { upName = '', oid = 0 } = opts;
  const els = [];
  const defs = defsSvg();
  let y = PAD;
  y = renderTitleBar(els, y, '动态更新', `最新动态 · ${upName || dyn.latestAuthor || 'B站动态'}`);

  const cardTop = y;
  const avatarY = cardTop + 20;
  const authorX = INNER_X + 46 + 12;
  els.push(`<image href="${esc(dyn.latestFace || '')}" x="${INNER_X}" y="${avatarY}" width="46" height="46" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="${INNER_X + 23}" cy="${avatarY + 23}" r="23" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>`);
  els.push(`<text x="${authorX}" y="${avatarY + 17}" font-size="14.5" font-weight="700" fill="#fff">${esc(dyn.latestAuthor || upName || '')}</text>`);
  els.push(`<text x="${authorX}" y="${avatarY + 34}" font-size="11.5" fill="${TEXT_DIM}">${fmtTime(dyn.latestTs)} · 最新动态 #${String(dyn.latestId).slice(-8)}</text>`);
  y = cardTop + 20 + 46;

  const bodyFs = 15.5;
  const lines = wrapTokens([{ type: 'text', text: dyn.latestDesc }], INNER_W, bodyFs);
  const bodyLh = bodyFs * LINE_H;
  for (const line of lines) {
    y += bodyLh;
    els.push(lineToSvg(line, bodyFs, INNER_X, y, {}));
  }

  if (dyn.latestImages && dyn.latestImages.length) {
    y += 12;
    const pics = dyn.latestImages;
    const picImgs = dyn._picImgs || [];
    if (pics.length === 1) {
      // 单图：按原图比例完整展开（与主评论卡片一致，不再固定 320x240 裁剪）
      const sz = (dyn._picSizes || [])[0] || null;
      const f = fitSinglePic(sz?.width, sz?.height, INNER_W, 480);
      els.push(`<image href="${esc(picImgs[0] || '')}" x="${INNER_X}" y="${y}" width="${f.w}" height="${f.h}" clip-path="url(#imgClipBig)" preserveAspectRatio="xMidYMid slice"/>`);
      if (!picImgs[0]) els.push(`<rect x="${INNER_X}" y="${y}" width="${f.w}" height="${f.h}" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      y += f.h;
    } else {
      const cell = (INNER_W - 12) / 3;
      pics.forEach((_, i) => {
        const cx = INNER_X + (i % 3) * (cell + 6);
        const cy = y + Math.floor(i / 3) * (cell + 6);
        els.push(`<image href="${esc(picImgs[i] || '')}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" clip-path="url(#imgClip)" preserveAspectRatio="xMidYMid slice"/>`);
        if (!picImgs[i]) els.push(`<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      });
      y += Math.ceil(pics.length / 3) * (cell + 6) - 6;
    }
  }
  y += 18;
  const cardBottom = y;
  els.push(`<rect x="${PAD}" y="${cardTop}" width="${CARD_W}" height="${cardBottom - cardTop}" rx="${CARD_RX}" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`);

  y = renderFooter(els, y, 'BILI DYNAMIC UPDATE', oid ? `https://t.bilibili.com/${oid}` : `#${String(dyn.latestId).slice(-8)}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${y}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
}

/** 生成普通动态更新卡片 */
async function generateDynamicCard({ dyn, opts, outDir }) {
  dyn._picImgs = await Promise.all(dyn.latestImages.map(u => dataUri(u)));
  dyn._picSizes = await Promise.all(dyn.latestImages.map(u => picSize(u))); // 供单图按比例展开
  if (dyn.latestFace) dyn.latestFace = await dataUri(dyn.latestFace);
  const svg = await buildDynamicSvg(dyn, opts);
  const png = renderPng(svg);
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(outDir, `dynamic-update_${ts}_${dyn.latestId}.png`);
  fs.writeFileSync(file, png);
  fs.writeFileSync(path.join(outDir, 'latest-dynamic.png'), png);
  return { file, png, svg };
}

module.exports = {
  generateCard, buildSvg, renderPng, W, generateUnpinnedCard, generateDynamicCard,
  prepareImages, prepareChainItems,
  // 布局常量（供 verify-pixels.js 等脚本复用，避免硬编码漂移）
  PAD, INNER_PAD, INNER_X,
  // 纯函数（供测试/二次开发）
  tokenize, wrapTokens, measureText, charWpx, fmtCount, fmtTime,
};
