// Run with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../js/engine.js";
import { loadGrid, targets, analogs } from "../tools/evaluate.mjs";

const grid = loadGrid();
const T = targets();
const A = analogs();
const byId = (id) => T.find((t) => t.id === id);
const at = (lat, lon) => E.nearestCell(grid, lat, lon);

test("grid decodes with sane physical values", () => {
  assert.ok(grid.n > 80000 && grid.n < 100000, `land cells ${grid.n}`);
  const atacama = at(-24.1, -70.0), amazon = at(-3, -60), domeC = at(-75.1, 123.3), tibet = at(33, 88);
  assert.ok(grid.f.precip[atacama] < 60, "Atacama is hyper-arid");
  assert.ok(grid.f.precip[amazon] > 1500, "Amazon is wet");
  assert.ok(grid.f.tmean[domeC] < -45, "Dome C is extremely cold");
  assert.ok(grid.f.ps[tibet] < 62, "Tibetan Plateau has low pressure");
  assert.equal(E.regionLabel(grid, atacama).country, "Chile");
});

test("cellAt / nearestCell round-trip", () => {
  for (let k = 0; k < 200; k++) {
    const i = (k * 433) % grid.n;
    assert.equal(E.cellAt(grid, grid.lat[i], grid.lon[i]), i);
  }
  assert.equal(E.cellAt(grid, 0, -30), -1, "mid-Atlantic is not land");
  assert.ok(at(29.158, -13.438) >= 0, "Lanzarote island resolves to a land cell");
});

test("percentile space is monotonic and bounded", () => {
  let prev = -1;
  for (const x of [-60, -30, 0, 10, 25, 40]) {
    const r = E.cdf(grid, "tmean", x);
    assert.ok(r >= prev && r >= 0 && r <= 1);
    prev = r;
  }
  assert.equal(E.cdf(grid, "tmean", -999), 0);
  assert.equal(E.cdf(grid, "tmean", 999), 1);
});

test("solar geometry: poles see a low Sun, the Moon's pole even more so", () => {
  const eq = E.bodyLighting("earth", 0), arc = E.bodyLighting("earth", 80), moonSP = E.bodyLighting("moon", -89.5);
  assert.ok(eq.lowsun < 0.15 && eq.polarnight === 0);
  assert.ok(arc.lowsun > 0.3 && arc.polarnight > 0.2);
  assert.ok(moonSP.lowsun > 0.99, "lunar south pole: Sun always < 10°");
});

test("scores are bounded and controls rank low", () => {
  const S = E.scoreGrid(grid, E.modelFor(grid, byId("mars-gale"), E.PRESETS.balanced.w));
  for (let i = 0; i < grid.n; i += 97) assert.ok(S[i] >= 0 && S[i] <= 1);
  for (const [lat, lon] of [[-3, -60], [1, 20], [48.85, 2.35], [1.35, 103.8]]) {
    const p = E.percentileOf(S, S[at(lat, lon)]);
    assert.ok(p < 50, `wet/vegetated control at ${lat},${lon} ranked ${p.toFixed(0)}`);
  }
  assert.ok(E.percentileOf(S, S[at(-24.1, -70.02)]) > 85, "Atacama is a top Gale analog");
});

test("lunar south-pole targets prefer polar Earth", () => {
  const S = E.scoreGrid(grid, E.modelFor(grid, byId("moon-connecting-ridge"), E.PRESETS.balanced.w));
  const top = E.topSites(grid, S, { k: 10 });
  const polar = top.filter((i) => Math.abs(grid.lat[i]) > 60).length;
  assert.ok(polar >= 5, `only ${polar}/10 top sites are polar`);
});

test("topSites respects the separation distance", () => {
  const S = E.scoreGrid(grid, E.modelFor(grid, byId("mars-jezero"), E.PRESETS.balanced.w));
  const top = E.topSites(grid, S, { k: 12, sepKm: 500 });
  for (let a = 0; a < top.length; a++) for (let b = a + 1; b < top.length; b++)
    assert.ok(E.haversine(grid.lat[top[a]], grid.lon[top[a]], grid.lat[top[b]], grid.lon[top[b]]) >= 500);
});

test("explainCell reproduces scoreGrid", () => {
  const model = E.modelFor(grid, byId("moon-malapert-massif"), E.PRESETS.isru.w);
  const S = E.scoreGrid(grid, model);
  for (const i of [100, 5000, 40000, at(75.4, -89.7)]) {
    const ex = E.explainCell(grid, model, i);
    assert.ok(Math.abs(ex.score - S[i]) < 1e-5);
    assert.ok(ex.limiting && ex.rows.length > 10);
  }
});

test("regression guard: theme-matched validation AUC", () => {
  const aucs = T.map((t) => E.validateTarget(grid, t, A, E.PRESETS.balanced.w).auc);
  const mean = aucs.reduce((a, b) => a + b) / aucs.length;
  assert.ok(mean > 0.72, `mean AUC dropped to ${mean.toFixed(3)}`);
});

test("data files are well-formed", () => {
  for (const t of T) {
    assert.ok(["moon", "mars"].includes(t.body) && Math.abs(t.lat) <= 90 && Math.abs(t.lon) <= 180, t.id);
    assert.ok(E.CATEGORY_EMPHASIS[t.category], `unknown category ${t.category}`);
    assert.ok(t.sources?.length, `${t.id} needs sources`);
  }
  for (const a of A) assert.ok(a.lat && a.lon && a.themes.length, a.id);
});

test("rank stability is a fraction and the #1 site is stable", () => {
  const t = byId("mars-gale");
  const S = E.scoreGrid(grid, E.modelFor(grid, t, E.PRESETS.astrobio.w));
  const c = E.topSites(grid, S, { k: 6, sepKm: 350 });
  const r = E.robustness(grid, t, E.PRESETS.astrobio.w, c, { runs: 6 });
  for (const v of r.values()) assert.ok(v >= 0 && v <= 1);
  assert.ok(r.get(c[0]) >= 0.8, "top analog should survive weight jitter");
});

test("lunar lighting matches Earth's high latitudes, not the tropics", () => {
  const ideals = E.targetIdeals(byId("moon-malapert-massif"), grid);
  const r0 = E.cdf(grid, "lowsun", ideals.lowsun.ideal);
  assert.ok(r0 > 0.9, "lunar south pole maps to Earth's lowest-Sun cells");
});
