// Analog Atlas — browser app.
import * as E from "./engine.js";
import { createEarth, createMiniBody } from "./globe.js";
import { radar, hbars, rankDots, dial, esc } from "./charts.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmtKm = (k) => (k >= 1000 ? `${(k / 1000).toFixed(1)}k km` : `${Math.round(k)} km`);

const state = {
  body: "moon", target: null, preset: "balanced", weights: { ...E.PRESETS.balanced.w },
  onlyNew: false, novKm: 250, accKm: 1000, showKnown: true, layer: "score", wlc: false,
  cell: -1, cands: [], S: null, model: null, robust: new Map(),
};
let grid, T, A, KNOWN, DIST_KNOWN, VAL, DISC, earth, mini, worker;

// ------------------------------------------------------------------ boot
async function boot() {
  const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
  const [meta, buf, targets, analogs, val, disc] = await Promise.all([
    j("data/earth.json"), fetch("data/earth.bin").then((r) => r.arrayBuffer()),
    j("data/targets.json"), j("data/analogs.json"), j("data/validation.json"), j("data/discoveries.json"),
  ]);
  grid = E.ensureRanks(E.decodeGrid(meta, buf));
  T = targets; A = analogs; VAL = val; DISC = disc;
  KNOWN = A.filter((a) => !a.facility);
  DIST_KNOWN = E.distanceToSites(grid, KNOWN);

  earth = createEarth($("#globe"), { texture: "assets/textures/earth_bmng_4096.jpg" });
  earth.setKnown(A);
  earth.onPick((lat, lon, known) => {
    const i = E.nearestCell(grid, lat, lon, 80);
    if (i >= 0) selectCell(i, { fly: false, known });
  });
  earth.onMarker((m) => selectCell(m.cell, { fly: true }));
  earth.onHover(hover);
  mini = createMiniBody($("#mini"), { textures: { moon: "assets/textures/moon_1024.jpg", mars: "assets/textures/mars_nasa_1440.jpg" } });
  mini.onPick((t) => setTarget(t.id));

  buildControls();
  readHash();
  if (!state.target) state.target = T.find((t) => t.id === "moon-connecting-ridge") || T[0];
  state.body = state.target.body;
  syncBody();
  recompute({ fly: state.cell < 0 });
  if (state.cell >= 0) selectCell(state.cell, { fly: true });
  $("#busy").classList.add("off");
  renderValidation();
  renderDiscoveries();
  startWorker();
}

