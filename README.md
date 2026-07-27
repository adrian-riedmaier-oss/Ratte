# Rattenschleuder

Messwerterfassung und Step-Schätzung für die Rattenschleuder.

Die Schleuder wird von einem Schrittmotor vorgespannt. Wie weit ein Schuss
fliegt, hängt davon ab, auf wie viele Steps gespannt wurde. Dieses Projekt
sammelt alle geschossenen Messwerte und lernt daraus die Umkehrung: **wie viele
Steps brauche ich für eine gewünschte Distanz?**

## Warum ein Repository statt einer Artifact-Seite

Der Vorgänger war eine statische Seite mit hart einprogrammierten Messwerten.
Neue Schüsse gingen dadurch verloren, weil die Werte im Seitenquelltext
standen. Eine Artifact-Seite kann das nicht lösen — sie hat keine Möglichkeit,
Daten serverseitig abzulegen.

Deshalb liegt der Datenstand hier im Repository (`data/shots.csv`) und ist damit
persistent, versioniert und von jedem Gerät erreichbar. Die Konsole wird über
GitHub Pages ausgeliefert und lädt genau diese Datei beim Start.

## Das Seil ist der entscheidende Faktor

Jedes neu gebundene Seil hat eine eigene Kennlinie — andere Spannung, andere
Wurfweite bei gleicher Vorspannung. Ein gemeinsamer Fit über alle Seile wäre
schlicht falsch. Die Konsole rechnet deshalb **pro Seil** und wählt beim Start
automatisch das aktuellste.

| Seil | Schüsse | bestes Modell         | Fehler |
| ---- | ------: | --------------------- | -----: |
| 1    |      82 | Linear                | 1,24 m |
| 2    |      15 | Linear                | 0,92 m |
| 3    |      33 | Potenzgesetz          | 0,78 m |
| 4    |      28 | Vorwissen, verschoben | 1,01 m |

Wie weit die Seile auseinanderliegen, zeigt sich, wenn man die Kennlinie des
einen auf die Schüsse des nächsten anwendet:

| Kennlinie von … auf … | Fehler | systematischer Versatz |
| --------------------- | -----: | ---------------------: |
| Seil 1 → Seil 2       | 1,92 m |                −1,37 m |
| Seil 2 → Seil 3       | 1,47 m |                −0,40 m |
| Seil 3 → Seil 4       | 0,82 m |                 0,24 m |

Seil 1 und 2 sind also deutlich verschieden — wer die alte Kennlinie
weiterbenutzt, liegt im Mittel um 1,37 m daneben, und zwar immer in dieselbe
Richtung.

Seil 3 und Seil 4 standen in den Rohdaten beide unter dem Namen „Seil 3", obwohl
die Trennmarke in der Quelldatei ein neu gebundenes Seil ausweist. Sie sind
allerdings ungewöhnlich **ähnlich** gebunden worden: 0,24 m Versatz, gerade
einmal 92 Steps Verschiebung. Getrennt zu führen ist trotzdem richtig — es
kostet nichts und entspricht dem, was tatsächlich passiert ist —, aber ein
großer Sprung wie zwischen Seil 1 und 2 ist es nicht.

## Datenformat

`data/shots.csv` ist die einzige Quelle der Wahrheit.

| Spalte      | Bedeutung                                        |
| ----------- | ------------------------------------------------ |
| `nr`        | Fortlaufende Schussnummer                        |
| `seil`      | Welches Seil gespannt war (`Seil 1` … `Seil 4`)  |
| `zeit`      | Uhrzeit des Schusses, sofern bekannt              |
| `steps`     | Vorspannung in Schritten des Schrittmotors        |
| `distanz_m` | Gemessene Flugweite in Metern                     |
| `ziel_m`    | Angepeilte Weite, sofern gesetzt                  |
| `winkel`    | Ausrichtung, z. B. `geradeaus` oder `25° links`   |
| `notiz`     | Freitext                                          |

Die ursprüngliche Exportdatei liegt unverändert als
`data/rohdaten_original.csv` daneben.

## Modell

