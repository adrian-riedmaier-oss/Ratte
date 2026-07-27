# Rattenschleuder

Messwerterfassung und Step-Schätzung für die Rattenschleuder.

Die Schleuder wird von einem Schrittmotor vorgespannt. Wie weit ein Schuss
fliegt, hängt davon ab, auf wie viele Steps gespannt wurde. Dieses Projekt
sammelt alle geschossenen Messwerte und lernt daraus die Umkehrung: **wie viele
Steps brauche ich für eine gewünschte Weite?**

Der Datenstand liegt in `data/shots.csv` und ist damit versioniert und von jedem
Gerät erreichbar. Die Konsole wird über GitHub Pages ausgeliefert und lädt genau
diese Datei beim Start.

## Wie gerechnet wird

Drei Ebenen, von grob nach fein. Jede beantwortet eine andere Frage.

### 1. Die Kurvenform — aus allen Schüssen

Wie die Wurfweite mit der Vorspannung wächst, ist bei allen Seilen ähnlich. Die
Form wird deshalb über die **gesamte Messreihe** gefittet, derzeit 188 Schüsse.
Mehrere Familien treten gegeneinander an:

- **Linear** — Weite wächst gleichmäßig mit den Steps
- **Quadratisch** — Federenergie wächst quadratisch mit dem Auszug
- **Kubisch** — zusätzliche Krümmung, etwa durch nachgebendes Gummi
- **Potenzgesetz** — `d = a·s^b`
- **Sättigung** — ab einem Punkt bringt mehr Zug kaum noch Weite

Bewertet wird per Kreuzvalidierung: ein **zusammenhängender Abschnitt** der nach
Steps sortierten Reihe wird weggelassen und dann vorhergesagt. Der Block ist
wichtig — ein einzeln weggelassener Punkt ist von Nachbarn umzingelt und misst
nur Interpolation. Beim Einschießen arbeitet man sich aber von kurz nach weit
hoch, die Kurve muss also über das Gemessene hinaus tragen. Bei statistischem
Gleichstand gewinnt die sparsamste Familie.

### 2. Die Höhenlage — je Seil

Was sich beim Neubinden ändert, ist vor allem, wie hoch die Kurve liegt. Jedes
Seil bekommt deshalb seinen eigenen Versatz. Form und Versätze werden
abwechselnd bestimmt, bis sie sich nicht mehr bewegen.

Der Versatz ist der **Median** der Restabweichungen, nicht der Mittelwert: beim
Auslösen von Hand geht ab und zu ein Schuss weit daneben, und ein einzelner
Ausreißer darf die Höhenlage eines ganzen Seils nicht verschieben.

| Seil | Schüsse | Versatz |
| ---- | ------: | ------: |
| 1    |      82 | +1,06 m |
| 2    |      15 | −0,12 m |
| 3    |      33 | −1,66 m |
| 4    |      58 | +0,12 m |

Ein Seil mit weniger als drei eigenen Schüssen erbt den Versatz des zuletzt
davor gespannten — die beste Auskunft, die es über sich gibt.

### 3. Der Feinabgleich — aus den Schüssen bei dieser Weite

Eine über den ganzen Bereich gefittete Kurve kann nicht überall zugleich passen.
In der Messreihe lag sie in der Mitte gut und am unteren Ende um rund 800
Schritte daneben — genug, um aus einem Ziel von 4 m einen Schuss von 1,3 m zu
machen.

Über die Antwort entscheidet deshalb nicht die Form allein, sondern das, was bei
ungefähr dieser Weite tatsächlich gefahren wurde. Für jeden Schuss wird
verglichen, wie viele Schritte er wirklich gebraucht hat und wie viele die Form
für seine Weite vorsieht; aus diesen Abweichungen wird der **gewichtete Median**
gebildet — gewichtet nach Nähe zur Zielweite.

Es zählen die Schüsse **aller** Seile, jeweils um den Versatz ihres Seils
bereinigt. Nur so steht bei jeder Weite genug Material bereit: für ein Ziel von
4 m sind es 39 statt 4 Schüsse. Jüngere Seile wiegen dabei schwerer.

Wieder der Median statt des Mittelwerts, und das ist der Kern: **ein Ausreißer
verschiebt ihn nicht, und alle übrigen Schüsse bleiben unverändert in der
Rechnung.** Zusätzlich ist die Korrektur auf das gedeckelt, was am Ziel etwa
anderthalb Metern entspricht — es geht um Feinjustierung, nicht um Sprünge.

### Was das bringt

Der reale Fehlschuss vom 27. Juli, Ziel 4 m:

