import { MODELS, label, loadTemplate, codeOf } from './models.js';
import { isTemplateLine, markCentres, roofSpot, markBits, sheetLayout, MM, MARK, MARK_R } from './align.js';

const $ = (id) => document.getElementById(id);
const sheet = $('sheet'), view = $('view'), modelSelect = $('model'), printSelect = $('print-model');
const MAX_BYTES = 1_000_000; // Tesla's limit is "1 MB"; stay under the decimal reading
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const options = (ids) => ids.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
function fillModels(detected) {
  const rest = MODELS.filter(([id]) => id !== detected);
  modelSelect.innerHTML = detected
    ? `<optgroup label="Detected">${options(MODELS.filter(([id]) => id === detected))}</optgroup><optgroup label="Other cars">${options(rest)}</optgroup>`
    : options(MODELS);
}
fillModels();
printSelect.innerHTML = options(MODELS);
// Sheets link here with ?car=, so a scanned sheet opens on the right car.
const linked = new URLSearchParams(location.search).get('car');
if (MODELS.some(([id]) => id === linked)) store.set('model', linked);
printSelect.value = store.get('model') || 'modely';

let worker, result, downloadUrl, detectedId, forcing = false;

function startWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') $('busy-text').textContent = data.text;
    else if (data.type === 'error') fail(data.message);
    else if (data.type === 'done') show(data);
  };
  worker.onerror = () => fail('Something went wrong while processing the photo. Try again, or try a different photo.');
}

function setState(state) {
  sheet.dataset.state = state;
  $('controls').hidden = state !== 'done';
  $('intro').hidden = state === 'done';
}

function fail(message) {
  forcing = false;
  setState('empty');
  $('controls').hidden = false;
  $('intro').hidden = false;
  for (const el of $('controls').children) el.hidden = el.id !== 'notice';
  notice(message, true);
}

function notice(text, isError = false) {
  const el = $('notice');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', isError);
}

async function decode(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    // Safari decodes HEIC natively; Chrome and Firefox need libheif.
    const { heicTo } = await import('https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/heic-to.js');
    return heicTo({ blob: file, type: 'bitmap' });
  }
}

async function handle(file) {
  if (!file) return;
  for (const el of $('controls').children) el.hidden = el.id === 'notice' || el.id === 'share';
  notice('');
  setState('busy');
  $('busy-text').textContent = 'Reading the photo';
  let bitmap;
  try {
    bitmap = await decode(file);
  } catch {
    return fail("That file couldn't be opened as a photo. Try a JPEG, HEIC or PNG.");
  }
  const k = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
  const thumb = document.createElement('canvas');
  thumb.width = bitmap.width * k; thumb.height = bitmap.height * k;
  thumb.getContext('2d').drawImage(bitmap, 0, 0, thumb.width, thumb.height);
  $('busy-photo').src = thumb.toDataURL('image/jpeg', 0.7);
  if (!worker) startWorker();
  worker.postMessage({ bitmap, prefer: store.get('model') || 'modely' }, [bitmap]);
}

