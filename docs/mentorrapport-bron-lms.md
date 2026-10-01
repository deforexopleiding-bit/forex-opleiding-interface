# Mentorrapport — coaching uit het LMS (sinds oktober 2026)

Mentoren > Rapporten (`modules/klanten-v2/views/mentoren-v2.js`) bouwt per mentor
per maand een payout-concept via `api/_lib/payout-generate-core.js`. Het
coaching-deel komt uit `computeCoachingEarnings()` in
`api/_lib/coaching-earnings.js`. Dezelfde helper voedt de Coaching-tab van de
mentor (`api/mentor-coaching-earnings.js`) en de debugknop in het rapport
(`api/mentor-coaching-debug.js`, blok `lms`) — de mentor ziet dus exact wat er
in het rapport staat.

## Bron

| Bron | Wanneer | Wat |
|---|---|---|
| **LMS** (dfo-lms, `api/_lib/dfo-lms-db.js`) | altijd | `hlms_sessie` + `hlms_teamtraining` |
| **Bubble** | alleen het deel van het venster vóór `BUBBLE_EINDE = 2026-10-01` | `1-1-session` + `team-training` (oude regels) |

Vanaf oktober 2026 wordt Bubble niet meer bevraagd.

## Regels

**Venster** — `[from 00:00 Europe/Brussels, (to+1) 00:00 Europe/Brussels)`,
DST-correct. Een sessie op 30/9 23:30 lokale tijd hoort bij september, 1/10
00:30 bij oktober. Geldt voor beide bronnen.

**LMS 1-op-1** — `hlms_sessie` met `mentor_id = mentorUserId` (= `profiles.id`
= `team_members.user_id` = `mentor_payouts.mentor_user_id`):
- `afgerond` → €35, `no_show` → €25. `gepland` / `geannuleerd` tellen niet.
- Attributie op de mentor van de **sessie** (wie de call deed), niet de huidige
  mentor van de student. Geen leertype-filter.
- Een gekoppeld duo is één sessierij = één vergoeding.
- **Exacte dubbels** (zelfde `student_id` + `start_tijd` + mentor) tellen één
  keer → `_meta.lms_exacte_dubbels`. Opeenvolgende sessies op dezelfde dag met
  een andere starttijd tellen wél (bewuste businessregel).

**LMS teamtraining** — `hlms_teamtraining_trainer.personeel_id = mentorUserId`,
start in venster, `status = 'gegeven'` → €50. Bestaat de kolom `status` nog niet
(migratie `supabase/hlms_teamtraining_status.sql` in het LMS-repo nog niet
gedraaid; fout 42703) → teamtraining LMS = 0 met
`_meta.lms_teamtraining = 'stand-kolom-ontbreekt'`. Elke andere fout = onbereikbaar.

**Bubble** (ongewijzigde regels) — `Created By` = mentor, `Alpha Program`,
`isdone`, call vereist `member_user`, no-show telt ook zonder `member_user`;
teamtraining via `tutor_user` op `completeddate`. Een Bubble-sessie telt
**niet** als dezelfde student (`member_user` ↔ `hlms_student.bubble_user_id`)
op dezelfde Brusselse kalenderdag een afgeronde of no-show sessie in het LMS
heeft, bij welke mentor ook → `_meta.bubble_overgeslagen_dubbel_met_lms`.

**Funded** — `mentor_funded_certificates` (CRM), €100, ongewijzigd.

`bubble_user_id` is optioneel: zonder koppeling telt alleen het LMS.

## Overgangsmaand september 2026

Mentoren schakelden in de loop van september over (eerste LMS-sessie: Chesney
3/9, Seppe 4/9, Danny 6/9, Karl 13/9, Kjento 15/9). September telt daarom LMS
+ Bubble, met de ontdubbeling hierboven. `_meta.bronnen` toont per bron de
aantallen:

```json
{ "lms":    { "status": "gelezen", "afgerond": 71, "no_show": 15, "team": 0 },
  "bubble": { "status": "gelezen", "calls": 8, "no_show": 1, "team": 0 } }
```

`bubble.status`: `gelezen` · `niet-van-toepassing` (venster ligt na
`BUBBLE_EINDE`) · `geen-bubble-koppeling` (mentor zonder `bubble_user_id`).

## Faalgedrag

Een onbereikbare bron mag **nooit** stil als 0 in een rapport belanden.

- LMS niet geconfigureerd (`DFO_LMS_SUPABASE_URL/KEY`) → throw
  `LMS_NIET_GECONFIGUREERD`; onbereikbaar → throw `LMS_ONBEREIKBAAR`.
- Bubble nodig (venster vóór oktober) en onbereikbaar → throw.
- Funded-telling faalt → throw.
- `payout-generate-core` rekent coaching **vóór** elke schrijfactie en vangt
  de fout niet meer af: `mentor-payout-generate` meldt die mentor als fout
  (`mentors[].error`), het bestaande concept blijft ongemoeid. De UI toont dat
  per mentor in het resultaatpaneel.
- `mentor-coaching-earnings` → 502 met leesbare boodschap.
- Debugknop: een bronfout verschijnt als `lms.error`.

Tests: `tests/coaching-earnings-lms.test.js`.
