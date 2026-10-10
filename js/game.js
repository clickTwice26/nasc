// Analog Atlas — game layer: player profile, XP & ranks, achievements, toasts, sound.
// Everything is local to this browser (localStorage) and purely cosmetic: it never
// changes a score.

const KEY = "analogAtlas.profile.v1";
const SND_KEY = "analogAtlas.sound";

export const RANKS = [
  [0, "Cadet", "◇"],
  [150, "Field Scout", "◆"],
  [400, "Analog Hunter", "✦"],
  [800, "Mission Geologist", "✧"],
  [1400, "Planetary Surveyor", "✪"],
  [2200, "Chief Scientist", "✹"],
  [3500, "Flight Director", "✺"],
  [5000, "Artemis Legend", "☄"],
];

export const BADGES = {
  "first-light":  { icon: "🛰", name: "First Light", desc: "Run your first planetary scan." },
  "moonwalker":   { icon: "🌕", name: "Moonwalker", desc: "Scan 5 different Moon targets." },
  "red-ranger":   { icon: "🔴", name: "Red Planet Ranger", desc: "Scan 5 different Mars targets." },
  "manifest":     { icon: "📜", name: "Full Manifest", desc: "Scan all 23 targets." },
  "strategist":   { icon: "🎯", name: "Mission Strategist", desc: "Try all 6 mission objectives." },
  "polar":        { icon: "🧊", name: "Polar Pioneer", desc: "Inspect a site beyond 66° latitude for a lunar south-pole target." },
  "twin":         { icon: "💎", name: "Twin Finder", desc: "Inspect an S-grade twin (score ≥ 75)." },
  "trailblazer":  { icon: "🧭", name: "Trailblazer", desc: "Log 3 NEW (uncharacterised) analog discoveries." },
  "cartographer": { icon: "🗺", name: "Cartographer", desc: "View 6 different NASA data layers." },
  "globetrotter": { icon: "🌍", name: "Globetrotter", desc: "Inspect sites in 10 different countries." },
  "field-ready":  { icon: "📦", name: "Field Ready", desc: "Export a field brief." },
  "peer-review":  { icon: "🔬", name: "Peer Reviewed", desc: "Open the Validation report." },
  "hunter":       { icon: "🏹", name: "Analog Hunter", desc: "Complete an Analog Hunt." },
  "sharpshooter": { icon: "🎖", name: "Sharpshooter", desc: "Score 3,500+ points in one Analog Hunt." },
};

const fresh = () => ({ xp: 0, scans: {}, presets: {}, layers: {}, countries: {}, inspected: 0, discoveries: [], badges: {}, hunt: { best: 0, played: 0 }, tour: false, seen: {} });

function load() {
  try {
    const p = JSON.parse(localStorage.getItem(KEY));
    return p && typeof p.xp === "number" ? { ...fresh(), ...p } : fresh();
  } catch { return fresh(); }
}
const profile = load();
function save() { try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* private mode */ } }

export function rankOf(xp) {
  let k = 0;
  while (k + 1 < RANKS.length && xp >= RANKS[k + 1][0]) k++;
  const [lo, name, icon] = RANKS[k];
  const hi = RANKS[k + 1]?.[0] ?? lo;
  return { level: k + 1, name, icon, lo, hi, frac: hi > lo ? (xp - lo) / (hi - lo) : 1 };
}

// ------------------------------------------------------------------ sound (WebAudio, synthesised)
let ctx = null;
let unlocked = false; // browsers only allow audio after a user gesture
for (const ev of ["pointerdown", "keydown"]) addEventListener(ev, () => { unlocked = true; }, { once: true, capture: true });
let soundOn = (() => { try { return localStorage.getItem(SND_KEY) !== "off"; } catch { return true; } })();
function ac() {
  if (!soundOn || !unlocked) return null;
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  } catch { return null; }
}
function tone(freq, dur = 0.08, type = "sine", vol = 0.05, at = 0, slideTo = null) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}
export const sfx = {
  click: () => tone(1400, 0.035, "square", 0.018),
  hover: () => tone(2200, 0.02, "sine", 0.008),
  scan: () => { tone(180, 1.1, "sawtooth", 0.018, 0, 900); tone(90, 1.1, "sine", 0.03, 0, 300); },
  lock: () => { tone(880, 0.06, "square", 0.025); tone(1320, 0.09, "square", 0.025, 0.07); },
  xp: () => { tone(988, 0.07, "triangle", 0.04); tone(1319, 0.1, "triangle", 0.04, 0.06); },
  badge: () => [523, 659, 784, 1047].forEach((f, k) => tone(f, 0.18, "triangle", 0.05, k * 0.09)),
  level: () => [392, 523, 659, 784, 1047, 1319].forEach((f, k) => tone(f, 0.22, "sawtooth", 0.03, k * 0.08)),
  miss: () => tone(220, 0.25, "sawtooth", 0.03, 0, 110),
};
export function isSoundOn() { return soundOn; }
export function setSound(v) { soundOn = v; try { localStorage.setItem(SND_KEY, v ? "on" : "off"); } catch { /* ignore */ } }

