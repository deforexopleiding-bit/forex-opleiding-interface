-- PROJECT: forex-command-center (nsjnsvlmdhunzqkdvagm)
--
-- ⚠⚠⚠ NIET DRAAIEN ⚠⚠⚠  (beslissing Cowork/Maxim, 26 okt 2026)
--
-- Wat het zou doen: lms_gebruikers.lead_id vullen voor de ±220 oude trials
-- waar hij sinds ~5 okt leeg bleef.
--
-- Waarom NIET: zodra lead_id gevuld is, ziet de view trial_warmte plots gsm
-- en toestemming voor ±220 LOPENDE oude trials. trial_wachtrij kan dan in
-- één keer een golf "niet-ingelogd" / "laatste-dag" / "verlopen"-WhatsApps
-- en -mails sturen die naar het OUDE LMS (www.deforexopleiding.nl/lms)
-- verwijzen — precies wat "Eén login voor alle funnels" wil vermijden.
-- De nieuwe flow (lab-leads in het echte LMS) geeft lead_id gewoon mee; de
-- oude trials laten we leeglopen zoals ze zijn.
--
-- Bewaard enkel als documentatie van de afweging.

/*
update public.lms_gebruikers g
   set lead_id = l.id
  from (
    select lower(email) as em, (array_agg(id))[1] as id
      from public.leads
     where verwijderd_op is null and email is not null
     group by lower(email)
    having count(*) = 1
  ) l
 where g.lead_id is null
   and lower(g.email) = l.em;
*/
