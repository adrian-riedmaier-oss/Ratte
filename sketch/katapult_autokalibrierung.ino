/*
  ==========================================================================
  KATAPULT  --  AUTO-KALIBRIERUNG  (loest Sketch 1 ab)
  ==========================================================================

  IDEE
    Du schiesst, tippst die gemessene Weite ein, der Arduino merkt sich
    das Paar (Position -> Weite), rechnet daraus wie viele Schritte ein
    Meter sind und faehrt selbststaendig Richtung Ziel nach.
    Je mehr Schuesse, desto besser die Schaetzung.

  TYPISCHER ABLAUF
    0         hier ist der Nullpunkt (Arm in Grundstellung)
    z8        Ziel = 8 Meter. Gibt es schon ein Modell, faehrt er direkt
              auf die geschaetzte Position. Sonst: von Hand grob vorfahren.
    (schiessen)
    w7.3      "der Schuss ging 7,3 m". Er speichert den Punkt und faehrt
              automatisch nach:  0,7 m zu kurz -> ein Stueck weiter vor.
    (schiessen)
    w8.1      "8,1 m" -> im Zielfenster, fertig. Position steht.
    Weiter mit  z10 , z12 ...  bis alle Weiten sitzen.
    t         fertige Tabelle fuer katapult_betrieb ausgeben.

  WICHTIG
    Nach dem NEU BINDEN des Seils sind die alten Punkte ungueltig
    (andere Spannung). Dann einmal  c  fuer "clear" und frisch anfangen.

  Position waechst hier mit der Wurfweite (mehr Schritte = weiter).
  Die vertauschte Motorrichtung ist ueber INVERT_DIR schon beruecksichtigt,
  du musst dir also kein Minus mehr merken.

  WICHTIG: DER MOTOR FAEHRT NIE VON SELBST.
    z<w> und w<w> berechnen nur die Zielposition und "scharfschalten" sie.
    Gefahren wird erst, wenn DU es ausloest -- mit  g  im Monitor oder dem
    GO-Taster an D4. So koennt ihr in Ruhe alles vorbereiten (laden, Ausloeser
    spannen), bevor sich etwas bewegt.

  HARDWARE
    28BYJ-48 an ULN2003, IN1..IN4 an D8..D11
    Spulenreihenfolge dieses Boards: IN1-IN3-IN2-IN4  (per Diagnose ermittelt)
    Optional: Taster gegen GND an D2 (vor) / D3 (zurueck)
    Optional: GO-Taster gegen GND an D4 (gibt vorbereitete Fahrt frei)

  WEB-KONSOLE (optional)
    Die Seite im Repository verbindet sich per USB direkt mit diesem Sketch
    und liest die Ausgaben unten mit. Ein gemeldeter Schuss ("gespeichert:
    Pos ... -> ... m") landet dort automatisch in der Messreihe, die im
    Gegensatz zu den 40 Punkten hier im RAM dauerhaft erhalten bleibt und
    auch das Seil mitfuehrt.
    Dafuer gibt es zusaetzlich  a<n> : Position vormerken ohne zu fahren.
    Auch dabei bleibt es bei GO -- der Motor faehrt nie von selbst.

  SERIELLER MONITOR: 115200 Baud, Zeilenende "Neue Zeile"
  ==========================================================================
*/

// ===================== PIN DEFINITION =====================
const int in1 = 8;
const int in2 = 9;
const int in3 = 10;
const int in4 = 11;

const int BTN_FWD = 2;    // Taster vor  (Handbetrieb)
const int BTN_BWD = 3;    // Taster zurueck (Handbetrieb)
const int BTN_GO  = 4;    // GO-Taster: gibt eine vorbereitete Fahrt frei

// ===================== EINSTELLUNGEN =====================
const bool INVERT_DIR   = false;  // f = vorwaerts, b = rueckwaerts
                                  // (am realen Motor bestaetigt)
