'use strict';

/* Verdrahtung: Daten laden, Modell rechnen, Oberfläche aktualisieren. */

const $ = (sel) => document.querySelector(sel);

const RAMP_STEPS = 5;

const ui = {
  seil: null,
  extraSeile: [], // neu gebunden, noch ohne Schuss
  models: new Map(), // Seil -> Modell
  colorOf: new Map(), // Seil -> Farbe
};

/* ---------- Hilfen ---------- */

function fmtNum(v, digits = 0) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function setPill(node, text, cls) {
  node.textContent = text;
  node.className = 'pill' + (cls ? ' ' + cls : '');
  node.hidden = false;
}

function log(text) {
  const box = $('#serialLog');
  box.textContent += text + '\n';
  const lines = box.textContent.split('\n');
  if (lines.length > 400) box.textContent = lines.slice(-400).join('\n');
  box.scrollTop = box.scrollHeight;
}

/* Farbe hängt am Seil, nicht an seiner Position in der aktuellen Auswahl —
 * ein Filter darf die verbleibenden Seile nicht umfärben.
 *
 * Die Seile werden in ihrer zeitlichen Reihenfolge über die Rampe verteilt,
 * das älteste am hellen Ende, das aktuelle am dunklen. Kommen Seile dazu,
 * rutscht die Verteilung mit — die Zuordnung bleibt „je neuer, desto
 * kräftiger", statt an feste Farben gebunden zu sein. */
function assignColors() {
  const chronological = allSeilNames().slice().reverse();
  const n = chronological.length;
  ui.colorOf.clear();

  chronological.forEach((name, i) => {
    const slot =
      n <= 1
        ? RAMP_STEPS
        : Math.round((i * (RAMP_STEPS - 1)) / (n - 1)) + 1;
    ui.colorOf.set(name, `var(--ramp-${Math.min(RAMP_STEPS, Math.max(1, slot))})`);
  });
}

/* Seile aus den Daten, plus ein gerade frisch gebundenes, zu dem noch kein
 * Schuss vorliegt. Neueste zuerst. */
function allSeilNames() {
  return ui.extraSeile.concat(RatteData.seilNames());
}

/* Fortlaufende Nummer weiterzählen, egal wie die Seile heißen. */
function nextSeilName() {
  let max = 0;
  for (const name of allSeilNames()) {
    const m = /(\d+)\s*$/.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Seil ${max + 1}`;
}

/* ---------- Modell ---------- */

function rebuild() {
  ui.models.clear();
  const names = allSeilNames(); // neueste zuerst

  names.forEach((name, i) => {
    /* Vorwissen kommt vom zuletzt davor gespannten Seil — einer einzelnen,
     * zusammenhängenden Kennlinie. Alle Vorseile zusammengeworfen ergäben eine
     * verschmierte Durchschnittsform, die deutlich schlechter trägt: im Test
     * lag der Fehler eines frischen Seils damit bei 2,0 m statt bei 0,8 m. */
    let prior = null;
    for (let j = i + 1; j < names.length && !prior; j++) {
      prior = RatteModel.buildReference(RatteData.pointsFor(names[j]));
    }

    ui.models.set(
      name,
      RatteModel.buildModel(RatteData.pointsFor(name), prior)
    );
  });

  renderAll();
}

function currentModel() {
  return ui.models.get(ui.seil) || null;
}

/* ---------- Darstellung ---------- */

function renderSeilSelect() {
  const sel = $('#seilSelect');
  const names = allSeilNames();
  sel.textContent = '';
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n;
    sel.appendChild(o);
  }
  if (!ui.seil || !names.includes(ui.seil)) ui.seil = names[0] || null;
  sel.value = ui.seil || '';
}

function renderEstimate() {
  const model = currentModel();
  const target = parseFloat($('#targetInput').value);
  const box = $('#resultBox');
  const note = $('#estimateNote');

  box.classList.remove('out-of-range');

  if (!model || !model.ready) {
    $('#resultSteps').textContent = '—';
    $('#resultLabel').textContent = 'Steps';
    note.textContent = model ? model.reason : 'Kein Seil ausgewählt.';
    setArmEnabled(false);
    return;
  }

  if (!Number.isFinite(target)) {
    $('#resultSteps').textContent = '—';
    $('#resultLabel').textContent = 'Steps';
    note.textContent = 'Zieldistanz eingeben.';
    setArmEnabled(false);
    return;
  }

  const res = RatteModel.stepsForDistance(model, target);

  if (!res || res.steps == null) {
    $('#resultSteps').textContent = '—';
    $('#resultLabel').textContent = 'Steps';
    box.classList.add('out-of-range');
    note.textContent = res ? res.note : 'Keine Lösung gefunden.';
    setArmEnabled(false);
    return;
  }

  $('#resultSteps').textContent = fmtNum(res.steps);
  $('#resultLabel').textContent = `Steps  ·  ± ${fmtNum(
    model.uncertainty,
    1
  )} m Streuung`;

  if (!res.inRange) box.classList.add('out-of-range');

  const n = model.points.length;
  note.textContent =
    (res.note ? res.note + ' ' : '') +
    `Modell „${model.best.label}" aus ${n} Schüssen von ${ui.seil}.` +
    (model.usesPrior
      ? n < 8
        ? ' Stützt sich noch auf die Kurvenform des vorherigen Seils — mit jedem Schuss löst es sich davon.'
        : ' Die Kurvenform des vorherigen Seils sagt hier zuverlässiger vorher als eine frei gefittete.'
      : '');

  setArmEnabled(true);
  ui.pendingSteps = res.steps;
}

function setArmEnabled(ok) {
  const connected = RatteSerial.isConnected();
  $('#armBtn').disabled = !(ok && connected);
  $('#goNowBtn').disabled = !(ok && connected);
  $('#armHint').textContent = connected
    ? ok
      ? ''
      : 'keine gültige Schätzung'
    : 'Arduino nicht verbunden';
}

function renderChart() {
  const showAll = $('#showAllSeile').checked;
  const names = showAll ? allSeilNames() : ui.seil ? [ui.seil] : [];

  const series = names.map((n) => ({
    name: n,
    color: ui.colorOf.get(n) || `var(--ramp-${RAMP_STEPS})`,
    points: RatteData.pointsFor(n),
    model: ui.models.get(n),
    /* Im Vergleich tritt alles zurück, was nicht das gewählte Seil ist. */
    current: !showAll || n === ui.seil,
  }));

  RatteChart.render($('#chart'), series);

  const legend = $('#legend');
  legend.textContent = '';
  if (series.length >= 2) {
    for (const s of series) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = s.color;
      const label = document.createElement('span');
      label.textContent = `${s.name} (${s.points.length})`;
      item.append(sw, label);
      legend.appendChild(item);
    }
  }
}

