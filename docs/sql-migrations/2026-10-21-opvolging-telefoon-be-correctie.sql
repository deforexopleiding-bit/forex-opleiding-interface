-- 2026-10-21 · opvolging_taken: Belgische gsm-nummers die als +31 terugkwamen uit GHL
--
-- KLAARGEZET, NIET UITGEVOERD. Draaien door Maxim, statement per statement,
-- in de Supabase SQL-editor (elk statement draait daar in een eigen transactie;
-- daarom geen temp-tabellen en geen DO-blokken).
--
-- WAT ER MIS WAS
--   GHL vulde ooit een lokaal '04…' aan met zijn standaardland NL (+314…) en
--   houdt dat contactnummer vast. De appointment-poll schreef het bij elke ronde
--   terug in follow_up_appointments.lead_phone, en de opvolg-crons maakten er
--   taken mee. De codefix (zelfde PR) laat de poll het nummer bevestigen tegen
--   onze eigen leaddata. Deze SQL zet ALLEEN de bestaande taken recht.
--
-- WELKE RIJEN (gemeten 21 okt): 17 taken met +314[5-9]…; 14 daarvan zijn
--   ONDUBBELZINNIG Belgisch: precies één lead, die lead heeft telefoon_e164 =
--   +32 + dezelfde negen cijfers, én zijn ruwe invoer is 04[5-9]…, +324…,
--   00324… of 4[5-9]… zonder 0. NIET in deze correctie:
--     a6708d05, d65bcacc  taak +3147979884 (cijfer te kort), lead +32479791884:
--                         ander nummer, dus geen zekerheid
--     834da3a9 (open, lead_bellen 13/10)  de lead zelf heeft +31475452053
--                         (+31 475 = ook een geldig NL-vastnummer, Roermond)
--
-- Elke rij wordt alleen aangepast als het nummer NOG STEEDS exact de oude
-- waarde is. Niets anders aan de rij verandert.

-- ── 0 · Controle vooraf (alleen lezen) — verwacht 14 rijen, kolom klopt = true
SELECT t.id, t.status, t.telefoon AS nu, v.nieuw, (t.telefoon = v.oud) AS klopt
FROM public.opvolging_taken t
JOIN (VALUES
  ('2b4a623a-aa39-4bd9-adb5-dc06ee9ec880'::uuid, '+31471693030', '+32471693030'),
  ('1b9d1d26-0514-4b47-b457-c59d58585555'::uuid, '+31465808688', '+32465808688'),
  ('fe1cbff4-8a65-4aae-bba0-4d4b9051d8cf'::uuid, '+31465893669', '+32465893669'),
  ('8d2293d2-cac6-470b-b4db-542d903de83b'::uuid, '+31473352693', '+32473352693'),
  ('c6575595-22c6-4ffb-b7b0-3dc1b5b6f242'::uuid, '+31470085329', '+32470085329'),
  ('975d26c2-3cde-4f05-add4-9dab8913dfd6'::uuid, '+31465808688', '+32465808688'),
  ('33dcc394-b9ad-4552-b46d-c3630917dedf'::uuid, '+31473352693', '+32473352693'),
  ('c26cf135-a46d-4967-9411-b0ae65e5d974'::uuid, '+31465705330', '+32465705330'),
  ('e5f66021-8f6f-42c0-ac43-ca06ddaadca8'::uuid, '+31465705330', '+32465705330'),
  ('d277a575-c3ca-419d-99dc-d7877728cf4d'::uuid, '+31472223752', '+32472223752'),
  ('3e1d16f4-d21f-45de-958f-49d00c68d03e'::uuid, '+31475716706', '+32475716706'),
  ('119621dc-b4a2-478f-bfac-96f641b1181a'::uuid, '+31475716706', '+32475716706'),
  ('fb75c6d0-6806-4ecf-9ad3-ef986511f8f3'::uuid, '+31493359937', '+32493359937'),
  ('1c710213-82fc-4e7e-9d33-b5d36f68acd7'::uuid, '+31472223752', '+32472223752')
) AS v(id, oud, nieuw) ON v.id = t.id
ORDER BY t.created_at;

-- ── 1 · Correctie — verwacht "14 rows" (minder = iemand paste het intussen aan; dan blijft die rij staan)
UPDATE public.opvolging_taken t
SET telefoon = v.nieuw, updated_at = now()
FROM (VALUES
  ('2b4a623a-aa39-4bd9-adb5-dc06ee9ec880'::uuid, '+31471693030', '+32471693030'),
  ('1b9d1d26-0514-4b47-b457-c59d58585555'::uuid, '+31465808688', '+32465808688'),
  ('fe1cbff4-8a65-4aae-bba0-4d4b9051d8cf'::uuid, '+31465893669', '+32465893669'),
  ('8d2293d2-cac6-470b-b4db-542d903de83b'::uuid, '+31473352693', '+32473352693'),
  ('c6575595-22c6-4ffb-b7b0-3dc1b5b6f242'::uuid, '+31470085329', '+32470085329'),
  ('975d26c2-3cde-4f05-add4-9dab8913dfd6'::uuid, '+31465808688', '+32465808688'),
  ('33dcc394-b9ad-4552-b46d-c3630917dedf'::uuid, '+31473352693', '+32473352693'),
  ('c26cf135-a46d-4967-9411-b0ae65e5d974'::uuid, '+31465705330', '+32465705330'),
  ('e5f66021-8f6f-42c0-ac43-ca06ddaadca8'::uuid, '+31465705330', '+32465705330'),
  ('d277a575-c3ca-419d-99dc-d7877728cf4d'::uuid, '+31472223752', '+32472223752'),
  ('3e1d16f4-d21f-45de-958f-49d00c68d03e'::uuid, '+31475716706', '+32475716706'),
  ('119621dc-b4a2-478f-bfac-96f641b1181a'::uuid, '+31475716706', '+32475716706'),
  ('fb75c6d0-6806-4ecf-9ad3-ef986511f8f3'::uuid, '+31493359937', '+32493359937'),
  ('1c710213-82fc-4e7e-9d33-b5d36f68acd7'::uuid, '+31472223752', '+32472223752')
) AS v(id, oud, nieuw)
WHERE t.id = v.id AND t.telefoon = v.oud
RETURNING t.id, t.telefoon;

-- ── 2 · Controle achteraf (alleen lezen) — verwacht nog precies 3 rijen:
--        a6708d05, d65bcacc (+3147979884) en 834da3a9 (+31475452053)
SELECT left(id::text, 8) AS taak, status, telefoon
FROM public.opvolging_taken
WHERE telefoon ~ '^\+314[5-9]'
ORDER BY created_at;

-- ── OPTIONEEL · follow_up_appointments.lead_phone (29 rijen met +314[5-9]…)
-- Na de codefix zet de poll komende afspraken zelf recht zodra de lead +32
-- bevestigt. Oudere afspraken worden niet meer gepolld. Wil je die ook
-- rechtzetten, kijk dan eerst wat dit voorstelt (alleen lezen):
--
-- SELECT a.id, a.scheduled_at::date, a.lead_phone, l.telefoon_e164 AS lead
-- FROM public.follow_up_appointments a
-- JOIN public.leads l ON lower(l.email) = lower(a.lead_email)
-- WHERE a.lead_phone ~ '^\+314[5-9][0-9]{7}$'
--   AND l.telefoon_e164 = '+32' || substring(a.lead_phone from 4)
--   AND (SELECT count(*) FROM public.leads l2 WHERE lower(l2.email) = lower(a.lead_email)) = 1;
