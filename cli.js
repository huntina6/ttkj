#!/usr/bin/env node
'use strict';
/**
 * bili-pinned-card v1.0 —— B站置顶评论监测 + 自动出图
 * 全平台独立版：无需浏览器、无需登录（匿名可读评论；提供 SESSDATA 可自动识别置顶动态）
 *
 * 用法：
 *   node cli.js                       # 交互模式（终端提示引导）
 *   node cli.js --oid 404135596       # 直接指定动态 ID，单次检查出图
 *   node cli.js --uid 401315430 --watch --interval 60
 *   node cli.js --help
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { BiliError, getPinnedDynamic, getPinnedComment, getReplies, getCommentDetail, getDynamicUpper, getAllSubReplies, filterUpInteractions } = require('./lib/api');
const { generateCard, generateUnpinnedCard, generateDynamicCard } = require('./lib/card');

const VERSION = '1.1.0';
const CFG_DIR = path.join(os.homedir(), '.bili-pinned-card');
const CFG_FILE = path.join(CFG_DIR, 'config.json');
const DEFAULT_UID = '401315430';

// ====== 终端样式 ======
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  dim: s => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: s => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  green: s => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: s => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: s => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  bold: s => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  pink: s => (useColor ? `\x1b[38;5;204m${s}\x1b[0m` : s),
};

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ====== 终端对齐工具（CJK 全角按 2 列宽，避免横幅/表格歪斜） ======
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}
/** 终端显示宽度：CJK/全角=2 列，其余=1 列；ANSI 颜色转义不计宽 */
function displayWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2ffff)) w += 2;
    else w += 1;
  }
  return w;
}

const BOX_W = 44; // 横幅内容区宽度（显示列）
const boxBorder = (left, right) => `${left}${'═'.repeat(BOX_W)}${right}`;
const boxLine = text => {
  const pad = Math.max(0, BOX_W - displayWidth(text) - 4);
  return `║  ${text}${' '.repeat(pad)}  ║`;
};

const BANNER = `
${boxBorder('╔', '╗')}
${boxLine(`${C.bold(C.pink('B站 置顶评论监测 · 自动出图'))} v${VERSION}`)}
${boxLine(C.dim('全平台独立版 · 无需浏览器 · 无需登录'))}
${boxBorder('╚', '╝')}
`;

// ====== 参数解析 ======
function parseArgs(argv) {
  const a = {
    uid: null, oid: null, rpid: null, type: null, interval: null, out: null,
    once: false, force: false, showReplies: null, cookie: null,
    upName: null, quiet: false, trackDyn: null, context: false, help: false,
  };
  const set = (k, v) => { a[k] = v; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--uid': case '-u': set('uid', argv[++i]); break;
      case '--oid': set('oid', argv[++i]); break;
      case '--rpid': set('rpid', argv[++i]); break;
      case '--type': case '-t': set('type', argv[++i]); break;
      case '--interval': case '-i': set('interval', argv[++i]); break;
      case '--out': case '-o': set('out', argv[++i]); break;
      case '--cookie': case '-c': set('cookie', argv[++i]); break;
      case '--up-name': set('upName', argv[++i]); break;
      case '--track-dyn': set('trackDyn', true); break;
      case '--no-track-dyn': set('trackDyn', false); break;
      case '--context': set('context', true); break;
      case '--once': set('once', true); break;
      case '--watch': set('once', false); break;
      case '--force': set('force', true); break;
      case '--show-replies': case '-r': set('showReplies', true); break;
      case '--no-replies': set('showReplies', false); break;
      case '--quiet': case '-q': set('quiet', true); break;
      case '--help': case '-h': set('help', true); break;
      default:
        if (arg.startsWith('--')) { console.error(C.red(`未知参数: ${arg}`)); process.exit(1); }
        if (!a.oid) set('oid', arg); // 裸参数视为动态 ID
    }
  }
  return a;
}