const bool USE_FULLSTEP = false;  // false=Halbschritt, true=Vollschritt(mehr Kraft)
const bool HOLD_TORQUE  = true;   // Spulen im Stand bestromt (haelt Vorspannung)

// Startschaetzung Schritte pro Meter. Wird nach 2 Schuessen automatisch
// durch den gemessenen Wert ersetzt. Mit  k<wert>  auch manuell setzbar.
// Aus den bisherigen Messungen: Seil 1 ~338, Seil 2 (neu gebunden) ~440.
// 400 als Mittelwert -- fuer das aktuelle Seil ggf. mit k440 nachziehen.
float stepsPerMeter = 400.0;

const float TOL_M     = 0.30;     // Zielfenster +/- in Meter ("gut genug")
const long  MAX_CORR  = 4000;     // groesste Einzelkorrektur in Schritten
                                  // (bremst wilde Ausreisser aus)

const unsigned long STEP_MIN_US = 900;
const unsigned long STEP_MAX_US = 20000;
unsigned long stepIntervalMicros = 1500;

const unsigned long PLOT_INTERVAL_MS = 50;

// ===================== MESSPUNKTE =====================
const uint8_t MAX_PTS = 40;
float ptMeter[MAX_PTS];
long  ptStep [MAX_PTS];
uint8_t nPts = 0;

// ===================== ZIELE FUER DIE TABELLE =====================
const int     WEITEN[]  = { 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24 };
const uint8_t N_WEITEN  = sizeof(WEITEN) / sizeof(WEITEN[0]);

// ===================== ZUSTAND =====================
long    currentPos = 0;
long    targetPos  = 0;
int8_t  jogDir     = 0;
float   zielWeite  = 4;       // aktuell angepeiltes Ziel
uint8_t seqIdx     = 0;       // Position in WEITEN[] (4,6,...,24)
bool    plotAlways = false;

long   armedPos   = 0;        // vorbereitete Zielposition ...
bool   hasArmed   = false;    // ... wartet auf GO (g / D4-Taster)

unsigned long lastStepMicros = 0;
unsigned long lastPlotMs     = 0;

// Ergebnis der linearen Regression (hier oben deklariert, damit die
// von der Arduino-IDE erzeugten Prototypen den Typ schon kennen)
struct Modell { bool ok; float slope; float intercept; float r2; };

// ===================== SCHRITT-SEQUENZ =====================
const uint8_t SEQ_HALF[8][4] = {
  {1,0,0,0},{1,1,0,0},{0,1,0,0},{0,1,1,0},
  {0,0,1,0},{0,0,1,1},{0,0,0,1},{1,0,0,1}
};
const uint8_t SEQ_FULL[4][4] = {
  {1,1,0,0},{0,1,1,0},{0,0,1,1},{1,0,0,1}
};
const uint8_t SEQ_LEN = USE_FULLSTEP ? 4 : 8;
int8_t phase = 0;

void applyPhase(int8_t p) {
  const uint8_t *m = USE_FULLSTEP ? SEQ_FULL[p] : SEQ_HALF[p];
  digitalWrite(in1, m[0]);   // Board-Spulenreihenfolge IN1-IN3-IN2-IN4
  digitalWrite(in3, m[1]);
  digitalWrite(in2, m[2]);
  digitalWrite(in4, m[3]);
}
void releaseCoils() {
  digitalWrite(in1, LOW); digitalWrite(in2, LOW);
  digitalWrite(in3, LOW); digitalWrite(in4, LOW);
}
void doOneStep(int8_t dir) {
  int8_t d = INVERT_DIR ? -dir : dir;
  phase += d;
  if (phase >= (int8_t)SEQ_LEN) phase = 0;
  if (phase < 0) phase = SEQ_LEN - 1;
  applyPhase(phase);
}

