-- ============================================================================
-- Supportmodule — kennisbank-startset
-- Datum: 22 september 2026
-- Hoort bij: docs/sql-migrations/2026-09-22-support-module-fundament.sql
--
-- ── WAAROM APART ────────────────────────────────────────────────────────────
-- Het fundament is schema; dit is inhoud. Inhoud verandert vaker en wordt
-- daarna in de UI bijgehouden (Agents → Kennisbank), dus die twee horen niet
-- in één bestand. Dit bestand is ook veilig om over te slaan: zonder deze
-- rijen werkt de bot gewoon, hij weet alleen minder en escaleert vaker.
--
-- ── WAT HIER WEL EN NIET IN STAAT ───────────────────────────────────────────
-- Alleen dingen die vaststaan: wat er op de website staat, en processen die
-- uit de code volgen. Bewust GEEN prijzen, doorlooptijden of toezeggingen —
-- die veranderen, en een bot die een verouderd bedrag noemt kost meer dan een
-- bot die zegt dat een collega het erbij pakt.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Elke INSERT staat achter een NOT EXISTS op het onderwerp. Opnieuw draaien
-- voegt niets toe en overschrijft geen tekst die iemand later heeft
-- bijgewerkt.
-- ============================================================================

BEGIN;

INSERT INTO public.kennisbank_artikelen (onderwerp, categorie, content, agents)
SELECT v.onderwerp, v.categorie, v.content, ARRAY['support']::text[]
FROM (VALUES

-- ── LMS ────────────────────────────────────────────────────────────────────
('Inloggen op het LMS', 'Praktisch',
 E'Het LMS staat op lms.deforexopleiding.nl. Je logt in met het e-mailadres waarop je de uitnodiging hebt gekregen.\n\nLukt inloggen niet, dan is dat bijna altijd één van drie dingen:\n1. Je probeert het met een ander mailadres dan waarop de uitnodiging binnenkwam.\n2. De uitnodiging is nooit aangekomen (kijk ook in de spam).\n3. Er is technisch iets misgegaan bij het aanmaken van je account.\n\nDe derde kan ik zelf nakijken zodra je je mailadres hebt bevestigd.'),

('Uitnodiging voor het LMS niet ontvangen', 'Praktisch',
 E'De uitnodiging voor het LMS gaat per mail naar het adres dat bij je inschrijving hoort. Kijk eerst in je spam- of ongewenste-mailmap.\n\nStaat hij daar ook niet, dan zet ik een nieuwe uitnodiging klaar. Een collega keurt die goed en dan krijg je hem opnieuw. Let op: er kan maar één geldige uitnodiging tegelijk openstaan, dus gebruik daarna de nieuwste mail en niet een oudere.'),

('Traject afgelopen en toegang tot het LMS', 'Praktisch',
 E'De toegang tot het LMS loopt zolang je traject loopt. Is de einddatum gepasseerd, dan vervalt de toegang — dat is geen storing.\n\nWil je verlengen of weer instappen, dan kijkt een collega met je mee wat er mogelijk is.'),

-- ── Discord ────────────────────────────────────────────────────────────────
('Discord-uitnodiging', 'Praktisch',
 E'De persoonlijke uitnodiging voor de Discord-community krijg je per mail nadat je de onboarding hebt afgerond.\n\nHeb je hem niet gekregen of werkt de link niet meer, vraag het dan aan je mentor — die kan hem opnieuw sturen. Wij kunnen dat vanuit het systeem niet zelf; Discord staat los van onze andere systemen.'),

('Discord werkt niet', 'Praktisch',
 E'Kom je niet in de Discord-server of zie je bepaalde kanalen niet, dan gaat het vrijwel altijd om de uitnodiging of om je rol in de server. Beide regelt je mentor.\n\nWij kunnen aan Discord zelf niets aanpassen — er is geen koppeling tussen Discord en ons systeem. Ik zet je vraag door naar je mentor.'),

-- ── Traject ────────────────────────────────────────────────────────────────
('Mentorship en membership', 'Aanbod',
 E'Er zijn twee vormen:\n\n• Mentorship 1-op-1 — je hebt een vaste mentor die elke week met je meekijkt. Trajecten lopen van 6 tot 24 maanden.\n• Membership — je werkt zelfstandig door het materiaal heen, in je eigen tempo.\n\nDaarnaast zijn er live sessies in de avonden en weekenden.'),

('Wie is mijn mentor en wanneer is mijn volgende sessie', 'Praktisch',
 E'Je mentor en je geplande sessies staan in het LMS. Ik kan ze ook opzoeken zodra je je mailadres hebt bevestigd.\n\nMoet een sessie verzet worden, dan regel je dat met je mentor zelf — die kent je planning.'),

('Een sessie missen of verzetten', 'Praktisch',
 E'Kun je niet bij een geplande 1-op-1 sessie zijn, laat het je mentor dan zo vroeg mogelijk weten. Een sessie die je zonder afmelding laat lopen, telt als no-show.\n\nHet aantal sessies in je traject ligt vast; je mentor kijkt met je mee hoe je ze het beste inzet.'),

-- ── Financieel ─────────────────────────────────────────────────────────────
('Factuur niet kunnen betalen', 'Praktisch',
 E'Lukt het niet om een factuur op tijd te voldoen, zeg het dan liever te vroeg dan te laat — dan valt er meestal iets te regelen.\n\nIk kan geen betalingsafspraak toezeggen; dat beoordeelt een collega. Wat ik wel kan: je situatie vastleggen en het bij de juiste persoon neerleggen, zodat je niet nog een keer je verhaal hoeft te doen.'),

('Betalingsafspraak aanvragen', 'Praktisch',
 E'Een betalingsafspraak vraag je aan door te vertellen wat er speelt en wat voor jou haalbaar is. Een collega kijkt ernaar en laat weten wat kan.\n\nWat er zoal mogelijk is: uitstel, of een bedrag in termijnen. Wat in jouw geval kan, hangt af van je situatie — daar kan ik niet op vooruitlopen.\n\nBelangrijk: een afspraak geldt pas als een collega hem bevestigd heeft. Tot die tijd loopt de oorspronkelijke factuur gewoon door.'),

('Al betaald maar nog een herinnering gekregen', 'Praktisch',
 E'Betalingen worden niet altijd direct verwerkt, dus een herinnering kan elkaar met jouw betaling kruisen.\n\nGeef door wanneer en hoe je betaald hebt, dan laat ik een collega het nakijken. Betaal niet nog een keer voordat dat gebeurd is.'),

-- ── Voor wie nog geen klant is ─────────────────────────────────────────────
('Zeven dagen meekijken', 'Aanbod',
 E'Je kunt zeven dagen gratis meekijken om te zien hoe we werken. Je meldt je aan via de website; daarna krijg je toegang per mail.\n\nKomt die mail niet binnen, kijk dan eerst in je spam. Blijft het uit, geef het dan door — dan zet een collega het recht.'),

('Een gesprek inplannen', 'Praktisch',
 E'Een kennismakingsgesprek plan je zelf in via de agenda op de website. Je kiest daar een moment dat jou uitkomt.\n\nStaat er niets dat past, laat het dan weten — dan kijkt een collega mee.'),

('Events en masterclasses', 'Aanbod',
 E'Alle aankomende events en masterclasses staan op de eventpagina van de website. Daar staat per event de datum, de locatie en voor wie het bedoeld is, en daar schrijf je je ook in.\n\nEr zijn events voor beginners en events voor gevorderden; op de pagina staat welk niveau bij welk event hoort.'),

('Inschrijving voor een event wijzigen of annuleren', 'Praktisch',
 E'Wil je je inschrijving wijzigen of annuleren, geef dan door om welk event het gaat en op welke naam en welk mailadres je bent ingeschreven. Een collega regelt het en je krijgt een bevestiging per mail.\n\nWil je naar een ander event, zeg dat er dan meteen bij — dan wordt het in één keer omgezet.'),

-- ── Over ons ───────────────────────────────────────────────────────────────
('Contact en bereikbaarheid', 'Over ons',
 E'Je kunt ons bereiken op info@deforexopleiding.nl en op +31 85 130 83 62.\n\nHet kantoor staat aan de Deinsesteenweg 108 in Drongen (Gent) en is op afspraak te bezoeken.'),

('Geen antwoord op een eerdere mail', 'Praktisch',
 E'Heb je eerder gemaild en nog niets gehoord, geef dan door op welk mailadres en ongeveer wanneer je geschreven hebt. Dan zoekt een collega het op.\n\nHelpt meestal: kijk of het antwoord in je spam staat, vooral als je van een ander adres schrijft dan waarop je bij ons bekend staat.')

) AS v(onderwerp, categorie, content)
WHERE NOT EXISTS (
  SELECT 1 FROM public.kennisbank_artikelen k WHERE k.onderwerp = v.onderwerp
);

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK:
--   DELETE FROM public.kennisbank_artikelen WHERE agents = ARRAY['support']::text[];
-- ============================================================================
