# VidSizer — Compress Any Video to Any Exact Size

**Brand:** VidSizer · **Canonical domain:** https://vidsizer.com
**Product:** browser-side video compressor. The user picks an EXACT target file size
(Discord 20/50/500 MB, WhatsApp 16 MB, Gmail 25 MB, or custom MB); the tool computes
the right bitrate and outputs a file just under the limit.
**Cost:** $0 — 100% client-side, no server, no build step. Vanilla HTML/CSS/JS.

## How it works

- `app.js` (shared by every tool page) loads `@ffmpeg/ffmpeg@0.12.10` via ESM from
  jsDelivr, with the **single-threaded** `@ffmpeg/core@0.12.10` (`dist/esm`) build —
  so **no COOP/COEP headers are needed** (works on plain Cloudflare Pages).
- Flow: drop file → metadata read via a `<video>` element (duration, dimensions,
  original size) → pick target size preset → Compress.
- Bitrate math: `totalBits = targetMB·1024·1024·8`; `audioBits = 128000·duration`;
  `videoBitrate = (totalBits·0.96 − audioBits)/duration`, clamped to ≥ 250k.
  Below 400k shows an honest quality warning.
- ffmpeg args: `-c:v libx264 -b:v {br}k -maxrate {1.5×}k -bufsize {2×}k`
  `-vf scale=-2:720` (only if input height > 720) `-preset veryfast -c:a aac -b:a 128k -movflags +faststart`
- **Verify-and-retry:** after encoding, output size is checked; if over target,
  bitrate is scaled by `(target/actual)·0.97` and re-encoded, up to 3 attempts.
- Progress % shown during encode; result shows "Original → Output ✓ under your limit".

## Pages (clean URLs = directory + index.html)

| URL | File |
|---|---|
| `/` | `index.html` — home, "Compress Any Video to Any Exact Size" |
| `/discord-video-compressor/` | SEO wedge, current Discord limits, preset 20 MB |
| `/compress-video-for-discord/` | variant phrasing page |
| `/discord-video-size-limit/` | content page: limits table, the 8 MB myth debunked |
| `/compress-video-to-20mb/` | exact-size landing, preset 20 MB |
| `/compress-video-to-50mb/` | exact-size landing, preset 50 MB |
| `/compress-video-to-500mb/` | exact-size landing, preset 500 MB |
| `/compress-video-for-whatsapp/` | 16 MB document trick, preset 16 MB |
| `/compress-video-for-gmail/` | 25 MB attachment limit, preset 25 MB |

Shared: `style.css`, `app.js`. Also: `sitemap.xml`, `robots.txt`, inline SVG favicon.

## Deploy on Cloudflare Pages (zero cost)

**Option A — Dashboard upload (no CLI):**
1. Cloudflare Dashboard → Workers & Pages → Create → Pages → **Upload assets**
2. Name the project `vidsizer`, drag the contents of this folder (or zip it) in
3. Deploy. Your site is live at `vidsizer.pages.dev`

**Option B — Wrangler CLI:**
```bash
cd ~/workspace/vidsizer
npx wrangler pages deploy . --project-name=vidsizer
```

**Connect the custom domain:**
1. Pages project → Custom domains → Set up a custom domain → enter `vidsizer.com`
2. If the domain is on Cloudflare already, DNS is automatic. If registered elsewhere,
   add the CNAME Cloudflare shows you (or transfer the domain to Cloudflare Registrar —
   typically cheapest, at-cost pricing).

No environment variables, no build command, no functions needed.
`_headers`/`_redirects` files are not required (single-threaded ffmpeg needs no
COOP/COEP).

## Validation

- `node --check` passes on `app.js` (checked as ESM).
- Manual QA checklist before launch:
  - [ ] Drop an MP4 → metadata shows → estimate appears
  - [ ] Compress to 20 MB → output ≤ 20 MB, downloads as MP4
  - [ ] Long clip + small target → quality warning appears
  - [ ] Oversize output triggers a retry pass (watch "Pass 2 of up to 3")
  - [ ] Test on mobile Safari/Chrome (slower, but works for small clips)

## Known limitations

- First encode downloads ~30 MB of ffmpeg WASM (cached afterwards).
- Files > 1 GB are refused (browser tabs OOM); very long clips on phones are slow.
- Some exotic codecs (e.g. HEVC in MKV on some browsers) may fail to decode —
  the UI suggests re-exporting as MP4 (H.264).
- Discord limits are stated as "last verified September 2026" — re-check
  periodically; the August 2026 change (free 10→20 MB) is why freshness matters here！