| | damals | jetzt |
| --- | ---: | ---: |
| Vorschlag | 15.177 Steps | **16.623 Steps** |
| geflogen | 1,3 m | — |
| Referenz aus echten Schüssen | — | 16.605 → 4,1 m · 17.208 → 4,2 m |

Und in der Auslassprobe über die 58 Schüsse von Seil 4 — jeder Schuss einmal
weggelassen, dann die Steps für seine Weite vorhergesagt:

| Datenbasis | Median | p90 | größter Fehler |
| ---------- | -----: | --: | -------------: |
| nur das eigene Seil | 489 | 986 | 1.284 Steps |
| alle Seile          | 526 | 880 | **1.003 Steps** |

Der typische Fehler bleibt etwa gleich — er liegt ohnehin nahe der Streuung, die
das Auslösen von Hand erzeugt. Was deutlich besser wird, sind die Ausreißer, und
darauf kommt es an.

## Wo die Grenze liegt

Nicht in der Rechnung. Vergleicht man Schüsse mit gleicher Vorspannung
miteinander, streut die Schleuder selbst:

| Weite    | Paare | typischer Unterschied bei gleichen Steps |
| -------- | ----: | ---------------------------------------: |
| 0–8 m    |    21 |                                   0,40 m |
| 8–14 m   |    72 |                                   1,40 m |
| 14–20 m  |    41 |                                   1,40 m |
| 20–30 m  |    20 |                                   2,70 m |

Nach Sitzung getrennt, Seil 4:

| Abschnitt                 | typische Streuung |
| ------------------------- | ----------------: |
| erste Sitzung (nr 132–159) |            0,60 m |
| zweite Sitzung (nr 160–189)|            1,20 m |

Der Modellfehler nach dem Einschießen liegt bei rund 1,35 m — also **unter** der
Wiederholgenauigkeit der Mechanik. Mehr Einschuss-Weiten ändern daran nichts:
mit drei Weiten kommt dasselbe heraus wie mit acht.

Daraus folgt für die Vorbereitung:

- **Der Auslöser ist der Hebel**, nicht die Software. Zwischen erster und
  zweiter Sitzung hat sich die Streuung verdoppelt.
- **Kurze Weiten sind deutlich verlässlicher** als weite — 0,4 m gegen 2,7 m.
- **Mehrere Schüsse je Einschuss-Weite** helfen, weil sich der Einschussfehler
  mit der Wurzel der Schusszahl verkleinert: 1,5 m bei einem Schuss, 0,87 m bei
  dreien. Der Median in der Rechnung nimmt sie ohnehin robust zusammen.

Die Konsole zeigt deshalb nicht mehr einen Durchschnittswert, sondern die an
**dieser** Weite zu erwartende Streuung — bei 4 m ± 0,9 m, bei 16 m ± 2,1 m.

### Was heißt das für die Wertung

Gewertet wird nach Abstand zur Zielweite: volle Punkte im Kreis von 1 m
Durchmesser (also ± 0,50 m), Teilpunkte bei 2 m (± 1,00 m). Simuliert über die
Messreihe — neues Seil, bei 4/8/12/18/24 m eingeschossen, dann alle übrigen
Schüsse als Wertungsschüsse gerechnet:

| Bereich          | typischer Fehler | volle Punkte | mind. Teilpunkte |
| ---------------- | ---------------: | -----------: | ---------------: |
| kurz (bis 8 m)   |           0,27 m |         70 % |             90 % |
| mittel (8–16 m)  |           1,35 m |         11 % |             31 % |
| weit (ab 16 m)   |           2,02 m |          9 % |             25 % |

Mit dem Auslöser der ersten Sitzung (Streuung 0,60 m statt 1,20 m) steigt das
auf 34 % volle und 80 % Teilpunkte.

Über vier Wertungsschüsse:

| | volle Punkte | Teilpunkte | alle vier leer |
| --- | ---: | ---: | ---: |
| Auslöser wie zuletzt | 0,6 von 4 | 1,3 von 4 | 19 % |
| besserer Auslöser    | 1,4 von 4 | 3,2 von 4 | ~0 % |

Ein Probeschuss auf dieselbe Weite hebt die vollen Punkte von 13 % auf 23 %,
an den Teilpunkten ändert er nichts. Der Grund steht in der Zerlegung des
Fehlers: bei einer Gesamtstreuung von σ ≈ 2,55 m sind σ ≈ 2,10 m reiner Zufall
und nur σ ≈ 1,46 m systematisch — **zwei Drittel der Streuung lassen sich durch
keine Rechnung wegbekommen.**

## Ein frisch gebundenes Seil

