-- 2026-07-17 — joost_config.arrangement_mandate.min_termijn_bedrag_eur
-- gedeprecateerd: vervangen door dynamische per-klant ondergrens (#788).
--
-- Achtergrond:
--   #787 introduceerde een VASTE min_termijn_bedrag_eur (EUR 300) als
--   ondergrens voor SPLITSING. In productie bleek dat te grof:
--     * membership-klant EUR 80/mnd + EUR 240 open → geblokkeerd
--       (elke termijn zou < 300 zijn), terwijl 3x EUR 80 juist z'n
--       eigen betaal-ritme is en Jeffrey dat expliciet wil toestaan.
--     * 1-op-1 begeleiding EUR 300/mnd + EUR 250 open → 1-termijn
--       is per definitie geen splitsing; escalatie is correcte route.
--
-- Beleid Jeffrey (#788): de ondergrens per termijn = het MAANDBEDRAG van
-- die klant (laagste actieve abonnement, incl BTW, per maand). Klanten
-- zonder actief abo → SPLITSING verboden, Joost escaleert.
--
-- Berekening zit in api/_lib/customer-monthly-payment.js. Wordt gelezen
-- door api/_lib/joost-suggest-core.js (prompt-hint) én
-- api/arrangements-propose.js (harde server-check bij SPLITSING).
--
-- Voor de config: zet min_termijn_bedrag_eur op null. De code negeert 't
-- veld sinds #788 sowieso; expliciet null-zetten voorkomt dat een
-- toekomstige lezer er per ongeluk op vertrouwt. Vierde dode config
-- vermeden.

BEGIN;

UPDATE public.joost_config
SET autonomy_config = jsonb_set(
      COALESCE(autonomy_config, '{}'::jsonb),
      '{arrangement_mandate,min_termijn_bedrag_eur}',
      'null'::jsonb,
      true
    ),
    updated_at = now()
WHERE module = 'finance';

DO $$
DECLARE
  v_val jsonb;
BEGIN
  SELECT autonomy_config->'arrangement_mandate'->'min_termijn_bedrag_eur'
    INTO v_val
    FROM public.joost_config
    WHERE module = 'finance';
  RAISE NOTICE '[2026-07-17-joost-min-termijn-vervangen-door-abo] finance.arrangement_mandate.min_termijn_bedrag_eur = % (verwacht: null; ondergrens is dynamisch per klant)', v_val;
END $$;

COMMIT;
