// Analog Atlas — scoring engine.
// Pure functions, no DOM: shared by the browser app and the Node test-suite.
//
// Method (see methods.html for the full write-up):
//  1. Every Earth land cell (0.5°) carries ~30 environmental features from NASA POWER
//     (MERRA-2, CERES, GPM IMERG), NOAA ETOPO1, solar geometry and geology layers.
//  2. A planetary target (e.g. Artemis III "Malapert Massif", Mars "Jezero") is translated
//     into an *ideal Earth value* per feature. Values beyond anything found on Earth are
//     clamped to Earth's attainable envelope (1st–99th percentile) — the most extreme
//     analog Earth can offer.
//  3. Per-feature similarity is measured in *percentile space*: if F is Earth's empirical
//     distribution of a feature over all land cells, sim = (1 − |F(x) − F(ideal)|)^k.
//     "How much of Earth's land lies between this site and the target condition?"
//     It is unit-free, robust to skewed data and needs no hand-tuned tolerances.
//     Geology layers (distance to volcanoes, impact structures, playas, ice) use a
//     distance-decay kernel.
//  4. Features are averaged within six factor groups; groups are combined with a weighted
//     geometric mean (non-compensatory multi-criteria decision analysis).

export const GROUPS = {
  thermal:    { label: "Thermal regime",        icon: "🌡" },
  water:      { label: "Aridity & biosphere",   icon: "💧" },
  atmosphere: { label: "Atmosphere & radiation", icon: "☀" },
  terrain:    { label: "Terrain",               icon: "⛰" },
  geology:    { label: "Geology & ice",         icon: "🪨" },
  lighting:   { label: "Polar lighting",        icon: "🌗" },
};

// Feature definitions used for scoring. `t` = transform for comparison.
//  kind 'rank' (default): (1 − |F(x) − F(ideal)|)^k with F = Earth land-cell CDF
//  kind 'near'          : 1/(1+(d/L)²) on a distance layer (km)
export const FEATURES = {
  tmean:  { group: "thermal",    t: "lin" },
  tcold:  { group: "thermal",    t: "lin" },
  dtr:    { group: "thermal",    t: "lin" },
  tsoil:  { group: "thermal",    t: "lin" },
  precip: { group: "water",      t: "log", c: 1 },
  qv:     { group: "water",      t: "log", c: 0.05 },
  soilw:  { group: "water",      t: "lin" },
  et:     { group: "water",      t: "log", c: 0.5 },
  ps:     { group: "atmosphere", t: "lin" },
  uv:     { group: "atmosphere", t: "lin" },
  cloud:  { group: "atmosphere", t: "lin" },
  albedo: { group: "atmosphere", t: "lin" },
  relief: { group: "terrain",    t: "log", c: 10 },
  slope:  { group: "terrain",    t: "log", c: 0.05 },
  ice:    { group: "geology",    t: "lin" },
  d_ice:  { group: "geology",    kind: "near", L: 50 },
  d_volcano: { group: "geology", kind: "near", L: 60 },
  d_crater:  { group: "geology", kind: "near", L: 40 },
  d_playa:   { group: "geology", kind: "near", L: 60 },
  lowsun:     { group: "lighting", t: "lin" },
  polarnight: { group: "lighting", t: "lin" },
};

export const SHARP = 3; // exponent k of the percentile-space kernel

