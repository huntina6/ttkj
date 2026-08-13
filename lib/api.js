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

/** 匿名获取 buvid（SPI 接口，无需登录） */
async function anonCookie() {
  if (_anonCookie) return _anonCookie;
  const d = await httpJson('https://api.bilibili.com/x/frontend/finger/spi');
  const b3 = d?.data?.b_3;
  const b4 = d?.data?.b_4;
  if (!b3) throw new BiliError('获取 buvid 失败');
  _anonCookie = `buvid3=${b3}; buvid4=${b4 || ''}`;
  return _anonCookie;
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
 * @returns {{ dynId, oid, type, author, pinned: boolean }}
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
  return {
    dynId: pinned.id_str || String(pinned.id),
    oid,
    type,
    author: pinned.modules?.module_author?.name || '',
    pinned: (pinned.modules?.module_tag?.text || '').includes('置顶'),
  };
}

/** 获取置顶评论（匿名可用） */
async function getPinnedComment(oid, type, cookie) {
  const data = await apiGet(`/x/v2/reply?type=${type}&oid=${oid}&sort=2&ps=1`, {
    cookie,
    referer: `https://t.bilibili.com/${oid}`,
  });
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

module.exports = {
  BiliError,
  apiGet,
  getPinnedDynamic,
  getPinnedComment,
  getReplies,
  downloadImage,
  mimeFromBuffer,
  normUrl,
  mergeCookie,
  UA,
};
