-- WhatsApp-verantwoordelijke als instelling
-- Datum: 27 augustus 2026
--
-- WAAROM
-- Na de tweede vergeefse belpoging op een event-lead zet de belmotor
-- automatisch een taak klaar in Takenbeheer: "stuur deze persoon een
-- WhatsApp". Die taak moet aan iemand toegewezen worden.
--
-- Die iemand is nu Dave Heylen, maar hij staat NIET in de code. Dat zou
-- breken zodra hij op vakantie is of vertrekt, en dan zoekt niemand het in
-- een bestand. Het is één rij in app_settings, te wijzigen zonder deploy.
--
-- GEEN SCHEMA-WIJZIGING. app_settings bestaat al (zie
-- migrations/034_dunning_pipeline_foundation.sql en 036_wanbetalers_sandbox.sql,
-- die dezelfde vorm gebruiken: key text, value jsonb). Deze migratie zet er
-- één rij in met een lege waarde.
--
-- Idempotent: draait hij twee keer, dan blijft een al ingevulde waarde staan.
--
-- ── DRAAIEN ────────────────────────────────────────────────────────────────
-- Nog NIET gedraaid. Twee stappen in de Supabase SQL-editor.
--
-- STAP 1 — de rij aanmaken (het blok hieronder).
--
-- STAP 2 — de verantwoordelijke invullen. Zoek eerst het id op:
--
--   select id, full_name, email, role
--     from public.profiles
--    where full_name ilike '%dave%'
--    order by full_name;
--
-- En zet het dan:
--
--   update public.app_settings
--      set value = jsonb_build_object('user_id', '<het-uuid-uit-stap-2>')
--    where key = 'whatsapp_verantwoordelijke';
--
-- CONTROLE — hoort één rij te geven met een gevulde user_id:
--
--   select s.value->>'user_id' as user_id, p.full_name
--     from public.app_settings s
--     left join public.profiles p on p.id = (s.value->>'user_id')::uuid
--    where s.key = 'whatsapp_verantwoordelijke';
--
-- ZOLANG STAP 2 NIET GEBEURD IS wordt er GEEN taak aangemaakt en komt er een
-- waarschuwing in de Vercel-log ("geen verantwoordelijke ingesteld"). De
-- belcadans zelf blijft gewoon werken. Dat is bewust: een taak zonder
-- eigenaar helpt niemand, en stil in het niets aanmaken is erger dan niets.
--
-- ALTERNATIEF ZONDER DATABASE: de omgevingsvariabele
-- WHATSAPP_VERANTWOORDELIJKE_ID in Vercel doet hetzelfde. app_settings gaat
-- vóór; de env-variabele is de terugval.
--
-- TERUGDRAAIEN:
--   delete from public.app_settings where key = 'whatsapp_verantwoordelijke';
-- ───────────────────────────────────────────────────────────────────────────

insert into public.app_settings (key, value)
select 'whatsapp_verantwoordelijke', jsonb_build_object('user_id', null)
where not exists (
  select 1 from public.app_settings where key = 'whatsapp_verantwoordelijke'
);

notify pgrst, 'reload schema';
