# Bouwopdracht — Contentmachine (wekelijkse drop vanuit het CRM)

Opgesteld door Claude (Cowork) op 23 okt 2026 in opdracht van Maxim. Werk volledig autonoom in logische PR's: bouwen, testen, mergen bij groene checks, na de merge nameten, dan door naar de volgende fase. Raakt één fase geblokkeerd (bv. een ontbrekende API-sleutel), bouw alles eromheen alsof het er al is, zet het achter een duidelijke "nog niet gekoppeld"-melding en ga verder. Meld elke afwijking van deze opdracht met de reden.

## 1. Wat Maxim wil (zijn woorden, samengevat)

Eén module in het CRM waarmee hij elke week met **één druk op de knop** een volledige "drop" maakt:

- **Input**, telkens anders:
  - een Vimeo-link van een live training of teamtraining (optioneel: er is niet elke week een video);
  - "wat is er deze week gebeurd": payouts, een trade die genomen werd, een les, een moment uit de community;
  - foto's/screenshots die hij erin gooit (payouts, trades, charts, teamfoto's);
  - beelden uit een vaste **beeldbibliotheek** (masterclass-slides, payout-screenshots, teamfoto's).
- **Output**, allemaal in één keer gegenereerd, in de huisstijl van training.deforexopleiding.nl:
  1. de **webpagina** van de drop (wat nu training.deforexopleiding.nl is, maar dan vanuit het CRM);
  2. de **wekelijkse nieuwsbrief**: mooi ontworpen, elke week anders en interessant, creatief met het materiaal, met triggers, een tip van de week, enz.;
  3. **Instagram-stories** (1080x1920);
  4. een **Instagram-post** (carrousel 1080x1350 + caption) en vierkant 1080x1080;
  5. een **LinkedIn-post** (tekst + beeld).
- ~~De nieuwsbrief gaat niet meer via GoHighLevel.~~ **Gewijzigd 23 okt (Maxim): de nieuwsbrief gaat via GoHighLevel**, dat al aan het CRM gekoppeld is. GHL blijft de bron van de lijst (~6.000 adressen) en de uitschrijvingen. Maxim kijkt alles na en drukt zelf op versturen. Claude/automatisaties versturen nooit zelf.
- Het moet **uniek** zijn elke week: andere invalshoek, ander format, andere hooks, ander beeld.

## 2. Wat er al staat (niet opnieuw bouwen)

- **dfo-website** (Next.js): training-funnel `/training/<dd-mm-jj>` + `training.deforexopleiding.nl` via middleware; `lib/trainingen.ts` (één blok per week), `lib/training-lead.ts`, `app/api/training-sessie` (cadeau: gratis strategiesessie met Dave, t.w.v. €100 nu €0, boeking via de CRM-agenda met `booking_source = training-<dd-mm-jj>`), funnel-events incl. `cadeau_getoond`, `cadeau_klik`, `sessie_ingepland`, Meta CAPI, Google Sheet-webapp. Zie `docs/training-funnel.md`.
- **CRM** (forex-opleiding-interface): module **Trainingdrops** (Groei → Trainingdrops) met bezoekers, leads, conversie, kanalen, cadeau-klikken, calls; bron-label "Live training dd/mm/jj"; Dave als eigenaar bij `training-*`-afspraken.
- **Supabase** forex-command-center: `leads`, `funnel_events` (variant-CHECK laat `training-dd-mm-jj` toe), `follow_up_appointments`, `opstartsessie_submissions`.
- GHL-koppeling in het CRM (lijst van ~6.000 nieuwsbriefcontacten zit daar).

## 3. Architectuur (beslist — volg dit)

### 3.1 Databank (forex-command-center) — enkel additief
Nieuwe tabellen, RLS zoals de andere CRM-tabellen (lezen/schrijven voor de rollen die Leads/Trainingdrops zien; publieke `anon`-lees enkel op gepubliceerde drops voor de website):

- `content_drops`: `id uuid`, `slug text unique` (`dd-mm-jj`, of `dd-mm-jj-2` bij een tweede drop die dag), `soort text` (`training` | `update`), `status text` (`concept` | `gegenereerd` | `goedgekeurd` | `gepubliceerd` | `gearchiveerd`), `input jsonb` (vimeo_url, vimeo_id, vimeo_hash, start_sec, duur, wat_gebeurde, trade_info, notities, gekozen_asset_ids, kanalen), `output jsonb` (zie 3.3), `format_key text`, `versie int`, `aangemaakt_door`, `aangemaakt_op`, `gegenereerd_op`, `gepubliceerd_op`.
- `content_assets`: `id`, `drop_id uuid null` (null = bibliotheek), `soort` (`payout` | `trade` | `chart` | `masterclass` | `team` | `community` | `overig`), `storage_path`, `publieke_url`, `breedte`, `hoogte`, `bijschrift`, `ai_beschrijving` (door AI uit het beeld gehaald), `persoon_naam`, `toestemming_publiek bool` (studentresultaten enkel met toestemming; Shani, Leslie, Karl en Luc hebben toestemming), `tags text[]`, `laatst_gebruikt_op`.
- ~~`nieuwsbrief_abonnees`~~ — **vervallen (23 okt)**: GHL blijft de bron van de lijst en de uitschrijvingen; er komt geen eigen abonnees-tabel.
- `nieuwsbrief_verzendingen`: `id`, `drop_id`, `provider` (`ghl`), `campagne_id`, `template_id`, `onderwerp`, `status` (`concept` | `test_verstuurd` | `ingepland` | `verstuurd`), `test_verstuurd_op`, `ingepland_op`, `verstuurd_op`, `stats jsonb` (opens, kliks … enkel als de GHL-API ze geeft).
- (uitvoering) `content_drop_versies`: elke opgeslagen wijziging van een drop (versie, reden, input, output) — de historiek achter "elke wijziging bewaart een nieuwe versie".
- Supabase Storage-bucket `content` (publiek lezen) voor assets en gerenderde beelden (`drops/<slug>/…`, `bibliotheek/…`).

Migraties: zet ze in `docs/sql-migrations/` en **draai ze zelf** in forex-command-center (Maxim gaf toestemming voor veilige, additieve, backwards-compatibele wijzigingen), met een controle vóór en na. Niets droppen, niets bestaands wijzigen.

### 3.2 CRM-module "Contentmachine" (Groei → Contentmachine, boven Trainingdrops)
Zelfde stijl als de rest van het CRM (vanilla JS, `*-v2.js`, app-shell, permissions).

**Scherm 1 — Overzicht:** alle drops, nieuwste bovenaan, met status-pill, soort, format, en per drop de cijfers uit Trainingdrops (bezoekers, leads, calls) + nieuwsbriefstats. Knop **"Nieuwe drop"**.

**Scherm 2 — Nieuwe drop (de invoer, zo kort mogelijk):**
- Datum (standaard vandaag) → slug.
- Vimeo-link (optioneel). Als ingevuld: soort = `training`, haal id/hash/duur/titel/thumbnail op via Vimeo oEmbed; veld "start op (mm:ss)".
- "Wat is er deze week gebeurd?" — één groot vrij tekstveld (Maxim typt of plakt; spraak-naar-tekst mag).
- Optioneel: "Trade van de week" (paar, richting, korte uitleg, resultaat in R).
- Foto's slepen (meerdere): upload naar Storage, AI beschrijft elk beeld (wat staat erop: payout-bedrag, firma, paar, setup), Maxim kan bijschrift/persoon/toestemming aanpassen.
- Bibliotheek-kiezer: rooster van bibliotheekbeelden, filter op soort; de generator kiest er zelf ook bij als Maxim niets kiest (minst recent gebruikt eerst).
- Kanalen-vinkjes: Pagina · Nieuwsbrief · Stories · Instagram-post · LinkedIn (standaard alles aan).
- Grote knop **"Genereer alles"**.

**Scherm 3 — Drop-werkblad (na genereren):** tabbladen **Pagina · Nieuwsbrief · Stories · Post · LinkedIn**. Per tabblad: live voorbeeld, elk tekstveld bewerkbaar, knop "Opnieuw genereren" voor alleen dat onderdeel (met optionele instructie, bv. "korter", "meer spanning"), en per beeld "ander beeld kiezen". Bovenaan: **Goedkeuren**, **Publiceer pagina**, **Download alle beelden (zip)**, **Kopieer teksten**. Elke wijziging bewaart een nieuwe `versie`.

**Scherm 4 — Bibliotheek:** beelden opladen, taggen, toestemming beheren. Seed (23 okt): de 19 masterclass-beelden uit `docs/contentmachine/bibliotheek-seed/` staan ook in `img/contentmachine/bibliotheek-seed/` (mee in de deploy) en worden met de knop **"Masterclass-beelden laden"** in de Bibliotheek eenmalig opgeladen naar `content/bibliotheek/seed/` met soort, persoon (uit de bestandsnaam) en toestemming voor Shani, Leslie, Karl, Luc en Maxim. Idempotent. (Rechtstreeks opladen vanuit de bouwcontainer kon niet: daar is geen service-key.)

### 3.3 De generator (het hart) — server-route `POST /api/contentmachine/genereer`
- Model: de Anthropic-API die het CRM al gebruikt (Iris / AI Agents); hergebruik dezelfde env-sleutel en client. Gebruik vision voor de beelden (stuur de geüploade beelden mee).
- Eén aanroep levert **strikte JSON** volgens een schema (valideer; bij fout één keer herstellen):
  ```
  output = {
    format_key, kernidee,                           // de rode draad van deze week in één zin
    pagina:   { hero_kicker, hero_titel, hero_accent, lead, frustraties[3], kaarten[{label,titel,tekst}], paren[], quote, formulier_titel, formulier_sub, ontgrendeld_tekst, og_titel },
    nieuwsbrief: { onderwerpen[3] (A/B-varianten), preheader, blokken[ {type, ...} ], ps },
    stories:  [ {rol:'hook'|'inhoud'|'bewijs'|'cta', kicker, titel, tekst, beeld_asset_id?, sticker:'link'|'poll'|'vraag'|'quiz', sticker_tekst} ] (3–5),
    post:     { slides:[ {titel, tekst, beeld_asset_id?} ] (5–7), caption, hashtags[] },
    vierkant: { titel, sub, beeld_asset_id? },
    linkedin: { tekst, beeld:'vierkant'|'slide1' }
  }
  ```
- **Nieuwsbrief-blokken** (de generator kiest en ordent ze per format): `opener` (persoonlijke aanhef in Maxims stem), `video` (thumbnail met play-knop + knop naar de pagina), `chart` (beeld + uitleg), `trade_ontleed` (stap-voor-stap volgens de DFO-volgorde), `quiz` ("Wat zou jij doen?" — antwoord pas op de pagina = trigger om te klikken), `payout` (bewijs met naam, enkel bij toestemming), `tip_van_de_week`, `mythe` (een veelgemaakte fout ontkracht), `vooruitblik` (waar we volgende week naar kijken), `cijfers` (één opvallend getal groot), `cadeau` (gratis strategiesessie met Dave, t.w.v. €100, nu €0), `ps`.
- **Formats** (roteer; nooit hetzelfde als een van de vorige 3 drops — geef de laatste 6 drops met format, onderwerpen en hooks mee in de prompt):
  1. *De trade ontleed* — één trade van H4-context tot target.
  2. *Wat zou jij doen?* — chart-quiz, antwoord op de pagina.
  3. *Achter de schermen* — wat er deze week in de community/live gebeurde.
  4. *Het bewijs* — payout(s) centraal, met het verhaal en de stappen erachter.
  5. *De fout van de week* — een veelgemaakte fout die we live zagen, en hoe het wel moet.
  6. *Eén regel, diep* — één regel uit het tradeplan grondig uitgelegd (bv. waarom 71% enkel locatie is).
  7. *Vooruitblik* — de markt voor volgende week (DXY, sleutelparen), zonder voorspellingen als zekerheid.
  8. *Vraag van een student* — een echte vraag uit de training, beantwoord.
  Kies het format dat het best past bij de input van deze week, binnen de rotatieregel.
- **Triggers die elke editie bevat** (subtiel, niet schreeuwerig): nieuwsgierigheid (een open lus die pas op de pagina sluit), bewijs (een concreet getal, chart of resultaat), schaarste die waar is (de opname/het cadeau is er "deze week"), en één duidelijke volgende stap.
- **Strategie-kennis**: zet `docs/dfo-strategie-kennis.md` in de repo (inhoud: zie bijlage A) en geef die mee als systeemkennis. Tips en uitleg mogen enkel daaruit komen. Onbekend = niet verzinnen.
- **Stem en grenzen** (hard, in de systeemprompt én een test op de output):
  - Vlaams/Nederlands, direct, rustig zelfvertrouwen, "we/wij"; geen sprekersnamen behalve "Dave" bij het cadeau en Maxim als afzender van de nieuwsbrief.
  - Geen beloftes over snel rijk worden, geen "gegarandeerd", "makkelijk geld", "passief inkomen", geen winstclaims zonder bewijs.
  - Geen verkooppraat of woorden als "verkoop", "deal", "korting", "laatste kans!!!". Benoem wat er feitelijk gebeurt. Het cadeau mag: "t.w.v. €100, nu €0".
  - Disclaimer onderaan (educatief, geen financieel advies, risico op verlies).
  - Studentnamen enkel bij `toestemming_publiek = true`.
- **Uniciteit**: naast de rotatie vergelijkt de generator de nieuwe onderwerpregels en hooks met de vorige 6 (eenvoudige tekstgelijkenis) en hergenereert dat onderdeel als het te sterk lijkt.

### 3.4 Rendering
- **Nieuwsbrief-HTML** (server, `api/_lib/nieuwsbrief-render.js`): 600px tabel-layout, inline CSS, werkt in Gmail/Outlook/Apple Mail, donker navy (#0B1E2A, #112B3B) met goud (#D0A050), Inter met Arial-fallback — dezelfde look als training.deforexopleiding.nl (zie `docs/training-prototypes/22-10-26/index.html` en `mail/nieuwsbrief-lt-22-10-26.html` als referentie in dfo-website). Elk bloktype is een eigen render-functie. Beelden via de publieke Storage-URL's. Alle links met `utm_source=nieuwsbrief&utm_medium=email&utm_campaign=drop-<slug>&utm_content=<blok>` en `src=nieuwsbrief` (gewijzigd 23 okt: GHL i.p.v. Brevo). Uitschrijflink = de GHL-uitschrijf-merge-tag. Geanimeerde chart-GIF optioneel (mag later).
- **Social-beelden** (in de browser van het CRM): HTML-templates per formaat → PNG via html-to-image (of canvas), downloadbaar per stuk en als zip; daarnaast opgeslagen in Storage `drops/<slug>/social/…`. Formaten: stories 1080x1920 (3–5), carrousel 1080x1350 (5–7), vierkant 1080x1080, LinkedIn 1200x1200 (of hergebruik vierkant), OG-beeld 1200x630 voor de pagina. Templates: zelfde huisstijl als de bestaande creatives (Inter 900-koppen, goud accent, grid-achtergrond, chart-illustraties, foto's in een kader met afgeronde hoeken). Minstens 3 varianten per formaat zodat het niet elke week identiek oogt; de generator kiest.
- Story-linksticker: vak + URL `training.deforexopleiding.nl/<slug>?src=ig-story&utm_source=instagram&utm_medium=story&utm_campaign=drop-<slug>`; zo per kanaal (ig-bio, linkedin, whatsapp, meta-ad).

### 3.5 Website (dfo-website) — pagina's uit het CRM
- `/training/<slug>` en `training.deforexopleiding.nl/<slug>` lezen eerst een **gepubliceerde** `content_drops`-rij (server-side, revalidate 60s, enkel `status = 'gepubliceerd'`, via anon-select-policy of een server-key); valt terug op `lib/trainingen.ts`. `/` op het subdomein = nieuwste gepubliceerde drop.
- Soort `training`: zoals nu (formulier → video ontgrendelt → cadeau).
- Soort `update` (geen video): zelfde huisstijl; hero + verhaal van de week + beeldengalerij (payouts/trade) + "trade ontleed"-blok + formulier "Ontvang elke week onze marktanalyse" + cadeau. Het formulier maakt een lead met bron `drop-<slug>` en schrijft in op de nieuwsbrief.
- `funnel_events.variant`: breid het patroon uit naar `^(training|drop)-\d{2}-\d{2}-\d{2}(-\d)?$` (additieve migratie, superset).
- ~~Elke lead van een drop-pagina wordt ook `nieuwsbrief_abonnees`~~ — **gewijzigd 23 okt**: elke lead van een drop-pagina gaat als GHL-contact met de nieuwsbrief-tag naar GHL (fase 5).

### 3.6 Versturen — GoHighLevel (gewijzigd 23 okt; was Brevo)
- GEEN Brevo. De nieuwsbrief gaat via de bestaande GHL-koppeling van het CRM. GHL blijft de bron van de lijst en de uitschrijvingen.
- Route (beste wat de GHL-API toelaat — zie de uitwerking in fase 5): de gegenereerde nieuwsbrief-HTML als e-mailtemplate in GHL zetten en, als de API het toelaat, een bulk-/campagneverzending als **concept** klaarzetten naar de nieuwsbrieflijst/-tag. Kan bulk via de API niet: template in GHL + knop **"Open in GHL"** met een duidelijke stap. Maxim drukt zelf op versturen (in het CRM of in GHL). Nooit automatisch versturen.
- **Testmail** naar de ingelogde gebruiker via GHL.
- Nieuwe drop-leads gaan als contact met de nieuwsbrief-tag naar GHL (zelfde manier als de andere funnels, als die dat al doen).
- Stats (opens/kliks) uit GHL als de API ze geeft, anders weglaten en melden.

## 4. Fasering (elke fase = eigen PR('s), mergen bij groen, nameten)
1. **Databank + bibliotheek + invoer**: migraties (zelf draaien), Storage-bucket, module-skelet, scherm Nieuwe drop, upload + AI-beeldbeschrijving, bibliotheek.
2. **Generator + werkblad**: generator met formats/rotatie/kennis/grenzen, tabbladen met voorbeelden, bewerken, per onderdeel hergenereren, versies. Tests op het JSON-schema en op de verboden woorden.
3. **Social-rendering**: templates, PNG + zip, opslag in Storage.
4. **Website leest drops**: dfo-website-PR (aparte repo), soort `update`, patroon-migratie, inschrijving op nieuwsbrief. Bestaande training 22/10/26 blijft werken.
5. **Nieuwsbrief via GoHighLevel** (gewijzigd 23 okt, was Brevo + abonnees): template/campagne-concept in GHL, testmail via GHL, "Open in GHL", drop-leads met nieuwsbrief-tag naar GHL, stats als de API ze geeft.
6. **Eerste echte drop als demo**: maak een concept-drop met slug `22-10-26-demo` uit de bestaande training (Vimeo `https://player.vimeo.com/video/1238714790?h=4822ada5ee`, start 600s) en status `gegenereerd`, niet gepubliceerd, zodat Maxim het resultaat meteen ziet.

## 5. Randvoorwaarden
- CRM is live met echte klantgegevens: geen bestaande opslaglogica, rechten of tabellen wijzigen; alles nieuw en additief.
- Geen secrets aanmaken of wijzigen. Ontbrekende sleutels melden met exact de naam van de env-variabele.
- Lint/tests/build groen per PR. De bekende, losstaande webinar-test die al op main faalt mag blijven falen; meld het.
- Na elke merge: wat staat er live, in gewone taal, kort. Je container bereikt de productiesites niet; Claude (Cowork) meet na in de browser.

## Bijlage A — DFO-strategiekennis (voor `docs/dfo-strategie-kennis.md`)
- Kern: we voorspellen niet blind waar prijs draait. De hogere timeframe (H4) geeft richting en locatie; daarna wachten we tot liquidity en orderflow op de lagere timeframe (15M) bevestigen dat de markt opnieuw in onze richting wil.
- Daytrade-volgorde: H4 context → geldige impuls → H4 fibonacci/range → retracement → 15M context → liquidity → structure shift met volume → 15M fibonacci → entry → target. Een 15M-setup zonder geldige H4-context is geen DFO-trade.
- Geldige impuls: uit geldige structuur, structurele beweging, displacement/body close, en volume (= agressieve verplaatsing zichtbaar als FVG of Hidden FVG; niet de volume-indicator). Een wick-break is geen bevestigde impuls.
- Fibonacci-levels: 1, 0, 71% en -27. Het 71%-niveau is het centrale referentiepunt. H4 71% geraakt = enkel locatie, geen entry.
- Entry op de 71%-zone van de nieuwe 15M-impuls; stop waar de setup structureel ongeldig wordt (onder het 1-level); risk free bij het 0-level; target op -27 (≈ 3,4R).
- Swing/H4-limit: als op H4 alles aanwezig is, limit op H4 71, stop onder H4 1, risk free bij H4 0, target H4 -27. (Niet "swing" noemen naar buiten.)
- Order Block, FVG, Hidden FVG, liquidity en inducement zijn confluence binnen een geldige setup, nooit op zichzelf een reden om te traden.
- BOS = body close door vorige high/low. Sweep vs BOS onderscheiden via volume. Wick-only = geen BOS.
- Risk: 1% per trade-idee (mag 0,5% op het fib-niveau + 0,5% op de OB). Eerst bepalen waar de trade ongeldig is, dan pas positieomvang.
- Harde regels: geen nieuwe positie 1 uur vóór FOMC, CPI of NFP; geen nieuwe trades na 21:00; rollover 23:00–00:30 (spreads); daytrades vóór het weekend sluiten.
- Verboden simplificaties: "prijs raakt 71% dus we nemen een trade", "liquidity sweep dus we kopen", "er staat een OB dus setup", "een FVG komt sowieso terug", "structure break = automatisch entry".
- Drie bouwstenen van een trader: strategie, risk management, psychologie & uitvoering (discipline, geduld, routine, journaling, reflectie, data).
- Bij twijfel of ontbrekende regel: niet invullen met algemene ICT/SMC-regels.