const HELP = `
用法: node cli.js [选项]

  （无参数）             交互模式：终端提示引导配置后持续监控
  --oid <动态ID或链接>    直接指定动态（含其置顶评论），跳过自动识别
  --rpid <评论ID或链接>   直接绘制指定评论的卡片（如旧的置顶评论，需配合 --oid）
  --context              与 --rpid 联用：绘制该评论的 UP 互动回顾图（UP 回复/点赞对话链）
  --uid <UP主UID>        目标 UP 主（配合 Cookie 自动识别置顶动态）
  --cookie <SESSDATA>    登录 Cookie（可选）：解锁自动识别置顶动态，降低风控
  --watch                持续监控（默认）
  --once                 单次检查并出图后退出
  --force                即使置顶评论未变化也重新出图
  -r, --show-replies     卡片上绘制精彩回复（默认不画）
  --track-dyn            同时监测普通动态更新：置顶未变但发了新动态时提示并出图
  -i, --interval <秒>    监控间隔（默认 60，最短 10）
  -o, --out <目录>       输出目录（默认 ./output）
  -q, --quiet            安静模式（仅输出结果行）
  -h, --help             帮助

示例:
  node cli.js --oid 404135596 --once --force
  node cli.js --oid 404135596 --rpid 313406396048 --once   # 绘制指定评论（旧置顶等）
  node cli.js --oid 404135596 --rpid 313406396048 --context --once   # 该评论的 UP 互动回顾图
  node cli.js --uid 401315430 --cookie "SESSDATA=xxx; bili_jct=yyy" --watch -i 120
`;

// ====== 配置持久化 ======
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf-8')); } catch { return {}; }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch { /* 忽略 */ }
}

// ====== 交互提示 ======
let rl = null;
function ask(question, def) {
  return new Promise(resolve => {
    const suffix = def !== undefined && def !== '' ? C.dim(` [${def}]`) : '';
    rl.question(`${C.cyan('➤')} ${C.cyan(question)}${suffix} `, ans => {
      const v = ans.trim();
      resolve(v === '' ? def : v);
    });
  });
}
async function askYN(question, def = false) {
  const hint = def ? 'Y/n' : 'y/N';
  const ans = (await ask(`${question} (${hint})`, '')).toLowerCase();
  if (ans === '') return def;
  return ans === 'y' || ans === 'yes';
}
/** 交互分区标题：┌─ 标题 ─────────────────┐ */
function section(title) {
  const fill = '─'.repeat(Math.max(2, BOX_W - displayWidth(title) - 4));
  console.log(`\n${C.pink('┌─ ')}${C.bold(title)}${C.pink(` ${fill}┐`)}`);
}
/** 交互完成汇总行（带键值对齐） */
function summaryRow(k, v) {
  console.log(`  ${C.dim(k.padEnd(4))}${C.bold(String(v))}`);
}
/**
 * 方向键选择器：↑/↓ 移动高亮光标，回车确认
 * @param {Array<{key:string, label:string, desc?:string}>} options
 * @param {number} defaultIndex 初始高亮位置
 * @returns {Promise<string>} 选中项的 key
 */
function select(options, defaultIndex = 0, io = { stdin: process.stdin, stdout: process.stdout }) {
  return new Promise(resolve => {
    const stdin = io.stdin;
    const stdout = io.stdout;
    let idx = Math.min(Math.max(defaultIndex, 0), options.length - 1);
    const line = i => (i === idx
      ? `  ${C.cyan('❯')} ${C.bold(options[i].label)}${options[i].desc ? `  ${C.dim(options[i].desc)}` : ''}`
      : `    ${options[i].label}${options[i].desc ? `  ${C.dim(options[i].desc)}` : ''}`);
    const render = () => {
      stdout.write(`\x1b[${options.length}A`); // 光标回到选项区顶部
      for (let i = 0; i < options.length; i++) {
        stdout.write(`\x1b[2K${line(i)}\n`);   // 清行并重绘
      }
    };
    for (let i = 0; i < options.length; i++) stdout.write(`${line(i)}\n`);
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw); } catch { /* noop */ }
      stdin.pause();
    };
    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        cleanup();
        stdout.write('\n');
        resolve(options[idx].key);
      } else if (ch === '\x1b[A') {            // ↑
        idx = (idx - 1 + options.length) % options.length;
        render();
      } else if (ch === '\x1b[B') {            // ↓
        idx = (idx + 1) % options.length;
        render();
      }
    };
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}
/** 静默输入（用于 Cookie，不回显） */
function askSilent(question) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(C.cyan(question) + ' ');
    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(process._silentBuf || '');
        process._silentBuf = '';
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        process._silentBuf = (process._silentBuf || '').slice(0, -1);
      } else {
        process._silentBuf = (process._silentBuf || '') + ch;
      }
    };
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.once('end', () => resolve(process._silentBuf || ''));
  }).finally(() => { try { process.stdin.setRawMode(false); } catch { /* noop */ } });
}

function maskCookie(c) {
  if (!c) return '';
  return c.replace(/(SESSDATA)=([^;]{6})[^;]*/, '$1=$2****');
}

