# Trial-flow — de feiten uit de code (26 okt 2026)

Feitenblad voor de PDF "volledige flow" van Maxim. Alles hieronder komt uit de
code van de drie repo's (dfo-website, forex-opleiding-interface = CRM,
dfo-lms-prototype = LMS) en uit de productie-instellingen op 26 okt 2026. Waar
iets een instelling is en geen code, staat dat erbij.

Stand op 26 okt: de opvolgmotor staat AAN (`lab_opvolging_live = "true"`),
alle producten staan op `lab` in `trial_bestemming`.

---

## 1. Ingangen per funnel

| Funnel | URL-pad (dfo-website) | `bron` | Product (CRM) | Naar |
|---|---|---|---|---|
| Minicursus v9 | `/kennismakingscursus-v9` | `kennismakingscursus-v9` | minicursus | `/api/lead` → WhatsApp-gate |
| Minicursus v10 | `/kennismakingscursus-v10` | `kennismakingscursus-v10` | minicursus | `/api/lead` → WhatsApp-gate |
| 7-daagse v5 | `/7-daagse-v5` | `7-daagse-v5` | 7-daagse | `/api/lead` → WhatsApp-gate |
| 7-daagse v6 | `/7-daagse-v6` | `7-daagse-v6` | 7-daagse | `/api/lead` → WhatsApp-gate |
| Webinar v1 | `/webinar-v1` | `webinar-v1` | webinar | `/api/webinar-aanmelding` → CRM `/api/public-webinar-aanmelding` (géén gate) |
| Webinar v2 | `/webinar-v2` | `webinar-v2` | webinar | idem |
| The Lab v1 | `/the-lab-v1` → `/the-lab-v1/bedankt` | `the-lab-v1` | the-lab | CRM `/api/lab-aanmelding` (géén gate) |
| The Lab v2 | `/the-lab-v2` → `/the-lab-v2/bedankt` | `the-lab-v2` | the-lab | idem |
| The Lab site | `/the-lab` → `/the-lab/bedankt` | `the-lab-site` | the-lab | idem |
| Website | aanmeldvenster `components/Aanmelden.tsx` (overal op de site; de 7-daagse-knop buiten `/7-dagen-meekijken` stuurt daarheen) | geen → `/api/lead` vult `website` in | website | `/api/lead` (soort `7-daagse`) → WhatsApp-gate |

Verdeelpaden (A/B): `/go/mini-cursus` (v9/v10, terugval `/kennismakingscursus-v5`)
en `/go/7-daagse` (v5/v6, terugval `/7-daagse-v5`). Keuze per bezoeker blijft
90 dagen vast (cookie `dfo_split_<slug>`). De gewichten staan in de DB
(`funnel_splits`); geseed op 0 = iedereen naar de terugval tot iemand ze zet.

Product uit de bron (`api/_lib/trial-product.js` → `productUitBron`):
`kennismakingscursus-*` → minicursus · `7-daagse-*` → 7-daagse · `webinar-*` →
webinar · `the-lab`, `the-lab-v1/-v2/-site` → the-lab · `website` → website.
Variant = het staartje `-v<n>` of `-site`.

### Kwalificatie (wie wordt afgewezen)

- **Minicursus v9/v10**: de flow per bron komt uit `app_settings.opstartsessie_flow`
  (`per_funnel[bron]` → `default` → `A`; bij een fout ook A).
  - Flow A: live quiz (`/api/quiz/minicursus`) met punten + afwijzer-antwoorden; kan afwijzen.
  - Flow B: 5 vaste vragen; afwijzer = "Nee, ik zoek liever alleen gratis dingen" /
    "Werkzoekend / geen eigen inkomen op dit moment" / "Gewoon even benieuwd, verder niet".
  - Flow C: geen vragen, altijd toegang.
- **7-daagse v5/v6**: altijd Flow C (geen quiz, altijd toegang).
- **Website**: quiz (`/api/quiz/7-daagse`); kan afwijzen.
- **Webinar, The Lab**: geen quiz.

Afgewezen: scherm "Bedankt voor je eerlijkheid." + "Op basis van je antwoorden
denken we dat dit nu nog niet het juiste moment is. …". De lead wordt bewaard,
krijgt de sjabloonmail `afwijzing`, géén toegangsaanvraag, géén boeking.

### Wat de bevestigingspagina nu zegt

- **Minicursus, Flow A** (toegelaten): "✔ Toegelaten" / "Goed nieuws, <naam> — je bent
  toegelaten." → video, 3 ja-vragen, agenda voor een kennismakingsgesprek. Geboekt:
  "Je plek is actief! 🎉 Je kennismakingsgesprek staat gepland: <datum>". Overgeslagen:
  "Je toegang staat klaar, <naam>. Je kunt meteen beginnen met de kennismakingscursus."
- **Minicursus, Flow B**: "Gelukt — Je bent toegelaten 🎉 Check je WhatsApp en je mail:
  je login voor je persoonlijke leeromgeving, met de kennismakingscursus, komt eraan."
  + kaart "Jouw gratis persoonlijke trading-scan" (normaal 99 euro, nu gratis), knop
  "Plan mijn gratis gesprek + scan".
