# Rattenschleuder

Messwerterfassung und Step-Schätzung für die Rattenschleuder.

Die Schleuder wird von einem Schrittmotor gespannt. Wie weit ein Schuss fliegt,
hängt davon ab, auf wie viele Steps vorgespannt wurde. Dieses Projekt sammelt
alle geschossenen Messwerte und lernt daraus die Umkehrung: **wie viele Steps
brauche ich für eine gewünschte Distanz?**

## Warum ein Repo statt einer Artifact-Seite

Der Vorgänger war eine statische Seite mit hart einprogrammierten Messwerten.
Neue Schüsse gingen dadurch verloren. Eine Artifact-Seite kann das nicht lösen:
sie hat keine Möglichkeit, Daten serverseitig abzulegen.

Deshalb liegt der Datenstand hier im Repo (`data/shots.csv`) und ist damit
persistent, versioniert und von jedem Gerät erreichbar. Die Seite selbst wird
über GitHub Pages ausgeliefert und lädt die CSV beim Start.

## Datenformat

`data/shots.csv` ist die einzige Quelle der Wahrheit.

| Spalte       | Bedeutung                                      |
| ------------ | ---------------------------------------------- |
| `id`         | Fortlaufende Schussnummer                      |
| `datum`      | Datum des Schusses (ISO, `YYYY-MM-DD`)         |
| `steps`      | Vorspannung in Schritten des Schrittmotors     |
| `distanz_cm` | Gemessene Flugweite in Zentimetern             |
| `notiz`      | Freitext, optional (Wind, Geschoss, Auffälliges)|

## Modell

Es gibt bewusst kein fest verdrahtetes Modell. In `js/model.js` treten fünf
Familien gegeneinander an:

- **Linear** — Distanz wächst gleichmäßig mit den Steps
- **Quadratisch** — Federenergie wächst quadratisch mit dem Auszug
- **Kubisch** — zusätzliche Krümmung, etwa durch nachgebendes Gummi
- **Potenzgesetz** — `d = a·s^b`
- **Sättigung** — ab einem Punkt bringt mehr Zug kaum noch Weite

Bewertet wird per Leave-One-Out-Kreuzvalidierung: jeder Messpunkt wird einmal
weggelassen, das Modell auf dem Rest neu gefittet und der weggelassene Punkt
vorhergesagt. Gewonnen hat die Familie mit dem kleinsten Vorhersagefehler auf
ungesehenen Schüssen.

Der Fit passiert bei jedem Laden neu über den kompletten Datenstand. Die
Schätzung verbessert sich damit automatisch mit jedem neuen Schuss — und wenn
genug Daten da sind, kann auch eine andere Familie nach vorne rücken.

## Stand

Im Aufbau. Fertig ist der Modellkern (`js/model.js`).

Noch offen:

- [ ] Historische Messwerte einpflegen (die ~130 Schüsse der alten Seite plus
      die neuen — liegen bisher nur in der alten, hart einprogrammierten Seite)
- [ ] Oberfläche: Eingabe, Diagramm, Schätzung
- [ ] Schreibpfad, damit neue Schüsse aus der Seite heraus im Repo landen
- [ ] Web-Serial-Anbindung an den Arduino (USB), sobald der Sketch vorliegt
- [ ] GitHub-Pages-Deployment
