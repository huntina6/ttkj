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
const { BiliError, getPinnedDynamic, getPinnedComment, getReplies } = require('./lib/api');
const { generateCard } = require('./lib/card');

const VERSION = '1.0.0';
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

const BANNER = `
╔══════════════════════════════════════════════╗
║   ${C.bold(C.pink('B站 置顶评论监测 · 自动出图'))} v${VERSION}              ║
║   ${C.dim('全平台独立版 · 无需浏览器 · 无需登录')}               ║
╚══════════════════════════════════════════════╝
`;

// ====== 参数解析 ======
function parseArgs(argv) {
  const a = {
    uid: null, oid: null, type: null, interval: null, out: null,
    once: false, force: false, showReplies: null, cookie: null,
    upName: null, quiet: false, help: false,
  };
  const set = (k, v) => { a[k] = v; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--uid': case '-u': set('uid', argv[++i]); break;
      case '--oid': set('oid', argv[++i]); break;
      case '--type': case '-t': set('type', argv[++i]); break;
      case '--interval': case '-i': set('interval', argv[++i]); break;
      case '--out': case '-o': set('out', argv[++i]); break;
      case '--cookie': case '-c': set('cookie', argv[++i]); break;
      case '--up-name': set('upName', argv[++i]); break;
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
  --uid <UP主UID>        目标 UP 主（配合 Cookie 自动识别置顶动态）
  --cookie <SESSDATA>    登录 Cookie（可选）：解锁自动识别置顶动态，降低风控
  --watch                持续监控（默认）
  --once                 单次检查并出图后退出
  --force                即使置顶评论未变化也重新出图
  -r, --show-replies     卡片上绘制精彩回复（默认不画）
  -i, --interval <秒>    监控间隔（默认 60，最短 10）
  -o, --out <目录>       输出目录（默认 ./output）
  -q, --quiet            安静模式（仅输出结果行）
  -h, --help             帮助

示例:
  node cli.js --oid 404135596 --once --force
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
    rl.question(C.cyan(question) + suffix + ' ', ans => {
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
async function checkOnce(cfg) {
  let { uid, oid, type, cookie, upName, showReplies, outDir, force } = cfg;
  let dyn = null;

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

  // 3. 变化判定（无 state 时视为首次 → 必然变化；isFirst 不参与判定，保证 --once 跨进程生效）
  const dynChanged = dyn && st && st.lastDynId && st.lastDynId !== dyn.dynId;
  const rpidChanged = !st || st.lastRpid !== (comment ? comment.rpid : null);
  const changed = force || dynChanged || rpidChanged;

  if (!comment) {
    if (st?.lastRpid) {
      if (!cfg.quiet) log(C.yellow('🔄 置顶评论已取消置顶（之前有，现在无）'));
      saveState(outDir, { ...st, lastRpid: null, lastCheck: new Date().toISOString() });
      return { event: 'unpinned' };
    }
    if (!cfg.quiet) log(C.dim('无置顶评论'));
    return { event: 'none', oid, type };
  }

  if (!changed) {
    if (!cfg.quiet) log(`${C.dim('置顶评论未变化:')} ${C.bold(comment.author)} "${(comment.message || '').slice(0, 30)}"${C.dim(` (rpid=${comment.rpid})`)}`);
    return { event: 'same', oid, type, comment };
  }

  // 4. 出图
  if (!cfg.quiet) log(`${C.yellow('🔄 检测到置顶评论变化，正在生成卡片...')}`);
  let replies = [];
  if (showReplies) {
    replies = await getReplies(oid, type, comment.rpid, 5, cookie);
  }
  const name = upName || dyn?.author || comment.author;
  const { file } = await generateCard({
    comment,
    replies,
    opts: { upName: name, upMid: uid, showReplies },
    outDir,
  });
  saveState(outDir, {
    lastRpid: comment.rpid,
    lastDynId: dyn ? dyn.dynId : (st?.lastDynId || null),
    oid,
    type,
    lastCard: file,
    lastCheck: new Date().toISOString(),
  });
  if (!cfg.quiet) log(`${C.green('✅ 卡片已生成:')} ${file}`);
  return { event: changed ? 'new' : 'same', oid, type, comment, file };
}

// ====== 主流程 ======
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const saved = loadConfig();
  const cfg = {
    uid: args.uid || saved.uid || DEFAULT_UID,
    oid: args.oid ? String(args.oid) : (saved.oid || ''),
    type: args.type != null ? parseInt(args.type, 10) : (saved.type || 11),
    cookie: args.cookie != null ? args.cookie : (saved.cookie || ''),
    upName: args.upName || saved.upName || '',
    showReplies: args.showReplies != null ? args.showReplies : (saved.showReplies ?? false),
    interval: args.interval != null ? parseInt(args.interval, 10) : (saved.interval || 60),
    outDir: args.out || saved.outDir || path.join(process.cwd(), 'output'),
    once: args.once,
    force: args.force,
    quiet: args.quiet,
  };
  // 裸参数 oid 可能是链接
  if (cfg.oid) {
    const m = String(cfg.oid).match(/dynamic\/(\d+)/);
    if (m) cfg.oid = m[1];
  }
  if (!Number.isFinite(cfg.interval) || cfg.interval < 10) cfg.interval = 60;

  // ---- 交互模式：终端提示引导 ----
  if (process.stdin.isTTY && !args.oid && args.cookie == null) {
    console.log(BANNER);
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`${C.bold('请选择模式:')}`);
    console.log(`  ${C.cyan('1')} 持续监控（默认）：检测到置顶评论变化自动出图`);
    console.log(`  ${C.cyan('2')} 单次检查：立即检查并出图一次`);
    console.log(`  ${C.cyan('0')} 退出`);
    const mode = await ask('选择', '1');
    if (mode === '0') { console.log('再见 👋'); rl.close(); return; }
    cfg.once = mode === '2';

    const uidAns = await ask('目标 UP 主 UID', cfg.uid);
    cfg.uid = uidAns || DEFAULT_UID;

    const cookieAns = await ask('SESSDATA Cookie（可选，留空匿名；提供后可自动识别置顶动态）', '');
    if (cookieAns) cfg.cookie = cookieAns;

    const oidAns = await ask('动态链接或 ID（可选，留空则自动识别置顶动态）', cfg.oid || '');
    if (oidAns) cfg.oid = String(oidAns).match(/dynamic\/(\d+)/)?.[1] || String(oidAns);

    if (!cfg.oid && !cfg.cookie) {
      console.log(C.yellow('  ⚠ 未提供 Cookie 时自动识别置顶动态可能被风控（-352），届时程序会提示你补充。'));
    }

    if (!cfg.once) {
      const iv = await ask('检查间隔（秒）', String(cfg.interval));
      if (parseInt(iv, 10) >= 10) cfg.interval = parseInt(iv, 10);
    }
    cfg.showReplies = await askYN('卡片上绘制精彩回复', cfg.showReplies);
    const outAns = await ask('输出目录', cfg.outDir);
    if (outAns) cfg.outDir = outAns;
    const nameAns = await ask('卡片标题显示名（留空自动取 UP 名）', cfg.upName || '');
    if (nameAns) cfg.upName = nameAns;

    // 保存配置（Cookie 也保存，下次免输；注意保管本机安全）
    saveConfig({
      uid: cfg.uid, oid: cfg.oid, type: cfg.type, cookie: cfg.cookie,
      upName: cfg.upName, showReplies: cfg.showReplies,
      interval: cfg.interval, outDir: cfg.outDir,
    });
    rl.close();
    rl = null;
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
        if (res.event === 'new' && res.file && cfg.quiet) {
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