Nach dem Neubinden gelten die alten Messpunkte nicht mehr — der Sketch verwirft
sie mit `c`. Die Kurvenform bleibt aber gültig, nur die Höhenlage ist offen.

Nachgerechnet, indem Seil 4 als frisches Seil behandelt und seine Schüsse
einzeln hinzugefügt wurden (Vorwissen: 130 Schüsse der Seile 1–3):

| eigene Schüsse | Fehler auf die ungesehenen | Vorschlag für 4 m |
| -------------: | -------------------------: | ----------------: |
|              0 |                 736 Steps  |            16.639 |
|              3 |                 609 Steps  |            16.547 |
|              4 |                 611 Steps  |            16.547 |
|              8 |                 720 Steps  |            16.708 |

Real brauchte Seil 4 für 4 m rund 16.605 Steps. **Schon ohne einen einzigen
eigenen Schuss** liegt der Vorschlag also im richtigen Feld, und nach drei bis
vier Schüssen wird er nicht mehr besser.

Für die Prüfung heißt das: neues Seil einspannen, über **„+ neu gebunden"**
anlegen, bei ein paar groben Weiten einschießen — 4, 8, 12, 18, 24 m genügen —,
danach macht der Feinabgleich den Rest.

## Der Regelkreis

Die Sollweite steht an **einer** Stelle — in der Schätzung, im Prüfungsmodus als
„Entfernung zum Ziel". Das Steuerpult hatte dafür einmal ein eigenes Feld;
dieselbe Größe zweimal einzutippen war eine Fehlerquelle, und beide konnten
auseinanderlaufen. Der Knopf „Zielweite melden (z)" nimmt jetzt den Wert von
oben.

Sobald eine Weite eingestellt ist, steht in der Live-Anzeige unter **Geplant**,
wohin die Konsole fahren würde, mit einer Marke auf dem Positionsbalken — noch
bevor etwas vorgemerkt oder gefahren ist. Daneben zeigt **Vorgemerkt**, was der
Arduino bestätigt hat.

Sollweite eintragen, schießen, tatsächliche Weite melden:

1. Der Sketch meldet `>> gespeichert: Pos … -> … m`.
2. Der Schuss wandert in die Messreihe und wird gesichert.
3. Form, Versätze und Feinabgleich werden neu gerechnet.
4. Die neue Vorspannung wird per `a<n>` im Arduino vorgemerkt.
5. GO drücken.

Der Sketch rechnet nach jedem Schuss auch selbst eine Korrektur, aus einer
linearen Regression über seine höchstens 40 Punkte im RAM. Die Konsole
überschreibt diese Vormerkung und schreibt in den Monitor, welche gilt.
Abschaltbar über die Automatik in der Karte „Live-Position"; dort steht auch der
Schalter, um ohne GO loszufahren — der hebt die Sicherung des Sketches auf und
fragt deshalb nach.

Nutzbar ist der Bereich, den die Messreihe abdeckt, plus ein Stück
Extrapolation. Außerhalb der je geschossenen Weiten wird die Zahl orange und der
Grund steht daneben; weit darüber hinaus verweigert die Konsole die Auskunft,
statt zu raten.

## Zwei Betriebsarten

**Testmodus** — zum Sammeln. Volles Steuerpult für den Sketch, Diagramm,
Modellrangliste, Datentabelle.

**Prüfungsmodus** — zum Treffen. Nur Entfernung und Ausrichtung: Richtung
(links, geradeaus, rechts) und Winkel in Fünferschritten von 5 bis 45 Grad.
Daraus die Vorspannung, vormerken, GO.

Der Winkel dreht nur das Gerät — auf die nötige Vorspannung wirkt er nicht, für
die zählt allein die Entfernung zum Ziel. Mitgeschrieben wird er trotzdem, damit
sich später nachprüfen lässt, ob doch ein Zusammenhang besteht.

## Anbindung an den Arduino

Die Konsole verbindet sich per **Web Serial** direkt über USB mit dem Sketch.
Nötig ist Chrome oder Edge auf einem Rechner; Firefox und Safari können das
nicht.

### Verbinden und prüfen

Oben in der Seite: **Arduino verbinden**. Ein offener Port beweist nur, dass ein
USB-Gerät da ist — ob dort der Katapult-Sketch läuft, zeigt erst seine Antwort.
Die Konsole fragt gleich nach dem Verbinden nach (und über **Verbindung prüfen**
jederzeit wieder):

- **Sketch erkannt · a\<n\> vorhanden** — alles da
- **Sketch erkannt · ohne a\<n\>** — läuft, aber Vormerken geht nicht; die
  Fassung aus `sketch/` aufspielen
