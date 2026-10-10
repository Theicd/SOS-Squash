/**
 * Offline checks for assessAlreadyCompressed (no browser).
 *   node qa/test-skip-logic.mjs
 */
import {
  assessAlreadyCompressed,
  estimateTargetVideoBitrate
} from '../squash-policy.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Web @ 784x576 ≈ target for v08-download5
const t08 = estimateTargetVideoBitrate(784, 576, 'web');
console.log('target web 784x576', t08, 'bps');
assert(t08 > 250000 && t08 < 600000, 'unexpected target for 784x576 web');

// v08-like: already leaner than target, no downscale → skip
const v08 = assessAlreadyCompressed({
  inW: 784, inH: 576, outW: 784, outH: 576,
  inFps: 30, outFps: 30, duration: 87, fileSize: 4769744,
  sourceVideoBitrate: 301554, codec: 'avc', quality: 'web',
  skipAlreadyCompressed: true
});
assert(v08.skip, 'v08 should skip: ' + JSON.stringify(v08));

// v06-like music: very low bitrate → skip even when budget wants 360p
const v06 = assessAlreadyCompressed({
  inW: 1280, inH: 720, outW: 640, outH: 360,
  inFps: 30, outFps: 15, duration: 194, fileSize: 6263271,
  sourceVideoBitrate: 126605, codec: 'avc', quality: 'web',
  skipAlreadyCompressed: true
});
assert(v06.skip && v06.reason === 'tiktok-like-efficiency', 'v06 should skip: ' + JSON.stringify(v06));

// v07 with 720p downscale from 1080p portrait → must encode
const v07 = assessAlreadyCompressed({
  inW: 1080, inH: 1920, outW: 720, outH: 1280,
  inFps: 30, outFps: 30, duration: 75, fileSize: 9153824,
  sourceVideoBitrate: 871343, codec: 'avc', quality: 'web',
  skipAlreadyCompressed: true
});
assert(!v07.skip, 'v07 downscale should encode: ' + JSON.stringify(v07));

// Fat 1080p camera clip → encode
const fat = assessAlreadyCompressed({
  inW: 1920, inH: 1080, outW: 1920, outH: 1080,
  inFps: 30, outFps: 30, duration: 8, fileSize: 19845426,
  sourceVideoBitrate: 19902005, codec: 'avc', quality: 'web',
  skipAlreadyCompressed: true
});
assert(!fat.skip, 'fat 1080p should encode: ' + JSON.stringify(fat));

// Growth case: Social quality on lean TikTok-like 1080p → skip (would balloon)
const social = assessAlreadyCompressed({
  inW: 1080, inH: 1920, outW: 1080, outH: 1920,
  inFps: 30, outFps: 30, duration: 30, fileSize: 5 * 1048576,
  sourceVideoBitrate: 1200000, codec: 'avc', quality: 'social',
  skipAlreadyCompressed: true
});
const socialTarget = estimateTargetVideoBitrate(1080, 1920, 'social');
console.log('social 1080x1920 target', socialTarget, 'skip', social.skip, social.reason);
assert(social.skip, 'social on lean TikTok should skip to avoid growth');

// Flag off → never skip
const off = assessAlreadyCompressed({
  inW: 784, inH: 576, outW: 784, outH: 576,
  inFps: 30, outFps: 30, duration: 87, fileSize: 4769744,
  sourceVideoBitrate: 301554, codec: 'avc', quality: 'web',
  skipAlreadyCompressed: false
});
assert(!off.skip, 'flag off must not skip');

console.log('OK — skip logic matches expected cases');