// Mission-objective presets: weight per group (0–3).
export const PRESETS = {
  balanced: { label: "Balanced fidelity", blurb: "All environmental factors equally weighted.",
    w: { thermal: 2, water: 2, atmosphere: 2, terrain: 2, geology: 2, lighting: 2 } },
  habitat: { label: "Base habitat & crew ops", blurb: "Long-duration isolation, cold, darkness and logistics — tests habitats, life support and crews.",
    w: { thermal: 3, water: 2, atmosphere: 1, terrain: 1, geology: 1, lighting: 3 } },
  mobility: { label: "Rover & EVA mobility", blurb: "Unvegetated, dry, rugged regolith-like terrain for rovers, spacesuits and navigation.",
    w: { thermal: 1, water: 3, atmosphere: 1, terrain: 3, geology: 2, lighting: 1 } },
  isru: { label: "ISRU: water-ice prospecting", blurb: "Frozen ground, buried or nearby ice and extreme cold — drills, excavation and ice extraction.",
    w: { thermal: 3, water: 1, atmosphere: 1, terrain: 1, geology: 3, lighting: 1 } },
  astrobio: { label: "Astrobiology & life detection", blurb: "Hyper-aridity, high UV, salts and volcanics — instruments that search for (or must not mistake) life.",
    w: { thermal: 2, water: 3, atmosphere: 3, terrain: 1, geology: 2, lighting: 0 } },
  power: { label: "Polar lighting & power", blurb: "Grazing Sun, long shadows and polar night — solar power, optical navigation and landing sensors.",
    w: { thermal: 2, water: 1, atmosphere: 1, terrain: 2, geology: 1, lighting: 3 } },
};

// How strongly each factor group defines a *kind* of site (multiplies the preset weight).
export const CATEGORY_EMPHASIS = {
  "south-pole":  { thermal: 1.4, lighting: 1.6, geology: 1.2 },
  "polar":       { thermal: 1.5, geology: 1.4, lighting: 1.2 },
  "ground-ice":  { thermal: 1.5, geology: 1.4 },
  "lava-tube":   { geology: 1.6, water: 1.2 },
  "volcanic":    { geology: 1.5, atmosphere: 1.2 },
  "mare":        { geology: 1.4, water: 1.2 },
  "sedimentary": { water: 1.3, geology: 1.4 },
  "crater-lake": { water: 1.3, geology: 1.4 },
  "canyon":      { terrain: 1.5, geology: 1.2 },
};

const BODY = {
  earth: { obliquity: 23.44 },
  moon: { obliquity: 1.54 },
  mars: { obliquity: 25.19 },
};

// ------------------------------------------------------------------ data decoding
export function decodeGrid(meta, buffer) {
  const n = meta.count;
  const idx = new Uint32Array(buffer, 0, n);
  let off = 4 * n;
  const f = {};
  for (const fm of meta.features) {
    const q = new Uint16Array(buffer, off, n);
    off += 2 * n;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = fm.offset + q[i] * fm.scale;
    f[fm.id] = v;
  }
  const cat = {};
  for (const name of meta.categorical) {
    cat[name] = new Uint16Array(buffer, off, n);
    off += 2 * n;
  }
  const { res, nx, lat0, lon0 } = meta.grid;
  const lat = new Float32Array(n), lon = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.floor(idx[i] / nx), c = idx[i] % nx;
    lat[i] = lat0 - r * res;
    lon[i] = lon0 + c * res;
  }
  const fmeta = Object.fromEntries(meta.features.map((m) => [m.id, m]));
  return { n, idx, lat, lon, f, cat, meta, fmeta };
}

