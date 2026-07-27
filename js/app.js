'use strict';

/* Verdrahtung: Daten laden, Modell rechnen, Oberfläche aktualisieren. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const RAMP_STEPS = 5;

/* Winkel der Prüfung: 5 bis 45 Grad in Fünferschritten, nach links oder rechts. */
const WINKEL_STUFEN = [5, 10, 15, 20, 25, 30, 35, 40, 45];

const ui = {
  mode: 'test',
  seil: null,
  extraSeile: [], // neu gebunden, noch ohne Schuss
  models: new Map(), // Seil -> Modell, kommt aus RatteModel.buildAll
  colorOf: new Map(), // Seil -> Farbe
  richtung: 'geradeaus',
  hasArm: null, // ob der Sketch a<n> kennt (aus der Verbindungsprüfung)
  winkel: 0,
  testSteps: null,
  pruefSteps: null,
  posRange: null,
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

/* Ein Befehl geht nur bei bestehender Verbindung hinaus. Ohne Verbindung zeigt
 * die Konsole, was sie geschickt hätte — so lässt sich das Pult gefahrlos
 * durchprobieren, bevor der Motor daran hängt. */
async function send(cmd) {
  if (!RatteSerial.isConnected()) {
    log(`(nicht verbunden) würde senden: ${cmd}`);
    return false;
  }
  try {
    await RatteSerial.sendCommand(cmd);
    return true;
  } catch (e) {
    log('!! ' + e.message);
    return false;
  }
}

/* Farbe hängt am Seil, nicht an seiner Position in der aktuellen Auswahl —
 * ein Filter darf die verbleibenden Seile nicht umfärben.
 *
 * Die Seile werden in ihrer zeitlichen Reihenfolge über die Rampe verteilt,
 * das älteste am hellen Ende, das aktuelle am dunklen. */
function assignColors() {
  const chronological = allSeilNames().slice().reverse();
  const n = chronological.length;
  ui.colorOf.clear();

  chronological.forEach((name, i) => {
    const slot =
      n <= 1 ? RAMP_STEPS : Math.round((i * (RAMP_STEPS - 1)) / (n - 1)) + 1;
    ui.colorOf.set(
      name,
      `var(--ramp-${Math.min(RAMP_STEPS, Math.max(1, slot))})`
    );
  });
}

/* Seile aus den Daten, plus ein gerade frisch gebundenes, zu dem noch kein
 * Schuss vorliegt. Neueste zuerst. */
function allSeilNames() {
  return ui.extraSeile.concat(RatteData.seilNames());
}

function nextSeilName() {
  let max = 0;
  for (const name of allSeilNames()) {
    const m = /(\d+)\s*$/.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Seil ${max + 1}`;
}

function winkelText() {
  return ui.richtung === 'geradeaus'
    ? 'geradeaus'
    : `${ui.winkel}° ${ui.richtung}`;
}

/* ---------- Modell ---------- */

function rebuild() {
  /* Alle Seile werden gemeinsam gerechnet: eine geteilte Kurvenform über
   * sämtliche Schüsse, dazu für jedes Seil sein eigener Versatz. So steht bei
   * jeder Weite die volle Messreihe zur Verfügung, ohne die Unterschiede
   * zwischen den Seilen einzuebnen. */
  const chronologisch = allSeilNames().slice().reverse();
  const ropes = chronologisch.map((name) => ({
    name,
    points: RatteData.pointsFor(name),
  }));

  ui.models = RatteModel.buildAll(ropes);
  renderAll();
}

function currentModel() {
  return ui.models.get(ui.seil) || null;
}

/* ---------- Darstellung ---------- */

function renderSeilSelects() {
  const names = allSeilNames();
  if (!ui.seil || !names.includes(ui.seil)) ui.seil = names[0] || null;

  for (const sel of [$('#seilSelect'), $('#pruefSeil')]) {
    sel.textContent = '';
    for (const n of names) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    }
    sel.value = ui.seil || '';
  }
}

/* Gemeinsame Rechnung für beide Modi. */
function estimate(target) {
  const model = currentModel();
  if (!model) return { ok: false, note: 'Kein Seil ausgewählt.' };
  if (!model.ready) return { ok: false, note: model.reason };
  if (!Number.isFinite(target))
    return { ok: false, note: 'Zieldistanz eingeben.' };

  const res = RatteModel.stepsForDistance(model, target);

  if (!res || res.steps == null)
    return {
      ok: false,
      note: res ? res.note : 'Keine Lösung gefunden.',
      warn: true,
    };

  return {
    ok: true,
    model,
    steps: res.steps,
    inRange: res.inRange,
    note: res.note,
    delta: res.delta,
    localShots: res.localShots,
    spread: res.spread,
  };
}

/* ---------- Trefferchance ----------
 *
 * Prüfungswertung: volle Punkte im Kreis von 1 m Durchmesser um die Zielweite,
 * Teilpunkte bei 2 m Durchmesser — also ±0,50 m und ±1,00 m.
 *
 * Aus der örtlichen Streuung lässt sich abschätzen, wie oft das gelingt. Die
 * Streuung wird dabei als glockenförmig angenommen; das trifft die Messreihe
 * gut genug, taugt aber nur als Größenordnung, nicht als Versprechen.
 */

const WERTUNG_VOLL_M = 0.5;
const WERTUNG_TEIL_M = 1.0;

/* Fehlerfunktion, Näherung nach Abramowitz-Stegun 7.1.26. */
function erf(x) {
  const vorzeichen = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return vorzeichen * y;
}

/* Anteil einer Normalverteilung innerhalb von ±radius. */
function trefferChance(sigma, radius) {
  if (!(sigma > 0)) return null;
  return erf(radius / (sigma * Math.SQRT2));
}

function chanceText(r) {
  const sigma = Number.isFinite(r.spread) && r.spread > 0 ? r.spread : r.model.uncertainty;
  const voll = trefferChance(sigma, WERTUNG_VOLL_M);
  const teil = trefferChance(sigma, WERTUNG_TEIL_M);
  if (voll == null) return '';
  return (
    `Zu erwarten: volle Punkte (± ${fmtNum(WERTUNG_VOLL_M, 1)} m) etwa ` +
    `${Math.round(voll * 100)} %, Teilpunkte (± ${fmtNum(WERTUNG_TEIL_M, 1)} m) ` +
    `etwa ${Math.round(teil * 100)} %.`
  );
}

/* Die Streuung ist stark weitenabhaengig — unter 8 m liegen zwei Schuesse mit
 * gleicher Vorspannung typisch 0,4 m auseinander, ueber 20 m sind es 2,7 m.
 * Deshalb der oertliche Wert, wo er sich bestimmen laesst. */
function streuungText(r) {
  const s = Number.isFinite(r.spread) && r.spread > 0 ? r.spread : r.model.uncertainty;
  return `Steps  ·  hier ± ${fmtNum(s, 1)} m zu erwarten`;
}

function modelSuffix(r) {
  const m = r.model;
  const eigene = m.points.length;
  const gesamt = m.shape ? m.shape.points.length : eigene;

  let text =
    `Kurvenform „${m.best.label}" aus allen ${gesamt} Schüssen, ` +
    `Höhenlage von ${ui.seil} aus dessen ${eigene} eigenen ` +
    `(Versatz ${m.offset >= 0 ? '+' : ''}${fmtNum(m.offset, 2)} m).`;

  if (r.localShots >= 2) {
    text +=
      ` Feinabgleich aus ${r.localShots} Schüssen in der Nähe dieser Weite: ` +
      `${r.delta >= 0 ? '+' : ''}${fmtNum(r.delta)} Steps.`;
  }

  if (m.usesShared) {
    text +=
      ' Das Seil hat noch zu wenige eigene Schüsse für eine eigene Höhenlage —' +
      ' es übernimmt die des vorherigen.';
  }

  return text;
}

function renderEstimate() {
  const r = estimate(parseFloat($('#targetInput').value));
  const box = $('#resultBox');
  box.classList.remove('out-of-range');

  if (!r.ok) {
    $('#resultSteps').textContent = '—';
    $('#resultLabel').textContent = 'Steps';
    $('#estimateNote').textContent = r.note;
    if (r.warn) box.classList.add('out-of-range');
    ui.testSteps = null;
    if (ui.mode === 'test') renderPlanned(null);
  } else {
    $('#resultSteps').textContent = fmtNum(r.steps);
    $('#resultLabel').textContent = streuungText(r);
    if (!r.inRange) box.classList.add('out-of-range');
    $('#estimateNote').textContent =
      (r.note ? r.note + ' ' : '') + modelSuffix(r);
    ui.testSteps = r.steps;
    if (ui.mode === 'test') renderPlanned(r.steps);
  }

  updateActionButtons();
}

function renderPruef() {
  const r = estimate(parseFloat($('#pruefDistanz').value));
  const box = $('#pruefBox');
  box.classList.remove('out-of-range');

  $('#aimSummary').textContent =
    ui.richtung === 'geradeaus'
      ? 'Gerät geradeaus ausrichten'
      : `Gerät ${ui.winkel}° nach ${ui.richtung} drehen`;

  if (!r.ok) {
    $('#pruefSteps').textContent = '—';
    $('#pruefLabel').textContent = 'Steps';
    $('#pruefNote').textContent = r.note;
    $('#pruefChance').textContent = '';
    if (r.warn) box.classList.add('out-of-range');
    ui.pruefSteps = null;
    if (ui.mode === 'pruef') renderPlanned(null);
  } else {
    $('#pruefSteps').textContent = fmtNum(r.steps);
    $('#pruefLabel').textContent = streuungText(r);
    if (!r.inRange) box.classList.add('out-of-range');
    $('#pruefChance').textContent = chanceText(r);
    $('#pruefNote').textContent =
      (r.note ? r.note + ' ' : '') +
      modelSuffix(r) +
      ' Der Winkel dreht nur das Gerät — auf die Vorspannung wirkt er nicht, ' +
      'er wird aber mitgeschrieben.';
    ui.pruefSteps = r.steps;
    if (ui.mode === 'pruef') renderPlanned(r.steps);
  }

  updateActionButtons();
}

/* Zeigt, wohin die Konsole fahren würde — schon beim Einstellen der Weite,
 * bevor irgendetwas vorgemerkt oder gefahren ist. */
function renderPlanned(steps) {
  const ziel = aktuellesZiel();

  $('#zielHint').textContent = Number.isFinite(ziel)
    ? `nimmt die Zieldistanz von oben: ${fmtNum(ziel, 1)} m`
    : 'keine Zieldistanz eingetragen';

  const plan = $('#posPlan');
  if (steps == null) {
    $('#livePlanned').textContent = '—';
    plan.hidden = true;
    return;
  }

  $('#livePlanned').textContent = fmtNum(steps);

  const [lo, hi] = ui.posRange || posRange();
  const anteil = ((steps - lo) / (hi - lo || 1)) * 100;
  if (anteil < -5 || anteil > 105) {
    plan.hidden = true;
  } else {
    plan.hidden = false;
    plan.style.left = `calc(${Math.max(0, Math.min(100, anteil))}% - 1px)`;
  }
}

function updateActionButtons() {
  const connected = RatteSerial.isConnected();

  $('#armBtn').disabled = !(connected && ui.testSteps != null);
  $('#goNowBtn').disabled = !(connected && ui.testSteps != null);
  $('#pruefArm').disabled = !(connected && ui.pruefSteps != null);

  /* GO und STOP bleiben immer bedienbar — sie gehören zum Steuerpult und
   * zeigen ohne Verbindung an, was sie geschickt hätten. */

  $('#armHint').textContent = connected
    ? ui.testSteps != null
      ? ''
      : 'keine gültige Schätzung'
    : 'Arduino nicht verbunden';
}

/* Balken für die Live-Position. Der Bereich ist das, was mit diesem Seil
 * bisher gefahren wurde — davor und danach ist unbekanntes Gebiet. */
function posRange() {
  /* Der Balken zeigt den Bereich, in dem tatsächlich gefahren wurde — nicht
   * den Suchbereich des Modells. Der reicht zum Extrapolieren über die Daten
   * hinaus, und der Balken staucht dadurch alles Wesentliche in die Mitte. */
  const alle = RatteData.pointsFor(null).map((p) => p.steps);
  if (alle.length) return [Math.min(...alle), Math.max(...alle)];

  const model = currentModel();
  if (model && model.ready && model.searchRange) return model.searchRange;
  return [0, 25000];
}

function renderPosScale() {
  ui.posRange = posRange();
  $('#posMin').textContent = fmtNum(ui.posRange[0]);
  $('#posMax').textContent = fmtNum(ui.posRange[1]);
}

function updatePosBar(pos, target) {
  const [lo, hi] = ui.posRange || posRange();
  const span = hi - lo || 1;
  const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));

  if (Number.isFinite(pos)) $('#posFill').style.width = pct(pos) + '%';

  const mark = $('#posMark');
  if (Number.isFinite(target) && target !== pos) {
    mark.hidden = false;
    mark.style.left = `calc(${pct(target)}% - 1px)`;
  } else {
    mark.hidden = true;
  }
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

  for (const r of RatteData.allRows().slice().reverse()) {
    const tr = document.createElement('tr');

    for (const [text, cls] of [
      [r.nr, 'num'],
      [r.seil, ''],
      [fmtNum(parseFloat(r.steps)), 'num'],
      [fmtNum(parseFloat(r.distanz_m), 1) + ' m', 'num'],
      [r.winkel || '—', ''],
      [r.zeit || '—', ''],
      [r.notiz || '', ''],
    ]) {
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
      scheduleAutoSync();
    });
    act.appendChild(del);
    tr.appendChild(act);

    body.appendChild(tr);
  }
}

