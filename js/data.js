'use strict';

/*
 * Datenhaltung.
 *
 * Quelle der Wahrheit ist data/shots.csv im Repository. Damit unterwegs nichts
 * verloren geht, hält der Browser zusätzlich eine eigene Kopie: jeder neue
 * Schuss landet sofort im localStorage und ist damit auch dann sicher, wenn
 * gerade kein Netz da ist oder kein Token hinterlegt wurde. Wer einen Token
 * hinterlegt, schreibt den Stand per GitHub-API zurück ins Repository.
 */

const FIELDS = [
  'nr',
  'seil',
  'zeit',
  'steps',
  'distanz_m',
  'ziel_m',
  'winkel',
  'notiz',
];

const LS_ROWS = 'ratte.rows';
const LS_BASE = 'ratte.baseCSV';
const LS_CFG = 'ratte.cfg';

const CSV_PATH = 'data/shots.csv';

/* ---------- CSV ---------- */

/* Zeichenweiser Parser, damit Notizen auch Kommas und Zeilenumbrüche in
 * Anführungszeichen enthalten dürfen. */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const src = text.replace(/\r\n?/g, '\n');

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) return [];

  const head = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const o = {};
      head.forEach((h, i) => (o[h] = (r[i] ?? '').trim()));
      return o;
    });
}

function escapeField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCSV(rows) {
  const lines = [FIELDS.join(',')];
  for (const r of rows) {
    lines.push(FIELDS.map((f) => escapeField(r[f])).join(','));
  }
  return lines.join('\n') + '\n';
}

/* Identität eines Schusses, unabhängig von der laufenden Nummer — die kann auf
 * zwei Geräten gleichzeitig vergeben worden sein. */
function rowKey(r) {
  return [r.seil, r.steps, r.distanz_m, r.zeit].join('|');
}

/* ---------- Zustand ---------- */

const state = {
  rows: [],
  baseCSV: '', // Stand, wie er zuletzt im Repository gesehen wurde
  loadedFrom: 'nichts',
};

function readCfg() {
  try {
    return JSON.parse(localStorage.getItem(LS_CFG) || '{}');
  } catch {
    return {};
  }
}

function writeCfg(cfg) {
  localStorage.setItem(LS_CFG, JSON.stringify(cfg));
}

function persistLocal() {
  try {
    localStorage.setItem(LS_ROWS, JSON.stringify(state.rows));
    localStorage.setItem(LS_BASE, state.baseCSV);
  } catch (e) {
    console.warn('localStorage nicht verfügbar:', e);
  }
}

function isDirty() {
  return toCSV(state.rows) !== state.baseCSV;
}