export function cellAt(grid, latDeg, lonDeg) {
  const { res, nx, lat0, lon0 } = grid.meta.grid;
  const r = Math.round((lat0 - latDeg) / res), c = ((Math.round((lonDeg - lon0) / res) % nx) + nx) % nx;
  const key = r * nx + c;
  // binary search in sorted idx
  let lo = 0, hi = grid.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (grid.idx[mid] === key) return mid;
    if (grid.idx[mid] < key) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** Nearest land cell within `maxKm` (spiral search on the grid). */
export function nearestCell(grid, latDeg, lonDeg, maxKm = 120) {
  const direct = cellAt(grid, latDeg, lonDeg);
  if (direct >= 0) return direct;
  const res = grid.meta.grid.res;
  let best = -1, bestD = Infinity;
  const steps = Math.ceil(maxKm / 55);
  for (let dr = -steps; dr <= steps; dr++) {
    for (let dc = -steps * 2; dc <= steps * 2; dc++) {
      const j = cellAt(grid, latDeg + dr * res, lonDeg + dc * res);
      if (j < 0) continue;
      const d = haversine(latDeg, lonDeg, grid.lat[j], grid.lon[j]);
      if (d < bestD) { bestD = d; best = j; }
    }
  }
  return bestD <= maxKm ? best : -1;
}

export function haversine(la1, lo1, la2, lo2) {
  const R = 6371, d = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * d) / 2) ** 2 +
    Math.cos(la1 * d) * Math.cos(la2 * d) * Math.sin(((lo2 - lo1) * d) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ------------------------------------------------------------------ percentile space
/** Lazily build sorted copies and per-cell CDF ranks for every rank-kernel feature. */
export function ensureRanks(grid) {
  if (grid.rank) return grid;
  grid.sorted = {};
  grid.rank = {};
  for (const [id, spec] of Object.entries(FEATURES)) {
    if (spec.kind === "near") continue;
    const v = grid.f[id];
    const order = Uint32Array.from(v.keys()).sort((a, b) => v[a] - v[b]);
    const sorted = new Float32Array(v.length);
    const r = new Float32Array(v.length);
    for (let k = 0; k < order.length; k++) sorted[k] = v[order[k]];
    // mid-rank for ties
    let k = 0;
    while (k < order.length) {
      let j = k;
      while (j + 1 < order.length && sorted[j + 1] === sorted[k]) j++;
      const q = (k + j) / 2 / (order.length - 1);
      for (let m = k; m <= j; m++) r[order[m]] = q;
      k = j + 1;
    }
    grid.sorted[id] = sorted;
    grid.rank[id] = r;
  }
  return grid;
}

/** Empirical CDF F(x) of a feature over Earth's land cells (0..1). */
export function cdf(grid, id, x) {
  const a = ensureRanks(grid).sorted[id];
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  let t = lo; while (t < a.length && a[t] === x) t++;
  return Math.min(1, Math.max(0, ((lo + t) / 2) / (a.length - 1)));
}

// ------------------------------------------------------------------ solar geometry
/** Fraction of sunlit time with Sun < 10° and fraction of year in polar night, for a body
 *  with the given obliquity at a given latitude (airless, flat horizon, circular orbit). */
export function bodyLighting(body, latDeg) {
  const eps = (BODY[body]?.obliquity ?? 23.44) * Math.PI / 180;
  const la = latDeg * Math.PI / 180;
  let lit = 0, low = 0, nightDays = 0;
  const D = 360, Hn = 144;
  for (let d = 0; d < D; d++) {
    const dec = eps * Math.sin((2 * Math.PI * d) / D);
    let maxEl = -90;
    for (let h = 0; h < Hn; h++) {
      const H = -Math.PI + (2 * Math.PI * h) / Hn;
      const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H)) * 180 / Math.PI;
      if (el > maxEl) maxEl = el;
      if (el > 0) { lit++; if (el < 10) low++; }
    }
    if (maxEl <= 0) nightDays++;
  }
  return { lowsun: lit ? low / lit : 1, polarnight: nightDays / D };
}

// ------------------------------------------------------------------ target → ideals
const tf = (spec, x) => (spec.t === "log" ? Math.log10(Math.max(0, x) + spec.c) : x);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const P1 = 0, P99 = 6; // indices into meta pct [1,5,25,50,75,95,99]

/** Translate a planetary target into per-feature {ideal, rel, why}.
 *  rel = relevance multiplier (0 disables a feature for this target). */
