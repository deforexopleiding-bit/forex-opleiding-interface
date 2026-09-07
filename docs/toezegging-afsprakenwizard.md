# Toezegging in de afsprakenwizard

"Klant belooft te betalen op datum X" — vastleggen, en dan stil tot die datum.

## Waarom dit geen nieuw mechanisme is

Het arrangement-type `TOEZEGGING` bestaat al sinds migratie
`2026-07-14-arrangement-toezegging.sql` en werkt end-to-end in de backend. Wat
ontbrak was een manier om er via de interface een te maken: de wizard bood vijf
types aan en `TOEZEGGING` stond er niet tussen. Deze wijziging voegt die ene
keuze toe en laat de rest van het spoor ongemoeid.

Het bestaande spoor, ongewijzigd:

| Stap | Wie doet het |
|---|---|
| Aanmaken, direct op `ACTIEF` | `api/arrangements-propose.js` |
| Aanmaan-runs pauzeren | `pauseRunsForArrangement()` → `paused_by_arrangement_id` |
| Dagelijkse controle (06:00) | `api/cron-arrangements-breach-check.js`, case `TOEZEGGING` |
| Betaald → dossier afronden | `completeRunsFromArrangement()` bij `NAGEKOMEN` |
| Niet betaald → weer aanmanen | `VERBROKEN` → dunning-engine via `trigger_conditions.arrangement_breached` → workflow **Betaalafspraak verbroken** (`is_active = true` in productie) |

Geen tweede pauzemechanisme, geen nieuwe cron, geen TeamLeader-mutatie, geen
approval-flow.

## Wat er in de interface bij komt

**De wizard.** In het dossier van een wanbetaler → nieuw arrangement. De
type-keuze **Toezegging (betaalafspraak)** staat vooraan en is de nieuwe
standaardkeuze — het is het lichtste type en in de praktijk het meest gebruikte.
Het formulier vraagt:

* welke facturen (aanvinken, zoals bij de andere types);
* **klant betaalt op** — een concrete datum, verplicht;
* **bedrag** in euro's, optioneel. Leeg laten betekent "het hele openstaande
  bedrag";
* toelichting (het bestaande rationale-veld).

Het bevestigingsscherm zegt in gewone taal wat er gebeurt: de aanmaningen
stoppen direct en blijven stil tot die datum, waarna het systeem zelf kijkt of
er betaald is.

**Zichtbaarheid**, zodat niemand zich afvraagt waarom een klant stil is:

* in de overzichtslijst staat onder de klantnaam `🤝 Toezegging tot 21 sep 26`
  in plaats van het generieke "⏸ Dunning gepauzeerd";
* in de kop van het dossier een badge `🤝 Toezegging tot …`;
* bovenaan het dossier een eigen kaart met de datum, het bedrag, hoeveel dagen
  het nog duurt, en één alinea die uitlegt wat er op die dag vanzelf gebeurt.
  Is de datum verstreken, dan kleurt de kaart amber en zegt hij dat de
  breach-check het overneemt.

Alle drie lezen uit de arrangements die de module toch al ophaalt — geen extra
API-call.

## Vertaling naar de server

De wizard vraagt één datum en één bedrag; de server verwacht
`details.parts: [{ due_date, amount_cents? }]`. De omzetting gebeurt bij het
versturen: euro's → centen, één part, `invoice_id` leeg. Een part zonder
`invoice_id` geldt voor álle aangevinkte facturen — precies wat "betaalt alles
op datum X" betekent.

Twee controles zitten alleen in de wizard, niet op de server: een datum in het
verleden wordt geweigerd (de breach-check zou hem de volgende ochtend meteen
op `VERBROKEN` zetten), en een bedrag moet groter dan nul zijn of leeg blijven.

## Wat NIET is aangeraakt

De bestaande knop **🤝 Betaalafspraak** onderin het dossier, die alleen een
regel in het logboek schrijft (`dunning-pipeline-add-log`) en niets pauzeert.
Die staat er nog precies zoals hij was. Dat de twee knoppen nu naast elkaar
bestaan en verschillend werken is een bewuste tussenstand — daar wordt later
over beslist.

## Tests

`tests/toezegging-arrangement.test.js` (12) legt het spoor vast waar de knop op
leunt: direct `ACTIEF`, geen `pending_actions`, pauze-hook precies één keer,
weigering zonder datum of zonder facturen, en de breach-evaluatie (stil vóór de
dag, stil óp de dag, `NAGEKOMEN` bij betaling, `VERBROKEN` erna).
