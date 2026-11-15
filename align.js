// Registration engine: finds a printed Tesla wrap template in a photo and
// warps the photo back into template space. Pure functions on ImageData-like
// objects ({width, height, data}) so it runs in a page, a worker or a test.

// ---------- small linear algebra ----------

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function mul(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Homography mapping 4 src points to 4 dst points.
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h && [...h, 1];
}

const normalise = (H) => H.map((v) => v / H[8]);

// ---------- image helpers ----------

function luminance(img) {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h), chroma = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = data[p], gr = data[p + 1], b = data[p + 2];
    g[i] = 0.299 * r + 0.587 * gr + 0.114 * b;
    chroma[i] = Math.max(r, gr, b) - Math.min(r, gr, b);
  }
  return { g, chroma };
}

// Separable running max (or min) with a square window of radius r.
function rankFilter(src, w, h, r, isMax) {
  const pick = isMax ? Math.max : Math.min;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  // ponytail: O(n·r) window scan, van Herk/Gil-Werman if r grows past ~10
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = src[row + x];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[row + k]);
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

// Thin, dark, colourless strokes: printed outlines. Black-hat (closing minus
// image) relative to the local paper brightness, so shadows don't matter and
// wide marker fills don't register; the chroma gate drops coloured strokes.
export function lineMap(img, radius = 4) {
  const { width: w, height: h } = img;
  const { g, chroma } = luminance(img);
  const closed = rankFilter(rankFilter(g, w, h, radius, true), w, h, radius, false);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const c = closed[i];
    if (c > 60 && (c - g[i]) / c > 0.4 && chroma[i] < 0.35 * c) out[i] = 1;
  }
  return out;
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
export function distanceTransform(mask, w, h) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] ? 0 : INF;
  const pass = (n, get, set) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s;
      while (true) {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let q = 0; q < n; q++) set(q, d[q]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => grid[y * w + x], (y, val) => (grid[y * w + x] = val));
  for (let y = 0; y < h; y++) pass(w, (x) => grid[y * w + x], (x, val) => (grid[y * w + x] = val));
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

function sampleD(D, w, h, x, y) {
  if (!(x >= 0 && y >= 0 && x < w - 1 && y < h - 1)) return 1e3;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (D[i] * (1 - fx) + D[i + 1] * fx) * (1 - fy) + (D[i + w] * (1 - fx) + D[i + w + 1] * fx) * fy;
}

// ---------- template model ----------

export const isTemplateLine = (data, i) => data[i * 4 + 3] > 128 && data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] < 384;

// Registration marks sit just left and right of the template, level with its
// top and bottom edges, so they cost the drawing no height on the page.
export const MARK_OFFSET = 30, MARK_R = 16;

export function markCentres(tw, th) {
  const o = MARK_OFFSET, a = MARK_R * 1.6;
  return [[-o, a], [tw + o, a], [tw + o, th - a], [-o, th - a]];
}

// Printed sheets carry a small QR code naming the car, placed in the largest
// empty (off-car) square of the template. Sheet and reader both derive the
// spot from this function, so it must stay deterministic.
export const QR_PREFIX = 'CTC1:', QR_MAX = 104, QR_MIN = 64, QR_PAD = 10;
export function qrSpot(tpl) {
  const { width: w, height: h, data } = tpl;
  const s = new Uint16Array(w * h);
  let best = 0, bx = 0, by = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i * 4 + 3] > 0) continue;
      const v = x && y ? 1 + Math.min(s[i - 1], s[i - w], s[i - w - 1]) : 1;
      s[i] = v;
      // Largest square wins; ties go to the one nearest the middle.
      const cx = x - v / 2 - w / 2, cy = y - v / 2 - h / 2;
      if (v > best || (v === best && cx * cx + cy * cy < (bx - best / 2 - w / 2) ** 2 + (by - best / 2 - h / 2) ** 2)) { best = v; bx = x; by = y; }
    }
  const size = Math.min(QR_MAX, best - 2 * QR_PAD);
  if (size < QR_MIN) return null;
  return { x: bx - best / 2 - size / 2 + 1, y: by - best / 2 - size / 2 + 1, size };
}

// A4 landscape sheet at 300 dpi, in sheet px. The worker maps the website QR
// back into template space with this, so the sheet must be drawn from it too.
export const MM = 300 / 25.4;
export function sheetLayout(tw, th) {
  const W = Math.round(297 * MM), H = Math.round(210 * MM), m = 7 * MM;
  const E = MARK_OFFSET + MARK_R * 1.6, box = H - 2 * m;
  const s = box / Math.max(tw, th);
  const x0 = m + (tw + 2 * E) * s + 9 * MM, barH = 2.4 * MM, qs = 30 * MM;
  return { W, H, m, s, ox: m + E * s, oy: (H - th * s) / 2, x0, cw: W - m - x0, barH, site: { x: x0, y: H - m - barH - 15 * MM - qs, size: qs } };
}

