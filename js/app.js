// Analog Atlas — browser app (Mission Control HUD + game layer).
import * as E from "./engine.js";
import { createEarth, createMiniBody } from "./globe.js";
import { radar, hbars, rankDots, dial, esc } from "./charts.js";
import * as G from "./game.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fmtKm = (k) => (k >= 1000 ? `${(k / 1000).toFixed(1)}k km` : `${Math.round(k)} km`);
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  body: "moon", target: null, preset: "balanced", weights: { ...E.PRESETS.balanced.w },
  onlyNew: false, novKm: 250, accKm: 1000, showKnown: true, layer: "score", wlc: false,
  cell: -1, cands: [], S: null, model: null, robust: new Map(), hunt: null,
};
let grid, T, A, KNOWN, DIST_KNOWN, VAL, DISC, earth, mini, worker;

const PRESET_ICON = { balanced: "⚖", habitat: "🏠", mobility: "🚙", isru: "⛏", astrobio: "🦠", power: "🔆" };

const gradeOf = E.gradeOf;
const gradeHex = (g, extra = "", cls = "") => `<span class="grade g-${g} ${cls}" title="Grade ${g}: ${{ S: "twin score ≥ 75", A: "twin score 60–74", B: "45–59", C: "30–44", D: "below 30" }[g]}">${g}${extra}</span>`;

// ------------------------------------------------------------------ boot sequence
const bootLog = [];
function bootLine(txt, ok = true, pct = null) {
  bootLog.push(`<span>&gt; ${esc(txt)}</span>${ok ? ` <span class="ok">[ OK ]</span>` : ""}`);
  $("#bootLog").innerHTML = bootLog.slice(-9).join("\n");
  if (pct != null) $("#bootBar").style.width = `${pct}%`;
}
const wait = (ms) => new Promise((r) => setTimeout(r, REDUCED ? 0 : ms));

async function boot() {
  const t0 = performance.now();
  bootLine("Initialising planetary analog reconnaissance core…", false, 5);
  const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); });
  const pMeta = j("data/earth.json"), pBin = fetch("data/earth.bin").then((r) => { if (!r.ok) throw new Error("earth.bin"); return r.arrayBuffer(); });
  const pRest = Promise.all([j("data/targets.json"), j("data/analogs.json"), j("data/validation.json"), j("data/discoveries.json")]);
  const meta = await pMeta;
  bootLine(`Linked NASA POWER climatology · ${meta.features.length} sensor layers`, true, 25);
  const buf = await pBin;
  bootLine(`Earth surface grid · ${meta.count.toLocaleString()} land cells @ 0.5°`, true, 45);
  grid = E.ensureRanks(E.decodeGrid(meta, buf));
  bootLine("Percentile-space kernels calibrated", true, 60);
  const [targets, analogs, val, disc] = await pRest;
  T = targets; A = analogs; VAL = val; DISC = disc;
  KNOWN = A.filter((a) => !a.facility);
  DIST_KNOWN = E.distanceToSites(grid, KNOWN);
  bootLine(`Mission manifest · ${T.filter((t) => t.body === "moon").length} lunar + ${T.filter((t) => t.body === "mars").length} martian targets`, true, 75);
  bootLine(`Ground truth · ${KNOWN.length} established analog sites · AUC ${val.presets.balanced.meanAUC.toFixed(2)}`, true, 85);

  earth = createEarth($("#globe"), { texture: "assets/textures/earth_bmng_4096.jpg" });
  earth.setKnown(A);
  earth.onPick((lat, lon, known) => {
    if (state.hunt) return huntPick(lat, lon);
    const i = E.nearestCell(grid, lat, lon, 80);
    if (i >= 0) selectCell(i, { fly: false, known });
  });
  earth.onMarker((m) => { if (!state.hunt) selectCell(m.cell, { fly: true }); });
  earth.onHover(hover);
  mini = createMiniBody($("#mini"), { textures: { moon: "assets/textures/moon_1024.jpg", mars: "assets/textures/mars_nasa_1440.jpg" } });
  mini.onPick((t) => { if (!state.hunt) setTarget(t.id); });

  buildControls();
  readHash();
  if (!state.target) state.target = T.find((t) => t.id === "moon-connecting-ridge") || T[0];
  state.body = state.target.body;
  syncBody();
  bootLine("3D globes online · WebGL", true, 95);
  await wait(Math.max(0, 900 - (performance.now() - t0)));
  bootLine("ALL SYSTEMS NOMINAL — welcome to Mission Control", true, 100);
  await wait(450);
  $("#boot").classList.add("done");
  $("#busy").classList.add("off");
  recompute({ fly: state.cell < 0 });
  if (state.cell >= 0) selectCell(state.cell, { fly: true });
  renderValidation();
  renderDiscoveries();
  startWorker();
  startTicker();
}

// ------------------------------------------------------------------ HUD chrome
function startClock() {
  const tick = () => { $("#clock").textContent = `${new Date().toISOString().slice(11, 19)} UTC`; };
  tick();
  setInterval(tick, 1000);
}

function startTicker() {
  const P = VAL.presets.balanced;
  const hi = DISC.targets.flatMap((t) => t.sites.slice(0, 1).map((s) => `${s.name || s.country} → ${t.name.split("(")[0].trim()}`)).slice(0, 8);
  const parts = [
    `<b>CELLS</b> ${grid.n.toLocaleString()}`, `<b>SENSOR LAYERS</b> ${grid.meta.features.length}`,
    `<b>SOURCE</b> NASA POWER · MERRA-2 · CERES · GPM IMERG · ETOPO1`,
    `<b>VALIDATION</b> mean ROC AUC ${P.meanAUC.toFixed(2)} vs ${KNOWN.length} agency analog sites`,
    `<em>NEW CANDIDATES</em> ${hi.join("  ·  ")}`,
    `<b>TARGETS</b> ${T.length} (Artemis III · Chandrayaan-3 · Jezero · Gale · Arcadia…)`,
    `<b>TIP</b> press ⚔ ANALOG HUNT and try to beat the algorithm`,
  ];
  $("#ticker").innerHTML = parts.join("   ◈   ") + "   ◈   ";
}

function renderPilot(p) {
  const r = G.rankOf(p.xp);
  $("#rankIcon").textContent = r.icon;
  $("#rankName").textContent = r.name;
  $("#rankLvl").textContent = `LV ${r.level}`;
  $("#xpTxt").textContent = `${p.xp.toLocaleString()} XP`;
  $("#xpBar").style.width = `${Math.round(r.frac * 100)}%`;
  $("#badgeCount").textContent = `${Object.keys(p.badges).length}/${Object.keys(G.BADGES).length}`;
  if ($("#logModal").open) renderLog();
}

