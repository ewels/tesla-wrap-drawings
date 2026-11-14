// Official templates, loaded live from Tesla's repo so new models only need a line here.
export const MODELS = [
  ['modely', 'Model Y'],
  ['modely-2025-base', 'Model Y (2025+) Standard'],
  ['modely-2025-premium', 'Model Y (2025+) Premium'],
  ['modely-2025-performance', 'Model Y (2025+) Performance'],
  ['modely-l', 'Model Y L'],
  ['model3', 'Model 3'],
  ['model3-2024-base', 'Model 3 (2024+) Standard & Premium'],
  ['model3-2024-performance', 'Model 3 (2024+) Performance'],
  ['models-2021', 'Model S (2021+)'],
  ['models-2025-plaid', 'Model S (2025+) Plaid'],
  ['modelx-2021', 'Model X (2021+)'],
  ['cybertruck', 'Cybertruck'],
];

export const label = (id) => MODELS.find(([m]) => m === id)?.[1] ?? id;

const BASE = 'https://raw.githubusercontent.com/teslamotors/custom-wraps/master/';
const cache = new Map();

export function loadTemplate(id) {
  if (!cache.has(id)) {
    cache.set(id, (async () => {
      const res = await fetch(`${BASE}${id}/template.png`);
      if (!res.ok) throw new Error(`Couldn't download the ${label(id)} template (HTTP ${res.status}).`);
      const bmp = await createImageBitmap(await res.blob());
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, bmp.width, bmp.height);
    })());
    cache.get(id).catch(() => cache.delete(id));
  }
  return cache.get(id);
}
