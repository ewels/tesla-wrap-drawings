import * as A from './align.js';
import { MODELS, byCode, loadTemplate } from './models.js';

const WORK = 1200, FULL = 4096, CODE = 2400;
const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';
let photo = null; // { work, full, prep } of the current photo

function draw(bitmap, max) {
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * k), h = Math.round(bitmap.height * k);
  const ctx = new OffscreenCanvas(w, h).getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

const say = (text) => postMessage({ type: 'progress', text });

// Printed sheets name their car twice: the roof mark (always in shot) and the
// website QR's ?car= link (often cropped off). Either also pins down where the
// template sits, which seeds the alignment. Results are in `img` pixels, as
// template → photo point pairs.
async function readSheet(img, tplFor) {
  const mark = A.findMark(img);
  const markId = mark && byCode(mark.code);
  if (markId) {
    const { x, y, r } = A.roofSpot(await tplFor(markId));
    return { id: markId, src: mark.pairs.map(([[u, v]]) => [x + u * r, y + v * r]), dst: mark.pairs.map(([, p]) => p) };
  }
  const jsQR = (await import(JSQR)).default;
  const { width: w, height: h } = img;
  const t = Math.round(Math.max(w, h) * 0.45), step = Math.round(t / 2);
  const regions = [[0, 0, w, h]];
  for (let y = 0; y < h - step; y += step) for (let x = 0; x < w - step; x += step) regions.push([x, y, Math.min(t, w - x), Math.min(t, h - y)]);
  for (const [x, y, rw, rh] of regions) {
    const data = new Uint8ClampedArray(rw * rh * 4);
    for (let r = 0; r < rh; r++) data.set(img.data.subarray(((y + r) * w + x) * 4, ((y + r) * w + x + rw) * 4), r * rw * 4);
    const code = jsQR(data, rw, rh, { inversionAttempts: 'dontInvert' });
    const id = code?.data.match(/[?&]car=([\w-]+)/)?.[1];
    if (!id || !MODELS.some(([m]) => m === id)) continue;
    const tpl = await tplFor(id), L = A.sheetLayout(tpl.width, tpl.height);
    const q = { x: (L.site.x - L.ox) / L.s, y: (L.site.y - L.oy) / L.s, size: L.site.size / L.s };
    const loc = code.location;
    return {
      id,
      src: [[q.x, q.y], [q.x + q.size, q.y], [q.x + q.size, q.y + q.size], [q.x, q.y + q.size]],
      dst: [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner].map((p) => [p.x + x, p.y + y]),
    };
  }
  return null;
}

async function fit(id) {
  const tpl = await loadTemplate(id);
  const model = (fit.models ??= new Map()).get(id) ?? A.templateModel(tpl);
  fit.models.set(id, model);
  const seed = photo.sheet?.id === id ? A.homography(photo.sheet.src, photo.sheet.dst) : null;
  return { id, tpl, fromCode: !!seed, ...A.align(photo.prep, model, seed) };
}

async function run({ bitmap, prefer, force }) {
  if (bitmap) {
    say('Finding the sheet');
    photo = { full: draw(bitmap, FULL), work: draw(bitmap, WORK) };
    const mid = draw(bitmap, CODE);
    bitmap.close();
    photo.prep = A.prepare(photo.work);
    say('Reading the sheet');
    const sheet = await readSheet(mid, loadTemplate).catch(() => null);
    const k = photo.work.width / mid.width;
    photo.sheet = sheet && { id: sheet.id, src: sheet.src, dst: sheet.dst.map(([x, y]) => [x * k, y * k]) };
  }
  let best;
  if (force) {
    say('Lining up the template');
    best = await fit(force);
  } else {
    // Try the car used last time first; only search the rest if it doesn't fit.
    const order = [...new Set([photo.sheet?.id, prefer, ...MODELS.map(([id]) => id)].filter(Boolean))];
    for (const id of order) {
      say(best ? 'Trying other cars' : 'Lining up the template');
      const r = await fit(id).catch(() => null);
      if (r && (!best || r.score > best.score)) best = r;
      if (best && best.score > 0.8) break;
    }
    if (!best) throw new Error("Couldn't download the templates. Check your connection and try again.");
  }
  say('Cutting out the wrap');
  const { tpl, H } = best;
  const k = photo.full.width / photo.work.width;
  const rgb = A.warp(photo.full, A.mul([k, 0, 0, 0, k, 0, 0, 0, 1], H), tpl.width, tpl.height);
  const aligned = A.toImageData(rgb, tpl.width, tpl.height);
  const wrap = A.renderWrap(rgb, tpl);
  postMessage({ type: 'done', id: best.id, score: best.score, hasMarks: best.hasMarks, fromCode: best.fromCode, wrap, aligned, tpl });
}

onmessage = (e) => run(e.data).catch((err) => postMessage({ type: 'error', message: err.message }));
