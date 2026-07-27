'use strict';

/*
 * Streudiagramm Steps gegen Wurfweite, dazu die gefittete Kurve je Seil.
 *
 * Bewusst ohne Fremdbibliothek: die Seite soll auf GitHub Pages ohne Bauschritt
 * und ohne Netzabhängigkeit laufen. Gezeichnet wird direkt als SVG.
 */

const NS = 'http://www.w3.org/2000/svg';

const W = 760;
const H = 380;
const PAD = { top: 16, right: 74, bottom: 44, left: 52 };

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(node);
  return node;
}

/* Achsenteilung auf runde Zahlen bringen. */
function niceTicks(min, max, count) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    ticks.push(Math.round(t / step) * step);
  }
  return ticks;
}

function fmt(v, digits) {
  return v.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/*
 * series: [{ name, color, points:[{steps,distance,row}], model }]
 */
function render(container, series) {
  container.textContent = '';
  container.style.position = 'relative';

  const visible = series.filter((s) => s.points.length);
  if (!visible.length) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Noch keine Messwerte für diese Auswahl.';
    container.appendChild(p);
    return;
  }

  const all = visible.flatMap((s) => s.points);
  const xs = all.map((p) => p.steps);
  const ys = all.map((p) => p.distance);

  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(0, Math.min(...ys));
  let y1 = Math.max(...ys);

  const xPad = (x1 - x0) * 0.04 || 1;
  const yPad = (y1 - y0) * 0.08 || 1;
  x0 -= xPad;
  x1 += xPad;
  y1 += yPad;

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const sx = (v) => PAD.left + ((v - x0) / (x1 - x0)) * plotW;
  const sy = (v) => PAD.top + plotH - ((v - y0) / (y1 - y0)) * plotH;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label':
      'Streudiagramm: Vorspannung in Steps gegen gemessene Wurfweite in Metern',
  });
  container.appendChild(svg);

  /* --- Gitter und Achsen (zurückhaltend) --- */
  const gGrid = el('g', {}, svg);

  for (const t of niceTicks(y0, y1, 6)) {
    const y = sy(t);
    el(
      'line',
      {
        x1: PAD.left,
        x2: W - PAD.right,
        y1: y,
        y2: y,
        stroke: 'var(--grid)',
        'stroke-width': 1,
      },
      gGrid
    );
    el(
      'text',
      {
        x: PAD.left - 8,
        y: y + 4,
        'text-anchor': 'end',
        fill: 'var(--text-muted)',
        'font-size': 11,
      },
      gGrid
    ).textContent = fmt(t, 0);
  }

  for (const t of niceTicks(x0, x1, 6)) {
    const x = sx(t);
    el(
      'line',
      {
        x1: x,
        x2: x,
        y1: PAD.top,
        y2: H - PAD.bottom,
        stroke: 'var(--grid)',
        'stroke-width': 1,
      },
      gGrid
    );
    el(
      'text',
      {
        x,
        y: H - PAD.bottom + 18,
        'text-anchor': 'middle',
        fill: 'var(--text-muted)',
        'font-size': 11,
      },
      gGrid
    ).textContent = fmt(t, 0);
  }

  el(
    'line',
    {
      x1: PAD.left,
      x2: W - PAD.right,
      y1: H - PAD.bottom,
      y2: H - PAD.bottom,
      stroke: 'var(--axis)',
      'stroke-width': 1,
    },
    svg
  );

  el(
    'text',
    {
      x: PAD.left + plotW / 2,
      y: H - 6,
      'text-anchor': 'middle',
      fill: 'var(--text-secondary)',
      'font-size': 12,
    },
    svg
  ).textContent = 'Vorspannung (Steps)';

  el(
    'text',
    {
      x: -(PAD.top + plotH / 2),
      y: 14,
      transform: 'rotate(-90)',
      'text-anchor': 'middle',
      fill: 'var(--text-secondary)',
      'font-size': 12,
    },
    svg
  ).textContent = 'Wurfweite (m)';

  /* --- Kurven mit Streuband --- */
  /* Beschriftungen werden gesammelt und ganz zum Schluss gezeichnet, damit
   * kein Messpunkt sie überdeckt. */
  const labels = [];

  for (const s of visible) {
    if (!s.model || !s.model.ready) continue;

    const band = s.model.uncertainty || 0;
    const pts = [];
    const N = 160;
    const from = Math.min(...s.points.map((p) => p.steps));
    const to = Math.max(...s.points.map((p) => p.steps));

    for (let i = 0; i <= N; i++) {
      const st = from + ((to - from) * i) / N;
      const d = s.model.fitted.predict(st);
      if (Number.isFinite(d)) pts.push([st, d]);
    }
    if (pts.length < 2) continue;

    if (band > 0) {
      const up = pts.map(([st, d]) => `${sx(st)},${sy(d + band)}`);
      const down = pts
        .slice()
        .reverse()
        .map(([st, d]) => `${sx(st)},${sy(d - band)}`);
      el(
        'polygon',
        {
          points: up.concat(down).join(' '),
          fill: s.color,
          'fill-opacity': 0.1,
          stroke: 'none',
        },
        svg
      );
    }

    el(
      'polyline',
      {
        points: pts.map(([st, d]) => `${sx(st)},${sy(d)}`).join(' '),
        fill: 'none',
        stroke: s.color,
        'stroke-width': 2,
        /* Benachbarte Rampenstufen liegen dicht beieinander. Das aktuelle Seil
         * bekommt deshalb zusätzlich die volle Deckkraft, ältere treten
         * zurück — die Farbe allein muss den Unterschied nicht tragen. */
        'stroke-opacity': s.current === false ? 0.5 : 1,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
      svg
    );

    const last = pts[pts.length - 1];
    labels.push({ x: sx(last[0]) + 8, y: sy(last[1]) + 4, name: s.name });
  }

  /* --- Messpunkte --- */
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.appendChild(tip);

  const gDots = el('g', {}, svg);

  for (const s of visible) {
    for (const p of s.points) {
      const c = el(
        'circle',
        {
          cx: sx(p.steps),
          cy: sy(p.distance),
          r: 4.5,
          fill: s.color,
          'fill-opacity': s.current === false ? 0.45 : 0.9,
          /* Ring in Flächenfarbe: bei dieser Punktdichte überlappt sonst
           * alles zu einem Fleck. */
          stroke: 'var(--surface-1)',
          'stroke-width': 1.5,
        },
        gDots
      );

      c.addEventListener('pointerenter', () => {
        c.setAttribute('r', 6.5);
        const nr = p.row && p.row.nr ? `#${p.row.nr} · ` : '';
        tip.textContent = `${nr}${fmt(p.steps, 0)} Steps → ${fmt(
          p.distance,
          1
        )} m`;
        tip.hidden = false;

        const box = container.getBoundingClientRect();
        const scale = box.width / W;
        let left = sx(p.steps) * scale + 12;
        const top = sy(p.distance) * scale - 34;
        tip.style.left = '0px';
        tip.style.top = top + 'px';
        if (left + tip.offsetWidth > box.width) {
          left = sx(p.steps) * scale - tip.offsetWidth - 12;
        }
        tip.style.left = Math.max(0, left) + 'px';
      });

      c.addEventListener('pointerleave', () => {
        c.setAttribute('r', 4.5);
        tip.hidden = true;
      });
    }
  }

  /* Direktbeschriftung zuletzt — die Farbe allein soll die Serie nie tragen
   * müssen, also muss der Name auch lesbar bleiben. Kurven mit kürzerem
   * Step-Bereich enden mitten im Punktfeld, daher zusätzlich ein Halo in
   * Flächenfarbe (paint-order zeichnet die Kontur zuerst). */
  for (const l of labels) {
    el(
      'text',
      {
        x: l.x,
        y: l.y,
        fill: 'var(--text-secondary)',
        'font-size': 11,
        stroke: 'var(--surface-1)',
        'stroke-width': 3.5,
        'stroke-linejoin': 'round',
        'paint-order': 'stroke',
      },
      svg
    ).textContent = l.name;
  }
}

window.RatteChart = { render };