function renderSyncState() {
  const cfg = RatteData.readCfg();

  if (RatteData.isDirty()) {
    setPill($('#pendingStatus'), 'lokale Änderungen nicht gesichert', 'warn');
  } else {
    $('#pendingStatus').hidden = true;
  }

  $('#syncNote').textContent = cfg.token
    ? `Sichert automatisch nach jedem Schuss in ${cfg.repo || '—'} ` +
      `(Branch ${cfg.branch || 'main'}). Der Knopf erzwingt es sofort.`
    : 'Kein Token hinterlegt — „Zugang …" öffnen, dann sichert die Konsole jeden ' +
      'Schuss von selbst ins Repository. Ohne Token bleiben neue Schüsse in diesem ' +
      'Browser und lassen sich als CSV exportieren.';

  $('#dataHint').textContent =
    `${RatteData.allRows().length} Schüsse · Quelle: ${RatteData.loadedFrom}`;
}

function renderAll() {
  renderSeilSelects();
  renderPosScale();
  renderEstimate();
  renderPruef();
  renderChart();
  renderModelTable();
  renderShotsTable();
  renderSyncState();
}

/* ---------- Betriebsart ---------- */

function setMode(mode) {
  ui.mode = mode;
  const test = mode === 'test';

  $('#viewTest').hidden = !test;
  $('#viewPruef').hidden = test;
  $('#modeTest').classList.toggle('is-on', test);
  $('#modePruef').classList.toggle('is-on', !test);
  $('#modeTest').setAttribute('aria-selected', String(test));
  $('#modePruef').setAttribute('aria-selected', String(!test));

  renderPlanned(test ? ui.testSteps : ui.pruefSteps);

  $('#modeLede').textContent = test
    ? 'Schüsse sammeln und das Modell schärfen. Alles wird gespeichert.'
    : 'Nur Entfernung und Winkel vorgeben — die Vorspannung rechnet die Konsole.';
}