function checkOverlay(tpl) {
  const c = document.createElement('canvas');
  c.width = tpl.width; c.height = tpl.height;
  const img = new ImageData(tpl.width, tpl.height);
  for (let i = 0; i < tpl.width * tpl.height; i++)
    if (isTemplateLine(tpl.data, i)) img.data.set([228, 0, 124, 255], i * 4);
    else if (tpl.data[i * 4 + 3] < 128) img.data[i * 4 + 3] = 51;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

let car3d;
const get3d = () => (car3d ??= import('./car3d.js').catch((err) => { car3d = null; throw err; }));
const preload3d = (id) => get3d().then((m) => m.preload(id)).catch(() => {});

async function load3d(id, wrap) {
  const bar = $('load3d'), fill = bar.querySelector('span');
  let mod, raf;
  // Only show the bar if loading is noticeable, so cached cars don't flash it.
  const reveal = setTimeout(() => { bar.hidden = false; }, 150);
  const tick = () => {
    const p = mod?.progress(id);
    bar.classList.toggle('indeterminate', p == null);
    fill.style.width = `${(p ?? 0) * 100}%`;
    raf = requestAnimationFrame(tick);
  };
  tick();
  try {
    mod = await get3d();
    await mod.show($('view3d'), id, wrap);
  } catch {
    notice('The 3D car couldn’t be loaded. Check your connection and try again.');
    set3d(false);
  } finally {
    clearTimeout(reveal);
    cancelAnimationFrame(raf);
    bar.hidden = true;
  }
}

async function show(data) {
  preload3d(data.id);
  result = { ...data, wrap: toImageData(data.wrap), aligned: toImageData(data.aligned), outline: checkOverlay(data.tpl) };
  store.set('model', data.id);
  if (!forcing) fillModels(detectedId = data.id);
  forcing = false;
  modelSelect.value = data.id;
  printSelect.value = data.id;
  $('detected').hidden = data.id !== detectedId;
  sheet.style.setProperty('--ar', data.tpl.width / data.tpl.height);
  view.width = data.tpl.width; view.height = data.tpl.height;
  if (!$('name').dataset.touched) $('name').value = `${label(data.id).replace(/\s*\(.*\)/, '')} wrap`.slice(0, 26);
  draw();
  setState('done');

  if (data.score < 0.6)
    notice('This might not be lined up right. Switch to Check alignment: the pink outline should sit on the printed lines. If it doesn’t, pick the right car above, or retake the photo flat-on in even light with the whole sheet in view.');

  const blob = await encode(result.wrap);
  result.blob = blob;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob.blob);
  $('download').href = downloadUrl;
  updateName();
  const file = new File([blob.blob], fileName(), { type: 'image/png' });
  $('share').hidden = !navigator.canShare?.({ files: [file] });
  const kb = Math.round(blob.blob.size / 1000), pct = Math.round(data.score * 100);
  $('meta').textContent = `${blob.width} × ${blob.height} px · ${kb} KB${blob.posterized ? ' · colours simplified to fit 1 MB' : ''}${data.fromCode ? ' · sheet recognised' : ''}${data.hasMarks ? ' · registration marks found' : ''}`;
  $('slug').innerHTML = `<span>${label(data.id)}</span><span>Outline matched ${pct}%</span><span>${blob.width}×${blob.height} · ${kb} KB</span>`;
}

const toImageData = ({ width, height, data }) => new ImageData(new Uint8ClampedArray(data), width, height);

function draw() {
  const ctx = view.getContext('2d');
  const mode = $('show3d').ariaPressed === 'true' ? '3d' : document.querySelector('input[name=view]:checked').value;
  const check = mode === 'check';
  sheet.dataset.view = mode;
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.putImageData(check ? result.aligned : result.wrap, 0, 0);
  if (check) ctx.drawImage(result.outline, 0, 0);
  view.setAttribute('aria-label', check ? 'Photo with the template outline drawn over it in pink and the parts left off the car shaded' : 'Finished wrap');
  $('view3d').hidden = mode !== '3d';
  if (mode === '3d')
    load3d(result.id, result.wrap);
  else $('load3d').hidden = true;
}

// Canvas PNGs of crayon texture can blow past Tesla's limit, so step down:
// fewer colour levels first, then smaller sizes (512 is Tesla's minimum).
async function encode(img) {
  const steps = [[false, 1], [true, 1], [true, 0.875], [true, 0.75], [true, 0.625], [true, 0.5]];
  let out;
  for (const [posterize, scale] of steps) {
    let src = img;
    if (posterize) {
      src = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
      for (let i = 0; i < src.data.length; i++) if (i % 4 !== 3) src.data[i] = Math.min(255, Math.round(src.data[i] / 8) * 8);
    }
    const full = document.createElement('canvas');
    full.width = img.width; full.height = img.height;
    full.getContext('2d').putImageData(src, 0, 0);
    let c = full;
    if (scale < 1) {
      c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(full, 0, 0, c.width, c.height);
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    out = { blob, width: c.width, height: c.height, posterized: posterize };
    if (blob.size <= MAX_BYTES) break;
  }
  return out;
}

const fileName = () => `${$('name').value.replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 26) || 'Wrap'}.png`;
function updateName() { $('download').download = fileName(); }

$('file').addEventListener('change', (e) => { handle(e.target.files[0]); e.target.value = ''; });
$('name').addEventListener('input', (e) => { e.target.dataset.touched = '1'; updateName(); });
$('restart').addEventListener('click', () => { setState('empty'); notice(''); $('file').click(); });
$('share').addEventListener('click', () => navigator.share({ files: [new File([result.blob.blob], fileName(), { type: 'image/png' })] }).catch(() => {}));
function set3d(on) {
  $('show3d').ariaPressed = String(on);
  $('show3d').lastChild.textContent = on ? 'Back to the flat wrap' : 'See it on the car in 3D';
  draw();
}
$('show3d').addEventListener('click', () => set3d($('show3d').ariaPressed !== 'true'));
document.querySelectorAll('input[name=view]').forEach((r) => r.addEventListener('click', () => set3d(false)));
modelSelect.addEventListener('change', () => {
  store.set('model', modelSelect.value);
  preload3d(modelSelect.value);
  for (const el of $('controls').children) el.hidden = el.id === 'notice' || el.id === 'share';
  notice('');
  setState('busy');
  forcing = true;
  worker.postMessage({ force: modelSelect.value });
});

let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = [...(e.dataTransfer?.files || [])][0];
  if (file) { handle(file); $('make').scrollIntoView({ block: 'start' }); }
});
addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) handle(f); });

