# VidSizer SEO 方案（2026-09-28）

目标：尽快获得自然搜索流量。核心判断：打长尾 + 场景词，不碰 head 词和对比页。

## 时间线实话

- Bing / DuckDuckGo：提交 Webmaster Tools + IndexNow 后，几周内可来第一波流量（索引快、竞争小）。
- Google：新域名 3–6 个月是常态，但长尾精确匹配词可以更快出 impression。域名年龄从购买绑定那天算起。

## Phase 0 — 今天（最高优先级，阻塞所有后续）

1. 购买 vidsizer.com，绑定 Cloudflare Pages。
2. 全站 canonical 指向 vidsizer.com；更新 robots.txt / sitemap.xml。
3. 提交 Google Search Console + Bing Webmaster Tools，提交 sitemap；Bing 开 IndexNow。
4. 每发一个新页面，用 IndexNow / GSC URL 检查推送一次。

## Phase 1 — 第 1–2 周：长尾页面矩阵（8 → 25 页）

SERP 实证（2026-09-28）：
- "compress video to 8mb"：第 1 是独立小站 iamtypist.dev，第 2 是 7 天前发的 dev.to 帖子 → 小站/UGC 能排，竞争弱。
- "compress video for telegram"：前排是 GitHub README（机器人仓库），没有强工具页 → 空位。
- videocompress.ai 的 Discord 页还写免费 10MB（2026-08 已涨到 20MB）→ 内容准确性是我们的武器。

已有的 8 页：discord-video-compressor / compress-video-for-discord / discord-video-size-limit /
compress-video-to-20mb / 50mb / 500mb / compress-video-for-whatsapp / compress-video-for-gmail

第一批新增（6 页，优先级排序）：
1. /compress-video-for-telegram/ —— SERP 最弱，GitHub README 在排
2. /compress-video-to-8mb/ —— dev.to 帖子排第 2，可超；老论坛/表单仍有真实需求
3. /compress-video-to-10mb/ —— 历史 Discord 数字，搜索量仍在
4. /compress-video-for-iphone/ —— 移动端意图强（iamtypist 有专门章节验证需求）
5. /compress-video-for-android/
6. /compress-video-to-100mb/

第二批（第 2–3 周）：slack、signal、messenger、imessage、reddit、instagram、tiktok、16mb、25mb。

每页模板（复用现有）：
- 内嵌工具 + data-preset 预设到对应目标
- 平台限额表，带 "Last verified {月份 年份}"
- 3 步使用教程 + FAQ（加 FAQPage schema）
- 差异化内容，禁止纯换关键词的门页

节奏警告：每天 2–3 页，不要一天发 100 页（thin content / doorway 风险）。

## Phase 2 — 技术 SEO（第 1 周同步）

- sitemap.xml 随新页面更新；robots.txt 保持干净
- Schema：每页 FAQPage，首页/工具页 SoftwareApplication
- 内链 hub-and-spoke：首页 ↔ 平台页 ↔ 尺寸页互相链
- Core Web Vitals：wasm 懒加载已做，不阻塞 LCP；图片加宽高防 CLS

## Phase 3 — 加速器（SEO 等待期的流量，不依赖社交运营）

1. Reddit 问答：r/discord、r/Telegram 等有人问"视频太大发不出去"时真诚回答 + 工具链接（帮忙，不是 spam）。
2. Show HN："Show HN: compress video to an exact size, 100% client-side, no upload"——HN 吃这一套，还能拿高质量外链。
3. dev.to 教程文：SERP 证明这个 niche 的 UGC 能排，写一篇真教程（bitrate 数学 + 工具链接）。
4. Product Hunt（可选）：spike 流量 + 外链。

## 衡量

- GSC：先看 impression（有没有出词），再看点击；哪个页面先出词，加码做它的变体。
- 每周复查一次"limits last verified"日期，平台改限额即更新——准确性就是排名武器。

## 不做的事

- 对比页（等有权重再说）
- 买外链
- head 词 "video compressor"（先别碰）
