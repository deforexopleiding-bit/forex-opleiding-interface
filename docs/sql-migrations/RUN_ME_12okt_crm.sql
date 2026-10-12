-- ============================================================================
--  RUN_ME_12okt_crm.sql — de CRM-stap van G2 (incasso-kaarten aanvullen)
-- ============================================================================
--  Op het CRM (forex-command-center), in de Supabase SQL-editor. ALLEEN LEZEN:
--  er wordt niets gewijzigd, niets verstuurd.
--
--  Waarom: wie vóór 7 okt naar incasso-opvolging ging, heeft in het LMS geen
--  incasso-kaart en staat dus niet in Daves tab Incasso (gemeten 9 okt: 5).
--  De onboardings staan hier in het CRM, de kaarten in het LMS — geen enkele
--  query ziet beide. Daarom bouwt deze query de regel SQL voor het LMS.
--
--  Volgorde:
--    1. Op dfo-lms: supabase/RUN_ME_12okt.sql (dfo-lms-prototype) — die zet de
--       functie hlms_incasso_kaarten_aanvullen klaar.
--    2. HIER: deze query draaien. Je krijgt één rij:
--         aantal_klanten  — verwacht 5 -
--         plak_dit_op_dfo_lms — één regel SQL.
--    3. Die regel kopiëren, op dfo-lms plakken, Run. Verwacht: nieuwe_kaarten = 5
--       (de eerste keer - daarna 0 — er komt nooit een tweede kaart per klant).
--    4. Op dfo-lms de EINDCONTROLE van RUN_ME_12okt.sql nog eens: nu staat ook
--       "G2 incasso-kaarten" op ok.
--
--  Testonboardings (is_test) en wie al terug actief is, tellen niet mee.
-- ============================================================================

with rijen as (
  select count(*) as n,
         coalesce(jsonb_agg(jsonb_build_object(
           'onboarding_id', o.id,
           'student_id', o.dfo_lms_student_id,
           'naam', o.customer_name,
           'reden', o.incasso_reden,
           'door', o.incasso_door,
           'op', o.incasso_op) order by o.incasso_op), '[]'::jsonb) as j
  from public.onboardings o
  where o.incasso_op is not null
    and (o.incasso_terug_op is null or o.incasso_terug_op < o.incasso_op)
    and coalesce(o.is_test, false) = false
)
select n as aantal_klanten,
       'select public.hlms_incasso_kaarten_aanvullen(' || quote_literal(j::text) || '::jsonb) as nieuwe_kaarten' || chr(59)
         as plak_dit_op_dfo_lms
from rijen
