/**
 * SOS Squash core — browser video compression via WebCodecs (Mediabunny).
 * Same engine as Squash (ishanjalan/Squash); presets tuned by qa/run-bench.mjs.
 */
import {
  Input,
  Output,
  Conversion,
  BlobSource,
  BufferTarget,
  Mp4OutputFormat,
  ALL_FORMATS,
  Quality,
  canEncodeVideo,
  canEncodeAudio
} from 'mediabunny';
import {
  QUALITY_LEVELS,
  estimateTargetVideoBitrate,
  assessAlreadyCompressed
} from './squash-policy.js';

export { QUALITY_LEVELS, estimateTargetVideoBitrate, assessAlreadyCompressed };

/** Short side caps (works for portrait and landscape). */
export const RESOLUTIONS = Object.freeze({
  original: 0,
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
  '360p': 360
});

/** Exact replica of Squash's default "Web" screen (MP4, Original, AAC 128k, Balanced). */
export const SQUASH_WEB_DEFAULTS = Object.freeze({
  quality: 'web',
  resolution: 'original',
  audio: 'aac',
  audioBitrate: 128000,
  keyFrameInterval: 2,
  hardwareAcceleration: 'prefer-hardware',
  keepOriginalIfLarger: false,
  skipAlreadyCompressed: false,
  maxFps: 0,
  timeBudgetSec: 0
});

/**
 * App default (qa/run-bench.mjs "fast-720-b80"): 720p short side, ≤30fps, smart audio
 * (copy AAC ≤160k, else AAC 128k), keyframe 5s, on-device speed plan to finish in ~80s.
 */
export const SOS_FAST_DEFAULTS = Object.freeze({
  quality: 'web',
  resolution: '720p',
  audio: 'auto',
  audioBitrate: 128000,
  keyFrameInterval: 5,
  hardwareAcceleration: 'prefer-hardware',
  keepOriginalIfLarger: true,
  /** Skip re-encode when source is already leaner than the WebCodecs quality target (TikTok-like). */
  skipAlreadyCompressed: true,
  maxFps: 30,
  timeBudgetSec: 80
});

export function isSupported() {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoDecoder !== 'undefined' &&
    typeof AudioDecoder !== 'undefined'
  );
}

export async function probeCapabilities() {
  if (!isSupported()) return { supported: false, avc: false, aac: false };
  const [avc, aac] = await Promise.all([
    canEncodeVideo('avc', { width: 1280, height: 720 }).catch(() => false),
    canEncodeAudio('aac', { sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }).catch(
      () => false
    )
  ]);
  return { supported: !!avc, avc: !!avc, aac: !!aac };
}

function even(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

/** Fit so the short side is <= cap; never upscale. */
export function targetSize(width, height, cap) {
  if (!cap || !width || !height) return null;
  const short = Math.min(width, height);
  if (short <= cap) return null;
  const k = cap / short;
  return { width: even(width * k), height: even(height * k) };
}

/** Relative encode cost per frame (ms) vs pixel count, fitted on qa/run-bench.mjs results. */
function frameCost(width, height) {
  return 7.5 + (6.5 * width * height) / 1e6;
}

/** Real encoder throughput (frames/s) on this device at the given size; null if unknown. */
export async function measureEncodeFps(width, height, hardwareAcceleration) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const total = 45;
  const warm = 10;
  let out = 0;
  let tWarm = 0;
  let tEnd = 0;
  let failed = false;
  const enc = new VideoEncoder({
    output: () => {
      out++;
      tEnd = performance.now();
      if (out === warm) tWarm = tEnd;
    },
    error: () => {
      failed = true;
    }
  });
  try {
    enc.configure({
      codec: width * height > 2073600 ? 'avc1.640033' : 'avc1.640028',
      width,
      height,
      bitrate: 2000000,
      framerate: 30,
      hardwareAcceleration,
      avc: { format: 'avc' }
    });
    for (let i = 0; i < total && !failed; i++) {
      ctx.fillStyle = 'hsl(' + ((i * 8) % 360) + ',60%,50%)';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff';
      ctx.fillRect((i * 37) % width, (i * 23) % height, width >> 2, height >> 2);
      const frame = new VideoFrame(canvas, { timestamp: i * 33333 });
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
      enc.encode(frame, { keyFrame: i === 0 });
      frame.close();
    }
    await enc.flush();
  } catch {
    failed = true;
  } finally {
    if (enc.state !== 'closed') enc.close();
  }
  if (failed || out <= warm || tEnd <= tWarm) return null;
  return (out - warm) / ((tEnd - tWarm) / 1000);
}

