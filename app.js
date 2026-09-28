/* VidSizer — shared browser-side video compression engine.
 * 100% client-side: @ffmpeg/ffmpeg with a multi-threaded core when the page
 * is cross-origin isolated (see _headers: COOP + COEP), single-threaded
 * fallback otherwise. No build step. Loaded as an ES module on every tool page.
 *
 * IMPORTANT: the FFmpeg wrapper library is loaded with a DYNAMIC import (not a
 * static top-level import) so that a blocked/slow CDN can never kill the whole
 * UI — buttons stay wired, and encoder-load failures surface as a clear message.
 * The wrapper AND the heavy encoder core (~31 MB) are self-hosted in /vendor/
 * (local first), with CDN fallbacks. Self-hosting the wrapper matters: the
 * wrapper spawns its worker from its own URL, and relative coreURL/wasmURL
 * resolve against the worker script — a CDN-hosted worker would resolve
 * '/vendor/…' against the CDN origin (404). Same-origin worker + Blob-URL wasm
 * keeps everything working with zero CDN dependency.
 * Cloudflare Pages caps deployed files at 25 MiB, so the wasm ships as two
 * parts and is reassembled in-memory via a Blob URL (fetchable from the worker);
 * if that ever fails we fall back to CDN.
 * window.__vidsizerCoreSource reports which core actually loaded
 * ('self-hosted-mt' | 'self-hosted-st' | 'cdn'), and window.__vidsizerThreads
 * reports 'mt' or 'st'. */
const CORE_VERSION = '0.12.10';
const LIB_URLS = [
  '/vendor/lib/index.js', // self-hosted wrapper — same-origin worker
  `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${CORE_VERSION}/+esm`,
  `https://esm.sh/@ffmpeg/ffmpeg@${CORE_VERSION}`,
];
const WASM_PARTS = [
  '/vendor/ffmpeg-core.wasm.part00',
  '/vendor/ffmpeg-core.wasm.part01',
];
// Multi-threaded core (@ffmpeg/core-mt): same split treatment, ~31 MiB.
const WASM_PARTS_MT = [
  '/vendor/ffmpeg-core-mt.wasm.part00',
  '/vendor/ffmpeg-core-mt.wasm.part01',
];
// SharedArrayBuffer (needed by the MT core) only exists in a
// cross-origin-isolated page — enabled via the _headers file
// (COOP: same-origin + COEP: credentialless). Where isolation is off
// (older browsers), we transparently fall back to the single-threaded core.
const MT_OK = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true;
const CORE_BASES = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];
const AUDIO_BITRATE = 128000; // 128k AAC
const SAFETY_MARGIN = 0.94;   // keep output ~6% under target
const WARN_BITRATE = 700000;  // warn when the video bitrate plan falls below this
const ABS_MIN_VIDEO_BR = 80000; // absolute floor — below this we fail fast, not retry
const ABS_MIN_AUDIO_BR = 64000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GB — beyond this, browsers likely OOM

const $ = (id) => document.getElementById(id);

let ffmpeg = null;
let ffmpegLoading = null;
let file = null;
let objectURL = null;
let durationSec = 0;
let vidWidth = 0;
let vidHeight = 0;
let targetMB = 20;
let busy = false;

// FFmpeg wrapper library is loaded lazily (dynamic import) so a blocked CDN
// can never kill the whole UI. See LIB_URLS / CORE_BASES above.
let FFmpegCtor = null;

// fetchFile (File/Blob/URL -> Uint8Array) lives in the separate @ffmpeg/util
// package; it's trivial, so we implement it locally and skip that dependency.
async function fetchFileLocal(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') {
    const r = await fetch(input);
    if (!r.ok) throw new Error('fetch failed: ' + input);
    return new Uint8Array(await r.arrayBuffer());
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(await input.arrayBuffer()); // File / Blob
}