Es gibt bewusst kein fest verdrahtetes Modell. In `js/model.js` treten fünf
Familien gegeneinander an:

- **Linear** — Distanz wächst gleichmäßig mit den Steps
- **Quadratisch** — Federenergie wächst quadratisch mit dem Auszug
- **Kubisch** — zusätzliche Krümmung, etwa durch nachgebendes Gummi
- **Potenzgesetz** — `d = a·s^b`
- **Sättigung** — ab einem Punkt bringt mehr Zug kaum noch Weite

Dazu kommen zwei Familien, die nicht frei fitten, sondern die **Kurvenform des
vorherigen Seils** übernehmen und daran nur verschieben (ein Parameter) und
strecken (zwei). Sie sind der Grund, warum ein frisch gebundenes Seil sofort
brauchbar schätzt — dazu unten mehr.

Bewertet wird per Kreuzvalidierung: ein **zusammenhängender Abschnitt** der nach
Steps sortierten Messreihe wird weggelassen, das Modell auf dem Rest neu
gefittet und der fehlende Abschnitt vorhergesagt. Der Block ist wichtig. Ein
einzeln weggelassener Punkt ist von Nachbarn umzingelt und misst nur
Interpolation — beim Einschießen arbeitet man sich aber von kurz nach weit hoch,
die Kurve muss also über das Gemessene hinaus tragen. Der erste und der letzte
Block prüfen genau das.

Bei statistischem Gleichstand gewinnt die sparsamste Familie
(Ein-Standardfehler-Regel). Ohne diese Regel kürt die Kreuzvalidierung bei
wenigen Schüssen gern eine freie Kurve, die zufällig gut durch drei Punkte
läuft — und die Schätzung würde mit einem zusätzlichen Schuss schlechter statt
besser. Die Rangliste steht in der Konsole, die Auswahl ist also nachvollziehbar
und nicht geraten.

Der Fit passiert bei jedem Laden neu über den kompletten Datenstand — und nach
jedem neu eingetragenen Schuss sofort noch einmal. Die Schätzung verbessert sich
damit automatisch, und wenn genug Daten da sind, kann auch eine andere Familie
nach vorne rücken.