/**
 * Pick the highest-quality (size, fps) whose predicted encode time fits the budget,
 * measured on the actual device. Lowers fps before resolution.
 */
async function planForBudget({ inW, inH, inFps, duration, size, fpsCap, budgetSec, hardwareAcceleration }) {
  const base = size || { width: inW, height: inH };
  const baseFps = fpsCap ? Math.min(inFps, fpsCap) : inFps;
  const measuredFps = await measureEncodeFps(even(base.width), even(base.height), hardwareAcceleration).catch(
    () => null
  );
  if (!measuredFps) return { size, fpsCap, measuredFps: null, estSec: null, adapted: false };
  const baseShort = Math.min(base.width, base.height);
  // Full decode→resize→encode→mux runs at ~0.45x the raw encoder probe rate (bench-calibrated).
  const estimate = (sz, fps) =>
    2.2 * ((duration * fps) / measuredFps) * (frameCost(sz.width, sz.height) / frameCost(base.width, base.height)) +
    (duration * inFps) / 800;
  const ladder = [[0, baseFps], [0, 30], [0, 24], [720, 30], [720, 24], [540, 24], [480, 24], [480, 20], [360, 20], [360, 15]];
  let pick = null;
  const seen = new Set();
  for (const [cap, f] of ladder) {
    const fps = Math.min(f, baseFps);
    const sz = cap && cap < baseShort ? targetSize(inW, inH, cap) : size;
    const key = (sz ? sz.width + 'x' + sz.height : 'orig') + '@' + fps.toFixed(1);
    if (seen.has(key)) continue;
    seen.add(key);
    pick = { size: sz, fps, estSec: estimate(sz || base, fps) };
    if (pick.estSec <= budgetSec) break;
  }
  return {
    size: pick.size,
    fpsCap: pick.fps < inFps * 0.9 ? pick.fps : fpsCap,
    measuredFps: Math.round(measuredFps),
    estSec: Math.round(pick.estSec),
    adapted: pick.size !== size || pick.fps < baseFps * 0.99
  };
}

/**
 * @param {File|Blob} file
 * @param {object} opts see SQUASH_WEB_DEFAULTS
 * @param {(p:{pct:number,stage:string})=>void} [onProgress]
 */
