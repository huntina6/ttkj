# 更新日志 Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-08-13

### 新增
- `--rpid <评论ID或链接>`：按评论 ID 直接绘制置顶样式卡片（旧置顶评论等），支持粘贴 `t.bilibili.com` 分享链接自动提取 ID
- `--context`：与 `--rpid` 联用，生成该评论的 UP 互动回顾图（UP 回复/点赞对话链）
- `--context` 自动识别动态 UP（评论接口 `upper` 字段），无需手动指定 UID
- Cookie 保存到 `~/.bili-pinned-card/config.json` 后运行时自动加载，无需每次传 `--cookie`
- `scripts/export-svg.js`：导出卡片 SVG 源码，供设计/视觉模型参考
- 互动回顾图：互动链评论的自带图片补全渲染（单图按比例、多图 3 列）

### 修复
- 卡片图片按原图比例完整展开：解析图片实际尺寸（JPEG/PNG/WebP），竖图/长图不再被 320×240 `slice` 裁剪
- 互动回顾图/回复区：日期（时间 · 赞）与正文重叠（多行正文时元信息行高不足）→ 块高度 +22px
- 页脚同步显示动态完整链接（UP互动回顾图 / 动态更新卡片），与置顶评论卡片一致
### 修复（2026-08-15 同步）
- 修复 UP 互动识别失效（B站 API mid 为数字、CLI uid 为字符串，严格比较恒 false）→ 互动回顾图/UP 标识恢复正常
- 修复主卡片无条件显示「UP主」徽标（粉丝评论误标）→ 按评论作者是否为目标 UP 条件显示
- 修复交互模式粘贴 t.bilibili.com 链接解析失败 → 统一 extractId 解析
- 修复置顶评论被删除（-404）时程序报错 → 优雅降级为「无置顶评论」
- 修复 export-svg.js 头像/表情丢失；--rpid 缺 --oid 无限报错；--type 非法值；图片下载失败缓存
- 修复终端横幅（BANNER）歪斜：CJK 全角字符按 2 列显示宽度动态对齐填充空格，边框左右字符独立
- 修复交互模式 Cookie 提示误导：有已保存 Cookie 时明确提示（回车沿用，输入 clear 清除后匿名）
- 交互模式全新 UI：分组分区（运行模式/目标设置/监控行为/卡片与输出）、➤ 提示符、配置完成汇总

## [1.0.1] - 2026-08-13

### 修复
- 移除主卡片底部统计栏（❤ 赞 / 条回复 / 分隔线），卡片更简洁
- 卡片文字整体右移：`lineToSvg` 对字符宽度双重累加，导致整行 `<text>` 起点偏移整行宽度（一行越满歪得越狠）
- 头像/图片网格被完全裁剪：`clipPath` 默认 `userSpaceOnUse` 坐标系，圆形裁剪定义在原点 `(0,0)` 而图片在卡片中部，两区域不相交 → 头像不显示；改用 `clipPathUnits="objectBoundingBox"` 相对裁剪
- `npm run check` 原为 bash for 循环，Windows 下无法运行；改为跨平台 `node --check` 链

### 新增
- 回归测试 ×2：`clipPath` 使用 objectBoundingBox + 渲染后像素级断言（头像区域可见、正文起点对齐）
- `scripts/verify-pixels.js`：PNG 像素检查脚本，快速验证卡片布局

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
