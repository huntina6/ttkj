# 更新日志 Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-08-13

### 新增
- 首次公开发布
- `cli.js`：终端交互式命令行入口
  - 模式选择（持续监控 / 单次检查）、配置引导、配置持久化（`~/.bili-pinned-card/config.json`）
  - 非 TTY 参数模式（`--uid/--oid/--cookie/--watch/--once/--force/--track-dyn` 等），可挂 cron
  - 监控循环：变化检测、风控友好提示、Ctrl+C 优雅退出
- `lib/api.js`：B站 API 层
  - 匿名访问（自动获取 buvid3/buvid4 防风控），置顶评论/子回复/detail 接口无需登录
  - 可选 SESSDATA Cookie：自动识别置顶动态（匿名会被 -352 风控）
  - UP 互动筛选（UP 回复 / UP 点赞对话链）、动态内容提取
- `lib/card.js`：SVG 卡片渲染（`@resvg/resvg-js`，跨平台无浏览器依赖）
  - 置顶评论卡片：头像 / 作者 / UP 徽标 / 正文（表情内联、自动换行）/ 图片网格 / 点赞回复统计
  - UP 互动回顾图：取消置顶或换新时自动生成（被 UP 回复 / UP 点赞对话链）
  - 动态更新卡片（`--track-dyn`）
  - 2x 高清 PNG 输出 + `latest*.png` 固定名副本
- 事件 → 出图完整闭环：
  - 置顶评论换新 → 先出旧评论互动回顾图，再出当前卡片
  - 置顶动态被替换 → 自动跟随出新图
  - 取消置顶 → 出 UP 互动回顾图
  - 普通动态更新（可选）→ 出动态更新卡片
- `test/card.test.js`：18 个单元测试（`npm test`，node:test 零额外依赖）
- GitHub Actions CI：语法检查 + 单元测试 + 敏感信息扫描

### 说明
- 运行时 Cookie 保存在本机 `~/.bili-pinned-card/config.json`，不入库
- 依赖：@resvg/resvg-js（各平台预编译二进制，无编译），Node ≥ 18
