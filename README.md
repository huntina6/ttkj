# bili-pinned-card

**B站置顶评论监测 + 自动出图** —— 全平台独立命令行程序。

- ✅ 无需浏览器、无需 OpenClaw/ego-browser，纯 Node.js 直连 B站 API
- ✅ 跨平台：Windows / macOS / Linux（渲染用 `@resvg/resvg-js` 预编译二进制，无编译）
- ✅ 匿名可用：置顶评论数据无需登录即可读取
- ✅ 终端交互：模式选择、配置引导（记住上次配置）、监控状态实时输出、Ctrl+C 优雅退出
- ✅ 变化检测：置顶评论换新 / 置顶动态被替换 / 取消置顶 / 普通动态更新（可选）自动识别；`state.json` 持久化，重启不重出图
- ✅ 取消置顶/换新时自动出「UP 互动回顾图」：拉取旧评论全部子回复，筛选 UP 回复/UP 点赞的评论形成对话链
- ✅ `--track-dyn` 可选监测普通动态更新：置顶未变但 UP 发了新动态时提示并出「动态更新」卡片
- ✅ 2x 高清输出：`pinned-card_<时间戳>_<rpid>.png` + `latest.png`

## 安装

需要 Node.js ≥ 18。

```bash
cd bili-pinned-card
npm install
```

## 使用

### 交互模式（推荐）

```bash
node cli.js
```

按终端提示逐步配置：模式（持续监控/单次检查）→ UID → Cookie（可选）→ 动态 ID（可选）→ 间隔 → 是否绘制精彩回复 → 输出目录。配置会保存到 `~/.bili-pinned-card/config.json`，下次运行直接回车使用默认值。

### 命令行模式（可挂 cron）

```bash
# 指定动态，单次检查出图
node cli.js --oid 404135596 --once

# 指定 UP 主 + Cookie，自动识别置顶动态并持续监控
node cli.js --uid 401315430 --cookie "SESSDATA=xxx; bili_jct=yyy" --watch -i 60

# 强制重新出图
node cli.js --oid 404135596 --once --force

# 卡片上绘制精彩回复
node cli.js --oid 404135596 --once -r

# 同时监测普通动态更新（置顶未变但发了新动态时提示并出图）
node cli.js --uid 401315430 --cookie "SESSDATA=xxx" --watch --track-dyn -i 120

# 安静模式：仅输出生成的文件路径（方便脚本取用）
node cli.js --uid 401315430 --cookie "SESSDATA=xxx" --watch -i 300 -q
```

### 监控输出示例

```
[21:18:56] 目标: 动态 404135596 (匿名)
[21:18:56] 输出: ./output · 每 60s 监控
[21:18:57] 🔄 检测到置顶评论变化，正在生成卡片...
[21:18:59] ✅ 卡片已生成: output/pinned-card_20260813131859_313472209520.png
[21:18:59] 下次检查: 21:19:56
```

## 两种数据来源（重要）

| 方式 | 需要 | 说明 |
|---|---|---|
| 指定动态 ID（`--oid`） | 无 | 直接读取该动态的置顶评论，匿名即可，最稳定 |
| 自动识别置顶动态（`--uid`） | SESSDATA Cookie | 匿名会被风控（-352）。提供 Cookie 后每次轮询自动跟随 UP 更换的置顶动态 |

**Cookie 获取方法**：浏览器登录 B站 → F12 → Application/存储 → Cookies → 复制 `SESSDATA` 值（格式 `SESSDATA=xxx; bili_jct=yyy`，两者都可填）。Cookie 保存在本机 `~/.bili-pinned-card/config.json`，请勿外传。

风控提示会直接显示在终端里，按提示操作即可恢复。

## 事件与出图对照

| 事件 | 触发条件 | 出图 |
|---|---|---|
| 首次/置顶评论换新 | rpid 与上次不同 | 置顶评论卡片（换新时先出旧评论的互动回顾图） |
| 置顶动态被替换 | 置顶动态 ID 变化 | 新置顶动态的评论卡片 |
| 置顶评论取消 | 之前有置顶评论，现在无 | UP 互动回顾图（旧评论的子回复中筛选 UP 回复/点赞） |
| 普通动态更新（可选） | `--track-dyn` 开启且最新动态 ID 变化（置顶未变） | 动态更新卡片 |

「UP 互动回顾图」：旧评论被取消置顶/换新时，拉取其全部子回复，筛选出被 UP 回复、被 UP 点赞的评论，以对话链形式绘制。旧评论已删除时自动跳过（仅日志提示）。

## 卡片样式

复刻原浏览器版模板（深色渐变 + 粉色徽标）：

- 标题栏：`置顶评论 · 动态 · <UP名>`
- 主卡片：头像 / 作者 / UP主徽标 / 时间 / 正文（表情内联渲染、自动换行）/ 图片网格（单图大图、多图 3 列）/ 点赞与回复数
- 精彩回复（`-r` 开启）：回复者头像、UP 回复粉色标识、时间与点赞
- 页脚：`BILI PINNED COMMENT #<rpid尾8位>`

字体用系统字体：macOS PingFang SC / Windows 微软雅黑 / Linux Noto Sans CJK，无需配置。正文含 emoji 时可能显示为空白（渲染器不支持彩色 emoji 字体），B站表情（`[xxx]` 占位符）已支持内联图片。

## 输出文件

- `pinned-card_<yyyyMMddHHmmss>_<rpid>.png` —— 置顶评论卡片（2x 高清）
- `unpinned-context_<时间戳>_<rpid>.png` —— 取消置顶/换新时的 UP 互动回顾图
- `dynamic-update_<时间戳>_<动态ID>.png` —— 普通动态更新卡片（`--track-dyn`）
- `latest.png` / `latest-unpinned.png` / `latest-dynamic.png` —— 各类最新一张的固定名副本
- `state.json` —— 监控状态（上次 rpid/oid/动态ID/时间），删除后下次运行会重新出图

## 常见问题

- **`-352` 风控**：匿名自动识别置顶动态被拦截 → 提供 `--cookie` 或改用 `--oid` 直连。
- **互动图显示「暂无 UP 互动」**：该评论的子回复中没有 UP 回复/点赞的记录，属正常情况。
- **图片空白/占位**：个别 CDN 图下载失败时自动降级为占位块，不影响文字。
- **`--interval` 最小 10 秒**：过频会被风控，建议 ≥ 30。
- **Node < 18**：`fetch`/`AbortSignal.timeout` 不可用，请升级。

## 项目结构

```
bili-pinned-card/
├── cli.js          # 入口：终端交互、监控循环、状态管理
├── lib/api.js      # B站 API 层（buvid 风控、Cookie 合并、评论/回复/图片）
└── lib/card.js     # SVG 卡片布局 + resvg 渲染 PNG
```