async function loadFFmpegLib() {
  if (FFmpegCtor) return;
  let lastErr = null;
  for (const url of LIB_URLS) {
    try {
      const mod = await import(/* @vite-ignore */url);
      FFmpegCtor = mod.FFmpeg;
      if (FFmpegCtor) return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('ffmpeg-lib-load-failed');
}

function init() {
  const tool = $('tool');
  if (!tool) return;
  targetMB = parseFloat(tool.dataset.preset || '20') || 20;

  const dropzone = $('dropzone');
  const fileInput = $('fileInput');

  dropzone.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    fileInput.click();
  });
  $('browseBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); })
  );
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  $('removeFile').addEventListener('click', resetTool);
  $('againBtn').addEventListener('click', resetTool);

  // Preset chips
  const chips = Array.from(document.querySelectorAll('#chips .chip'));
  chips.forEach((chip) => {
    if (chip.dataset.target) {
      const t = parseFloat(chip.dataset.target);
      if (t === targetMB) chip.classList.add('active');
      chip.addEventListener('click', () => {
        chips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        $('customRow').hidden = true;
        targetMB = t;
        updateEstimate();
      });
    } else {
      chip.addEventListener('click', () => {
        chips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        $('customRow').hidden = false;
        $('customMB').focus();
        readCustom();
      });
    }
  });
  $('customMB').addEventListener('input', readCustom);

  $('compressBtn').addEventListener('click', compress);
}

function readCustom() {
  const v = parseFloat($('customMB').value);
  if (v > 0 && v <= 2000) {
    targetMB = v;
    updateEstimate();
  }
}

function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function handleFile(f) {
  hideError();
  if (!f.type || !f.type.startsWith('video/')) {
    // Some browsers leave .mkv/.mov type empty — allow by extension fallback
    const ok = /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name || '');
    if (!ok) { showError('That doesn\'t look like a video file. Please choose an MP4, MOV, WebM or similar video.'); return; }
  }
  if (f.size > MAX_FILE_BYTES) {
    showError('This file is over 1 GB — browsers usually run out of memory encoding files this large. Please trim it under 1 GB first (even a phone\'s built-in editor works), then try again.');
    return;
  }
  if (objectURL) URL.revokeObjectURL(objectURL);
  file = f;
  objectURL = URL.createObjectURL(f);

  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.muted = true;
  probe.onloadedmetadata = () => {
    durationSec = probe.duration || 0;
    vidWidth = probe.videoWidth || 0;
    vidHeight = probe.videoHeight || 0;
    URL.revokeObjectURL(probe.src);
    if (!durationSec || !isFinite(durationSec)) {
      showError('Couldn\'t read this video\'s duration. It may use an unsupported codec — try exporting it as MP4 (H.264) first.');
      resetTool();
      return;
    }
    $('fileName').textContent = f.name;
    $('metaDuration').textContent = fmtTime(durationSec);
    $('metaDims').textContent = vidWidth && vidHeight ? vidWidth + '×' + vidHeight : '—';
    $('metaSize').textContent = fmtMB(f.size);
    $('dropzone').hidden = true;
    $('fileInfo').hidden = false;
    $('compressBtn').disabled = false;
    updateEstimate();
    // Warm up the encoder in the background so Compress feels instant
    ensureFFmpeg().catch(() => { /* errors surface when Compress is clicked */ });
  };
  probe.onerror = () => {
    showError('Couldn\'t read this video file. Try exporting it as MP4 (H.264) first.');
    resetTool();
  };
  probe.src = objectURL;
}

// Comfortable H.264 bitrates (bps) per output height at ~30fps.
// When the size budget can't sustain the source resolution we step down the
// ladder — a sharp 480p beats a starved, blocky 720p every time. This is what
// real compressors do; a fixed bitrate floor just produces identical failed
// passes (the old MIN_VIDEO_BITRATE clamp bug).
const LADDER = [1080, 720, 480, 360];
const COMFORT_BR = { 1080: 5000000, 720: 2200000, 480: 1000000, 360: 550000 };

