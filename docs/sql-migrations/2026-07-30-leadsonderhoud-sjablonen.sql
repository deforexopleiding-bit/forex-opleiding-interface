-- Leadsonderhoud stap 4 — de sjabloontabel met de teksten.
--
-- Draai dit één keer in de Supabase SQL-editor. Daarna leest de motor de teksten
-- hieruit (niet uit de code), zodat ze aanpasbaar zijn zonder uitrol.
--
-- Sleutel: (traject_slug, soort), met score-grenzen voor varianten (de 7-daagse
-- heeft twee 'verlopen'-mails: warm >= 8 en koud < 8; de motor kiest op score).
--
-- Elke mail heeft een HTML-versie (voor knop, logo, opmaak) én een platte versie
-- (voor mailprogramma's zonder HTML — scheelt spam-score). WhatsApp gebruikt geen
-- HTML: daar staat de tekst in 'tekst', de Meta-sjabloonnaam in 'meta_template'
-- en de volgorde van de variabelen in 'variabele_volgorde'.
--
-- Variabelen tussen accolades: {voornaam}, {inloglink}, {agendalink}, {lessen},
-- {trades}, {datum}, {tijd}, {dagen_over}. Eén invul-functie (api/_lib/
-- leadsonderhoud-sjabloon.js) vult ze voor beide kanalen in.

create table if not exists public.onderhoud_sjablonen (
  id                 uuid primary key default gen_random_uuid(),
  traject_slug       text not null,
  soort              text not null,
  kanaal             text not null check (kanaal in ('mail','whatsapp')),
  onderwerp          text,                 -- e-mail-onderwerp
  html               text,                 -- e-mail HTML-body
  tekst              text not null,        -- platte tekst (mail-fallback / whatsapp-body)
  meta_template      text,                 -- whatsapp: naam van het Meta-sjabloon
  variabele_volgorde text[],               -- whatsapp: volgorde van {{1}},{{2}},...
  score_min          int,                  -- ondergrens warmtescore (null = geen)
  score_max          int,                  -- bovengrens, exclusief (null = geen)
  actief             boolean not null default true,
  aangemaakt         timestamptz not null default now(),
  bijgewerkt         timestamptz not null default now()
);

create unique index if not exists onderhoud_sjablonen_uniek
  on public.onderhoud_sjablonen (traject_slug, soort, coalesce(score_min, -1), coalesce(score_max, 99999));

-- Kleine HTML-wrapper met logo + knop zit per mail in de $h$…$h$-body verwerkt.
-- Dollar-quoting zodat apostrofs en quotes in de tekst geen probleem zijn.

-- ── 1. Toelating (met inloglink-knop) ──────────────────────────────────────
insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, onderwerp, html, tekst) values
('7-daagse','toelating','mail','Je bent toegelaten, hier is je toegang',
$h$<div style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px">
<tr><td style="padding:28px 32px 4px"><img src="https://www.deforexopleiding.nl/img/merk/logo.png" alt="De Forex Opleiding" width="150" style="display:block;border:0"></td></tr>
<tr><td style="padding:8px 32px 28px;color:#1b2430;font-size:15px;line-height:1.6">
<p>Hoi {voornaam},</p>
<p>Je bent toegelaten tot de 7-daagse. Vanaf nu heb je zeven dagen volledige toegang tot onze leeromgeving.</p>
<p>Klik op de knop hieronder en je bent binnen. Je hoeft geen wachtwoord in te vullen.</p>
<p style="margin:22px 0"><a href="{inloglink}" style="display:inline-block;background:#5B5BD6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">Open mijn leeromgeving</a></p>
<p>Deze link is een uur geldig en werkt één keer. Ben je te laat, vraag dan gewoon een nieuwe aan op deforexopleiding.nl/lms.</p>
<p>Drie dingen voor je eerste dag:</p>
<ol><li>Kijk Market Structure, twintig minuten. Dat is de basis waar de rest op rust.</li>
<li>Join onze Discord. Daar staan de links naar de live sessies.</li>
<li>Leg één trade vast in je journaal, ook een oude of een demo-trade.</li></ol>
<p>Aan het eind van je week nemen we samen door wat je hebt gedaan. Twintig minuten via Zoom, vrijblijvend.</p>
<p>Vragen? Stel ze in Discord of mail terug op deze mail.</p>
<p>De Forex Opleiding</p>
</td></tr></table>
<p style="color:#8a97a5;font-size:12px;margin:16px 0 0">De Forex Opleiding · deforexopleiding.nl</p>
</td></tr></table></div>$h$,
$t$Hoi {voornaam},

Je bent toegelaten tot de 7-daagse. Vanaf nu heb je zeven dagen volledige toegang tot onze leeromgeving.

Open de leeromgeving via deze link (een uur geldig, werkt één keer): {inloglink}
Te laat? Vraag een nieuwe aan op deforexopleiding.nl/lms.

Drie dingen voor je eerste dag:
1. Kijk Market Structure, twintig minuten.
2. Join onze Discord.
3. Leg één trade vast in je journaal.

Aan het eind van je week nemen we samen door wat je hebt gedaan. Twintig minuten via Zoom.

De Forex Opleiding$t$);