- **Minicursus, Flow C**: "Gelukt, je bent aangemeld" + "Wacht even, we hebben nog iets
  speciaals voor je" → kennismakingsgesprek plannen (met €50-no-show-vinkje).
- **7-daagse v5/v6**: "Gelukt <voornaam>, je zit erin! Check zo je WhatsApp en je mail:
  je login voor je persoonlijke leeromgeving komt eraan. Eén klik en je zit erin." +
  "Plan je gratis opstartsessie" (±20 min met een mentor). Geboekt: "Je opstartsessie
  staat gepland".
- **Webinar v1/v2**: "Je plek is gereserveerd!" (of "…was al gereserveerd!" /
  "…is verplaatst!") + datum + "De Zoom-link staat in je mail en WhatsApp." + knoppen
  "Zet in je agenda" / ".ics".
- **The Lab v1/v2**: "Gelukt — Je toegang staat klaar. Check je mailbox." + "We stuurden
  je persoonlijke login voor The Lab naar <e-mail>. Eén klik en je zit erin: inloggen of
  een wachtwoord kiezen hoeft niet." + cadeau "Eenmalig cadeau · t.w.v. €100 — gratis
  strategiesessie: 30 minuten via Zoom met iemand van ons team" + agenda "Kies je moment".
  Geboekt: "Je strategiesessie staat vast."
- **The Lab site** (`/the-lab/bedankt`): zelfde boodschap, eyebrow "Gelukt · The Lab".
- **Website**: zelfde schermen als minicursus Flow A, met "de 7 dagen gratis meekijken".

Let op: de minicursus- en 7-daagse-schermen bieden een **kennismakingsgesprek /
opstartsessie** aan (de bestaande opstartsessie-agenda), niet de strategiesessie met
Dave. De strategiesessie (§6) zit in de Lab-bedankpagina en in het LMS.

---

## 2. De WhatsApp-gate (`toegang_aanvragen`)

**Wie erdoor gaat**: minicursus, 7-daagse en website (alles wat via `/api/lead`
toegang krijgt; `soort` is altijd `minicursus` of `7-daagse`). Webinar en The Lab
gaan er NIET door.

Bij aanmaken: voornaam, e-mail en telefoon verplicht. Staat er al een wachtende
aanvraag met hetzelfde e-mailadres of dezelfde laatste 9 cijfers → 409 (geen tweede).

**Bevestigingsbericht** — 2 minuten na de aanvraag (cron `*/2`, dus in de praktijk
2–4 min), vanaf de leadlijn:

- `bevestig_toegang_a` (als er al een call geboekt is):
  "Hoi {{1}}! 🎉 Je aanvraag is binnen én je opstartsessie staat gepland voor {{2}}. We
  geven niet zomaar iedereen toegang, dus we willen even zeker weten dat jij het echt
  bent. Stuur je even een berichtje terug (een "ja" is al genoeg)? Dan zetten we je
  gratis toegang open en ontvang je direct je inloggegevens per e-mail. Tot snel!"
- `bevestig_toegang_b` (geen call geboekt):
  "Hoi {{1}}! 🎉 Je aanvraag is binnen. We geven niet zomaar iedereen toegang, dus we
  willen even zeker weten dat jij het echt bent. Stuur je even een berichtje terug (een
  "ja" is al genoeg)? Dan zetten we je gratis toegang open en ontvang je direct je
  inloggegevens per e-mail. Plan hieronder ook meteen je gratis opstartsessie 👇"
  + knop naar deforexopleiding.nl/agenda.

Tegelijk een mail: onderwerp **"Nog één stapje — check je WhatsApp ✅"** (zelfde
boodschap: een "ja" volstaat, + agendalink).

**Wat de lead moet doen**: één berichtje terugsturen. Elk antwoord telt:
- een antwoord óp een gate-bericht (WhatsApp-context) telt altijd;
- zonder context: binnen 72 u (`GATE_VENSTER_UUR`) na het laatste gate-bericht, en er
  mag intussen geen ander (niet-gate) template gestuurd zijn.

Na het antwoord (WhatsApp, vrije tekst):
"Top <naam>! ✅ Je inloggegevens zijn direct per mail naar je toegestuurd.

Nog een vraagje, ben je ook al bekend met traden of is dit volledig nieuw?"
→ dan provisioning (§3). Er volgt GEEN tweede WhatsApp-welkom: de welkomstmail is het
laatste bericht van dag 0.

**Herinneringen** (alleen WhatsApp, gerekend vanaf het bevestigingsbericht):

