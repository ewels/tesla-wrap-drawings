import * as A from './align.js';
import { MODELS, loadTemplate } from './models.js';

const WORK = 1200, FULL = 4096;
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

async function fit(id) {
  const tpl = await loadTemplate(id);
  const model = (fit.models ??= new Map()).get(id) ?? A.templateModel(tpl);
  fit.models.set(id, model);
  return { id, tpl, ...A.align(photo.prep, model) };
}

async function run({ bitmap, prefer, force }) {
  if (bitmap) {
    say('Finding the sheet');
    photo = { full: draw(bitmap, FULL), work: draw(bitmap, WORK) };
    bitmap.close();
    photo.prep = A.prepare(photo.work);
  }
  let best;
  if (force) {
    say('Lining up the template');
    best = await fit(force);
  } else {
    // Try the car used last time first; only search the rest if it doesn't fit.
    const order = [prefer, ...MODELS.map(([id]) => id).filter((id) => id !== prefer)].filter(Boolean);
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
  postMessage({ type: 'done', id: best.id, score: best.score, hasMarks: best.hasMarks, wrap, aligned, tpl });
}

onmessage = (e) => run(e.data).catch((err) => postMessage({ type: 'error', message: err.message }));
