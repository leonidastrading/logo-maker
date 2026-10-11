'use strict';

// All geometry lives in a 1000 × 1000 design space and is scaled on render.
const D = 1000;

const DEFAULTS = {
  seed: 7, linkSeed: 1,
  count: 34, spread: 400, spacing: 0.6, k: 1, extra: 4, tree: true,
  dot: 24, variation: 0.3, endBoost: 1.3, line: 13, goo: 4,
  invert: false,
  shape: 'circle', letter: 'A', font: 'sans', outline: 0.15, center: 0.7,
};
const NUMERIC = ['seed', 'linkSeed', 'count', 'spread', 'spacing', 'k', 'extra',
  'dot', 'variation', 'endBoost', 'line', 'goo', 'outline', 'center'];
const STRING = ['shape', 'letter', 'font'];
const BOOLEAN = ['tree', 'invert'];
const LAYOUT_KEYS = new Set(['seed', 'count', 'spread', 'spacing', 'shape', 'letter', 'font', 'outline', 'center']);
const LINK_KEYS = new Set(['k', 'extra', 'tree', 'linkSeed']);

const params = loadParams();
let nodes = [];   // {x, y, f} — f is this dot's random size factor in [-1, 1]
let edges = [];   // [i, j]
let degree = [];

// ---------- random ----------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- graph generation ----------

const FONTS = {
  sans: '900 {s}px "Helvetica Neue", Arial, sans-serif',
  serif: 'bold {s}px Georgia, "Times New Roman", serif',
  rounded: 'bold {s}px ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", sans-serif',
  mono: 'bold {s}px ui-monospace, Menlo, Consolas, monospace',
  script: 'italic bold {s}px "Snell Roundhand", "Brush Script MT", cursive',
};

// Letter mode: the glyph is rasterised into a mask with a distance-to-edge
// field, used to keep dots inside the strokes and links from leaving them.
const MN = 500, MS = D / MN; // mask resolution and design units per mask pixel
let mask = null;

function letterMode() {
  return params.shape === 'letter' && Array.from(params.letter).length > 0;
}

function buildMask() {
  if (!letterMode()) { mask = null; return; }
  const ch = Array.from(params.letter)[0];
  const c = document.createElement('canvas');
  c.width = c.height = MN;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const font = s => (FONTS[params.font] || FONTS.sans).replace('{s}', s);
  ctx.font = font(100);
  let m = ctx.measureText(ch);
  const gw = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) || 60;
  const gh = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || 70;
  const box = 2 * params.spread / MS;
  ctx.font = font(100 * Math.min(box / gw, box / gh));
  m = ctx.measureText(ch);
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(ch,
    MN / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2,
    MN / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  const data = ctx.getImageData(0, 0, MN, MN).data;

  // Chamfer distance transform: distance (mask px) from each inside pixel to the outside.
  const dist = new Float32Array(MN * MN);
  let area = 0;
  for (let i = 0; i < dist.length; i++) {
    if (data[i * 4 + 3] > 127) { dist[i] = 1e9; area++; }
  }
  const A = 1, B = Math.SQRT2;
  for (let y = 0; y < MN; y++) for (let x = 0; x < MN; x++) {
    const i = y * MN + x;
    if (!dist[i]) continue;
    let d = dist[i];
    d = Math.min(d, x > 0 ? dist[i - 1] + A : A, y > 0 ? dist[i - MN] + A : A,
      x > 0 && y > 0 ? dist[i - MN - 1] + B : B, x < MN - 1 && y > 0 ? dist[i - MN + 1] + B : B);
    dist[i] = d;
  }
  for (let y = MN - 1; y >= 0; y--) for (let x = MN - 1; x >= 0; x--) {
    const i = y * MN + x;
    if (!dist[i]) continue;
    let d = dist[i];
    d = Math.min(d, x < MN - 1 ? dist[i + 1] + A : A, y < MN - 1 ? dist[i + MN] + A : A,
      x < MN - 1 && y < MN - 1 ? dist[i + MN + 1] + B : B, x > 0 && y < MN - 1 ? dist[i + MN - 1] + B : B);
    dist[i] = d;
  }
  let maxD = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] > maxD) maxD = dist[i];
  mask = area ? { dist, area: area * MS * MS, maxD } : null;
}