// ------------------------------------------------------------------ controls
function buildControls() {
  $$(".seg button").forEach((b) => b.addEventListener("click", () => {
    if (state.body === b.dataset.body) return;
    state.body = b.dataset.body;
    state.target = T.find((t) => t.body === state.body);
    state.cell = -1;
    earth.select(null);
    syncBody();
    recompute({ fly: true });
  }));
  $("#targetSel").addEventListener("change", (e) => setTarget(e.target.value));

  const pr = $("#presets");
  for (const [k, p] of Object.entries(E.PRESETS)) {
    const b = document.createElement("button");
    b.className = "chip"; b.dataset.k = k; b.textContent = p.label; b.setAttribute("role", "radio");
    b.addEventListener("click", () => { state.preset = k; state.weights = { ...p.w }; syncPreset(); recompute(); });
    pr.appendChild(b);
  }
  const sl = $("#sliders");
  for (const [g, meta] of Object.entries(E.GROUPS)) {
    const row = document.createElement("label");
    row.className = "slider";
    row.innerHTML = `<span>${meta.icon}</span><input type="range" min="0" max="3" step="0.5" data-g="${g}" aria-label="${meta.label} weight"><span>${meta.label}</span><output></output>`;
    row.querySelector("input").addEventListener("input", (e) => {
      state.weights[g] = +e.target.value;
      state.preset = "custom";
      syncPreset();
      recompute();
    });
    sl.appendChild(row);
  }
  $("#aggWlc").addEventListener("change", (e) => { state.wlc = e.target.checked; recompute(); });
  $("#onlyNew").addEventListener("change", (e) => { state.onlyNew = e.target.checked; recompute(); });
  $("#novKm").addEventListener("input", (e) => { state.novKm = +e.target.value; $("#novOut").textContent = state.novKm; if (state.onlyNew) recompute(); });
  $("#accKm").addEventListener("input", (e) => { state.accKm = +e.target.value; $("#accOut").textContent = state.accKm >= 1000 ? "any" : `${state.accKm} km`; recompute(); });
  $("#showKnown").addEventListener("change", (e) => { state.showKnown = e.target.checked; earth.showKnown(state.showKnown); });

  const ls = $("#layerSel");
  const og = (label) => { const g = document.createElement("optgroup"); g.label = label; ls.appendChild(g); return g; };
  og("Result").innerHTML = `<option value="score">Analog fidelity for selected target</option>`;
  const groups = { "Climate (NASA POWER)": [], "Terrain & light": [], "Geology & access": [] };
  for (const f of grid.meta.features) {
    if (f.id === "landfrac") continue;
    const k = f.id.startsWith("d_") || f.id === "ice" ? "Geology & access" : ["elev", "relief", "slope", "lowsun", "polarnight"].includes(f.id) ? "Terrain & light" : "Climate (NASA POWER)";
    groups[k].push(f);
  }
  for (const [k, fs] of Object.entries(groups)) og(k).innerHTML = fs.map((f) => `<option value="${f.id}">${esc(f.label)}${f.unit ? ` (${esc(f.unit)})` : ""}</option>`).join("");
  ls.addEventListener("change", () => { state.layer = ls.value; drawOverlay(); drawLegend(); });

  $$(".tabs .tab[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $$(".rtab").forEach((b) => b.addEventListener("click", () => showRight(b.dataset.r)));
  $("#tourBtn").addEventListener("click", startTour);
  window.addEventListener("hashchange", () => { if (location.hash.startsWith("#discover")) showView("discover", false); else if (location.hash.startsWith("#validate")) showView("validate", false); });
}

function showView(v, push = true) {
  $$(".view").forEach((el) => el.classList.toggle("on", el.id === v));
  $$(".tabs .tab[data-view]").forEach((b) => { b.classList.toggle("on", b.dataset.view === v); b.setAttribute("aria-selected", b.dataset.view === v); });
  if (push) history.replaceState(null, "", v === "explore" ? hashFor() : `#${v}`);
}
function showRight(r) {
  $$(".rtab").forEach((b) => { b.classList.toggle("on", b.dataset.r === r); b.setAttribute("aria-selected", b.dataset.r === r); });
  $$(".rview").forEach((el) => el.classList.toggle("on", el.id === r));
}

function setTarget(id) {
  const t = T.find((x) => x.id === id);
  if (!t) return;
  state.target = t;
  state.body = t.body;
  state.cell = -1;
  earth.select(null);
  syncBody();
  recompute({ fly: true });
}

function syncBody() {
  $$(".seg button").forEach((b) => { const on = b.dataset.body === state.body; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  const list = T.filter((t) => t.body === state.body);
  const cats = {};
  for (const t of list) (cats[t.category] ||= []).push(t);
  const catName = { "south-pole": "South-pole base regions", "lava-tube": "Lava-tube skylights", mare: "Mare basalts", "crater-lake": "Ancient lake basins", sedimentary: "Sedimentary & mineral sites", "ground-ice": "Ground-ice plains", volcanic: "Volcanic provinces", canyon: "Canyons", polar: "Polar" };
  $("#targetSel").innerHTML = Object.entries(cats).map(([c, ts]) => `<optgroup label="${catName[c] || c}">${ts.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</optgroup>`).join("");
  $("#targetSel").value = state.target.id;
  mini.setBody(state.body, list, state.target.id);
  mini.focus(state.target.lat, state.target.lon);
  renderTargetCard();
  syncPreset();
}

function syncPreset() {
  $$("#presets .chip").forEach((b) => { const on = b.dataset.k === state.preset; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  $("#presetBlurb").textContent = state.preset === "custom" ? "Custom weights — tune each factor group below." : E.PRESETS[state.preset].blurb;
  $$("#sliders input").forEach((inp) => { inp.value = state.weights[inp.dataset.g]; inp.parentElement.querySelector("output").textContent = (+state.weights[inp.dataset.g]).toFixed(1); });
}

function renderTargetCard() {
  const t = state.target, e = t.env;
  const T_ = (v) => `${v > 0 ? "+" : ""}${Math.round(v)} °C`;
  const pres = t.body === "moon" ? "vacuum" : `${(e.pressure_kPa * 1000).toFixed(0)} Pa`;
  const L = E.bodyLighting(t.body, t.lat);
  $("#targetCard").innerHTML = `
    <h3>${esc(t.name)}</h3>
    <div class="tags"><span class="tag ${t.body}">${t.body === "moon" ? "Moon" : "Mars"} · ${t.lat.toFixed(2)}°, ${t.lon.toFixed(2)}°</span>${(t.missions || []).slice(0, 3).map((m) => `<span class="tag">${esc(m)}</span>`).join("")}<span class="tag ${t.confidence === "low" ? "warn" : ""}" title="Confidence in the environmental values">data: ${esc(t.confidence)}</span></div>
    <p>${esc(t.summary)}</p>
    <div class="envgrid">
      <div><span>Mean surface</span><span>${T_(e.t_surface_mean_C)}</span></div>
      <div><span>Range</span><span>${T_(e.t_surface_min_C)} … ${T_(e.t_surface_max_C)}</span></div>
      <div><span>Pressure</span><span>${pres}</span></div>
      <div><span>Max Sun elev.</span><span>${e.sun_elevation_max_deg != null ? e.sun_elevation_max_deg + "°" : "—"}</span></div>
      <div><span>Low-Sun time</span><span>${Math.round(L.lowsun * 100)}%</span></div>
      <div><span>Ice</span><span>${esc((e.ice || "none").replace(/-/g, " "))}</span></div>
      <div><span>Typical slope</span><span>${e.slope_deg_typical ?? "—"}°</span></div>
      <div><span>Radiation</span><span>${e.radiation_mSv_per_day ?? "—"} mSv/d</span></div>
    </div>
    <div class="tags">${(e.geology || []).map((g) => `<span class="tag">${esc(g.replace(/-/g, " "))}</span>`).join("")}</div>
    <details><summary>Sources (${t.sources.length})</summary><ul class="src">${t.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join("")}</ul></details>`;
}

// ------------------------------------------------------------------ scoring & rendering
function candidateFilter() {
  return (i) => (!state.onlyNew || DIST_KNOWN[i] > state.novKm) && (state.accKm >= 1000 || grid.f.d_access[i] <= state.accKm);
}

function recompute({ fly = false } = {}) {
  state.model = E.modelFor(grid, state.target, state.weights, { aggregate: state.wlc ? "wlc" : "geo" });
  state.S = E.scoreGrid(grid, state.model);
  const filt = candidateFilter();
  state.cands = E.topSites(grid, state.S, { k: 12, sepKm: 350, filter: filt });
  earth.setMarkers(state.cands.map((i) => ({ lat: grid.lat[i], lon: grid.lon[i], cell: i, isNew: DIST_KNOWN[i] > state.novKm })));
  drawOverlay();
  drawLegend();
  renderCands();
  if (state.cell >= 0) renderReport(state.cell);
  else if (fly && state.cands.length) earth.flyTo(grid.lat[state.cands[0]], grid.lon[state.cands[0]], 2.9);
  history.replaceState(null, "", hashFor());
  requestRobustness();
}

// ramp (dark blue → teal → yellow → red-orange): the hot end stays visible on white ice
const RAMP = [[8, 20, 60], [31, 92, 160], [32, 168, 160], [140, 214, 90], [255, 200, 60], [255, 84, 46]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const k = Math.min(RAMP.length - 2, Math.floor(t)), f = t - k;
  return RAMP[k].map((c, j) => c + (RAMP[k + 1][j] - c) * f);
}

let small;
function drawOverlay() {
  const { nx, ny } = grid.meta.grid;
  small ||= Object.assign(document.createElement("canvas"), { width: nx, height: ny });
  const g = small.getContext("2d");
  const img = g.createImageData(nx, ny);
  const d = img.data;
  const filt = candidateFilter();
  if (state.layer === "score") {
    let mx = 0;
    for (let i = 0; i < grid.n; i++) if (state.S[i] > mx) mx = state.S[i];
    const lo = mx * 0.25;
    for (let i = 0; i < grid.n; i++) {
      const v = (state.S[i] - lo) / (mx - lo || 1);
      const p = grid.idx[i] * 4;
      const [r, gg, b] = ramp(v);
      d[p] = r; d[p + 1] = gg; d[p + 2] = b;
      let a = v <= 0 ? 40 : 70 + 185 * v ** 1.2;
      if (!filt(i)) a *= 0.25;
      d[p + 3] = a;
    }
  } else {
    const r = grid.rank[state.layer];
    const v0 = grid.f[state.layer];
    const m = grid.fmeta[state.layer];
    for (let i = 0; i < grid.n; i++) {
      const t = r ? r[i] : Math.min(1, Math.log10(1 + v0[i]) / Math.log10(1 + m.pct[6]));
      const p = grid.idx[i] * 4;
      const [rr, gg, b] = ramp(t);
      d[p] = rr; d[p + 1] = gg; d[p + 2] = b; d[p + 3] = 215;
    }
  }
  g.putImageData(img, 0, 0);
  const oc = earth.overlayCanvas, og = oc.getContext("2d");
  og.clearRect(0, 0, oc.width, oc.height);
  og.imageSmoothingEnabled = true;
  og.drawImage(small, 0, 0, oc.width, oc.height);
  earth.refreshOverlay();
}

function drawLegend() {
  const css = `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(",")})`).join(",")})`;
  let html;
  if (state.layer === "score") {
    let mx = 0;
    for (let i = 0; i < grid.n; i++) if (state.S[i] > mx) mx = state.S[i];
    html = `<b>Analog fidelity</b> — ${esc(state.target.name)}<div class="ramp" style="background:${css}"></div><div class="ends"><span>${Math.round(mx * 25)}</span><span>${Math.round(mx * 100)} (best on Earth)</span></div>
      <div class="key"><span><i style="background:#ffb347;border-radius:50%"></i>top analog</span><span><i style="background:#6fe0b0;border-radius:50%"></i>new (uncharacterised)</span><span><i style="background:#fff;transform:rotate(45deg)"></i>established site</span></div>`;
  } else {
    const m = grid.fmeta[state.layer];
    const f = (v) => v.toLocaleString("en-US", { maximumFractionDigits: m.decimals });
    html = `<b>${esc(m.label)}</b><div class="ramp" style="background:${css}"></div><div class="ends"><span>${f(m.pct[0])} ${esc(m.unit)}</span><span>${f(m.pct[3])}</span><span>${f(m.pct[6])} ${esc(m.unit)}</span></div><div class="key"><span>Source: ${esc(m.source)}</span></div>`;
  }
  $("#legend").innerHTML = html;
}

function label(i) {
  const r = E.regionLabel(grid, i);
  return { title: r.name || r.country || `${grid.lat[i].toFixed(1)}°, ${grid.lon[i].toFixed(1)}°`, sub: r.name ? r.country : "", cls: r.cls };
}

function renderCands() {
  const t = state.target;
  $("#candHead").innerHTML = `Best Earth analogs for <b>${esc(t.name)}</b> · ${state.preset === "custom" ? "custom weights" : esc(E.PRESETS[state.preset].label)}${state.onlyNew ? ` · only &gt;${state.novKm} km from known sites` : ""}. Distinct regions ≥350 km apart.`;
  $("#candList").innerHTML = state.cands.map((i, k) => {
    const L = label(i), s = state.S[i], isNew = DIST_KNOWN[i] > state.novKm;
    const rb = state.robust.get(i);
    return `<li class="cand${i === state.cell ? " on" : ""}" data-i="${i}" tabindex="0">
      <span class="rk" style="background:${isNew ? "#10392b" : "#1b2742"};color:${isNew ? "#6fe0b0" : "#ffb347"}">${k + 1}</span>
      <span><span class="nm">${esc(L.title)}</span><br><span class="sub">${esc(L.sub)}${L.sub ? " · " : ""}${grid.lat[i].toFixed(1)}°, ${grid.lon[i].toFixed(1)}° · ${E.koppenOf(grid, i)}</span>
      <span class="tags">${isNew ? `<span class="tag new">NEW · ${fmtKm(DIST_KNOWN[i])} from known</span>` : `<span class="tag">near established site</span>`}<span class="tag" title="Distance to nearest airport, town or research station">✈ ${fmtKm(grid.f.d_access[i])}</span>${rb != null ? `<span class="tag ${rb >= 0.7 ? "new" : rb < 0.4 ? "warn" : ""}" title="Rank stability: share of ±35% weight perturbations in which this region stays among the top 12">robust ${Math.round(rb * 100)}%</span>` : ""}</span>
      <div class="bar"><i style="width:${(s * 100).toFixed(0)}%"></i></div></span>
      <span class="sc">${Math.round(s * 100)}<small>/100</small></span></li>`;
  }).join("") || `<li class="muted">No land cells pass the filters — relax them.</li>`;
  $$("#candList .cand").forEach((li) => {
    const go = () => selectCell(+li.dataset.i, { fly: true });
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

function hover(p, x, y) {
  const tip = $("#tip");
  if (!p || p.lat == null && !p.marker && !p.known) { tip.style.display = "none"; return; }
  let html;
  if (p.known) html = `<b>◆ ${esc(p.known.name)}</b><br>${esc(p.known.note || "")}<br><span class="muted">${esc((p.known.programs || []).join(", "))}</span>`;
  else {
    const lat = p.marker ? p.marker.lat : p.lat, lon = p.marker ? p.marker.lon : p.lon;
    const i = E.nearestCell(grid, lat, lon, 60);
    if (i < 0) { tip.style.display = "none"; return; }
    const L = label(i);
    const lay = state.layer === "score" ? `fidelity <b>${Math.round(state.S[i] * 100)}</b> · top ${Math.max(0.1, 100 - E.percentileOf(state.S, state.S[i])).toFixed(1)}%` : `${esc(grid.fmeta[state.layer].label)}: <b>${fmtVal(state.layer, grid.f[state.layer][i])}</b>`;
    html = `<b>${esc(L.title)}</b>${L.sub ? `, ${esc(L.sub)}` : ""}<br>${lay}`;
  }
  tip.innerHTML = html;
  tip.style.display = "block";
  const W = $(".stage").clientWidth;
  tip.style.left = `${Math.min(W - 270, x + 14)}px`;
  tip.style.top = `${y + 14}px`;
}

function fmtVal(id, v) {
  const m = grid.fmeta[id];
  if (id === "lowsun" || id === "polarnight" || id === "ice" || id === "snow" || id === "landfrac") return `${Math.round(v * 100)}%`;
  if (id.startsWith("d_")) return fmtKm(v);
  return `${v.toLocaleString("en-US", { maximumFractionDigits: m.decimals })}${m.unit ? " " + m.unit : ""}`;
}

// ------------------------------------------------------------------ site report
function selectCell(i, { fly = false, known = null } = {}) {
  state.cell = i;
  earth.select(grid.lat[i], grid.lon[i]);
  if (fly) earth.flyTo(grid.lat[i], grid.lon[i], 2.2);
  earth.stopSpin();
  renderReport(i, known);
  renderCands();
  showRight("report");
  history.replaceState(null, "", hashFor());
}

function nearestKnown(i) {
  let best = null, bd = Infinity;
  for (const a of KNOWN) { const d = E.haversine(grid.lat[i], grid.lon[i], a.lat, a.lon); if (d < bd) { bd = d; best = a; } }
  return { site: best, km: bd };
}

function percentWord(id, rank) {
  const m = { precip: ["wetter", "drier"], tmean: ["warmer", "colder"], tcold: ["milder", "colder"], ps: ["higher-pressure", "lower-pressure"], qv: ["more humid", "drier"], uv: ["lower-UV", "higher-UV"], cloud: ["cloudier", "clearer"], et: ["more vegetated", "more barren"], relief: ["more rugged", "flatter"], dtr: ["larger swings", "smaller swings"] };
  if (!m[id] || rank == null) return "";
  const lowIsFirst = ["precip", "tmean", "tcold", "ps", "qv", "cloud", "et"].includes(id);
  const pct = Math.round((lowIsFirst ? 1 - rank : rank) * 100);
  const word = lowIsFirst ? m[id][1] : { uv: "higher-UV", relief: "more rugged", dtr: "larger day–night swing" }[id];
  return pct >= 50 ? `${word} than ${pct}% of Earth's land` : "";
}

function renderReport(i, known) {
  const ex = E.explainCell(grid, state.model, i);
  const L = label(i);
  const nk = nearestKnown(i);
  const pct = E.percentileOf(state.S, state.S[i]);
  const rb = state.robust.get(i);
  const groups = Object.keys(E.GROUPS).filter((g) => ex.groups[g] != null);
  const short = { thermal: "Thermal", water: "Aridity", atmosphere: "Atmosphere", terrain: "Terrain", geology: "Geology", lighting: "Lighting" };
  const axes = groups.map((g) => ({ label: short[g], value: ex.groups[g], share: ex.shares[g] }));
  const best = ex.rows.filter((r) => r.id !== "ice").sort((a, b) => b.weight * b.match - a.weight * a.match).slice(0, 3);
  const knownScore = nk.site ? state.S[E.nearestCell(grid, nk.site.lat, nk.site.lon)] : null;
  const rowsByGroup = groups.map((g) => {
    const rs = ex.rows.filter((r) => r.group === g);
    return `<tr class="grp"><td colspan="3">${E.GROUPS[g].icon} ${E.GROUPS[g].label} · ${Math.round(ex.groups[g] * 100)}%</td></tr>` + rs.map((r) => {
      const m = grid.fmeta[r.id];
      const col = r.match >= 0.66 ? "#6fe0b0" : r.match >= 0.33 ? "#ffb347" : "#ff6b6b";
      const pw = percentWord(r.id, r.rank);
      return `<tr><td>${esc(m.label)}<br><span class="muted small">target: ${esc(r.why)}</span>${pw ? `<br><span class="small" style="color:#9fd9c2">${esc(pw)}</span>` : ""}</td><td class="v">${fmtVal(r.id, r.value)}</td><td class="v"><span class="mbar"><i style="width:${Math.round(r.match * 100)}%;background:${col}"></i></span> ${Math.round(r.match * 100)}</td></tr>`;
    }).join("");
  }).join("");
  $("#report").innerHTML = `
    <div class="rep-head"><span class="muted small">${known ? `◆ Established analog: ${esc(known.name)}` : DIST_KNOWN[i] > state.novKm ? `<span class="tag new">NEW candidate</span>` : "Earth site"}</span>
      <h3>${esc(L.title)}</h3><div class="muted">${esc(L.sub)}${L.sub ? " · " : ""}${grid.lat[i].toFixed(2)}°, ${grid.lon[i].toFixed(2)}° · Köppen ${E.koppenOf(grid, i)} · 0.5° cell (~${Math.round(55 * Math.cos(grid.lat[i] * Math.PI / 180))}×55 km)</div></div>
    <div class="rep-score">${dial(ex.score, { label: "analog fidelity" })}
      <div class="facts">
        <div><span>Rank on Earth</span><span>top ${Math.max(0.01, 100 - pct).toFixed(pct > 99 ? 2 : 1)}%</span></div>
        <div><span>Analog of</span><span>${esc(state.target.name.split("(")[0])}</span></div>
        <div><span>Nearest established analog</span><span>${nk.site ? `${esc(nk.site.name.split("(")[0])} · ${fmtKm(nk.km)}` : "—"}</span></div>
        <div><span>Access (airport/town/station)</span><span>${fmtKm(grid.f.d_access[i])}</span></div>
        <div><span>Rank stability (±35% weights)</span><span>${rb != null ? Math.round(rb * 100) + "%" : state.cands.includes(i) ? "computing…" : "—"}</span></div>
        ${ex.gate < 0.999 ? `<div><span>Ice-sheet penalty</span><span>×${ex.gate.toFixed(2)}</span></div>` : ""}
      </div></div>
    ${radar(axes)}
    <div class="callout"><b>Why it matches:</b> ${best.map((r) => `${esc(grid.fmeta[r.id].label.toLowerCase())} (${Math.round(r.match * 100)}%)`).join(", ")}.</div>
    <div class="callout lim"><b>Limiting factor:</b> ${esc(grid.fmeta[ex.limiting.id].label)} — ${fmtVal(ex.limiting.id, ex.limiting.value)} vs target “${esc(ex.limiting.why)}”.</div>
    ${knownScore != null && nk.km > 5 ? `<p class="small muted">Compared with ${esc(nk.site.name)} (fidelity ${Math.round(knownScore * 100)}), this site is <b style="color:${state.S[i] >= knownScore ? "#6fe0b0" : "#ffb347"}">${state.S[i] >= knownScore ? "+" : ""}${Math.round((state.S[i] - knownScore) * 100)}</b> points for this target.</p>` : ""}
    <div class="actions"><button class="btn sm" id="briefBtn" type="button">⬇ Field brief (.md)</button><button class="btn ghost sm" id="linkBtn" type="button">🔗 Copy link</button><button class="btn ghost sm" id="layerBtn" type="button">Show limiting layer</button></div>
    <table class="ftable"><thead><tr><th>Factor (NASA data)</th><th class="v">This site</th><th class="v">Match</th></tr></thead><tbody>${rowsByGroup}</tbody></table>
    <p class="small muted">Match = similarity in percentile space: 100 means the site sits at the same position in Earth's distribution as the (Earth-clamped) target condition. Group scores combine by weighted geometric mean, so one failed factor drags the total down.</p>`;
  $("#briefBtn").onclick = () => downloadBrief(i, ex, L, nk);
  $("#linkBtn").onclick = () => { navigator.clipboard?.writeText(location.href); $("#linkBtn").textContent = "✓ Copied"; };
  $("#layerBtn").onclick = () => { state.layer = ex.limiting.id; $("#layerSel").value = state.layer; drawOverlay(); drawLegend(); };
}

function downloadBrief(i, ex, L, nk) {
  const t = state.target;
  const lines = [
    `# Analog field brief — ${L.title}${L.sub ? `, ${L.sub}` : ""}`, "",
    `*Generated by Analog Atlas (NASA Space Apps 2026) from open NASA Earth data.*`, "",
    `| | |`, `|---|---|`,
    `| Location | ${grid.lat[i].toFixed(2)}°, ${grid.lon[i].toFixed(2)}° (0.5° cell) |`,
    `| Analog of | ${t.name} (${t.body}, ${t.lat}°, ${t.lon}°) |`,
    `| Mission objective | ${state.preset === "custom" ? "custom weights" : E.PRESETS[state.preset].label} |`,
    `| Analog fidelity | ${Math.round(ex.score * 100)}/100 — top ${Math.max(0.01, 100 - E.percentileOf(state.S, state.S[i])).toFixed(2)}% of Earth's land |`,
    `| Köppen climate | ${E.koppenOf(grid, i)} |`,
    `| Nearest established analog | ${nk.site?.name} (${fmtKm(nk.km)}) |`,
    `| Access | ${fmtKm(grid.f.d_access[i])} to nearest airport / town / station |`, "",
    `## Factor-by-factor`, "", `| Group | Factor | Site value | Target condition | Match |`, `|---|---|---|---|---|`,
    ...ex.rows.map((r) => `| ${E.GROUPS[r.group].label} | ${grid.fmeta[r.id].label} | ${fmtVal(r.id, r.value)} | ${r.why} | ${Math.round(r.match * 100)}% |`), "",
    `**Limiting factor:** ${grid.fmeta[ex.limiting.id].label}.`, "",
    `## Target sources`, ...t.sources.map((s) => `- [${s.label}](${s.url})`), "",
    `## Earth data sources`, ...[...new Set(grid.meta.features.map((f) => f.source))].map((s) => `- ${s}`), "",
    `Permalink: ${location.href}`,
  ];
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" })), download: `analog-brief-${t.id}-${grid.lat[i].toFixed(1)}_${grid.lon[i].toFixed(1)}.md` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------ robustness worker
function startWorker() {
  try {
    worker = new Worker("js/worker.js", { type: "module" });
    worker.onmessage = (e) => {
      if (e.data.key !== robustKey()) return;
      state.robust = new Map(e.data.result);
      renderCands();
      if (state.cell >= 0) renderReport(state.cell);
    };
    requestRobustness();
  } catch { worker = null; }
}
const robustKey = () => `${state.target.id}|${JSON.stringify(state.weights)}|${state.wlc}|${state.onlyNew}|${state.novKm}|${state.accKm}|${state.cands.join(",")}`;
let rTimer;
function requestRobustness() {
  if (!worker) return;
  state.robust = new Map();
  clearTimeout(rTimer);
  rTimer = setTimeout(() => worker.postMessage({ key: robustKey(), target: state.target, weights: state.weights, cands: state.cands, aggregate: state.wlc ? "wlc" : "geo", filter: { onlyNew: state.onlyNew, novKm: state.novKm, accKm: state.accKm } }), 250);
}

// ------------------------------------------------------------------ URL state
function hashFor() {
  const p = new URLSearchParams({ t: state.target?.id || "", p: state.preset });
  if (state.preset === "custom") p.set("w", Object.values(state.weights).join(","));
  if (state.cell >= 0) p.set("c", `${grid.lat[state.cell].toFixed(2)},${grid.lon[state.cell].toFixed(2)}`);
  return `#explore?${p}`;
}
function readHash() {
  const h = location.hash;
  if (h.startsWith("#discover")) showView("discover", false);
  if (h.startsWith("#validate")) showView("validate", false);
  const q = new URLSearchParams(h.split("?")[1] || "");
  const t = T.find((x) => x.id === q.get("t"));
  if (t) state.target = t;
  const p = q.get("p");
  if (p && E.PRESETS[p]) { state.preset = p; state.weights = { ...E.PRESETS[p].w }; }
  if (p === "custom" && q.get("w")) {
    state.preset = "custom";
    const ws = q.get("w").split(",").map(Number);
    Object.keys(E.GROUPS).forEach((g, k) => { state.weights[g] = Number.isFinite(ws[k]) ? ws[k] : 2; });
  }
  if (q.get("c")) { const [la, lo] = q.get("c").split(",").map(Number); state.cell = E.nearestCell(grid, la, lo, 80); }
}

// ------------------------------------------------------------------ validation & discoveries
function renderValidation() {
  const P = VAL.presets.balanced;
  const nSites = KNOWN.length;
  const best = Object.entries(VAL.presets).sort((a, b) => b[1].meanAUC - a[1].meanAUC)[0];
  const top10 = P.targets.reduce((a, r) => a + r.sites.filter((s) => s.pct >= 90).length, 0) / P.targets.reduce((a, r) => a + r.sites.length, 0);
  $("#kpis").innerHTML = [
    [P.meanAUC.toFixed(2), "mean ROC AUC, 23 targets (0.5 = chance)"],
    [P.moonAUC.toFixed(2), "Moon targets (13)"],
    [P.marsAUC.toFixed(2), "Mars targets (10)"],
    [`${Math.round(top10 * 100)}%`, "of matched known sites land in Earth's top 10%"],
    [best[1].meanAUC.toFixed(2), `best objective: ${E.PRESETS[best[0]].label}`],
    [nSites, "established analog sites used as ground truth"],
  ].map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${esc(s)}</span></div>`).join("");
  $("#aucChart").innerHTML = hbars(P.targets.map((r) => ({ label: r.name.replace(/\s*\(.*\)/, "").slice(0, 30), value: r.auc, color: r.body === "moon" ? "#c9c7c0" : "#e0703f", note: `${r.n} matched sites (${r.themes.join(", ")})` })), { lo: 0.3, hi: 1 });
  const sel = $("#valTarget");
  sel.innerHTML = P.targets.map((r) => `<option value="${r.target}">${esc(r.name)}</option>`).join("");
  const draw = () => { const r = P.targets.find((x) => x.target === sel.value); $("#rankChart").innerHTML = rankDots(r.sites) + `<p class="small muted">Matched themes: ${esc(r.themes.join(", "))} · AUC ${r.auc} · median percentile ${r.medianPct.toFixed(0)}</p>`; };
  sel.addEventListener("change", draw);
  sel.value = "mars-gale";
  draw();
  $("#presetTable").innerHTML = `<table class="data"><thead><tr><th>Mission objective</th><th>Mean AUC</th><th>Moon</th><th>Mars</th></tr></thead><tbody>${Object.entries(VAL.presets).map(([k, v]) => `<tr><td>${esc(E.PRESETS[k].label)}</td><td><b>${v.meanAUC}</b></td><td>${v.moonAUC}</td><td>${v.marsAUC}</td></tr>`).join("")}<tr><td class="muted">Baseline: linear (compensatory) aggregation, balanced</td><td>${P.wlcMeanAUC}</td><td colspan="2" class="muted">similar AUC, but ranks hot deserts above polar sites for −100 °C lunar targets — the geometric mean fixes the physics</td></tr></tbody></table>`;
}

function renderDiscoveries() {
  // aggregate distinct regions that recur across targets
  const agg = new Map();
  for (const t of DISC.targets) for (const s of t.sites) {
    const k = `${(s.name || "").replace(/^near /, "")}|${s.country}`;
    const a = agg.get(k) || { name: s.name.replace(/^near /, "") || s.country, country: s.country, targets: [], best: s, bestT: t };
    if (!a.targets.includes(t.name)) a.targets.push(t.name);
    if (s.score > a.best.score) { a.best = s; a.bestT = t; }
    agg.set(k, a);
  }
  const hi = [...agg.values()].sort((a, b) => b.targets.length - a.targets.length || b.best.score - a.best.score).slice(0, 8);
  $("#discHi").innerHTML = hi.map((a) => `<div class="hi" tabindex="0" data-t="${a.bestT.id}" data-c="${a.best.lat},${a.best.lon}">
    <b>${esc(a.name)}</b><span class="muted small">${esc(a.country)} · ${esc(a.best.koppen)} · ${fmtKm(a.best.nearestKnownKm)} from nearest known analog</span>
    <p class="small">Analog for ${a.targets.length} target${a.targets.length > 1 ? "s" : ""}: ${esc(a.targets.slice(0, 3).map((x) => x.split("(")[0].trim()).join(", "))}${a.targets.length > 3 ? "…" : ""}</p>
    <span class="n">best fidelity ${Math.round(a.best.score * 100)} · ${esc(a.bestT.name.split("(")[0])}</span></div>`).join("");
  $$("#discHi .hi").forEach((el) => {
    const go = () => openDiscovery(el.dataset.t, el.dataset.c);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
  const rows = [];
  for (const body of ["moon", "mars"]) {
    rows.push(`<tr class="body-row"><td colspan="6">${body === "moon" ? "🌕 Moon" : "🔴 Mars"}</td></tr>`);
    for (const t of DISC.targets.filter((x) => x.body === body)) {
      t.sites.slice(0, 3).forEach((s, k) => rows.push(`<tr>${k === 0 ? `<td rowspan="${Math.min(3, t.sites.length)}"><b>${esc(t.name)}</b></td>` : ""}
        <td>${esc(s.name || "—")}<br><span class="muted small">${esc(s.country)} · ${s.lat}°, ${s.lon}° · ${esc(s.koppen)}</span></td>
        <td><b>${Math.round(s.score * 100)}</b> <span class="muted small">top ${Math.max(0.01, 100 - s.pct).toFixed(2)}%</span></td>
        <td>${esc((s.nearestKnown || "").split("(")[0])}<br><span class="muted small">${fmtKm(s.nearestKnownKm)} away</span></td>
        <td>${fmtKm(s.accessKm)}</td>
        <td><a class="open" data-t="${t.id}" data-c="${s.lat},${s.lon}" href="#explore?t=${t.id}&p=balanced&c=${s.lat},${s.lon}">Open →</a></td></tr>`));
    }
  }
  $("#discTable").innerHTML = `<table class="data"><thead><tr><th>Target</th><th>New candidate region</th><th>Fidelity</th><th>Nearest established analog</th><th>Access</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  $$("#discTable a.open").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openDiscovery(a.dataset.t, a.dataset.c); }));
}

