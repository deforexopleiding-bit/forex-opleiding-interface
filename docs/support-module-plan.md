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
| S1 | Datamodel, RBAC, publieke API, widget, CRM-module, bot met kennisbank + read-only lookups, voorgestelde acties | deze PR |
| S2 | Uitvoeren van goedgekeurde acties (uitnodiging opnieuw sturen) | later |
| S3 | Autonoom antwoorden buiten kantooruren, per intent achter feature-flag | later |
| S4 | Abonnement pauzeren / factuur crediteren vanuit een goedgekeurde actie | later, pas als S2 bewezen is |

## 8. Benodigde omgevingsvariabelen

| Variabele | Waarvoor | Zonder |
|---|---|---|
| `SUPPORT_WIDGET_ORIGINS` | komma-gescheiden extra toegestane origins | alleen de ingebouwde allowlist |
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
4. Kantooruren controleren in `app_settings.support_kantooruren`.