function computePlan() {
  const targetBytes = Math.floor(targetMB * 1024 * 1024);
  const totalBits = targetBytes * 8;
  const budgetBits = totalBits * SAFETY_MARGIN;

  // Audio ladder: on tight budgets (long videos) 128k audio eats the whole
  // budget, so step it down — dialogue stays intelligible at 64k.
  const roughVideoBr = (budgetBits - AUDIO_BITRATE * durationSec) / durationSec;
  const audioBr = roughVideoBr < 700000 ? 64000
    : roughVideoBr < 1500000 ? 96000 : AUDIO_BITRATE;

  let videoBr = Math.floor((budgetBits - audioBr * durationSec) / durationSec);

  // Resolution ladder: tallest height whose comfortable bitrate fits the budget.
  const srcH = vidHeight || 720;
  const heights = LADDER.filter(h => h <= srcH);
  if (!heights.length) heights.push(srcH);
  let outH = heights[heights.length - 1];
  for (const h of heights) {
    if (COMFORT_BR[h] <= videoBr) { outH = h; break; }
  }

  // Fail fast: even at rock bottom (80k video + 64k audio) this clip can't
  // fit — tell the user honestly instead of burning minutes on doomed passes.
  const minTotalBr = ABS_MIN_VIDEO_BR + ABS_MIN_AUDIO_BR;
  const minBytes = Math.ceil(minTotalBr * durationSec / 8);
  if (minBytes > targetBytes) {
    return {
      targetBytes, videoBr: 0, audioBr, outH,
      impossible: true,
      minMB: (minBytes / 1048576).toFixed(1),
    };
  }

  videoBr = Math.max(ABS_MIN_VIDEO_BR, videoBr);
  return { targetBytes, videoBr, audioBr, outH, impossible: false };
}

function updateEstimate() {
  if (!file || !durationSec) return;
  const plan = computePlan();
  $('estOrig').textContent = fmtMB(file.size);
  const alreadyUnder = file.size <= plan.targetBytes;
  if (plan.impossible) {
    $('estOut').textContent = '—';
    $('estPlan').textContent = '';
  } else if (alreadyUnder) {
    $('estOut').textContent = fmtMB(file.size);
    $('estPlan').textContent = 'already under target — no re-encode needed';
  } else {
    $('estOut').textContent = '≈ ' + (targetMB * SAFETY_MARGIN).toFixed(1) + ' MB';
    $('estPlan').textContent = plan.outH + 'p · ' + (plan.videoBr / 1e6).toFixed(1) +
      ' Mbps video + ' + Math.round(plan.audioBr / 1000) + 'k audio';
  }
  $('estimate').hidden = false;
  const warn = $('qualityWarn');
  const srcH = vidHeight || plan.outH;
  if (plan.impossible) {
    warn.hidden = false;
    warn.textContent = `⚠️ Even at minimum quality this clip needs ≈ ${plan.minMB} MB — it can't fit in ${targetMB} MB. Try a larger target or trim it shorter.`;
  } else if (alreadyUnder) {
    warn.hidden = true;
  } else if (plan.outH < srcH || plan.videoBr < WARN_BITRATE) {
    warn.hidden = false;
    const nextUp = nextPresetAbove(targetMB);
    warn.hidden = false;
    warn.textContent = `⚠️ To hit ${targetMB} MB we'll output ${plan.outH}p — expect softer detail. ` +
      (nextUp ? `Try ${nextUp} MB for sharper quality.` : 'Try trimming the video shorter.');
  } else {
    warn.hidden = true;
  }
  // Large-file heads-up: in-browser encoding of several hundred MB is slow
  // and can exhaust memory on phones.
  $('bigFileNote').hidden = file.size <= 200 * 1024 * 1024;
}

function nextPresetAbove(t) {
  const presets = [16, 20, 25, 50, 500];
  for (const p of presets) if (p > t) return p;
  return null;
}

// Pages limits deployed files to 25 MiB, so the ~31 MiB wasm cores are stored
// as two parts and reassembled here into a Blob URL, which the FFmpeg worker
// can fetch like any normal URL.
async function assembleSelfHostedWasmURL(parts) {
  const bufs = await Promise.all(parts.map(async (p) => {
    const r = await fetch(p);
    if (!r.ok) throw new Error('wasm-part-missing: ' + p);
    return r.arrayBuffer();
  }));
  return URL.createObjectURL(new Blob(bufs, { type: 'application/wasm' }));
}

