// Small, dependency-free SVG/HTML charts.
// Marks follow the dataviz spec: bars <= 24px with a 4px rounded data-end and square baseline,
// a 2px surface gap between touching bars, hairline grid, text in text colours (never series colours),
// a legend for 2+ series, a hover tooltip on every mark, and a table view.

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const SERIES = { blue: '#2a78d6', orange: '#eb6834' }; // validated pair (light surface)

const AUD0 = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
export const moneyRound = n => AUD0.format(Math.round(Number(n) || 0));
export function moneyCompact(n) {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}K`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `${s}$${Math.round(a)}`;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
// Rect with 4px rounded top corners, square at the baseline
function colPath(x, y, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

let tipEl = null;
function tip() {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'viz-tip'; tipEl.setAttribute('role', 'status'); document.body.appendChild(tipEl); }
  return tipEl;
}
function showTip(html, evt) {
  const t = tip(); t.innerHTML = html; t.style.display = 'block';
  const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY - h - pad;
  if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
  if (y < 8) y = evt.clientY + pad;
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
const hideTip = () => { if (tipEl) tipEl.style.display = 'none'; };

/**
 * Grouped column chart.
 * opts: { labels: [..], series: [{ name, color, values: [..] }], fmt, height, title }
 */
export function columnChart(el, opts) {
  const draw = () => {
    const { labels, series, fmt = moneyRound, height = 230 } = opts;
    const W = Math.max(300, el.clientWidth || 600), H = height;
    const m = { l: 52, r: 8, t: 10, b: 28 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const max = niceMax(Math.max(1, ...series.flatMap(s => s.values.map(v => Math.max(0, v || 0)))));
    const n = labels.length, gw = pw / n;
    const bw = Math.max(4, Math.min(24, (gw * 0.72 - 2 * (series.length - 1)) / series.length));
    const groupW = bw * series.length + 2 * (series.length - 1);
    const y = v => m.t + ph - (Math.max(0, v) / max) * ph;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);
    const every = Math.ceil(n / Math.floor(pw / 46));
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(opts.title || 'Chart')}">`;
    for (const t of ticks) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}" class="viz-grid"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end" class="viz-tick">${moneyCompact(t)}</text>`;
    labels.forEach((lab, i) => {
      const gx = m.l + gw * i + (gw - groupW) / 2;
      series.forEach((s, j) => {
        const v = s.values[i] || 0, bx = gx + j * (bw + 2);
        svg += `<path d="${colPath(bx, y(v), bw, m.t + ph - y(v))}" fill="${s.color}"/>`;
      });
      if (i % every === 0) svg += `<text x="${m.l + gw * i + gw / 2}" y="${H - 8}" text-anchor="middle" class="viz-tick">${esc(lab)}</text>`;
      svg += `<rect class="viz-hit" data-i="${i}" x="${m.l + gw * i}" y="${m.t}" width="${gw}" height="${ph}" fill="transparent"/>`;
    });
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ph}" y2="${m.t + ph}" class="viz-axis"/></svg>`;
    el.querySelector('.viz-plot').innerHTML = svg;
    el.querySelectorAll('.viz-hit').forEach(r => {
      const i = +r.dataset.i;
      const html = `<b>${esc(opts.tipLabels ? opts.tipLabels[i] : labels[i])}</b>` + series.map(s => `<div><span class="viz-key" style="background:${s.color}"></span>${esc(s.name)} <b>${fmt(s.values[i] || 0)}</b></div>`).join('')
        + (opts.tipExtra ? opts.tipExtra(i) : '');
      r.addEventListener('mousemove', e => { r.setAttribute('fill', 'rgba(0,0,0,.04)'); showTip(html, e); });
      r.addEventListener('mouseleave', () => { r.setAttribute('fill', 'transparent'); hideTip(); });
      r.addEventListener('click', e => showTip(html, e));
    });
  };
  el.innerHTML = `${opts.series.length > 1 ? `<div class="viz-legend">${opts.series.map(s => `<span><span class="viz-key" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('')}</div>` : ''}
    <div class="viz-plot"></div>
    <details class="viz-table"><summary>Show as table</summary><div class="tablewrap"><table><thead><tr><th></th>${opts.series.map(s => `<th class="num">${esc(s.name)}</th>`).join('')}</tr></thead>
      <tbody>${opts.labels.map((l, i) => `<tr><td>${esc(opts.tipLabels ? opts.tipLabels[i] : l)}</td>${opts.series.map(s => `<td class="num">${(opts.fmt || moneyRound)(s.values[i] || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  draw();
  if (window.ResizeObserver) { let w = el.clientWidth; new ResizeObserver(() => { if (Math.abs(el.clientWidth - w) > 20) { w = el.clientWidth; draw(); } }).observe(el); }
}

/**
 * Horizontal bar list (one series). items: [{ label, value, note? }]
 * Value sits at the bar tip in text colour; bar grows from the left baseline.
 */
export function hbarChart(el, { items, color = SERIES.blue, fmt = moneyRound, max, empty = 'Nothing to show yet.' }) {
  if (!items.length) { el.innerHTML = `<p class="empty">${esc(empty)}</p>`; return; }
  const top = max ?? Math.max(...items.map(i => i.value), 1);
  el.innerHTML = `<div class="hbar">${items.map(i => `
    <div class="hbar-row" title="${esc(i.label)}: ${esc(fmt(i.value))}${i.note ? ' — ' + esc(i.note) : ''}">
      <div class="hbar-label">${esc(i.label)}${i.badge ? ` <span class="pill ${i.badgeClass || ''}">${esc(i.badge)}</span>` : ''}</div>
      <div class="hbar-track"><div class="hbar-bar" style="flex:0 0 calc((100% - 7.5rem) * ${Math.max(0.004, i.value / top).toFixed(4)});background:${i.color || color}"></div>
        <span class="hbar-val">${esc(fmt(i.value))}</span></div>
      ${i.note ? `<div class="hbar-note">${esc(i.note)}</div>` : ''}
    </div>`).join('')}</div>`;
}