/* ---------- Schüsse eintragen ---------- */

function recordShot({ steps, distance, notiz, ziel, winkel }) {
  RatteData.addShot({
    seil: ui.seil,
    steps,
    distanz_m: distance,
    ziel_m: ziel,
    winkel: winkel || '',
    notiz: notiz || '',
  });
  assignColors();
  rebuild();
  scheduleAutoSync();
}

/* ---------- Automatisches Sichern ---------- */

let syncTimer = null;

/* Liegt ein Token vor, wandert jeder Schuss von selbst ins Repository — mit
 * Verzögerung, damit eine schnelle Folge nicht jeden einzeln committet und
 * jedes Mal eine Neuveröffentlichung der Seite auslöst.
 *
 * Scheitert es, etwa weil auf der Wiese kein Netz ist, bleibt alles lokal
 * erhalten und der nächste Schuss nimmt es mit. Verloren geht dabei nichts. */
function scheduleAutoSync() {
  if (!RatteData.readCfg().token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runAutoSync, 15000);
}

async function runAutoSync() {
  if (!RatteData.isDirty() || !RatteData.readCfg().token) return;

  setPill($('#pendingStatus'), 'sichere …', 'pill-quiet');
  try {
    const r = await RatteData.syncToGitHub();
    renderAll();
    if (!RatteData.isDirty()) {
      setPill($('#pendingStatus'), `gesichert · ${r.count} Schüsse`, 'ok');
      setTimeout(() => {
        if (!RatteData.isDirty()) $('#pendingStatus').hidden = true;
      }, 4000);
    }
  } catch (e) {
    setPill($('#pendingStatus'), 'noch nicht gesichert', 'warn');
    console.warn('Automatisches Sichern fehlgeschlagen:', e.message);
  }
}