function ensureFFmpeg() {
  if (ffmpeg) return Promise.resolve(ffmpeg);
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    await loadFFmpegLib();
    let lastErr = null;
    // 1) self-hosted MULTI-THREADED core (needs crossOriginIsolated) —
    //    typically several times faster than single-threaded.
    if (MT_OK) {
      let blobURL = null;
      try {
        const inst = new FFmpegCtor();
        inst.on('log', () => {});
        blobURL = await assembleSelfHostedWasmURL(WASM_PARTS_MT);
        await inst.load({
          coreURL: '/vendor/ffmpeg-core-mt.js',
          wasmURL: blobURL,
          // workerURL defaults to /vendor/ffmpeg-core-mt.worker.js
          // (derived from coreURL by the wrapper) — the pthread bootstrap.
        });
        ffmpeg = inst;
        window.__vidsizerCoreSource = 'self-hosted-mt';
        window.__vidsizerThreads = 'mt';
        return inst;
      } catch (e) {
        lastErr = e;
        if (blobURL) URL.revokeObjectURL(blobURL);
      }
    }
    // 2) self-hosted single-threaded core — no CDN dependency
    let blobURL = null;
    try {
      const inst = new FFmpegCtor();
      inst.on('log', () => {});
      blobURL = await assembleSelfHostedWasmURL(WASM_PARTS);
      await inst.load({
        coreURL: '/vendor/ffmpeg-core.js',
        wasmURL: blobURL,
      });
      ffmpeg = inst;
      window.__vidsizerCoreSource = 'self-hosted-st';
      window.__vidsizerThreads = 'st';
      return inst;
    } catch (e) {
      lastErr = e;
      if (blobURL) URL.revokeObjectURL(blobURL);
    }
    // 3) CDN fallbacks (full single-file core)
    for (const base of CORE_BASES) {
      try {
        const inst = new FFmpegCtor();
        inst.on('log', () => {});
        await inst.load({
          coreURL: base + '/ffmpeg-core.js',
          wasmURL: base + '/ffmpeg-core.wasm',
        });
        ffmpeg = inst;
        window.__vidsizerCoreSource = 'cdn';
        window.__vidsizerThreads = 'st';
        return inst;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('ffmpeg-core-load-failed');
  })();
  return ffmpegLoading;
}

function buildArgs(inName, outName, plan) {
  const videoBrK = Math.max(80, Math.round(plan.videoBr / 1000));
  const args = ['-y', '-i', inName, '-c:v', 'libx264',
    '-b:v', videoBrK + 'k',
    '-maxrate', Math.round(videoBrK * 1.5) + 'k',
    '-bufsize', Math.round(videoBrK * 2) + 'k'];
  const srcH = vidHeight || plan.outH;
  if (plan.outH < srcH) args.push('-vf', 'scale=-2:' + plan.outH);
  args.push('-preset', 'veryfast', '-c:a', 'aac', '-b:a', Math.round(plan.audioBr / 1000) + 'k',
    '-movflags', '+faststart', outName);
  return args;
}

