# Supportmodule — architectuur & fasering

> Opgesteld 22 september 2026. Beslissingen in dit document zijn genomen door
> Jeffrey bij de start van de bouw; wijk er niet van af zonder nieuw akkoord.

## 1. Waarom

Klantvragen komen vandaag binnen via vier IMAP-mailboxen en de WhatsApp-inbox.
Er is geen kanaal op de website zelf, geen ticket-lifecycle voor klantvragen
(de bestaande `tickets`-tabel is een *interne* bug/feature-tracker) en geen
manier voor een klant om zelf iets aan te vragen. De vijf vragen die het
vaakst terugkomen zijn bovendien machinaal beantwoordbaar — het antwoord staat
al in de database:

| Vraag | Waar het antwoord staat |
|---|---|
| "Ik kan niet meer in het LMS" | `onboardings.dfo_lms_provision_error`, `hlms_student.auth_id` / `eind_datum` |
| "Discord werkt niet" | Nergens — geen integratie. Altijd naar de mentor. |
| "Wie is mijn mentor / wanneer is mijn volgende sessie?" | `onboardings.mentor_user_id` → `team_members`, `hlms_sessie` |
| "Ik kan de factuur niet betalen" | `hlms_crm_factuurstand`, `payment_arrangements` |
| "Waar plan ik een gesprek / kan ik me inschrijven?" | Events + agenda-links |

## 2. Beslissingen

1. **Plaatsing** — één `<script>`-regel in de Webflow site-settings. De widget
   wordt als los JS-bestand vanuit het CRM geserveerd (`/widget/support.js`) en
   bouwt zijn eigen UI in een **shadow DOM**. Geen iframe: `X-Frame-Options:
   SAMEORIGIN` + CSP `frame-ancestors 'self'` in `vercel.json` sluiten dat uit,
   en een shadow DOM voorkomt bovendien dat Webflow-CSS de widget sloopt.
2. **Identificatie** — naam + e-mail + telefoon volstaat om een vraag te
   stellen. Zodra er **persoonlijke gegevens** getoond worden (factuurstand,
   LMS-status, mentor, sessies) eerst een zescijferige code per e-mail.
   Zonder geverifieerde sessie ziet de bot die gegevens zélf ook niet: de
   lookups draaien pas ná verificatie.
3. **Botmandaat** — de bot antwoordt uit de kennisbank, kijkt read-only live
   data op, en zet een betalingsafspraak klaar als **voorstel**. De bot voert
   niets uit en belooft niets. Herstelacties (uitnodiging opnieuw sturen,
   abonnement aanpassen, factuur crediteren) worden door de module
   *voorgesteld* en pas na menselijke goedkeuring uitgevoerd — automatisering
   daarvan is een latere fase.
4. **Live chat** — aanwezigheid per medewerker (hartslag, verloopt na 5 min)
   gecombineerd met kantooruren. Is er niemand → de bezoeker krijgt het
   eerlijke bericht dat het gesprek in de wachtrij komt en per mail wordt
   beantwoord.

## 3. Datamodel

Eigen `support_*`-namespace, los van de interne `tickets`-tabel.

- **`support_gesprekken`** — het gesprek *is* het ticket. Eén rij per
  bezoeker-sessie. `soort` (`klant`/`bezoeker`), `onderwerp`, `status`
  (`bot` → `wacht_op_ons` → `in_behandeling` → `wacht_op_klant` →
  `afgehandeld`), contactgegevens, `customer_id`, `geverifieerd`,
  `toegewezen_aan`, `sessie_token_hash`, tellers en tijdstempels.
- **`support_berichten`** — `afzender` ∈ `klant`/`bot`/`medewerker`/`systeem`.
- **`support_verificaties`** — code-hash, vervaltijd, pogingenteller.
- **`support_aanwezigheid`** — één rij per medewerker, hartslag.
- **`support_acties`** — door de bot of een medewerker voorgestelde actie met
  status `voorgesteld` → `goedgekeurd`/`afgewezen` → `uitgevoerd`/`mislukt`.

Kennis komt uit `kennisbank_artikelen` met `agents @> ['support']` — dezelfde
tabel die Joost, Simone, Mila en Lisa gebruiken, dus één plek om bij te
houden. Wat de bot niet wist, landt in `kennisbank_unmatched` met
`agent_key='support'`: dat lijstje ís de achterstand in de kennisbank.

Bot-configuratie krijgt **geen eigen tabel**: een rij `module='support'` in
`joost_config` hergebruikt persona, prompt, kennisbank, model, mandaat en
feature-flags, inclusief de bestaande admin-UI-patronen.

## 4. Beveiligingsmodel

- **CORS** strikt volgens het `api/lms-whoami.js`-recept: allowlist, nooit
  `*`, `Vary: Origin`, `OPTIONS` → 204, fail-closed. Toegestaan zijn de eigen
  domeinen plus de Vercel-previews van het website-project.