/* Lädt den Repository-Stand und führt ihn mit dem lokalen zusammen. */
async function load() {
  let repoCSV = null;
  try {
    const res = await fetch(CSV_PATH + '?t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) repoCSV = await res.text();
  } catch (e) {
    console.warn('Repository-CSV nicht erreichbar:', e);
  }

  let localRows = null;
  let localBase = null;
  try {
    const raw = localStorage.getItem(LS_ROWS);
    if (raw) localRows = JSON.parse(raw);
    localBase = localStorage.getItem(LS_BASE);
  } catch {
    /* localStorage gesperrt — dann eben nur der Repository-Stand */
  }

  const repoRows = repoCSV ? parseCSV(repoCSV) : null;

  if (repoRows && localRows) {
    if (localBase === repoCSV) {
      /* Repository unverändert, lokal liegen ggf. neue Schüsse. */
      state.rows = localRows;
      state.baseCSV = repoCSV;
      state.loadedFrom = 'Repository + lokale Änderungen';
    } else {
      /* Repository hat sich bewegt. Repository gewinnt, alles lokal
       * Zusätzliche wird hinten angehängt. */
      const known = new Set(repoRows.map(rowKey));
      const extra = localRows.filter((r) => !known.has(rowKey(r)));
      state.rows = repoRows.concat(extra);
      state.baseCSV = repoCSV;
      state.loadedFrom = extra.length
        ? `Repository (neu geladen) + ${extra.length} lokal`
        : 'Repository (neu geladen)';
    }
  } else if (repoRows) {
    state.rows = repoRows;
    state.baseCSV = repoCSV;
    state.loadedFrom = 'Repository';
  } else if (localRows) {
    state.rows = localRows;
    state.baseCSV = localBase || '';
    state.loadedFrom = 'nur lokal (Repository nicht erreichbar)';
  } else {
    state.rows = [];
    state.baseCSV = '';
    state.loadedFrom = 'leer';
  }

  normalise();
  persistLocal();
  return state.rows;
}

/* Zahlenfelder vereinheitlichen und fehlende Nummern nachziehen. */
function normalise() {
  let maxNr = 0;
  for (const r of state.rows) {
    const n = parseInt(r.nr, 10);
    if (Number.isFinite(n)) maxNr = Math.max(maxNr, n);
  }
  for (const r of state.rows) {
    if (!r.nr) r.nr = String(++maxNr);
    for (const f of FIELDS) if (r[f] == null) r[f] = '';
  }
}

function nextNr() {
  let max = 0;
  for (const r of state.rows) {
    const n = parseInt(r.nr, 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return max + 1;
}

/* ---------- Zugriff ---------- */

function allRows() {
  return state.rows;
}

/* Seil-Namen, neueste zuerst — das aktuell gespannte Seil ist das
 * interessanteste. */
function seilNames() {
  const seen = [];
  for (const r of state.rows) {
    if (r.seil && !seen.includes(r.seil)) seen.push(r.seil);
  }
  return seen.reverse();
}

function pointsFor(seil) {
  return state.rows
    .filter((r) => (seil ? r.seil === seil : true))
    .map((r) => ({
      steps: parseFloat(r.steps),
      distance: parseFloat(r.distanz_m),
      row: r,
    }))
    .filter((p) => Number.isFinite(p.steps) && Number.isFinite(p.distance));
}

function addShot({ seil, steps, distanz_m, ziel_m, winkel, notiz }) {
  const now = new Date();
  const row = {
    nr: String(nextNr()),
    seil: seil || '',
    zeit: now.toTimeString().slice(0, 8),
    steps: String(Math.round(steps)),
    distanz_m: String(distanz_m),
    ziel_m: ziel_m == null ? '' : String(ziel_m),
    winkel: winkel || '',
    notiz: notiz || '',
  };
  state.rows.push(row);
  persistLocal();
  return row;
}

function removeShot(row) {
  const i = state.rows.indexOf(row);
  if (i >= 0) {
    state.rows.splice(i, 1);
    persistLocal();
  }
}

/* ---------- GitHub ---------- */

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function ghRequest(cfg, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* GitHub liefert bei Fehlern gelegentlich reinen Text */
  }
  if (!res.ok) {
    const msg = (json && json.message) || text || res.statusText;
    throw new Error(`GitHub ${res.status}: ${msg}`);
  }
  return json;
}

/* Schreibt den aktuellen Stand zurück. Der Dateiname im Repository ist
 * derselbe, aus dem die Seite lädt — nach dem Sync sind Browser und
 * Repository wieder deckungsgleich. */
async function syncToGitHub() {
  const cfg = readCfg();
  if (!cfg.token) throw new Error('Kein Token hinterlegt.');
  if (!cfg.repo) throw new Error('Kein Repository hinterlegt.');

  const branch = cfg.branch || 'main';
  const base = `https://api.github.com/repos/${cfg.repo}/contents/${CSV_PATH}`;

  /* Aktuellen Stand samt SHA holen. Ohne SHA lehnt GitHub das Überschreiben
   * ab — das ist die Absicherung gegen versehentliches Zurückwerfen fremder
   * Änderungen. */
  let sha = null;
  let remoteCSV = null;
  try {
    const cur = await ghRequest(
      cfg,
      'GET',
      `${base}?ref=${encodeURIComponent(branch)}`
    );
    sha = cur.sha;
    if (cur.content) remoteCSV = b64decode(cur.content);
  } catch (e) {
    if (!/GitHub 404/.test(e.message)) throw e;
    /* Datei existiert dort noch nicht — dann legen wir sie an. */
  }

  /* Hat jemand anders in der Zwischenzeit geschrieben, wird zusammengeführt
   * statt überschrieben. */
  if (remoteCSV && remoteCSV !== state.baseCSV) {
    const remoteRows = parseCSV(remoteCSV);
    const known = new Set(remoteRows.map(rowKey));
    const mine = state.rows.filter((r) => !known.has(rowKey(r)));
    state.rows = remoteRows.concat(mine);
    normalise();
  }

  const csv = toCSV(state.rows);
  if (csv === remoteCSV) {
    state.baseCSV = csv;
    persistLocal();
    return { changed: false, count: state.rows.length };
  }

  const added = state.baseCSV
    ? state.rows.length - parseCSV(state.baseCSV).length
    : state.rows.length;

  await ghRequest(cfg, 'PUT', base, {
    message:
      added > 0
        ? `Messwerte: ${added} neue${added === 1 ? 'r Schuss' : ' Schüsse'} (${state.rows.length} gesamt)`
        : `Messwerte aktualisiert (${state.rows.length} gesamt)`,
    content: b64encode(csv),
    branch,
    ...(sha ? { sha } : {}),
  });

  state.baseCSV = csv;
  persistLocal();
  return { changed: true, count: state.rows.length, added };
}

function downloadCSV() {
  const blob = new Blob([toCSV(state.rows)], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shots.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.RatteData = {
  load,
  allRows,
  seilNames,
  pointsFor,
  addShot,
  removeShot,
  syncToGitHub,
  downloadCSV,
  isDirty,
  readCfg,
  writeCfg,
  parseCSV,
  toCSV,
  get loadedFrom() {
    return state.loadedFrom;
  },
};
