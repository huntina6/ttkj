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
const { filterUpInteractions, extractDynamicContent } = api;

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