// ---------- printable sheets ----------

const UQR = 'https://cdn.jsdelivr.net/npm/uqr@0.1.3/dist/index.mjs';
const SITE = 'https://ewels.github.io/tesla-wrap-drawings/';
const C = { ink: '#17161b', ink2: '#4e4b55', rule: '#cfc8b8', npb: '#9fd6ef', cyan: '#009fe3', magenta: '#e4007c', yellow: '#ffe500' };

function drawQR(ctx, encode, text, x, y, size, ecc) {
  const { data } = encode(text, { ecc, border: 0 });
  const n = data.length, m = size / n;
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 2 * m, y - 2 * m, size + 4 * m, size + 4 * m);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (data[r][c]) ctx.fillRect(x + c * m, y + r * m, m + 0.5, m + 0.5);
}

// Mirrors markInk in align.js, which the reader is tested against.
function drawMark(ctx, { x, y, r }, bits) {
  const n = MARK.segments, top = -Math.PI / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(0, 0, MARK.clear * r, 0, 2 * Math.PI); ctx.fill();
  ctx.fillStyle = '#000';
  bits.forEach((bit, i) => {
    if (!bit) return;
    const a0 = top + (i / n) * 2 * Math.PI, a1 = top + ((i + 1) / n) * 2 * Math.PI;
    ctx.beginPath(); ctx.arc(0, 0, MARK.dataOut * r, a0, a1); ctx.arc(0, 0, MARK.dataIn * r, a1, a0, true); ctx.fill();
  });
  ctx.beginPath(); ctx.arc(0, 0, MARK.ringOut * r, 0, 2 * Math.PI); ctx.arc(0, 0, MARK.ringIn * r, 0, 2 * Math.PI, true); ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, MARK.dot * r, 0, 2 * Math.PI); ctx.fill();
  const t = 0.035 * r;
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]])
    ctx.fillRect(dx ? Math.min(dx * MARK.tickIn, dx * MARK.tickOut) * r : -t, dy ? Math.min(dy * MARK.tickIn, dy * MARK.tickOut) * r : -t, dx ? (MARK.tickOut - MARK.tickIn) * r : 2 * t, dy ? (MARK.tickOut - MARK.tickIn) * r : 2 * t);
  ctx.restore();
}

