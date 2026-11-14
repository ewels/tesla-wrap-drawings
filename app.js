import { MODELS, label, loadTemplate } from './models.js';
import { isTemplateLine, markCentres, MARK_R } from './align.js';

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
  $('meta').textContent = `${blob.width} × ${blob.height} px · ${kb} KB${blob.posterized ? ' · colours simplified to fit 1 MB' : ''}${data.hasMarks ? ' · registration marks found' : ''}`;
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

async function makeSheet(id) {
  const tpl = await loadTemplate(id);
  const { width: tw, height: th } = tpl;
  const S = 2, M = 56 + MARK_R + 34, FOOT = 72;
  const c = document.createElement('canvas');
  c.width = (tw + 2 * M) * S; c.height = (th + 2 * M + FOOT) * S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);

  const tplCanvas = new OffscreenCanvas(tw, th);
  tplCanvas.getContext('2d').putImageData(tpl, 0, 0);

  // Non-photo blue hatching over everything the car never shows.
  const hatch = new OffscreenCanvas(tw * S, th * S), h = hatch.getContext('2d');
  h.strokeStyle = '#9fd6ef'; h.lineWidth = 1.6 * S;
  for (let d = -th * S; d < tw * S; d += 11 * S) { h.beginPath(); h.moveTo(d, th * S); h.lineTo(d + th * S, 0); h.stroke(); }
  h.globalCompositeOperation = 'destination-out';
  h.drawImage(tplCanvas, 0, 0, tw * S, th * S);

  const lines = new ImageData(tw, th);
  for (let i = 0; i < tw * th; i++) if (isTemplateLine(tpl.data, i)) lines.data[i * 4 + 3] = 255;
  const lineCanvas = new OffscreenCanvas(tw, th);
  lineCanvas.getContext('2d').putImageData(lines, 0, 0);

  ctx.setTransform(S, 0, 0, S, M * S, M * S);
  ctx.drawImage(hatch, 0, 0, tw, th);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(lineCanvas, 0, 0, tw, th);

  // Registration marks: alignment looks for these exact shapes.
  ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
  for (const [x, y] of markCentres(tw, th)) {
    ctx.beginPath(); ctx.arc(x, y, MARK_R, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - MARK_R * 1.6, y); ctx.lineTo(x + MARK_R * 1.6, y);
    ctx.moveTo(x, y - MARK_R * 1.6); ctx.lineTo(x, y + MARK_R * 1.6); ctx.stroke();
  }

  await document.fonts.load('600 26px Archivo');
  ctx.fillStyle = '#4e4b55';
  ctx.font = '600 26px Archivo, sans-serif';
  ctx.textBaseline = 'alphabetic';
  const y = th + M + 30;
  ctx.textAlign = 'left';
  ctx.fillText(label(id).toUpperCase(), 0, y);
  ctx.textAlign = 'right';
  const note = 'Blue hatched areas don’t show on the car';
  ctx.fillText(note, tw, y);
  ctx.fillStyle = '#9fd6ef';
  ctx.fillRect(tw - ctx.measureText(note).width - 40, y - 21, 28, 24);
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