function renderLog() {
  const p = G.getProfile(), r = G.rankOf(p.xp);
  const next = G.RANKS[r.level]?.[1];
  $("#logBody").innerHTML = `
    <div class="lg-rank"><div class="ic">${r.icon}</div><div><span class="muted small">LEVEL ${r.level}</span><br><b>${esc(r.name)}</b><div class="muted small">${p.xp.toLocaleString()} XP${next ? ` · ${(r.hi - p.xp).toLocaleString()} XP to ${esc(next)}` : " · max rank"}</div><span class="xpbar"><i style="width:${Math.round(r.frac * 100)}%"></i></span></div></div>
    <div class="lg-stats">
      <div><b>${Object.keys(p.scans).length}/${T.length}</b><span>targets scanned</span></div>
      <div><b>${p.inspected}</b><span>sites inspected</span></div>
      <div><b>${Object.keys(p.countries).length}</b><span>countries</span></div>
      <div><b>${p.discoveries.length}</b><span>discoveries logged</span></div>
      <div><b>${p.hunt.best.toLocaleString()}</b><span>best hunt score</span></div>
    </div>
    <p class="h3l">Achievements · ${Object.keys(p.badges).length}/${Object.keys(G.BADGES).length}</p>
    <div class="badges">${Object.entries(G.BADGES).map(([id, b]) => `<div class="bd ${p.badges[id] ? "" : "locked"}"><span class="bi">${b.icon}</span><span><b>${esc(b.name)}</b><span>${esc(b.desc)}</span></span></div>`).join("")}</div>
    <p class="h3l">Discovery log</p>
    ${p.discoveries.length ? `<ul class="disc-log">${p.discoveries.map((d) => `<li>${gradeHex(d.grade)}<span><b>${esc(d.name)}</b> <span class="muted small">${esc(d.country || "")} · ${d.lat.toFixed(1)}°, ${d.lon.toFixed(1)}°</span><br><span class="small">analog of ${esc(d.targetName)} · fidelity ${d.score} ${d.isNew ? '<span class="tag new">NEW</span>' : ""} <span class="muted">${d.date}</span></span></span><span><button class="btn ghost sm" data-open="${esc(d.key)}" type="button">Open</button></span></li>`).join("")}</ul>
      <div class="actions"><button class="btn sm" id="logExport" type="button">⬇ Export log (.md)</button><button class="btn ghost sm" id="logReset" type="button">Reset profile</button></div>`
      : `<p class="muted small">Inspect a site in the explorer and press <b>★ Log discovery</b> to add it here. NEW (uncharacterised) sites earn the most XP.</p><div class="actions"><button class="btn ghost sm" id="logReset" type="button">Reset profile</button></div>`}`;
  $$("#logBody [data-open]").forEach((b) => b.addEventListener("click", () => {
    const d = p.discoveries.find((x) => x.key === b.dataset.open);
    $("#logModal").close();
    if (d) openDiscovery(d.target, `${d.lat},${d.lon}`, d.preset);
  }));
  $("#logExport")?.addEventListener("click", () => {
    const md = [`# Analog Atlas — discovery log`, "", `Rank: ${r.name} (LV ${r.level}, ${p.xp} XP)`, "", "| Grade | Site | Country | Lat | Lon | Analog of | Fidelity | New | Date |", "|---|---|---|---|---|---|---|---|---|",
      ...p.discoveries.map((d) => `| ${d.grade} | ${d.name} | ${d.country || ""} | ${d.lat.toFixed(2)} | ${d.lon.toFixed(2)} | ${d.targetName} | ${d.score} | ${d.isNew ? "yes" : ""} | ${d.date} |`)].join("\n");
    download(md, "analog-atlas-discovery-log.md");
  });
  $("#logReset")?.addEventListener("click", () => { if (confirm("Reset XP, achievements and discovery log stored in this browser?")) { G.resetProfile(); renderLog(); } });
}

function download(text, name) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function setScanStat(title, sub, busy = false) {
  $("#scanTitle").textContent = title;
  $("#scanSub").textContent = sub;
  $("#scanStat").classList.toggle("busy-scan", busy);
}