// ===================== MODELL (lineare Regression) =====================
// Fit:  Schritte = slope * Meter + intercept
// slope ist damit direkt "Schritte pro Meter".
Modell rechneModell() {
  Modell M = { false, stepsPerMeter, 0, 0 };
  if (nPts < 2) return M;

  float sm=0, ss=0, smm=0, sms=0;
  for (uint8_t i=0;i<nPts;i++){
    sm  += ptMeter[i];
    ss  += ptStep[i];
    smm += ptMeter[i]*ptMeter[i];
    sms += ptMeter[i]*ptStep[i];
  }
  float n = nPts;
  float denom = n*smm - sm*sm;
  if (fabs(denom) < 1e-6) return M;         // alle Schuesse gleiche Weite

  float slope = (n*sms - sm*ss) / denom;
  float inter = (ss - slope*sm) / n;
  if (slope <= 0) return M;                  // unphysikalisch -> verwerfen

  // Bestimmtheitsmass R2
  float meanS = ss/n, ssTot=0, ssRes=0;
  for (uint8_t i=0;i<nPts;i++){
    float pred = slope*ptMeter[i] + inter;
    ssRes += (ptStep[i]-pred)*(ptStep[i]-pred);
    ssTot += (ptStep[i]-meanS)*(ptStep[i]-meanS);
  }
  M.ok = true;
  M.slope = slope;
  M.intercept = inter;
  M.r2 = (ssTot>1e-6) ? (1.0 - ssRes/ssTot) : 1.0;
  return M;
}

// Aktuell beste Schaetzung Schritte/Meter (Modell, sonst Startwert)
float aktSpm() {
  Modell M = rechneModell();
  return M.ok ? M.slope : stepsPerMeter;
}

// Vorhergesagte Position fuer eine Wunschweite
bool vorhersage(float meter, long &steps) {
  Modell M = rechneModell();
  if (!M.ok) return false;
  steps = lround(M.slope*meter + M.intercept);
  return true;
}

// ===================== MOTOR =====================
bool isMoving(){ return (jogDir!=0) || (targetPos!=currentPos); }

void stopNow(){
  jogDir=0; targetPos=currentPos; hasArmed=false;
  Serial.println();
  Serial.print(F("!! NOT-STOPP bei Position ")); Serial.println(currentPos);
}

// Zielposition vormerken -- FAEHRT NOCH NICHT. Wartet auf GO.
void armiere(long pos){
  armedPos = pos; hasArmed = true;
  Serial.print(F("   VORBEREITET -> Position ")); Serial.print(pos);
  Serial.print(F("  ("));
  Serial.print(pos-currentPos); Serial.println(F(" Schritte)"));
  Serial.println(F("   alles bereit machen, dann 'g' oder GO-Taster (D4)"));
}

// Vorbereitete Fahrt freigeben
void commitGo(){
  if(!hasArmed){
    Serial.println(F("!! nichts vorbereitet -- erst z<w> oder w<w>"));
    return;
  }
  jogDir=0; targetPos=armedPos; hasArmed=false;
  Serial.println();
  Serial.print(F(">> LOS! fahre auf Position ")); Serial.println(targetPos);
}

void serviceMotor(){
  int8_t dir=0;
  if(jogDir!=0) dir=jogDir;
  else if(targetPos>currentPos) dir=+1;
  else if(targetPos<currentPos) dir=-1;

  if(dir==0){ if(!HOLD_TORQUE) releaseCoils(); return; }

  unsigned long now=micros();
  if(now-lastStepMicros < stepIntervalMicros) return;
  lastStepMicros=now;

  doOneStep(dir);
  currentPos += dir;
  if(jogDir!=0) targetPos=currentPos;

  if(currentPos==targetPos && jogDir==0){
    Serial.println();
    Serial.print(F(">> Position erreicht: ")); Serial.println(currentPos);
  }
}

// ===================== TASTER =====================
void serviceButtons(){
  bool f=(digitalRead(BTN_FWD)==LOW);
  bool b=(digitalRead(BTN_BWD)==LOW);
  int8_t want=0;
  if(f&&!b) want=+1; else if(b&&!f) want=-1;
  static int8_t last=0;
  if(want!=last){ jogDir=want; if(want==0) targetPos=currentPos; last=want; }
}