function markPoints(tw, th) {
  const pts = [];
  for (const [cx, cy] of markCentres(tw, th)) {
    for (let a = 0; a < 48; a++) pts.push([cx + MARK_R * Math.cos((a / 48) * 2 * Math.PI), cy + MARK_R * Math.sin((a / 48) * 2 * Math.PI)]);
    for (let t = -MARK_R * 1.6; t <= MARK_R * 1.6; t += 2) pts.push([cx + t, cy], [cx, cy + t]);
  }
  return pts;
}

// One point per cell of outline pixels, so long strokes don't dominate.
function samplePoints(tpl, cell) {
  const { width: w, height: h, data } = tpl;
  const pts = [];
  for (let cy = 0; cy < h; cy += cell)
    for (let cx = 0; cx < w; cx += cell) {
      let sx = 0, sy = 0, n = 0;
      for (let y = cy; y < Math.min(h, cy + cell); y++)
        for (let x = cx; x < Math.min(w, cx + cell); x++)
          if (isTemplateLine(data, y * w + x)) { sx += x; sy += y; n++; }
      if (n > cell / 2) pts.push([sx / n + 0.5, sy / n + 0.5]);
    }
  return pts;
}

export function templateModel(tpl) {
  return { width: tpl.width, height: tpl.height, coarse: samplePoints(tpl, 14), fine: samplePoints(tpl, 4), marks: markPoints(tpl.width, tpl.height) };
}

// ---------- paper detection ----------

// Rough quad of the brightest, least coloured blob: the sheet of paper. It
// only seeds the search, so extreme points along the diagonals are enough.
export function findPaper(img) {
  const { width: w, height: h } = img;
  const { g: raw, chroma } = luminance(img);
  // Flatten lighting first so a shadow across the sheet doesn't split it.
  const bg = rankFilter(raw, w, h, Math.round(Math.max(w, h) / 40), true);
  const g = raw.map((v, i) => (255 * v) / Math.max(1, bg[i]));
  const hist = new Array(256).fill(0);
  for (let i = 0; i < w * h; i++) hist[Math.min(255, g[i] | 0)]++;
  // Otsu threshold
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = w * h - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = g[i] > thr && raw[i] > 40 && chroma[i] < 0.25 * raw[i] ? 1 : 0;
  // close small gaps (colouring inside the sheet) so the blob stays whole
  const closed = rankFilter(rankFilter(Float32Array.from(mask), w, h, 6, true), w, h, 6, false);
  const label = new Int32Array(w * h).fill(-1);
  let bestId = -1, bestSize = 0;
  const stack = new Int32Array(w * h);
  for (let s = 0, id = 0; s < w * h; s++) {
    if (!closed[s] || label[s] >= 0) continue;
    let top = 0, size = 0; stack[top++] = s; label[s] = id;
    while (top) {
      const i = stack[--top]; size++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && closed[i - 1] && label[i - 1] < 0) { label[i - 1] = id; stack[top++] = i - 1; }
      if (x < w - 1 && closed[i + 1] && label[i + 1] < 0) { label[i + 1] = id; stack[top++] = i + 1; }
      if (y > 0 && closed[i - w] && label[i - w] < 0) { label[i - w] = id; stack[top++] = i - w; }
      if (y < h - 1 && closed[i + w] && label[i + w] < 0) { label[i + w] = id; stack[top++] = i + w; }
    }
    if (size > bestSize) { bestSize = size; bestId = id; }
    id++;
  }
  if (bestSize < 0.12 * w * h) return null;
  const dirs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const corners = dirs.map(() => [0, 0, -Infinity]);
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== bestId) continue;
    const x = i % w, y = (i / w) | 0;
    dirs.forEach(([dx, dy], k) => { const s = dx * x + dy * y; if (s > corners[k][2]) corners[k] = [x, y, s]; });
  }
  return corners.map(([x, y]) => [x, y]);
}

// ---------- search ----------

function chamfer(D, w, h, H, pts, tau) {
  let s = 0;
  for (const [x, y] of pts) {
    const [u, v] = apply(H, x, y);
    s += Math.min(tau, sampleD(D, w, h, u, v));
  }
  return s / pts.length;
}

