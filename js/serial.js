'use strict';

/*
 * Direktverbindung zum Katapult-Sketch über die Web-Serial-API (USB).
 *
 * Der Sketch gibt seinen Zustand ohnehin schon vollständig über die serielle
 * Schnittstelle aus. Diese Seite liest genau diese Zeilen mit — insbesondere
 * die Bestätigung eines eingetragenen Schusses, die damit ohne Abtippen in der
 * Messreihe landet.
 *
 * ACHTUNG BEIM SENDEN: der Sketch wertet jedes 's' im Datenstrom sofort als
 * NOT-STOPP und verwirft den Eingabepuffer (siehe serviceSerial). Ein Befehl
 * darf deshalb niemals ein 's' enthalten. Alle Befehle des Sketches erfüllen
 * das; sendCommand prüft es zusätzlich ab, damit es beim Erweitern nicht
 * versehentlich kaputtgeht.
 */

const BAUD = 115200;

const listeners = {};
let port = null;
let reader = null;
let writer = null;
let readLoop = null;
let buffer = '';
let closing = false;

function on(event, fn) {
  (listeners[event] = listeners[event] || []).push(fn);
}

function off(event, fn) {
  const l = listeners[event];
  if (!l) return;
  const i = l.indexOf(fn);
  if (i >= 0) l.splice(i, 1);
}

function emit(event, payload) {
  for (const fn of listeners[event] || []) {
    try {
      fn(payload);
    } catch (e) {
      console.error(`Fehler im ${event}-Handler:`, e);
    }
  }
}

function isSupported() {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

function isConnected() {
  return !!port && !!writer;
}

/* ---------- Zeilen deuten ---------- */

const PATTERNS = [
  /* Laufende Positionsmeldung während der Fahrt */
  {
    event: 'position',
    re: /^Pos:(-?\d+)\s+Ziel:(-?\d+)/,
    parse: (m) => ({ pos: +m[1], target: +m[2], moving: true }),
  },
  {
    event: 'position',
    re: /Position erreicht:\s*(-?\d+)/,
    parse: (m) => ({ pos: +m[1], target: +m[1], moving: false }),
  },
  /* Der wichtigste Fall: der Sketch hat einen Schuss verbucht. */
  {
    event: 'shot',
    re: /gespeichert:\s*Pos\s+(-?\d+)\s*->\s*(-?[\d.]+)\s*m/i,
    parse: (m) => ({ steps: +m[1], distance: parseFloat(m[2]) }),
  },
  {
    event: 'armed',
    re: /VORBEREITET\s*->\s*Position\s+(-?\d+)/,
    parse: (m) => ({ pos: +m[1] }),
  },
  {
    event: 'go',
    re: /LOS!\s*fahre auf Position\s*(-?\d+)/,
    parse: (m) => ({ pos: +m[1] }),
  },
  {
    event: 'estop',
    re: /NOT-STOPP bei Position\s*(-?\d+)/,
    parse: (m) => ({ pos: +m[1] }),
  },
  {
    event: 'position',
    re: /NULLPUNKT gesetzt/,
    parse: () => ({ pos: 0, target: 0, moving: false }),
  },
  {
    event: 'unknownCommand',
    re: /^!!\s*unbekannt:\s*(.+)$/,
    parse: (m) => ({ cmd: m[1].trim() }),
  },
];

/* Ordnet eine Zeile des Sketches einem Ereignis zu — rein, ohne Nebenwirkung,
 * damit sich die Zuordnung gegen die echten Ausgaben prüfen lässt. */
function parseLine(text) {
  if (!text.trim()) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) return { event: p.event, payload: p.parse(m) };
  }
  return null;
}

function handleLine(line) {
  const text = line.replace(/\r$/, '');

  /* Jede Zeile geht unverändert weiter, auch die leeren: der Monitor in der
   * Seite soll denselben Text zeigen wie der serielle Monitor der Arduino-IDE,
   * und der Sketch setzt Leerzeilen bewusst zur Gliederung. */
  emit('line', { text });

  const hit = parseLine(text);
  if (hit) emit(hit.event, hit.payload);
}

/* ---------- Verbindung ---------- */

async function connect() {
  if (!isSupported()) {
    throw new Error(
      'Dieser Browser kann kein Web Serial. Chrome oder Edge auf einem Rechner verwenden.'
    );
  }
  if (port) return;

  port = await navigator.serial.requestPort();
  await port.open({ baudRate: BAUD });

  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  closing = false;
  buffer = '';

  emit('state', { connected: true });
  readLoop = pump();
}

async function pump() {
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    }
  } catch (e) {
    if (!closing) emit('error', { message: e.message });
  } finally {
    if (!closing) await disconnect();
  }
}

async function disconnect() {
  closing = true;
  try {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (writer) {
      writer.releaseLock();
    }
    if (port) await port.close().catch(() => {});
  } finally {
    reader = null;
    writer = null;
    port = null;
    readLoop = null;
    emit('state', { connected: false });
  }
}

