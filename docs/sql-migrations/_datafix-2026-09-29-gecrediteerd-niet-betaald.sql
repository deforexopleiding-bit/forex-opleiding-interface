-- docs/sql-migrations/_datafix-2026-09-29-gecrediteerd-niet-betaald.sql
--
-- DATAFIX — gecrediteerd ≠ betaald. Jeffrey draait dit HANDMATIG in de
-- Supabase SQL-editor, NA de deploy van de bron-fix (api/_lib/invoice-upsert.js
-- + creditnote-upsert.js). Draai je dit eerder, dan zet de uurlijkse
-- Teamleader-sync (oude code) deze facturen bij een volgende passage weer op
-- 'paid'.
--
-- ── WAT ER MIS WAS ────────────────────────────────────────────────────────
-- Teamleader verrekent een creditnota met de factuur (due = 0, paid = true).
-- De sync maakte daar status 'paid' + amount_paid = volledig bedrag van, terwijl
-- credited_amount óók het volledige bedrag was. Gemeten 29-09-2026: 282
-- facturen staan zo, samen ≈ € 146k "betaald" dat gecrediteerd is.
--
-- ── WAT DIT DOET ──────────────────────────────────────────────────────────
-- Volledig gecrediteerde facturen ZONDER geregistreerde betaling (geen rij in
-- payments) → status 'credited', amount_paid 0, paid_date leeg. Verwacht: 280.
--
-- UITGEZONDERD (rij in payments — handmatig beoordelen, NIET in deze update):
--   2026 / 1594  03ef53e6-d5c5-4d9a-8349-1367ac3d60be  Wilhelmina Schreurs
--                € 300, betaling € 0,01 (manual, 11-08), creditnota 2026 / 227 (20-08)
--   2026 / 1240  f29bf160-9384-4831-a271-82df96713b7e  "kajdladjfklajsdfklj" (testklant, jbaanbiedingen@)
--                € 605, betaling € 605 (manual, 30-06), creditnota 2026 / 148 (30-06)
-- Details: Documents/DFO-backups/credited-herstel-uitzonderingen-2026-09-29.json
--
-- ── ZICHTBAAR EFFECT ──────────────────────────────────────────────────────
--   * Factuurlijsten: status "Gecrediteerd" i.p.v. "Betaald"; geen "Betaald op".
--   * Finance "Betalingen deze maand": gecrediteerde bedragen tellen niet meer
--     mee (september: − € 28.388,74; eerdere maanden ook lager).
--   * Mentorbonus-overzicht / maandconcept: gecrediteerde termijnen tellen niet
--     meer als betaald (status "Gecrediteerd"). Al goedgekeurde of uitbetaalde
--     concepten veranderen NIET (die worden niet herberekend).
--   * Setter-forecast: gecrediteerde facturen verlagen de prognose niet meer.
--   * LMS: bij de volgende onboarding-spiegel (07:20 UTC) blijft/wordt
--     "eerste factuur betaald" = false bij studenten met alleen creditnota's
--     (6 van 36 gespiegelde onboardings — al zo sinds de hotfix).
--   * Sales-bonus: deze UPDATE vuurt GEEN hooks. De bron-fix doet dat wel bij de
--     volgende Teamleader-sync van zo'n factuur; gemeten raakt dat 1 bonus
--     (aanbetaling 2026 / 961, € 178,51, status earned → voided; niet uitbetaald,
--     dus geen terugvordering).
--
-- De Supabase SQL-editor draait elk statement los: hieronder alleen losse
-- SELECT/UPDATE-statements, geen temp-tabellen en geen DO-blokken.

-- 1) VOORAF: wat gaat er veranderen? (verwacht: aantal = 280)
SELECT count(*) AS aantal, round(sum(amount_paid)::numeric, 2) AS amount_paid_nu, round(sum(credited_amount)::numeric, 2) AS gecrediteerd
FROM invoices i
WHERE i.status = 'paid'
  AND i.credited_amount > 0
  AND i.credited_amount >= i.amount_total - 0.005
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id);

-- 2) De uitzonderingen (verwacht: de 2 hierboven, NIET aanpassen)
SELECT i.id, i.invoice_number, i.amount_total, i.amount_paid, i.credited_amount,
       (SELECT round(sum(p.amount)::numeric, 2) FROM payments p WHERE p.invoice_id = i.id) AS betalingen
FROM invoices i
WHERE i.status = 'paid'
  AND i.credited_amount > 0
  AND i.credited_amount >= i.amount_total - 0.005
  AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id);

-- 3) DE FIX
UPDATE invoices i
SET status = 'credited', amount_paid = 0, paid_date = NULL, updated_at = now()
WHERE i.status = 'paid'
  AND i.credited_amount > 0
  AND i.credited_amount >= i.amount_total - 0.005
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id);

-- 4) ACHTERAF: moet 0 zijn
SELECT count(*) AS nog_betaald_en_volledig_gecrediteerd_zonder_betaling
FROM invoices i
WHERE i.status = 'paid'
  AND i.credited_amount > 0
  AND i.credited_amount >= i.amount_total - 0.005
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id);

-- 5) ACHTERAF: overzicht
SELECT status, count(*) AS aantal, round(sum(amount_paid)::numeric, 2) AS amount_paid, round(sum(credited_amount)::numeric, 2) AS gecrediteerd
FROM invoices WHERE credited_amount > 0 GROUP BY status ORDER BY status;
