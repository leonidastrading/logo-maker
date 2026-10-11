// Rendering core shared by the page and the background render worker.
// A "scene" is plain data: {pts: [x0, y0, x1, y1, …], radii: [...],
// edges: [a0, b0, a1, b1, …], line, goo, invert}, in the 1000-unit design space.
'use strict';

const DESIGN = 1000;

function drawScene(ctx, scene, color) {
  const { pts, radii, edges } = scene;
  ctx.fillStyle = ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = scene.line;
  ctx.beginPath();
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e] * 2, b = edges[e + 1] * 2;
    ctx.moveTo(pts[a], pts[a + 1]);
    ctx.lineTo(pts[b], pts[b + 1]);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < radii.length; i++) {
    const x = pts[2 * i], y = pts[2 * i + 1], r = radii[i];
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function boxBlurH(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= r && x < w; x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * inv;
      const add = x + r + 1, sub = x - r;
      if (add < w) sum += src[row + add];
      if (sub >= 0) sum -= src[row + sub];
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  const sum = new Float32Array(w);
  for (let y = 0; y <= r && y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) sum[x] += src[row + x];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w, add = y + r + 1, sub = y - r;
    for (let x = 0; x < w; x++) dst[row + x] = sum[x] * inv;
    if (add < h) { const ar = add * w; for (let x = 0; x < w; x++) sum[x] += src[ar + x]; }
    if (sub >= 0) { const sr = sub * w; for (let x = 0; x < w; x++) sum[x] -= src[sr + x]; }
  }
}

// Renders the region [x0, x0+w) × [y0, y0+h) of a size×size image and returns
// the (blurred) coverage field, 0..255. Blur + threshold is what melts the
// joints between dots and connections into smooth, organic fillets.
function renderField(scene, size, x0, y0, w, h) {
  const scale = size / DESIGN;
  const r = Math.round(scene.goo * scale);
  const m = r > 0 ? r * 3 + 2 : 0;
  const tw = w + 2 * m, th = h + 2 * m;
  const c = makeCanvas(tw, th);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(scale, 0, 0, scale, m - x0, m - y0);
  drawScene(ctx, scene, '#000');
  const data = ctx.getImageData(0, 0, tw, th).data;
  let a = new Float32Array(tw * th);
  for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3];
  c.width = c.height = 0;
  if (r >= 1) {
    let b = new Float32Array(tw * th);
    for (let pass = 0; pass < 3; pass++) {
      boxBlurH(a, b, tw, th, r);
      boxBlurV(b, a, tw, th, r);
    }
    b = null;
  }
  const field = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y + m) * tw + m;
    field.set(a.subarray(src, src + w), y * w);
  }
  return { field, r };
}

function composite(field, w, h, r, transparent, invert) {
  const img = new ImageData(w, h);
  const d = img.data;
  const fg = invert ? 255 : 0, bg = 255 - fg;
  const blurred = r >= 1;
  for (let y = 0, i = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++, p += 4) {
      let v = field[i];
      if (blurred) {
        // Threshold at 50% with a 1px antialiasing band: divide the distance
        // from the threshold by the local gradient to get distance in pixels.
        const gx = (field[x < w - 1 ? i + 1 : i] - field[x > 0 ? i - 1 : i]) * 0.5;
        const gy = (field[y < h - 1 ? i + w : i] - field[y > 0 ? i - w : i]) * 0.5;
        const g = Math.sqrt(gx * gx + gy * gy);
        v = 127.5 + (v - 127.5) * 255 / Math.max(g, 0.5);
      }
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      if (transparent) {
        d[p] = d[p + 1] = d[p + 2] = fg; d[p + 3] = v;
      } else {
        d[p] = d[p + 1] = d[p + 2] = bg + (fg - bg) * v / 255; d[p + 3] = 255;
      }
    }
  }
  return img;
}