// Template → page placements: 4 quarter turns × scale × position.
function coarseSearch(D, w, h, model, Hpage, pageW, pageH, extraAngles) {
  const { width: tw, height: th } = model;
  let best = { score: Infinity };
  for (let q = 0; q < 4; q++) {
    for (const da of extraAngles) {
      const a = (q * Math.PI) / 2 + da, c = Math.cos(a), s = Math.sin(a);
      const bw = Math.abs(c) * tw + Math.abs(s) * th, bh = Math.abs(s) * tw + Math.abs(c) * th;
      const fit = Math.min(pageW / bw, pageH / bh);
      for (let k = 0; k < 14; k++) {
        const sc = fit * (0.5 + (0.55 * k) / 13);
        const stepX = pageW / 40, stepY = pageH / 40;
        for (let cx = (sc * bw) / 2 * 0.85; cx <= pageW - (sc * bw) / 2 * 0.85; cx += stepX)
          for (let cy = (sc * bh) / 2 * 0.85; cy <= pageH - (sc * bh) / 2 * 0.85; cy += stepY) {
            // centre template, rotate, scale, place
            const A = [sc * c, -sc * s, cx - sc * (c * tw / 2 - s * th / 2), sc * s, sc * c, cy - sc * (s * tw / 2 + c * th / 2), 0, 0, 1];
            const H = mul(Hpage, A);
            const score = chamfer(D, w, h, H, model.coarse, 24);
            if (score < best.score) best = { score, H };
          }
      }
    }
  }
  return best;
}

// Levenberg–Marquardt on all 8 homography parameters, minimising truncated
// distance from template outline points to the nearest detected stroke.
// Points are normalised to [-1, 1] for conditioning.
export function refine(D, w, h, Hinit, pts, tw, th, schedule = [24, 12, 6, 3, 2]) {
  const sx = tw / 2, sy = th / 2;
  const N = [sx, 0, sx, 0, sy, sy, 0, 0, 1]; // normalised → template px
  const Ninv = [1 / sx, 0, -1, 0, 1 / sy, -1, 0, 0, 1];
  const P = pts.map(([x, y]) => [x / sx - 1, y / sy - 1]);
  let G = normalise(mul(Hinit, N));
  const cost = (G, tau) => P.reduce((s, [x, y]) => { const [u, v] = apply(G, x, y); const d = Math.min(tau, sampleD(D, w, h, u, v)); return s + d * d; }, 0);
  for (const tau of schedule) {
    let lambda = 1e-3, c0 = cost(G, tau);
    for (let it = 0; it < 25; it++) {
      const JtJ = Array.from({ length: 8 }, () => new Array(8).fill(0)), Jtr = new Array(8).fill(0);
      for (const [x, y] of P) {
        const wq = G[6] * x + G[7] * y + 1;
        const u = (G[0] * x + G[1] * y + G[2]) / wq, v = (G[3] * x + G[4] * y + G[5]) / wq;
        const d = sampleD(D, w, h, u, v);
        if (d >= tau) continue;
        const gx = (sampleD(D, w, h, u + 0.5, v) - sampleD(D, w, h, u - 0.5, v));
        const gy = (sampleD(D, w, h, u, v + 0.5) - sampleD(D, w, h, u, v - 0.5));
        const J = [gx * x / wq, gx * y / wq, gx / wq, gy * x / wq, gy * y / wq, gy / wq, -(gx * u + gy * v) * x / wq, -(gx * u + gy * v) * y / wq];
        for (let i = 0; i < 8; i++) { Jtr[i] += J[i] * d; for (let j = 0; j < 8; j++) JtJ[i][j] += J[i] * J[j]; }
      }
      let improved = false;
      for (let tries = 0; tries < 6 && !improved; tries++) {
        const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-9 : v)));
        const step = solve(A, Jtr.map((v) => -v));
        if (!step) break;
        const Gn = [...G.slice(0, 8).map((v, i) => v + step[i]), 1];
        const c1 = cost(Gn, tau);
        if (c1 < c0) { G = Gn; lambda = Math.max(1e-7, lambda / 3); improved = c0 - c1 > 1e-6 * c0 ? true : 'done'; c0 = c1; }
        else lambda *= 4;
      }
      if (improved !== true) break;
    }
  }
  return normalise(mul(G, Ninv));
}

// Share of outline points sitting on a detected stroke: the fit quality.
export function inlierRatio(D, w, h, H, pts, tol = 2.5) {
  let n = 0;
  for (const [x, y] of pts) { const [u, v] = apply(H, x, y); if (sampleD(D, w, h, u, v) <= tol) n++; }
  return n / pts.length;
}