// GO-Taster (D4): gibt bei Flanke die vorbereitete Fahrt frei
void serviceGoButton(){
  static bool wasPressed=false;
  bool pressed=(digitalRead(BTN_GO)==LOW);
  if(pressed && !wasPressed) commitGo();
  wasPressed=pressed;
}

// ===================== PLOTTER =====================
void servicePlot(){
  if(!plotAlways && !isMoving()) return;
  unsigned long now=millis();
  if(now-lastPlotMs < PLOT_INTERVAL_MS) return;
  lastPlotMs=now;
  Serial.print(F("Pos:"));  Serial.print(currentPos);
  Serial.print(F(" Ziel:")); Serial.println(targetPos);
}

// ===================== MESSPUNKT + AUTO-KORREKTUR =====================
void schussEingetragen(float gemessen){
  // Punkt speichern (aeltesten verwerfen, wenn voll)
  if(nPts >= MAX_PTS){
    for(uint8_t i=1;i<MAX_PTS;i++){ ptMeter[i-1]=ptMeter[i]; ptStep[i-1]=ptStep[i]; }
    nPts = MAX_PTS-1;
  }
  ptMeter[nPts]=gemessen; ptStep[nPts]=currentPos; nPts++;

  Serial.println();
  Serial.print(F(">> gespeichert:  Pos "));
  Serial.print(currentPos); Serial.print(F("  ->  "));
  Serial.print(gemessen,2); Serial.print(F(" m   (Punkt #"));
  Serial.print(nPts); Serial.println(F(")"));

  float spm = aktSpm();
  Serial.print(F("   aktuell ~")); Serial.print(spm,1);
  Serial.println(F(" Schritte/Meter"));

  if(zielWeite <= 0){
    Serial.println(F("   (kein Ziel gesetzt -- mit z<weite> aktivieren)"));
    return;
  }

  float err = zielWeite - gemessen;              // + = zu kurz, - = zu weit
  Serial.print(F("   Ziel ")); Serial.print(zielWeite,1);
  Serial.print(F(" m  ->  Abweichung "));
  Serial.print(err,2); Serial.println(F(" m"));

  if(fabs(err) <= TOL_M){
    hasArmed=false;
    Serial.println(F("   >>> im Zielfenster, Position passt. <<<"));
    if(seqIdx+1 < N_WEITEN){
      Serial.print(F("   'n' = weiter zur naechsten Weite ("));
      Serial.print(WEITEN[seqIdx+1]); Serial.println(F(" m)"));
    } else {
      Serial.println(F("   letzte Stufe -- 't' gibt die Tabelle aus."));
    }
    return;
  }

  long corr = lround(err * spm);
  corr = constrain(corr, -MAX_CORR, MAX_CORR);

  Serial.print(F("   Korrektur ")); Serial.print(corr);
  Serial.println(err>0 ? F(" Schritte (war zu kurz, weiter vor)")
                       : F(" Schritte (war zu weit, zurueck)"));
  armiere(currentPos + corr);          // nur vormerken -- Motor wartet auf GO
}