/* ---------- Verbindung prüfen ----------
 *
 * Ein offener Port beweist nur, dass ein USB-Gerät da ist. Ob am anderen Ende
 * der Katapult-Sketch läuft — und ob es die Fassung mit a<n> ist —, zeigt erst
 * seine Antwort. */
async function runIdentify() {
  const pill = $('#sketchState');
  const hint = $('#serialHint');

  setPill(pill, 'prüfe Sketch …', 'pill-quiet');
  hint.textContent = '';
  $('#checkBtn').disabled = true;

  try {
    const r = await RatteSerial.identify();
    ui.hasArm = r.hasArm;

    if (!r.found) {
      setPill(pill, 'keine Antwort vom Sketch', 'warn');
      hint.textContent =
        r.lines === 0
          ? 'Der Port ist offen, es kommt aber gar nichts. Ist der serielle Monitor der Arduino-IDE noch offen? Ein Port lässt sich nur von einem Programm gleichzeitig nutzen.'
          : 'Es kommen Zeilen, aber keine Kennung des Katapult-Sketches. Läuft dort ein anderes Programm?';
    } else if (!r.hasArm) {
      setPill(pill, 'Sketch erkannt · ohne a<n>', 'warn');
      hint.textContent =
        'Vormerken geht damit nicht — dafür die Fassung aus sketch/ aufspielen. Alles andere funktioniert.';
    } else {
      setPill(pill, 'Sketch erkannt · a<n> vorhanden', 'ok');
      hint.textContent = '';
    }
  } catch (e) {
    setPill(pill, 'Prüfung fehlgeschlagen', 'warn');
    log('!! ' + e.message);
  } finally {
    $('#checkBtn').disabled = false;
  }
}