export function prepare(img) {
  const lines = lineMap(img);
  return { width: img.width, height: img.height, D: distanceTransform(lines, img.width, img.height), paper: findPaper(img) };
}

// Template px → photo px (in prepared image coordinates). A seed homography
// (from the sheet's QR code) skips the search when it refines to a good fit.
export function align(prep, model, seed) {
  const { D, width: w, height: h, paper } = prep;
  if (seed) {
    const H = refine(D, w, h, seed, model.fine, model.width, model.height, [48, 24, 12, 6, 3, 2]);
    if (inlierRatio(D, w, h, H, model.fine) > 0.6) return withMarks(prep, model, H);
  }
  const frames = [{ H: [1, 0, 0, 0, 1, 0, 0, 0, 1], W: w, Hh: h, angles: [-0.1, -0.05, 0, 0.05, 0.1] }];
  if (paper) {
    const [a, b, c, d] = paper;
    const W = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - d[0], c[1] - d[1])) / 2;
    const Hh = (Math.hypot(d[0] - a[0], d[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1])) / 2;
    const H = homography([[0, 0], [W, 0], [W, Hh], [0, Hh]], paper);
    if (H) frames.unshift({ H, W, Hh, angles: [0] });
  }
  let best = { score: -1 };
  // The paper quad is the better seed; the whole frame catches a missed or
  // misshapen sheet. Skip the fallback when the first fit is clearly good.
  for (const f of frames) {
    const coarse = coarseSearch(D, w, h, model, f.H, f.W, f.Hh, f.angles);
    const H = refine(D, w, h, coarse.H, model.fine, model.width, model.height);
    const score = inlierRatio(D, w, h, H, model.fine);
    if (score > best.score) best = { H, score };
    if (best.score > 0.8) break;
  }
  return withMarks(prep, model, best.H);
}

function withMarks({ D, width: w, height: h }, model, H) {
  // Printed sheets from this app carry registration marks; fold them in
  // only when they're actually there, so stray edges can't pull a plain print.
  const hasMarks = inlierRatio(D, w, h, H, model.marks, 3) > 0.6;
  if (hasMarks) H = refine(D, w, h, H, [...model.fine, ...model.marks], model.width, model.height, [4, 2]);
  return { H, score: inlierRatio(D, w, h, H, model.fine), hasMarks };
}

// ---------- output ----------

// Photo → template space as float RGB, supersampled to avoid crayon-grain aliasing.
export function warp(photo, H, tw, th) {
  const { width: pw, height: ph, data: pd } = photo;
  // photo px per template px decides supersampling
  const [x0, y0] = apply(H, tw / 2, th / 2), [x1, y1] = apply(H, tw / 2 + 1, th / 2);
  const ss = Math.max(1, Math.min(4, Math.round(Math.hypot(x1 - x0, y1 - y0))));
  const rgb = new Float32Array(tw * th * 3);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < ss; j++)
        for (let i = 0; i < ss; i++) {
          let [u, v] = apply(H, x + (i + 0.5) / ss, y + (j + 0.5) / ss);
          u = Math.min(pw - 1.001, Math.max(0, u - 0.5)); v = Math.min(ph - 1.001, Math.max(0, v - 0.5));
          const u0 = u | 0, v0 = v | 0, fu = u - u0, fv = v - v0, p = (v0 * pw + u0) * 4, q = p + pw * 4;
          r += (pd[p] * (1 - fu) + pd[p + 4] * fu) * (1 - fv) + (pd[q] * (1 - fu) + pd[q + 4] * fu) * fv;
          g += (pd[p + 1] * (1 - fu) + pd[p + 5] * fu) * (1 - fv) + (pd[q + 1] * (1 - fu) + pd[q + 5] * fu) * fv;
          b += (pd[p + 2] * (1 - fu) + pd[p + 6] * fu) * (1 - fv) + (pd[q + 2] * (1 - fu) + pd[q + 6] * fu) * fv;
        }
      const o = (y * tw + x) * 3, n = ss * ss;
      rgb[o] = r / n; rgb[o + 1] = g / n; rgb[o + 2] = b / n;
    }
  return rgb;
}

export function toImageData(rgb, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1]; out[i * 4 + 2] = rgb[i * 3 + 2]; out[i * 4 + 3] = 255; }
  return { width: w, height: h, data: out };
}