// Car name beside the roof mark (below, or above if that's roomier), shrunk or
// wrapped to stay clear of the car's panels.
function drawChip(ctx, tpl, { x, y, r }, text, size) {
  const { width: tw, height: th, data } = tpl;
  const mono = (px) => { ctx.font = `600 ${px}px ui-monospace, 'SF Mono', Menlo, Consolas, monospace`; ctx.letterSpacing = `${px * 0.08}px`; };
  const free = (xx, yy) => yy >= 0 && yy < th && data[(Math.round(yy) * tw + Math.round(xx)) * 4 + 3] === 0;
  // Usable width for a chip spanning rows top..top+h, centred on the mark.
  const room = (top, h) => {
    let half = tw / 2;
    for (let yy = Math.floor(top); yy <= top + h; yy++) {
      let l = 0, rr = 0;
      while (x - l > 0 && free(x - l, yy)) l++;
      while (x + rr < tw - 1 && free(x + rr, yy)) rr++;
      half = Math.min(half, l, rr);
    }
    return 2 * half - size;
  };
  const gap = (MARK.tickOut + 0.25) * r;
  const split = text.indexOf(' (');
  const layouts = [[text]];
  if (split > 0) layouts.push([text.slice(0, split), text.slice(split + 1)]);
  let best = { scale: -1 };
  for (const lines of layouts)
    for (const below of [true, false]) {
      mono(size);
      const wide = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 1.1;
      const h = size * (0.5 + 1.25 * lines.length);
      const top = below ? y + gap : y - gap - h;
      // Prefer one line below the mark; wrap or move up only when it buys real size.
      const scale = Math.min(1, room(top, h) / wide) - (lines.length - 1) * 0.08 - (below ? 0 : 0.04);
      if (scale > best.scale) best = { scale, lines, below };
    }
  const px = size * Math.max(0.55, Math.min(1, best.scale + (best.lines.length - 1) * 0.08 + (best.below ? 0 : 0.04)));
  mono(px);
  const { lines } = best;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + px * 1.1, h = px * (0.5 + 1.25 * lines.length);
  const top = best.below ? y + gap : y - gap - h;
  ctx.fillStyle = C.ink;
  ctx.beginPath(); ctx.roundRect(x - w / 2, top, w, h, px * 0.3); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((l, i) => ctx.fillText(l, x + px * 0.04, top + px * (0.25 + 1.25 * i + 0.66)));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.letterSpacing = '0px';
}