export function targetIdeals(target, grid) {
  const e = target.env;
  const g = new Set(e.geology || []);
  const pct = (id, k) => grid.fmeta[id].pct[k];
  const earthMin = (id) => pct(id, P1), earthMax = (id) => pct(id, P99);
  const atLeastEarth = (id, v) => clamp(v, earthMin(id), earthMax(id));
  const iceKind = e.ice || "none";
  const out = {};
  const set = (id, ideal, rel, why) => { out[id] = { ideal, rel, why }; };

  const tMean = e.t_surface_mean_C, tMin = e.t_surface_min_C;
  // Lava-tube interiors are thermally buffered (~17 °C on the Moon): temperature matters less.
  const tRel = target.category === "lava-tube" ? 0.4 : 1;
  set("tmean", atLeastEarth("tmean", tMean), tRel, target.category === "lava-tube" ? `Buffered cave interior ≈ ${fmtT(tMean)}` : `Surface mean ${fmtT(tMean)}`);
  set("tcold", atLeastEarth("tcold", tMin), tRel, `Surface minimum ${fmtT(tMin)}`);
  set("dtr", atLeastEarth("dtr", e.diurnal_range_C), 0.6, `Day–night swing ${Math.round(e.diurnal_range_C)} °C`);
  const iceRel = iceKind === "none" ? 0.5 : 1.5;
  set("tsoil", atLeastEarth("tsoil", tMean), iceRel, iceKind === "none" ? "Frozen ground (sub-surface ≈ mean temperature)" : "Ice-cemented ground / cold-trapped volatiles");

  set("precip", earthMin("precip"), 1.5, "No rainfall — liquid water unstable at the surface");
  set("qv", earthMin("qv"), 1, e.water_vapor_note || "Near-zero atmospheric water");
  set("soilw", earthMin("soilw"), iceKind === "none" ? 0.8 : 0.3, "Desiccated regolith");
  set("et", earthMin("et"), 1.5, "No biosphere");

  const isMoon = target.body === "moon";
  set("ps", atLeastEarth("ps", e.pressure_kPa), isMoon ? 0.6 : 1, isMoon ? "Hard vacuum (~3×10⁻¹⁵ kPa)" : `Surface pressure ${e.pressure_kPa} kPa`);
  const grazing = (e.sun_elevation_max_deg ?? 90) < 15;
  const highLat = grazing || Math.abs(target.lat) > 55;
  // At grazing incidence the UV dose on level ground is small: de-emphasise UV for polar sites.
  set("uv", earthMax("uv"), grazing ? 0.15 : highLat ? 0.3 : isMoon ? 0.6 : 1, e.uv_note || "Unshielded solar UV");
  set("cloud", earthMin("cloud"), highLat ? 0.4 : 0.8, "Cloud-free sky");
  set("albedo", atLeastEarth("albedo", e.albedo ?? 0.15), 0.5, `Surface albedo ${e.albedo ?? "~0.15"}`);

  // terrain: map typical slope to Earth percentiles
  const s = e.slope_deg_typical ?? 5;
  const terrainPct = s >= 15 ? P99 : s >= 8 ? 5 : s >= 4 ? 4 : s >= 2 ? 3 : 2;
  set("relief", pct("relief", terrainPct), 1, `${e.terrain || "terrain"} (typical slope ${s}°)`);
  set("slope", pct("slope", terrainPct), 1, `Typical slope ${s}°`);

  // geology & ice
  const iceIdeal = { none: 0, "psr-nearby": 0, "shallow-ground-ice": 0, glacier: 0.4, "polar-cap": 0.8 }[iceKind] ?? 0;
  set("ice", iceIdeal, iceKind === "glacier" || iceKind === "polar-cap" ? 1.5 : 1,
    { none: "Ice-free surface", "psr-nearby": "Water ice cold-trapped in nearby shadowed craters", "shallow-ground-ice": "Shallow buried ground ice", glacier: "Debris-covered glaciers", "polar-cap": "Polar ice deposits" }[iceKind] || "");
  set("d_ice", 0, { none: 0, "psr-nearby": 1.5, "shallow-ground-ice": 1, glacier: 1.5, "polar-cap": 1 }[iceKind] ?? 0,
    iceKind === "psr-nearby" ? "Ice-free ground next to cold-trapped ice" : "Ice within reach of the work site");
  const volc = g.has("volcanic-basalt") || g.has("lava-tube");
  set("d_volcano", 0, volc ? (g.has("lava-tube") ? 2 : 1.5) : 0, g.has("lava-tube") ? "Lava tubes / skylights in basaltic flows" : "Basaltic volcanic terrain");
  set("d_crater", 0, g.has("impact") ? 1.2 : 0, "Impact-dominated geology");
  const evap = g.has("evaporite") || g.has("sedimentary") || g.has("hydrated-minerals");
  set("d_playa", 0, evap ? 1.2 : 0, "Evaporites / lacustrine sediments");

  // lighting: computed from the body's own obliquity at the target latitude
  const L = bodyLighting(target.body, target.lat);
  const polar = Math.abs(target.lat) > 75 || grazing;
  set("lowsun", atLeastEarth("lowsun", L.lowsun), polar ? 3 : 0.4,
    `Sun below 10° for ${Math.round(L.lowsun * 100)}% of daylight` + (e.sun_elevation_max_deg != null ? ` (max ≈ ${e.sun_elevation_max_deg}°)` : ""));
  set("polarnight", atLeastEarth("polarnight", L.polarnight), polar ? 1.5 : 0.2,
    `${Math.round(L.polarnight * 100)}% of the year without sunrise (flat horizon)`);
  return out;
}

