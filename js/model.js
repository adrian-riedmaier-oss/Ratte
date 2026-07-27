'use strict';

/*
 * Modellkern der Rattenschleuder.
 *
 * Aufgabe: aus allen bisher gemessenen Schüssen (Steps -> Distanz) die
 * Umkehrung lernen, also "wie viele Steps brauche ich für Distanz X".
 *
 * Es gibt kein fest verdrahtetes Modell. Stattdessen konkurrieren mehrere
 * Modellfamilien gegeneinander und werden per Leave-One-Out-Kreuzvalidierung
 * bewertet. Gewonnen hat, wer ungesehene Schüsse am besten vorhersagt. Dadurch
 * verbessert sich die Schätzung automatisch mit jedem neuen Messwert: mehr
 * Daten können eine andere Familie nach vorne bringen.
 */

/* ---------- Lineare Algebra (klein gehalten, p <= 4) ---------- */

/* Löst die Normalgleichungen (X'X)b = X'y per Gauß-Elimination mit
 * Spaltenpivotisierung. Ein winziger Ridge-Term hält die Sache auch dann
 * stabil, wenn zwei Spalten fast kollinear sind. */
function olsFit(X, y) {
  const n = X.length;
  const p = X[0].length;

  const A = [];
  for (let i = 0; i < p; i++) A.push(new Array(p + 1).fill(0));

  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += X[k][i] * X[k][j];
      A[i][j] = s;
    }
    let s = 0;
    for (let k = 0; k < n; k++) s += X[k][i] * y[k];
    A[i][p] = s;
  }

  let trace = 0;
  for (let i = 0; i < p; i++) trace += A[i][i];
  const ridge = (trace / p) * 1e-10;
  for (let i = 0; i < p; i++) A[i][i] += ridge;

  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-14) return null;
    if (piv !== col) {
      const t = A[piv];
      A[piv] = A[col];
      A[col] = t;
    }
    const d = A[col][col];
    for (let j = col; j <= p; j++) A[col][j] /= d;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let j = col; j <= p; j++) A[r][j] -= f * A[col][j];
    }
  }

  const beta = new Array(p);
  for (let i = 0; i < p; i++) {
    beta[i] = A[i][p];
    if (!Number.isFinite(beta[i])) return null;
  }
  return beta;
}

/* ---------- Modellfamilien ----------
 *
 * Jede Familie bekommt die Punkte [{steps, distance}, ...] und liefert ein
 * Objekt mit predict(steps). Steps werden intern auf ~1 skaliert, sonst wird
 * die Konditionierung bei kubischen Termen schlecht.
 */

function linearBasisModel(id, label, description, basis, minPoints) {
  return {
    id,
    label,
    description,
    minPoints,
    fit(points) {
      const scale = Math.max(...points.map((p) => p.steps)) || 1;
      const X = points.map((p) => basis(p.steps / scale));
      const y = points.map((p) => p.distance);
      const beta = olsFit(X, y);
      if (!beta) return null;
      return {
        predict(steps) {
          const row = basis(steps / scale);
          let s = 0;
          for (let i = 0; i < row.length; i++) s += row[i] * beta[i];
          return s;
        },
        params: beta,
        nParams: beta.length,
      };
    },
  };
}

/* d = a*s + b — einfachste Annahme, oft schon erstaunlich brauchbar. */
const MODEL_LINEAR = linearBasisModel(
  'linear',
  'Linear',
  'Distanz wächst gleichmäßig mit den Steps.',
  (s) => [1, s],
  3
);

/* d = a*s^2 + b*s + c — physikalisch motiviert: die gespeicherte Energie einer
 * Feder wächst quadratisch mit dem Auszug, die Wurfweite geht linear mit der
 * Energie. */
const MODEL_QUADRATIC = linearBasisModel(
  'quadratic',
  'Quadratisch',
  'Federenergie wächst quadratisch mit dem Auszug.',
  (s) => [1, s, s * s],
  4
);

/* Kubisch — fängt zusätzliche Nichtlinearität ab (Reibung, Gummi-Kennlinie). */
const MODEL_CUBIC = linearBasisModel(
  'cubic',
  'Kubisch',
  'Zusätzliche Krümmung, z. B. durch nachgebendes Gummi.',
  (s) => [1, s, s * s, s * s * s],
  6
);