- **keine Antwort vom Sketch** — meist ist der serielle Monitor der Arduino-IDE
  noch offen. Einen Port kann immer nur ein Programm gleichzeitig benutzen.

Geprüft wird über die Hilfeausgabe, die der Sketch beim Neustart von selbst
schickt; bleibt sie aus, wird `?` gesendet. Bewusst nebenwirkungsfrei — `a<n>`
auszuprobieren würde eine Position vormerken.

### Alle Befehle sind abgebildet

Das Steuerpult deckt den vollständigen Befehlssatz ab:
`0 · ? · a · b · c · f · g · k · m · n · p · r · s · t · u · v · w · x · z`.
Jeder Knopf trägt den Befehl, den er schickt. Ohne Verbindung wird nichts
gesendet, sondern angezeigt, was gesendet würde.

Der serielle Monitor der Seite gibt die Ausgaben unverändert wieder, Leerzeilen
eingeschlossen. Selbst gesendete Befehle sind mit `>` markiert.

Ausgewertet werden unter anderem:

| Ausgabe des Sketches           | Wirkung in der Konsole                  |
| ------------------------------ | --------------------------------------- |
| `Pos:… Ziel:…`                 | Live-Anzeige während der Fahrt          |
| `>> gespeichert: Pos … -> … m` | Schuss wandert automatisch in die Reihe |
| `VORBEREITET -> Position …`    | vorgemerkte Position                    |
| `!! NOT-STOPP bei Position …`  | Warnung                                 |

### Die Ergänzung am Sketch

Der Sketch folgt der Regel „der Motor fährt nie von selbst": `z<w>` merkt nur
vor, gefahren wird erst nach `g` oder dem GO-Taster. Für eine absolute Position
gab es das nicht — `g<n>` fährt sofort los. Da die Konsole ihre Steps selbst
rechnet, fehlte genau dieses Gegenstück. **`a<n>`** merkt eine absolute Position
vor, ohne zu fahren.

**Vorsicht beim Senden:** `serviceSerial()` wertet **jedes** `s` im Datenstrom
sofort als NOT-STOPP und verwirft den Eingabepuffer. Ein Befehl darf deshalb nie
ein `s` enthalten. `sendCommand` prüft das ab.

## Wo die Daten bleiben

1. **Sofort im Browser** — jeder Schuss landet im `localStorage`, auch ohne Netz.
2. **Ins Repository** — liegt ein Token vor, wird nach jedem Schuss automatisch
   `data/shots.csv` zurückgeschrieben, 15 Sekunden verzögert.
3. **Als Datei** — „CSV herunterladen".

Für Stufe 2 einmalig einen Token hinterlegen (Knopf „Zugang …"): *fine-grained*,
nur dieses Repository, `Contents: read and write`. Er bleibt ausschließlich im
Browser.

## Datenformat

| Spalte      | Bedeutung                                      |
| ----------- | ---------------------------------------------- |
| `nr`        | Fortlaufende Schussnummer                      |
| `seil`      | Welches Seil gespannt war                      |
| `zeit`      | Uhrzeit des Schusses, sofern bekannt           |
| `steps`     | Vorspannung in Schritten                       |
| `distanz_m` | Gemessene Flugweite in Metern                  |
| `ziel_m`    | Angepeilte Weite, sofern gesetzt               |
| `winkel`    | Ausrichtung, z. B. `geradeaus` oder `25° links` |
| `notiz`     | Freitext                                       |

## Einrichten

1. **Settings → Pages → Build and deployment**: *Source* auf **Deploy from a
   branch**, Branch **`main`**, Ordner **`/ (root)`**, dann *Save*.
2. Token hinterlegen (siehe oben).
3. `sketch/katapult_autokalibrierung.ino` aufspielen.

Lokal genügt ein statischer Server im Projektordner, etwa
`python3 -m http.server` — es gibt keinen Bauschritt und keine Abhängigkeiten.

## Aufbau

```
index.html                Konsole
.nojekyll                 schaltet die Jekyll-Vorverarbeitung von Pages ab
css/style.css             Darstellung, hell und dunkel
js/model.js               Form, Versätze, Feinabgleich, Umkehrung
js/data.js                Laden, Zusammenführen, Zurückschreiben
js/chart.js               Diagramm (SVG, ohne Fremdbibliothek)
js/serial.js              Web-Serial-Anbindung an den Sketch
js/app.js                 Verdrahtung
data/shots.csv            Messreihe — die Quelle der Wahrheit
data/rohdaten_original.csv  Ursprünglicher Export, unverändert
sketch/                   Arduino-Sketch
```
