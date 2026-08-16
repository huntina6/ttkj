'use strict';
/**
 * B站 API 层 —— 零依赖（Node >= 18 内置 fetch）
 * 匿名访问：自动获取 buvid3/buvid4 防风控；
 * 可选 SESSDATA Cookie：解锁「自动识别置顶动态」等需要登录的接口。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class BiliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = 'BiliError';
  }
}

let _anonCookie = null;
let _anonCookiePromise = null; // in-flight 去重：并发首调只发一次 SPI 请求

/** 匿名获取 buvid（SPI 接口，无需登录） */
async function anonCookie() {
  if (_anonCookie) return _anonCookie;
  if (_anonCookiePromise) return _anonCookiePromise;
  _anonCookiePromise = (async () => {
    const d = await httpJson('https://api.bilibili.com/x/frontend/finger/spi');
    const b3 = d?.data?.b_3;
    const b4 = d?.data?.b_4;
    if (!b3) throw new BiliError('获取 buvid 失败');
    _anonCookie = `buvid3=${b3}; buvid4=${b4 || ''}`;
    return _anonCookie;
  })().finally(() => { _anonCookiePromise = null; });
  return _anonCookiePromise;
}

/** 合并多段 Cookie（后者覆盖前者同名键） */
function mergeCookie(...parts) {
  const map = new Map();
  for (const p of parts) {
    if (!p) continue;
    for (const kv of String(p).split(';')) {
      const i = kv.indexOf('=');
      if (i < 0) continue;
      map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function httpJson(url, { cookie, referer } = {}) {
  const headers = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' };
  if (cookie) headers['Cookie'] = cookie;
  if (referer) headers['Referer'] = referer;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!data) throw new BiliError(`响应不是 JSON（HTTP ${res.status}，可能被风控）: ${text.slice(0, 100)}`, res.status);
  return data;
}

/** B站标准 API 请求（自动带 buvid，统一处理风控/错误码） */
async function apiGet(urlPath, { cookie, referer } = {}) {
  const full = mergeCookie(await anonCookie(), cookie);
  const data = await httpJson('https://api.bilibili.com' + urlPath, { cookie: full, referer });
  if (data.code === -352 || data.code === -412 || data.code === -799) {
    throw new BiliError(`风控 code=${data.code}: ${data.message || '请求被拦截'}`, data.code);
  }
  if (data.code === -101) throw new BiliError('Cookie 已失效 (-101)，请更新 SESSDATA', -101);
  if (data.code !== 0) throw new BiliError(`API code=${data.code}: ${data.message || ''}`, data.code);
  return data;
}

function normUrl(url) {
  if (!url) return '';
  return String(url).replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://');
}

/** 从链接/裸输入中提取动态 ID 或评论 ID（提取失败原样返回） */
function extractId(v) {
  const s = String(v || '').trim();
  if (!s) return s;
  // 评论 ID 优先：评论分享链接形如 t.bilibili.com/<oid>?comment_root_id=<rpid>，
  // 若先匹配动态 ID 会把 rpid 误提取为 oid（评论链接模式失效）
  const rep = s.match(/comment_root_id=(\d+)|comment_id=(\d+)|#reply(\d+)/);
  if (rep) return rep[1] || rep[2] || rep[3];
  const dyn = s.match(/(?:t\.bilibili\.com|bilibili\.com)\/(?:dynamic\/)?(\d+)/);
  if (dyn) return dyn[1];
  return s;
}

/** 提取动态对应的评论对象参数（oid/type） */
function extractReplyParams(item) {
  const dynId = item.id_str || String(item.id);
  const major = item.modules?.module_dynamic?.major;
  if (!major || major.type === 'MAJOR_TYPE_NONE') return { oid: dynId, type: 11 };
  switch (major.type) {
    case 'MAJOR_TYPE_DRAW':    return { oid: String(major.draw.id), type: 11 };
    case 'MAJOR_TYPE_ARCHIVE': return { oid: String(major.archive.aid || major.archive.id), type: 1 };
    case 'MAJOR_TYPE_ARTICLE': return { oid: String(major.article.id), type: 12 };
    case 'MAJOR_TYPE_MUSIC':   return { oid: String(major.music.id), type: 14 };
    default:                   return { oid: dynId, type: 11 };
  }
}

/**
 * 获取指定 UP 的置顶动态（需要 Cookie，匿名会被风控 -352）
 * @returns {{ dynId, oid, type, author, pinned, latestId, latestDesc, latestImages, latestTs }}
 *   latest* 为最新动态（items[0]）信息，用于普通动态更新监测
 */
async function getPinnedDynamic(uid, cookie) {
  const data = await apiGet(`/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}`, {
    cookie,
    referer: `https://space.bilibili.com/${uid}`,
  });
  const items = data.data?.items || [];
  if (!items.length) throw new BiliError('动态列表为空（该用户可能没有动态）');
  const pinned = items.find(it => (it.modules?.module_tag?.text || '').includes('置顶')) || items[0];
  const { oid, type } = extractReplyParams(pinned);
  const latest = items[0];
  const lc = extractDynamicContent(latest);
  return {
    dynId: pinned.id_str || String(pinned.id),
    oid,
    type,
    author: pinned.modules?.module_author?.name || '',
    pinned: (pinned.modules?.module_tag?.text || '').includes('置顶'),
    latestId: latest.id_str || String(latest.id),
    latestDesc: lc.desc,
    latestImages: lc.images,
    latestTs: latest.modules?.module_author?.pub_ts || 0,
    latestAuthor: latest.modules?.module_author?.name || '',
    latestFace: normUrl(latest.modules?.module_author?.face || ''),
  };
}

/** 从动态条目提取展示内容（正文/图片），供普通动态更新卡片使用 */
function extractDynamicContent(item) {
  const major = item.modules?.module_dynamic?.major;
  const desc = item.modules?.module_dynamic?.desc?.text || '';
  if (!major || major.type === 'MAJOR_TYPE_NONE') {
    // 纯文本动态：desc 即正文
    return { desc: desc || '（纯文本动态）', images: [] };
  }
  switch (major.type) {
    case 'MAJOR_TYPE_DRAW':
      return {
        desc: desc || (major.draw.items?.[0]?.description || '（图片动态）'),
        images: (major.draw.items || []).map(i => normUrl(i.src)).filter(Boolean),
      };
    case 'MAJOR_TYPE_ARCHIVE':
      return {
        desc: desc || major.archive.title || '',
        images: [normUrl(major.archive.cover || '')].filter(Boolean),
      };
    case 'MAJOR_TYPE_ARTICLE':
      return { desc: desc || major.article.title || '', images: [] };
    default:
      return { desc: desc || '（动态）', images: [] };
  }
}

/** 获取置顶评论（匿名可用；评论对象不存在/已删除时返回 null） */
async function getPinnedComment(oid, type, cookie) {
  let data;
  try {
    data = await apiGet(`/x/v2/reply?type=${type}&oid=${oid}&sort=2&ps=1`, {
      cookie,
      referer: `https://t.bilibili.com/${oid}`,
    });
  } catch (err) {
    // -404：评论区/对象不存在（如动态已删），视为"无置顶评论"，与上层降级路径一致
    if (err instanceof BiliError && err.code === -404) return null;
    throw err;
  }
  const top = data.data?.top_replies?.[0];
  if (!top) return null;
  const c = top.content || {};
  return {
    rpid: String(top.rpid),
    author: top.member?.uname || '',
    avatar: normUrl(top.member?.avatar || ''),
    mid: top.mid,
    ctime: top.ctime || 0,
    message: c.message || '',
    emote: c.emote || {},
    pictures: (c.pictures || []).map(p => normUrl(p.img_src)),
    like: top.like ?? 0,
    rcount: top.rcount ?? 0,
  };
}

/** 获取置顶评论下的子回复（匿名可用） */
async function getReplies(oid, type, rootRpid, max, cookie) {
  const data = await apiGet(`/x/v2/reply/reply?type=${type}&oid=${oid}&root=${rootRpid}&pn=1&ps=${max}`, {
    cookie,
    referer: `https://t.bilibili.com/${oid}`,
  });
  return (data.data?.replies || []).slice(0, max).map(r => ({
    rpid: String(r.rpid),
    author: r.member?.uname || '',
    avatar: normUrl(r.member?.avatar || ''),
    mid: r.mid,
    ctime: r.ctime || 0,
    message: r.content?.message || '',
    emote: r.content?.emote || {},
    like: r.like ?? 0,
  }));
}

/** 获取指定评论本体（detail 接口，root 参数；评论存在时匿名可用） */
async function getCommentDetail(oid, type, rpid, cookie) {
  const data = await apiGet(`/x/v2/reply/detail?type=${type}&oid=${oid}&root=${rpid}`, {
    cookie,
    referer: `https://t.bilibili.com/${oid}`,
  });
  const r = data.data?.root;
  if (!r) return null;
  const c = r.content || {};
  return {
    rpid: String(r.rpid),
    author: r.member?.uname || '',
    avatar: normUrl(r.member?.avatar || ''),
    mid: r.mid,
    ctime: r.ctime || 0,
    message: c.message || '',
    emote: c.emote || {},
    pictures: (c.pictures || []).map(p => normUrl(p.img_src)),
    like: r.like ?? 0,
    rcount: r.rcount ?? 0,
  };
}

/** 获取评论目标动态的 UP 信息（评论接口 upper 字段，匿名可用） */
async function getDynamicUpper(oid, type, cookie) {
  const data = await apiGet(`/x/v2/reply?type=${type}&oid=${oid}&sort=2&ps=1`, {
    cookie,
    referer: `https://t.bilibili.com/${oid}`,
  });
  const u = data.data?.upper;
  return u ? { mid: u.mid, name: u.name } : null;
}

/** 分页拉取全部子回复（B站每页最多返回 20 条；匿名只给第一页，需 Cookie 翻页） */
async function getAllSubReplies(oid, type, rootRpid, cookie, maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    // ps=20：B站 v2 reply 接口实际每页上限 20（传更大值会被服务端截断）
    const data = await apiGet(`/x/v2/reply/reply?type=${type}&oid=${oid}&root=${rootRpid}&pn=${page}&ps=20`, {
      cookie,
      referer: `https://t.bilibili.com/${oid}`,
    });
    const replies = data.data?.replies;
    if (!replies?.length) break;
    all.push(...replies);
    if (replies.length < 20) break;
  }
  return all;
}

/**
 * 筛选 UP 互动：UP 回复的评论（含对话链）+ UP 点赞的评论
 * @returns {Array<{kind:'reply'|'like', parent:object|null, upReply:object|null}>}
 */
function filterUpInteractions(replies, uid) {
  const byRpid = new Map(replies.map(r => [String(r.rpid), r]));
  // 注意：B站 API 返回的 mid 是 number，而调用方（cli.js）传入的 uid 是字符串，
  // 必须统一 String 后再比较，否则 UP 互动永远识别不到（P0 修复）
  const isUp = r => String(r.mid ?? '') === String(uid ?? '');
  const upReplies = replies.filter(isUp);
  const upLiked = replies.filter(r => r.up_action && r.up_action.like);
  const pick = r => ({
    rpid: String(r.rpid),
    author: r.member?.uname || '',
    avatar: normUrl(r.member?.avatar || ''),
    isUp: isUp(r),
    message: r.content?.message || '',
    emote: r.content?.emote || {},
    pictures: (r.content?.pictures || []).map(p => normUrl(p.img_src)),
    ctime: r.ctime || 0,
    like: r.like ?? 0,
  });
  const items = [];
  for (const ur of upReplies) {
    const parentRpid = String(ur.parent || '');
    const parent = parentRpid && byRpid.get(parentRpid) ? byRpid.get(parentRpid) : null;
    items.push({ kind: 'reply', parent: parent ? pick(parent) : null, upReply: pick(ur) });
  }
  for (const lk of upLiked) {
    if (isUp(lk)) continue; // UP 自己的回复不重复算点赞
    items.push({ kind: 'like', parent: pick(lk), upReply: null });
  }
  return items;
}

/** 下载图片（带 UA/Referer，失败返回 null） */
async function downloadImage(url) {
  try {
    const res = await fetch(normUrl(url), {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    return buf;
  } catch {
    return null;
  }
}

/** 从文件头嗅探 MIME */
function mimeFromBuffer(buf) {
  if (!buf || buf.length < 12) return 'image/png';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return 'image/webp';
  return 'image/png';
}

/** 解析图片实际尺寸（JPEG/PNG/WebP），失败返回 null */
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    // PNG: IHDR 宽高（大端）
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // WebP: VP8/VP8L/VP8X
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        const w = 1 + buf.readUIntLE(24, 3), h = 1 + buf.readUIntLE(27, 3);
        return { width: w, height: h };
      }
      if (fourcc === 'VP8 ') {
        const w = buf.readUInt16LE(26) & 0x3fff, h = buf.readUInt16LE(28) & 0x3fff;
        return { width: w, height: h };
      }
      if (fourcc === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      return null;
    }
    // JPEG: 扫描 SOF 段
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off < buf.length - 9) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        const len = buf.readUInt16BE(off + 2);
        if (len < 2) return null;
        off += 2 + len;
      }
      return null;
    }
    return null;
  } catch { return null; }
}

module.exports = {
  BiliError,
  apiGet,
  getPinnedDynamic,
  extractDynamicContent,
  getPinnedComment,
  getReplies,
  getCommentDetail,
  getDynamicUpper,
  getAllSubReplies,
  filterUpInteractions,
  downloadImage,
  mimeFromBuffer,
  imageSize,
  normUrl,
  extractId,
  mergeCookie,
  UA,
};