/* ---------- Nachführen ----------
 *
 * Der Sketch rechnet nach jedem gemeldeten Schuss selbst eine Korrektur:
 * Fehler mal Schritte-pro-Meter, aus einer linearen Regression über seine
 * höchstens 40 Punkte im RAM. Die Konsole kann das besser — sie hat die
 * vollständige Messreihe, rechnet pro Seil, nichtlinear und kreuzvalidiert.
 *
 * Deshalb überschreibt sie die Vormerkung des Sketches mit ihrem eigenen Wert.
 * Weil das zwei "VORBEREITET"-Zeilen hintereinander erzeugt, schreibt sie
 * zusätzlich in den Monitor, welche davon gilt.
 */

const ZIELFENSTER_M = 0.3; // dasselbe Fenster, das auch der Sketch verwendet

function aktuellesZiel() {
  return parseFloat(
    ui.mode === 'pruef' ? $('#pruefDistanz').value : $('#targetInput').value
  );
}

async function nachfuehren(gemessen) {
  if (!$('#autoFollow').checked || !RatteSerial.isConnected()) return;

  const ziel = aktuellesZiel();
  if (!Number.isFinite(ziel)) {
    log('!! Nachführen übersprungen — keine Sollweite eingetragen.');
    return;
  }

  /* Der Schuss steckt hier schon im Modell: recordShot hat neu gerechnet. */
  const r = estimate(ziel);
  if (!r.ok) {
    log('!! Nachführen nicht möglich — ' + r.note);
    return;
  }

  const abw = gemessen - ziel;
  const vorzeichen = abw >= 0 ? '+' : '';
  log(
    `>> Soll ${fmtNum(ziel, 1)} m, geflogen ${fmtNum(gemessen, 1)} m ` +
      `(${vorzeichen}${fmtNum(abw, 1)} m)` +
      (Math.abs(abw) <= ZIELFENSTER_M ? ' — im Zielfenster' : '')
  );
  const gesamt = r.model.shape ? r.model.shape.points.length : r.model.points.length;
  log(
    `>> Konsole rechnet neu über alle ${gesamt} Schüsse ` +
      `(${r.model.best.label}` +
      (r.localShots >= 2
        ? `, Feinabgleich ${r.delta >= 0 ? '+' : ''}${fmtNum(r.delta)} Steps aus ${r.localShots} Schüssen nahe ${fmtNum(aktuellesZiel(), 1)} m`
        : '') +
      `): ${fmtNum(r.steps)} Steps`
  );

  if ($('#autoDrive').checked) {
    try {
      await RatteSerial.moveTo(r.steps);
    } catch (e) {
      log('!! ' + e.message);
    }
    return;
  }

  const ok = await RatteSerial.armPosition(r.steps);
  log(
    ok
      ? `>> ${fmtNum(r.steps)} vorgemerkt — es gilt dieser Wert, nicht die Korrektur des Sketches. Jetzt GO.`
      : '!! Sketch kennt kein a<n> — es bleibt bei seiner eigenen Korrektur. Für das Nachführen die Fassung aus sketch/ aufspielen.'
  );
}

/* ---------- Vormerken und Fahren ---------- */