| Wanneer | Template | Tekst |
|---|---|---|
| +2 u | `reminder_toegang_2u` | "Hoi {{1}}, we wachten nog op je bevestiging! 😊 We willen alleen even zeker weten dat jij het echt bent — stuur je even een berichtje terug (een "ja" is genoeg)? Dan staan je inloggegevens zo in je mail." |
| +24 u | `reminder_toegang_24u` | "Hoi {{1}}, je gratis toegang staat nog voor je klaar — we hebben alleen nog je bevestiging nodig zodat we zeker weten dat jij het bent. Eén berichtje terug en we zetten 'm meteen voor je open. 🚀" |
| +48 u | `reminder_toegang_48u_v3` | "Hoi {{1}}, we hebben je aanvraag ontvangen maar nog geen bevestiging van je gezien. Stuur je even "ja" terug, dan ronden we je toegang af en krijg je je inloggegevens per e-mail. Liever niet meer? Laat het gerust weten, dan sluiten we het netjes af." |

**Vervallen**: 24 u na de 48u-herinnering (`VERVALLEN_UREN_NA_48U = 24`), dus ±72 u na
het bevestigingsbericht. Bij vervallen wordt er niets gestuurd.

**Nooit geantwoord**: geen account, geen login, geen opvolgmotor (die start pas bij een
lab-lead). Een antwoord ná het vervallen doet automatisch niets meer; enkel handmatig
"Geef toegang" in Leadsonderhoud. De lead blijft wel in `leads` staan.

Schakelaar van de gate zelf: env `TOEGANG_AANVRAGEN_LIVE`.

---

## 3. Provisioning (account in het LMS)

Eén instap voor elke funnel: `geefLabTrial()` (`api/_lib/lab-trial.js`) →
rij in `lab_aanmeldingen` (product, bron, variant, toegang_aanvraag_id, CRM-lead_id)
→ `verwerkLmsEnBerichten` → `zorgVoorLabAccount` (`api/_lib/dfo-lms-lab-account.js`).

Wanneer:
- gate-funnels: meteen na het "ja" (via `belProvisioning`);
- webinar: na de aanmelding, op de achtergrond (`waitUntil`), alleen bij een NIEUWE
  aanmelding (niet bij "al aangemeld" of "verplaatst");
- The Lab: meteen bij het formulier.

Wat er aangemaakt wordt (in dfo-lms):
1. **Auth-user** (Supabase Auth): e-mail bevestigd, metadata voornaam/achternaam,
   `herkomst: 'lab_lead'`. **Geen wachtwoord.**
2. **Rol** `trial` (`hlms_rol`).
3. **`hlms_lab_lead`**: `toegang_van` = nu, `toegang_tot` = nu + **7 dagen**
   (`LAB_TOEGANG_DAGEN = 7`), met product / bron / variant / `crm_lead_id` / `is_test`.

**Inloggen**: de knop in de welkomstmail is een persoonlijke link
`https://lms.deforexopleiding.nl/the-lab/start/?s=<sleutel>` (soms met `&naar=lab`
of `&naar=sessie`). De sleutel = 32 willekeurige bytes; in de DB staat alleen de
sha256 (`hlms_lab_sleutel`). Geen wachtwoord, geen code: één klik.
- **Niet eenmalig**: dezelfde link werkt telkens opnieuw (de teller `keer_gebruikt`
  wordt bijgehouden maar niet gecontroleerd). Elke klik maakt een gewone Supabase-sessie
  aan (via een eenmalige magic-link-token achter de schermen) en haalt de sleutel uit de
  adresbalk.
- **Geldig** tot `toegang_tot` + **30 dagen** (`NA_VERLOPEN_DAGEN = 30` in het LMS,
  `src/app/api/lab/inloggen/route.ts`). Na de 7 dagen geeft de link dus nog 30 dagen
  toegang tot de boekingspagina (geen Lab, geen lessen). Daarna: "Deze link is verlopen".
- `naar=lab` → `/lab/` · `naar=sessie` → `/student/?sessie=1` (actieplan, scrolt naar
  de sessie) · anders `/student/`.