// ------------------------------------------------------------------ controls
function buildControls() {
  $$(".seg button").forEach((b) => b.addEventListener("click", () => {
    if (state.body === b.dataset.body || state.hunt) return;
    state.body = b.dataset.body;
    state.target = T.find((t) => t.body === state.body);
    state.cell = -1;
    earth.select(null);
    syncBody();
    recompute({ fly: true });
  }));
  $("#targetSel").addEventListener("change", (e) => { if (state.hunt) { e.target.value = state.target.id; return; } setTarget(e.target.value); });

  const pr = $("#presets");
  for (const [k, p] of Object.entries(E.PRESETS)) {
    const b = document.createElement("button");
    b.className = "chip"; b.dataset.k = k; b.setAttribute("role", "radio"); b.title = p.blurb;
    b.innerHTML = `<span class="ci">${PRESET_ICON[k] || "◈"}</span><span>${esc(p.label)}</span>`;
    b.addEventListener("click", () => { if (state.hunt) return; state.preset = k; state.weights = { ...p.w }; syncPreset(); recompute(); G.track("preset", { id: k, label: p.label }); });
    pr.appendChild(b);
  }
  const sl = $("#sliders");
  for (const [g, meta] of Object.entries(E.GROUPS)) {
    const row = document.createElement("label");
    row.className = "slider";
    row.innerHTML = `<span>${meta.icon}</span><input type="range" min="0" max="3" step="0.5" data-g="${g}" aria-label="${meta.label} weight"><span>${meta.label}</span><output></output>`;
    row.querySelector("input").addEventListener("input", (e) => {
      if (state.hunt) return;
      state.weights[g] = +e.target.value;
      state.preset = "custom";
      syncPreset();
      recompute({ quiet: true });
    });
    sl.appendChild(row);
  }
  $("#aggWlc").addEventListener("change", (e) => { state.wlc = e.target.checked; recompute(); });
  $("#onlyNew").addEventListener("change", (e) => { state.onlyNew = e.target.checked; recompute(); });
  $("#novKm").addEventListener("input", (e) => { state.novKm = +e.target.value; $("#novOut").textContent = state.novKm; if (state.onlyNew) recompute({ quiet: true }); });
  $("#accKm").addEventListener("input", (e) => { state.accKm = +e.target.value; $("#accOut").textContent = state.accKm >= 1000 ? "any" : `${state.accKm} km`; recompute({ quiet: true }); });
  $("#showKnown").addEventListener("change", (e) => { state.showKnown = e.target.checked; earth.showKnown(state.showKnown && !state.hunt); });

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
  ls.addEventListener("change", () => { setLayer(ls.value); });

  $$(".tabs .tab[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $$(".rtab").forEach((b) => b.addEventListener("click", () => showRight(b.dataset.r)));
  $("#tourBtn").addEventListener("click", startTour);
  $("#huntBtn").addEventListener("click", () => (state.hunt ? endHunt() : startHunt()));
  $("#logBtn").addEventListener("click", () => { renderLog(); $("#logModal").showModal(); });
  $("#logClose").addEventListener("click", () => $("#logModal").close());
  $("#logModal").addEventListener("click", (e) => { if (e.target === $("#logModal")) $("#logModal").close(); });
  const snd = $("#sndBtn");
  const syncSnd = () => { snd.textContent = G.isSoundOn() ? "🔊" : "🔇"; snd.setAttribute("aria-pressed", G.isSoundOn()); };
  snd.addEventListener("click", () => { G.setSound(!G.isSoundOn()); syncSnd(); G.sfx.click(); });
  syncSnd();
  document.addEventListener("click", (e) => { if (e.target.closest(".btn, .chip, .tab, .rtab, .seg button, .cand, .hi, .pilot")) G.sfx.click(); });
  window.addEventListener("hashchange", () => { if (location.hash.startsWith("#discover")) showView("discover", false); else if (location.hash.startsWith("#validate")) showView("validate", false); });
  G.onChange(renderPilot);
}

function setLayer(id) {
  state.layer = id;
  $("#layerSel").value = id;
  drawOverlay();
  paintOverlay(1);
  drawLegend();
  G.track("layer", { id });
}

function showView(v, push = true) {
  $$(".view").forEach((el) => el.classList.toggle("on", el.id === v));
  $$(".tabs .tab[data-view]").forEach((b) => { b.classList.toggle("on", b.dataset.view === v); b.setAttribute("aria-selected", b.dataset.view === v); });
  if (push) history.replaceState(null, "", v === "explore" ? hashFor() : `#${v}`);
  if (v === "validate") G.track("validate");
  if (v === "discover") G.track("discover");
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

/** 0–5 "hostility" pips: how far the target sits beyond anything on Earth. */
function hostility(t) {
  const e = t.env;
  let h = 0;
  if (e.t_surface_mean_C < -50) h++;
  if (e.t_surface_min_C < -120) h++;
  if (e.diurnal_range_C > 100) h++;
  if (e.pressure_kPa < 1) h++;
  if ((e.radiation_mSv_per_day ?? 0) > 1) h++;
  return h;
}

function renderTargetCard() {
  const t = state.target, e = t.env;
  const T_ = (v) => `${v > 0 ? "+" : ""}${Math.round(v)} °C`;
  const pres = t.body === "moon" ? "vacuum" : `${(e.pressure_kPa * 1000).toFixed(0)} Pa`;
  const L = E.bodyLighting(t.body, t.lat);
  const h = hostility(t);
  $("#targetCard").innerHTML = `
    <h3>${esc(t.name)}</h3>
    <div class="tags"><span class="tag ${t.body}">${t.body === "moon" ? "MOON" : "MARS"} · ${t.lat.toFixed(2)}°, ${t.lon.toFixed(2)}°</span>${(t.missions || []).slice(0, 3).map((m) => `<span class="tag">${esc(m)}</span>`).join("")}<span class="tag ${t.confidence === "low" ? "warn" : ""}" title="Confidence in the environmental values">data: ${esc(t.confidence)}</span></div>
    <div class="threat" title="Environment hostility: conditions beyond anything on Earth">HOSTILITY <i style="max-width:${h * 20}%"></i> ${h}/5</div>
    <p>${esc(t.summary)}</p>
    <div class="envgrid">
      <div><span>Mean surface</span><span>${T_(e.t_surface_mean_C)}</span></div>
      <div><span>Range</span><span>${T_(e.t_surface_min_C)}…${T_(e.t_surface_max_C)}</span></div>
      <div><span>Pressure</span><span>${pres}</span></div>
      <div><span>Max Sun</span><span>${e.sun_elevation_max_deg != null ? e.sun_elevation_max_deg + "°" : "—"}</span></div>
      <div><span>Low-Sun time</span><span>${Math.round(L.lowsun * 100)}%</span></div>
      <div><span>Ice</span><span>${esc((e.ice || "none").replace(/-/g, " "))}</span></div>
      <div><span>Slope</span><span>${e.slope_deg_typical ?? "—"}°</span></div>
      <div><span>Radiation</span><span>${e.radiation_mSv_per_day ?? "—"} mSv/d</span></div>
    </div>
    <div class="tags">${(e.geology || []).map((g) => `<span class="tag">${esc(g.replace(/-/g, " "))}</span>`).join("")}</div>
    <details><summary>Sources (${t.sources.length})</summary><ul class="src">${t.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join("")}</ul></details>`;
}

// ------------------------------------------------------------------ scoring & rendering
function candidateFilter() {
  return (i) => (!state.onlyNew || DIST_KNOWN[i] > state.novKm) && (state.accKm >= 1000 || grid.f.d_access[i] <= state.accKm);
}

function recompute({ fly = false, quiet = false } = {}) {
  state.model = E.modelFor(grid, state.target, state.weights, { aggregate: state.wlc ? "wlc" : "geo" });
  state.S = E.scoreGrid(grid, state.model);
  if (state.hunt) return;
  const filt = candidateFilter();
  state.cands = E.topSites(grid, state.S, { k: 12, sepKm: 350, filter: filt });
  earth.setMarkers(state.cands.map((i) => ({ lat: grid.lat[i], lon: grid.lon[i], cell: i, isNew: DIST_KNOWN[i] > state.novKm, grade: gradeOf(state.S[i]) })));
  drawOverlay();
  drawLegend();
  renderCands();
  if (state.cell >= 0) renderReport(state.cell);
  else if (fly && state.cands.length) earth.flyTo(grid.lat[state.cands[0]], grid.lon[state.cands[0]], 2.9);
  history.replaceState(null, "", hashFor());
  requestRobustness();
  if (quiet || REDUCED) { paintOverlay(1); setScanStat("LOCKED", `${state.target.name.split("(")[0].trim()} · ${grid.n.toLocaleString()} cells`); }
  else runScan(() => setScanStat("LOCKED", `${state.target.name.split("(")[0].trim()} · best twin ${Math.round(state.S[state.cands[0]] * 100)}`));
  G.track("scan", { id: state.target.id, body: state.target.body, name: state.target.name.split("(")[0].trim(), total: T.length });
}

/** Sweep the scanner beam around the globe, revealing the heatmap behind it. */
function runScan(done) {
  const lon0 = earth.viewLon() - 120;
  setScanStat("SCANNING", `${grid.n.toLocaleString()} land cells · ${state.model.terms.length} factors`, true);
  G.sfx.scan();
  earth.scan(lon0, 1.15, (t) => {
    paintOverlay(t, lon0);
    if (t >= 1) { G.sfx.lock(); done?.(); }
  });
}

// ramp (deep blue → cyan → green → yellow → red-orange): the hot end stays visible on white ice
const RAMP = [[6, 14, 50], [20, 80, 170], [0, 200, 230], [124, 255, 178], [255, 210, 63], [255, 70, 90]];
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
  if (state.hunt && state.hunt.phase === "guess") { g.putImageData(img, 0, 0); return; }
  const filt = candidateFilter();
  if (state.layer === "score" || state.hunt) {
    let mx = 0;
    for (let i = 0; i < grid.n; i++) if (state.S[i] > mx) mx = state.S[i];
    const lo = mx * 0.25;
    for (let i = 0; i < grid.n; i++) {
      const v = (state.S[i] - lo) / (mx - lo || 1);
      const p = grid.idx[i] * 4;
      const [r, gg, b] = ramp(v);
      d[p] = r; d[p + 1] = gg; d[p + 2] = b;
      let a = v <= 0 ? 40 : 70 + 185 * v ** 1.2;
      if (!state.hunt && !filt(i)) a *= 0.25;
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
}

/** Copy the computed overlay to the globe texture; frac < 1 reveals only longitudes swept so far. */
function paintOverlay(frac = 1, lon0 = 0) {
  const oc = earth.overlayCanvas, og = oc.getContext("2d");
  og.clearRect(0, 0, oc.width, oc.height);
  og.imageSmoothingEnabled = true;
  if (frac >= 1) og.drawImage(small, 0, 0, oc.width, oc.height);
  else {
    const W = oc.width, sw = small.width;
    const x0 = (((lon0 + 180) / 360) % 1 + 1) % 1, span = frac;
    const seg = (a, b) => { if (b > a) og.drawImage(small, a * sw, 0, (b - a) * sw, small.height, a * W, 0, (b - a) * W, oc.height); };
    if (x0 + span <= 1) seg(x0, x0 + span);
    else { seg(x0, 1); seg(0, x0 + span - 1); }
  }
  earth.refreshOverlay();
}

function drawLegend() {
  const css = `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(",")})`).join(",")})`;
  let html;
  if (state.layer === "score") {
    let mx = 0;
    for (let i = 0; i < grid.n; i++) if (state.S[i] > mx) mx = state.S[i];
    html = `<b>Twin score</b> · ${esc(state.target.name)}<div class="ramp" style="background:${css}"></div><div class="ends"><span>${Math.round(mx * 25)}</span><span>${Math.round(mx * 100)} BEST ON EARTH</span></div>
      <div class="key"><span><i style="background:#00e5ff;border-radius:50%"></i>top twin</span><span><i style="background:#7cffb2;border-radius:50%"></i>NEW</span><span><i style="background:#ff3df0;border-radius:50%"></i>S-grade</span><span><i style="background:#fff;transform:rotate(45deg)"></i>established</span></div>`;
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
  $("#candHead").innerHTML = `Best Earth twins for <b>${esc(t.name)}</b> · ${state.preset === "custom" ? "custom weights" : esc(E.PRESETS[state.preset].label)}${state.onlyNew ? ` · only &gt;${state.novKm} km from known sites` : ""}. Distinct regions ≥350 km apart.`;
  $("#candList").innerHTML = state.cands.map((i, k) => {
    const L = label(i), s = state.S[i], isNew = DIST_KNOWN[i] > state.novKm;
    const rb = state.robust.get(i);
    const g = gradeOf(s);
    return `<li class="cand${i === state.cell ? " on" : ""}" data-i="${i}" tabindex="0" style="animation-delay:${k * 45}ms">
      ${gradeHex(g, `<small>#${k + 1}</small>`)}
      <span><span class="nm">${esc(L.title)}</span><br><span class="sub">${esc(L.sub)}${L.sub ? " · " : ""}${grid.lat[i].toFixed(1)}°, ${grid.lon[i].toFixed(1)}° · ${E.koppenOf(grid, i)}</span>
      <span class="tags">${isNew ? `<span class="tag new">NEW · ${fmtKm(DIST_KNOWN[i])} from known</span>` : `<span class="tag">near established site</span>`}<span class="tag" title="Distance to nearest airport, town or research station">✈ ${fmtKm(grid.f.d_access[i])}</span>${rb != null ? `<span class="tag ${rb >= 0.7 ? "new" : rb < 0.4 ? "warn" : ""}" title="Rank stability: share of ±35% weight perturbations in which this region stays among the top 12">stability ${Math.round(rb * 100)}%</span>` : ""}</span>
      <div class="bar"><i style="width:${(s * 100).toFixed(0)}%"></i></div></span>
      <span class="sc">${Math.round(s * 100)}<small>TWIN</small></span></li>`;
  }).join("") || `<li class="muted">No land cells pass the filters — relax them.</li>`;
  $$("#candList .cand").forEach((li) => {
    const go = () => selectCell(+li.dataset.i, { fly: true });
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

function hover(p, x, y) {
  const tip = $("#tip");
  if (!p || (p.lat == null && !p.marker && !p.known) || (state.hunt && state.hunt.phase === "guess")) {
    tip.style.display = "none";
    if (state.hunt && state.hunt.phase === "guess" && p && p.lat != null) {
      tip.innerHTML = `<b>${p.lat.toFixed(1)}°, ${p.lon.toFixed(1)}°</b><br><span class="muted">click to lock your pick</span>`;
      tip.style.display = "block"; tip.style.left = `${x + 14}px`; tip.style.top = `${y + 14}px`;
    }
    return;
  }
  let html;
  if (p.known) html = `<b>◆ ${esc(p.known.name)}</b><br>${esc(p.known.note || "")}<br><span class="muted">${esc((p.known.programs || []).join(", "))}</span>`;
  else {
    const lat = p.marker ? p.marker.lat : p.lat, lon = p.marker ? p.marker.lon : p.lon;
    const i = E.nearestCell(grid, lat, lon, 60);
    if (i < 0) { tip.style.display = "none"; return; }
    const L = label(i);
    const pct = E.percentileOf(state.S, state.S[i]);
    const lay = state.layer === "score" ? `twin score <b>${Math.round(state.S[i] * 100)}</b> · grade <b>${gradeOf(state.S[i])}</b> · top ${Math.max(0.1, 100 - pct).toFixed(1)}%` : `${esc(grid.fmeta[state.layer].label)}: <b>${fmtVal(state.layer, grid.f[state.layer][i])}</b>`;
    html = `<b>${esc(L.title)}</b>${L.sub ? `, ${esc(L.sub)}` : ""}<br>${lay}`;
  }
  tip.innerHTML = html;
  tip.style.display = "block";
  const W = $(".stage").clientWidth;
  tip.style.left = `${Math.min(W - 280, x + 14)}px`;
  tip.style.top = `${y + 14}px`;
}

function fmtVal(id, v) {
  const m = grid.fmeta[id];
  if (id === "lowsun" || id === "polarnight" || id === "ice" || id === "snow" || id === "landfrac") return `${Math.round(v * 100)}%`;
  if (id.startsWith("d_")) return fmtKm(v);
  return `${v.toLocaleString("en-US", { maximumFractionDigits: m.decimals })}${m.unit ? " " + m.unit : ""}`;
}

// ------------------------------------------------------------------ site dossier
function selectCell(i, { fly = false, known = null } = {}) {
  state.cell = i;
  earth.select(grid.lat[i], grid.lon[i]);
  if (fly) earth.flyTo(grid.lat[i], grid.lon[i], 2.2);
  earth.stopSpin();
  renderReport(i, known);
  renderCands();
  showRight("report");
  history.replaceState(null, "", hashFor());
  G.sfx.lock();
  G.track("inspect", { country: E.regionLabel(grid, i).country, grade: gradeOf(state.S[i]), lat: grid.lat[i], southPole: state.target.category === "south-pole" });
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
  const grade = gradeOf(ex.score);
  const isNew = DIST_KNOWN[i] > state.novKm;
  const rb = state.robust.get(i);
  const groups = Object.keys(E.GROUPS).filter((g) => ex.groups[g] != null);
  const short = { thermal: "Thermal", water: "Aridity", atmosphere: "Atmosphere", terrain: "Terrain", geology: "Geology", lighting: "Lighting" };
  const axes = groups.map((g) => ({ label: short[g], value: ex.groups[g], share: ex.shares[g] }));
  const best = ex.rows.filter((r) => r.id !== "ice").sort((a, b) => b.weight * b.match - a.weight * a.match).slice(0, 3);
  const knownScore = nk.site ? state.S[E.nearestCell(grid, nk.site.lat, nk.site.lon)] : null;
  const logged = G.getProfile().discoveries.some((d) => d.key === `${state.target.id}|${grid.lat[i].toFixed(1)}|${grid.lon[i].toFixed(1)}`);
  const rowsByGroup = groups.map((g) => {
    const rs = ex.rows.filter((r) => r.group === g);
    return `<tr class="grp"><td colspan="3">${E.GROUPS[g].icon} ${E.GROUPS[g].label} · ${Math.round(ex.groups[g] * 100)}%</td></tr>` + rs.map((r) => {
      const m = grid.fmeta[r.id];
      const col = r.match >= 0.66 ? "#7cffb2" : r.match >= 0.33 ? "#ffd23f" : "#ff4d6d";
      const pw = percentWord(r.id, r.rank);
      return `<tr><td>${esc(m.label)}<br><span class="muted small">target: ${esc(r.why)}</span>${pw ? `<br><span class="small" style="color:#9ff0c8">${esc(pw)}</span>` : ""}</td><td class="v">${fmtVal(r.id, r.value)}</td><td class="v"><span class="mbar"><i style="width:${Math.round(r.match * 100)}%;background:${col}"></i></span> ${Math.round(r.match * 100)}</td></tr>`;
    }).join("");
  }).join("");
  $("#report").innerHTML = `
    <div class="rep-head"><span class="muted small">${known ? `◆ ESTABLISHED ANALOG: ${esc(known.name)}` : isNew ? `<span class="tag new">NEW CANDIDATE · UNCHARACTERISED</span>` : "EARTH SITE"}</span>
      <h3>${esc(L.title)}</h3><div class="muted">${esc(L.sub)}${L.sub ? " · " : ""}${grid.lat[i].toFixed(2)}°, ${grid.lon[i].toFixed(2)}° · Köppen ${E.koppenOf(grid, i)} · cell ~${Math.round(55 * Math.cos(grid.lat[i] * Math.PI / 180))}×55 km</div></div>
    <div class="rep-score">${dial(ex.score, { label: "twin score" }).replace('<b>', `<span class="dgrade" style="color:${{ S: "#ff3df0", A: "#00e5ff", B: "#5fd4ff", C: "#7f9bb0", D: "#7f9bb0" }[grade]}">GRADE ${grade}</span><b>`)}
      <div class="facts">
        <div><span>Rank on Earth</span><span>top ${Math.max(0.01, 100 - pct).toFixed(pct > 99 ? 2 : 1)}%</span></div>
        <div><span>Analog of</span><span>${esc(state.target.name.split("(")[0])}</span></div>
        <div><span>Nearest known analog</span><span>${nk.site ? `${esc(nk.site.name.split("(")[0])} · ${fmtKm(nk.km)}` : "—"}</span></div>
        <div><span>Access</span><span>${fmtKm(grid.f.d_access[i])}</span></div>
        <div><span>Rank stability</span><span>${rb != null ? Math.round(rb * 100) + "%" : state.cands.includes(i) ? "computing…" : "—"}</span></div>
        ${ex.gate < 0.999 ? `<div><span>Ice-sheet penalty</span><span>×${ex.gate.toFixed(2)}</span></div>` : ""}
      </div></div>
    ${radar(axes, { color: "#00e5ff" })}
    <div class="callout"><b>Why it matches</b> ${best.map((r) => `${esc(grid.fmeta[r.id].label.toLowerCase())} (${Math.round(r.match * 100)}%)`).join(", ")}.</div>
    <div class="callout lim"><b>Limiting factor</b> ${esc(grid.fmeta[ex.limiting.id].label)} — ${fmtVal(ex.limiting.id, ex.limiting.value)} vs target “${esc(ex.limiting.why)}”.</div>
    ${knownScore != null && nk.km > 5 ? `<p class="small muted">Versus ${esc(nk.site.name)} (twin score ${Math.round(knownScore * 100)}): <b style="color:${state.S[i] >= knownScore ? "#7cffb2" : "#ffd23f"}">${state.S[i] >= knownScore ? "+" : ""}${Math.round((state.S[i] - knownScore) * 100)}</b> points for this target.</p>` : ""}
    <div class="actions"><button class="btn ok sm" id="logDisc" type="button" ${logged ? "disabled" : ""}>${logged ? "✓ Logged" : `★ Log discovery${isNew ? " (+XP bonus)" : ""}`}</button><button class="btn sm" id="briefBtn" type="button">⬇ Field brief</button><button class="btn ghost sm" id="linkBtn" type="button">🔗 Link</button><button class="btn ghost sm" id="layerBtn" type="button">Limiting layer</button></div>
    <table class="ftable"><thead><tr><th>Factor (NASA data)</th><th class="v">Site</th><th class="v">Match</th></tr></thead><tbody>${rowsByGroup}</tbody></table>
    <p class="small muted">Match = similarity in percentile space: 100 means the site sits at the same position in Earth's distribution as the (Earth-clamped) target condition. Group scores combine by weighted geometric mean, so one failed factor drags the total down. Grades by twin score: S ≥ 75, A ≥ 60, B ≥ 45, C ≥ 30 — for airless, −100 °C lunar-pole targets even Earth's best twin rarely beats B.</p>`;
  $("#briefBtn").onclick = () => { downloadBrief(i, ex, L, nk); G.track("brief"); };
  $("#linkBtn").onclick = () => { navigator.clipboard?.writeText(location.href); $("#linkBtn").textContent = "✓ Copied"; };
  $("#layerBtn").onclick = () => setLayer(ex.limiting.id);
  $("#logDisc").onclick = () => {
    const ok = G.track("discovery", { target: state.target.id, targetName: state.target.name.split("(")[0].trim(), preset: state.preset, name: L.title, country: L.sub || E.regionLabel(grid, i).country, lat: grid.lat[i], lon: grid.lon[i], score: Math.round(ex.score * 100), grade, isNew });
    if (ok !== false) { $("#logDisc").textContent = "✓ Logged"; $("#logDisc").disabled = true; }
  };
}

function downloadBrief(i, ex, L, nk) {
  const t = state.target;
  const pct = E.percentileOf(state.S, state.S[i]);
  const lines = [
    `# Analog field brief — ${L.title}${L.sub ? `, ${L.sub}` : ""}`, "",
    `*Generated by Analog Atlas (NASA Space Apps 2026) from open NASA Earth data.*`, "",
    `| | |`, `|---|---|`,
    `| Location | ${grid.lat[i].toFixed(2)}°, ${grid.lon[i].toFixed(2)}° (0.5° cell) |`,
    `| Analog of | ${t.name} (${t.body}, ${t.lat}°, ${t.lon}°) |`,
    `| Mission objective | ${state.preset === "custom" ? "custom weights" : E.PRESETS[state.preset].label} |`,
    `| Twin score | ${Math.round(ex.score * 100)}/100 · grade ${gradeOf(ex.score)} — top ${Math.max(0.01, 100 - pct).toFixed(2)}% of Earth's land |`,
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
  download(lines.join("\n"), `analog-brief-${t.id}-${grid.lat[i].toFixed(1)}_${grid.lon[i].toFixed(1)}.md`);
}