function renderModelTable() {
  const model = currentModel();
  const body = $('#modelTable tbody');
  body.textContent = '';

  if (!model || !model.ready) {
    $('#modelHint').textContent = model ? model.reason : '';
    return;
  }

  $('#modelHint').textContent =
    `${model.points.length} Schüsse · Vorhersagefehler ± ` +
    `${fmtNum(model.uncertainty, 2)} m`;

  for (const c of model.candidates) {
    const tr = document.createElement('tr');
    if (c === model.best) tr.className = 'is-best';

    const name = document.createElement('td');
    name.textContent = c.label + (c === model.best ? '  ✓' : '');
    if (c.fromPrior) {
      const tag = document.createElement('span');
      tag.className = 'row-tag';
      tag.textContent = 'Vorseil';
      tag.title = 'Übernimmt die Kurvenform des vorherigen Seils';
      name.appendChild(tag);
    }

    const rmse = document.createElement('td');
    rmse.className = 'num';
    rmse.textContent = c.cv ? fmtNum(c.cv.rmse, 3) : '—';

    const mae = document.createElement('td');
    mae.className = 'num';
    mae.textContent = c.cv ? fmtNum(c.cv.mae, 3) : '—';

    const desc = document.createElement('td');
    desc.textContent = c.description;
    desc.style.whiteSpace = 'normal';

    tr.append(name, rmse, mae, desc);
    body.appendChild(tr);
  }
}

function renderShotsTable() {
  const body = $('#shotsTable tbody');
  body.textContent = '';

  const rows = RatteData.allRows().slice().reverse();
  for (const r of rows) {
    const tr = document.createElement('tr');

    const cells = [
      [r.nr, 'num'],
      [r.seil, ''],
      [fmtNum(parseFloat(r.steps)), 'num'],
      [fmtNum(parseFloat(r.distanz_m), 1) + ' m', 'num'],
      [r.zeit || '—', ''],
      [r.notiz || '', ''],
    ];

    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }

    const act = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '×';
    del.title = 'Schuss löschen';
    del.addEventListener('click', () => {
      if (!confirm(`Schuss #${r.nr} löschen?`)) return;
      RatteData.removeShot(r);
      assignColors();
      rebuild();
    });
    act.appendChild(del);
    tr.appendChild(act);

    body.appendChild(tr);
  }
}