// ===================== AUSGABEN =====================
void printHelp(){
  Serial.println();
  Serial.println(F("========= KATAPULT AUTO-KALIBRIERUNG ========="));
  Serial.println(F("  DER MOTOR FAEHRT NUR NACH 'g' / GO-TASTER (D4)."));
  Serial.println(F("  Sequenz: 4 -> 6 -> ... -> 24 m. Weiter mit 'n'."));
  Serial.println(F("  0        NULLPUNKT hier setzen (startet bei 4 m)"));
  Serial.println(F("  w<w>     Schussweite melden (w7.3) -> Korrektur VORBEREITEN"));
  Serial.println(F("  n        naechste Weite (+2 m)"));
  Serial.println(F("  g        LOS: vorbereitete Fahrt freigeben (= GO-Taster)"));
  Serial.println(F("  z<w>     Ziel manuell auf w setzen (z8)"));
  Serial.println(F("  f / b    Dauerfahrt vor / zurueck (Handbetrieb, sofort)"));
  Serial.println(F("  f<n>/b<n> n Schritte vor / zurueck (sofort)"));
  Serial.println(F("  g<n>     auf absolute Position n (sofort)"));
  Serial.println(F("  a<n>     Position n nur VORMERKEN (fuer die Web-Konsole)"));
  Serial.println(F("  s        NOT-STOPP (sofort, ohne Enter)"));
  Serial.println(F("  r        zurueck auf Nullpunkt (sofort)"));
  Serial.println(F("  ------"));
  Serial.println(F("  m        Modell zeigen (Schritte/Meter, R2)"));
  Serial.println(F("  p        alle Messpunkte auflisten"));
  Serial.println(F("  t        Tabelle 4..24 m fuer katapult_betrieb"));
  Serial.println(F("  c        Messpunkte loeschen (nach Seil neu binden!)"));
  Serial.println(F("  u        letzten Messpunkt zuruecknehmen"));
  Serial.println(F("  k<wert>  Schritte/Meter manuell setzen"));
  Serial.println(F("  v<us>    Schrittzeit (klein=schnell)"));
  Serial.println(F("  x        Spulen stromlos (Vorsicht: Arm schnellt zurueck)"));
  Serial.println(F("  ?        Hilfe"));
  Serial.println(F("=============================================="));
  Serial.println();
}

void printModell(){
  Modell M=rechneModell();
  Serial.println();
  if(!M.ok){
    Serial.print(F("Modell: noch keins ("));
    Serial.print(nPts); Serial.println(F(" Punkt(e)). Mind. 2 noetig."));
    Serial.print(F("Startwert Schritte/Meter: "));
    Serial.println(stepsPerMeter,1);
    Serial.println();
    return;
  }
  Serial.println(F("--- MODELL:  Schritte = a * Meter + b ---"));
  Serial.print(F("  a (Schritte/Meter): ")); Serial.println(M.slope,1);
  Serial.print(F("  b (Offset)        : ")); Serial.println(M.intercept,1);
  Serial.print(F("  R2 (Guete 0..1)   : ")); Serial.println(M.r2,4);
  Serial.print(F("  Punkte            : ")); Serial.println(nPts);
  Serial.println(F("-----------------------------------------"));
  Serial.println();
}

void printPunkte(){
  Serial.println();
  Serial.println(F("  #   Meter    Schritte"));
  for(uint8_t i=0;i<nPts;i++){
    Serial.print(F("  ")); Serial.print(i+1);
    Serial.print(F("   ")); Serial.print(ptMeter[i],2);
    Serial.print(F("     ")); Serial.println(ptStep[i]);
  }
  if(nPts==0) Serial.println(F("  (noch keine)"));
  Serial.println();
}

void printTabelle(){
  Modell M=rechneModell();
  Serial.println();
  if(!M.ok){
    Serial.println(F("!! Noch kein Modell -- erst ein paar Schuesse."));
    Serial.println();
    return;
  }
  Serial.println(F("--- In katapult_betrieb einfuegen: ---"));
  Serial.println(F("const Punkt TABELLE[] = {"));
  for(uint8_t i=0;i<N_WEITEN;i++){
    long s=lround(M.slope*WEITEN[i]+M.intercept);
    Serial.print(F("  { "));
    if(WEITEN[i]<10) Serial.print(' ');
    Serial.print(WEITEN[i]); Serial.print(F(", "));
    Serial.print(s); Serial.println(F(" },"));
  }
  Serial.println(F("};"));
  Serial.print(F("// Modell aus ")); Serial.print(nPts);
  Serial.print(F(" Punkten, R2=")); Serial.println(M.r2,3);
  Serial.println(F("--------------------------------------"));
  Serial.println();
}