Gefittet wird `Distanz = f(Steps)`, nicht umgekehrt. Das ist die richtige
Richtung: die Steps stellt der Motor genau ein, die Streuung steckt fast
vollständig in der gemessenen Weite. Für die praktische Frage („wie viele Steps
für 12 m?") wird die Kurve anschließend numerisch umgekehrt.

## Der Regelkreis

Sollweite eintragen, schießen, tatsächliche Weite melden — den Rest macht die
Konsole:

1. Der Sketch meldet `>> gespeichert: Pos … -> … m`.
2. Der Schuss wandert in die Messreihe und wird gesichert.
3. Das Modell wird über den kompletten Datenstand neu gerechnet.
4. Daraus die neue Vorspannung für die Sollweite — und die wird per `a<n>` im
   Arduino vorgemerkt.
5. GO drücken.

Der Sketch rechnet nach jedem Schuss auch selbst eine Korrektur, aus einer
linearen Regression über seine höchstens 40 Punkte im RAM. Die Konsole
überschreibt diese Vormerkung mit ihrem eigenen Wert und schreibt in den
Monitor, welcher gilt. Abschalten lässt sich das Nachführen über die Automatik
in der Karte „Live-Position"; dort steht auch der Schalter, um ohne GO
loszufahren — der hebt allerdings die Sicherung des Sketches auf und fragt
deshalb nach.

### Warum es nicht nur am Modell hängt

Das Modell über alle Schüsse ist träge, und das ist meistens richtig: bei rund
einem Meter Streuung von Schuss zu Schuss darf ein einzelner Ausreißer die Kurve
nicht verbiegen. Nur gilt das nicht mehr, wenn sich das Seil im Lauf einer
Sitzung dehnt. Dann liegen die letzten Schüsse systematisch auf einer Seite, und
das Modell bräuchte Dutzende Schüsse zum Nachziehen — gemessen: nach drei
Schüssen, die alle 1,5 m zu kurz lagen, bewegte sich die Schätzung um ganze
29 Steps.

Deshalb sind Form und Höhenlage getrennt. Die Kurvenform kommt aus allen
Schüssen, die Höhenlage aus den letzten paar: der **Nachlauf** ist der
gewichtete Mittelwert von gemessen minus vorhergesagt. Ein Ausreißer bewegt ihn
nur zum Teil und klingt ab, mehrere Schüsse in dieselbe Richtung setzen sich
durch.

Gewichtet wird doppelt — nach Aktualität und nach **Nähe zum Ziel**. Ein Versatz,
der bei 24 m gemessen wurde, sagt wenig über einen Schuss auf 12 m; er kann
genauso gut daher rühren, dass die Kurvenform am weiten Ende leicht
danebenliegt. Ohne diese zweite Gewichtung sprang die Schätzung um 465 Steps in
die falsche Richtung. Liegen alle jüngsten Schüsse weit vom Ziel weg, geht der
Nachlauf gegen null und es bleibt beim reinen Modell.

Mit beidem zusammen, nachgerechnet an drei zu kurzen Schüssen auf ein 12-m-Ziel:

| Schuss             | vorgemerkt danach |
| ------------------ | ----------------: |
| —                  |            20.881 |
| 20.800 → 10,4 m    |            21.294 |
| 21.150 → 11,6 m    |            21.295 |
| 21.260 → 12,1 m    |            21.260 |

Nach dem ersten Schuss steht die Korrektur, danach hält sie sich.

## Ein frisch gebundenes Seil

Nach dem Neubinden gelten die alten Messpunkte nicht mehr — der Sketch verwirft
sie deshalb mit `c`. Bei null eigenen Schüssen steht man damit aber wieder ganz
am Anfang.

Das ist unnötig: was sich beim Neubinden ändert, ist vor allem, **ab wann** die
Schleuder wirft und **wie kräftig** sie ist. Die Form der Kurve bleibt ähnlich.
Also übernimmt ein neues Seil die Form des vorherigen und passt daran nur ein
bis zwei Stellgrößen an — das geht mit zwei Schüssen.

Nachgerechnet an allen drei Seilwechseln der Messreihe. Trainiert wird auf den
ersten n Schüssen des neuen Seils, bewertet auf allen übrigen — also genau der
Fall „ich habe kurz eingeschossen und will jetzt weiter hinaus":

| eigene Schüsse | Seil 1 → 2 | Seil 2 → 3 | Seil 3 → 4 | ohne Vorwissen |
| -------------: | ---------: | ---------: | ---------: | -------------- |
|              2 |     2,88 m |     1,46 m |     0,82 m | keine Schätzung |
|              3 |     2,67 m |     1,49 m |     0,82 m | keine Schätzung |
|              4 |     2,08 m |     1,51 m |     0,83 m | keine Schätzung |
|              5 |     1,27 m |     1,53 m |     0,87 m | keine Schätzung |
|              8 |     1,38 m |     1,61 m |     0,90 m | 1,38 / 4,60 / 3,64 m |

Der Unterschied zwischen den Spalten ist die Ähnlichkeit der Seile: Seil 3 und 4
wurden fast gleich gebunden, Seil 1 und 2 nicht. Selbst im ungünstigsten Fall
liegt man ab dem zweiten Schuss bei knapp 2,9 m und nach fünf Schüssen bei
1,3 m — statt bis Schuss 6 bis 8 gar keine Schätzung zu haben.

Entscheidend ist dabei weniger die Zahl als die Reichweite: die Schätzung deckt
ab dem zweiten Schuss sofort den ganzen Bereich von 4 bis 24 m ab, nicht nur die
zwei bereits geschossenen Weiten.

Wichtig dabei: das Vorwissen kommt vom **zuletzt davor gespannten Seil**, nicht
aus allen bisherigen zusammen. Zusammengeworfen ergeben verschieden gespannte
Seile eine verschmierte Durchschnittsform, die zu „linear" entartet — im Test
2,0 m Fehler statt 0,8 m.

Der Übergang regelt sich von selbst: alle Familien laufen durch dieselbe
Kreuzvalidierung. Anfangs gewinnt das Vorwissen, sobald genug eigene Schüsse da
sind, übernehmen die freien Familien. In der Konsole ist jederzeit ablesbar,
welche gerade führt.

In der Oberfläche startet ein neues Seil über **„+ neu gebunden"**.

## Anbindung an den Arduino

Die Konsole verbindet sich per **Web Serial** direkt über USB mit dem Sketch —
kein Zwischenstück, kein Server. Nötig ist Chrome oder Edge auf einem Rechner;
Firefox und Safari können Web Serial nicht.

### Verbinden und prüfen

Oben in der Seite: **Arduino verbinden**. Ein offener Port beweist aber nur, dass
ein USB-Gerät da ist — ob dort auch der Katapult-Sketch läuft, zeigt erst seine
Antwort. Deshalb fragt die Konsole gleich nach dem Verbinden nach (und über
**Verbindung prüfen** jederzeit wieder) und meldet eines von drei Ergebnissen:

- **Sketch erkannt · a\<n\> vorhanden** — alles da
- **Sketch erkannt · ohne a\<n\>** — läuft, aber Vormerken geht nicht; die
  Fassung aus `sketch/` aufspielen
- **keine Antwort vom Sketch** — meist ist der serielle Monitor der Arduino-IDE
  noch offen. Einen Port kann immer nur ein Programm gleichzeitig benutzen.

Geprüft wird über die Hilfeausgabe des Sketches, die er beim Neustart von selbst
schickt; bleibt sie aus, wird `?` gesendet. Das ist bewusst nebenwirkungsfrei —
`a<n>` auszuprobieren würde eine Position vormerken.

### Alle Befehle sind abgebildet

Das Steuerpult deckt den vollständigen Befehlssatz des Sketches ab:
`0 · ? · a · b · c · f · g · k · m · n · p · r · s · t · u · v · w · x · z`.
Jeder Knopf trägt den Befehl, den er schickt. Ohne Verbindung wird nichts
gesendet, sondern angezeigt, was gesendet würde.

Der serielle Monitor der Seite gibt die Ausgaben unverändert wieder, Leerzeilen
eingeschlossen — er zeigt denselben Text wie der Monitor der Arduino-IDE.
Selbst gesendete Befehle sind mit `>` markiert.

Der Sketch gibt seinen Zustand ohnehin schon vollständig über die serielle
Schnittstelle aus, ausgewertet werden daher unter anderem:

| Ausgabe des Sketches               | Wirkung in der Konsole                 |
| ---------------------------------- | -------------------------------------- |
| `Pos:… Ziel:…`                     | Live-Anzeige während der Fahrt          |
| `>> gespeichert: Pos … -> … m`     | Schuss wandert automatisch in die Reihe |
| `VORBEREITET -> Position …`        | vorgemerkte Position                    |
| `!! NOT-STOPP bei Position …`      | Warnung                                 |

Ein gemeldeter Schuss landet damit ohne Abtippen in der Messreihe — und anders
als die 40 Punkte im RAM des Arduino bleibt er dauerhaft erhalten und führt das
Seil mit.

### Zwei Ergänzungen am Sketch

**`a<n>` — Position vormerken.** Der Sketch folgt der Regel „der Motor fährt nie
von selbst": `z<w>` merkt nur vor, gefahren wird erst nach `g` oder dem
GO-Taster. Für eine absolute Position gab es das aber nicht — `g<n>` fährt
sofort los. Da die Konsole ihre Steps aus allen je gemessenen Schüssen rechnet
und dann herüberschickt, fehlte genau dieses Gegenstück. `a<n>` merkt eine
absolute Position vor, ohne zu fahren; die GO-Bestätigung bleibt.

Die Konsole erkennt selbst, ob der Arduino den Befehl kennt: antwortet er
`!! unbekannt: a…`, wird stattdessen die sofortige Fahrt angeboten — nach
Rückfrage, weil der Motor dabei ohne GO losläuft.

**Vorsicht beim Senden:** `serviceSerial()` wertet **jedes** `s` im Datenstrom
sofort als NOT-STOPP und verwirft den Eingabepuffer. Ein Befehl darf deshalb
niemals ein `s` enthalten. Alle Befehle des Sketches erfüllen das; `sendCommand`
prüft es zusätzlich ab, damit es beim Erweitern nicht versehentlich kaputtgeht.

## Zwei Betriebsarten

**Testmodus** — zum Sammeln. Volles Steuerpult für den Sketch, Diagramm,
Modellrangliste, Datentabelle. Jeder Knopf schickt genau den Befehl, der
danebensteht; ohne Verbindung zeigt die Konsole nur an, was sie geschickt
hätte, sodass sich alles gefahrlos durchprobieren lässt.

**Prüfungsmodus** — zum Treffen. Nur noch Entfernung und Ausrichtung: Richtung
(links, geradeaus, rechts) und Winkel in Fünferschritten von 5 bis 45 Grad.
Daraus die Vorspannung, vormerken, GO. Kein Diagramm, keine Tabellen.

Der Winkel dreht nur das Gerät — auf die nötige Vorspannung wirkt er nicht, für
die zählt allein die Entfernung zum Ziel. Mitgeschrieben wird er trotzdem in der
Spalte `winkel`, damit sich später nachprüfen lässt, ob doch ein Zusammenhang
besteht. Ein Ergebnis lässt sich auch im Prüfungsmodus festhalten und fließt
sofort ins Modell.

## Wo die Daten bleiben

Drei Stufen, damit nichts verloren geht:

1. **Sofort im Browser.** Jeder Schuss landet unmittelbar im `localStorage` —
   auch ohne Netz und ohne Token.
2. **Ins Repository.** „Mit GitHub synchronisieren" schreibt `data/shots.csv`
   per API zurück. Hat in der Zwischenzeit jemand anders geschrieben, wird
   zusammengeführt statt überschrieben.
3. **Als Datei.** „CSV herunterladen" gibt den kompletten Stand aus.

Für Stufe 2 wird ein Token gebraucht (Knopf „Zugang …"). Empfohlen ist ein
**fine-grained** Token, der nur auf dieses eine Repository zeigt und dort genau
`Contents: read and write` darf. Er bleibt ausschließlich im Browser. Wer das
nicht möchte, arbeitet mit Stufe 1 und 3 — die Konsole funktioniert vollständig
ohne Token.

## Einrichten

1. **Settings → Pages → Build and deployment**: *Source* auf
   **Deploy from a branch**, Branch **`main`**, Ordner **`/ (root)`**, dann
   *Save*. Die Seite steht kurz darauf unter
   `https://<benutzer>.github.io/Ratte/`.

   Ein Workflow ist dafür nicht nötig — die Seite ist reines HTML ohne
   Bauschritt, GitHub liefert den Repository-Inhalt direkt aus. Jeder Push auf
   `main` veröffentlicht automatisch neu. Die leere Datei `.nojekyll` schaltet
   die Jekyll-Vorverarbeitung ab, die sonst über die Dateien laufen würde.

2. Für das Zurückschreiben einmalig den Token hinterlegen (siehe oben).
3. Für die USB-Verbindung `sketch/katapult_autokalibrierung.ino` aufspielen.

Lokal genügt ein beliebiger statischer Server im Projektordner, etwa
`python3 -m http.server` — es gibt keinen Bauschritt und keine Abhängigkeiten.

## Aufbau

```
index.html                Konsole
.nojekyll                 schaltet die Jekyll-Vorverarbeitung von Pages ab
css/style.css             Darstellung, hell und dunkel
js/model.js               Modellfamilien, Kreuzvalidierung, Umkehrung
js/data.js                Laden, Zusammenführen, Zurückschreiben
js/chart.js               Diagramm (SVG, ohne Fremdbibliothek)
js/serial.js              Web-Serial-Anbindung an den Sketch
js/app.js                 Verdrahtung
data/shots.csv            Messreihe — die Quelle der Wahrheit
data/rohdaten_original.csv  Ursprünglicher Export, unverändert
sketch/                   Arduino-Sketch
```
