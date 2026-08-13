'use strict';
/**
 * 置顶评论卡片渲染器 —— SVG 手绘布局 + resvg 转 PNG
 * 设计复刻 templates/comment-card-template.html：深色渐变背景 + 粉色点缀
 * 全平台：resvg 预编译二进制，字体用系统字体（macOS PingFang / Win 微软雅黑 / Linux Noto CJK）
 */

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { downloadImage, mimeFromBuffer, normUrl } = require('./api');

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

// ====== 图片下载缓存 ======
const imgCache = new Map();
/** 下载图片并转 data URI（带缓存；失败返回 ''） */
async function dataUri(url) {
  if (!url) return '';
  if (imgCache.has(url)) return imgCache.get(url);
  const p = downloadImage(url).then(buf => {
    if (!buf) return '';
    return `data:${mimeFromBuffer(buf)};base64,${buf.toString('base64')}`;
  });
  imgCache.set(url, p);
  return p;
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
  let x = x0;
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
      x0 += t.w;
    } else {
      flushText();
      const dataUri = emoteImgs[t.key];
      if (dataUri) {
        const size = t.w - 4;
        out += `<image href="${dataUri}" x="${x0}" y="${baseline - fs + (fs - size) / 2}" width="${size}" height="${size}"/>`;
      } else {
        buf += `[${t.text}]`;
        x0 += measureText(`[${t.text}]`, fs);
      }
      x0 += 4;
    }
  }
  flushText();
  void x;
  return out;
}

// ====== 卡片组装 ======

/**
 * @param {object} comment getPinnedComment 返回值
 * @param {object[]} replies getReplies 返回值
 * @param {object} opts { upName, upMid, showReplies }
 * @returns {Promise<string>} SVG 字符串
 */
async function buildSvg(comment, replies, opts = {}) {
  const { upName = '', upMid = 0, showReplies = false } = opts;
  const els = [];
  const defs = defsSvg();
  let y = PAD;

  // 1. 标题栏
  y = renderTitleBar(els, y, '置顶评论', `动态 · ${upName || 'B站动态'}`);

  // 2. 主评论卡片
  const mc = renderMainCard(comment, y, true);
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
      const itemH = 12 + 12 + bodyH + 16; // 上内边距 + 文本 + 下内边距
      els.push(`<rect x="${PAD}" y="${rTop}" width="${rw}" height="${itemH}" rx="12" fill="rgba(255,255,255,0.05)"/>`);
      // 头像
      els.push(`<image href="${r.avatar}" x="${PAD + 14}" y="${rTop + 12}" width="34" height="34" clip-path="url(#avatarClipSm)" preserveAspectRatio="xMidYMid slice"/>`);
      // 名字
      const nameX = PAD + 14 + 34 + 10;
      let nameEl = `<text x="${nameX}" y="${rTop + 24}" font-size="12.5" font-weight="600" fill="${TEXT_SUB}">${esc(r.author)}</text>`;
      if (r.mid === upMid) {
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

  // 4. 页脚
  y = renderFooter(els, y, 'BILI PINNED COMMENT', `#${String(comment.rpid).slice(-8)}`);

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
  comment._picImgs = await Promise.all(comment.pictures.map(u => dataUri(u)));
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
    <clipPath id="avatarClip"><circle cx="0" cy="0" r="23"/></clipPath>
    <clipPath id="avatarClipSm"><circle cx="0" cy="0" r="17"/></clipPath>
    <clipPath id="imgClip"><rect x="0" y="0" width="188" height="188" rx="10"/></clipPath>
    <clipPath id="imgClipBig"><rect x="0" y="0" width="320" height="240" rx="10"/></clipPath>
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
function renderMainCard(comment, startY, showStat = true) {
  const els = [];
  let y = startY;
  const cardTop = y;
  const avatarY = cardTop + 20;
  const authorX = INNER_X + 46 + 12;

  els.push(`<image href="${comment.avatar}" x="${INNER_X}" y="${avatarY}" width="46" height="46" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>
    <circle cx="${INNER_X + 23}" cy="${avatarY + 23}" r="23" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>`);
  els.push(`<text x="${authorX}" y="${avatarY + 17}" font-size="14.5" font-weight="700" fill="#fff">${esc(comment.author)}</text>`);
  const authorW = measureText(comment.author, 14.5);
  const tagX = authorX + authorW + 6;
  els.push(`<rect x="${tagX}" y="${avatarY + 3}" width="40" height="16" rx="8" fill="url(#pink)"/>`);
  els.push(`<text x="${tagX + 20}" y="${avatarY + 14}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">UP主</text>`);
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
      els.push(`<image href="${picImgs[0] || ''}" x="${INNER_X}" y="${y}" width="320" height="240" clip-path="url(#imgClipBig)" preserveAspectRatio="xMidYMid slice"/>`);
      if (!picImgs[0]) els.push(`<rect x="${INNER_X}" y="${y}" width="320" height="240" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      y += 240;
    } else {
      const cell = (INNER_W - 12) / 3;
      pics.forEach((_, i) => {
        const cx = INNER_X + (i % 3) * (cell + 6);
        const cy = y + Math.floor(i / 3) * (cell + 6);
        els.push(`<image href="${picImgs[i] || ''}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" clip-path="url(#imgClip)" preserveAspectRatio="xMidYMid slice"/>`);
        if (!picImgs[i]) els.push(`<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      });
      y += Math.ceil(pics.length / 3) * (cell + 6) - 6;
    }
  }

  if (showStat) {
    y += 12;
    els.push(`<line x1="${INNER_X}" y1="${y}" x2="${INNER_X + INNER_W}" y2="${y}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`);
    y += 12;
    const heart = `<path d="M7.5 2.5c-2.2 0-4 1.8-4 4 0 3 2.7 5.3 6 7.8 3.3-2.5 6-4.8 6-7.8 0-2.2-1.8-4-4-4-1.3 0-2.4.6-3.2 1.6-.8-1-1.9-1.6-3.2-1.6z" fill="${PINK}"/>`;
    els.push(`<g transform="translate(${INNER_X}, ${y - 11}) scale(1.1)">${heart}</g>`);
    els.push(`<text x="${INNER_X + 18}" y="${y}" font-size="12" fill="${TEXT_SUB}">${fmtCount(comment.like)} 赞</text>`);
    els.push(`<text x="${INNER_X + 120}" y="${y}" font-size="12" fill="${TEXT_SUB}">${fmtCount(comment.rcount)} 条回复</text>`);
    y += 18;
  } else {
    y += 18;
  }
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
  const itemH = 12 + 12 + textH + 16;
  const bg = isUp ? 'rgba(251,114,153,0.08)' : 'rgba(255,255,255,0.05)';
  const border = isUp ? 'rgba(251,114,153,0.35)' : 'rgba(255,255,255,0.08)';
  els.push(`<rect x="${PAD}" y="${rTop}" width="${rw}" height="${itemH}" rx="12" fill="${bg}" stroke="${border}" stroke-width="1"/>`);
  if (isUp) els.push(`<rect x="${PAD}" y="${rTop}" width="3.5" height="${itemH}" rx="1.75" fill="${PINK}"/>`);
  els.push(`<image href="${item.avatar}" x="${PAD + 14}" y="${rTop + 12}" width="34" height="34" clip-path="url(#avatarClipSm)" preserveAspectRatio="xMidYMid slice"/>`);
  const nameX = PAD + 14 + 34 + 10;
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
  els.push(`<text x="${nameX}" y="${rTop + itemH - 16}" font-size="11" fill="${TEXT_DIMMER}">${fmtTime(item.ctime)} · ${fmtCount(item.like)} 赞</text>`);
  return rTop + itemH;
}