// ------------------------------------------------------------------ Analog Hunt (mini-game)
const HUNT_ROUNDS = 5;
const HUNT_OBJ = { "south-pole": ["power", "habitat", "isru"], "lava-tube": ["mobility", "balanced"], mare: ["mobility", "balanced"], "crater-lake": ["astrobio", "mobility"], sedimentary: ["astrobio", "balanced"], "ground-ice": ["isru", "balanced"], volcanic: ["mobility", "balanced"], canyon: ["mobility", "astrobio"], polar: ["isru", "habitat"] };
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

function startHunt(saved = null) {
  showView("explore");
  const byCat = {};
  for (const t of T) (byCat[`${t.body}|${t.category}`] ||= []).push(t);
  const pools = Object.values(byCat).sort(() => Math.random() - 0.5);
  const rounds = pools.slice(0, HUNT_ROUNDS).map((p) => { const t = pick(p); return { target: t, preset: pick(HUNT_OBJ[t.category] || ["balanced"]) }; });
  state.hunt = { k: 0, rounds, results: [], phase: "guess", saved: saved || { target: state.target, preset: state.preset, weights: { ...state.weights }, layer: state.layer, cell: state.cell } };
  document.body.classList.add("huntmode");
  $("#huntBtn").textContent = "✕ Exit hunt";
  earth.showMarkers(false);
  earth.showKnown(false);
  earth.select(null);
  state.layer = "score";
  $(".rtabs").hidden = true;
  showRight("huntPanel");
  G.toast("<b>ANALOG HUNT</b> <span>5 rounds · click where you think the best Earth twin is</span>", "", 3500);
  huntRound();
}