function maskDist(x, y) {
  const mx = Math.floor(x / MS), my = Math.floor(y / MS);
  if (mx < 0 || my < 0 || mx >= MN || my >= MN) return 0;
  return mask.dist[my * MN + mx] * MS;
}

// True when the straight segment between two dots stays inside the letter.
function insideSegment(a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(1, Math.ceil(len / (MS * 0.75)));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (maskDist(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) < MS * 0.5) return false;
  }
  return true;
}

function generateLayout() {
  buildMask();
  const rand = mulberry32(params.seed * 7919 + 13);
  const sizeRand = mulberry32(params.seed * 104729 + 7);
  const R = params.spread;
  const area = mask ? mask.area : Math.PI * R * R;
  const minDist = params.spacing * Math.sqrt(area / params.count);
  nodes = [];

  let sample;
  if (mask) {
    // Keep dot centres inset from the glyph edge (less so in thin strokes).
    const inset = Math.min(params.dot * 0.5, mask.maxD * MS * 0.6);
    const inner = [], edge = [], ridge = [], dm = mask.dist;
    for (let i = 0; i < dm.length; i++) {
      const d = dm[i] * MS;
      if (d < inset) continue;
      inner.push(i);
      if (d < inset + MS * 1.5) edge.push(i);
      // Centreline: pixels at least as deep as every neighbour.
      const v = dm[i];
      if (v >= dm[i - 1] && v >= dm[i + 1] && v >= dm[i - MN] && v >= dm[i + MN] &&
          v >= dm[i - MN - 1] && v >= dm[i - MN + 1] && v >= dm[i + MN - 1] && v >= dm[i + MN + 1]) ridge.push(i);
    }
    const outlineCount = Math.round(params.count * params.outline);
    const centerCount = outlineCount + Math.round(params.count * params.center);
    sample = i => {
      const pool = i < outlineCount && edge.length ? edge
        : i < centerCount && ridge.length ? ridge : inner;
      const p = pool[Math.floor(rand() * pool.length)];
      return { x: (p % MN + rand()) * MS, y: (Math.floor(p / MN) + rand()) * MS };
    };
  } else {
    sample = () => {
      const a = rand() * Math.PI * 2, r = R * Math.sqrt(rand());
      return { x: D / 2 + Math.cos(a) * r, y: D / 2 + Math.sin(a) * r };
    };
  }

  const tries = mask ? 250 : 80;
  for (let i = 0; i < params.count; i++) {
    let best = null, bestD = -1;
    for (let t = 0; t < tries; t++) {
      const p = sample(i);
      let d = Infinity;
      for (const n of nodes) d = Math.min(d, Math.hypot(n.x - p.x, n.y - p.y));
      if (d >= minDist) { best = p; break; }
      if (d > bestD) { bestD = d; best = p; }
    }
    nodes.push({ x: best.x, y: best.y, f: sizeRand() * 2 - 1 });
  }
}