/** 从链接/裸输入中提取动态 ID 或评论 ID（提取失败原样返回） */
function extractId(v) {
  const s = String(v || '').trim();
  if (!s) return s;
  const dyn = s.match(/(?:t\.bilibili\.com|bilibili\.com)\/(?:dynamic\/)?(\d+)/);
  if (dyn) return dyn[1];
  const rep = s.match(/comment_root_id=(\d+)|comment_id=(\d+)|#reply(\d+)/);
  if (rep) return rep[1] || rep[2] || rep[3];
  return s;
}

// ====== 状态 ======
function stateFile(outDir) {
  return path.join(outDir, 'state.json');
}
function loadState(outDir) {
  try { return JSON.parse(fs.readFileSync(stateFile(outDir), 'utf-8')); } catch { return null; }
}
function saveState(outDir, st) {
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(stateFile(outDir), JSON.stringify(st, null, 2), 'utf-8');
  } catch { /* 忽略 */ }
}

// ====== 核心检查 ======

/** 取消置顶/换新时：拉取旧评论互动并出回顾图（失败降级为日志，不影响主流程） */
async function generateUnpinnedIfPossible(st, cfg, reason) {
  const oldRpid = st?.lastRpid;
  const oldOid = st?.oid || cfg.oid;
  const oldType = st?.type || cfg.type;
  if (!oldRpid || !oldOid) return null;
  try {
    const detail = await getCommentDetail(oldOid, oldType, oldRpid, cfg.cookie);
    if (!detail) {
      if (!cfg.quiet) log(C.dim(`旧评论 ${oldRpid} 已不可查（可能已删除），跳过互动图`));
      return null;
    }
    if (!cfg.quiet) log(C.dim(`拉取旧评论 ${oldRpid} 的子回复...`));
    const replies = await getAllSubReplies(oldOid, oldType, oldRpid, cfg.cookie, 5);
    const items = filterUpInteractions(replies, cfg.uid);
    const replyN = items.filter(i => i.kind === 'reply').length;
    const likeN = items.filter(i => i.kind === 'like').length;
    if (!cfg.quiet) log(C.dim(`UP 回复 ${replyN} 条, UP 点赞 ${likeN} 条, 共 ${items.length} 条互动`));
    const { file } = await generateUnpinnedCard({
      comment: detail,
      items,
      opts: { upName: cfg.upName, oid: oldOid, upMid: cfg.uid },
      outDir: cfg.outDir,
    });
    if (!cfg.quiet) log(`${C.green('✅ 互动回顾图')} (${reason}): ${file}`);
    return file;
  } catch (err) {
    if (!cfg.quiet) log(C.red(`✗ 互动图生成失败（${reason}）: ${err.message}`));
    return null;
  }
}