function huntRound() {
  const H = state.hunt, R = H.rounds[H.k];
  H.phase = "guess";
  state.target = R.target; state.body = R.target.body; state.preset = R.preset; state.weights = { ...E.PRESETS[R.preset].w }; state.cell = -1;
  syncBody();
  recompute();
  drawOverlay(); paintOverlay(1); drawLegend();
  earth.setPins([]);
  setScanStat("HUNT ACTIVE", `round ${H.k + 1}/${HUNT_ROUNDS} · awaiting your pick`, true);
  const e = R.target.env;
  $("#huntHud").hidden = false;
  $("#huntHud").innerHTML = `<div class="k">Analog Hunt · round ${H.k + 1} / ${HUNT_ROUNDS}</div><div class="rounds">${H.rounds.map((_, k) => `<i class="${k < H.k ? "done" : k === H.k ? "cur" : ""}"></i>`).join("")}</div>
    <h3>${esc(R.target.name)} ${R.target.body === "moon" ? "🌕" : "🔴"}</h3>
    <p>Objective <b>${PRESET_ICON[R.preset]} ${esc(E.PRESETS[R.preset].label)}</b> · click the Earth location you think is its best twin.</p>`;
  $("#huntPanel").innerHTML = `
    <p class="kicker">// ANALOG HUNT</p><h3 style="margin:2px 0 6px">Beat the algorithm</h3>
    <p class="small">Study the target dossier on the left — temperature, pressure, Sun angle, ice, geology — then click the place on Earth you think matches best. The heatmap stays hidden until you lock in.</p>
    <div class="callout"><b>Intel</b> mean ${Math.round(e.t_surface_mean_C)} °C · ${R.target.body === "moon" ? "airless" : `${Math.round(e.pressure_kPa * 1000)} Pa`} · Sun ≤ ${e.sun_elevation_max_deg ?? "?"}° · ice: ${esc((e.ice || "none").replace(/-/g, " "))} · ${esc((e.geology || []).slice(0, 3).join(", ").replace(/-/g, " "))}</div>
    <p class="small muted">Scoring: up to 1,000 points per round from your pick's Earth percentile (top 1% ≈ 940), +150 bullseye bonus within 300 km of the algorithm's #1 twin.</p>
    ${huntTable()}`;
}

