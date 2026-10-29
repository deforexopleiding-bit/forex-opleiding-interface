-- 2026-10-29 · Jeffrey's meldingsnummer (eindigt op 655270212) uit de lead-flow.
--
-- Waarom: het nummer stond als lead/toegangsaanvraag in de opvolgflows en kreeg
-- daar marketingtemplates ("stuur ja terug voor je toegang"). Meta begrenst
-- marketing per ontvanger; toen die grens bereikt was, hield Meta ook de
-- lead-melding tegen. De code weigert vanaf nu elk niet-intern template naar dit
-- nummer (api/_lib/wa-intern.js); deze SQL ruimt de rijen op die nog openstaan.
--
--   1. open toegangsaanvragen (status 'wachtend') → 'vervallen' (geen reminders meer)
--   2. lead-rijen met dit nummer → wa_nu_niet_op (massa-WhatsApp slaat ze over)
--
-- Eén statement: de editor toont meteen wat er veranderd is. Herhaalbaar (doet
-- de tweede keer niets). Niets wordt verwijderd.
WITH toegang AS (
  UPDATE public.toegang_aanvragen
  SET status = 'vervallen', vervallen_at = now()
  WHERE status = 'wachtend'
    AND regexp_replace(coalesce(telefoon, ''), '\D', '', 'g') LIKE '%655270212'
  RETURNING 'toegang_aanvraag → vervallen'::text AS wat, id::text AS id,
            coalesce(email, '')::text AS detail, created_at AS sinds
), lead AS (
  UPDATE public.leads
  SET wa_nu_niet_op = now()
  WHERE wa_nu_niet_op IS NULL
    AND regexp_replace(coalesce(telefoon_e164, ''), '\D', '', 'g') LIKE '%655270212'
  RETURNING 'lead → geen massa-WhatsApp'::text AS wat, id::text AS id,
            ('bron=' || coalesce(bron, '?') || ' · ' || coalesce(email, ''))::text AS detail, aangemaakt AS sinds
)
SELECT * FROM toegang
UNION ALL
SELECT * FROM lead
ORDER BY sinds;