- **Sessie** — de widget krijgt bij `support-start` een random token van 32
  bytes. In de database staat alleen de SHA-256 daarvan. Het token gaat in de
  header `X-Support-Token`, nooit in de URL.
- **Honeypot + IP-rate-limit** op elk publiek schrijf-endpoint, conform
  `api/assessment-submit.js`. De rate-limiter is fail-open (bekende keuze);
  de verificatie-endpoints hebben daarom een *tweede*, DB-gebaseerde teller
  per gesprek die fail-closed is.
- **Verificatiecode** — 6 cijfers, 10 minuten geldig, maximaal 5 pogingen,
  daarna is het gesprek permanent onverifieerbaar (nieuw gesprek starten).
  Het antwoord op "bestaat dit e-mailadres?" is altijd hetzelfde, ongeacht of
  de klant bestaat — anders is het endpoint een klantenbestand-orakel.
- **RLS** — alle nieuwe tabellen `ENABLE ROW LEVEL SECURITY` met
  `public.is_crm_staff()`, schrijven uitsluitend via service-role, conform
  `docs/rls-regels-nieuwe-tabellen.md`.

## 5. Gespreksstromen

**Bezoeker (nog geen klant)** → informatie over de opleiding · een gesprek
inplannen · inschrijven voor een event · vraag over een bestaande
inschrijving. De bot beantwoordt uit de kennisbank en verwijst naar de
agenda- en eventpagina's; alles wat hij niet weet wordt een ticket.