function huntTable() {
  const H = state.hunt;
  if (!H.results.length) return "";
  return `<p class="h3l">Scoreboard</p>${H.results.map((r, k) => `<div class="hunt-row"><span>R${k + 1} · ${esc(r.target.split("(")[0])}</span><span>${r.grade} · <b>${r.points}</b></span></div>`).join("")}<div class="hunt-row"><span><b>TOTAL</b></span><span><b>${H.results.reduce((a, r) => a + r.points, 0).toLocaleString()}</b></span></div>`;
}

function huntPick(lat, lon) {
  const H = state.hunt;
  if (H.phase !== "guess") return;
  const i = E.nearestCell(grid, lat, lon, 80);
  if (i < 0) { G.sfx.miss(); G.toast("<b>OCEAN</b> <span>Analogs need land — try again.</span>", "", 2000); return; }
  H.phase = "reveal";
  $("#tip").style.display = "none";
  const S = state.S;
  const best = E.topSites(grid, S, { k: 1 })[0];
  const pct = E.percentileOf(S, S[i]);
  const km = E.haversine(grid.lat[i], grid.lon[i], grid.lat[best], grid.lon[best]);
  const base = Math.round(1000 * (Math.max(0, pct - 50) / 50) ** 3);
  const bull = km <= 300 ? 150 : 0;
  const points = Math.min(1000, base + bull);
  const grade = gradeOf(S[i]);
  const L = label(i), LB = label(best);
  H.results.push({ target: H.rounds[H.k].target.name, points, grade, pct, km });
  earth.setPins([{ lat: grid.lat[i], lon: grid.lon[i], text: "★", color: "#ff3df0" }, { lat: grid.lat[best], lon: grid.lon[best], text: "1", color: "#ffd23f" }]);
  earth.flyTo((grid.lat[i] + grid.lat[best]) / 2, grid.lat[i] === grid.lat[best] ? grid.lon[i] : grid.lon[best], Math.min(4.2, 2.4 + km / 6000));
  drawOverlay();
  drawLegend();
  runScan(() => {
    setScanStat("ROUND SCORED", `${points} pts · grade ${grade}`);
    if (points >= 700) G.sfx.badge(); else if (points < 150) G.sfx.miss();
  });
  const last = H.k === HUNT_ROUNDS - 1;
  $("#huntHud").innerHTML = `<div class="k">Round ${H.k + 1} result</div><div class="pts">+${points}</div>
    <p>Your pick <b>${esc(L.title)}</b> ${gradeHex(grade, "", "inline")} top ${Math.max(0.01, 100 - pct).toFixed(pct > 99 ? 2 : 1)}% · twin score ${Math.round(S[i] * 100)}${bull ? " · 🎯 BULLSEYE +150" : ""}</p>
    <p class="small muted">Algorithm's #1: ${esc(LB.title)}${LB.sub ? `, ${esc(LB.sub)}` : ""} (${Math.round(S[best] * 100)}) · ${fmtKm(km)} away</p>
    <div class="actions" style="justify-content:center"><button class="btn sm" id="huntNext" type="button">${last ? "Final debrief ▸" : "Next round ▸"}</button></div>`;
  $("#huntPanel").innerHTML = `<p class="kicker">// ROUND ${H.k + 1} DEBRIEF</p>${huntTable()}<p class="small muted">The heatmap now shows the full twin-score field for this target — compare your intuition with 21 NASA-derived factors.</p>`;
  $("#huntNext").onclick = () => { if (last) huntDone(); else { H.k++; huntRound(); } };
}