/* d = a*s^b, gefittet im Log-Raum. Skaleninvariantes Potenzgesetz. */
const MODEL_POWER = {
  id: 'power',
  label: 'Potenzgesetz',
  description: 'Distanz folgt einer festen Potenz der Steps (d = a·s^b).',
  minPoints: 4,
  fit(points) {
    const usable = points.filter((p) => p.steps > 0 && p.distance > 0);
    if (usable.length < this.minPoints) return null;
    const X = usable.map((p) => [1, Math.log(p.steps)]);
    const y = usable.map((p) => Math.log(p.distance));
    const beta = olsFit(X, y);
    if (!beta) return null;
    const a = Math.exp(beta[0]);
    const b = beta[1];
    return {
      predict(steps) {
        if (steps <= 0) return 0;
        return a * Math.pow(steps, b);
      },
      params: [a, b],
      nParams: 2,
    };
  },
};

/* d = a*(1 - exp(-s/tau)) — Sättigung. Ab einem gewissen Auszug bringt mehr
 * Zug kaum noch Weite, weil das Gummi am Anschlag ist. tau wird per Gitter
 * gesucht, a ist bei festem tau linear lösbar. */
const MODEL_SATURATING = {
  id: 'saturating',
  label: 'Sättigung',
  description: 'Mehr Steps bringen ab einem Punkt kaum noch Weite.',
  minPoints: 5,
  fit(points) {
    const sMax = Math.max(...points.map((p) => p.steps)) || 1;
    let best = null;

    for (let i = 1; i <= 80; i++) {
      const tau = (sMax * i) / 20;
      const X = points.map((p) => [1 - Math.exp(-p.steps / tau)]);
      const y = points.map((p) => p.distance);
      const beta = olsFit(X, y);
      if (!beta) continue;
      let sse = 0;
      for (let k = 0; k < points.length; k++) {
        const r = y[k] - beta[0] * X[k][0];
        sse += r * r;
      }
      if (!best || sse < best.sse) best = { sse, a: beta[0], tau };
    }

    if (!best) return null;
    const { a, tau } = best;
    return {
      predict(steps) {
        return a * (1 - Math.exp(-steps / tau));
      },
      params: [a, tau],
      nParams: 2,
    };
  },
};

const MODELS = [
  MODEL_LINEAR,
  MODEL_QUADRATIC,
  MODEL_CUBIC,
  MODEL_POWER,
  MODEL_SATURATING,
];

/* ---------- Bewertung ----------
 *
 * Echte Leave-One-Out-Kreuzvalidierung: jeder Punkt wird einmal weggelassen,
 * das Modell auf dem Rest neu gefittet und der weggelassene Punkt vorhergesagt.
 * Bei ein paar hundert Schüssen ist das im Browser problemlos schnell und
 * ehrlicher als eine Formelabkürzung, weil auch die nichtlinearen Familien
 * fair mitbewertet werden.
 */
function crossValidate(model, points) {
  if (points.length < model.minPoints + 1) return null;

  let sse = 0;
  let absSum = 0;
  let count = 0;

  for (let i = 0; i < points.length; i++) {
    const train = points.slice(0, i).concat(points.slice(i + 1));
    const fitted = model.fit(train);
    if (!fitted) continue;
    const pred = fitted.predict(points[i].steps);
    if (!Number.isFinite(pred)) continue;
    const r = points[i].distance - pred;
    sse += r * r;
    absSum += Math.abs(r);
    count++;
  }

  if (count < model.minPoints) return null;
  return {
    rmse: Math.sqrt(sse / count),
    mae: absSum / count,
    evaluated: count,
  };
}

/* Fittet alle Familien auf dem kompletten Datenstand und kürt die mit dem
 * kleinsten Kreuzvalidierungsfehler. */
