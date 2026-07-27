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
    re: /^Pos:(-?\d+)\s+Ziel:(-?\d+)/,
    handle: (m) =>
      emit('position', { pos: +m[1], target: +m[2], moving: true }),
  },
  {
    re: /Position erreicht:\s*(-?\d+)/,
    handle: (m) =>
      emit('position', { pos: +m[1], target: +m[1], moving: false }),
  },
  /* Der wichtigste Fall: der Sketch hat einen Schuss verbucht. */
  {
    re: /gespeichert:\s*Pos\s+(-?\d+)\s*->\s*(-?[\d.]+)\s*m/i,
    handle: (m) => emit('shot', { steps: +m[1], distance: parseFloat(m[2]) }),
  },
  {
    re: /VORBEREITET\s*->\s*Position\s+(-?\d+)/,
    handle: (m) => emit('armed', { pos: +m[1] }),
  },
  {
    re: /LOS!\s*fahre auf Position\s*(-?\d+)/,
    handle: (m) => emit('go', { pos: +m[1] }),
  },
  {
    re: /NOT-STOPP bei Position\s*(-?\d+)/,
    handle: (m) => emit('estop', { pos: +m[1] }),
  },
  {
    re: /NULLPUNKT gesetzt/,
    handle: () => emit('position', { pos: 0, target: 0, moving: false }),
  },
  {
    re: /^!!\s*unbekannt:\s*(.+)$/,
    handle: (m) => emit('unknownCommand', { cmd: m[1].trim() }),
  },
];

function handleLine(line) {
  const text = line.replace(/\r$/, '');
  if (!text.trim()) return;
  emit('line', { text });
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      p.handle(m);
      return;
    }
  }
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
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offArmed();
      offUnknown();
      resolve(value);
    };

    const onArmed = () => finish(true);
    const onUnknown = ({ cmd }) => {
      if (/^a/i.test(cmd)) finish(false);
    };

    const offArmed = () => {
      const l = listeners.armed || [];
      const i = l.indexOf(onArmed);
      if (i >= 0) l.splice(i, 1);
    };
    const offUnknown = () => {
      const l = listeners.unknownCommand || [];
      const i = l.indexOf(onUnknown);
      if (i >= 0) l.splice(i, 1);
    };

    on('armed', onArmed);
    on('unknownCommand', onUnknown);

    /* Bleibt beides aus, ist der Sketch vermutlich zu alt und schweigt. */
    const timer = setTimeout(() => finish(false), 1500);

    sendCommand('a' + Math.round(steps)).catch((e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offArmed();
      offUnknown();
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

window.RatteSerial = {
  on,
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