function generateLinks() {
  const n = nodes.length;
  const set = new Set();
  edges = [];
  const add = (a, b) => {
    if (a === b) return false;
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    if (set.has(key)) return false;
    set.add(key); edges.push([a, b]);
    return true;
  };
  // In letter mode a link may only exist if it stays inside the glyph.
  const okCache = new Map();
  const ok = (a, b) => {
    if (!mask) return true;
    const key = a < b ? a * 100000 + b : b * 100000 + a;
    let v = okCache.get(key);
    if (v === undefined) okCache.set(key, v = insideSegment(nodes[a], nodes[b]));
    return v;
  };
  const dist = (a, b) => ok(a, b) ? Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y) : Infinity;

  // Minimum spanning tree (Prim) so the whole mark is one connected shape.
  if (params.tree && n > 1) {
    const inTree = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1);
    best[0] = 0;
    for (let it = 0; it < n; it++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
      inTree[u] = 1;
      if (from[u] >= 0 && best[u] < Infinity) add(from[u], u);
      for (let v = 0; v < n; v++) {
        if (inTree[v]) continue;
        const d = dist(u, v);
        if (d < best[v]) { best[v] = d; from[v] = u; }
      }
    }
  }

  // k nearest neighbours.
  for (let i = 0; i < n; i++) {
    const others = [];
    for (let j = 0; j < n; j++) if (j !== i) others.push([dist(i, j), j]);
    others.sort((a, b) => a[0] - b[0]);
    for (let m = 0; m < Math.min(params.k, others.length) && others[m][0] < Infinity; m++) add(i, others[m][1]);
  }

  // Long links between random pairs.
  const rand = mulberry32(params.seed * 31 + params.linkSeed * 977 + 5);
  for (let e = 0; e < params.extra && n > 2; e++) {
    for (let t = 0; t < 40; t++) {
      const a = Math.floor(rand() * n), b = Math.floor(rand() * n);
      if (a !== b && dist(a, b) < params.spread * 1.4 && add(a, b)) break;
    }
  }
  computeDegree();
}

function computeDegree() {
  degree = new Array(nodes.length).fill(0);
  for (const [a, b] of edges) { degree[a]++; degree[b]++; }
}

function radius(i) {
  const n = nodes[i];
  let r = params.dot * (1 + params.variation * n.f);
  if (degree[i] <= 1) r *= params.endBoost;
  return Math.max(0.5, r);
}

// ---------- rendering ----------