async function armSteps(steps) {
  if (steps == null) return;
  try {
    const ok = await RatteSerial.armPosition(steps);
    if (ok) {
      log(`>> ${steps} vorgemerkt — Fahrt erst nach GO (g oder Taster D4)`);
    } else {
      log('!! Sketch kennt kein a<n> — bitte die erweiterte Fassung aufspielen');
      if (
        confirm(
          'Der Sketch kennt den Befehl a<n> zum Vormerken noch nicht.\n\n' +
            'Stattdessen sofort auf die Position fahren? Der Motor läuft dann ' +
            'ohne GO-Bestätigung los.'
        )
      ) {
        await RatteSerial.moveTo(steps);
      }
    }
  } catch (e) {
    alert(e.message);
  }
}

async function moveNow(steps) {
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
}

/* ---------- Serielle Ereignisse ---------- */

function wireSerial() {
  if (!RatteSerial.isSupported()) {
    $('#serialHint').textContent =
      'Dieser Browser kann kein Web Serial — dafür Chrome oder Edge auf einem Rechner verwenden.';
    $('#connectBtn').disabled = true;
  }

  RatteSerial.on('state', ({ connected }) => {
    setPill(
      $('#serialState'),
      connected ? 'Port offen' : 'getrennt',
      connected ? 'ok' : 'pill-quiet'
    );
    $('#connectBtn').hidden = connected;
    $('#checkBtn').hidden = !connected;
    $('#disconnectBtn').hidden = !connected;

    if (!connected) {
      $('#sketchState').hidden = true;
      $('#serialHint').textContent = '';
      ui.hasArm = null;
      $('#livePos').textContent = '—';
      $('#liveTarget').textContent = '—';
      $('#liveArmed').textContent = '—';
    }
    updateActionButtons();
  });

  RatteSerial.on('line', ({ text }) => log(text));
  RatteSerial.on('sent', ({ text }) => log('> ' + text));
  RatteSerial.on('error', ({ message }) => log('!! ' + message));

  RatteSerial.on('position', ({ pos, target }) => {
    $('#livePos').textContent = fmtNum(pos);
    $('#liveTarget').textContent = fmtNum(target);
    updatePosBar(pos, target);
  });

  RatteSerial.on('armed', ({ pos }) => {
    $('#liveArmed').textContent = fmtNum(pos);
    updatePosBar(NaN, pos);
  });

  RatteSerial.on('go', () => {
    $('#liveArmed').textContent = '—';
  });

  RatteSerial.on('estop', ({ pos }) => {
    $('#liveArmed').textContent = '—';
    log(`!! NOT-STOPP bei ${pos}`);
  });

  /* Der Sketch hat einen Schuss verbucht — direkt übernehmen, samt der
   * gerade eingestellten Ausrichtung. */
  RatteSerial.on('shot', async ({ steps, distance }) => {
    recordShot({
      steps,
      distance,
      ziel: aktuellesZiel(),
      winkel: winkelText(),
      notiz: 'automatisch vom Arduino',
    });
    log(`>> übernommen: ${steps} Steps -> ${distance} m (${winkelText()})`);
    await nachfuehren(distance);
  });
}

/* ---------- Ereignisse der Oberfläche ---------- */

