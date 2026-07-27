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
  6
);

/* d = a*s^2 + b*s + c — physikalisch motiviert: die gespeicherte Energie einer
 * Feder wächst quadratisch mit dem Auszug, die Wurfweite geht linear mit der
 * Energie. */
const MODEL_QUADRATIC = linearBasisModel(
  'quadratic',
  'Quadratisch',
  'Federenergie wächst quadratisch mit dem Auszug.',
  (s) => [1, s, s * s],
  9
);

/* Kubisch — fängt zusätzliche Nichtlinearität ab (Reibung, Gummi-Kennlinie). */
const MODEL_CUBIC = linearBasisModel(
  'cubic',
  'Kubisch',
  'Zusätzliche Krümmung, z. B. durch nachgebendes Gummi.',
  (s) => [1, s, s * s, s * s * s],
  12
);

/* d = a*s^b, gefittet im Log-Raum. Skaleninvariantes Potenzgesetz. */
const MODEL_POWER = {
  id: 'power',
  label: 'Potenzgesetz',
  description: 'Distanz folgt einer festen Potenz der Steps (d = a·s^b).',
  minPoints: 6,
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

/* d = c + a*(1 - exp(-(s-s0)/tau)) — Sättigung mit Offset.
 *
 * Ab einem gewissen Auszug bringt mehr Zug kaum noch Weite, weil das Gummi am
 * Anschlag ist. Der Offset ist hier wesentlich: die Schleuder wirft erst ab
 * einer Grundvorspannung überhaupt (bei diesem Aufbau um 16000 Schritte). Ohne
 * c und s0 müsste die Kurve durch den Ursprung, was den Fit unbrauchbar macht.
 *
 * tau wird per Gitter gesucht; c und a sind bei festem tau linear lösbar. */
const MODEL_SATURATING = {
  id: 'saturating',
  label: 'Sättigung',
  description: 'Mehr Steps bringen ab einem Punkt kaum noch Weite.',
  minPoints: 9,
  fit(points) {
    const steps = points.map((p) => p.steps);
    const s0 = Math.min(...steps);
    const span = Math.max(Math.max(...steps) - s0, 1);
    const y = points.map((p) => p.distance);
    let best = null;

    for (let i = 1; i <= 120; i++) {
      const tau = (span * i) / 30;
      const X = points.map((p) => [1, 1 - Math.exp(-(p.steps - s0) / tau)]);
      const beta = olsFit(X, y);
      if (!beta) continue;
      let sse = 0;
      for (let k = 0; k < points.length; k++) {
        const r = y[k] - (beta[0] + beta[1] * X[k][1]);
        sse += r * r;
      }
      if (!best || sse < best.sse) best = { sse, c: beta[0], a: beta[1], tau };
    }

    if (!best) return null;
    const { c, a, tau } = best;
    return {
      predict(s) {
        return c + a * (1 - Math.exp(-(s - s0) / tau));
      },
      params: [c, a, tau, s0],
      nParams: 3,
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

/* ---------- Vorwissen aus den bisherigen Seilen ----------
 *
 * Ein frisch gebundenes Seil hat noch keine eigene Messreihe. Mit drei Schüssen
 * lässt sich keine Kurve bestimmen — wohl aber, WO auf einer bereits bekannten
 * Kurve man sich befindet. Denn die Form ist bei allen Seilen ähnlich; was sich
 * ändert, ist im Wesentlichen die Verschiebung (ab wann die Schleuder
 * überhaupt wirft) und die Streckung (wie kräftig sie ist).
 *
 * Deshalb treten zusätzlich zwei Familien an, die die bekannte Form übernehmen
 * und daran nur ein bis zwei Stellgrößen anpassen. Sie brauchen entsprechend
 * wenige Punkte. Weil alle Familien über dieselbe Kreuzvalidierung laufen,
 * regelt sich der Übergang von selbst: anfangs gewinnt das Vorwissen, sobald
 * genug eigene Schüsse da sind, übernehmen die freien Familien.
 */

/* Die Referenzkurve wird außerhalb ihres Messbereichs linear fortgesetzt.
 * Ein Kubischer würde dort sonst wegkippen. */
function asPrior(model) {
  if (!model || !model.ready) return null;

  const steps = model.points.map((p) => p.steps);
  const lo = Math.min(...steps);
  const hi = Math.max(...steps);
  const h = Math.max((hi - lo) * 0.01, 1);

  const f = (s) => model.fitted.predict(s);
  const slopeLo = (f(lo + h) - f(lo)) / h;
  const slopeHi = (f(hi) - f(hi - h)) / h;

  return {
    range: [lo, hi],
    predict(s) {
      if (s < lo) return f(lo) + (s - lo) * slopeLo;
      if (s > hi) return f(hi) + (s - hi) * slopeHi;
      return f(s);
    },
  };
}

/* Sucht die Verschiebung (und optional die Streckung), mit der die
 * Referenzkurve am besten auf die vorhandenen Punkte passt. */
function fitPrior(prior, points, withScale) {
  const span = prior.range[1] - prior.range[0];
  const y = points.map((p) => p.distance);

  const evaluate = (shift) => {
    const f = points.map((p) => prior.predict(p.steps - shift));
    let k = 1;
    if (withScale) {
      let num = 0;
      let den = 0;
      for (let i = 0; i < f.length; i++) {
        num += y[i] * f[i];
        den += f[i] * f[i];
      }
      if (den < 1e-12) return null;
      k = num / den;
      if (k <= 0) return null;
    }
    let sse = 0;
    for (let i = 0; i < f.length; i++) {
      const r = y[i] - k * f[i];
      sse += r * r;
    }
    return { sse, shift, k };
  };

  let best = null;
  const coarse = span * 0.6;
  for (let i = -60; i <= 60; i++) {
    const c = evaluate((coarse * i) / 60);
    if (c && (!best || c.sse < best.sse)) best = c;
  }
  if (!best) return null;

  /* Nachschärfen um das gefundene Optimum herum. */
  let stepWidth = coarse / 60;
  for (let round = 0; round < 3; round++) {
    for (let i = -10; i <= 10; i++) {
      const c = evaluate(best.shift + (stepWidth * i) / 10);
      if (c && c.sse < best.sse) best = c;
    }
    stepWidth /= 10;
  }

  return best;
}

function makePriorModel(prior, withScale) {
  return {
    id: withScale ? 'prior-scaled' : 'prior-shifted',
    label: withScale ? 'Vorwissen, angepasst' : 'Vorwissen, verschoben',
    description: withScale
      ? 'Kurvenform der bisherigen Seile, seitlich verschoben und gestreckt.'
      : 'Kurvenform der bisherigen Seile, nur seitlich verschoben.',
    minPoints: withScale ? 3 : 2,
    fit(points) {
      const best = fitPrior(prior, points, withScale);
      if (!best) return null;
      return {
        predict(s) {
          return best.k * prior.predict(s - best.shift);
        },
        params: [best.shift, best.k],
        nParams: withScale ? 2 : 1,
      };
    },
  };
}

/* ---------- Bewertung ----------
 *
 * Echte Leave-One-Out-Kreuzvalidierung: jeder Punkt wird einmal weggelassen,
 * das Modell auf dem Rest neu gefittet und der weggelassene Punkt vorhergesagt.
 * Bei ein paar hundert Schüssen ist das im Browser problemlos schnell und
 * ehrlicher als eine Formelabkürzung, weil auch die nichtlinearen Familien
 * fair mitbewertet werden.
 */
function crossValidate(model, points) {
  const n = points.length;
  if (n < model.minPoints + 1) return null;

  const squared = [];
  let absSum = 0;

  /* Die Punkte liegen nach Steps sortiert vor, und weggelassen wird nicht
   * einzeln, sondern blockweise. Das ist hier entscheidend: beim Einschießen
   * arbeitet man sich von kurz nach weit hoch, die Kurve muss also über den
   * gemessenen Bereich hinaus tragen. Ein einzeln weggelassener Punkt ist von
   * Nachbarn umzingelt und misst nur Interpolation — der erste und der letzte
   * Block dagegen prüfen genau das Hinausreichen. Familien, die daneben
   * wegkippen, fallen so auf, statt sich gut zu rechnen. */
  /* Wie viele Blöcke, hängt an der Datenlage. Bei einem frischen Seil deckt die
   * Messreihe nur einen schmalen Streifen ab und jede Schätzung reicht darüber
   * hinaus — drei Blöcke prüfen dann in zwei von drei Fällen genau das. Ist das
   * Seil erst gut vermessen, wird überwiegend interpoliert, und fünf Blöcke
   * geben das ehrlicher wieder. */
  const folds = Math.min(n >= 20 ? 5 : 3, n);

  for (let f = 0; f < folds; f++) {
    const from = Math.floor((f * n) / folds);
    const to = Math.floor(((f + 1) * n) / folds);
    const test = points.slice(from, to);
    const train = points.slice(0, from).concat(points.slice(to));

    if (train.length < model.minPoints) continue;
    const fitted = model.fit(train);
    if (!fitted) continue;

    for (const p of test) {
      const pred = fitted.predict(p.steps);
      if (!Number.isFinite(pred)) continue;
      const r = p.distance - pred;
      squared.push(r * r);
      absSum += Math.abs(r);
    }
  }

  const count = squared.length;
  if (count < model.minPoints) return null;

  const meanSq = squared.reduce((a, b) => a + b, 0) / count;
  const rmse = Math.sqrt(meanSq);

  /* Wie genau ist dieser Fehlerwert selbst? Bei wenigen Schüssen ist die
   * Kreuzvalidierung stark verrauscht — dann darf ein knapper Vorsprung keine
   * kompliziertere Familie küren. Der Standardfehler macht das messbar. */
  let variance = 0;
  for (const v of squared) variance += (v - meanSq) ** 2;
  variance /= Math.max(1, count - 1);
  const se = rmse > 1e-9 ? Math.sqrt(variance / count) / (2 * rmse) : 0;

  return { rmse, se, mae: absSum / count, evaluated: count };
}

/* Fittet alle Familien auf dem kompletten Datenstand und kürt die mit dem
 * kleinsten Kreuzvalidierungsfehler.
 *
 * prior ist optional die Referenzkurve aus den übrigen Seilen (siehe
 * buildReference). Liegt sie vor, treten zusätzlich die Familien an, die diese
 * Form nur noch verschieben und strecken — die kommen mit zwei bis drei
 * Schüssen aus. */
function buildModel(rawPoints, prior) {
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
    usesPrior: false,
    reason: '',
  };

  const minimum = prior ? 2 : 3;
  if (points.length < minimum) {
    result.reason = prior
      ? `Noch ${minimum - points.length} Schuss bis zur ersten Schätzung — die Form der bisherigen Seile ist schon da.`
      : 'Zu wenig Messwerte für eine Schätzung — mindestens 3 Schüsse nötig.';
    return result;
  }

  const families = prior
    ? MODELS.concat([makePriorModel(prior, false), makePriorModel(prior, true)])
    : MODELS;

  for (const model of families) {
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
      fromPrior: model.id.startsWith('prior-'),
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

    /* Ein-Standardfehler-Regel: unter allen Familien, die statistisch gleichauf
     * mit der besten liegen, gewinnt die sparsamste. Ohne das kürt die
     * Kreuzvalidierung bei wenigen Schüssen gern eine freie Kurve, die zufällig
     * gut durch drei Punkte läuft — und die Schätzung würde mit einem
     * zusätzlichen Schuss schlechter statt besser. */
    const leader = scored[0];
    const grenze = leader.cv.rmse + leader.cv.se;
    const gleichauf = scored.filter((c) => c.cv.rmse <= grenze);
    gleichauf.sort(
      (a, b) => a.fitted.nParams - b.fitted.nParams || a.cv.rmse - b.cv.rmse
    );

    result.best = gleichauf[0];
  } else {
    result.candidates.sort((a, b) => a.residualStd - b.residualStd);
    result.best = result.candidates[0];
  }

  result.fitted = result.best.fitted;
  result.ready = true;
  result.usesPrior = !!result.best.fromPrior;
  result.uncertainty = result.best.cv
    ? result.best.cv.rmse
    : result.best.residualStd;

  /* Bei wenigen eigenen Schüssen deckt der Messbereich nur einen Ausschnitt ab.
   * Gesucht wird die Umkehrung deshalb über den Bereich, den auch das Vorwissen
   * kennt — sonst käme für 20 m keine Antwort, obwohl die Form längst bekannt
   * ist. */
  const own = [
    Math.min(...points.map((p) => p.steps)),
    Math.max(...points.map((p) => p.steps)),
  ];
  result.measuredRange = own;

  /* Für die Warnung zählt, ob die gewünschte WEITE schon einmal geschossen
   * wurde — nicht, ob die errechnete Step-Zahl im gefahrenen Band liegt. Die
   * gefittete Kurve läuft an den Rändern naturgemäß etwas neben den äußersten
   * Messpunkten, wodurch sonst auch ganz normale Ziele wie 4 oder 25 m eine
   * Warnung ausgelöst hätten. Eine Warnung, die dauernd angeht, wird ignoriert. */
  result.distanceRange = [
    Math.min(...points.map((p) => p.distance)),
    Math.max(...points.map((p) => p.distance)),
  ];
  result.searchRange = prior
    ? [Math.min(own[0], prior.range[0]), Math.max(own[1], prior.range[1])]
    : own;

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

  const [sMin, sMax] = model.measuredRange;
  const [rMin, rMax] = model.searchRange;
  const span = Math.max(rMax - rMin, 1);

  /* Etwas über den bekannten Bereich hinaus suchen, aber nicht wild
   * extrapolieren. */
  const lo = Math.max(0, rMin - span * 0.25);
  const hi = rMax + span * 0.25;

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

  /* Ein Rand von der Größe der Vorhersagestreuung gilt noch als abgedeckt:
   * einen halben Meter über der weitesten je geschossenen Weite zu landen ist
   * keine Extrapolation, sondern liegt im Rauschen. */
  const [dMin, dMax] = model.distanceRange;
  const rand = model.uncertainty || 0;
  const drunter = targetDistance < dMin - rand;
  const drueber = targetDistance > dMax + rand;

  return {
    steps,
    inRange: !drunter && !drueber,
    note: drueber
      ? `Weiter als je geschossen (bisher höchstens ${dMax.toFixed(1)} m) — extrapoliert.`
      : drunter
        ? `Kürzer als je geschossen (bisher mindestens ${dMin.toFixed(1)} m) — extrapoliert.`
        : '',
  };
}

/* Referenzkurve aus den Schüssen aller übrigen Seile. Sie liefert die Form,
 * an der sich ein frisch gebundenes Seil zu Beginn orientiert. */
function buildReference(points) {
  if (!points || points.length < 8) return null;
  return asPrior(buildModel(points));
}

window.RatteModel = { buildModel, buildReference, stepsForDistance, MODELS };
