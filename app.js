/* VidSizer — shared browser-side video compression engine.
 * 100% client-side: @ffmpeg/ffmpeg (single-threaded core, no COOP/COEP headers needed).
 * No build step. Loaded as an ES module on every tool page.
 *
 * IMPORTANT: the FFmpeg wrapper library is loaded with a DYNAMIC import (not a
 * static top-level import) so that a blocked/slow CDN can never kill the whole
 * UI — buttons stay wired, and encoder-load failures surface as a clear message.
 * The heavy encoder core (~31 MB) is self-hosted in /vendor/ (local first),
 * with CDN fallbacks. */
const CORE_VERSION = '0.12.10';
const LIB_URLS = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${CORE_VERSION}/+esm`,
  `https://esm.sh/@ffmpeg/ffmpeg@${CORE_VERSION}`,
];
const CORE_BASES = [
  '/vendor', // self-hosted — no CDN dependency
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];
const AUDIO_BITRATE = 128000; // 128k AAC
const SAFETY_MARGIN = 0.96;   // keep output ~4% under target
const MIN_VIDEO_BITRATE = 250000;
const WARN_BITRATE = 400000;
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
let fetchFileFn = null;

async function loadFFmpegLib() {
  if (FFmpegCtor) return;
  let lastErr = null;
  for (const url of LIB_URLS) {
    try {
      const mod = await import(/* @vite-ignore */url);
      FFmpegCtor = mod.FFmpeg;
      fetchFileFn = mod.fetchFile;
      if (FFmpegCtor && fetchFileFn) return;
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

function computePlan() {
  const targetBytes = Math.floor(targetMB * 1024 * 1024);
  const totalBits = targetBytes * 8;
  const audioBits = AUDIO_BITRATE * durationSec;
  let videoBr = Math.floor((totalBits * SAFETY_MARGIN - audioBits) / durationSec);
  videoBr = Math.max(MIN_VIDEO_BITRATE, videoBr);
  return { targetBytes, videoBr };
}

function updateEstimate() {
  if (!file || !durationSec) return;
  const plan = computePlan();
  $('estOrig').textContent = fmtMB(file.size);
  $('estOut').textContent = '≈ ' + (targetMB * SAFETY_MARGIN).toFixed(1) + ' MB';
  $('estimate').hidden = false;
  const warn = $('qualityWarn');
  if (plan.videoBr < WARN_BITRATE) {
    const nextUp = nextPresetAbove(targetMB);
    warn.hidden = false;
    warn.textContent = `⚠️ This clip is long for a ${targetMB} MB target — expect visible quality loss. ` +
      (nextUp ? `Try ${nextUp} MB instead, or trim the video.` : 'Try trimming the video shorter.');
  } else {
    warn.hidden = true;
  }
}

function nextPresetAbove(t) {
  const presets = [16, 20, 25, 50, 500];
  for (const p of presets) if (p > t) return p;
  return null;
}

function ensureFFmpeg() {
  if (ffmpeg) return Promise.resolve(ffmpeg);
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    await loadFFmpegLib();
    const inst = new FFmpegCtor();
    inst.on('log', () => {});
    let lastErr = null;
    for (const base of CORE_BASES) {
      try {
        await inst.load({
          coreURL: base + '/ffmpeg-core.js',
          wasmURL: base + '/ffmpeg-core.wasm',
        });
        ffmpeg = inst;
        return inst;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('ffmpeg-core-load-failed');
  })();
  return ffmpegLoading;
}

function buildArgs(inName, outName, videoBrK) {
  const args = ['-y', '-i', inName, '-c:v', 'libx264',
    '-b:v', videoBrK + 'k',
    '-maxrate', Math.round(videoBrK * 1.5) + 'k',
    '-bufsize', Math.round(videoBrK * 2) + 'k'];
  if (vidHeight > 720) args.push('-vf', 'scale=-2:720');
  args.push('-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k',
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
    const inst = await ensureFFmpeg();
    const plan = computePlan();
    const ext = (file.name && file.name.includes('.'))
      ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
      : '.mp4';
    const inName = 'input' + (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(ext) ? ext : '.mp4');
    const outName = 'output.mp4';

    await inst.writeFile(inName, await fetchFileFn(file));

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
    for (attempt = 1; attempt <= 3; attempt++) {
      $('attemptText').textContent = 'Pass ' + attempt + ' of up to 3 — targeting under ' + targetMB + ' MB';
      setProgress(3, 'Compressing…');
      await inst.exec(buildArgs(inName, outName, Math.max(1, Math.round(videoBr / 1000))));
      outData = await inst.readFile(outName);
      if (outData.length <= plan.targetBytes) break;
      // Overshot: scale bitrate down proportionally with a safety factor and retry
      videoBr = Math.floor(videoBr * (plan.targetBytes / outData.length) * 0.97);
      videoBr = Math.max(MIN_VIDEO_BITRATE, videoBr);
    }

    await inst.deleteFile(inName).catch(() => {});
    await inst.deleteFile(outName).catch(() => {});

    if (!outData || outData.length === 0) throw new Error('encode-failed');
    if (outData.length > plan.targetBytes) {
      showError('We couldn\'t get this clip under ' + targetMB + ' MB after 3 passes without destroying quality. Try a larger target size or trim the video shorter.');
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
      showError('Couldn\'t load the video encoder (network issue?). Check your connection and click Compress again — the encoder is cached after the first load.');
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