async function checkOnce(cfg) {
  let { uid, oid, rpid, type, cookie, upName, showReplies, outDir, force, trackDyn, context } = cfg;
  let dyn = null;

  // 0. 指定评论 ID（--rpid）：直接绘制该评论卡片（旧的置顶评论等）
  if (rpid) {
    if (!oid) {
      if (!cfg.quiet) log(C.red('✗ --rpid 模式需要同时指定 --oid'));
      return { event: 'error', oid: null };
    }
    const comment = await getCommentDetail(oid, type || 11, rpid, cookie);
    if (!comment) throw new BiliError(`评论 ${rpid} 不存在或不可访问`);
    // --context：绘制 UP 互动回顾图（UP 回复/点赞对话链），参考 2568x unpinned-context
    if (context) {
      // 未显式指定 --uid 时，自动识别该动态的 UP（评论接口 upper 字段）
      let upMid = uid;
      let upLabel = upName || '';
      if (!cfg.uidExplicit) {
        const upper = await getDynamicUpper(oid, type || 11, cookie).catch(() => null);
        if (upper) { upMid = upper.mid; upLabel = upLabel || upper.name; }
      }
      if (!cfg.quiet) log(C.dim(`拉取评论 ${rpid} 的全部子回复（UP: ${upLabel || upMid}）...`));
      const replies = await getAllSubReplies(oid, type || 11, rpid, cookie, 5);
      const items = filterUpInteractions(replies, upMid || DEFAULT_UID);
      const replyN = items.filter(i => i.kind === 'reply').length;
      const likeN = items.filter(i => i.kind === 'like').length;
      if (!cfg.quiet) log(C.dim(`子回复 ${replies.length} 条, UP 回复 ${replyN} 条, UP 点赞 ${likeN} 条`));
      const { file } = await generateUnpinnedCard({
        comment,
        items,
        opts: { upName: upLabel || comment.author, oid, upMid: upMid || DEFAULT_UID },
        outDir,
      });
      if (!cfg.quiet) log(`${C.green('✅ UP互动回顾图已生成:')} ${file}`);
      return { event: 'context', oid, type: type || 11, comment, file, items: items.length };
    }
    let replies = [];
    if (showReplies) replies = await getReplies(oid, type || 11, comment.rpid, 5, cookie);
    const name = upName || comment.author;
    const { file } = await generateCard({
      comment,
      replies,
      opts: { upName: name, upMid: uid, showReplies, oid },
      outDir,
    });
    if (!cfg.quiet) log(`${C.green('✅ 评论卡片已生成:')} ${file}`);
    return { event: 'manual', oid, type: type || 11, comment, file };
  }

  // 1. 确定 oid（未指定时用 Cookie 自动识别置顶动态）
  if (!oid) {
    dyn = await getPinnedDynamic(uid, cookie);
    oid = dyn.oid;
    type = dyn.type;
    if (!cfg.quiet) log(`${C.dim('自动识别置顶动态:')} ${dyn.dynId} (type=${type})${dyn.pinned ? '' : C.yellow(' [未标记置顶，取最新动态]')}`);
  }

  // 2. 取置顶评论
  const comment = await getPinnedComment(oid, type, cookie);
  const st = loadState(outDir);

  // 3. 变化判定（无 state 时视为首次 → 必然变化）
  const dynChanged = dyn && st && st.lastDynId && st.lastDynId !== dyn.dynId;
  const rpidChanged = !st || st.lastRpid !== (comment ? comment.rpid : null);
  const changed = force || dynChanged || rpidChanged;

  // A. 置顶评论被取消（之前有，现在无）→ 出旧评论互动回顾图
  if (!comment) {
    if (st?.lastRpid) {
      if (!cfg.quiet) log(C.yellow('🔄 置顶评论已取消置顶，生成互动回顾图...'));
      const file = await generateUnpinnedIfPossible(st, cfg, '已取消置顶');
      saveState(outDir, { ...st, lastRpid: null, lastUnpinnedRpid: st.lastRpid, lastCheck: new Date().toISOString() });
      return { event: 'unpinned', file };
    }
    if (!cfg.quiet) log(C.dim('无置顶评论'));
    return { event: 'none', oid, type };
  }

  // B. 普通动态更新（置顶未变，但最新动态变了）→ 提示 + 出动态更新卡片
  const dynUpdate = trackDyn && dyn && st?.lastLatestId && st.lastLatestId !== dyn.latestId && !dynChanged;
  if (dynUpdate) {
    if (!cfg.quiet) log(`${C.yellow('🆕 检测到普通动态更新')} (${dyn.latestId})，生成动态卡片...`);
    try {
      const { file } = await generateDynamicCard({
        dyn,
        opts: { upName: upName || dyn.latestAuthor || dyn.author, oid: dyn.latestId },
        outDir,
      });
      if (!cfg.quiet) log(`${C.green('✅ 动态更新卡片:')} ${file}`);
      st._dynFile = file;
    } catch (err) {
      if (!cfg.quiet) log(C.red(`✗ 动态卡片生成失败: ${err.message}`));
    }
  }

  if (!changed) {
    if (!cfg.quiet) log(`${C.dim('置顶评论未变化:')} ${C.bold(comment.author)} "${(comment.message || '').slice(0, 30)}"${C.dim(` (rpid=${comment.rpid})`)}`);
    if (dynUpdate) {
      saveState(outDir, { ...st, lastLatestId: dyn.latestId, lastCheck: new Date().toISOString() });
      return { event: 'dyn-update', file: st._dynFile };
    }
    return { event: 'same', oid, type, comment };
  }

  // C. 置顶评论换新（旧 rpid 存在且不同）→ 先出旧评论互动回顾图
  if (st?.lastRpid && st.lastRpid !== comment.rpid && !force) {
    if (!cfg.quiet) log(`${C.yellow('🔄 置顶评论换新')}，先生成旧评论互动回顾图...`);
    await generateUnpinnedIfPossible(st, cfg, '置顶评论换新');
  }

  // D. 出当前置顶评论卡片
  if (!cfg.quiet) log(`${C.yellow('🔄 检测到置顶评论变化，正在生成卡片...')}`);
  let replies = [];
  if (showReplies) {
    replies = await getReplies(oid, type, comment.rpid, 5, cookie);
  }
  const name = upName || dyn?.author || comment.author;
  const { file } = await generateCard({
    comment,
    replies,
    opts: { upName: name, upMid: uid, showReplies, oid },
    outDir,
  });
  saveState(outDir, {
    lastRpid: comment.rpid,
    lastDynId: dyn ? dyn.dynId : (st?.lastDynId || null),
    lastLatestId: dyn ? dyn.latestId : (st?.lastLatestId || null),
    oid,
    type,
    lastCard: file,
    lastCheck: new Date().toISOString(),
  });
  if (!cfg.quiet) log(`${C.green('✅ 卡片已生成:')} ${file}`);
  return { event: 'new', oid, type, comment, file };
}