function buildModel(rawPoints) {
  const points = rawPoints
    .filter(
      (p) =>
        Number.isFinite(p.steps) &&
        Number.isFinite(p.distance) &&
        p.steps >= 0 &&
        p.distance >= 0
    )
    .slice()
    .sort((a, b) => a.steps - b.steps);

  const result = {
    points,
    candidates: [],
    best: null,
    fitted: null,
    ready: false,
    reason: '',
  };

  if (points.length < 3) {
    result.reason =
      'Zu wenig Messwerte für eine Schätzung — mindestens 3 Schüsse nötig.';
    return result;
  }

  for (const model of MODELS) {
    if (points.length < model.minPoints) continue;
    const fitted = model.fit(points);
    if (!fitted) continue;

    const cv = crossValidate(model, points);

    let sse = 0;
    for (const p of points) {
      const r = p.distance - fitted.predict(p.steps);
      sse += r * r;
    }
    const dof = Math.max(1, points.length - fitted.nParams);

    result.candidates.push({
      id: model.id,
      label: model.label,
      description: model.description,
      fitted,
      cv,
      residualStd: Math.sqrt(sse / dof),
    });
  }

  if (!result.candidates.length) {
    result.reason = 'Keine Modellfamilie ließ sich auf diesen Daten fitten.';
    return result;
  }

  /* Ohne Kreuzvalidierung (sehr wenige Punkte) entscheidet der In-Sample-Fehler,
   * dann aber bewusst die sparsamste Familie zuerst. */
  const scored = result.candidates.filter((c) => c.cv);
  if (scored.length) {
    scored.sort((a, b) => a.cv.rmse - b.cv.rmse);
    result.best = scored[0];
  } else {
    result.candidates.sort((a, b) => a.residualStd - b.residualStd);
    result.best = result.candidates[0];
  }

  result.fitted = result.best.fitted;
  result.ready = true;
  result.uncertainty = result.best.cv
    ? result.best.cv.rmse
    : result.best.residualStd;

  result.candidates.sort((a, b) => {
    const av = a.cv ? a.cv.rmse : Infinity;
    const bv = b.cv ? b.cv.rmse : Infinity;
    return av - bv;
  });

  return result;
}

/* ---------- Umkehrung: Distanz -> Steps ----------
 *
 * Die gefittete Kurve ist nicht garantiert monoton (eine Parabel kippt
 * irgendwann wieder ab). Deshalb wird sie dicht abgetastet und der erste
 * aufsteigende Schnittpunkt mit der Zieldistanz genommen — das ist der
 * physikalisch sinnvolle Ast. Anschließend Bisektion für die Feinheit.
 */
function stepsForDistance(model, targetDistance) {
  if (!model.ready || !Number.isFinite(targetDistance)) return null;

  const stepsList = model.points.map((p) => p.steps);
  const sMin = Math.min(...stepsList);
  const sMax = Math.max(...stepsList);
  const span = Math.max(sMax - sMin, 1);

  /* Etwas über den gemessenen Bereich hinaus suchen, aber nicht wild
   * extrapolieren. */
  const lo = Math.max(0, sMin - span * 0.25);
  const hi = sMax + span * 0.25;

  const N = 2000;
  const predict = (s) => model.fitted.predict(s);

  let bracket = null;
  let prevS = lo;
  let prevD = predict(lo);

  for (let i = 1; i <= N; i++) {
    const s = lo + ((hi - lo) * i) / N;
    const d = predict(s);
    if (!Number.isFinite(d)) {
      prevS = s;
      prevD = d;
      continue;
    }
    const crosses =
      (prevD - targetDistance) * (d - targetDistance) <= 0 && prevD !== d;
    if (crosses && d >= prevD) {
      bracket = [prevS, s];
      break;
    }
    if (!bracket && crosses) bracket = [prevS, s];
    prevS = s;
    prevD = d;
  }

  if (!bracket) {
    return {
      steps: null,
      inRange: false,
      note:
        targetDistance > predict(hi)
          ? 'Zieldistanz liegt über allem, was bisher gemessen wurde.'
          : 'Zieldistanz liegt außerhalb des bisher abgedeckten Bereichs.',
    };
  }

  let [a, b] = bracket;
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    const d = predict(m);
    if (d < targetDistance) a = m;
    else b = m;
  }

  const steps = Math.round((a + b) / 2);
  const measuredMin = sMin;
  const measuredMax = sMax;

  return {
    steps,
    inRange: steps >= measuredMin && steps <= measuredMax,
    note:
      steps < measuredMin || steps > measuredMax
        ? 'Achtung: außerhalb des gemessenen Step-Bereichs — extrapoliert.'
        : '',
  };
}

window.RatteModel = { buildModel, stepsForDistance, MODELS };