function wireUI() {
  $('#modeTest').addEventListener('click', () => setMode('test'));
  $('#modePruef').addEventListener('click', () => setMode('pruef'));

  /* --- Verbindung --- */
  $('#connectBtn').addEventListener('click', async () => {
    try {
      await RatteSerial.connect();
    } catch (e) {
      /* Abbruch im Geräte-Dialog ist kein Fehler, den man melden muss. */
      if (!/No port selected|cancelled/i.test(e.message)) alert(e.message);
      return;
    }
    /* Ein offener Port heißt noch nicht, dass der richtige Sketch antwortet —
     * also gleich nachfragen. */
    runIdentify();
  });
  $('#disconnectBtn').addEventListener('click', () => RatteSerial.disconnect());
  $('#clearLogBtn').addEventListener('click', () => {
    $('#serialLog').textContent = '';
  });

  $('#checkBtn').addEventListener('click', runIdentify);

  /* Ohne GO losfahren hebt die Sicherung des Sketches auf — das soll niemand
   * versehentlich anklicken. */
  $('#autoDrive').addEventListener('change', (e) => {
    if (!e.target.checked) return;
    const ok = confirm(
      'Der Motor läuft danach nach jedem gemeldeten Schuss von selbst an, ' +
        'ohne GO und ohne Rückfrage.\n\n' +
        'Der Sketch ist bewusst andersherum gebaut: „DER MOTOR FAEHRT NIE VON ' +
        'SELBST", damit ihr in Ruhe laden und den Auslöser spannen könnt.\n\n' +
        'Trotzdem einschalten?'
    );
    if (!ok) e.target.checked = false;
  });

  /* --- Steuerpult: alles, was ein fester Befehl ist --- */
  for (const btn of $$('.js-cmd')) {
    btn.addEventListener('click', () => {
      const frage = btn.dataset.confirm;
      if (frage && !confirm(frage)) return;
      send(btn.dataset.cmd);
    });
  }

  for (const btn of $$('.js-go')) {
    btn.addEventListener('click', () => send('g'));
  }

  for (const btn of $$('.js-stop')) {
    btn.addEventListener('click', async () => {
      if (!RatteSerial.isConnected()) {
        log('(nicht verbunden) würde senden: s');
        return;
      }
      try {
        await RatteSerial.emergencyStop();
      } catch (e) {
        log('!! ' + e.message);
      }
    });
  }

  /* Meldet die Zielweite aus der Schätzung an den Sketch. Ein eigenes Feld
   * dafür gab es hier einmal — dieselbe Größe zweimal einzutippen war eine
   * Fehlerquelle, und beide konnten auseinanderlaufen. */
  $('#zielSetBtn').addEventListener('click', () => {
    const v = aktuellesZiel();
    if (!Number.isFinite(v)) {
      log('!! keine Zielweite eingetragen');
      return;
    }
    send('z' + v);
  });

  $('#trefferBtn').addEventListener('click', () => {
    const v = parseFloat($('#weiteInput').value);
    if (!Number.isFinite(v)) return;
    /* Der Sketch antwortet mit "gespeichert: Pos … -> … m"; über dieses Echo
     * landet der Schuss in der Messreihe. Doppelt eintragen wäre falsch. */
    send('w' + v);
    $('#weiteInput').value = '';
  });

  $('#tempoBtn').addEventListener('click', () => {
    const v = parseInt($('#tempoInput').value, 10);
    if (!Number.isFinite(v)) return;
    send('v' + v);
  });

  $('#spmBtn').addEventListener('click', () => {
    const v = parseFloat($('#spmInput').value);
    if (!Number.isFinite(v)) return;
    send('k' + v);
  });

  $('#rawForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#rawInput').value.trim();
    if (!v) return;
    send(v);
    $('#rawInput').value = '';
  });

  /* --- Seil --- */
  for (const sel of [$('#seilSelect'), $('#pruefSeil')]) {
    sel.addEventListener('change', (e) => {
      ui.seil = e.target.value;
      renderAll();
    });
  }

  /* Neu gebundenes Seil: die alten Messpunkte gelten dann nicht mehr, weil die
   * Spannung eine andere ist. Hier bekommt es einen eigenen Eintrag — die
   * Kurvenform des vorherigen dient als Startpunkt —, und im Arduino werden
   * die Punkte im RAM verworfen. */
  $('#newSeilBtn').addEventListener('click', async () => {
    const name = nextSeilName();
    if (
      !confirm(
        `„${name}" beginnen?\n\n` +
          'Die bisherigen Seile bleiben hier erhalten. Im Arduino werden die ' +
          'Messpunkte gelöscht (c), weil sie für das neue Seil nicht mehr gelten.\n\n' +
          'Die Schätzung startet mit der Kurvenform des vorherigen Seils und ' +
          'braucht nur zwei bis drei Schüsse, um sich darauf einzustellen.'
      )
    )
      return;

    await send('c');
    ui.extraSeile.unshift(name);
    ui.seil = name;
    assignColors();
    rebuild();
  });

  /* --- Testmodus --- */
  $('#targetInput').addEventListener('input', renderEstimate);
  $('#showAllSeile').addEventListener('change', renderChart);
  $('#armBtn').addEventListener('click', () => armSteps(ui.testSteps));
  $('#goNowBtn').addEventListener('click', () => moveNow(ui.testSteps));

  $('#shotForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const steps = parseFloat($('#shotSteps').value);
    const distance = parseFloat($('#shotDistance').value);
    if (!Number.isFinite(steps) || !Number.isFinite(distance)) return;
    recordShot({
      steps,
      distance,
      winkel: winkelText(),
      notiz: $('#shotNote').value,
    });
    $('#shotSteps').value = '';
    $('#shotDistance').value = '';
    $('#shotNote').value = '';
  });

  /* --- Prüfungsmodus --- */
  $('#pruefDistanz').addEventListener('input', renderPruef);
  $('#pruefArm').addEventListener('click', () => armSteps(ui.pruefSteps));

  buildWinkelButtons();

  for (const btn of $$('#richtungGroup .seg-btn')) {
    btn.addEventListener('click', () => {
      ui.richtung = btn.dataset.dir;
      if (ui.richtung === 'geradeaus') ui.winkel = 0;
      else if (!ui.winkel) ui.winkel = WINKEL_STUFEN[0];
      syncAimButtons();
      renderPruef();
    });
  }

  $('#pruefResultForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const gemessen = parseFloat($('#pruefGemessen').value);
    if (!Number.isFinite(gemessen)) return;

    if (ui.pruefSteps == null) {
      $('#pruefResultNote').textContent =
        'Erst eine Entfernung vorgeben — ohne Steps lässt sich der Schuss nicht einordnen.';
      return;
    }

    const ziel = parseFloat($('#pruefDistanz').value);
    /* Vor dem Eintragen festhalten: recordShot rechnet das Modell neu, danach
     * steht in ui.pruefSteps schon die nächste Schätzung. */
    const gefahren = ui.pruefSteps;

    recordShot({
      steps: gefahren,
      distance: gemessen,
      ziel,
      winkel: winkelText(),
      notiz: 'Prüfung',
    });

    const abw = gemessen - ziel;
    $('#pruefResultNote').textContent =
      `Festgehalten: ${fmtNum(gefahren)} Steps → ${fmtNum(gemessen, 1)} m ` +
      `(${abw >= 0 ? '+' : ''}${fmtNum(abw, 1)} m gegenüber dem Ziel). ` +
      'Das Modell hat den Schuss schon aufgenommen.';
    $('#pruefGemessen').value = '';
  });

  /* --- Daten --- */
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
      btn.textContent = 'Jetzt synchronisieren';
      renderSyncState();
    }
  });

  /* --- Zugangsdaten --- */
  const dlg = $('#tokenDialog');

  $('#tokenBtn').addEventListener('click', () => {
    const cfg = RatteData.readCfg();
    $('#repoInput').value = cfg.repo || guessRepo();
    $('#branchInput').value = cfg.branch || 'main';
    $('#tokenInput').value = cfg.token || '';
    dlg.showModal();
  });

  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'save' || dlg.returnValue === 'clear') {
      RatteData.writeCfg({
        repo: $('#repoInput').value.trim(),
        branch: $('#branchInput').value.trim() || 'main',
        token: dlg.returnValue === 'save' ? $('#tokenInput').value.trim() : '',
      });
    }
    $('#tokenInput').value = '';
    renderSyncState();
  });

  window.addEventListener('beforeunload', (e) => {
    if (RatteData.isDirty()) e.preventDefault();
  });
}

