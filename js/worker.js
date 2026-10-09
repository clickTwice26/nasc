// Background Monte-Carlo rank-stability analysis (keeps the UI responsive).
import * as E from "./engine.js";

let grid = null, distKnown = null;
const ready = (async () => {
  const [meta, buf, analogs] = await Promise.all([
    fetch("../data/earth.json").then((r) => r.json()),
    fetch("../data/earth.bin").then((r) => r.arrayBuffer()),
    fetch("../data/analogs.json").then((r) => r.json()),
  ]);
  grid = E.ensureRanks(E.decodeGrid(meta, buf));
  distKnown = E.distanceToSites(grid, analogs.filter((a) => !a.facility));
})();

let latest = null;
self.onmessage = async (e) => {
  latest = e.data.key;
  await ready;
  if (e.data.key !== latest) return; // superseded while loading
  const { target, weights, cands, aggregate, filter: f } = e.data;
  const filter = (i) => (!f.onlyNew || distKnown[i] > f.novKm) && (f.accKm >= 1000 || grid.f.d_access[i] <= f.accKm);
  const res = E.robustness(grid, target, weights, cands, { runs: 24, baseOpts: { aggregate, filter } });
  if (e.data.key === latest) self.postMessage({ key: e.data.key, result: [...res] });
};