function target(ctx, x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = color;
  ctx.lineWidth = r * 0.13;
  ctx.beginPath(); ctx.arc(x, y, r * 0.47, 0, 2 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r * 0.17, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
}

const font = (ctx, size, weight = 400, stretch = 'normal') => { ctx.font = `${weight} ${size}px Archivo, sans-serif`; ctx.fontStretch = stretch; };

// Word-wraps runs of [text, weight] into width; returns the y after the last line.
function paragraph(ctx, runs, x, y, width, size, color, lead = 1.38) {
  const words = runs.flatMap(([t, w]) => t.split(/(?<=\s)/).map((word) => [word, w]));
  let cx = x;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  for (const [word, w] of words) {
    font(ctx, size, w);
    const ww = ctx.measureText(word.trimEnd()).width;
    if (cx > x && cx + ww > x + width) { cx = x; y += size * lead; }
    ctx.fillText(word, cx, y);
    cx += ctx.measureText(word).width;
  }
  return y + size * lead;
}

async function makeSheet(id) {
  const [tpl, { encode }] = await Promise.all([loadTemplate(id), import(UQR)]);
  await Promise.all([400, 650, 800].map((w) => document.fonts.load(`${w} 40px Archivo`)));
  const { width: tw, height: th } = tpl;
  const { W, H, m, s, ox, oy, x0, cw, barH, site } = sheetLayout(tw, th);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  const tplCanvas = new OffscreenCanvas(tw, th);
  tplCanvas.getContext('2d').putImageData(tpl, 0, 0);

  // Non-photo blue hatching over everything the car never shows.
  const hw = Math.round(tw * s), hh = Math.round(th * s);
  const hatch = new OffscreenCanvas(hw, hh), h = hatch.getContext('2d');
  h.strokeStyle = C.npb; h.lineWidth = 0.3 * MM;
  for (let d = -hh; d < hw; d += 1.9 * MM) { h.beginPath(); h.moveTo(d, hh); h.lineTo(d + hh, 0); h.stroke(); }
  h.globalCompositeOperation = 'destination-out';
  h.drawImage(tplCanvas, 0, 0, hw, hh);

  const lines = new ImageData(tw, th);
  for (let i = 0; i < tw * th; i++) if (isTemplateLine(tpl.data, i)) lines.data[i * 4 + 3] = 255;
  const lineCanvas = new OffscreenCanvas(tw, th);
  lineCanvas.getContext('2d').putImageData(lines, 0, 0);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.drawImage(hatch, 0, 0, tw * s, th * s);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lineCanvas, 0, 0, tw * s, th * s);
  ctx.scale(s, s);
  // Some templates (Cybertruck) run panels off the image edge. Close them with
  // a line just outside the template, where the wrap is never sampled.
  ctx.fillStyle = '#000';
  const t = 5;
  // Edge pixels are anti-aliased, so look a few pixels in.
  const on = (x, y) => [0, 1, 2, 3].some((d) => {
    const px = x === 0 ? d : x === tw - 1 ? tw - 1 - d : x, py = y === 0 ? d : y === th - 1 ? th - 1 - d : y;
    return tpl.data[(py * tw + px) * 4 + 3] > 128;
  });
  for (let x = 0; x < tw; x++) {
    if (on(x, 0)) ctx.fillRect(x - 0.01, -t - 0.5, 1.02, t);
    if (on(x, th - 1)) ctx.fillRect(x - 0.01, th + 0.5, 1.02, t);
  }
  for (let y = 0; y < th; y++) {
    if (on(0, y)) ctx.fillRect(-t - 0.5, y - 0.01, t, 1.02);
    if (on(tw - 1, y)) ctx.fillRect(tw + 0.5, y - 0.01, t, 1.02);
  }
  for (const [x, y, cx, cy] of [[0, 0, -t - 0.5, -t - 0.5], [tw - 1, 0, tw + 0.5, -t - 0.5], [tw - 1, th - 1, tw + 0.5, th + 0.5], [0, th - 1, -t - 0.5, th + 0.5]])
    if (on(x, y)) ctx.fillRect(cx, cy, t, t);

  // Registration marks: alignment looks for these exact shapes.
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
  for (const [x, y] of markCentres(tw, th)) {
    ctx.beginPath(); ctx.arc(x, y, MARK_R, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - MARK_R * 1.6, y); ctx.lineTo(x + MARK_R * 1.6, y);
    ctx.moveTo(x, y - MARK_R * 1.6); ctx.lineTo(x, y + MARK_R * 1.6); ctx.stroke();
  }
  const spot = roofSpot(tpl);
  drawMark(ctx, spot, markBits(codeOf(id)));
  drawChip(ctx, tpl, spot, label(id).toUpperCase(), (2.3 * MM) / s);
  ctx.restore();

  // Instructions column.
  ctx.fillStyle = C.rule;
  ctx.fillRect(x0 - 4.5 * MM, m + 4 * MM, 0.25 * MM, H - 2 * m - 8 * MM);

  let y = m + 4 * MM;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const tr = 4.6 * MM, tx = x0 + tr, ty = y + 5.2 * MM;
  target(ctx, tx - 0.9 * MM, ty + 0.55 * MM, tr, C.cyan);
  target(ctx, tx + 0.9 * MM, ty - 0.4 * MM, tr, C.magenta);
  target(ctx, tx + 0.2 * MM, ty + 0.9 * MM, tr, C.yellow);
  ctx.restore();
  const ws = 9.4 * MM;
  font(ctx, ws, 800, 'semi-expanded');
  ctx.fillStyle = C.ink;
  ctx.fillText('Crayon', x0 + 2 * tr + 3 * MM, y + 0.78 * ws);
  ctx.fillText('to Car', x0 + 2 * tr + 3 * MM, y + 1.7 * ws);
  y += 2 * ws + 5 * MM;

  y = paragraph(ctx, [['Colour in the car, then make it a wrap for a real Tesla.', 400]], x0, y, cw, 4.3 * MM, C.ink2, 1.32);
  y += 4 * MM;

  const steps = [
    [C.cyan, '#fff', 'Colour it in. ', 'Anything goes. Skip the blue stripes: they don’t show on the car.'],
    [C.magenta, '#fff', 'Take a photo ', 'of the whole page, flat and in good light.'],
    [C.yellow, C.ink, 'Scan the code ', 'below and add your photo.'],
    [C.ink, '#fff', 'Download the wrap. ', 'Upload it in the Tesla app under Creations › Wrap, or copy it to a Wraps folder on a USB stick.'],
  ];
  const ts = 3.55 * MM, dr = 2.7 * MM, indent = 2 * dr + 2.6 * MM;
  steps.forEach(([bg, fg, lead, rest], i) => {
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(x0 + dr, y - ts * 0.36, dr, 0, 2 * Math.PI); ctx.fill();
    font(ctx, ts * 0.92, 800);
    ctx.fillStyle = fg; ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), x0 + dr, y - ts * 0.36 + ts * 0.33);
    ctx.textAlign = 'left';
    y = paragraph(ctx, [[lead, 650], [rest, 400]], x0 + indent, y, cw - indent, ts, C.ink, 1.36) + 2.4 * MM;
  });

  // Website code near the bottom, with a line to sign above it.
  const { y: qy, size: qs } = site;
  const caps = (text, x, y) => {
    font(ctx, 3.1 * MM, 650, 'condensed');
    ctx.fillStyle = C.ink;
    ctx.letterSpacing = `${0.3 * MM}px`;
    ctx.fillText(text, x, y);
    const w = ctx.measureText(text).width;
    ctx.letterSpacing = '0px';
    return w;
  };
  const sy = qy - 15 * MM;
  const sx = x0 + caps('DRAWN BY', x0, sy) + 4 * MM;
  ctx.fillStyle = C.rule;
  ctx.fillRect(sx, sy + 0.6 * MM, x0 + cw - sx, 0.3 * MM);
  caps('SCAN TO START', x0, qy - 3.6 * MM);
  drawQR(ctx, encode, `${SITE}?car=${id}`, x0, qy, qs, 'M');
  paragraph(ctx, [['Free, and it runs in the browser. Photos stay on your phone.', 400]], x0 + qs + 4 * MM, qy + 2.6 * MM, cw - qs - 4 * MM, 2.8 * MM, C.ink2, 1.35);
  paragraph(ctx, [['ewels.github.io/tesla-wrap-drawings', 650]], x0, qy + qs + 5.2 * MM, cw, 3.1 * MM, C.ink, 1.3);

  // Footer: car, sheet code, and the site's colour bar.
  const fy = H - m - barH - 2.4 * MM;
  font(ctx, 2.7 * MM, 650, 'condensed');
  ctx.letterSpacing = `${0.25 * MM}px`;
  ctx.fillStyle = C.ink;
  ctx.fillText(label(id).toUpperCase(), x0, fy);
  ctx.textAlign = 'right';
  ctx.fillStyle = C.ink2;
  ctx.fillText('NOT AFFILIATED WITH TESLA', W - m, fy);
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0px';
  const bar = [C.cyan, C.magenta, C.yellow, C.ink, '#80cff1', '#f17fbd', '#fff280', '#a2a1a4'];
  bar.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(x0 + (cw * i) / 8, H - m - barH, cw / 8 + 0.5, barH); });

  return new Promise((r) => c.toBlob(r, 'image/png'));
}

