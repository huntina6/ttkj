'use strict';
/**
 * 核心纯函数测试（node:test，零额外依赖）
 * 运行：npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const card = require('../lib/card');
const api = require('../lib/api');

const { fmtCount, fmtTime, charWpx, measureText, tokenize, wrapTokens } = card;
const { filterUpInteractions, extractDynamicContent, extractId } = api;

// ====== extractId（回归：评论分享链接必须提取 rpid 而非 oid） ======
test('extractId 评论分享链接提取 rpid', () => {
  assert.strictEqual(extractId('https://t.bilibili.com/404135596?comment_root_id=313406396048'), '313406396048');
  assert.strictEqual(extractId('https://t.bilibili.com/404135596?comment_id=313406396048'), '313406396048');
  assert.strictEqual(extractId('https://t.bilibili.com/404135596#reply313406396048'), '313406396048');
});

test('extractId 动态链接/裸输入提取 oid', () => {
  assert.strictEqual(extractId('https://t.bilibili.com/404135596'), '404135596');
  assert.strictEqual(extractId('https://www.bilibili.com/dynamic/404135596'), '404135596');
  assert.strictEqual(extractId('404135596'), '404135596');
  assert.strictEqual(extractId('313406396048'), '313406396048');
});

test('extractId 无法识别时原样返回', () => {
  assert.strictEqual(extractId(''), '');
  assert.strictEqual(extractId('随便一句话'), '随便一句话');
  assert.strictEqual(extractId(null), '');
});

// ====== fmtCount ======
test('fmtCount 万级格式化', () => {
  assert.strictEqual(fmtCount(0), '0');
  assert.strictEqual(fmtCount(9999), '9999');
  assert.strictEqual(fmtCount(10000), '1万');
  assert.strictEqual(fmtCount(12000), '1.2万');
  assert.strictEqual(fmtCount(12345), '1.2万');
  assert.strictEqual(fmtCount(100000), '10万');
  assert.strictEqual(fmtCount(null), '0');
  assert.strictEqual(fmtCount(undefined), '0');
});

// ====== fmtTime ======
test('fmtTime 时间格式化', () => {
  // 与本地时区无关：动态构造期望值，验证格式与字段正确
  const ts = 1754985600;
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  const expected = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  assert.strictEqual(fmtTime(ts), expected);
  assert.strictEqual(fmtTime(null), '');
  assert.strictEqual(fmtTime(undefined), '');
});

// ====== charWpx / measureText ======
test('charWpx CJK 全角宽度', () => {
  assert.strictEqual(charWpx('中', 10), 10);      // CJK = 1em
  assert.strictEqual(charWpx('a', 10), 5.5);      // ASCII = 0.55em
  assert.strictEqual(charWpx('！', 10), 10);      // 全角符号
  assert.strictEqual(charWpx('\n', 10), 6);       // 控制字符兜底
});

test('measureText 混合文本', () => {
  // 'AB中' = 5.5 + 5.5 + 10 = 21
  assert.strictEqual(measureText('AB中', 10), 21);
  assert.strictEqual(measureText('', 10), 0);
});

// ====== tokenize ======
test('tokenize 无表情 → 纯文本', () => {
  const t = tokenize('你好世界', {});
  assert.deepStrictEqual(t, [{ type: 'text', text: '你好世界' }]);
});

test('tokenize 表情内联拆分', () => {
  const t = tokenize('开心[大笑]了', { '[大笑]': { text: '大笑', url: '//i0.hdslb.com/x.png' } });
  assert.strictEqual(t.length, 3);
  assert.strictEqual(t[0].type, 'text');
  assert.strictEqual(t[0].text, '开心');
  assert.strictEqual(t[1].type, 'emote');
  assert.strictEqual(t[1].key, '[大笑]');
  assert.strictEqual(t[1].url, 'https://i0.hdslb.com/x.png'); // // 归一化
  assert.strictEqual(t[2].text, '了');
});

test('tokenize 表情在开头/结尾/多个', () => {
  const em = { '[a]': { url: '//x/1.png' }, '[b]': { url: '//x/2.png' } };
  const t = tokenize('[a]中间[b]', em);
  assert.deepStrictEqual(t.map(x => x.type), ['emote', 'text', 'emote']);
  const t2 = tokenize('[a][b]', em);
  assert.strictEqual(t2.length, 2);
});

// ====== wrapTokens ======
test('wrapTokens 超宽换行', () => {
  const tokens = [{ type: 'text', text: '一二三四五六七八九十' }];
  // 宽度 30，字号 10 → 每行 3 个字
  const lines = wrapTokens(tokens, 30, 10);
  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[0].filter(x => x.type === 'char').length, 3);
});

test('wrapTokens 硬换行', () => {
  const tokens = [{ type: 'text', text: '第一行\n第二行' }];
  const lines = wrapTokens(tokens, 1000, 10);
  assert.strictEqual(lines.length, 2);
});

test('wrapTokens 表情参与换行', () => {
  const tokens = [
    { type: 'text', text: '哈哈哈哈' },
    { type: 'emote', key: '[a]', text: 'a', url: '', w: 40 },
    { type: 'text', text: '呵呵' },
  ];
  const lines = wrapTokens(tokens, 60, 10); // 40(字) + 44(表情) > 60 → 表情换行
  assert.ok(lines.length >= 2);
});

// ====== filterUpInteractions ======
const mkReply = (rpid, mid, opts = {}) => ({
  rpid, mid,
  parent: opts.parent || '0',
  up_action: opts.liked ? { like: true } : undefined,
  member: { uname: 'user' + mid, avatar: '//x/a.png' },
  content: { message: '内容' + rpid, emote: {} },
  ctime: 1754985600, like: 3,
});

test('filterUpInteractions UP 回复形成对话链', () => {
  const replies = [
    mkReply('100', 123),                       // 粉丝评论
    mkReply('101', 401315430, { parent: '100' }), // UP 回复该评论
  ];
  const items = filterUpInteractions(replies, 401315430);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'reply');
  assert.ok(items[0].parent);                  // 有父评论
  assert.strictEqual(items[0].parent.rpid, '100');
  assert.ok(items[0].upReply);
  assert.strictEqual(items[0].upReply.rpid, '101');
});

test('filterUpInteractions UP 回复无父评论', () => {
  const replies = [mkReply('200', 401315430, { parent: '999' })]; // 父评论不在列表
  const items = filterUpInteractions(replies, 401315430);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'reply');
  assert.strictEqual(items[0].parent, null);
});

test('filterUpInteractions UP 点赞（UP 自己的回复不重复计赞）', () => {
  const replies = [
    mkReply('300', 555, { liked: true }),      // 被 UP 点赞的粉丝评论
    mkReply('301', 401315430, { liked: true }), // UP 自己的回复（已被算作 UP 回复，不再重复算点赞）
  ];
  const items = filterUpInteractions(replies, 401315430);
  // 2 条：一条 UP 回复（301），一条 UP 点赞（300）
  assert.strictEqual(items.length, 2);
  const likeItems = items.filter(i => i.kind === 'like');
  assert.strictEqual(likeItems.length, 1);
  assert.strictEqual(likeItems[0].parent.rpid, '300');
});

test('filterUpInteractions 无互动', () => {
  assert.deepStrictEqual(filterUpInteractions([], 401315430), []);
});

test('回归：uid 为字符串时 UP 互动也能匹配（P0 类型不匹配修复）', () => {
  // cli.js 传入的 uid 是字符串（如 '401315430'），而 API 返回的 mid 是 number；
  // 修复前 `r.mid === uid` 恒为 false，UP 互动永远识别不到
  const replies = [
    mkReply('400', 401315430),                        // UP 自己的回复（number mid）
    mkReply('401', 123456, { liked: true }),          // 被 UP 点赞的粉丝评论
    mkReply('402', 401315430, { liked: true }),       // UP 自己的回复被点赞 → 只计 reply，不重复计 like
  ];
  const items = filterUpInteractions(replies, '401315430'); // 字符串 uid
  // 期望：reply×2（400、402）+ like×1（401）= 3 项
  assert.strictEqual(items.length, 3, '字符串 uid 应识别出 UP 回复与 UP 点赞');
  const replyItems = items.filter(i => i.kind === 'reply');
  const likeItems = items.filter(i => i.kind === 'like');
  assert.strictEqual(replyItems.length, 2, 'UP 回复应为 2 条（400、402）');
  assert.ok(replyItems.every(i => i.upReply && i.upReply.rpid !== undefined));
  assert.strictEqual(likeItems.length, 1, 'UP 点赞应为 1 条（401，UP 自己的 402 不重复计）');
  assert.strictEqual(likeItems[0].parent.rpid, '401');
});

test('回归：uid 为数字时行为不变', () => {
  const replies = [mkReply('500', 401315430)];
  const items = filterUpInteractions(replies, 401315430);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].kind, 'reply');
});

// ====== extractDynamicContent ======
test('extractDynamicContent DRAW 图片动态', () => {
  const item = {
    modules: {
      module_dynamic: {
        desc: { text: '晒图' },
        major: { type: 'MAJOR_TYPE_DRAW', draw: { items: [{ src: '//i0.hdslb.com/1.jpg' }, { src: '//i0.hdslb.com/2.jpg' }] } },
      },
    },
  };
  const r = extractDynamicContent(item);
  assert.strictEqual(r.desc, '晒图');
  assert.strictEqual(r.images.length, 2);
  assert.ok(r.images[0].startsWith('https://'));
});

test('extractDynamicContent ARCHIVE 视频动态', () => {
  const item = {
    modules: {
      module_dynamic: {
        desc: { text: '' },
        major: { type: 'MAJOR_TYPE_ARCHIVE', archive: { title: '新视频', cover: '//i0.hdslb.com/c.jpg' } },
      },
    },
  };
  const r = extractDynamicContent(item);
  assert.strictEqual(r.desc, '新视频');
  assert.strictEqual(r.images.length, 1);
});

test('extractDynamicContent 纯文本动态', () => {
  const item = { modules: { module_dynamic: { desc: { text: '纯文本' } } } };
  const r = extractDynamicContent(item);
  assert.strictEqual(r.desc, '纯文本');
  assert.strictEqual(r.images.length, 0);
});

// ====== 渲染管线 ======
test('renderPng 输出有效 PNG', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <rect width="100" height="100" fill="#2b2140"/>
  </svg>`;
  const png = card.renderPng(svg, 1);
  assert.ok(Buffer.isBuffer(png));
  // PNG 魔数
  assert.strictEqual(png[0], 0x89);
  assert.strictEqual(png[1], 0x50);
  assert.strictEqual(png[2], 0x4e);
  assert.strictEqual(png[3], 0x47);
});

// ====== 回归测试：卡片渲染布局（issue: 头像不显示 / 正文偏移） ======

/** 构造最小 comment（可指定 avatar data URI 与正文） */
function mkComment(extra = {}) {
  return {
    rpid: '313472209520', author: '测试UP', ctime: 1754985600,
    like: 42, rcount: 7, message: '一二三四五六七八九十一二三四五六七八九十',
    emote: {}, pictures: [], avatar: '',
    _tokens: [{ type: 'text', text: '一二三四五六七八九十一二三四五六七八九十' }],
    _emoteImgs: {}, _picImgs: [],
    ...extra,
  };
}

