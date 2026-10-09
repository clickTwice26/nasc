// Tiny dependency-free SVG charts.
const NS = "http://www.w3.org/2000/svg";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Radar chart: axes [{label, value 0..1, share}] */
export function radar(axes, { size = 300, color = "#6fe0b0" } = {}) {
  const c = size / 2, r = size / 2 - 62, n = axes.length;
  const pt = (k, v) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
    return [c + r * v * Math.cos(a), c + r * v * Math.sin(a)];
  };
  let s = `<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:300px;display:block;margin:0 auto" role="img" aria-label="Factor match radar chart" xmlns="${NS}">`;
  for (const ring of [0.25, 0.5, 0.75, 1]) {
    s += `<polygon points="${axes.map((_, k) => pt(k, ring).join(",")).join(" ")}" fill="none" stroke="#24314f" stroke-width="1"/>`;
  }
  axes.forEach((ax, k) => {
    const [x, y] = pt(k, 1);
    s += `<line x1="${c}" y1="${c}" x2="${x}" y2="${y}" stroke="#24314f"/>`;
    const [lx, ly] = pt(k, 1.16);
    const anchor = Math.abs(lx - c) < 8 ? "middle" : lx > c ? "start" : "end";
    s += `<text x="${lx}" y="${ly + 4}" text-anchor="${anchor}" font-size="10.5">${esc(ax.label)}</text>`;
    s += `<text x="${lx}" y="${ly + 16}" text-anchor="${anchor}" font-size="10" fill="#6fe0b0" style="fill:${color}">${Math.round(ax.value * 100)}%</text>`;
  });
  s += `<polygon points="${axes.map((ax, k) => pt(k, Math.max(0.02, ax.value)).join(",")).join(" ")}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2"/>`;
  axes.forEach((ax, k) => { const [x, y] = pt(k, Math.max(0.02, ax.value)); s += `<circle cx="${x}" cy="${y}" r="${2 + 4 * (ax.share || 0.15)}" fill="${color}"/>`; });
  return s + "</svg>";
}

/** Horizontal bars: rows [{label, value, color, note}] with value in [lo, hi] */
export function hbars(rows, { lo = 0.4, hi = 1, ref = 0.5, refLabel = "chance", width = 520, rowH = 19, fmt = (v) => v.toFixed(2) } = {}) {
  const left = 190, right = 48, h = rows.length * rowH + 30;
  const x = (v) => left + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (width - left - right);
  let s = `<svg viewBox="0 0 ${width} ${h}" width="100%" role="img" aria-label="Bar chart" xmlns="${NS}">`;
  for (let t = lo; t <= hi + 1e-9; t += 0.1) s += `<line x1="${x(t)}" y1="12" x2="${x(t)}" y2="${h - 16}" stroke="#18233b"/><text x="${x(t)}" y="${h - 4}" text-anchor="middle" font-size="10">${t.toFixed(1)}</text>`;
  s += `<line x1="${x(ref)}" y1="8" x2="${x(ref)}" y2="${h - 16}" stroke="#ff6b6b" stroke-dasharray="3 3"/><text x="${x(ref) + 3}" y="9" font-size="10" style="fill:#ff8f8f">${refLabel}</text>`;
  rows.forEach((r, k) => {
    const y = 14 + k * rowH;
    s += `<text x="${left - 6}" y="${y + 11}" text-anchor="end" font-size="11">${esc(r.label)}</text>`;
    s += `<rect x="${x(lo)}" y="${y + 2}" width="${Math.max(1, x(r.value) - x(lo))}" height="${rowH - 6}" rx="3" fill="${r.color || "#5aa2ff"}"><title>${esc(r.label)}: ${fmt(r.value)}${r.note ? " — " + esc(r.note) : ""}</title></rect>`;
    s += `<text x="${x(r.value) + 4}" y="${y + 11}" font-size="10.5" style="fill:#e8ecf4">${fmt(r.value)}</text>`;
  });
  return s + "</svg>";
}

/** Dot plot of percentile ranks (0–100) for named sites. */
export function rankDots(sites, { width = 520 } = {}) {
  const rows = [...sites].sort((a, b) => b.pct - a.pct);
  const left = 215, right = 20, rowH = 17, h = rows.length * rowH + 34;
  const x = (p) => left + (p / 100) * (width - left - right);
  let s = `<svg viewBox="0 0 ${width} ${h}" width="100%" role="img" aria-label="Percentile rank of established analog sites" xmlns="${NS}">`;
  s += `<rect x="${x(90)}" y="6" width="${x(100) - x(90)}" height="${h - 28}" fill="#10392b" opacity="0.6"/><text x="${x(95)}" y="${h - 18}" text-anchor="middle" font-size="9.5" style="fill:#6fe0b0">top 10%</text>`;
  for (const t of [0, 25, 50, 75, 100]) s += `<line x1="${x(t)}" y1="6" x2="${x(t)}" y2="${h - 28}" stroke="#18233b"/><text x="${x(t)}" y="${h - 6}" text-anchor="middle" font-size="10">${t}</text>`;
  s += `<line x1="${x(50)}" y1="6" x2="${x(50)}" y2="${h - 28}" stroke="#ff6b6b" stroke-dasharray="3 3"/>`;
  rows.forEach((r, k) => {
    const y = 12 + k * rowH;
    s += `<text x="${left - 6}" y="${y + 4}" text-anchor="end" font-size="10.5">${esc(r.name.length > 36 ? r.name.slice(0, 35) + "…" : r.name)}</text>`;
    s += `<line x1="${x(0)}" y1="${y}" x2="${x(r.pct)}" y2="${y}" stroke="#24314f"/>`;
    s += `<circle cx="${x(r.pct)}" cy="${y}" r="5" fill="${r.pct >= 90 ? "#6fe0b0" : r.pct >= 50 ? "#5aa2ff" : "#ff6b6b"}"><title>${esc(r.name)}: ${r.pct.toFixed(0)}th percentile</title></circle>`;
  });
  return s + "</svg>";
}

/** Circular score dial. */
export function dial(v, { size = 120, label = "fidelity" } = {}) {
  const r = size / 2 - 9, c = size / 2, L = 2 * Math.PI * r;
  const col = v >= 0.6 ? "#6fe0b0" : v >= 0.4 ? "#ffb347" : "#ff6b6b";
  return `<div class="dial"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#172036" stroke-width="9"/><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${L * v} ${L}" transform="rotate(-90 ${c} ${c})"/></svg><b>${Math.round(v * 100)}</b><small>${label}</small></div>`;
}

export { esc };