const fmtT = (t) => `${t > 0 ? "+" : ""}${Math.round(t)} °C`;

// ------------------------------------------------------------------ scoring
// Two-level aggregation (as in AHP-style suitability analysis):
//   group score  G_k = weighted mean of its feature similarities
//   site score   S   = Π G_k^(w_k/Σw)   — weighted geometric mean across groups
// The geometric mean is non-compensatory: a site that fails one heavily weighted
// dimension (e.g. a hot desert for a −100 °C polar target) cannot buy it back with others.
// opts.aggregate = "wlc" switches to a plain weighted linear combination for comparison.
const FLOOR = 0.02;

export function buildModel(grid, ideals, groupWeights, opts = {}) {
  ensureRanks(grid);
  const sharp = opts.sharp ?? SHARP;
  const terms = [];
  for (const [id, spec] of Object.entries(FEATURES)) {
    const it = ideals[id];
    if (!it) continue;
    const gw = groupWeights[spec.group] ?? 0;
    const W = it.rel * (opts.featureWeights?.[id] ?? 1);
    if (W <= 0 || gw <= 0) continue;
    const m = grid.fmeta[id];
    const base = { id, group: spec.group, W, it };
    if (spec.kind === "near") terms.push({ ...base, kind: "near", L: spec.L });
    else terms.push({ ...base, kind: "rank", r0: cdf(grid, id, it.ideal), sharp });
  }
  const groups = [];
  for (const g of Object.keys(GROUPS)) {
    const ts = terms.filter((t) => t.group === g);
    if (!ts.length) continue;
    const wsum = ts.reduce((a, t) => a + t.W, 0);
    // a group's say grows with the relevance of its features for this target
    const rel = Math.min(1.5, wsum / ts.length);
    const emph = opts.emphasis?.[g] ?? 1;
    groups.push({ id: g, terms: ts, wsum, gw: groupWeights[g] * rel * emph });
  }
  const GW = groups.reduce((a, g) => a + g.gw, 0) || 1;
  for (const g of groups) g.share = g.gw / GW;
  const iceIdeal = ideals.ice?.ideal ?? 0;
  // Substrate gate: a regolith/rock target needs exposed ground, not an ice sheet. Ice cover
  // beyond (ideal + 0.15) is penalised multiplicatively.
  const gate = opts.gate !== false ? { id: "ice", start: iceIdeal + 0.15, strength: opts.gateStrength ?? 0.85 } : null;
  return { terms, groups, opts, gate, aggregate: opts.aggregate || "geo" };
}

/** Convenience: full model for a target + preset (what the app and the tests use). */
export function modelFor(grid, target, presetWeights, opts = {}) {
  const ideals = targetIdeals(target, grid);
  const iceKind = target.env.ice || "none";
  return buildModel(grid, ideals, presetWeights, {
    emphasis: CATEGORY_EMPHASIS[target.category],
    gateStrength: iceKind === "none" ? 0.85 : 0.6,
    ...opts,
  });
}

/** Similarity for one term. For 'rank' terms pass the cell's CDF rank, for 'near' the km. */
export function termScore(term, x) {
  if (term.kind === "near") return 1 / (1 + (x / term.L) ** 2);
  return (1 - Math.abs(x - term.r0)) ** term.sharp;
}

const termInput = (grid, t) => (t.kind === "near" ? grid.f[t.id] : grid.rank[t.id]);

export function gateFactor(model, iceFrac) {
  if (!model.gate) return 1;
  return 1 - model.gate.strength * Math.min(1, Math.max(0, (iceFrac - model.gate.start) / 0.7));
}

