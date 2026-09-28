# How I built a video compressor that hits an *exact* file size — 100% in the browser

> Draft for dev.to — written 2026-09-28. Post from John's dev.to account when ready.

---

Ever needed a video to be *exactly* under 25 MB for a Gmail attachment, or exactly 8 MB for Discord? Most "compressors" give you a quality slider and wish you luck. I built [VidSizer](https://vidsizer.com) to do the opposite: you type the target size, it computes the exact bitrate needed, and the output lands under it. No upload, no server, no account — the whole encode runs in your browser with FFmpeg.wasm.

Here are the engineering lessons that surprised me.

## 1. Exact size is just arithmetic — if you're honest about overhead

The core formula is trivial:

```
total_bitrate = target_bytes × 8 / duration_seconds
video_bitrate = total_bitrate − audio_bitrate − container_overhead
```

The devil is in the honesty:

- **Container overhead isn't zero.** MP4 muxing eats ~1–2%. I plan with a 6% safety margin: aim for 94% of the target. After one encode I measure the real output; if it's slightly over, I adjust and re-encode once more (max 2 passes).
- **Audio is a fixed tax.** 128k audio on a 10 MB target is a rounding error; on a 1 MB target it's a quarter of your budget. So I use an audio ladder: 128k → 96k → 64k as the budget shrinks.
- **Resolution is the real lever.** Dropping 1080p → 360p cuts the pixels by 9×. Nobody wants to admit it, but for a hard size target, resolution beats bitrate fiddling every time. I use a resolution ladder (1080p → 720p → 480p → 360p) and pick the highest rung whose bitrate budget still gives decent quality — then *tell the user* what they'll get before encoding ("Planned output: 360p · 0.8 Mbps — expect softer detail").
- **Fail fast on impossible targets.** If the math says even 360p + 64k audio can't fit, don't burn 5 minutes encoding — say so up front and suggest a bigger target. Users respect honesty more than a spinning progress bar.

## 2. The 25 MB wall: Cloudflare Pages won't serve your .wasm

FFmpeg.wasm's core is ~31 MB. Cloudflare Pages refuses to deploy any single file over 25 MiB. The fix: split the wasm into two chunks at build time, deploy both, and reassemble in the browser:

```js
const [p0, p1] = await Promise.all([
  fetch('/vendor/ffmpeg-core.wasm.part00').then(r => r.arrayBuffer()),
  fetch('/vendor/ffmpeg-core.wasm.part01').then(r => r.arrayBuffer()),
]);
const blob = new Blob([p0, p1], { type: 'application/wasm' });
const coreURL = URL.createObjectURL(blob);
```

Feed `coreURL` to FFmpeg as the core. Works for single-threaded and multi-threaded cores alike.

## 3. The worker cross-origin trap

`@ffmpeg/ffmpeg` (the JS wrapper) loads fine from a CDN — but then it spawns its *worker* from the CDN origin, and any relative `coreURL` you pass gets resolved against `cdn.jsdelivr.net` instead of your domain. Your self-hosted wasm 404s and you get a cryptic load failure.

Fix: self-host the wrapper's `dist/esm` files too (I copied them to `/vendor/lib`), so wrapper and worker share your origin. While I was at it, I dropped the `@ffmpeg/util` dependency entirely — v0.12 of the wrapper doesn't export `fetchFile` anymore, so I wrote a 10-line local replacement.

## 4. Multi-threading: fast on paper, treacherous in practice

The multi-threaded core (`@ffmpeg/core-mt`) needs `crossOriginIsolated` — i.e. `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` headers on every response. I set those in Cloudflare Pages' `_headers` file, and it works: ~3–4× faster on a real machine.

But in a headless VM it hung at 0% progress with no error — twice. No logs, no crash, just silence. My takeaway: **ship single-threaded as the default and gate multi-threading behind a flag** (`?mt=1`) until you've validated it on real hardware. A slow success beats a fast hang. (Also: cap x264 threads at 8 — more threads on more cores gave diminishing returns and spikier memory.)

## 5. If the file is already under target, don't encode

Obvious in retrospect: check `input.size <= target` first and skip encoding entirely — just hand back the original file. It also makes for a great demo moment.

## 6. The 200 MB honesty note

Browser encoding has a memory wall. Files over ~200 MB *can* work in desktop Chrome but may be slow or OOM on weaker machines. I show a banner for big files instead of pretending everything is fine. Users forgive a warning; they don't forgive a crashed tab.

---

The whole thing is a static site — zero server cost, which is the only reason a free unlimited tool like this is sustainable. If you want to try it: [vidsizer.com](https://vidsizer.com) — pick any exact size, it hits it.

Happy to answer questions about FFmpeg.wasm, the bitrate math, or the Pages deployment hacks.
