-- Leadsonderhoud stap 4 — de sjabloontabel met de mailteksten.
--
-- Draai dit één keer in de Supabase SQL-editor. Hierna leest de motor de teksten
-- hieruit (niet uit de code), zodat ze aanpasbaar zijn zonder uitrol.
--
-- Sleutel: (traject_slug, soort). De score-grenzen maken varianten mogelijk —
-- de 7-daagse heeft bijvoorbeeld twee 'verlopen'-mails, één voor wie iets deed
-- (score >= 8) en één voor wie er niet aan toekwam (score < 8). De motor kiest
-- op basis van de warmtescore.
--
-- Variabelen in de tekst tussen accolades: {voornaam}, {inloglink}, {agendalink},
-- {lessen}, {trades}, {datum}, {tijd}. Die vult de verzendcode straks in.

create table if not exists public.onderhoud_sjablonen (
  id            uuid primary key default gen_random_uuid(),
  traject_slug  text not null,
  soort         text not null,
  kanaal        text not null check (kanaal in ('mail','whatsapp')),
  onderwerp     text,                       -- e-mail-onderwerp (leeg bij whatsapp)
  tekst         text not null,              -- de body, met {variabelen}
  meta_template text,                       -- bij whatsapp: naam van het Meta-sjabloon
  score_min     int,                        -- ondergrens warmtescore (null = geen)
  score_max     int,                        -- bovengrens, exclusief (null = geen)
  actief        boolean not null default true,
  aangemaakt    timestamptz not null default now(),
  bijgewerkt    timestamptz not null default now()
);

-- Eén sjabloon per (traject, soort, score-variant).
create unique index if not exists onderhoud_sjablonen_uniek
  on public.onderhoud_sjablonen (traject_slug, soort, coalesce(score_min, -1), coalesce(score_max, 99999));

-- ── De zes mailteksten van de 7-daagse ────────────────────────────────────
-- Dollar-quoting ($t$ … $t$) zodat apostrofs in de tekst geen probleem zijn.

insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, onderwerp, tekst)
values
('7-daagse', 'toelating', 'mail', 'Je bent toegelaten, hier is je toegang', $t$Hoi {voornaam},

Je bent toegelaten tot de 7-daagse. Vanaf nu heb je zeven dagen volledige toegang tot onze leeromgeving.

Klik op de knop hieronder en je bent binnen. Je hoeft geen wachtwoord in te vullen.

[ OPEN MIJN LEEROMGEVING ]   ← {inloglink}

Deze link is een uur geldig en werkt één keer. Ben je te laat, vraag dan gewoon een nieuwe aan op deforexopleiding.nl/lms.

Drie dingen voor je eerste dag:

1. Kijk Market Structure, twintig minuten. Dat is de basis waar de rest op rust.
2. Join onze Discord. Daar staan de links naar de live sessies.
3. Leg één trade vast in je journaal, ook een oude of een demo-trade.

Aan het eind van je week nemen we samen door wat je hebt gedaan. Twintig minuten via Zoom, vrijblijvend.

Vragen? Stel ze in Discord of mail terug op deze mail.

De Forex Opleiding$t$),

('7-daagse', 'afwijzing', 'mail', 'Over je aanmelding voor de 7-daagse', $t$Hoi {voornaam},

Bedankt voor je aanmelding. We hebben je antwoorden gelezen en gaan je deze keer niet toelaten.

Dat is geen oordeel over jou. Wij nemen niet iedereen aan, omdat begeleiding alleen werkt als het moment klopt. Op basis van wat je hebt ingevuld denken we dat dat nu nog niet zo is.

Verandert je situatie, dan mag je je opnieuw aanmelden. Dat kan gewoon via deforexopleiding.nl.

Wil je in de tussentijd al iets doen: onze events zijn gratis en daar kun je zonder verplichting kennismaken met hoe we werken. Je vindt ze op deforexopleiding.nl/events.

Succes.

De Forex Opleiding$t$),

('7-daagse', 'uitnodiging-gesprek', 'mail', 'Zullen we je week samen doornemen?', $t$Hoi {voornaam},

Je week zit er over twee dagen op. Voordat het zover is: laten we samen doornemen wat je hebt gedaan.

Twintig minuten via Zoom, op een moment dat jou uitkomt. We kijken naar je trades, je vragen en waar je nu staat. En of het traject bij je past. Past het niet, dan zeggen we dat gewoon; we willen niemand overhalen.

[ PLAN JE MOMENT ]   ← {agendalink}

Kun je deze week niet, plan het dan alsnog verderop. Je toegang loopt af maar je gegevens blijven bewaard, dus als je later instapt begin je niet opnieuw.

Tot dan.

De Forex Opleiding$t$),

('7-daagse', 'verlopen', 'mail', 'Mooie week, {voornaam}', $t$Hoi {voornaam},

Je zeven dagen zijn voorbij. Je hebt er echt iets mee gedaan: {lessen} lessen bekeken en {trades} trades vastgelegd.

Dat maakt een gesprek ook zinvol. We kunnen je journaal erbij pakken en kijken waar je staat, in plaats van in het algemeen te praten over wat er mogelijk is.

[ PLAN EEN GESPREK ]   ← {agendalink}

Twintig minuten via Zoom. Past het traject niet bij je, dan zeggen we dat.

Je gegevens blijven bewaard. Stap je later in, dan begin je niet opnieuw.

De Forex Opleiding$t$),

('7-daagse', 'verlopen', 'mail', 'Je week is voorbij, en dat is geen probleem', $t$Hoi {voornaam},

Je zeven dagen zijn voorbij, en je bent er niet echt aan toegekomen. Dat gebeurt: het is een drukke week, of het moment klopte niet.

Liever een goede week dan een halve. Wil je het opnieuw proberen wanneer het je beter uitkomt, laat het weten en we zetten je toegang opnieuw open.

Heb je een vraag zonder dat je ergens voor wilt gaan zitten, mail dan gewoon terug op deze mail. Dat mag ook.

De Forex Opleiding$t$),

('7-daagse', 'gesprek-bevestiging', 'mail', 'Je gesprek staat: {datum} om {tijd}', $t$Hoi {voornaam},

Je gesprek staat ingepland op {datum} om {tijd}. Reken op twintig minuten.

We doen het via Zoom, de link staat in de agenda-uitnodiging. Je hoeft niets voor te bereiden, maar twee dingen helpen:

- Zorg dat je trades in je journaal staan, ook de trades die misgingen. Juist die zijn interessant.
- Schrijf op waar je vastloopt of wat je niet snapt.

Komt het niet uit, dan kun je het verzetten via de link in de agenda-uitnodiging.

Tot dan.

De Forex Opleiding$t$);

-- De twee 'verlopen'-varianten op score zetten: warm (>= 8) en koud (< 8).
update public.onderhoud_sjablonen set score_min = 8
  where traject_slug = '7-daagse' and soort = 'verlopen' and onderwerp = 'Mooie week, {voornaam}';
update public.onderhoud_sjablonen set score_max = 8
  where traject_slug = '7-daagse' and soort = 'verlopen' and onderwerp = 'Je week is voorbij, en dat is geen probleem';

-- De live-schakelaar: standaard uit (droogloop). De motor leest deze rij; de
-- UI-schuif in het Instellingen-scherm zet 'm op 'true' of 'false'.
insert into public.app_settings (key, value)
values ('leadsonderhoud_live', 'false')
on conflict (key) do nothing;