function huntDone() {
  const H = state.hunt;
  const total = H.results.reduce((a, r) => a + r.points, 0);
  const best = G.getProfile().hunt.best;
  const rating = total >= 4200 ? "LEGENDARY" : total >= 3500 ? "SHARPSHOOTER" : total >= 2500 ? "FIELD EXPERT" : total >= 1500 ? "PROMISING SCOUT" : "TRAINEE";
  G.track("hunt", { total });
  H.phase = "done";
  $("#huntHud").innerHTML = `<div class="k">Hunt complete</div><div class="pts">${total.toLocaleString()}</div><p><b>${rating}</b>${total > best ? " · 🏆 NEW PERSONAL BEST" : ` · best ${best.toLocaleString()}`}</p>
    <div class="actions" style="justify-content:center"><button class="btn sm" id="huntAgain" type="button">Play again</button><button class="btn ghost sm" id="huntExit" type="button">Back to explorer</button></div>`;
  $("#huntPanel").innerHTML = `<p class="kicker">// FINAL DEBRIEF</p><div class="hunt-big"><span class="pts">${total.toLocaleString()}</span><span class="muted">of ${(HUNT_ROUNDS * 1000).toLocaleString()} · ${rating}</span></div>${huntTable()}<p class="small muted">XP earned: ${Math.round(total / 10)}. Every site you clicked can be explored in full once you return to the explorer.</p>`;
  $("#huntAgain").onclick = () => { const saved = H.saved; endHunt(true); startHunt(saved); };
  $("#huntExit").onclick = () => endHunt();
}

function endHunt(silent = false) {
  const H = state.hunt;
  if (!H) return;
  state.hunt = null;
  document.body.classList.remove("huntmode");
  $("#huntBtn").textContent = "⚔ Analog Hunt";
  $("#huntHud").hidden = true;
  $(".rtabs").hidden = false;
  earth.setPins([]);
  earth.showMarkers(true);
  earth.showKnown(state.showKnown);
  if (silent) return;
  Object.assign(state, { target: H.saved.target, body: H.saved.target.body, preset: H.saved.preset, weights: H.saved.weights, layer: H.saved.layer, cell: -1 });
  $("#layerSel").value = state.layer;
  syncBody();
  showRight("cands");
  recompute({ fly: true });
}

