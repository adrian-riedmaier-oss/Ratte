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

/* ---------- Bewertung ----------
 *
 * Kreuzvalidierung: ein zusammenhängender Abschnitt der nach Steps sortierten
 * Messreihe wird weggelassen, das Modell auf dem Rest neu gefittet und der
 * fehlende Abschnitt vorhergesagt.
 *
 * Blockweise, nicht einzeln: ein einzeln weggelassener Punkt ist von Nachbarn
 * umzingelt und misst nur Interpolation. Beim Einschießen arbeitet man sich
 * aber von kurz nach weit hoch, die Kurve muss also über das Gemessene hinaus
 * tragen. Der erste und der letzte Block prüfen genau das.
 */
function crossValidate(model, points) {
  const n = points.length;
  if (n < model.minPoints + 1) return null;

  const squared = [];
  let absSum = 0;

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

  let variance = 0;
  for (const v of squared) variance += (v - meanSq) ** 2;
  variance /= Math.max(1, count - 1);
  const se = rmse > 1e-9 ? Math.sqrt(variance / count) / (2 * rmse) : 0;

  return { rmse, se, mae: absSum / count, evaluated: count };
}

/* Fittet alle Familien auf den übergebenen Punkten und kürt die beste. */
function buildShape(rawPoints) {
  const points = rawPoints
    .filter(
      (p) =>
        Number.isFinite(p.steps) &&
        Number.isFinite(p.distance) &&
        p.steps >= 0
    )
    .slice()
    .sort((a, b) => a.steps - b.steps);

  const result = { points, candidates: [], best: null, fitted: null, ready: false };
  if (points.length < 3) return result;

  for (const model of MODELS) {
    if (points.length < model.minPoints) continue;
    const fitted = model.fit(points);
    if (!fitted) continue;

    const cv = crossValidate(model, points);

    let sse = 0;
    for (const p of points) sse += (p.distance - fitted.predict(p.steps)) ** 2;

    result.candidates.push({
      id: model.id,
      label: model.label,
      description: model.description,
      fitted,
      cv,
      residualStd: Math.sqrt(sse / Math.max(1, points.length - fitted.nParams)),
    });
  }

  if (!result.candidates.length) return result;

  const scored = result.candidates.filter((c) => c.cv);
  if (scored.length) {
    scored.sort((a, b) => a.cv.rmse - b.cv.rmse);

    /* Ein-Standardfehler-Regel: unter allen Familien, die statistisch gleichauf
     * mit der besten liegen, gewinnt die sparsamste. Ohne das kürt die
     * Kreuzvalidierung bei wenigen Schüssen gern eine freie Kurve, die zufällig
     * gut durch drei Punkte läuft. */
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

/* ---------- Gemeinsame Form, eigene Höhenlage ----------
 *
 * Jedes Seil für sich zu rechnen verschenkt den größten Teil der Messreihe: für
 * das aktuelle Seil blieben von 188 Schüssen nur 58 übrig. Die Kurvenform ist
 * aber bei allen Seilen ähnlich — was sich beim Neubinden ändert, ist vor allem
 * die Höhenlage.
 *
 * Deshalb wird eine gemeinsame Form über ALLE Schüsse gefittet, und jedes Seil
 * bekommt zusätzlich seinen eigenen Versatz. Beides wird abwechselnd bestimmt,
 * bis es sich nicht mehr bewegt: Form aus den um ihren Versatz bereinigten
 * Punkten, Versatz als Median der Restabweichungen je Seil.
 *
 * Der Median, nicht der Mittelwert — beim Auslösen von Hand geht ab und zu ein
 * Schuss weit daneben, und ein einzelner Ausreißer darf die Höhenlage eines
 * ganzen Seils nicht verschieben.
 */

function median(werte) {
  if (!werte.length) return 0;
  const s = werte.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const VERSATZ_RUNDEN = 4;
const VERSATZ_MIN_SCHUESSE = 3;

function buildShared(ropes) {
  const brauchbar = ropes.filter((r) => r.points.length);
  if (!brauchbar.length) return null;

  const versatz = new Map(brauchbar.map((r) => [r.name, 0]));
  let shape = null;

  for (let runde = 0; runde < VERSATZ_RUNDEN; runde++) {
    const bereinigt = [];
    for (const r of brauchbar) {
      const v = versatz.get(r.name);
      for (const p of r.points) {
        bereinigt.push({ steps: p.steps, distance: p.distance - v });
      }
    }

    const neu = buildShape(bereinigt);
    if (!neu.ready) return null;
    shape = neu;

    /* Versätze neu bestimmen. Ein Seil mit sehr wenigen Schüssen bekommt noch
     * keinen eigenen — es erbt den des zuletzt davor gespannten, denn das ist
     * die beste Auskunft, die es über sich gibt. */
    let letzterBekannter = 0;
    for (const r of brauchbar) {
      if (r.points.length >= VERSATZ_MIN_SCHUESSE) {
        const rest = r.points.map(
          (p) => p.distance - shape.fitted.predict(p.steps)
        );
        letzterBekannter = median(rest);
      }
      versatz.set(r.name, letzterBekannter);
    }

    /* Form und Versätze sind zusammen überbestimmt — ohne Verankerung wandern
     * beide gemeinsam davon. Deshalb die Versätze um ihren Median zentrieren. */
    const mitte = median([...versatz.values()]);
    for (const [k, v] of versatz) versatz.set(k, v - mitte);
  }

  return { shape, versatz };
}

/* ---------- Kurve abtasten und umkehren ---------- */

function sampleCurve(fitted, [lo, hi], n = 1400) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const s = lo + ((hi - lo) * i) / n;
    pts.push([s, fitted.predict(s)]);
  }
  return pts;
}

/* Die Kurve ist nicht garantiert monoton — eine Parabel kippt irgendwann wieder
 * ab. Genommen wird der erste aufsteigende Schnittpunkt, das ist der
 * physikalisch sinnvolle Ast. */
function curveInvert(curve, distance) {
  if (!curve || !Number.isFinite(distance)) return null;
  for (let i = 1; i < curve.length; i++) {
    const [s0, d0] = curve[i - 1];
    const [s1, d1] = curve[i];
    if (!Number.isFinite(d0) || !Number.isFinite(d1) || d1 < d0) continue;
    if (d0 <= distance && distance <= d1) {
      return d1 === d0 ? s0 : s0 + ((distance - d0) / (d1 - d0)) * (s1 - s0);
    }
  }
  return null;
}

/* ---------- Lokale Korrektur ----------
 *
 * Eine über den ganzen Bereich gefittete Kurve kann nicht überall zugleich
 * passen. In der Messreihe von Seil 4 lag sie in der Mitte gut und am unteren
 * Ende um rund 800 Schritte daneben — genug, um aus einem Ziel von 4 m einen
 * Schuss von 1,3 m zu machen. Ausreißer waren daran nicht schuld: sie
 * herauszunehmen änderte den Fit um drei Schritte.
 *
 * Deshalb entscheidet über die Antwort nicht die Form allein, sondern das, was
 * bei ungefähr dieser Weite tatsächlich gefahren wurde. Für jeden Schuss wird
 * verglichen, wie viele Schritte er wirklich gebraucht hat und wie viele die
 * Form für seine Weite vorsieht. Aus diesen Abweichungen wird der Median
 * gebildet, gewichtet nach Nähe zur Zielweite.
 *
 * Es zählen die Schüsse ALLER Seile, jeweils um den Versatz ihres Seils
 * bereinigt — nur so steht bei jeder Weite genug Material zur Verfügung.
 * Jüngere Seile wiegen dabei schwerer, weil dort die Technik dieselbe war.
 *
 * Der Median statt des Mittelwerts, weil beim Auslösen von Hand einzelne
 * Schüsse weit danebengehen. Ein Ausreißer verschiebt den Median nicht, und
 * alle übrigen Schüsse bleiben unverändert in der Rechnung.
 */

/* Stellgrößen der lokalen Korrektur. Bewusst an einer Stelle und benannt —
 * sie sind an der Messreihe abgestimmt, nicht geraten. */
const TUNING = {
  fensterMin: 2.5, // Fensterbreite bei kurzen Weiten, in Metern
  fensterAnteil: 0.18, // ihr Zuwachs mit der Zielweite
  alterung: 0.995, // ältere Schüsse zählen nur wenig weniger
  seilAlterung: 0.7, // wie stark ältere Seile zurücktreten
  maxKorrekturM: 1.5, // größte Korrektur, in Metern an der Zielweite
};

function gewichteterMedian(werte) {
  const sortiert = werte.slice().sort((a, b) => a.wert - b.wert);
  const gesamt = sortiert.reduce((a, x) => a + x.gewicht, 0);
  if (gesamt <= 0) return 0;
  let kumuliert = 0;
  for (const x of sortiert) {
    kumuliert += x.gewicht;
    if (kumuliert >= gesamt / 2) return x.wert;
  }
  return sortiert[sortiert.length - 1].wert;
}

function localCorrection(model, zielFormraum) {
  const leer = { delta: 0, used: 0, window: 0 };
  if (!model.ready || !Number.isFinite(zielFormraum)) return leer;

  const alle = model.allShots;
  if (!alle || alle.length < 2) return leer;

  const fenster = Math.max(
    TUNING.fensterMin,
    TUNING.fensterAnteil * Math.abs(zielFormraum)
  );
  const n = alle.length;
  const werte = [];

  alle.forEach((p, i) => {
    const noetig = curveInvert(model.curve, p.distance);
    if (noetig == null) return;

    const naehe = Math.exp(-Math.pow((p.distance - zielFormraum) / fenster, 2));
    if (naehe < 0.05) return; // zu weit weg, sagt nichts über dieses Ziel

    werte.push({
      wert: p.steps - noetig,
      gewicht: naehe * p.seilGewicht * Math.pow(TUNING.alterung, n - 1 - i),
    });
  });

  if (werte.length < 2) return { ...leer, window: fenster };

  let delta = gewichteterMedian(werte);

  /* Gedeckelt auf das, was am Ziel etwa anderthalb Metern entspricht — so
   * bleibt es bei Feinjustierung statt großer Sprünge. */
  const basis = curveInvert(model.curve, zielFormraum);
  if (basis != null) {
    const steigung = model.slopeAt(basis);
    if (steigung > 1e-9) {
      const grenze = TUNING.maxKorrekturM / steigung;
      delta = Math.max(-grenze, Math.min(grenze, delta));
    }
  }

  return { delta, used: werte.length, window: fenster };
}

/* ---------- Umkehrung: Distanz -> Steps ---------- */

function stepsForDistance(model, targetDistance) {
  if (!model.ready || !Number.isFinite(targetDistance)) return null;

  /* Gerechnet wird im Formraum: die gemeinsame Kurve ohne den Versatz des
   * Seils. */
  const ziel = targetDistance - model.offset;
  const roh = curveInvert(model.curve, ziel);

  if (roh == null) {
    const letzte = model.curve[model.curve.length - 1][1];
    return {
      steps: null,
      inRange: false,
      note:
        ziel > letzte
          ? 'Zieldistanz liegt über allem, was bisher gemessen wurde.'
          : 'Zieldistanz liegt außerhalb des bisher abgedeckten Bereichs.',
    };
  }

  const lokal = localCorrection(model, ziel);
  const steps = Math.round(roh + lokal.delta);

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
    delta: Math.round(lokal.delta),
    localShots: lokal.used,
    note: drueber
      ? `Weiter als je geschossen (bisher höchstens ${dMax.toFixed(1)} m) — extrapoliert.`
      : drunter
        ? `Kürzer als je geschossen (bisher mindestens ${dMin.toFixed(1)} m) — extrapoliert.`
        : '',
  };
}