// ===================== BEFEHLE =====================
char cmdBuf[16]; uint8_t cmdLen=0;

void setZero(){
  // Punkte NICHT verschieben: der mechanische Grundstellungs-Anschlag ist
  // der feste Bezug. Immer an derselben Stelle nullen -> Punkte bleiben gueltig,
  // auch nach einem Verhaker (verlorene Schritte werden so ausgenullt).
  currentPos=0; targetPos=0; jogDir=0; hasArmed=false;
  Serial.println(F(">> NULLPUNKT gesetzt (Position = 0). Messpunkte bleiben erhalten."));
  Serial.println(F("   Immer an DERSELBEN Grundstellung nullen!"));
  Serial.print(F("   Sequenz steht bei ")); Serial.print(WEITEN[seqIdx]);
  Serial.println(F(" m."));
}

// Auf eine bestimmte Stufe der 4..24-m-Sequenz stellen
void setSeq(uint8_t idx){
  if(idx >= N_WEITEN) idx = N_WEITEN-1;
  seqIdx = idx;
  zielWeite = WEITEN[seqIdx];
  Serial.println();
  Serial.print(F(">> SEQUENZ-ZIEL: ")); Serial.print(WEITEN[seqIdx]);
  Serial.print(F(" m   (Stufe ")); Serial.print(seqIdx+1);
  Serial.print(F("/")); Serial.print(N_WEITEN); Serial.println(F(")"));
  long pred;
  if(vorhersage(zielWeite,pred)){
    Serial.print(F("   Modell schaetzt Position ")); Serial.println(pred);
    armiere(pred);                 // vormerken -- Motor wartet auf GO
  } else {
    Serial.println(F("   noch kein Modell -- von Hand vorfahren, schiessen, w<weite>"));
  }
}