-- ── 2. Afwijzing ───────────────────────────────────────────────────────────
insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, onderwerp, html, tekst) values
('7-daagse','afwijzing','mail','Over je aanmelding voor de 7-daagse',
$h$<div style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px">
<tr><td style="padding:28px 32px 4px"><img src="https://www.deforexopleiding.nl/img/merk/logo.png" alt="De Forex Opleiding" width="150" style="display:block;border:0"></td></tr>
<tr><td style="padding:8px 32px 28px;color:#1b2430;font-size:15px;line-height:1.6">
<p>Hoi {voornaam},</p>
<p>Bedankt voor je aanmelding. We hebben je antwoorden gelezen en gaan je deze keer niet toelaten.</p>
<p>Dat is geen oordeel over jou. Wij nemen niet iedereen aan, omdat begeleiding alleen werkt als het moment klopt. Op basis van wat je hebt ingevuld denken we dat dat nu nog niet zo is.</p>
<p>Verandert je situatie, dan mag je je opnieuw aanmelden via deforexopleiding.nl.</p>
<p>Wil je in de tussentijd al iets doen: onze events zijn gratis. Je vindt ze op deforexopleiding.nl/events.</p>
<p>Succes.</p>
<p>De Forex Opleiding</p>
</td></tr></table>
<p style="color:#8a97a5;font-size:12px;margin:16px 0 0">De Forex Opleiding · deforexopleiding.nl</p>
</td></tr></table></div>$h$,
$t$Hoi {voornaam},

Bedankt voor je aanmelding. We hebben je antwoorden gelezen en gaan je deze keer niet toelaten.

Dat is geen oordeel over jou. Wij nemen niet iedereen aan, omdat begeleiding alleen werkt als het moment klopt.

Verandert je situatie, dan mag je je opnieuw aanmelden via deforexopleiding.nl. Onze events zijn gratis: deforexopleiding.nl/events.

Succes.

De Forex Opleiding$t$);

-- ── 9. Uitnodiging gesprek (met agenda-knop) ───────────────────────────────
insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, onderwerp, html, tekst) values
('7-daagse','uitnodiging-gesprek','mail','Zullen we je week samen doornemen?',
$h$<div style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px">
<tr><td style="padding:28px 32px 4px"><img src="https://www.deforexopleiding.nl/img/merk/logo.png" alt="De Forex Opleiding" width="150" style="display:block;border:0"></td></tr>
<tr><td style="padding:8px 32px 28px;color:#1b2430;font-size:15px;line-height:1.6">
<p>Hoi {voornaam},</p>
<p>Je week zit er over twee dagen op. Voordat het zover is: laten we samen doornemen wat je hebt gedaan.</p>
<p>Twintig minuten via Zoom, op een moment dat jou uitkomt. We kijken naar je trades, je vragen en waar je nu staat. Past het traject niet, dan zeggen we dat gewoon; we willen niemand overhalen.</p>
<p style="margin:22px 0"><a href="{agendalink}" style="display:inline-block;background:#5B5BD6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">Plan je moment</a></p>
<p>Kun je deze week niet, plan het dan alsnog verderop. Je toegang loopt af maar je gegevens blijven bewaard, dus als je later instapt begin je niet opnieuw.</p>
<p>Tot dan.</p>
<p>De Forex Opleiding</p>
</td></tr></table>
<p style="color:#8a97a5;font-size:12px;margin:16px 0 0">De Forex Opleiding · deforexopleiding.nl</p>
</td></tr></table></div>$h$,
$t$Hoi {voornaam},

Je week zit er over twee dagen op. Voordat het zover is: laten we samen doornemen wat je hebt gedaan.

Twintig minuten via Zoom, op een moment dat jou uitkomt. Plan je moment: {agendalink}

Kun je deze week niet, plan het dan alsnog verderop. Je gegevens blijven bewaard.

Tot dan.

De Forex Opleiding$t$);