let sheetUrl;
async function refreshSheet() {
  const id = printSelect.value;
  try {
    const blob = await makeSheet(id);
    if (printSelect.value !== id) return;
    if (sheetUrl) URL.revokeObjectURL(sheetUrl);
    sheetUrl = URL.createObjectURL(blob);
    $('print-img').src = sheetUrl;
    $('printable-img').src = sheetUrl;
    $('sheet-download').href = sheetUrl;
    $('sheet-download').download = `${label(id)} colouring sheet.png`;
  } catch (e) {
    $('print-img').alt = e.message;
  }
}
printSelect.addEventListener('change', refreshSheet);
$('print-button').addEventListener('click', () => {
  const img = $('printable-img');
  if (img.complete && img.naturalWidth) print(); else img.onload = () => print();
});
refreshSheet();

navigator.serviceWorker?.register('sw.js').catch(() => {});

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (!standalone && (ios || matchMedia('(pointer: coarse)').matches) && !store.get('install-dismissed')) {
  let prompt;
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    $('install-button').hidden = false;
    $('install').hidden = false;
  });
  if (ios) {
    // A web page's share sheet never offers Add to Home Screen; only Safari's own Share button does.
    $('install-text').innerHTML = `In Safari, tap <b>Share</b> <svg class="share-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v10M6.5 6 10 2.5 13.5 6M6 9H4.5v8.5h11V9H14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg> (under <b>•••</b> on newer iPhones), then <b>Add to Home Screen</b>.`;
    $('install').hidden = false;
  }
  $('install-button').addEventListener('click', async () => {
    prompt.prompt();
    if ((await prompt.userChoice).outcome === 'accepted') $('install').hidden = true;
  });
  $('install-close').addEventListener('click', () => { $('install').hidden = true; store.set('install-dismissed', '1'); });
}