// Level the paper to white, drop everything outside the template and paint
// over the printed outlines. Takes warp() output and consumes it.
export function renderWrap(rgb, tpl) {
  const { width: tw, height: th, data: td } = tpl;
  levelPaper(rgb, tw, th);

  // Printed outlines → fill from neighbouring colour.
  const hole = new Uint8Array(tw * th);
  const R = 2;
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      if (!isTemplateLine(td, y * tw + x)) continue;
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < tw && yy < th) hole[yy * tw + xx] = 1;
        }
    }
  // Panels that run off the template edge get a closing line on printed sheets; keep it out of the wrap.
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++)
      if (Math.min(x, y, tw - 1 - x, th - 1 - y) < 3) hole[y * tw + x] = 1;
  inpaint(rgb, hole, tw, th, (i) => td[i * 4 + 3] > 0);

  const out = new Uint8ClampedArray(tw * th * 4);
  for (let i = 0; i < tw * th; i++) {
    if (!td[i * 4 + 3]) continue;
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    // Paper grain snaps to clean white: looks better and halves the PNG size.
    const t = Math.max(r, g, b) - Math.min(r, g, b) < 30 ? Math.min(1, Math.max(0, ((r + g + b) / 3 - 215) / 25)) : 0;
    out[i * 4] = r + (255 - r) * t; out[i * 4 + 1] = g + (255 - g) * t; out[i * 4 + 2] = b + (255 - b) * t;
    out[i * 4 + 3] = td[i * 4 + 3];
  }
  return { width: tw, height: th, data: out };
}

// Divide out uneven lighting: per-cell paper white from bright, colourless
// pixels, interpolated across cells that are fully coloured in.
function levelPaper(rgb, w, h) {
  const C = 48, gw = Math.ceil(w / C), gh = Math.ceil(h / C);
  const white = new Array(gw * gh).fill(null);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const vals = [];
      for (let y = gy * C; y < Math.min(h, (gy + 1) * C); y += 2)
        for (let x = gx * C; x < Math.min(w, (gx + 1) * C); x += 2) {
          const o = (y * w + x) * 3, r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
          const mx = Math.max(r, g, b);
          if (mx - Math.min(r, g, b) < 0.15 * mx) vals.push([r, g, b, r + g + b]);
        }
      if (vals.length < 40) continue;
      vals.sort((a, b) => a[3] - b[3]);
      const top = vals.slice(Math.floor(vals.length * 0.8));
      white[gy * gw + gx] = [0, 1, 2].map((c) => top.reduce((s, v) => s + v[c], 0) / top.length);
    }
  // fill missing cells from neighbours; fall back to global brightest
  const known = white.filter(Boolean);
  const global = known.length ? [0, 1, 2].map((c) => Math.max(...known.map((v) => v[c]))) : [255, 255, 255];
  for (let pass = 0; pass < gw + gh && white.some((v) => !v); pass++) {
    const next = white.slice();
    for (let i = 0; i < white.length; i++) {
      if (white[i]) continue;
      const gx = i % gw, gy = (i / gw) | 0, nb = [];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = gx + dx, y = gy + dy;
        if (x >= 0 && y >= 0 && x < gw && y < gh && white[y * gw + x]) nb.push(white[y * gw + x]);
      }
      if (nb.length) next[i] = [0, 1, 2].map((c) => nb.reduce((s, v) => s + v[c], 0) / nb.length);
    }
    white.splice(0, white.length, ...next);
  }
  for (let i = 0; i < white.length; i++) if (!white[i]) white[i] = global;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, x / C - 0.5)), fy = Math.min(gh - 1, Math.max(0, y / C - 0.5));
      const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const wv = (white[y0 * gw + x0][c] * (1 - ax) + white[y0 * gw + x1][c] * ax) * (1 - ay) + (white[y1 * gw + x0][c] * (1 - ax) + white[y1 * gw + x1][c] * ax) * ay;
        // slight gamma deepens crayon colours that photograph washed out
        rgb[o + c] = 255 * Math.pow(Math.min(1, rgb[o + c] / Math.max(40, wv)), 1.15);
      }
    }
}

// Grow known colour into holes, one ring per pass, within the inside() area.
function inpaint(rgb, hole, w, h, inside) {
  const todo = [];
  for (let i = 0; i < w * h; i++) if (hole[i] && inside(i)) todo.push(i);
  let remaining = todo;
  for (let pass = 0; pass < 12 && remaining.length; pass++) {
    const filled = [], left = [];
    for (const i of remaining) {
      const x = i % w, y = (i / w) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, j = yy * w + xx;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h && !hole[j] && inside(j)) {
            r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++;
          }
        }
      if (n) filled.push([i, r / n, g / n, b / n]); else left.push(i);
    }
    for (const [i, r, g, b] of filled) { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; hole[i] = 0; }
    remaining = left;
  }
}