function drawShapes(ctx, color = '#000') {
  ctx.fillStyle = ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = params.line;
  ctx.beginPath();
  for (const [a, b] of edges) {
    ctx.moveTo(nodes[a].x, nodes[a].y);
    ctx.lineTo(nodes[b].x, nodes[b].y);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < nodes.length; i++) {
    const r = radius(i);
    ctx.moveTo(nodes[i].x + r, nodes[i].y);
    ctx.arc(nodes[i].x, nodes[i].y, r, 0, Math.PI * 2);
  }
  ctx.fill();
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
function renderField(size, x0, y0, w, h) {
  const scale = size / D;
  const r = Math.round(params.goo * scale);
  const m = r > 0 ? r * 3 + 2 : 0;
  const tw = w + 2 * m, th = h + 2 * m;
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(scale, 0, 0, scale, m - x0, m - y0);
  drawShapes(ctx);
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

function composite(field, w, h, r, transparent) {
  const img = new ImageData(w, h);
  const d = img.data;
  const fg = params.invert ? 255 : 0, bg = 255 - fg;
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

// ---------- preview ----------

const canvas = document.getElementById('view');
const frame = document.getElementById('frame');
const exact = document.getElementById('exact');
const ectx = exact.getContext('2d');
const vctx = canvas.getContext('2d');
let cssSize = 600, margin = 60;
let queued = false;

const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
const isTouch = matchMedia('(pointer: coarse)').matches;

// The preview draws plain vector shapes and lets the GPU do the melting with a
// CSS blur + contrast filter: the same blur-then-threshold the exporter runs
// in JS, but cheap enough to follow a slider in real time. The canvas
// overhangs the clipped frame so the blur never smears the artboard edges.
let lastLayoutW = 0;
function layoutCanvas() {
  // Phones fire resize when the address bar shows/hides while scrolling;
  // resizing the canvas clears it, so on mobile only re-layout on width changes.
  if (isMobile() && lastLayoutW === window.innerWidth && canvas.width) return;
  lastLayoutW = window.innerWidth;
  const topbar = document.querySelector('.topbar');
  document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
  const board = document.querySelector('.artboard');
  if (isMobile()) {
    cssSize = Math.min(window.innerWidth - 28, Math.round(window.innerHeight * 0.46));
  } else {
    cssSize = Math.min(board.clientWidth, board.clientHeight, 1100);
  }
  cssSize = Math.max(160, Math.floor(cssSize));
  margin = Math.ceil(cssSize * 0.1);
  frame.style.width = frame.style.height = cssSize + 'px';
  const full = cssSize + 2 * margin;
  const dpr = window.devicePixelRatio || 1;
  Object.assign(canvas.style, { width: full + 'px', height: full + 'px', left: -margin + 'px', top: -margin + 'px' });
  const px = Math.min(2600, Math.round(full * dpr));
  const epx = Math.round(px * cssSize / full);
  if (canvas.width !== px) canvas.width = canvas.height = px;
  if (exact.width !== epx) exact.width = exact.height = epx;
  render(); // synchronously, so a resized (cleared) canvas never shows a blank frame
}

function draw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

function render() {
  const px = canvas.width, perCss = px / (cssSize + 2 * margin);
  const fg = params.invert ? '#fff' : '#000', bg = params.invert ? '#000' : '#fff';
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.fillStyle = bg;
  vctx.fillRect(0, 0, px, px);
  const s = perCss * cssSize / D;
  vctx.setTransform(s, 0, 0, s, margin * perCss, margin * perCss);
  drawShapes(vctx, fg);
  const sigma = params.goo * cssSize / D; // CSS px
  const filter = sigma > 0.05
    ? `blur(${sigma.toFixed(2)}px) contrast(${Math.max(1, 4 * sigma * perCss).toFixed(1)})`
    : 'none';
  // Only touch the filter when it actually changes: re-applying it makes
  // some browsers rebuild the layer, which shows up as a flash.
  if (filter !== currentFilter) canvas.style.filter = currentFilter = filter;
  frame.style.background = bg;
  exact.style.visibility = 'hidden';
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 220);
  document.getElementById('statDots').textContent = nodes.length;
  document.getElementById('statLinks').textContent = edges.length;
  document.getElementById('statEnds').textContent = degree.filter(d => d <= 1).length;
}

// Once the controls go quiet, lay the exact render the exporter produces over
// the GPU approximation, so what you see is what you download. The GPU layer
// stays untouched underneath, so hiding the overlay again never flashes.
let settleTimer = 0, currentFilter = '';
function settle() {
  if (drag) { settleTimer = setTimeout(settle, 220); return; }
  const size = exact.width;
  const { field, r } = renderField(size, 0, 0, size, size);
  ectx.putImageData(composite(field, size, size, r, false), 0, 0);
  exact.style.visibility = 'visible';
}

// ---------- export ----------

const statusEl = document.getElementById('status');
const nextFrame = () => new Promise(res => requestAnimationFrame(() => res()));

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportPNG() {
  const size = +document.getElementById('res').value;
  const transparent = document.getElementById('transparent').checked;
  setBusy(true);
  try {
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const octx = out.getContext('2d');
    if (!octx) throw new Error('canvas too large for this browser');
    const T = 2048;
    const tiles = Math.ceil(size / T) ** 2;
    let done = 0;
    for (let ty = 0; ty < size; ty += T) {
      for (let tx = 0; tx < size; tx += T) {
        statusEl.textContent = `Rendering ${size}px… ${Math.round(done / tiles * 100)}%`;
        await nextFrame();
        const w = Math.min(T, size - tx), h = Math.min(T, size - ty);
        const { field, r } = renderField(size, tx, ty, w, h);
        octx.putImageData(composite(field, w, h, r, transparent), tx, ty);
        done++;
      }
    }
    statusEl.textContent = 'Encoding PNG…';
    await nextFrame();
    const blob = await new Promise(res => out.toBlob(res, 'image/png'));
    out.width = out.height = 0;
    if (!blob) throw new Error('canvas too large for this browser');
    download(blob, `logo-${size}.png`);
    statusEl.textContent = `Saved ${size} × ${size} PNG (${(blob.size / 1e6).toFixed(1)} MB).`;
  } catch (err) {
    statusEl.textContent = `Export failed: ${err.message}. Try a smaller resolution.`;
  } finally {
    setBusy(false);
  }
}

// Marching squares over the coverage field → closed, oriented outlines.
function traceContours(f, N, T = 127.5) {
  const W = N + 2, HN = W * W;
  const g = new Float32Array(HN);
  for (let y = 0; y < N; y++) g.set(f.subarray(y * N, y * N + N), (y + 1) * W + 1);
  const next = new Int32Array(2 * HN).fill(-1);
  const px = new Float32Array(2 * HN), py = new Float32Array(2 * HN);
  const hEdge = (x, y) => {
    const id = y * W + x, v0 = g[id], v1 = g[id + 1];
    px[id] = x + (T - v0) / (v1 - v0); py[id] = y;
    return id;
  };
  const vEdge = (x, y) => {
    const i = y * W + x, v0 = g[i], v1 = g[i + W];
    const id = HN + i;
    px[id] = x; py[id] = y + (T - v0) / (v1 - v0);
    return id;
  };
  const corner = [0, 0, 0, 0], cross = [], isEntry = [];
  for (let y = 0; y < W - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = g[y * W + x], b = g[y * W + x + 1], c = g[(y + 1) * W + x + 1], d = g[(y + 1) * W + x];
      corner[0] = a > T; corner[1] = b > T; corner[2] = c > T; corner[3] = d > T;
      if (corner[0] === corner[1] && corner[1] === corner[2] && corner[2] === corner[3]) continue;
      // Walk the cell boundary clockwise (y points down): top, right, bottom, left.
      cross.length = 0; isEntry.length = 0;
      for (let e = 0; e < 4; e++) {
        const from = corner[e], to = corner[(e + 1) & 3];
        if (from === to) continue;
        cross.push(e === 0 ? hEdge(x, y) : e === 1 ? vEdge(x + 1, y) : e === 2 ? hEdge(x, y + 1) : vEdge(x, y));
        isEntry.push(to);
      }
      if (cross.length === 2) {
        if (isEntry[0]) next[cross[1]] = cross[0]; else next[cross[0]] = cross[1];
      } else {
        // Saddle: decide by the cell centre which corners get cut off.
        const centreIn = (a + b + c + d) / 4 > T;
        for (let i = 0; i < 4; i++) {
          if (isEntry[i]) continue;
          next[cross[i]] = cross[centreIn ? (i + 1) & 3 : (i + 3) & 3];
        }
      }
    }
  }
  const visited = new Uint8Array(2 * HN);
  const loops = [];
  for (let s = 0; s < next.length; s++) {
    if (next[s] < 0 || visited[s]) continue;
    const pts = [];
    let id = s;
    while (id >= 0 && !visited[id]) {
      visited[id] = 1;
      pts.push(px[id] - 0.5, py[id] - 0.5); // undo padding, move to pixel centres
      id = next[id];
    }
    if (pts.length >= 6) loops.push(pts);
  }
  return loops;
}

function simplify(pts, eps) {
  const n = pts.length / 2;
  if (n < 4) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const ax = pts[2 * s], ay = pts[2 * s + 1], bx = pts[2 * e], by = pts[2 * e + 1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[2 * i] - ax) * dy - (pts[2 * i + 1] - ay) * dx) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

// Split a closed loop at the point farthest from its start so both halves
// are well-defined open polylines for Douglas–Peucker.
function simplifyClosed(pts, eps) {
  const n = pts.length / 2;
  let far = 0, farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(pts[2 * i] - pts[0], pts[2 * i + 1] - pts[1]);
    if (d > farD) { farD = d; far = i; }
  }
  const a = simplify(pts.slice(0, 2 * far + 2), eps);
  const b = simplify(pts.slice(2 * far).concat(pts[0], pts[1]), eps);
  return a.concat(b.slice(2, -2));
}

