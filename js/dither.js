// 1-bit dithering algorithms. Each takes a Float32Array of luminance values
// (0-255), width, height, and returns a Uint8Array of the same length
// containing only 0 or 255.

function addErr(buf, w, h, x, y, amount) {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  buf[y * w + x] += amount;
}

function ditherFloydSteinberg(gray, w, h) {
  const buf = Float32Array.from(gray);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const nv = old < 128 ? 0 : 255;
      out[i] = nv;
      const err = old - nv;
      addErr(buf, w, h, x + 1, y, err * (7 / 16));
      addErr(buf, w, h, x - 1, y + 1, err * (3 / 16));
      addErr(buf, w, h, x, y + 1, err * (5 / 16));
      addErr(buf, w, h, x + 1, y + 1, err * (1 / 16));
    }
  }
  return out;
}

function ditherAtkinson(gray, w, h) {
  const buf = Float32Array.from(gray);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const nv = old < 128 ? 0 : 255;
      out[i] = nv;
      const err = (old - nv) / 8;
      addErr(buf, w, h, x + 1, y, err);
      addErr(buf, w, h, x + 2, y, err);
      addErr(buf, w, h, x - 1, y + 1, err);
      addErr(buf, w, h, x, y + 1, err);
      addErr(buf, w, h, x + 1, y + 1, err);
      addErr(buf, w, h, x, y + 2, err);
    }
  }
  return out;
}

const STUCKI_KERNEL = [
  [1, 0, 8], [2, 0, 4],
  [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
  [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
];

function ditherStucki(gray, w, h) {
  const buf = Float32Array.from(gray);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = buf[i];
      const nv = old < 128 ? 0 : 255;
      out[i] = nv;
      const err = (old - nv) / 42;
      for (const [dx, dy, weight] of STUCKI_KERNEL) {
        addErr(buf, w, h, x + dx, y + dy, err * weight);
      }
    }
  }
  return out;
}

const BAYER8_RAW = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21],
];
const BAYER8 = BAYER8_RAW.map((row) => row.map((v) => ((v + 0.5) / 64) * 255));

function ditherBayer(gray, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = BAYER8[y % 8];
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = gray[i] > row[x % 8] ? 255 : 0;
    }
  }
  return out;
}

function ditherThreshold(gray, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = gray[i] >= 128 ? 255 : 0;
  return out;
}

const DITHER_ALGORITHMS = {
  "floyd-steinberg": { label: "Floyd–Steinberg", fn: ditherFloydSteinberg },
  atkinson: { label: "Atkinson", fn: ditherAtkinson },
  stucki: { label: "Stucki", fn: ditherStucki },
  bayer: { label: "Ordered (Bayer)", fn: ditherBayer },
  threshold: { label: "Threshold (no dither)", fn: ditherThreshold },
};