function renderSyncState() {
  const dirty = RatteData.isDirty();
  const cfg = RatteData.readCfg();
  const pending = $('#pendingStatus');

  if (dirty) {
    setPill(pending, 'lokale Änderungen nicht gesichert', 'warn');
  } else {
    pending.hidden = true;
  }

  $('#syncNote').textContent = cfg.token
    ? `Ziel: ${cfg.repo || '—'} (Branch ${cfg.branch || 'main'})`
    : 'Kein Token hinterlegt — „Zugang …" öffnen, um direkt ins Repository zu schreiben. ' +
      'Ohne Token bleiben neue Schüsse in diesem Browser und lassen sich als CSV exportieren.';

  $('#dataHint').textContent = `${RatteData.allRows().length} Schüsse · Quelle: ${RatteData.loadedFrom}`;
}

function renderAll() {
  renderSeilSelect();
  renderEstimate();
  renderChart();
  renderModelTable();
  renderShotsTable();
  renderSyncState();
}

/* ---------- Schüsse eintragen ---------- */

function recordShot({ steps, distance, notiz, ziel }) {
  RatteData.addShot({
    seil: ui.seil,
    steps,
    distanz_m: distance,
    ziel_m: ziel,
    winkel: '',
    notiz: notiz || '',
  });
  assignColors();
  rebuild();
}

/* ---------- Serielle Ereignisse ---------- */

function wireSerial() {
  if (!RatteSerial.isSupported()) {
    $('#serialIntro').textContent =
      'Dieser Browser kann kein Web Serial. Für die Direktverbindung Chrome oder Edge ' +
      'auf einem Rechner verwenden — Schüsse lassen sich aber jederzeit von Hand eintragen.';
    $('#connectBtn').disabled = true;
  }

  RatteSerial.on('state', ({ connected }) => {
    setPill($('#serialState'), connected ? 'verbunden' : 'getrennt', connected ? 'ok' : '');
    $('#connectBtn').disabled = connected;
    $('#disconnectBtn').disabled = !connected;
    $('#zeroBtn').disabled = !connected;
    $('#stopBtn').disabled = !connected;
    $('#rawSend').disabled = !connected;
    if (!connected) {
      $('#livePos').textContent = '—';
      $('#liveTarget').textContent = '—';
      $('#liveArmed').textContent = '—';
    }
    renderEstimate();
  });

  RatteSerial.on('line', ({ text }) => log(text));
  RatteSerial.on('sent', ({ text }) => log('> ' + text));
  RatteSerial.on('error', ({ message }) => log('!! ' + message));

  RatteSerial.on('position', ({ pos, target }) => {
    $('#livePos').textContent = fmtNum(pos);
    $('#liveTarget').textContent = fmtNum(target);
  });

  RatteSerial.on('armed', ({ pos }) => {
    $('#liveArmed').textContent = fmtNum(pos);
  });

  RatteSerial.on('go', () => {
    $('#liveArmed').textContent = '—';
  });

  RatteSerial.on('estop', ({ pos }) => {
    $('#liveArmed').textContent = '—';
    log(`!! NOT-STOPP bei ${pos}`);
  });

  /* Der Sketch hat einen Schuss verbucht — direkt übernehmen. */
  RatteSerial.on('shot', ({ steps, distance }) => {
    recordShot({
      steps,
      distance,
      notiz: 'automatisch vom Arduino',
    });
    log(`>> übernommen: ${steps} Steps -> ${distance} m`);
  });
}

/* ---------- Ereignisse der Oberfläche ---------- */