**Klant** → naam, e-mail en telefoon → keuze uit LMS · Discord · traject &
mentor · financieel · overig. Bij LMS, traject en financieel volgt de
mailcode; daarna kijkt de bot de werkelijke status op en antwoordt concreet
("je uitnodiging is verstuurd maar het wachtwoord is niet gezet — ik zet een
nieuwe uitnodiging klaar voor een collega om goed te keuren").

Op elk moment kan de bezoeker "ik wil een medewerker spreken" kiezen. Is er
iemand beschikbaar → live chat. Anders → wachtrij met mailbelofte.

## 6. Wat de bot expliciet NIET doet

- Toezeggen dat een betalingsafspraak rond is. Zelfde regel als Joost:
  *je vraagt, een collega bevestigt*.
- Een hold of stilte in het LMS opheffen — het CRM schrijft daar niet.
- Iets beweren over Discord buiten "de link komt per mail na je onboarding".
- Persoonlijke gegevens tonen zonder geverifieerde sessie.

## 7. Fasering

| Fase | Inhoud | Status |
|---|---|---|
| S1 | Datamodel, RBAC, publieke API, widget, CRM-module incl. instellingen-tab, bot met kennisbank + read-only lookups, voorgestelde acties | deze PR |
| S2 | Uitvoeren van goedgekeurde acties | deels — zie hieronder |
| S3 | Autonoom antwoorden buiten kantooruren, per intent achter feature-flag | later |
| S4 | Abonnement pauzeren / factuur crediteren vanuit een goedgekeurde actie | later, pas als S2 bewezen is |

## 7b. Fase S2 — wat er wel en niet uitgevoerd kan worden

Achter `joost_config.feature_flags.s2_acties_uitvoeren` (default UIT) voert
`api/_lib/support-actie-uitvoeren.js` een goedgekeurde actie direct uit.
Eén regel stuurt alles: **een actie geldt alleen als uitgevoerd wanneer het
onderliggende systeem dat bevestigt.** Bij twijfel wordt het `mislukt` mét
uitleg, nooit stilzwijgend `uitgevoerd` — een klant die denkt dat iets
geregeld is terwijl dat niet zo is, kost meer dan een collega die het zelf
doet.

| Soort | Uitvoerbaar | Toelichting |
|---|---|---|
| `LMS_PROVISIONING_OPNIEUW` | ja | `provisionDfoLmsStudent()`; drie lagen idempotentie |
| `MENTOR_CONTACT` | ja | notificatie naar `onboardings.mentor_user_id`; alleen een weggeschreven rij telt (`count > 0`) |
| `LMS_UITNODIGING_OPNIEUW` | **deels** | zie de grendel hieronder |
| `BETALINGSAFSPRAAK` | nee | raakt facturen en abonnementen in TeamLeader; blijft mensenwerk |
| `HANDMATIG` | nee | vrije omschrijving, per definitie handwerk |

### De grendel in het LMS

`stuurLmsUitnodiging()` slaat stap 2 over zodra `uitnodiging_verstuurd_op`
gevuld is, omdat een tweede mail het bestaande wachtwoord van de student
ongeldig maakt. Dat is verstandig — maar het betekent dat juist het geval
waarvoor deze actie bestaat (`UITNODIGING_WACHTWOORD_NIET_GEZET`: de mail
ging eruit met een wachtwoord dat niet werkt) **niet** door die functie heen
komt. Het LMS heeft geen force-optie en geen endpoint om dat veld te wissen.

De actie meldt dat dan als `mislukt` met de reden `lms_grendel` en de uitleg
dat iemand aan LMS-kant het wachtwoord moet resetten of
`uitnodiging_verstuurd_op` moet leegmaken. Bij `UITNODIGING_MAIL_MISLUKT` is
er niets verstuurd, staat dat veld leeg, en werkt opnieuw versturen wél.

**Openstaand bij de compagnon**: een force-optie op
`POST /api/admin/studenten/<id>/uitnodiging/` (bijvoorbeeld `{ opnieuw: true }`),
zodat het CRM een kapotte uitnodiging zelf kan herstellen. Zodra die er is,
is dat één tak in `support-actie-uitvoeren.js`.

### Twee vormen van "geslaagd maar er is niets gebeurd"

De grendel is niet het enige antwoord dat er van buiten uitziet als succes
terwijl er niets is weggeschreven. `createNotification()` kent dezelfde vorm:
die geeft `ok: true` mét `count: 0` terug bij een lege ontvangerslijst of
wanneer de dedup-tak de melding overslaat. `MENTOR_CONTACT` toetst daarom op
`ok && count > 0` en niet alleen op `ok`; bij `count: 0` wordt het `mislukt`
met reden `notificatie_leeg`. Zonder die toets hoorde de student dat zijn
mentor is ingelicht terwijl er geen melding bestaat.

Wie hier een derde soort aan toevoegt, stelt dus niet de vraag "gaf de helper
een fout?" maar "heeft het onderliggende systeem bevestigd dát het iets
gedaan heeft?" — dat zijn niet dezelfde vraag.

### Het herstelpad na een mislukking

Een `mislukt` actie is een eindpunt voor het systeem, niet voor de collega.
De detailkaart toont de reden uit `besluit_reden` en een knop **Toch gedaan**,
voor precies het geval van de grendel: iemand regelt het met de hand aan
LMS-kant en zet de actie daarna op gedaan. De klant krijgt dan alsnog het
bericht dat het geregeld is.

Daarom staat `api/support-actie-besluit.js` de overgang naar `uitgevoerd` toe
vanuit **`goedgekeurd` én `mislukt`**. De andere overgangen blijven strak:

| Van | Naar | |
|---|---|---|
| `voorgesteld` | `goedgekeurd` / `afgewezen` | ja |
| `goedgekeurd` | `uitgevoerd` | ja — de knop "Gedaan" uit S1 |
| `mislukt` | `uitgevoerd` | ja — de knop "Toch gedaan" |
| `uitgevoerd` | wat dan ook | **409** — anders krijgt de klant een tweede bericht |
| `afgewezen` / `voorgesteld` | `uitgevoerd` | **409** — er is niets goedgekeurd om te doen |

## 8. Benodigde omgevingsvariabelen

| Variabele | Waarvoor | Zonder |
|---|---|---|
| `SUPPORT_WIDGET_ORIGINS` | komma-gescheiden extra toegestane origins | alleen de ingebouwde allowlist |
| `DFO_LMS_SUPABASE_URL` + `_SERVICE_ROLE_KEY` | LMS-status opzoeken | bot zegt "dat kan ik nu niet zien" |
| `ANTHROPIC_API_KEY` | de bot | 503, widget valt terug op "we nemen contact op" |
| `IMAP_PASS_INFO` | verificatiecodes en antwoordmails vanaf info@ | verificatie onmogelijk (503) |

## 9. Handmatige stappen na merge

1. De migratie `docs/sql-migrations/2026-09-22-support-module-fundament.sql`
   draaien in de Supabase SQL-editor. **Blokkerend**: zonder deze migratie
   faalt elk support-endpoint met `relation "support_gesprekken" does not exist`.
2. In Webflow → Site settings → Custom code → Footer:
   `<script src="https://crm.deforexopleiding.nl/widget/support.js" async></script>`
3. Rechten toekennen in Beheer → Rollen. De migratie zet ze goed voor
   super_admin, admin, manager, sales en administratie. **Mentor staat
   bewust uit**: het contextpaneel toont de factuurstand van een student, en
   dat hoort niet standaard bij een mentor. Wil je dat mentoren
   LMS-vragen oppakken, zet dan `support.module.access` en `support.reply`
   voor mentor aan — het paneel toont dan ook de facturen.
4. Kantooruren, widgetteksten en de bot instellen in **Support →
   Instellingen** (recht `support.config`). Daar staat ook het script-snippet
   met een kopieerknop, zodat niemand het hoeft over te typen.
5. Optioneel: `docs/sql-migrations/2026-09-22-support-kennisbank-seed.sql`
   draaien voor zeventien startartikelen (LMS, Discord, traject, financieel,
   events, contact). Overslaan mag — de bot werkt dan gewoon, hij weet
   alleen minder en escaleert vaker. Daarna bij te houden in
   Instellingen → Kennisbank.