export async function squashVideo(file, opts, onProgress) {
  const o = Object.assign({}, SQUASH_WEB_DEFAULTS, opts || {});
  const t0 = performance.now();
  const report = (pct, stage) => onProgress && onProgress({ pct, stage });
  report(0, 'reading');

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error('אין ערוץ וידאו בקובץ');
  const aTrack = await input.getPrimaryAudioTrack();
  const inW = vTrack.displayWidth;
  const inH = vTrack.displayHeight;
  const duration = await input.computeDuration();

  let size = targetSize(inW, inH, RESOLUTIONS[o.resolution] || 0);
  const level = QUALITY_LEVELS[o.quality] || 'low';

  const video = {
    codec: 'avc',
    quality: new Quality(level),
    hardwareAcceleration: o.hardwareAcceleration,
    forceTranscode: true
  };
  if (o.keyFrameInterval) video.keyFrameInterval = o.keyFrameInterval;
  let inFps = null;
  let sourceVideoBitrate = null;
  if (o.maxFps || o.timeBudgetSec || o.skipAlreadyCompressed) {
    try {
      const vs = await vTrack.computePacketStats(300);
      inFps = vs && vs.averagePacketRate ? vs.averagePacketRate : null;
      sourceVideoBitrate = vs && vs.averageBitrate ? vs.averageBitrate : null;
    } catch {
      /* unknown fps / bitrate */
    }
  }
  let fpsCap = o.maxFps || 0;
  let budget = null;

  // Skip lean sources before the expensive on-device speed probe / encode.
  const wantSkip =
    o.skipAlreadyCompressed === true ||
    (o.skipAlreadyCompressed == null && o.keepOriginalIfLarger === true);
  const plannedOut = size || { width: inW, height: inH };
  const plannedFps = fpsCap && inFps && inFps > fpsCap * 1.1 ? fpsCap : inFps;
  const already = assessAlreadyCompressed({
    inW,
    inH,
    outW: plannedOut.width,
    outH: plannedOut.height,
    inFps,
    outFps: plannedFps,
    duration,
    fileSize: file.size,
    sourceVideoBitrate,
    codec: vTrack.codec,
    quality: o.quality,
    skipAlreadyCompressed: wantSkip
  });
  if (already.skip) {
    const ms = Math.round(performance.now() - t0);
    report(100, 'skipped');
    return {
      blob: file,
      encodedSize: file.size,
      keptOriginal: true,
      skipped: true,
      skipReason: already.reason,
      ms,
      info: {
        inWidth: inW,
        inHeight: inH,
        outWidth: inW,
        outHeight: inH,
        duration,
        inFps,
        outFps: inFps,
        budget: null,
        audioCopied: false,
        hasAudio: !!aTrack,
        already
      }
    };
  }

  if (o.timeBudgetSec && duration > 0) {
    report(0, 'planning');
    budget = await planForBudget({
      inW, inH, inFps: inFps || 30, duration, size, fpsCap,
      budgetSec: o.timeBudgetSec, hardwareAcceleration: o.hardwareAcceleration
    });
    size = budget.size;
    fpsCap = budget.fpsCap;
  }
  // Only ever lower the frame rate; a cap above the source would duplicate frames.
  const fpsCapped = !!(fpsCap && inFps && inFps > fpsCap * 1.1);
  if (fpsCapped) video.frameRate = fpsCap;
  if (size) {
    video.width = size.width;
    video.height = size.height;
    video.fit = 'contain';
  }

  let audioMode = o.audio;
  if (aTrack && audioMode === 'auto') {
    audioMode = 'aac';
    try {
      const codec = aTrack.codec;
      const stats = await aTrack.computePacketStats(400);
      const br = stats && stats.averageBitrate;
      if (codec === 'aac' && br && br <= (o.audioBitrate || 128000) * 1.25) audioMode = 'copy';
    } catch {
      /* keep aac */
    }
  }

  let audio;
  if (!aTrack || audioMode === 'none') {
    audio = { discard: true };
  } else if (audioMode === 'copy') {
    // Pass encoded packets through untouched: zero audio re-timing, zero quality loss.
    audio = {};
  } else {
    audio = {
      codec: 'aac',
      quality: new Quality({ bitrate: o.audioBitrate || 128000 }),
      forceTranscode: true
    };
  }

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target
  });

  const conversion = await Conversion.init({ input, output, video, audio, showWarnings: false });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks
      .map((d) => d.track.type + ':' + d.reason)
      .join(', ');
    throw new Error('הדפדפן לא יכול לקודד את הקובץ (' + why + ')');
  }
  conversion.onProgress = (p) => report(Math.round(p * 100), 'encoding');
  // Mediabunny's Conversion does not forward latencyMode to VideoEncoder.
  const proto = o.latencyMode && typeof VideoEncoder !== 'undefined' ? VideoEncoder.prototype : null;
  const origConfigure = proto && proto.configure;
  if (proto) {
    proto.configure = function (cfg) {
      return origConfigure.call(this, Object.assign({}, cfg, { latencyMode: o.latencyMode }));
    };
  }
  try {
    await conversion.execute();
  } finally {
    if (proto) proto.configure = origConfigure;
  }

  const out = new Blob([target.buffer], { type: 'video/mp4' });
  const ms = Math.round(performance.now() - t0);
  // Re-encoding an already-H.264 file for <10% gain only costs quality; other codecs still
  // benefit from the H.264 conversion (playback compatibility) unless the file actually grew.
  const minGain = vTrack.codec === 'avc' ? 0.9 : 1;
  const keptOriginal = !!(o.keepOriginalIfLarger && out.size >= file.size * minGain);
  report(100, 'done');
  return {
    blob: keptOriginal ? file : out,
    encodedSize: out.size,
    keptOriginal,
    skipped: false,
    skipReason: already.reason || null,
    ms,
    info: {
      inWidth: inW,
      inHeight: inH,
      outWidth: size ? size.width : inW,
      outHeight: size ? size.height : inH,
      duration,
      inFps,
      outFps: fpsCapped ? fpsCap : inFps,
      budget,
      audioCopied: !!aTrack && audioMode === 'copy',
      hasAudio: !!aTrack,
      already
    }
  };
}