// ------------------------------------------------------------------ robustness worker
function startWorker() {
  try {
    worker = new Worker("js/worker.js", { type: "module" });
    worker.onmessage = (e) => {
      if (e.data.key !== robustKey()) return;
      state.robust = new Map(e.data.result);
      if (state.hunt) return;
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
  $("#aucChart").innerHTML = hbars(P.targets.map((r) => ({ label: r.name.replace(/\s*\(.*\)/, "").slice(0, 30), value: r.auc, color: r.body === "moon" ? "#c9c7c0" : "#ff7a45", note: `${r.n} matched sites (${r.themes.join(", ")})` })), { lo: 0.3, hi: 1 });
  const sel = $("#valTarget");
  sel.innerHTML = P.targets.map((r) => `<option value="${r.target}">${esc(r.name)}</option>`).join("");
  const draw = () => { const r = P.targets.find((x) => x.target === sel.value); $("#rankChart").innerHTML = rankDots(r.sites) + `<p class="small muted">Matched themes: ${esc(r.themes.join(", "))} · AUC ${r.auc} · median percentile ${r.medianPct.toFixed(0)}</p>`; };
  sel.addEventListener("change", draw);
  sel.value = "mars-gale";
  draw();
  $("#presetTable").innerHTML = `<table class="data"><thead><tr><th>Mission objective</th><th>Mean AUC</th><th>Moon</th><th>Mars</th></tr></thead><tbody>${Object.entries(VAL.presets).map(([k, v]) => `<tr><td>${PRESET_ICON[k]} ${esc(E.PRESETS[k].label)}</td><td><b>${v.meanAUC}</b></td><td>${v.moonAUC}</td><td>${v.marsAUC}</td></tr>`).join("")}<tr><td class="muted">Baseline: linear (compensatory) aggregation, balanced</td><td>${P.wlcMeanAUC}</td><td colspan="2" class="muted">similar AUC, but ranks hot deserts above polar sites for −100 °C lunar targets — the geometric mean fixes the physics</td></tr></tbody></table>`;
}

function renderDiscoveries() {
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
    <span class="n">BEST TWIN SCORE ${Math.round(a.best.score * 100)} · ${esc(a.bestT.name.split("(")[0])}</span></div>`).join("");
  $$("#discHi .hi").forEach((el) => {
    const go = () => openDiscovery(el.dataset.t, el.dataset.c);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
  const rows = [];
  for (const body of ["moon", "mars"]) {
    rows.push(`<tr class="body-row"><td colspan="6">${body === "moon" ? "🌕 MOON" : "🔴 MARS"}</td></tr>`);
    for (const t of DISC.targets.filter((x) => x.body === body)) {
      t.sites.slice(0, 3).forEach((s, k) => rows.push(`<tr>${k === 0 ? `<td rowspan="${Math.min(3, t.sites.length)}"><b>${esc(t.name)}</b></td>` : ""}
        <td>${esc(s.name || "—")}<br><span class="muted small">${esc(s.country)} · ${s.lat}°, ${s.lon}° · ${esc(s.koppen)}</span></td>
        <td><b>${Math.round(s.score * 100)}</b> <span class="muted small">top ${Math.max(0.01, 100 - s.pct).toFixed(2)}%</span></td>
        <td>${esc((s.nearestKnown || "").split("(")[0])}<br><span class="muted small">${fmtKm(s.nearestKnownKm)} away</span></td>
        <td>${fmtKm(s.accessKm)}</td>
        <td><a class="open" data-t="${t.id}" data-c="${s.lat},${s.lon}" href="#explore?t=${t.id}&p=balanced&c=${s.lat},${s.lon}">Open →</a></td></tr>`));
    }
  }
  $("#discTable").innerHTML = `<table class="data"><thead><tr><th>Target</th><th>New candidate region</th><th>Twin score</th><th>Nearest established analog</th><th>Access</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  $$("#discTable a.open").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); openDiscovery(a.dataset.t, a.dataset.c); }));
}

function openDiscovery(tid, c, preset = "balanced") {
  if (state.hunt) endHunt(true);
  state.preset = E.PRESETS[preset] ? preset : "balanced";
  state.weights = { ...E.PRESETS[state.preset].w };
  syncPreset();
  setTarget(tid);
  const [la, lo] = c.split(",").map(Number);
  showView("explore");
  selectCell(E.nearestCell(grid, la, lo, 80), { fly: true });
}

// ------------------------------------------------------------------ guided briefing
const TOUR = [
  ["#stepTarget", "Pick a destination", "Choose an Artemis III south-pole region, a lunar lava-tube skylight, or a Mars landing site. Each carries cited environmental values (Diviner, LOLA, ChaSTE, REMS, MEDA, SHARAD…)."],
  ["#stepPreset", "Choose the mission objective", "Rover mobility, ISRU ice prospecting, astrobiology, habitats or polar power each weight the six factor groups differently."],
  [".stage", "Earth, re-ranked", "21 factors from 32 data layers — NASA POWER (MERRA-2, CERES, GPM IMERG), ETOPO terrain, solar geometry and geology — are scored for 88,648 land cells, live in your browser. The scanner sweep reveals the result."],
  ["#cands", "Graded twins", "The best regions ≥350 km apart, graded S (twin score ≥ 75) to D. Green = NEW: far from any established analog. ‘Stability’ = survives ±35% weight perturbations."],
  ["#report", "Site dossier", "Factor-by-factor match, limiting factor, comparison with the nearest established analog. Log discoveries for XP, or export a field brief."],
  ["#huntBtn", "Analog Hunt", "Think you know Earth? Five rounds: read a Moon or Mars target's intel, click where you think its best Earth twin is, and see how you score against the algorithm."],
  ["#logBtn", "Your mission log", "XP, ranks from Cadet to Artemis Legend, 14 achievements and your discovery log — stored only in this browser."],
];
let tourK = 0;
function startTour() { if (state.hunt) endHunt(); showView("explore"); tourK = 0; $("#tour").hidden = false; stepTour(); }
function stepTour() {
  $$(".spot").forEach((el) => el.classList.remove("spot"));
  if (tourK >= TOUR.length) { $("#tour").hidden = true; return; }
  const [sel, h, p] = TOUR[tourK];
  if (sel === "#cands") showRight("cands");
  if (sel === "#report") { if (state.cands.length) selectCell(state.cands[0], { fly: true }); showRight("report"); }
  const el = $(sel);
  el.classList.add("spot");
  el.scrollIntoView?.({ block: "nearest" });
  $("#tourStep").textContent = `Briefing ${tourK + 1} / ${TOUR.length}`;
  $("#tourTitle").textContent = h;
  $("#tourText").textContent = p;
  $("#tourNext").textContent = tourK === TOUR.length - 1 ? "Done ✓" : "Next →";
  const card = $(".tour-card"), r = el.getBoundingClientRect();
  const w = Math.min(360, innerWidth - 32);
  let x = r.right + 12, y = r.top + 10;
  if (x + w > innerWidth - 8) x = Math.max(16, r.left - w - 12);
  if (r.bottom < 80) { x = Math.min(innerWidth - w - 16, Math.max(16, r.left - w / 2)); y = r.bottom + 12; }
  if (x < 16 || innerWidth < 920) { x = 16; y = Math.min(innerHeight - 220, r.bottom + 10); }
  card.style.left = `${x}px`;
  card.style.top = `${Math.max(64, Math.min(innerHeight - 220, y))}px`;
}
$("#tourNext").addEventListener("click", () => { tourK++; if (tourK >= TOUR.length) G.track("tour"); stepTour(); });
$("#tourSkip").addEventListener("click", () => { tourK = TOUR.length; stepTour(); });
$("#bootSkip").addEventListener("click", () => $("#boot").classList.add("done"));

startClock();
boot().catch((err) => {
  console.error(err);
  bootLine(`FAULT: ${err.message} — serve this folder over HTTP (python3 -m http.server)`, false);
  $("#busy").textContent = `Could not load data (${err.message}). Serve the folder over HTTP, e.g. "python3 -m http.server".`;
});
