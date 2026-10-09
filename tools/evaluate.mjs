// Reproducible validation run: node tools/evaluate.mjs [preset]
// Writes data/validation.json (consumed by the app's Validation tab and the README).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../js/engine.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export function loadGrid() {
  const meta = JSON.parse(fs.readFileSync(path.join(root, "data/earth.json")));
  const b = fs.readFileSync(path.join(root, "data/earth.bin"));
  return E.decodeGrid(meta, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
export const targets = () => JSON.parse(fs.readFileSync(path.join(root, "data/targets.json")));
export const analogs = () => JSON.parse(fs.readFileSync(path.join(root, "data/analogs.json")));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const grid = loadGrid(), T = targets(), A = analogs();
  const out = { generated: new Date().toISOString().slice(0, 10), presets: {} };
  for (const preset of Object.keys(E.PRESETS)) {
    const rows = [];
    let wlc = [];
    for (const t of T) {
      const S = E.scoreGrid(grid, E.modelFor(grid, t, E.PRESETS[preset].w));
      const v = E.validateTarget(grid, t, A, E.PRESETS[preset].w, S);
      const top = E.topSites(grid, S, { k: 5 }).map((i) => ({ ...E.regionLabel(grid, i), lat: grid.lat[i], lon: grid.lon[i], score: +S[i].toFixed(3) }));
      rows.push({ ...v, body: t.body, name: t.name, top });
      if (preset === "balanced") {
        const Sw = E.scoreGrid(grid, E.modelFor(grid, t, E.PRESETS[preset].w, { aggregate: "wlc" }));
        wlc.push(E.validateTarget(grid, t, A, E.PRESETS[preset].w, Sw).auc);
      }
    }
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    out.presets[preset] = {
      meanAUC: +mean(rows.map((r) => r.auc)).toFixed(3),
      moonAUC: +mean(rows.filter((r) => r.body === "moon").map((r) => r.auc)).toFixed(3),
      marsAUC: +mean(rows.filter((r) => r.body === "mars").map((r) => r.auc)).toFixed(3),
      ...(wlc.length ? { wlcMeanAUC: +mean(wlc).toFixed(3) } : {}),
      targets: rows.map((r) => ({ ...r, auc: +r.auc.toFixed(3), sites: r.sites.map((s) => ({ ...s, pct: +s.pct.toFixed(1), score: +s.score.toFixed(3) })) })),
    };
    console.log(`${preset.padEnd(9)} mean AUC ${out.presets[preset].meanAUC}  moon ${out.presets[preset].moonAUC}  mars ${out.presets[preset].marsAUC}` + (wlc.length ? `  (linear-combination baseline ${out.presets[preset].wlcMeanAUC})` : ""));
  }
  for (const r of out.presets.balanced.targets) console.log(`  ${r.target.padEnd(30)} AUC ${r.auc}  n=${r.n}  median pct ${r.medianPct.toFixed(0)}  top: ${r.top.slice(0, 3).map((t) => t.name || t.country).join(", ")}`);
  fs.writeFileSync(path.join(root, "data/validation.json"), JSON.stringify(out));

  // ---- discoveries: best sites > 300 km from every established analog
  const known = A.filter((a) => !a.facility);
  const D = E.distanceToSites(grid, known);
  const disc = { generated: out.generated, minKm: 300, preset: "balanced", targets: [] };
  for (const t of T) {
    const S = E.scoreGrid(grid, E.modelFor(grid, t, E.PRESETS.balanced.w));
    const picks = E.topSites(grid, S, { k: 4, sepKm: 600, filter: (i) => D[i] > 300 });
    disc.targets.push({
      id: t.id, body: t.body, name: t.name,
      sites: picks.map((i) => {
        let nk = null, nd = Infinity;
        for (const a of known) { const d = E.haversine(grid.lat[i], grid.lon[i], a.lat, a.lon); if (d < nd) { nd = d; nk = a.name; } }
        return { ...E.regionLabel(grid, i), lat: +grid.lat[i].toFixed(2), lon: +grid.lon[i].toFixed(2), score: +S[i].toFixed(3),
          pct: +E.percentileOf(S, S[i]).toFixed(2), nearestKnown: nk, nearestKnownKm: Math.round(nd), accessKm: Math.round(grid.f.d_access[i]),
          koppen: E.koppenOf(grid, i) };
      }),
    });
  }
  fs.writeFileSync(path.join(root, "data/discoveries.json"), JSON.stringify(disc));
  const freq = {};
  for (const t of disc.targets) for (const s of t.sites) { const k = `${s.name || "?"} (${s.country})`; freq[k] = (freq[k] || 0) + 1; }
  console.log("discoveries:", Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}×${v}`).join("; "));
}