// ------------------------------------------------------------------ toasts
let stack = null;
function toastRoot() {
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toasts";
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  return stack;
}
export function toast(html, cls = "", ms = 3200) {
  const el = document.createElement("div");
  el.className = `toast ${cls}`;
  el.innerHTML = html;
  const root = toastRoot();
  root.appendChild(el);
  while (root.children.length > 3) root.firstElementChild.remove(); // keep the HUD readable
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(() => { el.classList.remove("in"); setTimeout(() => el.remove(), 400); }, ms);
}

// ------------------------------------------------------------------ XP & badges
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); fn(profile); }
const emit = () => listeners.forEach((fn) => fn(profile));

export function addXP(n, why) {
  if (!n) return;
  const before = rankOf(profile.xp);
  profile.xp += Math.round(n);
  const after = rankOf(profile.xp);
  save();
  toast(`<b>+${Math.round(n)} XP</b> <span>${why}</span>`, "xp", 2200);
  sfx.xp();
  if (after.level > before.level) {
    setTimeout(() => {
      toast(`<div class="big">${after.icon}</div><b>RANK UP · LEVEL ${after.level}</b><span>${after.name}</span>`, "level", 4200);
      sfx.level();
    }, 500);
  }
  emit();
}

export function award(id) {
  if (profile.badges[id] || !BADGES[id]) return false;
  profile.badges[id] = new Date().toISOString().slice(0, 10);
  save();
  const b = BADGES[id];
  setTimeout(() => {
    toast(`<div class="big">${b.icon}</div><b>ACHIEVEMENT UNLOCKED</b><span>${b.name} — ${b.desc}</span>`, "badge", 4200);
    sfx.badge();
  }, 250);
  addXP(75, `achievement: ${b.name}`);
  return true;
}

/** Record a game event. ctx carries the facts needed to evaluate achievements. */
export function track(ev, d = {}) {
  const P = profile;
  switch (ev) {
    case "scan": {
      award("first-light");
      if (!P.scans[d.id]) { P.scans[d.id] = d.body; addXP(40, `new target scanned · ${d.name}`); }
      const moon = Object.values(P.scans).filter((b) => b === "moon").length;
      const mars = Object.values(P.scans).filter((b) => b === "mars").length;
      if (moon >= 5) award("moonwalker");
      if (mars >= 5) award("red-ranger");
      if (Object.keys(P.scans).length >= (d.total || 23)) award("manifest");
      break;
    }
    case "preset":
      if (!P.presets[d.id]) { P.presets[d.id] = 1; addXP(15, `objective · ${d.label}`); }
      if (Object.keys(P.presets).length >= 6) award("strategist");
      break;
    case "layer":
      if (d.id === "score") break;
      if (!P.layers[d.id]) { P.layers[d.id] = 1; addXP(10, "new data layer"); }
      if (Object.keys(P.layers).length >= 6) award("cartographer");
      break;
    case "inspect":
      P.inspected++;
      if (d.country && !P.countries[d.country]) { P.countries[d.country] = 1; addXP(5, `new country · ${d.country}`); }
      if (Object.keys(P.countries).length >= 10) award("globetrotter");
      if (d.grade === "S") award("twin");
      if (d.southPole && Math.abs(d.lat) >= 66) award("polar");
      break;
    case "discovery": {
      const key = `${d.target}|${d.lat.toFixed(1)}|${d.lon.toFixed(1)}`;
      if (P.discoveries.some((x) => x.key === key)) return false;
      P.discoveries.unshift({ key, ...d, date: new Date().toISOString().slice(0, 10) });
      addXP({ S: 150, A: 120, B: 90 }[d.grade] ?? 60, `discovery logged · ${d.name}`);
      if (P.discoveries.filter((x) => x.isNew).length >= 3) award("trailblazer");
      break;
    }
    case "brief": if (!P.seen.brief) { P.seen.brief = 1; addXP(30, "field brief exported"); } award("field-ready"); break;
    case "validate": if (!P.seen.validate) { P.seen.validate = 1; addXP(25, "validation reviewed"); } award("peer-review"); break;
    case "discover": if (!P.seen.discover) { P.seen.discover = 1; addXP(25, "discoveries briefing"); } break;
    case "tour": if (!P.tour) { P.tour = true; addXP(60, "mission briefing complete"); } break;
    case "hunt":
      P.hunt.played++;
      if (d.total > P.hunt.best) P.hunt.best = d.total;
      addXP(Math.round(d.total / 10), `Analog Hunt · ${d.total} pts`);
      award("hunter");
      if (d.total >= 3500) award("sharpshooter");
      break;
  }
  save();
  emit();
  return true;
}

export function getProfile() { return profile; }
export function removeDiscovery(key) { profile.discoveries = profile.discoveries.filter((d) => d.key !== key); save(); emit(); }
export function resetProfile() {
  Object.assign(profile, fresh());
  save();
  emit();
}