// ====== 主流程 ======
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const saved = loadConfig();
  const cfg = {
    uid: args.uid || saved.uid || DEFAULT_UID,
    uidExplicit: !!args.uid,
    oid: args.oid ? String(args.oid) : (saved.oid || ''),
    rpid: args.rpid ? String(args.rpid) : (saved.rpid || ''),
    type: args.type != null ? parseInt(args.type, 10) : (saved.type || 11),
    cookie: args.cookie != null ? args.cookie : (saved.cookie || ''),
    upName: args.upName || saved.upName || '',
    showReplies: args.showReplies != null ? args.showReplies : (saved.showReplies ?? false),
    interval: args.interval != null ? parseInt(args.interval, 10) : (saved.interval || 60),
    outDir: args.out || saved.outDir || path.join(process.cwd(), 'output'),
    once: args.once,
    force: args.force,
    context: args.context,
    trackDyn: args.trackDyn != null ? args.trackDyn : (saved.trackDyn ?? false),
    quiet: args.quiet,
  };
  // 裸参数 oid / rpid 可能是链接 → 提取数字 ID
  if (cfg.oid) cfg.oid = extractId(cfg.oid);
  if (cfg.rpid) cfg.rpid = extractId(cfg.rpid);
  if (!Number.isFinite(cfg.interval) || cfg.interval < 10) cfg.interval = 60;
  if (!Number.isFinite(cfg.type)) cfg.type = 11;

  // ---- 交互模式：终端提示引导 ----
  if (process.stdin.isTTY && !args.oid && args.cookie == null) {
    console.log(BANNER);
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // —— 模式选择（↑/↓ 移动光标，回车确认） ——
    section('运行模式');
    console.log(C.dim('  ↑/↓ 选择，回车确认'));
    const mode = await select([
      { key: '1', label: '持续监控', desc: '检测到置顶评论变化自动出图（默认）' },
      { key: '2', label: '单次检查', desc: '立即检查并出图一次' },
      { key: '0', label: '退出', desc: '' },
    ], 0);
    if (mode === '0') { console.log('\n再见 👋'); rl.close(); return; }
    cfg.once = mode === '2';

    // —— 目标设置 ——
    section('目标设置');
    const uidAns = await ask('目标 UP 主 UID', cfg.uid);
    cfg.uid = uidAns || DEFAULT_UID;

    // Cookie 交互：已有保存的 Cookie 时明确提示（留空会沿用，输入 clear 清除回到匿名）
    const cookieAns = await ask(
      cfg.cookie
        ? `SESSDATA Cookie（已保存，回车沿用；输入 ${C.yellow('clear')} 清除后匿名）`
        : 'SESSDATA Cookie（可选，留空匿名；提供后可自动识别置顶动态）',
      '');
    if (cookieAns.trim().toLowerCase() === 'clear') {
      cfg.cookie = '';
      if (!cfg.quiet) log(C.dim('已清除已保存的 Cookie，本次以匿名运行'));
    } else if (cookieAns) cfg.cookie = cookieAns;

    const oidAns = await ask('动态链接或 ID（可选，留空则自动识别置顶动态）', cfg.oid || '');
    if (oidAns) cfg.oid = extractId(oidAns);

    if (!cfg.oid && !cfg.cookie) {
      console.log(C.yellow('  ⚠ 未提供 Cookie 时自动识别置顶动态可能被风控（-352），届时程序会提示你补充。'));
    }

    // —— 监控行为 ——
    section('监控行为');
    if (!cfg.once) {
      const iv = await ask('检查间隔（秒）', String(cfg.interval));
      if (parseInt(iv, 10) >= 10) cfg.interval = parseInt(iv, 10);
    }
    cfg.trackDyn = await askYN('同时监测普通动态更新（置顶未变但发了新动态时提示并出图）', cfg.trackDyn);

    // —— 卡片与输出 ——
    section('卡片与输出');
    cfg.showReplies = await askYN('卡片上绘制精彩回复', cfg.showReplies);
    const outAns = await ask('输出目录', cfg.outDir);
    if (outAns) cfg.outDir = outAns;
    const nameAns = await ask('卡片标题显示名（留空自动取 UP 名）', cfg.upName || '');
    if (nameAns) cfg.upName = nameAns;

    // 保存配置（Cookie 也保存，下次免输；注意保管本机安全）
    saveConfig({
      uid: cfg.uid, oid: cfg.oid, type: cfg.type, cookie: cfg.cookie,
      upName: cfg.upName, showReplies: cfg.showReplies,
      interval: cfg.interval, outDir: cfg.outDir, trackDyn: cfg.trackDyn,
    });
    rl.close();
    rl = null;

    // —— 配置汇总 ——
    console.log(`\n${C.pink('┌─ ')}${C.bold('配置完成')}${C.pink(` ${'─'.repeat(Math.max(2, BOX_W - displayWidth('配置完成') - 4))}┐`)}`);
    summaryRow('目标', cfg.oid ? `动态 ${cfg.oid}` : `UID ${cfg.uid}${cfg.cookie ? '（已带 Cookie）' : '（匿名）'}`);
    summaryRow('模式', cfg.once ? '单次检查' : `持续监控 · 每 ${cfg.interval}s`);
    if (cfg.trackDyn) summaryRow('监测', '普通动态更新已开启');
    if (cfg.showReplies) summaryRow('卡片', '含精彩回复');
    summaryRow('输出', cfg.outDir);
    console.log(`\n${C.green('✔')} 开始运行，Ctrl+C 随时退出\n`);
  } else if (!cfg.oid && !cfg.cookie) {
    // 非交互且无 oid：尝试匿名自动识别（可能被风控）
    console.log(C.dim('未指定 --oid 且无 Cookie，尝试匿名自动识别置顶动态（可能被风控）...'));
  }

  if (!cfg.quiet) {
    console.log(BANNER);
    log(`${C.bold('目标:')} ${cfg.oid ? '动态 ' + cfg.oid : 'UID ' + cfg.uid}${cfg.cookie ? ' ' + C.dim('(已带 Cookie)') : C.dim(' (匿名)')}`);
    log(`${C.bold('输出:')} ${cfg.outDir} · ${cfg.once ? '单次检查' : `每 ${cfg.interval}s 监控`}${cfg.force ? ' · 强制出图' : ''}${cfg.showReplies ? ' · 含精彩回复' : ''}`);
    log('');
  }

  // ---- 执行 ----
  let running = true;
  const stopped = () => { running = false; };

  if (process.stdin.isTTY) {
    process.on('SIGINT', () => {
      console.log('');
      log(C.yellow('收到 Ctrl+C，正在退出...'));
      stopped();
      setTimeout(() => process.exit(0), 100);
    });
  }

  const loop = async () => {
    while (running) {
      const t0 = Date.now();
      try {
        const res = await checkOnce(cfg);
        if (res.event === 'error') break; // 参数错误（如 --rpid 缺 --oid），继续循环只会重复报错
        if (res.file && cfg.quiet) {
          console.log(res.file); // quiet 模式只输出文件路径（方便脚本取用）
        }
      } catch (err) {
        if (err instanceof BiliError && (err.code === -352 || err.code === -412)) {
          console.log(C.red(`  ⚠ 风控 (${err.code})：${err.message}`));
          console.log(C.yellow(`  → 解决：提供 SESSDATA Cookie（--cookie "SESSDATA=xxx"）或直接指定动态 ID（--oid <动态ID>）`));
          if (cfg.once) { process.exitCode = 1; return; }
        } else {
          console.log(C.red(`  ✗ 检查失败: ${err.message || err}`));
        }
      }

      if (cfg.once || !running) break;
      const elapsed = Date.now() - t0;
      const wait = Math.max(1, cfg.interval * 1000 - elapsed);
      if (!cfg.quiet) log(C.dim(`下次检查: ${new Date(Date.now() + wait).toLocaleTimeString('zh-CN', { hour12: false })}`));
      await new Promise(r => setTimeout(r, wait));
    }
  };

  await loop();
  if (cfg.once) {
    console.log(C.dim('单次检查完成。'));
  }
}

main().catch(err => {
  console.error(C.red('致命错误: ' + (err?.message || err)));
  process.exit(1);
});
