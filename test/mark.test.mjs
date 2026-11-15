// node test/mark.test.mjs — render a sheet mark through a known perspective; the reader must recover code and pose.
import assert from 'node:assert/strict';
import * as A from '../align.js';

const R = 40, cx = 300, cy = 260;
for (const [code, quad] of [
  [7, [[180, 140], [470, 170], [450, 420], [160, 390]]],
  [12, [[470, 410], [160, 400], [190, 120], [440, 150]]], // upside down
  [200, [[260, 120], [470, 260], [330, 470], [120, 330]]], // turned 45°
]) {
  const bits = A.markBits(code);
  const box = [[cx - 2 * R, cy - 2 * R], [cx + 2 * R, cy - 2 * R], [cx + 2 * R, cy + 2 * R], [cx - 2 * R, cy + 2 * R]];
  const inv = A.homography(quad, box);
  const W = 640, H = 560, img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [u, v] = A.apply(inv, x + 0.5, y + 0.5);
      const mu = (u - cx) / R, mv = (v - cy) / R, r = Math.hypot(mu, mv);
      let c = (u + v) % 9 < 1.6 ? [159, 214, 239] : [236, 232, 224];
      if (r < A.MARK.clear) c = [244, 242, 236];
      if (Math.sin(x / 7 + y / 23) > 0.9 && r > A.MARK.clear) c = [220, 60, 50];
      if (A.markInk(mu, mv, bits)) c = [35, 33, 38];
      img.data.set([...c, 255], (y * W + x) * 4);
    }
  const got = A.findMark(img);
  assert.ok(got, `mark ${code} found`);
  assert.equal(got.code, code);
  const truth = A.homography(box.map(([x, y]) => [(x - cx) / R, (y - cy) / R]), quad);
  const err = Math.max(...got.pairs.map(([[u, v], [x, y]]) => { const [tx, ty] = A.apply(truth, u, v); return Math.hypot(tx - x, ty - y); }));
  console.log(`code ${code}: pose error ${err.toFixed(2)} px`);
  assert.ok(err < 4, 'pose within 4 px');
}
console.log('ok');