async function exportSVG() {
  const transparent = document.getElementById('transparent').checked;
  setBusy(true);
  try {
    statusEl.textContent = 'Tracing vector outlines…';
    await nextFrame();
    const N = 3000;
    const { field } = renderField(N, 0, 0, N, N);
    const loops = traceContours(field, N);
    const s = D / N;
    let d = '';
    for (const loop of loops) {
      const p = simplifyClosed(loop, 0.2);
      d += 'M' + (p[0] * s).toFixed(2) + ' ' + (p[1] * s).toFixed(2);
      for (let i = 2; i < p.length; i += 2) d += 'L' + (p[i] * s).toFixed(2) + ' ' + (p[i + 1] * s).toFixed(2);
      d += 'Z';
    }
    const fg = params.invert ? '#fff' : '#000', bg = params.invert ? '#000' : '#fff';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${D} ${D}" width="${D}" height="${D}">` +
      (transparent ? '' : `<rect width="${D}" height="${D}" fill="${bg}"/>`) +
      `<path fill="${fg}" fill-rule="evenodd" d="${d}"/></svg>`;
    download(new Blob([svg], { type: 'image/svg+xml' }), 'logo.svg');
    statusEl.textContent = `Saved SVG (${loops.length} outlines).`;
  } catch (err) {
    statusEl.textContent = `Export failed: ${err.message}`;
  } finally {
    setBusy(false);
  }
}