function combine(model, gscores) {
  if (model.aggregate === "wlc") {
    let s = 0;
    for (let k = 0; k < model.groups.length; k++) s += model.groups[k].share * gscores[k];
    return s;
  }
  let l = 0;
  for (let k = 0; k < model.groups.length; k++) l += model.groups[k].share * Math.log(Math.max(FLOOR, gscores[k]));
  return Math.exp(l);
}

/** Score every land cell. Returns Float32Array in [0,1]; masked cells get -1. */
export function scoreGrid(grid, model, mask) {
  const S = new Float32Array(grid.n);
  const G = model.groups.map((g) => ({ cols: g.terms.map((t) => termInput(grid, t)), g }));
  const gs = new Float64Array(G.length);
  const ice = grid.f.ice;
  for (let i = 0; i < grid.n; i++) {
    if (mask && !mask[i]) { S[i] = -1; continue; }
    for (let k = 0; k < G.length; k++) {
      const { cols, g } = G[k];
      let acc = 0;
      for (let j = 0; j < g.terms.length; j++) acc += g.terms[j].W * termScore(g.terms[j], cols[j][i]);
      gs[k] = acc / g.wsum;
    }
    S[i] = combine(model, gs) * gateFactor(model, ice[i]);
  }
  return S;
}

/** Per-feature explanation for one cell. */
export function explainCell(grid, model, i) {
  const rows = [];
  const groups = {};
  const gs = [];
  for (const g of model.groups) {
    let acc = 0;
    for (const t of g.terms) {
      const x = grid.f[t.id][i];
      const s = termScore(t, termInput(grid, t)[i]);
      acc += t.W * s;
      rows.push({ id: t.id, group: g.id, value: x, ideal: t.it.ideal, why: t.it.why, match: s,
        rank: t.kind === "rank" ? grid.rank[t.id][i] : null, idealRank: t.kind === "rank" ? t.r0 : null,
        weight: (g.share * t.W) / g.wsum });
    }
    groups[g.id] = acc / g.wsum;
    gs.push(groups[g.id]);
  }
  for (const r of rows) r.loss = r.weight * (1 - r.match);
  const limiting = [...rows].sort((a, b) => b.loss - a.loss)[0];
  const raw = combine(model, gs);
  const gate = gateFactor(model, grid.f.ice[i]);
  const shares = Object.fromEntries(model.groups.map((g) => [g.id, g.share]));
  return { rows, groups, shares, limiting, raw, gate, score: raw * gate };
}

// ------------------------------------------------------------------ candidates
/** Greedy non-maximum suppression: the k best cells at least `sepKm` apart. */
export function topSites(grid, S, { k = 10, sepKm = 400, filter } = {}) {
  const order = Array.from(S.keys()).filter((i) => S[i] >= 0 && (!filter || filter(i)));
  order.sort((a, b) => S[b] - S[a]);
  const picked = [];
  for (const i of order) {
    if (picked.length >= k) break;
    if (picked.every((j) => haversine(grid.lat[i], grid.lon[i], grid.lat[j], grid.lon[j]) >= sepKm)) picked.push(i);
  }
  return picked;
}

/** Percentile rank (0–100) of value v within the valid scores. */
export function percentileOf(S, v) {
  let below = 0, tot = 0;
  for (let i = 0; i < S.length; i++) {
    if (S[i] < 0) continue;
    tot++;
    if (S[i] < v) below++;
  }
  return (100 * below) / tot;
}

/** Distance (km) from every cell to the nearest site in a list. */
export function distanceToSites(grid, sites) {
  const D = new Float32Array(grid.n);
  for (let i = 0; i < grid.n; i++) {
    let best = Infinity;
    for (const s of sites) {
      const d = haversine(grid.lat[i], grid.lon[i], s.lat, s.lon);
      if (d < best) best = d;
    }
    D[i] = best;
  }
  return D;
}

/** ROC AUC of `positives` (cell indices) against all valid cells — the probability that a
 *  known analog outscores a random land cell (Mann–Whitney U / n1n2). */
