/**
 * Pure skip / bitrate policy — no Mediabunny / WebCodecs dependency (Node-testable).
 */

/** Squash quality buttons → Mediabunny quality level. */
export const QUALITY_LEVELS = Object.freeze({
  tiny: 'very-low',
  web: 'low',
  social: 'medium',
  high: 'high',
  max: 'very-high'
});

/** Mediabunny qualitative quality → 0..1 (must match vendor QUALITY_LEVELS). */
const QUALITY_NUMERIC = Object.freeze({
  'very-low': 0,
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  'very-high': 1
});

/**
 * Same curve as Mediabunny computeVideoBitrate for AVC — used to predict whether
 * a quality preset would target a *higher* bitrate than the source (growth risk).
 */
export function estimateTargetVideoBitrate(width, height, qualityKey) {
  const level = QUALITY_LEVELS[qualityKey] || qualityKey;
  const q = QUALITY_NUMERIC[level];
  if (q == null || !width || !height) return null;
  const factor = 0.3 * Math.exp(2.5538 * q);
  const pixels = width * height;
  const scale = Math.pow(pixels / (1920 * 1080), 0.95);
  return Math.ceil((3_000_000 * scale * factor) / 1000) * 1000;
}

/**
 * Decide whether re-encoding is likely useless or harmful.
 * Only skips when we are NOT downscaling: downscales (e.g. 1080→720) often still win.
 */
export function assessAlreadyCompressed({
  inW,
  inH,
  outW,
  outH,
  inFps,
  outFps,
  duration,
  fileSize,
  sourceVideoBitrate,
  codec,
  quality,
  skipAlreadyCompressed
}) {
  if (!skipAlreadyCompressed) return { skip: false };
  if (!duration || duration <= 0 || !fileSize) return { skip: false };

  const downscaling = outW < inW * 0.92 || outH < inH * 0.92;
  const fpsDrop = !!(inFps && outFps && outFps < inFps * 0.9);

  // Prefer measured video bitrate; fall back to container bitrate minus ~128k audio.
  let srcBr = sourceVideoBitrate;
  if (!(srcBr > 0)) {
    srcBr = Math.max(0, (fileSize * 8) / duration - 128000);
  }
  const containerBr = (fileSize * 8) / duration;
  // bpp against *source* pixels — measures how hard the file is already compressed.
  const bpp = srcBr / (inW * inH * (inFps || outFps || 30));
  const avcOk = !codec || codec === 'avc' || codec === 'avc1' || codec === 'h264';
  const mbPerMin = fileSize / 1048576 / (duration / 60);

  // Ultra-efficient AVC (TikTok / music / downloads): skip even if a time-budget
  // plan wants to smash resolution — that "save" is mostly quality loss, not real squash.
  if (
    avcOk &&
    bpp > 0 &&
    bpp <= 0.03 &&
    srcBr > 0 &&
    srcBr <= 500000 &&
    containerBr <= 700000 &&
    mbPerMin <= 4
  ) {
    return {
      skip: true,
      reason: 'tiktok-like-efficiency',
      srcBr: Math.round(srcBr),
      targetBr: estimateTargetVideoBitrate(inW, inH, quality),
      bpp: +bpp.toFixed(4),
      mbPerMin: +mbPerMin.toFixed(2),
      codec: codec || null
    };
  }

  if (downscaling || fpsDrop) {
    return { skip: false, reason: 'will-downscale', downscaling, fpsDrop, bpp: +bpp.toFixed(4) };
  }

  const targetBr = estimateTargetVideoBitrate(outW || inW, outH || inH, quality);
  if (!targetBr) return { skip: false };

  // Growth guard: source already at/under the encoder's bitrate floor for this size+quality.
  if (srcBr > 0 && srcBr <= targetBr * 1.05) {
    return {
      skip: true,
      reason: 'already-leaner-than-target',
      srcBr: Math.round(srcBr),
      targetBr,
      bpp: +bpp.toFixed(4),
      codec: codec || null
    };
  }

  return {
    skip: false,
    reason: 'worth-encoding',
    srcBr: srcBr > 0 ? Math.round(srcBr) : null,
    targetBr,
    bpp: bpp > 0 ? +bpp.toFixed(4) : null
  };
}