function setBusy(b) {
  for (const id of ['png', 'svg']) document.getElementById(id).disabled = b;
}

// ---------- controls & state ----------

function loadParams() {
  const p = { ...DEFAULTS };
  const q = new URLSearchParams(location.hash.slice(1));
  for (const k of NUMERIC) if (q.has(k) && isFinite(+q.get(k))) p[k] = +q.get(k);
  for (const k of BOOLEAN) if (q.has(k)) p[k] = q.get(k) === '1';
  for (const k of STRING) if (q.has(k)) p[k] = q.get(k);
  return p;
}

function saveParams() {
  const q = new URLSearchParams();
  for (const k of NUMERIC) q.set(k, params[k]);
  for (const k of BOOLEAN) q.set(k, params[k] ? '1' : '0');
  for (const k of STRING) q.set(k, params[k]);
  history.replaceState(null, '', '#' + q.toString());
}

function fmt(key, v) {
  if (key === 'variation' || key === 'spacing' || key === 'outline' || key === 'center') return Math.round(v * 100) + '%';
  if (key === 'endBoost') return '×' + v.toFixed(2);
  return String(v);
}

function syncControls() {
  for (const k of NUMERIC) {
    const el = document.getElementById(k);
    if (!el) continue;
    el.value = params[k];
    const out = document.querySelector(`output[data-for="${k}"]`);
    if (out) out.textContent = fmt(k, params[k]);
  }
  for (const k of BOOLEAN) document.getElementById(k).checked = params[k];
  document.getElementById('letter').value = params.letter;
  document.getElementById('font').value = params.font;
  for (const b of document.querySelectorAll('#shapeSeg button')) b.classList.toggle('on', b.dataset.shape === params.shape);
  document.getElementById('letterOpts').hidden = params.shape !== 'letter';
  document.getElementById('spreadLabel').textContent = params.shape === 'letter' ? 'Size' : 'Spread';
}

function onChange(key) {
  if (LAYOUT_KEYS.has(key)) { generateLayout(); generateLinks(); }
  else if (LINK_KEYS.has(key)) generateLinks();
  syncControls();
  saveParams();
  draw();
}

for (const k of NUMERIC) {
  const el = document.getElementById(k);
  if (el) el.addEventListener('input', () => { params[k] = +el.value; onChange(k); });
}
for (const k of BOOLEAN) {
  const el = document.getElementById(k);
  el.addEventListener('change', () => { params[k] = el.checked; onChange(k); });
}
for (const b of document.querySelectorAll('#shapeSeg button')) {
  b.addEventListener('click', () => {
    if (params.shape === b.dataset.shape) return;
    params.shape = b.dataset.shape;
    // A letter needs more, smaller dots than a round cluster to read clearly.
    if (params.shape === 'letter' && params.count < 60) {
      Object.assign(params, { count: 60, dot: 17, line: 10 });
    }
    onChange('shape');
  });
}
document.getElementById('letter').addEventListener('input', e => {
  const ch = Array.from(e.target.value.trim()).slice(-1).join('');
  e.target.value = ch;
  if (!ch) return;
  params.letter = ch; onChange('letter');
});
document.getElementById('letter').addEventListener('focus', e => e.target.select());
document.getElementById('font').addEventListener('change', e => { params.font = e.target.value; onChange('font'); });
document.getElementById('newSeed').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 1e6); onChange('seed');
});
document.getElementById('newLinks').addEventListener('click', () => {
  params.linkSeed = Math.floor(Math.random() * 1e6); onChange('linkSeed');
});
document.getElementById('png').addEventListener('click', exportPNG);
document.getElementById('svg').addEventListener('click', exportSVG);