function buildWinkelButtons() {
  const group = $('#winkelGroup');
  group.textContent = '';
  for (const w of WINKEL_STUFEN) {
    const b = document.createElement('button');
    b.className = 'seg-btn';
    b.dataset.winkel = String(w);
    b.textContent = `${w}°`;
    b.addEventListener('click', () => {
      ui.winkel = w;
      if (ui.richtung === 'geradeaus') ui.richtung = 'rechts';
      syncAimButtons();
      renderPruef();
    });
    group.appendChild(b);
  }
  syncAimButtons();
}

function syncAimButtons() {
  for (const b of $$('#richtungGroup .seg-btn')) {
    b.classList.toggle('is-on', b.dataset.dir === ui.richtung);
  }
  const geradeaus = ui.richtung === 'geradeaus';
  for (const b of $$('#winkelGroup .seg-btn')) {
    b.disabled = geradeaus;
    b.classList.toggle(
      'is-on',
      !geradeaus && Number(b.dataset.winkel) === ui.winkel
    );
  }
}

/* Auf GitHub Pages lässt sich das Repository aus der Adresse ableiten. */
function guessRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  if (!m) return '';
  const seg = location.pathname.split('/').filter(Boolean);
  return seg.length ? `${m[1]}/${seg[0]}` : '';
}

/* ---------- Start ---------- */

async function main() {
  wireUI();
  wireSerial();
  setMode('test');

  log('Noch nicht verbunden. „Verbinden" öffnet die USB-Verbindung zum Arduino (115200 Baud).');
  log('Ohne Verbindung zeigen die Knöpfe nur, welcher Befehl gesendet würde.');

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