/** 轻量 PNG 像素解析（RGBA8） */
function parsePng(buf) {
  let off = 8, width = 0, height = 0, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') { width = buf.readUInt32BE(off + 8); height = buf.readUInt32BE(off + 12); }
    else if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = require('zlib').inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
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

/** 区域统计：返回 [平均R, 平均G, 平均B]（忽略透明像素） */
function regionAvg(img, x0, y0, w, h) {
  let n = 0, r = 0, g = 0, b = 0;
  for (let y = y0; y < Math.min(y0 + h, img.height); y++)
    for (let x = Math.max(0, x0); x < Math.min(x0 + w, img.width); x++) {
      const i = (y * img.width + x) * 4;
      if (img.px[i + 3] < 128) continue;
      n++; r += img.px[i]; g += img.px[i + 1]; b += img.px[i + 2];
    }
  return n ? [r / n, g / n, b / n] : null;
}

test('回归：clipPath 使用 objectBoundingBox（头像不被裁剪）', async () => {
  const svg = await card.buildSvg(mkComment(), [], {});
  assert.ok(svg.includes('clipPathUnits="objectBoundingBox"'));
  // 正文首个 <text> 应从 INNER_X=52 开始（修复前会右移整行宽度）
  assert.ok(/<text x="52" y="[0-9.]+" font-size="15.5"/.test(svg),
    `正文 text 起点应为 52，实际 SVG: ${svg.match(/<text x="[^"]+" y="[^"]+" font-size="15.5"/)?.[0] || '未找到'}`);
});

test('回归：UP主 徽标仅在评论作者为目标 UP 时显示（P1 无条件徽标修复）', async () => {
  // 粉丝发的置顶评论：不应显示 UP主 徽标
  const fan = await card.buildSvg(mkComment({ mid: 999999 }), [], { upMid: 401315430 });
  assert.ok(!fan.includes('>UP主</text>'), '粉丝评论不应出现 UP主 徽标');
  // 目标 UP 自己的评论：应显示 UP主 徽标
  const up = await card.buildSvg(mkComment({ mid: 401315430 }), [], { upMid: 401315430 });
  assert.ok(up.includes('>UP主</text>'), 'UP 自己的评论应显示 UP主 徽标');
  // 未提供 upMid 时：不显示徽标（无判断依据）
  const noUp = await card.buildSvg(mkComment({ mid: 401315430 }), [], {});
  assert.ok(!noUp.includes('>UP主</text>'), '未提供 upMid 时不应显示 UP主 徽标');
  // 字符串 upMid 与数字 mid 也能匹配（类型一致性）
  const strUp = await card.buildSvg(mkComment({ mid: 401315430 }), [], { upMid: '401315430' });
  assert.ok(strUp.includes('>UP主</text>'), '字符串 upMid 应匹配数字 mid');
});

test('回归：渲染后头像区域可见且正文起点对齐', async () => {
  // 用 resvg 自己生成 8x8 红色小图作为头像 data URI（无网络依赖）
  const tiny = card.renderPng('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ff0000"/></svg>', 1);
  const avatarUri = `data:image/png;base64,${tiny.toString('base64')}`;
  const svg = await card.buildSvg(mkComment({ avatar: avatarUri }), [], {});
  const png = card.renderPng(svg);
  const img = parsePng(png);
  const scale = img.width / card.W; // 2x
  const s = v => Math.round(v * scale);
  const INNER_X = 52, avatarY = 92, avatarR = 23, bodyBaseline = 165.9;

  // 1) 头像圆心处应为红色（圆形裁剪区域内），修复前整个头像被裁掉
  const center = regionAvg(img, s(INNER_X + avatarR) - 2, s(avatarY + avatarR) - 2, 4, 4);
  assert.ok(center, '头像圆心区域应有像素');
  assert.ok(center[0] > 150 && center[1] < 100, `头像圆心应为红色，实际 ${center.map(v => v.toFixed(0))}`);

  // 2) 正文首行最左亮像素应贴近 INNER_X（修复前右移整行宽度）
  let firstX = -1;
  outer:
  for (let x = s(40); x < s(200); x++)
    for (let y = s(bodyBaseline - 6); y <= s(bodyBaseline + 2); y++) {
      const i = (y * img.width + x) * 4;
      if (img.px[i] + img.px[i + 1] + img.px[i + 2] > 500) { firstX = x; break outer; }
    }
  assert.ok(firstX >= 0, '首行应有文字像素');
  assert.ok(firstX <= s(INNER_X) + 6, `首行文字起点应贴近 ${s(INNER_X)}，实际 ${firstX}`);
});