- Werkt de link niet: "Deze link werkt niet meer" / "Deze link is verlopen" + formulier
  "Je e-mailadres" → "Stuur me een nieuwe link" (CRM `/api/lab-nieuwe-link`, max. 3 per
  10 min per adres; antwoord altijd "Als dit adres bij ons bekend is, staat er binnen een
  minuut een nieuwe link in je mailbox."). Op het gewone inlogscherm: "Kom je van The
  Lab? Stuur me een nieuwe link"; lab-leads hebben geen wachtwoord.

Gevallen (`beslisAccount`):

| Geval | Wat er gebeurt |
|---|---|
| Nieuw e-mailadres | auth-user + rol + lab-lead, welkomstmail (§4). |
| Bestaat al als auth-user zonder LMS-rol | gekoppeld aan die auth-user, verder als nieuw. |
| **Al student / personeel** (rij in `hlms_student` of `hlms_personeel`, een personeelsrol, of een trial-rol zonder lab-lead) | **niets aangepast**. Mail "Je hebt al toegang bij De Forex Opleiding": "Je vroeg <x> aan, maar met dit e-mailadres heb je al een account bij ons. We hebben daar niets aan veranderd." + knop "Naar het leerplatform". In het CRM als "Al student", apart van de cijfers. |
| **Bestaande lab-lead, toegang loopt nog** | geen nieuwe week; mail met een nieuwe inloglink ("Je nieuwe link voor The Lab" / "Je nieuwe inloglink"). |
| **Bestaande lab-lead, toegang verlopen, < 30 dagen geleden gestart of al geboekt** | geen nieuwe week; nieuwe link die naar de sessie-pagina leidt (`naar=sessie`). |
| **Verlengen**: toegang verlopen, NIET geboekt, en `toegang_van` ≥ **30 dagen** geleden (`VERLENG_NA_DAGEN = 30`) | een frisse week (`resultaat: verlengd`) + de welkomstmail. Dus max. 1 nieuwe week per 30 dagen. |

Lukt het LMS niet: retry. Gate-funnels via `cron-toegang-aanvragen` (72 u lang,
max. 7 pogingen, wachttijd `min(60·2^n, 3600)` s; daarna alarmmail naar
`PROVISIONING_ALARM_EMAIL`). Webinar/The Lab via `cron-lab-opvolging` (`herstel`,
max. 5 pogingen binnen 72 u, telkens n×10 min later).

Testleads: e-mail met `+test` / `+labtest`, of `maxim.delombaerde96+…@gmail.com`
→ `is_test`, telt niet mee in de cijfers.

---

## 4. Welkomstmail per belofte

Afzender: env `LEADSONDERHOUD_MAIL_AFZENDER`, anders **welkom@deforexopleiding.nl**.
Code: `api/_lib/lab-berichten.js` → `WELKOM_BELOFTE`.

| Belofte | Onderwerp | Kern (openingsalinea) |
|---|---|---|
| Minicursus | **Je minicursus staat klaar** | "Je minicursus staat voor je klaar. Je krijgt de korte video's waarmee onze studenten zelf begonnen — hoe de markt écht beweegt — en daarna plaats je in The Lab je eerste (simulatie)trade met onze strategie." |
| 7-daagse | **Je 7 dagen meekijken starten nu** | "Vanaf vandaag kijk je 7 dagen mee in onze leeromgeving. Je ziet de video's die onze studenten krijgen, de opname van een live training, en in The Lab plaats je zelf je eerste (simulatie)trade." |
| Webinar | **Je toegang staat klaar — alvast vóór het webinar** | "Je plek in het webinar staat vast. Wil je er het maximum uithalen? Dan kan je nu al beginnen: in je leeromgeving staan de video's waar we in het webinar op verder bouwen, en in The Lab plaats je je eerste (simulatie)trade." |
| Website | **Je toegang tot de leeromgeving staat klaar** | "Je persoonlijke leeromgeving staat klaar. Je krijgt de video's waarmee onze studenten zelf begonnen, en in The Lab plaats je je eerste (simulatie)trade met onze strategie." |
| The Lab | **Je toegang tot The Lab staat klaar** | "Je eigen account staat klaar. In The Lab plaats je je eerste trade met onze strategie — stap voor stap, in een echte chart. Reken op een twintigtal minuten." |

Daarna voor iedereen:
- één knop **"Log in"** (de persoonlijke link uit §3);
- "Wat je eerst doet:" 1. Kijk de video's · 2. Plaats je eerste trade in The Lab
  (±20 min) · 3. Plan je strategiesessie (30 min, normaal €100, voor jou gratis);
- "Inloggen hoeft niet: de knop doet dat voor je. Je toegang loopt 7 dagen, tot
  <weekdag dag maand>";
- werkt de knop niet: een nieuwe link aanvragen op lms.deforexopleiding.nl.

WhatsApp op dag 0:
- gate-funnels: GEEN extra WhatsApp (ze kregen al het "Top <naam>! ✅"-bericht);
- webinar / The Lab: template `trial_welkom`, enkel met toestemming en een
  goedgekeurd template — "Hey {{1}}! 👋 Je toegang staat klaar: 7 dagen in de
  leeromgeving van De Forex Opleiding. Begin met de eerste video en plaats daarna je
  eerste (simulatie)trade in The Lab. Log in met één klik: {{2}}" + "Veel succes, het
  team van De Forex Opleiding".

---

## 5. De LMS-ervaring

Na de klik op "Log in" (`/the-lab/start/?s=…`: "Even geduld… We loggen je in.") komt de
lead op `/student/`. Een trial MET een `hlms_lab_lead`-rij krijgt "Jouw route"; een
student krijgt het gewone dashboard.

**1. Welkomstervaring** (eerste keer, zolang er geen route gekozen is) — schermvullend,
7 momenten, "Sla over" springt naar de keuze:
1. *Welkom* — bovenregel + titel per belofte (`src/features/lab-lead/belofte.ts`):

   | Product | Bovenregel | Titel |
   |---|---|---|
   | Minicursus | Welkom bij je minicursus | "<Voornaam>, je minicursus staat klaar." |
   | 7-daagse | Welkom bij je 7 dagen meekijken | "<Voornaam>, vanaf vandaag kijk je 7 dagen mee." |
   | Webinar | Welkom — alvast vóór het webinar | "<Voornaam>, je plek staat vast. Begin alvast." |
   | Website | Welkom in je leeromgeving | "<Voornaam>, je bent klaar voor het echte werk." |
   | The Lab | Welkom bij De Forex Opleiding | "<Voornaam>, je bent klaar voor het echte werk." |

   + "Eerst even dit: wat de trades van onze studenten ons leerden."
2. *Trades* — 20.244 gelogde trades, van 177 studenten.
3. *Ring* — 78,7% winrate in de backtest → 48,5% met echt geld. "Het verschil zit in
   de uitvoering."
4. *Schuif* — "Hoeveel van je trades moet je winnen om geld te verdienen?" → quitte
   vanaf ~24% winrate.
5. *Studenten* — 41 van de 47 studenten met 30+ trades in winst · +70,5% voor de
   mediaanstudent over 19 maanden bij 1% risico · 100+ funded traders.
6. *Kern* — "Trading is niet moeilijk. Het is disciplinewerk. Daarom werken wij 1-op-1."
7. *Keuze* — "Hoe wil je beginnen?":
   - **lab** — "Ik neem het serieus — ik heb tijd en een laptop" (eerst video's, dan
     The Lab, dan de sessie);
   - **kort** — "Ik heb nu maar 5 minuten" (eerste video + meteen een moment met Dave;
     The Lab later op de laptop);
   - **praten** — "Ik wil meteen praten" (strategiesessie: 30 min, t.w.v. €100 — gratis).

   (De "±20 min" voor The Lab staat in het actieplan, niet op het keuzescherm.)
   Bronregel onder de cijfers: journaldata van 177 studenten, gemeten op 8 okt 2026;
   resultaten uit het verleden bieden geen garantie.

**2. Jouw actieplan** (`/student/`, na de keuze; "Andere keuze" heropent het
keuzescherm):
- Aftelling: "Nog {n} dagen toegang." / "Vandaag je laatste dag toegang." / "Je toegang
  is afgelopen — je sessie kan je nog plannen."
- Voortgang: "{k} van 3 stappen · {b} van {t} video's bekeken". Na 2+ dagen weg: "Fijn
  dat je terug bent. …".
- Grote knop = volgende stap: "Start hier — je eerste video" / "Verder met je leerpad" →
  "Nu toepassen in The Lab" → "Plan je strategiesessie met Dave". Route *praten* gaat
  meteen naar de sessie.
- **Stap 1 — De video's**: open lessen in vaste volgorde (Market Structure, Fibonacci,
  Volume & Orderblocks, Protected & Unprotected Highs / Lows, 15M Entry Model Criteria,
  High probability sweeps + OB + Volume deepdive, Live Training 08/10/26, daarna de
  rest die open staat). Klaar = de eerste 5 bekeken (*kort*: 1 video).