/* ---------- Modell je Seil ---------- */

/*
 * ropes: [{ name, points: [{steps, distance}] }, ...] in zeitlicher Reihenfolge,
 * ältestes zuerst. Zurück kommt eine Map von Seilname auf Modell.
 */
function buildAll(ropes) {
  const modelle = new Map();
  const geteilt = buildShared(ropes);

  if (!geteilt) {
    for (const r of ropes) {
      modelle.set(r.name, {
        ready: false,
        points: r.points,
        candidates: [],
        reason:
          'Zu wenig Messwerte für eine Schätzung — mindestens 3 Schüsse nötig.',
      });
    }
    return modelle;
  }

  const { shape, versatz } = geteilt;

  /* Alle Schüsse in den Formraum bringen: Weite minus Versatz des eigenen
   * Seils. Danach sind sie untereinander vergleichbar. */
  const alleSchuesse = [];
  ropes.forEach((r, idx) => {
    const seilGewicht = Math.pow(TUNING.seilAlterung, ropes.length - 1 - idx);
    for (const p of r.points) {
      alleSchuesse.push({
        steps: p.steps,
        distance: p.distance - versatz.get(r.name),
        seilGewicht,
      });
    }
  });

  const formSteps = shape.points.map((p) => p.steps);
  const formSpanne = Math.max(
    Math.max(...formSteps) - Math.min(...formSteps),
    1
  );
  const suchbereich = [
    Math.max(0, Math.min(...formSteps) - formSpanne * 0.25),
    Math.max(...formSteps) + formSpanne * 0.25,
  ];
  const curve = sampleCurve(shape.fitted, suchbereich);

  for (const r of ropes) {
    const offset = versatz.get(r.name) ?? 0;
    const eigen = r.points;

    const model = {
      ready: true,
      offset,
      curve,
      allShots: alleSchuesse,
      shape,
      points: eigen,
      candidates: shape.candidates,
      best: shape.best,
      searchRange: suchbereich,
      reason: '',
      slopeAt(s) {
        const h = Math.max(formSpanne * 0.005, 1);
        return (
          (shape.fitted.predict(s + h) - shape.fitted.predict(s - h)) / (2 * h)
        );
      },
      fitted: { predict: (s) => shape.fitted.predict(s) + offset },
    };

    model.measuredRange = eigen.length
      ? [
          Math.min(...eigen.map((p) => p.steps)),
          Math.max(...eigen.map((p) => p.steps)),
        ]
      : [suchbereich[0], suchbereich[1]];

    /* Solange das Seil selbst kaum Schüsse hat, gilt der Bereich der
     * gemeinsamen Form — sonst verweigerte es die Auskunft für Weiten, die
     * längst bekannt sind. */
    const formBereich = [
      Math.min(...shape.points.map((p) => p.distance)) + offset,
      Math.max(...shape.points.map((p) => p.distance)) + offset,
    ];
    model.distanceRange =
      eigen.length >= 6
        ? [
            Math.min(...eigen.map((p) => p.distance)),
            Math.max(...eigen.map((p) => p.distance)),
          ]
        : formBereich;

    /* Streuung: die eigenen Schüsse gegen das eigene Modell, sonst die der
     * gemeinsamen Form. */
    if (eigen.length >= 4) {
      let sse = 0;
      for (const p of eigen) sse += (p.distance - model.fitted.predict(p.steps)) ** 2;
      model.uncertainty = Math.sqrt(sse / eigen.length);
    } else {
      model.uncertainty = shape.uncertainty;
    }

    model.usesShared = eigen.length < VERSATZ_MIN_SCHUESSE;
    modelle.set(r.name, model);
  }

  return modelle;
}

window.RatteModel = {
  TUNING,
  buildAll,
  buildShape,
  stepsForDistance,
  curveInvert,
  median,
  MODELS,
};