function wireUI() {
  $('#seilSelect').addEventListener('change', (e) => {
    ui.seil = e.target.value;
    renderAll();
  });

  /* Neu gebundenes Seil: die alten Messpunkte gelten dann nicht mehr, weil die
   * Spannung eine andere ist. Statt sie zu verwerfen, bekommt das neue Seil
   * einen eigenen Eintrag — die Kurvenform des vorherigen dient als Startpunkt,
   * bis genug eigene Schüsse da sind. */
  $('#newSeilBtn').addEventListener('click', () => {
    const name = nextSeilName();
    if (
      !confirm(
        `„${name}" beginnen?\n\n` +
          'Die bisherigen Seile bleiben erhalten. Die Schätzung startet mit der ' +
          'Kurvenform des vorherigen Seils und braucht nur zwei bis drei Schüsse, ' +
          'um sich darauf einzustellen.'
      )
    )
      return;

    ui.extraSeile.unshift(name);
    ui.seil = name;
    assignColors();
    rebuild();
  });

  $('#targetInput').addEventListener('input', renderEstimate);
  $('#showAllSeile').addEventListener('change', renderChart);

  $('#shotForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const steps = parseFloat($('#shotSteps').value);
    const distance = parseFloat($('#shotDistance').value);
    if (!Number.isFinite(steps) || !Number.isFinite(distance)) return;
    recordShot({ steps, distance, notiz: $('#shotNote').value });
    $('#shotSteps').value = '';
    $('#shotDistance').value = '';
    $('#shotNote').value = '';
  });

  $('#connectBtn').addEventListener('click', async () => {
    try {
      await RatteSerial.connect();
    } catch (e) {
      /* Abbruch im Geräte-Dialog ist kein Fehler, den man melden muss. */
      if (!/No port selected|cancelled/i.test(e.message)) alert(e.message);
    }
  });

  $('#disconnectBtn').addEventListener('click', () => RatteSerial.disconnect());
  $('#zeroBtn').addEventListener('click', () => RatteSerial.setZero());
  $('#stopBtn').addEventListener('click', () => RatteSerial.emergencyStop());

  $('#armBtn').addEventListener('click', async () => {
    const steps = ui.pendingSteps;
    if (steps == null) return;
    try {
      const ok = await RatteSerial.armPosition(steps);
      if (ok) {
        log(`>> ${steps} vorgemerkt — Fahrt erst nach GO (g oder Taster D4)`);
      } else {
        log('!! Sketch kennt kein a<n> — bitte die erweiterte Fassung aufspielen');
        alert(
          'Der Sketch auf dem Arduino kennt den Befehl a<n> zum Vormerken noch nicht.\n\n' +
            'Entweder die erweiterte Fassung aus sketch/ aufspielen, oder ' +
            '„Sofort fahren" verwenden — dabei läuft der Motor allerdings ohne GO los.'
        );
      }
    } catch (e) {
      alert(e.message);
    }
  });

  $('#goNowBtn').addEventListener('click', async () => {
    const steps = ui.pendingSteps;
    if (steps == null) return;
    if (
      !confirm(
        `Der Motor fährt sofort auf Position ${fmtNum(steps)} — ohne GO-Bestätigung.\n\n` +
          'Ist alles frei und niemand im Weg?'
      )
    )
      return;
    try {
      await RatteSerial.moveTo(steps);
    } catch (e) {
      alert(e.message);
    }
  });

  $('#rawForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#rawInput').value.trim();
    if (!v) return;
    try {
      await RatteSerial.sendCommand(v);
      $('#rawInput').value = '';
    } catch (err) {
      alert(err.message);
    }
  });

  $('#exportBtn').addEventListener('click', () => RatteData.downloadCSV());

  $('#syncBtn').addEventListener('click', async () => {
    const btn = $('#syncBtn');
    btn.disabled = true;
    btn.textContent = 'synchronisiere …';
    try {
      const r = await RatteData.syncToGitHub();
      renderAll();
      alert(
        r.changed
          ? `Gespeichert. ${r.count} Schüsse im Repository.`
          : 'Nichts zu tun — Repository ist schon aktuell.'
      );
    } catch (e) {
      alert('Synchronisieren fehlgeschlagen.\n\n' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Mit GitHub synchronisieren';
      renderSyncState();
    }
  });

  /* Zugangsdaten */
  const dlg = $('#tokenDialog');

  $('#tokenBtn').addEventListener('click', () => {
    const cfg = RatteData.readCfg();
    $('#repoInput').value = cfg.repo || guessRepo();
    $('#branchInput').value = cfg.branch || 'main';
    $('#tokenInput').value = cfg.token || '';
    dlg.showModal();
  });

  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'save') {
      RatteData.writeCfg({
        repo: $('#repoInput').value.trim(),
        branch: $('#branchInput').value.trim() || 'main',
        token: $('#tokenInput').value.trim(),
      });
    } else if (dlg.returnValue === 'clear') {
      RatteData.writeCfg({
        repo: $('#repoInput').value.trim(),
        branch: $('#branchInput').value.trim() || 'main',
        token: '',
      });
    }
    $('#tokenInput').value = '';
    renderSyncState();
  });

  /* Vor dem Schließen warnen, solange etwas ungesichert ist. */
  window.addEventListener('beforeunload', (e) => {
    if (RatteData.isDirty()) e.preventDefault();
  });
}

/* Auf GitHub Pages lässt sich das Repository aus der Adresse ableiten. */
function guessRepo() {
  const host = location.hostname;
  const m = host.match(/^([^.]+)\.github\.io$/);
  if (!m) return '';
  const seg = location.pathname.split('/').filter(Boolean);
  return seg.length ? `${m[1]}/${seg[0]}` : '';
}

/* ---------- Start ---------- */

async function main() {
  wireUI();
  wireSerial();

  try {
    await RatteData.load();
    setPill(
      $('#dataStatus'),
      `${RatteData.allRows().length} Schüsse geladen`,
      'ok'
    );
  } catch (e) {
    setPill($('#dataStatus'), 'Laden fehlgeschlagen', 'warn');
    console.error(e);
  }

  assignColors();
  rebuild();
}

main();