- **Stap 2 — The Lab**: "Nu toepassen in The Lab: je eerste trade (±20 min, laptop)".
  Knop "Open The Lab"; voor *kort*/*praten* ook "Mail me de link voor op mijn laptop".
- **Stap 3 — Strategiesessie met Dave**: 30 min, t.w.v. €100, gratis en vrijblijvend.
  Nooit vergrendeld; de kalender staat er meteen in.
- Onderaan: "De rest van het leerplatform ontgrendel je in een traject."

**3. The Lab** (`/lab`): één echte chart, één trade, stap voor stap. Na de eerste
winnende trade één keer: "Mooi, je eerste trade raakt zijn doel. Wil je dit live met Dave
bekijken?". Eindkaart: "Jouw resultaat" (±xR, 78,7% vs 48,5%) → boeken ("gratis omdat je
The Lab afwerkte") → 3 vragen "Help Dave zich voorbereiden" (doel · tijd per week ·
bereid te investeren in begeleiding) → "Waarom is 48,5% genoeg?".

**4. Boekkalender / sessiebalk**: op elke pagina behalve `/lab` een balk "Gratis
strategiesessie · 30 min met Dave · nog n dagen toegang" + "Plan in". Een
uitnodigingsvenster ("Je hoeft het niet alleen uit te zoeken") komt bij o.a. de 2e
pagina, 45 s op een pagina, een nieuwe dag of een afgewerkte video — max. 3 keer in
totaal, max. 1× per sessie, niet binnen 24 u na "Niet nu", nooit na een boeking.
Kalender: "1 · Kies een dag" (deze en volgende week) → "2 · Kies een tijd" (Belgische en
Nederlandse tijd · 30 minuten via Zoom; bij ≤ 6 vrije momenten "Nog {n} vrije momenten
deze week.") → "3 · Bevestig". Alternatief: "Liever eerst een vraag stellen? → Dave belt
je".

**Wat vergrendeld is** (`src/features/trial/trial-lock.ts`): Planner, Agenda, 1-op-1
sessies, Mijn coachingsessies & plakboek, Notities, Performance Hub, Mijlpalen, FAQ — in
de zijbalk samen in "Ontgrendeld in een traject (n)". Klik erop: "Dit zit in een 1-op-1
traject. Bekijk met Dave of het bij je past." + "Plan je strategiesessie met Dave (30
min, gratis)". Open: actieplan, Study Desk (enkel lessen/materiaal met
`trial_zichtbaar`), Trading Journal, Documenten, The Lab. Live trainingen: enkel de
opname, nooit een Zoom-link.

("Dave" = de gastheer; zonder naam staat er "met iemand van ons team".)

---

## 6. De strategiesessie

- **Boeken**: in het LMS (actieplan stap 3, sessiebalk, uitnodiging, eindkaart van The
  Lab) en op de Lab-bedankpagina, via CRM `/api/lab-sessie`. Het CRM levert vrije
  momenten voor **14 dagen** (`VENSTER_DAGEN = 14`); het LMS toont daarvan deze en
  volgende week. Duur **30 minuten** (`DUUR_MIN = 30`), via Zoom.
- **Agenda**: dezelfde GHL-agenda als de kennismakingsgesprekken (`GHL_CALENDAR_ID`).
  `booking_source = 'the-lab'`; eigenaar = de gastheer uit `app_settings.lab_gastheer`
  (nu Dave Heylen). Op de bedankpagina geldt een weekquotum van 3 (`LAB_WEEKQUOTUM`).
- **Titel bij Dave** (`sessieTitel`): **"Strategiesessie · via <Belofte> · <naam>"**,
  bv. "Strategiesessie · via Minicursus · Lien". Voor The Lab of een lead zonder
  product: "The Lab · strategiesessie · <naam>". In Opvolging en
  Kennismakingsgesprekken staat er een chip "via Minicursus" enz.
- **Bevestiging**: mail **"Je strategiesessie met Dave staat vast"** met de
  agenda-bijlage `strategiesessie.ics` en de Zoom-link, plus WhatsApp. In het LMS:
  "Bevestigd · via Zoom — Je strategiesessie staat op <moment>." + "Wat we bespreken"
  (je resultaat uit The Lab · je doel en je tijd · of trading bij je past) + knop "Zet in
  mijn agenda" (een .ics uit de browser, herinnering 15 min vooraf, zonder Zoom-link).
- **Herinneringen** (cron-afspraak-reminders):
  - 24 u vooraf: "Morgen: je strategiesessie met Dave";
  - 1 u vooraf (alleen mail): "Over een uur: je strategiesessie met Dave";
  - 30 min vooraf: "Over 30 minuten begint je strategiesessie";
  - 5 min vooraf: "We beginnen zo — je strategiesessie".
- **Verzetten**: link `https://deforexopleiding.nl/afspraak/<token>`
  (`AFSPRAAK_SELFSERVICE_BASE`), in elke mail en als "verzetten" in de sessiebalk van het
  LMS (na de boeking: "Je sessie met Dave: <moment> · toevoegen aan agenda · verzetten").
- Na een boeking stopt de opvolgmotor (§7) voor die lead.
- Testleads krijgen een testafspraak; er wordt niets verstuurd.

---

## 7. De opvolgmotor (`cron-lab-opvolging`)

Draait **elke 15 minuten** (`*/15 * * * *`). Code: `api/cron-lab-opvolging.js`,
beslissing in `api/_lib/lab-opvolging.js` → `volgendeStap` (pure functie).
Teksten bewerkbaar in Leadsonderhoud › Templates › Trial-opvolging (een eigen tekst
wint van de standaard). Rekent vanaf `toegang_van` (start van de trial).

### Stappen

| Stap | Trigger (wanneer) | Kanaal | Mail-onderwerp | WhatsApp-template | Link naar |
|---|---|---|---|---|---|
| niet-ingelogd-24u | ≥ 1 dag na de start, nog niet ingelogd | mail | "Je toegang staat klaar, <voornaam>" | — | login |
| niet-ingelogd-48u | ≥ 2 dagen na de start, nog niet ingelogd | mail + WA | "Je toegang loopt maar 7 dagen" | `trial_niet_ingelogd_48u` | login |
| dag3-lab | ≥ 3 dagen na de start, ingelogd, The Lab nog niet gestart | mail | "Nu de praktijk: je eerste trade" | — | The Lab |
| uitnodiging-sessie | The Lab afgewerkt of ≥ 2 video's gezien | mail + WA | "Je bent er klaar voor: je strategiesessie" | `trial_uitnodiging_sessie` | sessie |
| dag5 | nog ≤ 2 dagen toegang | mail | "Je toegang verloopt binnenkort" | — | sessie |
| laatste-dag | nog ≤ 1 dag toegang | mail + WA | "Vandaag je laatste dag" | `trial_laatste_dag` | sessie |
| verlopen | na `toegang_tot` | mail + WA | "Je toegang is verlopen" | `trial_verlopen` | sessie |
| verlopen-3 | ≥ 3 dagen na het verlopen, én niets gedaan (nooit ingelogd, of 0 video's en geen Lab) | mail | "Eerlijk is eerlijk, <voornaam>" | — | sessie |
| verlopen-7 | ≥ 7 dagen na het verlopen | mail | "Een laatste bericht van ons" | — | sessie |

Volgorde van de beslissing (eerste die past wint): na het verlopen → verlopen-7 /
verlopen-3 / verlopen; daarvoor → laatste-dag, dag5, uitnodiging-sessie,
niet-ingelogd-48u/-24u, dag3-lab. Elke stap gaat hoogstens één keer
(uniek op aanmelding + stap + kanaal in `lab_opvolging`).

WhatsApp-teksten (alle vijf met een afsluitregel na de link):
- `trial_niet_ingelogd_48u`: "Hey {{1}}, je toegang loopt maar 7 dagen en je bent nog
  niet ingelogd. Zet er vanavond tien minuten voor opzij — één klik en je zit erin:
  {{2}}" + "Tot zo, het team van De Forex Opleiding"
- `trial_uitnodiging_sessie`: "Hey {{1}}, sterk bezig! Tijd om het concreet te maken:
  plan je strategiesessie van 30 minuten met ons team (t.w.v. €100, voor jou gratis).
  Kies je moment: {{2}}" + "Tot binnenkort, het team van De Forex Opleiding"
- `trial_laatste_dag`: "Hey {{1}}, vandaag is je laatste dag toegang. Twijfel je nog?
  Plan je gratis strategiesessie — 30 minuten, zonder verplichtingen. Je gaat buiten met
  een plan: {{2}}" + "Het team van De Forex Opleiding"
- `trial_verlopen`: "Hey {{1}}, je 7 dagen zitten erop. Wil je verder? Plan een sessie
  met ons team, dan bekijken we samen wat er voor jou mogelijk is: {{2}}" + "Het team
  van De Forex Opleiding"

Status bij Meta op 26 okt: `trial_welkom`, `trial_niet_ingelogd_48u` en
`trial_uitnodiging_sessie` goedgekeurd; `trial_laatste_dag` en `trial_verlopen` in
review. Een template dat niet goedgekeurd is wordt overgeslagen (gelogd); de mail van
die stap gaat wel. De code stuurt precies 2 variabelen: {{1}} voornaam, {{2}} link.

### Regels

- **Cron**: elke 15 min; per run max. 40 berichten (`MAX_PER_RUN`); kijkt naar
  aanmeldingen van de laatste 21 dagen (`VENSTER_DAGEN`).
- **Stille uren**: niets tussen 21:00 en 08:00 (Europe/Amsterdam).
- **Max. 1 bericht per lead per 20 uur.**
- **Stopt bij**: geboekte sessie · klant geworden · afgemeld (`lead_mail_voorkeuren`)
  · geen toestemming. Let op: zonder toestemming gaat er ook GEEN mail uit de motor.
- **Nooit** "je bent nog niet ingelogd" aan wie al inlogde.
- **Schakelaar**: `app_settings.lab_opvolging_live` (nu `"true"`). Uit = de motor
  rekent en logt ("droog"), maar verstuurt niets. Aan/uit enkel door super_admin /
  admin / manager / sales, met een bevestiging in de pagina.
- **Noodstop**: env `LEADSONDERHOUD_UIT` = alles stil (ook de oude motor).
- De oude leadsonderhoud-motor slaat minicursus-/7-daagse-leads met een lab-trial over
  (`heeftLabTrial`), dus geen dubbele berichten.
- Variabelen in eigen teksten: {voornaam} {loginlink} {belofte} {eerste_video_min}
  {dagen_over} {stap} {stappen}. `{eerste_video_min}` valt nu terug op "maar een paar
  minuten" (`app_settings.trial_eerste_video_min` is niet gezet).

---

## 8. Op de einddatum

Er is **geen harde uitlog**: de lead kan nog 30 dagen inloggen met dezelfde link
(§3), maar de inhoud gaat dicht.
- **In de database**: `hlms_trial_toegang_geldig()` wordt onwaar zodra
  `toegang_tot < now()` → geen lessen, modules, materiaal of trainingen meer leesbaar.
- **`/student/`**: het actieplan blijft, met "Je toegang is afgelopen — je sessie kan je
  nog plannen."; stap 2 (The Lab) toont "Niet meer beschikbaar."; de volgende stap is de
  strategiesessie; de balk zegt "toegang afgelopen".
- **`/lab`**: "Je toegang tot The Lab is afgelopen" / "Je proefperiode liep tot <d
  maand>. Op je startpagina zie je hoe je verder kan." + knop "Naar je startpagina".
- **Boeken kan nog**: het LMS toont de kalender, en CRM `/api/lab-sessie` controleert de
  einddatum niet.
- **Berichten**: de opvolgmotor stuurt "verlopen" (dag van verlopen, mail + WhatsApp),
  "verlopen-3" (enkel wie niets deed) en "verlopen-7" (§7), allemaal met de
  sessielink. Daarna niets meer (de motor kijkt 21 dagen terug).
- **Na 30 dagen**: de link geeft "Deze link is verlopen". Een nieuwe link aanvragen
  maakt wel een verse sleutel, maar het LMS weigert die om dezelfde reden (de 30 dagen
  hangen aan `toegang_tot`, niet aan de sleutel). Een nieuwe week krijgt de lead alleen
  door zich opnieuw aan te melden via een funnel (verlengen, §3).
- **In het CRM**: chip "Verlopen", status `verlopen`; de lead blijft in de bellijst tot
  geboekt/klant/afgemeld.

---

## 9. CRM: waar het team alles ziet

### Leadsonderhoud › The Lab
Tabs **Overzicht** · **Bellijst** · **Ads (The Lab)**. Bron: `api/trial-overzicht.js`.

- **Overzicht**: KPI's per product (Minicursus / 7-daagse / Webinar / Website /
  The Lab): leads · ingelogd · video gezien · Lab gestart · Lab afgewerkt · sessie
  geboekt · klant (met % van de leads). Filters: Vandaag / 7d / 30d / 90d, product,
  hook, variant. Per lead een dossier met tijdlijn.
- **Chips per lead**: Klant · Sessie geboekt · <datum> · Ingelogd / Niet ingelogd ·
  Video's · n (titels bij hover) · Lab · stap x/y · Lab afgewerkt · Verlopen ·
  Afgemeld. **Al student** staat in een apart blok, buiten de KPI's en de bellijst.
- **Status (labStatus)**: geboekt · afgewerkt · bezig · verlopen · ingelogd ·
  aangemeld · geen_account.
- **Bellijst**: groepen "Warm, geen sessie" / "Ingelogd, geen sessie" / "Niet
  ingelogd (met toestemming)". Niet erin: geboekt, klant, afgemeld, geen telefoon,
  test. Wie de laatste 24 u gebeld werd, schuift achteraan. Knop "Bel +32…", uitkomst
  noteren: geen_antwoord · voicemail · gesproken · sessie_geboekt · terugbellen ·
  geen_interesse · verkeerd_nummer (`trial_belpogingen`). CSV-export.

### Leadsonderhoud › Templates › Trial-opvolging
Alle stappen van §7 met wanneer, standaardtekst, eigen tekst en de Meta-status van het
WhatsApp-template; de schakelaar van de motor.

### Opvolging › Leads bellen
Toont de minicursus- en 7-daagse-proefleads ("Minicursus" / "7-daagse · <variant>")
met hun LMS-gedrag (ingelogd, video's, Lab) uit `api/_lib/lab-trial-stand.js`.
Warmte 0–45: ingelogd +5, per video +4 (max. 20), Lab gestart +8, afgewerkt +12.
**Webinar-trials staan NIET in Leads bellen** (die zie je in Leadsonderhoud › The Lab).

### Afspraken
Opvolging-agenda en Kennismakingsgesprekken: chip "via <Belofte>" op de
strategiesessie.

---

## 10. De schakelaar `trial_bestemming` en terugdraaien

`app_settings.trial_bestemming` — nu:
```json
{"the-lab":"lab","webinar":"lab","website":"lab","7-daagse":"lab","minicursus":"lab"}
```
- `lab` = lab-lead in het echte LMS (alles hierboven).
- `oud` = terug naar het oude trial-LMS (dfo-website `/api/interne-welkom`, account in
  `lms_gebruikers`, www.deforexopleiding.nl/lms).
- Ontbreekt een product, staat er onzin, of lukt het lezen niet → `lab`.

**Terugdraaien per product, zonder deploy**: in Supabase (forex-command-center):
```sql
update app_settings
set value = jsonb_set(value::jsonb, '{minicursus}', '"oud"')
where key = 'trial_bestemming';
```
(product naar keuze: `minicursus`, `7-daagse`, `website`, `webinar`). Geldt voor
nieuwe aanmeldingen vanaf dan; wie al een lab-lead heeft houdt die.

Kanttekeningen:
- **De sleutel `the-lab` doet niets**: de Lab-funnel (`/api/lab-aanmelding`) gaat
  altijd naar het LMS en leest de schakelaar niet.
- Webinar op `oud` = geen trial meer bij een webinar-aanmelding (er bestond geen oud
  webinar-trial); de webinar-registratie zelf blijft.
- De opvolgmotor apart stilzetten: `lab_opvolging_live` op `"false"` (of via de knop
  in Trial-opvolging). Alles stil: env `LEADSONDERHOUD_UIT`.
- NOOIT `lms_gebruikers.lead_id` backfillen (zie
  `docs/sql-migrations/2026-10-26-NIET-DRAAIEN-…`): dan gaat de oude motor weer
  sturen naar mensen die al in het nieuwe LMS zitten.

---

## Open punten die uit de code blijken

- Verlopen gate-aanvraag (geen "ja" binnen ±72 u): geen automatisch vervolg, enkel
  handmatig "Geef toegang".
- Leads zonder toestemming krijgen geen enkel motorbericht, ook geen mail.
- `trial_laatste_dag` en `trial_verlopen` wachten op Meta; tot dan alleen de mail.
- Minicursus/7-daagse-bedankpagina's bieden nog het kennismakingsgesprek /
  de opstartsessie aan, niet de strategiesessie met Dave.
- Na 30 dagen na het verlopen werkt ook een nieuw aangevraagde link niet meer (§8).
- Flow B-afwijstekst wijkt een paar woorden af van Flow A ("we begeleiden alleen
  mensen" vs "we willen alleen mensen begeleiden").
