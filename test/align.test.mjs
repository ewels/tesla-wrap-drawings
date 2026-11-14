// node test/align.test.mjs — synthetic photo through a known homography; alignment must recover it.
import assert from 'node:assert/strict';
import * as A from '../align.js';

const TW = 512, TH = 512;
const tpl = { width: TW, height: TH, data: new Uint8ClampedArray(TW * TH * 4) };
const shapes = [
  (x, y) => ((x - 256) / 120) ** 2 + ((y - 200) / 90) ** 2, // ellipse
  (x, y) => Math.max(Math.abs(x - 90) / 50, Math.abs(y - 300) / 150), // tall box
  (x, y) => Math.max(Math.abs(x - 420) / 50, Math.abs(y - 330) / 120),
  (x, y) => Math.max(Math.abs(x - 256) / 140, Math.abs(y - 440) / 30),
  (x, y) => Math.hypot(x - 380, y - 90) / 45,
];
for (let y = 0; y < TH; y++)
  for (let x = 0; x < TW; x++) {
    const f = Math.min(...shapes.map((s) => s(x, y)));
    if (f > 1) continue;
    const i = (y * TW + x) * 4;
    const edge = shapes.some((s) => Math.abs(s(x, y) - 1) < 0.025);
    tpl.data.set(edge ? [0, 0, 0, 255] : [255, 255, 255, 255], i);
  }

// Template drawn on a page, rotated 180°, photographed at an angle.
const truth = A.homography([[0, 0], [TW, 0], [TW, TH], [0, TH]], [[870, 760], [260, 800], [300, 160], [840, 210]]);
const inv = A.homography([[870, 760], [260, 800], [300, 160], [840, 210]], [[0, 0], [TW, 0], [TW, TH], [0, TH]]);
const PW = 1100, PH = 900;
const photo = { width: PW, height: PH, data: new Uint8ClampedArray(PW * PH * 4) };
const paper = A.homography([[0, 0], [1, 0], [1, 1], [0, 1]], [[180, 90], [960, 120], [990, 860], [150, 830]]);
const paperInv = A.homography([[180, 90], [960, 120], [990, 860], [150, 830]], [[0, 0], [1, 0], [1, 1], [0, 1]]);
for (let y = 0; y < PH; y++)
  for (let x = 0; x < PW; x++) {
    const [px, py] = A.apply(paperInv, x, y);
    let c = px >= 0 && px <= 1 && py >= 0 && py <= 1 ? [235 - x / 40, 232 - x / 40, 225 - x / 40] : [120, 85, 50];
    const [u, v] = A.apply(inv, x, y);
    const ui = Math.floor(u), vi = Math.floor(v);
    if (ui >= 0 && vi >= 0 && ui < TW && vi < TH && A.isTemplateLine(tpl.data, vi * TW + ui)) c = [30, 30, 35];
    // coloured scribbles, including over the outline
    if (Math.sin(x / 9 + y / 31) > 0.93 && Math.abs(Math.sin(y / 17)) > 0.5) c = [40, 150, 60];
    photo.data.set([...c, 255], (y * PW + x) * 4);
  }

const prep = A.prepare(photo);
assert.ok(prep.paper, 'paper found');
const { H, score } = A.align(prep, A.templateModel(tpl));
const err = Math.max(...[[0, 0], [TW, 0], [TW, TH], [0, TH], [TW / 2, TH / 2]].map(([x, y]) => {
  const [a, b] = A.apply(H, x, y), [c, d] = A.apply(truth, x, y);
  return Math.hypot(a - c, b - d);
}));
console.log(`score ${score.toFixed(3)}, max corner error ${err.toFixed(2)} px`);
assert.ok(score > 0.8, 'outline fits');
assert.ok(err < 1.5, 'registration within 1.5 px');

const wrap = A.renderWrap(A.warp(photo, H, TW, TH), tpl);
for (let i = 3; i < wrap.data.length; i += 4) assert.equal(wrap.data[i], tpl.data[i], 'alpha matches template');
console.log('ok');