-- ── 11a. Verlopen — warm (score >= 8, met agenda-knop) ─────────────────────
insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, onderwerp, html, tekst, score_min) values
('7-daagse','verlopen','mail','Mooie week, {voornaam}',
$h$<div style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px">
<tr><td style="padding:28px 32px 4px"><img src="https://www.deforexopleiding.nl/img/merk/logo.png" alt="De Forex Opleiding" width="150" style="display:block;border:0"></td></tr>
<tr><td style="padding:8px 32px 28px;color:#1b2430;font-size:15px;line-height:1.6">
<p>Hoi {voornaam},</p>
<p>Je zeven dagen zijn voorbij. Je hebt er echt iets mee gedaan: {lessen} lessen bekeken en {trades} trades vastgelegd.</p>
<p>Dat maakt een gesprek ook zinvol. We kunnen je journaal erbij pakken en kijken waar je staat.</p>
<p style="margin:22px 0"><a href="{agendalink}" style="display:inline-block;background:#5B5BD6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">Plan een gesprek</a></p>
<p>Twintig minuten via Zoom. Past het traject niet bij je, dan zeggen we dat. Je gegevens blijven bewaard.</p>
<p>De Forex Opleiding</p>
</td></tr></table>
<p style="color:#8a97a5;font-size:12px;margin:16px 0 0">De Forex Opleiding · deforexopleiding.nl</p>
</td></tr></table></div>$h$,
$t$Hoi {voornaam},

Je zeven dagen zijn voorbij. Je hebt er echt iets mee gedaan: {lessen} lessen bekeken en {trades} trades vastgelegd.

Dat maakt een gesprek ook zinvol. Plan een gesprek: {agendalink}

Twintig minuten via Zoom. Je gegevens blijven bewaard.

De Forex Opleiding$t$, 8);

-- ── 11b. Verlopen — koud (score < 8) ──────────────────────────────────────
insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, onderwerp, html, tekst, score_max) values
('7-daagse','verlopen','mail','Je week is voorbij, en dat is geen probleem',
$h$<div style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px">
<tr><td style="padding:28px 32px 4px"><img src="https://www.deforexopleiding.nl/img/merk/logo.png" alt="De Forex Opleiding" width="150" style="display:block;border:0"></td></tr>
<tr><td style="padding:8px 32px 28px;color:#1b2430;font-size:15px;line-height:1.6">
<p>Hoi {voornaam},</p>
<p>Je zeven dagen zijn voorbij, en je bent er niet echt aan toegekomen. Dat gebeurt: het is een drukke week, of het moment klopte niet.</p>
<p>Liever een goede week dan een halve. Wil je het opnieuw proberen wanneer het je beter uitkomt, laat het weten en we zetten je toegang opnieuw open.</p>
<p>Heb je een vraag zonder dat je ergens voor wilt gaan zitten, mail dan gewoon terug op deze mail.</p>
<p>De Forex Opleiding</p>
</td></tr></table>
<p style="color:#8a97a5;font-size:12px;margin:16px 0 0">De Forex Opleiding · deforexopleiding.nl</p>
</td></tr></table></div>$h$,
$t$Hoi {voornaam},

Je zeven dagen zijn voorbij, en je bent er niet echt aan toegekomen. Dat gebeurt.

Wil je het opnieuw proberen wanneer het je beter uitkomt, laat het weten en we zetten je toegang opnieuw open.

Heb je een vraag, mail dan gewoon terug op deze mail.

De Forex Opleiding$t$, 8);

-- ── 12. Gesprek bevestigd ──────────────────────────────────────────────────
insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, onderwerp, html, tekst) values
('7-daagse','gesprek-bevestiging','mail','Je gesprek staat: {datum} om {tijd}',
$h$<div style="background:#f4f5f7;padding:24px 0;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px">
<tr><td style="padding:28px 32px 4px"><img src="https://www.deforexopleiding.nl/img/merk/logo.png" alt="De Forex Opleiding" width="150" style="display:block;border:0"></td></tr>
<tr><td style="padding:8px 32px 28px;color:#1b2430;font-size:15px;line-height:1.6">
<p>Hoi {voornaam},</p>
<p>Je gesprek staat ingepland op <strong>{datum} om {tijd}</strong>. Reken op twintig minuten.</p>
<p>We doen het via Zoom, de link staat in de agenda-uitnodiging. Twee dingen helpen:</p>
<ul><li>Zorg dat je trades in je journaal staan, ook de trades die misgingen.</li>
<li>Schrijf op waar je vastloopt of wat je niet snapt.</li></ul>
<p>Komt het niet uit, dan kun je het verzetten via de link in de agenda-uitnodiging.</p>
<p>Tot dan.</p>
<p>De Forex Opleiding</p>
</td></tr></table>
<p style="color:#8a97a5;font-size:12px;margin:16px 0 0">De Forex Opleiding · deforexopleiding.nl</p>
</td></tr></table></div>$h$,
$t$Hoi {voornaam},

Je gesprek staat ingepland op {datum} om {tijd}. Reken op twintig minuten.

We doen het via Zoom, de link staat in de agenda-uitnodiging. Twee dingen helpen:
- Zorg dat je trades in je journaal staan, ook de trades die misgingen.
- Schrijf op waar je vastloopt.

Komt het niet uit, dan kun je het verzetten via de link in de agenda-uitnodiging.

Tot dan.

De Forex Opleiding$t$);

