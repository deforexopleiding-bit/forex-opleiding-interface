# Wat Iris in het LMS zou willen

**Datum:** 21 september 2026
**Status:** wensen, geen wijzigingen. Vanuit deze sessie is er niets aan het
LMS gewijzigd.

De opdracht vraagt nieuwe LMS-velden of -endpoints hier te beschrijven in
plaats van ze te maken. Dit is die lijst, op volgorde van hoeveel het scheelt.

---

## 1. Een einddatum-mutatie met een reden erbij

**Wat er nu is:** `hlms_student.eind_datum` is een kale datum. Iris kan hem
vooruit zetten (via `iris_acties`, type `lms_toegang_verlengen`) maar er blijft
nergens staan waarom.

**Wat er zou moeten zijn:** een tabel of kolommenset met per verlenging de
reden, wie het deed en vanuit welk systeem. Bijvoorbeeld:

```
hlms_toegang_mutaties
  student_id, van_datum, naar_datum, reden, door, door_systeem, op
```

**Waarom het scheelt:** "Of de einddatum meeschuift hangt van de reden af: bij
ziekte of vakantie wel, bij betaling of geen contact niet." Die regel staat in
de opdracht, en zonder vastgelegde reden is achteraf niet te zien of hij
gevolgd is. Nu is een verlenging een datum die veranderd is, en verder niets.

---

## 2. Een leesbaar antwoord op "mag deze student er nog in?"

**Wat er nu is:** de functie `hlms_toegang_geldig()`. Iris gebruikt hem niet
maar rekent zelf met `eind_datum`, omdat het antwoord van de functie niet zegt
*waarom* iemand er niet in mag.

**Wat er zou moeten zijn:** een functie of view die naast `true`/`false` ook
een reden geeft: verlopen, on hold, nooit gestart, geblokkeerd.

**Waarom het scheelt:** wie belt over "ik kan niet inloggen", wil van Maxim
horen wát er aan de hand is. "Je toegang is verlopen op 1 september" en "je
staat op pauze wegens twee openstaande facturen" zijn twee verschillende
gesprekken, en Iris kan ze nu niet uit elkaar houden zonder drie tabellen
tegelijk te lezen en zelf te gokken welke het zwaarst weegt.

---

## 3. On hold zetten via een endpoint in plaats van een kolom

**Wat er nu is:** `hlms_student_hold`, die `api/_lib/lms-hold.js` leest.

**Wat er zou moeten zijn:** een machine-endpoint aan LMS-kant dat een hold zet
mét reden, met einddatum en met de regel over of de einddatum meeschuift al
ingebakken.

**Waarom het scheelt:** die regel is business-logica van het LMS, niet van het
CRM. Nu zou Iris hem moeten nabouwen, en dan staat hij op twee plekken en lopen
die twee na een half jaar uiteen. Dat is precies wat er met de zeven mailboxen
is gebeurd (die staan nu op drie plekken in dit repo).

Zolang dit er niet is, staat `lms_on_hold` in `iris_acties` als staptype dat
uitdrukkelijk een fout gooit: "nog niet ingebouwd". Liever dat dan een stap die
er in het scherm uitziet alsof hij lukte.

---

## 4. Een uitnodigings-endpoint dat idempotent is

**Wat er nu is:** `api/_lib/dfo-lms-uitnodiging.js` aan CRM-kant.

**Wat er zou moeten zijn:** een endpoint dat bij een tweede aanroep binnen X
minuten dezelfde uitnodiging teruggeeft in plaats van een tweede te sturen.

**Waarom het scheelt:** "stuur de uitnodiging opnieuw" is precies het soort
knop waar twee keer op geklikt wordt, en twee mails met twee verschillende
links is verwarrender dan geen mail.

---

## Wat er NIET gevraagd wordt

- Geen schrijfrechten op `hlms_signaal`. Die tabel is van de mentormodule.
- Geen toegang tot het LMS-schema vanuit deze sessie. De enige schrijfactie die
  Iris doet is `eind_datum` bij een goedgekeurde verlenging, en die loopt via
  de bestaande sleutel.
- Geen koppeling andersom (LMS die het CRM leest). De richting blijft CRM → LMS.
