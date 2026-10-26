# Trial-opvolging — WhatsApp-templates (in te dienen bij Meta)

De opvolgmotor van elke trial-lead (`api/cron-lab-opvolging.js`) stuurt WhatsApp
**enkel** via een door Meta goedgekeurd template op de leadsonderhoud-lijn. Zolang
een template niet goedgekeurd is, slaat de motor WhatsApp over (gelogd in
`lab_opvolging` met `status='overgeslagen'`, `detail='niet_goedgekeurd'` of
`'geen_template'`) en gaat de mail wel.

Koppeling: `onderhoud_sjablonen` met `traject_slug='the-lab'`, `kanaal='whatsapp'`,
`soort` = de stap, `meta_template` = de naam hieronder, `variabele_volgorde` =
`{voornaam, loginlink}`. De migratie `2026-10-26-trial-opvolging-wa-sjablonen.sql`
zet die rijen klaar; aanpassen kan in **Leadsonderhoud › Templates › Trial-opvolging**.

Taal: **nl (Dutch)** · Categorie: **Marketing** — zo ingediend op 26 okt 2026 (WABA De Forex
Opleiding). Status toen: `trial_welkom`, `trial_niet_ingelogd_48u`, `trial_uitnodiging_sessie`
goedgekeurd; `trial_laatste_dag`, `trial_verlopen` in controle.

**Meta laat geen variabele op het einde van de body toe.** Daarom eindigt elk template met
een vaste afsluitregel ná `{{2}}` (in de tabel na de witregel). Die regel is gewone tekst,
geen parameter: de motor stuurt per bericht precies twee parameters mee, in de volgorde van
`variabele_volgorde` (`voornaam`, `loginlink`) — zie `waVariabelenVolgens()` in
`api/_lib/lab-berichten.js`. De kolom `onderhoud_sjablonen.tekst` bevat dezelfde volledige
tekst (ter info in Templates › Trial-opvolging).
Variabelen: `{{1}}` = voornaam, `{{2}}` = persoonlijke loginlink (lms.deforexopleiding.nl/the-lab/start/?s=…).

| Stap | Template | Tekst |
|---|---|---|
| Dag 0 · welkom (alleen zonder WhatsApp-gate, bv. webinar en The Lab) | `trial_welkom` | Hey {{1}}! 👋 Je toegang staat klaar: 7 dagen in de leeromgeving van De Forex Opleiding. Begin met de eerste video en plaats daarna je eerste (simulatie)trade in The Lab. Log in met één klik: {{2}}<br><br>Veel succes, het team van De Forex Opleiding |
| +48u niet ingelogd | `trial_niet_ingelogd_48u` | Hey {{1}}, je toegang loopt maar 7 dagen en je bent nog niet ingelogd. Zet er vanavond tien minuten voor opzij — één klik en je zit erin: {{2}}<br><br>Tot zo, het team van De Forex Opleiding |
| Uitnodiging strategiesessie | `trial_uitnodiging_sessie` | Hey {{1}}, sterk bezig! Tijd om het concreet te maken: plan je strategiesessie van 30 minuten met ons team (t.w.v. €100, voor jou gratis). Kies je moment: {{2}}<br><br>Tot binnenkort, het team van De Forex Opleiding |
| Laatste dag | `trial_laatste_dag` | Hey {{1}}, vandaag is je laatste dag toegang. Twijfel je nog? Plan je gratis strategiesessie — 30 minuten, zonder verplichtingen. Je gaat buiten met een plan: {{2}}<br><br>Het team van De Forex Opleiding |
| Verlopen | `trial_verlopen` | Hey {{1}}, je 7 dagen zitten erop. Wil je verder? Plan een sessie met ons team, dan bekijken we samen wat er voor jou mogelijk is: {{2}}<br><br>Het team van De Forex Opleiding |

Mails (alle stappen) staan als standaardtekst in `api/_lib/lab-opvolging.js`
(`standaardMail`) en zijn per stap te overschrijven in Leadsonderhoud › Templates ›
Trial-opvolging.