async function compress() {
  if (busy || !file) return;
  busy = true;
  hideError();
  $('result').hidden = true;
  $('compressBtn').disabled = true;
  $('progressWrap').hidden = false;
  setProgress(2, 'Loading encoder… (first run downloads ~30 MB, then it\'s cached)');

  try {
    const plan = computePlan();

    // Fail fast on impossible targets — before downloading the encoder.
    if (plan.impossible) {
      showError(`This video can't fit in ${targetMB} MB — even at minimum quality it needs ≈ ${plan.minMB} MB. ` +
        'Try a larger target size or trim the video shorter.');
      $('compressBtn').disabled = false;
      return;
    }

    // Already under target: no re-encode, no quality loss, instant.
    if (file.size <= plan.targetBytes) {
      const dl = $('downloadBtn');
      dl.href = objectURL;
      dl.download = file.name || 'video.mp4';
      $('resOrig').textContent = fmtMB(file.size);
      $('resOut').textContent = fmtMB(file.size) + ' (no re-encode needed)';
      $('resTarget').textContent = targetMB;
      $('progressWrap').hidden = true;
      $('result').hidden = false;
      $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const inst = await ensureFFmpeg();
    const ext = (file.name && file.name.includes('.'))
      ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      : '.mp4';
    const inName = 'input' + (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(ext) ? ext : '.mp4');
    const outName = 'output.mp4';

    await inst.writeFile(inName, await fetchFileLocal(file));

    inst.off('progress');
    inst.on('progress', ({ time }) => {
      if (durationSec > 0) {
        const pct = Math.min(99, Math.round(((time || 0) / 1e6 / durationSec) * 100));
        setProgress(pct, 'Compressing…');
      }
    });

    let videoBr = plan.videoBr;
    let outData = null;
    let attempt;
    for (attempt = 1; attempt <= 2; attempt++) {
      $('attemptText').textContent = 'Pass ' + attempt + ' of up to 2 — targeting under ' + targetMB + ' MB';
      setProgress(3, 'Compressing…');
      await inst.exec(buildArgs(inName, outName, { ...plan, videoBr }));
      outData = await inst.readFile(outName);
      if (outData.length <= plan.targetBytes) break;
      // Overshot: scale bitrate down proportionally with a safety factor and retry once
      videoBr = Math.max(ABS_MIN_VIDEO_BR,
        Math.floor(videoBr * (plan.targetBytes / outData.length) * 0.97));
    }

    await inst.deleteFile(inName).catch(() => {});
    await inst.deleteFile(outName).catch(() => {});

    if (!outData || outData.length === 0) throw new Error('encode-failed');
    if (outData.length > plan.targetBytes) {
      showError('We couldn\'t get this clip under ' + targetMB + ' MB after 2 passes. Try a larger target size or trim the video shorter.');
      return;
    }

    // Money shot
    const blob = new Blob([outData], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const dl = $('downloadBtn');
    const base = (file.name || 'video').replace(/\.[^.]+$/, '') || 'video';
    dl.href = url;
    dl.download = base + '-' + targetMB + 'mb.mp4';
    $('resOrig').textContent = fmtMB(file.size);
    $('resOut').textContent = fmtMB(outData.length);
    $('resTarget').textContent = targetMB;
    $('progressWrap').hidden = true;
    $('result').hidden = false;
    $('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    const msg = String((err && err.message) || err || '');
    if (/memory|allocation|abort/i.test(msg)) {
      showError('The browser ran out of memory encoding this video. Try a shorter clip, a lower target size, or a desktop browser with more RAM.');
    } else if (/load|fetch|network|failed/i.test(msg)) {
      showError('Couldn\'t load the video encoder. Check your connection and click Compress again — the encoder is cached after the first load.' +
        (msg ? ' (detail: ' + msg.slice(0, 160) + ')' : ''));
    } else {
      showError('Encoding failed on this file. It may use an unusual codec — try exporting it as MP4 (H.264) first, then compress again.');
    }
    $('compressBtn').disabled = false;
  } finally {
    $('progressWrap').hidden = true;
    busy = false;
  }
}

function setProgress(pct, text) {
  $('progressBar').style.width = pct + '%';
  $('progressText').textContent = text + (pct > 3 ? ' ' + pct + '%' : '');
}

function showError(msg) {
  const box = $('errorBox');
  box.textContent = msg;
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideError() { $('errorBox').hidden = true; }

function resetTool() {
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  file = null;
  durationSec = 0; vidWidth = 0; vidHeight = 0;
  $('fileInput').value = '';
  $('fileInfo').hidden = true;
  $('dropzone').hidden = false;
  $('estimate').hidden = true;
  $('result').hidden = true;
  $('progressWrap').hidden = true;
  hideError();
  $('compressBtn').disabled = true;
  $('compressBtn').textContent = 'Compress';
}

document.addEventListener('DOMContentLoaded', init);