// ---------- direct manipulation ----------

function toDesign(e) {
  const rect = frame.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / rect.width * D, y: (e.clientY - rect.top) / rect.height * D };
}

function hit(p) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = Math.hypot(nodes[i].x - p.x, nodes[i].y - p.y);
    if (d < radius(i) + 10 && d < bestD) { best = i; bestD = d; }
  }
  return best;
}

let drag = null, press = null, lastTap = { t: 0, x: 0, y: 0 };

function addNode(p) {
  nodes.push({ x: p.x, y: p.y, f: Math.random() * 2 - 1 });
  generateLinks();
  draw();
}

frame.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const p = toDesign(e), i = hit(p);
  press = { x: e.clientX, y: e.clientY, moved: false, timer: 0 };
  if (i < 0) return;
  if (e.altKey) { removeNode(i); return; }
  drag = { i, dx: nodes[i].x - p.x, dy: nodes[i].y - p.y };
  // Long-press a dot (touch) to delete it.
  if (e.pointerType !== 'mouse') {
    press.timer = setTimeout(() => {
      if (drag && !press.moved) { const k = drag.i; endDrag(); removeNode(k); press = null; }
    }, 550);
  }
  frame.setPointerCapture(e.pointerId);
  frame.classList.add('dragging');
});
frame.addEventListener('pointermove', e => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
  const p = toDesign(e);
  if (drag) {
    nodes[drag.i].x = Math.min(D, Math.max(0, p.x + drag.dx));
    nodes[drag.i].y = Math.min(D, Math.max(0, p.y + drag.dy));
    draw();
  } else if (e.pointerType === 'mouse') {
    frame.classList.toggle('over', hit(p) >= 0);
  }
});
function endDrag() {
  if (press) clearTimeout(press.timer);
  drag = null;
  frame.classList.remove('dragging');
}
frame.addEventListener('pointerup', e => {
  const wasTap = press && !press.moved && !drag;
  endDrag();
  press = null;
  // Double-tap empty space (touch) to add a dot; mice use dblclick below.
  if (wasTap && e.pointerType !== 'mouse') {
    const now = performance.now();
    if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      const p = toDesign(e);
      if (hit(p) < 0) addNode(p);
      lastTap.t = 0;
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  }
});
frame.addEventListener('pointercancel', () => { endDrag(); press = null; });
frame.addEventListener('contextmenu', e => {
  e.preventDefault();
  const i = hit(toDesign(e));
  if (i >= 0 && !isTouch) removeNode(i);
});
frame.addEventListener('dblclick', e => {
  if (isTouch) return;
  const p = toDesign(e);
  if (hit(p) < 0) addNode(p);
});

function removeNode(i) {
  if (nodes.length <= 1) return;
  nodes.splice(i, 1);
  generateLinks();
  draw();
}

// ---------- boot ----------

document.getElementById('hint').textContent = isTouch
  ? 'Drag dots to move them · double-tap empty space to add a dot · long-press a dot to delete it. Changing Dots, Spread, Min spacing or New layout regenerates positions.'
  : 'Drag dots to move them · double-click empty space to add a dot · right-click (or Alt-click) a dot to delete it. Changing Dots, Spread, Min spacing or New layout regenerates positions.';
// Phones and iPads cap canvas size at ~16.7 MP, so default to 4096 there.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (isTouch && navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))) {
  document.getElementById('res').value = '4096';
  for (const o of document.querySelectorAll('#res option')) if (+o.value > 4096) o.textContent += ' (desktop only)';
}

syncControls();
generateLayout();
generateLinks();
window.addEventListener('resize', layoutCanvas);
layoutCanvas();