/* ---------- Senden ---------- */

async function sendCommand(cmd) {
  if (!writer) throw new Error('Nicht verbunden.');

  const text = String(cmd).trim();
  if (text !== 's' && /s/i.test(text)) {
    throw new Error(
      `Befehl "${text}" enthält ein s — der Sketch würde das als NOT-STOPP lesen.`
    );
  }

  emit('sent', { text });
  await writer.write(new TextEncoder().encode(text + '\n'));
}

/*
 * Prüft, ob am anderen Ende tatsächlich der Katapult-Sketch hängt.
 *
 * Beim Öffnen des Ports startet der Arduino neu (die Web-Serial-API zieht dabei
 * dieselben Leitungen wie der serielle Monitor) und gibt von sich aus seine
 * Hilfe aus. Kommt die nicht — etwa weil der Port schon offen war und kein
 * Neustart ausgelöst wurde —, wird mit '?' aktiv nachgefragt.
 *
 * Aus derselben Antwort lässt sich nebenbei ablesen, ob die erweiterte Fassung
 * mit a<n> aufgespielt ist. Das geht so ohne Nebenwirkung: a<n> auszuprobieren
 * würde eine Position vormerken.
 */
async function identify() {
  if (!writer) throw new Error('Nicht verbunden.');

  const seen = [];
  const collect = ({ text }) => seen.push(text);
  on('line', collect);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sawBanner = () => seen.some((l) => /KATAPULT/i.test(l));

  try {
    await wait(2500); // Neustart nach dem Öffnen abwarten
    if (!sawBanner()) {
      await sendCommand('?');
      await wait(1800);
    }
  } finally {
    off('line', collect);
  }

  const text = seen.join('\n');
  return {
    found: sawBanner(),
    hasArm: /a<n>/i.test(text),
    lines: seen.length,
  };
}

/* NOT-STOPP. Wirkt sofort, ohne Zeilenende, weil der Sketch das Zeichen
 * direkt beim Lesen auswertet. */
async function emergencyStop() {
  if (!writer) throw new Error('Nicht verbunden.');
  emit('sent', { text: 's' });
  await writer.write(new TextEncoder().encode('s'));
}

/*
 * Position vormerken, ohne zu fahren.
 *
 * Der erweiterte Sketch kennt dafür 'a<n>' und behält damit die Sicherheitslogik
 * bei: gefahren wird erst nach GO. Ein unveränderter Sketch antwortet
 * "!! unbekannt: a…" — dann meldet diese Funktion false zurück und die
 * Oberfläche bietet stattdessen die sofortige Fahrt an.
 */
function armPosition(steps) {
  const ziel = Math.round(steps);

  return new Promise((resolve, reject) => {
    let settled = false;

    const aufraeumen = () => {
      clearTimeout(timer);
      off('armed', onArmed);
      off('unknownCommand', onUnknown);
    };

    const finish = (value) => {
      if (settled) return;
      settled = true;
      aufraeumen();
      resolve(value);
    };

    /* Nur die Bestätigung für GENAU diese Position zählt. Der Sketch merkt
     * nach einem gemeldeten Schuss von sich aus seine eigene Korrektur vor und
     * meldet das ebenfalls als "VORBEREITET" — ohne diesen Abgleich hielte man
     * dessen Meldung für die Antwort auf a<n>. */
    const onArmed = ({ pos }) => {
      if (Math.abs(pos - ziel) <= 1) finish(true);
    };
    const onUnknown = ({ cmd }) => {
      if (/^a/i.test(cmd)) finish(false);
    };

    on('armed', onArmed);
    on('unknownCommand', onUnknown);

    /* Bleibt beides aus, ist der Sketch vermutlich zu alt und schweigt. */
    const timer = setTimeout(() => finish(false), 2000);

    sendCommand('a' + ziel).catch((e) => {
      if (settled) return;
      settled = true;
      aufraeumen();
      reject(e);
    });
  });
}

/* Sofort auf eine absolute Position fahren. Der Motor läuft ohne weitere
 * Rückfrage los — die Oberfläche fragt deshalb vorher nach. */
function moveTo(steps) {
  return sendCommand('g' + Math.round(steps));
}

function releaseGo() {
  return sendCommand('g');
}

function setZero() {
  return sendCommand('0');
}

function reportShot(meters) {
  return sendCommand('w' + Number(meters));
}

/* Speist eine Zeile ein, als wäre sie vom Gerät gekommen. Gedacht zum Prüfen
 * und zur Fehlersuche: ein mitgeschnittenes Protokoll lässt sich damit noch
 * einmal durch dieselbe Auswertung schicken, ohne Hardware. */
function feedLine(text) {
  handleLine(String(text));
}

window.RatteSerial = {
  on,
  off,
  identify,
  parseLine,
  feedLine,
  connect,
  disconnect,
  isSupported,
  isConnected,
  sendCommand,
  emergencyStop,
  armPosition,
  moveTo,
  releaseGo,
  setZero,
  reportShot,
};