/** 预下载互动链中所有头像与表情 */
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
    }
  }
}

/** 取消置顶 → UP 互动回顾卡片 SVG */
async function buildUnpinnedSvg(comment, items, opts = {}) {
  const { upName = '' } = opts;
  const els = [];
  const defs = defsSvg();
  let y = PAD;
  y = renderTitleBar(els, y, '置顶评论', `UP互动回顾 · ${upName || comment.author || 'B站动态'}`);

  const mc = renderMainCard(comment, y, true);
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

  y = renderFooter(els, y, 'BILI UP INTERACTION', `#${String(comment.rpid).slice(-8)}`);
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
  const { upName = '' } = opts;
  const els = [];
  const defs = defsSvg();
  let y = PAD;
  y = renderTitleBar(els, y, '动态更新', `最新动态 · ${upName || dyn.latestAuthor || 'B站动态'}`);

  const cardTop = y;
  const avatarY = cardTop + 20;
  const authorX = INNER_X + 46 + 12;
  els.push(`<image href="${dyn.latestFace || ''}" x="${INNER_X}" y="${avatarY}" width="46" height="46" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>
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
      els.push(`<image href="${picImgs[0] || ''}" x="${INNER_X}" y="${y}" width="320" height="240" clip-path="url(#imgClipBig)" preserveAspectRatio="xMidYMid slice"/>`);
      if (!picImgs[0]) els.push(`<rect x="${INNER_X}" y="${y}" width="320" height="240" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      y += 240;
    } else {
      const cell = (INNER_W - 12) / 3;
      pics.forEach((_, i) => {
        const cx = INNER_X + (i % 3) * (cell + 6);
        const cy = y + Math.floor(i / 3) * (cell + 6);
        els.push(`<image href="${picImgs[i] || ''}" x="${cx}" y="${cy}" width="${cell}" height="${cell}" clip-path="url(#imgClip)" preserveAspectRatio="xMidYMid slice"/>`);
        if (!picImgs[i]) els.push(`<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="10" fill="rgba(255,255,255,0.06)"/>`);
      });
      y += Math.ceil(pics.length / 3) * (cell + 6) - 6;
    }
  }
  y += 18;
  const cardBottom = y;
  els.push(`<rect x="${PAD}" y="${cardTop}" width="${CARD_W}" height="${cardBottom - cardTop}" rx="${CARD_RX}" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`);

  y = renderFooter(els, y, 'BILI DYNAMIC UPDATE', `#${String(dyn.latestId).slice(-8)}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}">
  <defs>${defs}</defs>
  <rect x="0" y="0" width="${W}" height="${y}" fill="url(#bg)"/>
  ${els.join('\n  ')}
</svg>`;
}

/** 生成普通动态更新卡片 */
async function generateDynamicCard({ dyn, opts, outDir }) {
  dyn._picImgs = await Promise.all(dyn.latestImages.map(u => dataUri(u)));
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
  // 纯函数（供测试/二次开发）
  tokenize, wrapTokens, measureText, charWpx, fmtCount, fmtTime,
};
