// Grayscale conversion, high-quality (Lanczos) resizing, and tonal adjustments.
// All functions operate on plain Float32Array buffers of luminance values (0-255).

const PRESETS = {
  custom:    { label: "Custom",          brightness: 0,  contrast: 20, gamma: 1.0,  blackPoint: 0,  whitePoint: 255 },
  portrait:  { label: "Portrait / Face", brightness: 10, contrast: 30, gamma: 1.1,  blackPoint: 10, whitePoint: 245 },
  logo:      { label: "Logo / Line Art", brightness: 0,  contrast: 60, gamma: 1.0,  blackPoint: 40, whitePoint: 215 },
  landscape: { label: "Landscape",       brightness: 0,  contrast: 15, gamma: 0.95, blackPoint: 5,  whitePoint: 250 },
};

function toGrayscale(imageData) {
  const { data, width, height } = imageData;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return out;
}

function lanczosKernel(x, a) {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

function clampIndex(i, len) {
  return Math.min(len - 1, Math.max(0, i));
}

// Single-axis resample of a flat W*H buffer. `horizontal` resamples width
// (srcW -> dstW, height unchanged); otherwise resamples height.
function resamplePass(src, srcW, srcH, dstW, dstH, horizontal, a) {
  const out = new Float32Array(dstW * dstH);
  const inLen = horizontal ? srcW : srcH;
  const outLen = horizontal ? dstW : dstH;
  const scale = outLen / inLen;
  const filterScale = Math.max(1, 1 / scale);
  const support = a * filterScale;

  const weightsByOut = new Array(outLen);
  for (let o = 0; o < outLen; o++) {
    const center = (o + 0.5) / scale - 0.5;
    const left = Math.ceil(center - support);
    const right = Math.floor(center + support);
    const entries = [];
    let sum = 0;
    for (let s = left; s <= right; s++) {
      const w = lanczosKernel((s - center) / filterScale, a);
      if (w !== 0) {
        entries.push(clampIndex(s, inLen), w);
        sum += w;
      }
    }
    if (sum !== 0) {
      for (let k = 1; k < entries.length; k += 2) entries[k] /= sum;
    }
    weightsByOut[o] = entries;
  }

  if (horizontal) {
    for (let y = 0; y < srcH; y++) {
      const rowOff = y * srcW;
      const outRowOff = y * dstW;
      for (let x = 0; x < dstW; x++) {
        const entries = weightsByOut[x];
        let sum = 0;
        for (let k = 0; k < entries.length; k += 2) {
          sum += src[rowOff + entries[k]] * entries[k + 1];
        }
        out[outRowOff + x] = sum;
      }
    }
  } else {
    for (let x = 0; x < dstW; x++) {
      for (let y = 0; y < dstH; y++) {
        const entries = weightsByOut[y];
        let sum = 0;
        for (let k = 0; k < entries.length; k += 2) {
          sum += src[entries[k] * dstW + x] * entries[k + 1];
        }
        out[y * dstW + x] = sum;
      }
    }
  }
  return out;
}

function resizeLanczosGray(src, srcW, srcH, dstW, dstH, a = 3) {
  const horizontally = resamplePass(src, srcW, srcH, dstW, srcH, true, a);
  return resamplePass(horizontally, dstW, srcH, dstW, dstH, false, a);
}

// levels (black/white point) -> gamma -> brightness -> contrast -> optional invert
function applyAdjustments(gray, adj) {
  const bp = Math.min(adj.blackPoint, adj.whitePoint - 1);
  const wp = Math.max(adj.whitePoint, bp + 1);
  const range = wp - bp;
  const contrastAmount = adj.contrast * 2.55; // slider -100..100 -> -255..255
  const contrastFactor = (259 * (contrastAmount + 255)) / (255 * (259 - contrastAmount));
  const invGamma = 1 / adj.gamma;

  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    let v = gray[i];
    v = ((v - bp) / range) * 255;
    v = Math.min(255, Math.max(0, v));
    v = 255 * Math.pow(v / 255, invGamma);
    v += adj.brightness;
    v = contrastFactor * (v - 128) + 128;
    v = Math.min(255, Math.max(0, v));
    if (adj.invert) v = 255 - v;
    out[i] = v;
  }
  return out;
}
