# VidSizer 学 ClipUtils 矩阵打法 — 计划与执行（2026-10-26）

## ClipUtils 套路（2026-10-26 实查首页 + sitemap）

- 约 90 个 `/tools/` 页面 + 约 25 篇 blog，全部浏览器端（FFmpeg.wasm），零服务器成本。
- 矩阵维度：精确尺寸（resize-image-to-10/20/30/50/100/200/500kb、compress-video-to-10mb/25mb）、
  证件尺寸（150x200、413x531）、格式转换（X→mp3/mp4 十几个组合）、语言（translate/dub × 5 语）、
  平台（remove-music × Instagram/TikTok/YouTube、whatsapp-audio-to-mp3）。
- Blog（how-to）给工具页导流；首页信任文案打头（免费/无水印/不用注册/文件不离开设备/可离线）。
- 变现：核心永远免费；Pro 一次性付费、分地区定价（约 $1–$2.99），只解锁附加项；另有 /advertise。

## VidSizer 现状（本批之前）

- 22 页：8 个尺寸页（8/10/16/20/25/50/100/500MB）、13 个平台页（Discord/WhatsApp/Telegram/
  Slack/Signal/Messenger/iMessage/Reddit/Gmail/iPhone/Android + discord-video-compressor +
  discord-video-size-limit）、1 个对比页。
- 首页信任文案已有（Free · No signup · No watermark + "never leaves your device"），无需重做。
- 工具现状：输入 MP4/MOV/WebM/MKV/AVI，输出恒为 MP4（H.264 + AAC）；FFmpeg 核心已编译
  libmp3lame（wasm 内实测确认），具备音频提取能力。

## 本批执行（9 新页 + app.js 双模式）

- Batch A — 格式转换页（3 页，零新功能，复用现有压缩工具）：
  mov-to-mp4、webm-to-mp4、mkv-to-mp4。新增 `data-mode="convert"`：强制重编码
  （绕过"已小于目标则原样下载"的捷径，否则转换页会把原格式文件原样还给用户），
  默认预算 500MB，可再选精确尺寸。
- Batch B — 音频提取（1 页 + app.js 小改动，仅该页生效）：
  video-to-mp3（`data-mode="audio"`，libmp3lame 192k 输出 MP3）。mp4-to-mp3 不单独立页，
  并入本页文案与 FAQ，避免近重复页。
- Batch C — 尺寸缺口（1 页）：compress-video-to-200mb（preset 200）。
  原定 1gb 页已取消：工具对源文件有 1GB 浏览器内存上限，1GB 目标页的核心意图
  （把大于 1GB 的文件压到 1GB 以下）恰好无法服务，做了只会引来无法服务的用户；
  200MB 是可服务且真实存在的档位。
- Batch D — guides 层（4 页，纯内容 + 内链，不内嵌工具）：
  how-to-compress-video-for-discord、how-to-compress-video-for-email、
  how-to-reduce-video-file-size、how-to-convert-mov-to-mp4。
- Batch E — 管线：sitemap 补 9 条、全部页面页脚导航补新链接、首页加 Convert/Guides 入口、
  部署后 IndexNow 提交新 URL；GSC URL 检查留给 John（他的 Google 账号）。

## 明确不做的事（及原因）

- 图片/PDF/纯音频转换页：John 2026-09-28 定的扩张顺序——视频流量验证通过后才扩品类，
  本批仍是视频品类，不越线。
- AI 功能（字幕/翻译/配音/人声分离）：需服务端 API，有边际成本，破零成本根基。
- Instagram/TikTok 平台页：无可核验的硬性 MB 限额，写了就是编数字；等核实限额后再做。
- 尺寸 × 平台组合页（如 20mb-for-discord）：与现有平台页重复，doorway 风险。
- 一天铺 90 页：本批 9 页均为差异化实质内容，非换词门页；SEO-PLAN 的"每天 2–3 页"
  节奏建议已告知 John，本批按他"能做的都做了"的指令一次上齐。

## 质量铁律（沿用 SEO-PLAN）

- 每页差异化实质内容，禁止纯换关键词的门页；不编造任何平台限额数字。
- 工具页：FAQPage + HowTo schema；guides 页：Article schema；全部 canonical 指向 vidsizer.com。
- 上线前校验：node --check、内链可达、JSON-LD 可解析、data-preset/data-mode 正确、
  无模板残留；部署后逐 URL 线上验 200。
