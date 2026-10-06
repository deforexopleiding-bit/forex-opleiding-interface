# Intake-pot — de CRM-kant (opdracht 5 oktober 2026)

De intake-pot zelf leeft in het LMS (`hlms_intake`, zie `docs/intake-pot.md` in
dfo-lms-prototype). Het CRM doet drie dingen:

1. **Vullen** — `api/_lib/onboarding-intake-spiegel.js`, aangeroepen vanuit
   `spiegelOnboarding()`. Schrijft alleen de CRM-kolommen (naam, telefoon uit
   `customers.phone`, traject, start, aangemeld, `crm_stand`, `student_id`).
   Nieuwe rijen alleen voor onboardings vanaf `INTAKE_POT_VANAF`
   (default 2026-10-06 00:00 Brussel); oudere zet de hoofdmentor er in het LMS
   met de hand in, en die worden daarna wél bijgewerkt. Faalzacht.
2. **Tonen** — `api/_lib/intake-gesprek-stand.js` via de sidecar
   `/api/onboarding-intake-status` (`gesprekken`, `gesprekken_status`):
   kolom **Intakegesprek** in het onboardingoverzicht, regel **Intakegesprek**
   in het detailscherm (met uitkomst en actieplan na afronden). Niet gelezen =
   "onbekend", nooit "niet in de pot".
3. **Verlonen** — `coaching-earnings.js` telt afgeronde intakes
   (`afgerond_door` = mentor, `afgerond_op` in het venster) als
   `breakdown.intake` à €8,75 (¼ × €35). Op de uitbetaling een eigen regel
   `coaching_intake`, label "Intakes: n × 0,25". Een intake is geen
   `hlms_sessie`: hij verbruikt geen sessie van het pakket en sluit de
   onboarding niet. Zolang `hlms_intake` niet bestaat: 0, met
   `_meta.lms_intake = 'tabel-ontbreekt'`.

"Intake" betekent in de bestaande CRM-code de START-STATUS
(`mentor_intake_status`). Het gesprek uit de pot heet op het scherm daarom
**Intakegesprek**.