function openDiscovery(tid, c) {
  state.preset = "balanced"; state.weights = { ...E.PRESETS.balanced.w };
  syncPreset();
  setTarget(tid);
  const [la, lo] = c.split(",").map(Number);
  showView("explore");
  selectCell(E.nearestCell(grid, la, lo, 80), { fly: true });
}

// ------------------------------------------------------------------ guided tour
const TOUR = [
  ["#stepTarget", "Pick a destination", "Choose an Artemis III south-pole region, a lunar lava-tube skylight, or a Mars landing site. Each carries cited environmental values (Diviner, LOLA, ChaSTE, REMS, MEDA, SHARAD…)."],
  ["#stepPreset", "Say what you want to test", "Rover mobility, ISRU ice prospecting, astrobiology, habitats or polar power each weight the six factor groups differently."],
  [".stage", "Earth, re-ranked", "21 factors from 32 data layers — NASA POWER (MERRA-2, CERES, GPM IMERG), ETOPO terrain, solar geometry and geology — are scored for 88,648 land cells, live in your browser."],
  ["#cands", "Distinct candidates", "The best regions ≥350 km apart. Green = NEW: far from any established analog. ‘Robust’ = survives ±35% weight perturbations."],
  ["#report", "A report card for any site", "Click a candidate or anywhere on land: factor-by-factor match, limiting factor, comparison with the nearest established analog, downloadable field brief."],
  [".tabs", "Trust, but verify", "Validation shows the method rediscovers 36 established NASA/ESA/CSA/ISRO/CNSA analog sites (ROC AUC ≈ 0.78). Discoveries lists new, uncharacterised candidates."],
];
let tourK = 0;
function startTour() { showView("explore"); tourK = 0; $("#tour").hidden = false; stepTour(); }
function stepTour() {
  $$(".spot").forEach((el) => el.classList.remove("spot"));
  if (tourK >= TOUR.length) { $("#tour").hidden = true; return; }
  const [sel, h, p] = TOUR[tourK];
  if (sel === "#cands") showRight("cands");
  if (sel === "#report") { if (state.cands.length) selectCell(state.cands[0], { fly: true }); showRight("report"); }
  const el = $(sel);
  el.classList.add("spot");
  el.scrollIntoView?.({ block: "nearest" });
  $("#tourStep").textContent = `Step ${tourK + 1} of ${TOUR.length}`;
  $("#tourTitle").textContent = h;
  $("#tourText").textContent = p;
  $("#tourNext").textContent = tourK === TOUR.length - 1 ? "Done" : "Next →";
  const card = $(".tour-card"), r = el.getBoundingClientRect();
  const w = Math.min(360, innerWidth - 32);
  let x = r.right + 12, y = r.top + 10;
  if (x + w > innerWidth - 8) x = Math.max(16, r.left - w - 12);
  if (x < 16 || innerWidth < 920) { x = 16; y = Math.min(innerHeight - 220, r.bottom + 10); }
  card.style.left = `${x}px`;
  card.style.top = `${Math.max(70, Math.min(innerHeight - 220, y))}px`;
}
$("#tourNext").addEventListener("click", () => { tourK++; stepTour(); });
$("#tourSkip").addEventListener("click", () => { tourK = TOUR.length; stepTour(); });

boot().catch((err) => {
  console.error(err);
  $("#busy").textContent = `Could not load data (${err.message}). Serve the folder over HTTP, e.g. "python3 -m http.server".`;
});