export function aucOf(S, positives) {
  const valid = [];
  for (let i = 0; i < S.length; i++) if (S[i] >= 0) valid.push(S[i]);
  valid.sort((a, b) => a - b);
  const rankBelow = (v) => { // count < v plus half ties
    let lo = 0, hi = valid.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (valid[m] < v) lo = m + 1; else hi = m; }
    let tie = lo; while (tie < valid.length && valid[tie] === v) tie++;
    return lo + (tie - lo) / 2;
  };
  let sum = 0;
  for (const i of positives) sum += rankBelow(S[i]) / valid.length;
  return positives.length ? sum / positives.length : NaN;
}

/** Monte-Carlo sensitivity: jitter every group weight and the kernel sharpness by ±35 %,
 *  re-rank the planet, and count how often each candidate is still among the top-k
 *  distinct regions (a re-picked site within sepKm/2 counts as the same region).
 *  Returns Map(cellIndex -> fraction of runs). */
export function robustness(grid, target, groupWeights, candidates, { runs = 30, jitter = 0.35, sepKm = 350, seed = 1, baseOpts = {} } = {}) {
  let st = seed >>> 0 || 1;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296);
  const hits = new Map(candidates.map((c) => [c, 0]));
  for (let r = 0; r < runs; r++) {
    const w = {};
    for (const k in groupWeights) w[k] = groupWeights[k] * (1 + jitter * (2 * rnd() - 1));
    const sharp = SHARP * (1 + jitter * (2 * rnd() - 1));
    const S = scoreGrid(grid, modelFor(grid, target, w, { sharp, ...baseOpts }));
    const picks = topSites(grid, S, { k: candidates.length, sepKm, filter: baseOpts.filter });
    for (const c of candidates) {
      if (picks.some((p) => haversine(grid.lat[p], grid.lon[p], grid.lat[c], grid.lon[c]) <= sepKm / 2)) hits.set(c, hits.get(c) + 1);
    }
  }
  for (const [c, h] of hits) hits.set(c, h / runs);
  return hits;
}

export function regionLabel(grid, i) {
  const code = grid.cat.region[i];
  const near = (code & 0x8000) !== 0;
  const reg = grid.meta.regions[code & 0x7fff] || "";
  const [name, cls] = reg.split("|");
  const country = grid.meta.countries[grid.cat.country[i]] || "";
  return { name: name ? (near ? `near ${name}` : name) : "", cls: cls || "", country, near };
}

export function koppenOf(grid, i) {
  return grid.meta.koppen[grid.cat.koppen[i] - 1] || "";
}

// ------------------------------------------------------------------ validation
// Which established-analog themes count as a "known positive" for a target category.
export const VALIDATION_THEMES = {
  "south-pole": ["polar", "ice"],
  "polar": ["polar", "ice"],
  "ground-ice": ["polar", "ice"],
  "lava-tube": ["lava-tube", "volcanic"],
  "mare": ["volcanic", "lava-tube"],
  "volcanic": ["volcanic", "lava-tube"],
  "sedimentary": ["arid", "evaporite"],
  "crater-lake": ["arid", "evaporite"],
  "canyon": ["arid", "evaporite"],
};

/** Theme-matched retrieval test for one target: do established analog field sites whose
 *  environment matches the target's category score above random Earth land? */
export function validateTarget(grid, target, analogs, presetW, S) {
  S ||= scoreGrid(grid, modelFor(grid, target, presetW));
  const themes = VALIDATION_THEMES[target.category] || [];
  const sites = analogs.filter((a) => !a.facility && a.themes.some((t) => themes.includes(t)))
    .map((a) => ({ a, i: nearestCell(grid, a.lat, a.lon) })).filter((x) => x.i >= 0);
  const pos = sites.map((x) => x.i);
  const pct = sites.map((x) => ({ id: x.a.id, name: x.a.name, pct: percentileOf(S, S[x.i]), score: S[x.i] }));
  const sortedP = pct.map((p) => p.pct).sort((a, b) => a - b);
  return {
    target: target.id, themes, n: pos.length, auc: aucOf(S, pos),
    medianPct: sortedP.length ? sortedP[Math.floor(sortedP.length / 2)] : NaN,
    top10: pct.filter((p) => p.pct >= 90).length / (pct.length || 1),
    sites: pct,
  };
}