void handleCmd(char *s){
  char c=s[0];
  bool hasArg=(strlen(s)>1);

  switch(c){
    case '0': setZero(); break;

    case 'z': case 'Z': {
      if(!hasArg){ Serial.println(F("!! z. B. z8")); break; }
      float w=atof(s+1);
      // passt die Weite in die Sequenz? -> Stufe mitfuehren
      for(uint8_t i=0;i<N_WEITEN;i++) if(WEITEN[i]==(int)w) seqIdx=i;
      zielWeite=w;
      Serial.println();
      Serial.print(F(">> Ziel = ")); Serial.print(zielWeite,1);
      Serial.println(F(" m"));
      long pred;
      if(vorhersage(zielWeite,pred)){
        Serial.print(F("   Modell schaetzt Position ")); Serial.println(pred);
        armiere(pred);                 // vormerken -- Motor wartet auf GO
      } else {
        Serial.println(F("   noch kein Modell -- von Hand grob vorfahren,"));
        Serial.println(F("   schiessen, dann w<weite> melden"));
      }
      break;
    }

    case 'n': case 'N':                  // naechste Weite der Sequenz
      if(seqIdx+1 >= N_WEITEN){
        Serial.println(F(">> Sequenz fertig (24 m erreicht). 't' fuer Tabelle."));
      } else {
        setSeq(seqIdx+1);
      }
      break;

    case 'w': case 'W': {
      if(!hasArg){ Serial.println(F("!! Weite angeben, z. B. w7.3")); break; }
      schussEingetragen(atof(s+1));
      break;
    }

    case 'f': case 'F':
      if(hasArg){ jogDir=0; targetPos=currentPos+atol(s+1); }
      else jogDir=+1;
      break;

    case 'b': case 'B':
      if(hasArg){ jogDir=0; targetPos=currentPos-atol(s+1); }
      else jogDir=-1;
      break;

    case 'g': case 'G':
      if(hasArg){                      // g<n> = sofort auf absolute Position n
        jogDir=0; targetPos=atol(s+1);
        Serial.print(F(">> fahre auf ")); Serial.println(targetPos);
      } else {                         // g allein = vorbereitete Fahrt freigeben
        commitGo();
      }
      break;

    // a<n> = absolute Position nur VORMERKEN, nicht fahren.
    // Gegenstueck zu g<n> fuer die Web-Konsole: die rechnet die Schritte aus
    // allen je gemessenen Schuessen und schickt das Ergebnis herueber.
    // Gefahren wird trotzdem erst nach GO -- die Regel "der Motor faehrt nie
    // von selbst" gilt damit auch fuer Befehle von aussen.
    case 'a': case 'A':
      if(!hasArg){ Serial.println(F("!! z. B. a20000")); break; }
      armiere(atol(s+1));
      break;

    case 'r': case 'R':
      jogDir=0; targetPos=0; zielWeite=0;
      Serial.println(F(">> zurueck auf Nullpunkt"));
      break;

    case 'm': case 'M': printModell(); break;
    case 'p': case 'P': printPunkte(); break;
    case 't': case 'T': printTabelle(); break;

    case 'c': case 'C':
      nPts=0; zielWeite=0;
      Serial.println(F(">> alle Messpunkte geloescht"));
      break;

    case 'u': case 'U':
      if(nPts>0){ nPts--; Serial.print(F(">> Punkt zurueckgenommen, noch "));
        Serial.println(nPts); }
      else Serial.println(F("!! keine Punkte da"));
      break;

    case 'k': case 'K':
      if(!hasArg){ Serial.println(F("!! z. B. k180")); break; }
      stepsPerMeter=atof(s+1);
      Serial.print(F(">> Schritte/Meter (Startwert) = "));
      Serial.println(stepsPerMeter,1);
      break;

    case 'v': case 'V':
      if(!hasArg){ Serial.println(F("!! z. B. v1200")); break; }
      stepIntervalMicros=constrain((unsigned long)atol(s+1),STEP_MIN_US,STEP_MAX_US);
      Serial.print(F(">> Schrittzeit ")); Serial.print(stepIntervalMicros);
      Serial.println(F(" us"));
      break;

    case 'x': case 'X':
      jogDir=0; targetPos=currentPos; releaseCoils();
      Serial.println(F(">> Spulen stromlos. Position kann verrutschen!"));
      break;

    case '?': case 'h': case 'H': printHelp(); break;

    default:
      Serial.print(F("!! unbekannt: ")); Serial.println(s);
      break;
  }
}

void serviceSerial(){
  while(Serial.available()){
    char c=Serial.read();
    if(c=='s'||c=='S'){ stopNow(); cmdLen=0; continue; }   // sofort-Stopp
    if(c=='\n'||c=='\r'){
      if(cmdLen>0){ cmdBuf[cmdLen]='\0'; handleCmd(cmdBuf); cmdLen=0; }
      continue;
    }
    if(c==' '||c=='\t') continue;
    if(cmdLen<sizeof(cmdBuf)-1) cmdBuf[cmdLen++]=c;
  }
}

// ===================== SETUP / LOOP =====================
void setup(){
  pinMode(in1,OUTPUT); pinMode(in2,OUTPUT);
  pinMode(in3,OUTPUT); pinMode(in4,OUTPUT);
  releaseCoils();
  pinMode(BTN_FWD,INPUT_PULLUP);
  pinMode(BTN_BWD,INPUT_PULLUP);
  pinMode(BTN_GO, INPUT_PULLUP);

  Serial.begin(115200);
  while(!Serial){ ; }
  printHelp();
  Serial.println(F("Arm in Grundstellung bringen, dann \"0\"."));
  Serial.println(F("Danach Sequenz ab 4 m: f (vor), schiessen, w<weite>, n (weiter)."));
  Serial.println();
  applyPhase(phase);
}

void loop(){
  serviceSerial();
  serviceButtons();
  serviceGoButton();
  serviceMotor();
  servicePlot();
}