-- ── WhatsApp-berichten (Esmee) — meta_template + variabelevolgorde ─────────
-- De teksten zijn geschreven met {{1}},{{2}},… zoals Meta ze wil. De motor
-- stuurt de variabelen in de volgorde van variabele_volgorde mee. De berichten
-- gaan pas live zodra het Meta-sjabloon is goedgekeurd (de motor slaat een niet-
-- goedgekeurd sjabloon zichtbaar over).
insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, tekst, meta_template, variabele_volgorde) values
('7-daagse','welkom','whatsapp',
$t$Hoi {{1}}, ik ben Esmee van De Forex Opleiding. Je toegang staat klaar en je hebt de inloglink per mail gekregen. Kom je er niet in, of heb je een vraag onderweg, dan mag je hier gewoon antwoorden. Ik help je deze week op weg 🙂$t$,
'welkom', array['voornaam']),

('7-daagse','niet-ingelogd','whatsapp',
$t$Hoi {{1}}, ik zie dat je nog niet in de leeromgeving bent geweest. Geen probleem, maar je week loopt wel. Je hebt nog {{2}} dagen. Is de inloglink verlopen? Vraag een nieuwe aan op deforexopleiding.nl/lms.$t$,
'niet_ingelogd', array['voornaam','dagen_over']),

('7-daagse','sessie-donderdag','whatsapp',
$t$Hoi {{1}}, vanavond om 19:00 is de live sessie. We lopen de week door op de charts en je kunt alles vragen wat je tegenkwam. Meekijken mag ook. De Zoom-link zetten we kort voor aanvang in Discord.$t$,
'sessie_donderdag', array['voornaam']),

('7-daagse','sessie-zondag','whatsapp',
$t$Goedemorgen {{1}}, om 10:00 doen we de weekvooruitblik. We kijken naar wat we deze week in de gaten houden en waarom. De Zoom-link staat kort vooraf in Discord.$t$,
'sessie_zondag', array['voornaam']),

('7-daagse','halverwege-warm','whatsapp',
$t$Hoi {{1}}, je bent goed op weg. Ik zie {{2}} lessen bekeken en {{3}} trades in je journaal. Dat maakt het gesprek aan het eind van je week ook een stuk nuttiger. Je hebt nog {{4}} dagen. Als je één ding doet, wees dan bij een live sessie.$t$,
'halverwege_warm', array['voornaam','lessen','trades','dagen_over']),

('7-daagse','halverwege-koud','whatsapp',
$t$Hoi {{1}}, je bent wel binnen geweest maar er nog niet echt aan toegekomen. Dat gebeurt. Toch even vragen: loopt er iets vast, of is het gewoon tijd? Je hebt nog {{2}} dagen. Wil je een zetje, laat het me hier weten.$t$,
'halverwege_koud', array['voornaam','dagen_over']),

('7-daagse','laatste-dag','whatsapp',
$t$Hoi {{1}}, morgen loopt je toegang af. Heb je meer tijd nodig, dan kun je eenmalig drie dagen verlengen. Dat doe je zelf in de leeromgeving. En als je het gesprek nog niet hebt ingepland: dat kan ook na je week.$t$,
'laatste_dag', array['voornaam']),

('7-daagse','gesprek-herinnering','whatsapp',
$t$Hoi {{1}}, vandaag om {{2}} hebben we ons gesprek. Twintig minuten via Zoom, de link staat in je agenda. Neem je journaal er even bij. Komt het niet uit? Laat het me hier weten, dan zetten we het om.$t$,
'gesprek_herinnering', array['voornaam','tijd']);

-- Live-schakelaar PER OMGEVING: standaard uit (droogloop). Zo zet je live op de
-- preview niet per ongeluk productie aan. De motor leest de sleutel van de
-- omgeving waarin hij draait; de UI-schuif zet 'm op 'true' of 'false'.
insert into public.app_settings (key, value) values
  ('leadsonderhoud_live_production', 'false'),
  ('leadsonderhoud_live_preview', 'false')
on conflict (key) do nothing;
