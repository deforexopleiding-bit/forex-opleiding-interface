# Follow-up Module — Volledig project plan v2.2

> Quick Win #1 voor De Forex Opleiding (Jeffrey Biemold).
> Versie: 2.2 (15 mei 2026)
> Doel: volledige follow-up flow voor sales calls die via GoHighLevel + Zoom worden ingepland.

## Versie-historie

- **v1.0**: oorspronkelijk — module zou WhatsApp Business API integreren voor messaging
- **v2.0**: scope herzien — GHL eigenaar van messaging, module wordt detectie+trigger+tracking laag
- **v2.1**: WhatsApp conversaties zichtbaarheid + reply-functionaliteit toegevoegd via GHL webhook + API
- **v2.2**: rapportages en admin-features gericht op ALLE ADMIN_ROLES (super_admin + admin + manager), niet alleen Jeffrey persoonlijk

## Economische onderbouwing

- 50-100 calls per maand
- Gemiddelde klantwaarde €4000 (range €2880-€12000)
- Huidige no-show rate: ~25%
- Huidige conversie call → klant: ~25%
- Doel no-show recovery: 33% (van 25 → 8 extra effectieve calls/mnd)
- Doel conversie verbetering: 25% → 33% (+8 klanten/mnd)
- Extra omzet bij realistische doelen: **+€44.000/maand = €528.000/jaar**
- Conservatieve schatting bij halve resultaten: +€264.000/jaar

## Architectuur — Module vs GHL

### Module is eigenaar van

- Voicememo accountability (Dave's afvink-workflow)
- Steekproef-screenshot upload + Haiku review
- Zoom webhook ontvangst + no-show detectie
- Post-call invul-formulier (bezwaar, warmte, terugkomdatum, notitie)
- Snelle notities per call
- Dashboard met 5 secties + detail-scherm per lead
- WhatsApp conversatie zichtbaarheid (via GHL data) + reply UX
- Notificatie-engine voor Dave (in-app banners, sidebar-badges)
- Trigger-API calls naar GHL workflows
- Status-tracking van GHL workflows
- Rapportages naar alle ADMIN_ROLES (dagelijks + wekelijks)

### GHL blijft eigenaar van

- Afspraakbevestiging na inplannen (email + WhatsApp)
- Pre-call reminders 2u / 10min / bij start naar de lead (email + WhatsApp)
- **No-show messaging** (getriggerd door Module via API)
- Drip-campagnes voor niet-kopers (getriggerd door Module met bezwaar als custom field)
- WhatsApp-notificaties naar Dave (07:00 daily list, 2u pre-call, 17:00 EOD)
- WhatsApp Business API integratie (alle verzending verloopt via GHL)
- Geverifieerd bedrijfsnummer en template-management

### Wat de module NIET doet

- Geen directe WhatsApp Business API integratie in eigen code
- Geen email-verzending van marketing/follow-up berichten
- Geen drip-engine in eigen code
- Geen Teamleader-koppeling (Dave geeft handmatig "klant geworden" status)

## Rol-gebaseerde toegang

Module gebruikt bestaande `ADMIN_ROLES = ['super_admin', 'admin', 'manager']` constante uit `api/supabase.js`. Drie toegangsniveaus:

| Rol | Wat ziet/krijgt deze rol |
|-----|--------------------------|
| sales (Dave) | Eigen workflow, eigen voicememo's, eigen leads, eigen messages |
| ADMIN_ROLES | Alles platform-breed: alle Dave's data, screenshot review queue, alle rapportages |
| mentor / administratie / viewer | Module niet zichtbaar in sidebar |

Bij groei (meer ADMIN_ROLES gebruikers): allemaal krijgen dezelfde rapporten en notificaties. KISS principe — eventueel later differentiëren per rol als 10+ admins.

## Hoofdflow — Drie kernfuncties

### 1. Voicememo accountability

Dave moet voor elke ingeplande call een voicememo sturen vanaf zijn eigen telefoon. Module is verplicht afvinkpunt + accountability.

**Waarom handmatig via Dave's eigen telefoon:**
- WhatsApp Business API automation = afzender wordt "De Forex Opleiding" niet "Dave persoonlijk"
- WhatsApp Coexistence Mode niet beschikbaar voor EU/NL nummers
- Persoonlijke ervaring voor lead = warmer + hogere conversie
- Dave's 1-tap actie per call (~2 sec) is geen probleem bij 5/dag volume

**Workflow:**
- 07:00 dagelijks: Dave krijgt WhatsApp via GHL met lijst calls van die dag
- 2u voor elke call: WhatsApp via GHL als persoonlijke reminder per call
- Timing voicememo: flexibel — als Dave het maar doet vóór de call
- Dave vinkt af in module zodra verstuurd

**Steekproef-logica:**
- Dave's afvink-teller per dag begint op 0
- Op de 3e, 8e, 13e (random tussen elke 3-5) afvinking: screenshot upload verplicht
- Dave kan niet verder afvinken zonder screenshot

**Screenshot review (Haiku eerste check + ADMIN_ROLES alleen verdachte):**

Haiku analyseert:
- Is het een WhatsApp screenshot?
- Met verzonden voicememo (microfoon-icoon zichtbaar)?
- Naar juiste lead-nummer (match met appointment)?
- Op juiste tijd (binnen 30 min van verwachte verzending)?

Bij OK → groen vinkje. Bij verdacht → notificatie naar alle ADMIN_ROLES users.

### 2. No-show detectie en GHL trigger

**Detectie via Zoom webhooks:**
- Lead is "no-show" als 10 min na call-start tijd niet in Zoom is verschenen
- Webhooks: `meeting.started`, `meeting.participant_joined`
- Match Zoom meeting ID met GHL appointment in database

**Module actie:**
- Markeer `follow_up_appointments.status = 'no_show'`
- Roep GHL workflow aan via API trigger (preferred) of custom field update (fallback)
- Log trigger in `follow_up_messages_sent`

**GHL doet de rest:**
- GHL workflow stuurt no-show WhatsApp + email
- GHL doet eventuele 24u herinnering
- Module ontvangt status via GHL conversation webhook

**Belangrijk: bij Fase 2 go-live moet huidige GHL no-show flow UIT staan, vervangen door API-getriggerde versie.**

### 3. Post-call invul-flow

Na elke completed call vult Dave het formulier in.

**Eerste vraag — Uitkomst:**
- **Klant geworden** → formulier klaar, geen vervolgvragen
- **Geen klant** → vervolgvragen verschijnen
- **No-show** → automatisch ingevuld door Module

**Vervolgvragen bij "Geen klant":**

Bezwaren (multi-select):
- Te duur
- Timing niet goed
- Partner overleg
- Twijfel winstgevendheid
- Technische zorgen
- Angst voor verliezen
- Eerdere slechte ervaring met trading
- Twijfel of forex überhaupt werkt
- Regulatie-zorgen
- Tijd om te traden
- Demo-versus-live drempel
- Anders: ___ (vrij tekst)

Volgende actie:
- Bellen op datum
- Email sturen
- Event-uitnodiging
- Sluiten zonder follow-up
- **Niet meer opvolgen** (uitsluiting van alle automation)

Overige velden:
- Wanneer terugkomen: datum picker (optioneel)
- Warmte: 1-10 score
- Korte notitie: vrij tekstveld

**Invul-verplichting: Optie C (niet blokkerend):**
- Dave kan blijven werken
- Permanente rode banner bovenaan dashboard
- Sidebar-badge met aantal openstaand
- 17:00 WhatsApp EOD-reminder via GHL als niet ingevuld
- Dagelijks rapport naar ADMIN_ROLES bij rode flags

## UI — Module structuur

### Hoofdpagina: `/modules/follow-up.html`

Vijf secties op één pagina, mobile-responsive:

**Sectie 1 — Vandaag**
- Chronologische lijst calls vandaag
- Per rij: tijd, lead-naam, telefoonnummer (klikbaar), status-indicators, knoppen (Voicememo verstuurd / Invul formulier / Snelle notitie)
- Klik op rij → opent detail-scherm
- Bovenaan: rode banner bij achterstand (Optie C nudge)

**Sectie 2 — Aankomende dagen**
- Compacte tabel, week vooruit, gegroepeerd per dag
- Zichtbaarheid voor planning, geen acties

**Sectie 3 — Achterstand** (alleen zichtbaar als er iets is)
- Niet-ingevulde formulieren van eerdere dagen
- Verstreken opvolgingen (>2 dagen voorbij terugkomdatum)
- Per rij: datum, lead-naam, type, actie-knop

**Sectie 4 — Geplande opvolgingen**
- Toont leads met `terugkom_datum` gezet
- Deze week (rood) / Komende 30 dagen (oranje) / Verder weg (groen compact)
- Per rij: lead-naam, telefoonnummer, originele call-datum + bezwaar, geplande opvolgdatum, warmte-score, notitie
- Knoppen: "Opvolging geregeld" / "Verzet opvolgdatum"
- 1 dag voor opvolgdatum: WhatsApp via GHL naar Dave
- 2 dagen na verstreken: in Sectie 3 + ADMIN_ROLES rapport

**Sectie 5 — Admin view** (zichtbaar voor alle ADMIN_ROLES, niet voor Dave)
- Statistieken: % voicememo-compliance (vandaag/week/maand)
- Verdachte screenshots in review-queue
- Recente no-shows met GHL workflow-status
- "Bekijk alles van Dave" link
- Bij meerdere sales-users in de toekomst: filter op user

**Filters (admin)**: periode + status + zoek op naam + (toekomst) sales-user

**Historie**: 30 dagen standaard, "Laad meer" knop

### Detail-scherm: `/modules/follow-up-lead.html?id={appointment_id}`

Apart detail-scherm per lead met tabs:

**Header:**
- Lead-naam + telefoonnummer
- Status-indicator (klant geworden / opvolging / no-show / gepland)
- Back-knop naar herkomst-sectie

**Tab: Calls**
- Chronologisch overzicht alle calls van deze lead (gepland + historisch)
- Per call: datum, tijd, status, link naar Zoom-recording indien beschikbaar

**Tab: WhatsApp**
- Chat-thread laatste 90 dagen berichten (gesynced via GHL)
- Berichten gegroepeerd per dag, bedrijfsnummer + lead nummer onderscheiden
- Onderaan: reply-veld
  - **Binnen 24u-venster**: free-text reply box, gaat via GHL API als regulier bericht
  - **Buiten 24u-venster**: gele banner "Lead is buiten 24u-venster, gebruik een template" + template-keuze dropdown uit GHL goedgekeurde templates
- Verzending: POST naar GHL `/conversations/{id}/messages` API
- Module detecteert venster automatisch op basis van timestamp laatste lead-bericht

**Tab: Outcome**
- Ingevuld post-call formulier (bezwaren, warmte, terugkomdatum, etc.)
- Bewerkbaar als nog niet definitief

**Tab: Notities**
- Alle snelle notities chronologisch
- Inline notitie toevoegen mogelijk

### Mobile

Mobile-responsive (geen PWA). Past bij toekomstige site-brede mobile rollout.

## Notificatie-systeem (anti-laksheid voor Dave)

### Laag 1 — In-module banner (permanent)
Bovenaan elke module-pagina, niet weg te klikken bij openstaande acties.

### Laag 2 — Sidebar-badge (heel platform door)
Rood bolletje bij "Follow-up" link met aantal openstaande acties.

### Laag 3 — Dagelijkse WhatsApp 17:00 via GHL
Bij openstaande acties: nudge-bericht naar Dave.

### Laag 4 — Dagelijks rapport ADMIN_ROLES bij rode flags
Email naar email-adres van elke ADMIN_ROLES user + in-app notificatie. Alleen bij iets in Achterstand. Schaalbaar: voegt automatisch nieuwe admin-users toe als die later worden aangemaakt.

### Laag 5 — Wekelijks compliance-rapport (zondag 17:00)
Email naar email-adres van elke ADMIN_ROLES user + in-app notificatie:
- % voicememo's op tijd deze week
- % formulieren ingevuld binnen 24u
- Aantal verstreken opvolgingen
- Trend over 4 weken
- Per sales-user uitsplitsing (relevant bij meerdere sales in toekomst)

### Bewust NIET in scope

- Geen blokkering van Dave's werk
- Geen push notifications (vereist PWA)
- Geen excessieve frequentie (max 1 EOD-reminder per dag)

## WhatsApp conversaties — Sync architectuur

### Strategie: webhook-eerst, polling als safety net

**Initiële sync per lead:**
- Bij eerste keer dat een lead in module verschijnt: eenmalig laatste 90 dagen WhatsApp-berichten ophalen via GHL API
- Endpoint: `GET /conversations/search` + `GET /conversations/{id}/messages`
- Opslaan in `follow_up_messages` tabel

**Realtime updates:**
- GHL conversation webhook stuurt elk nieuw bericht direct naar Module
- Endpoint: `/api/ghl-conversation-webhook`
- Webhook-handler verifieert secret, slaat bericht op, triggert UI-update
- Idempotent: zelfde event-id niet dubbel opslaan

**Polling als safety net:**
- Cron-job `/api/follow-up-ghl-message-sync` elke 15 min
- Check of er berichten zijn van laatste 15 min die niet via webhook binnenkwamen
- Vangt webhook delivery failures op

**Verzenden vanuit Module:**
- Module detecteert 24u-venster (timestamp laatste bericht van lead)
- Binnen venster: POST naar GHL `/conversations/{id}/messages` met free-text body
- Buiten venster: POST met template-id + variabelen
- Response opslaan in `follow_up_messages` met `direction = 'outbound'`

## Database schema

### follow_up_appointments

- `id` (uuid)
- `ghl_appointment_id` (string, unique)
- `zoom_meeting_id` (string, nullable)
- `lead_name` (text)
- `lead_email` (text)
- `lead_phone` (text)
- `lead_ghl_contact_id` (string)
- `scheduled_at` (timestamp)
- `duration_minutes` (int)
- `status` (enum: scheduled / in_progress / completed / no_show / cancelled)
- `voicememo_status` (enum: pending / sent / skipped)
- `voicememo_sent_at` (timestamp, nullable)
- `voicememo_sent_by` (uuid, FK profiles, nullable) — wie heeft afgevinkt
- `requires_screenshot` (boolean)
- `screenshot_url` (text, nullable)
- `screenshot_uploaded_at` (timestamp, nullable)
- `snelle_notitie` (text, nullable)
- `owner_id` (uuid, FK profiles) — voor RLS: welke sales-user is verantwoordelijk
- `created_at`, `updated_at` (timestamptz)

### follow_up_outcomes

- `id` (uuid)
- `appointment_id` (uuid, FK)
- `outcome` (enum: klant_geworden / geen_klant / no_show)
- `bezwaren` (text[]) — alleen bij geen_klant
- `volgende_actie` (enum) — alleen bij geen_klant
- `terugkom_datum` (date, nullable)
- `warmte_score` (int 1-10, nullable)
- `notitie` (text, nullable)
- `opvolging_status` (enum: gepland / geregeld / verzet / vervallen, default null)
- `opvolging_geregeld_at` (timestamp, nullable)
- `niet_meer_opvolgen` (boolean, default false)
- `ingevuld_door` (uuid, FK profiles)
- `ingevuld_at` (timestamp)

### follow_up_messages

- `id` (uuid)
- `ghl_message_id` (string, unique) — voor idempotency
- `ghl_conversation_id` (string)
- `lead_ghl_contact_id` (string)
- `appointment_id` (uuid, FK, nullable) — beste-match koppeling, kan ontbreken
- `direction` (enum: inbound / outbound)
- `channel` (enum: whatsapp / email / sms)
- `body` (text)
- `template_id` (string, nullable) — voor outbound template-berichten
- `template_variables` (jsonb, nullable)
- `sent_at` (timestamp)
- `received_at` (timestamp) — wanneer Module het zag
- `source` (enum: webhook / polling_sync / initial_sync)

### follow_up_messages_sent (status-tracking GHL workflows)

- `id` (uuid)
- `appointment_id` (uuid, FK)
- `trigger_type` (enum: no_show_immediate / no_show_24h / drip_per_bezwaar / opvolging_reminder)
- `ghl_workflow_id` (string, nullable)
- `triggered_at` (timestamp)
- `ghl_response_status` (enum: triggered / failed / completed, nullable)
- `lead_responded` (boolean, default false)
- `lead_responded_at` (timestamp, nullable)

### follow_up_events_log

- `id` (uuid)
- `source` (enum: ghl / zoom / manual / cron)
- `event_type` (string)
- `payload` (jsonb)
- `received_at` (timestamp)
- `processed` (boolean)

### follow_up_screenshot_audit

- `id` (uuid)
- `sales_user_id` (uuid, FK profiles) — generieke naam i.p.v. dave_user_id, schaalbaar bij meerdere sales
- `screenshot_url` (text)
- `appointment_id` (uuid, FK)
- `ai_review_result` (enum: ok / suspicious / missing)
- `ai_review_reasoning` (text, nullable)
- `admin_reviewed` (boolean, default false) — generieke naam i.p.v. jeffrey_reviewed
- `admin_reviewer_id` (uuid, FK profiles, nullable) — welke ADMIN_ROLES user heeft gereviewd
- `review_notes` (text, nullable)
- `uploaded_at` (timestamp)

### follow_up_notifications_sent

- `id` (uuid)
- `recipient_user_id` (uuid, FK profiles)
- `notification_type` (enum: dave_eod / admin_daily_flag / admin_weekly / admin_screenshot_review)
- `sent_at` (timestamp)
- `channel` (enum: whatsapp_ghl / email / in_app)
- `payload_summary` (jsonb)

### RLS

- sales-role users zien alleen rows waar `owner_id = auth.uid()` of waar zij betrokken zijn
- ADMIN_ROLES users zien alles
- Niet relevant voor mentoren/administratie/viewer
- Screenshot bewaartermijn: 30 dagen (cron-job verwijdert)
- Messages bewaren: 90 dagen rolling window per lead (cron-job verwijdert oudere)

## Externe systemen stack

### Bevestigd beschikbaar

- **GoHighLevel Agency Pro**
  - V2 API: Calendar, Contacts, Conversations, Workflows
  - Private Integration Tokens
  - Custom field updates
  - API workflow triggers
  - Conversation webhooks
- **Zoom Pro**
  - Webhooks: meeting.started, meeting.ended, meeting.participant_joined, meeting.participant_left
  - Marketplace App voor webhook config
- **WhatsApp Business API via GHL**
  - Geverifieerd bedrijfsnummer
  - Templates al in gebruik
- **Anthropic API** — Haiku voor screenshot review
- **Supabase Pro** — 8GB plan + Storage voor screenshots

### Niet via dit systeem

- Dave's persoonlijke telefoon: alleen handmatige voicememo's
- Teamleader: geen koppeling

## Cron-jobs

Negen cron-jobs bovenop bestaande vijf:

| Cron | Schedule | Doel |
|------|----------|------|
| `/api/follow-up-ghl-appointment-poll` | Elke 15 min | Nieuwe GHL appointments ophalen |
| `/api/follow-up-no-show-detect` | Elke 5 min | Check appointments waarvan tijd verstreken + geen Zoom-join |
| `/api/follow-up-ghl-message-sync` | Elke 15 min | Safety-net polling voor gemiste webhook messages |
| `/api/follow-up-dave-eod` | 17:00 dagelijks | EOD WhatsApp via GHL bij openstaande acties |
| `/api/follow-up-admin-daily` | 19:00 dagelijks | Email + in-app bij rode flags naar alle ADMIN_ROLES |
| `/api/follow-up-admin-weekly` | Zondag 17:00 | Wekelijks compliance-rapport naar alle ADMIN_ROLES |
| `/api/follow-up-screenshot-cleanup` | 03:00 dagelijks | Verwijder screenshots ouder dan 30 dagen |
| `/api/follow-up-message-cleanup` | 03:00 dagelijks | Verwijder messages ouder dan 90 dagen |
| `/api/follow-up-opvolging-reminder` | 09:00 dagelijks | Reminder Dave 1 dag voor opvolging + aging |

## Fase planning

### Fase 1A — Foundation + Dashboard (4-6 uur Claude Code, 3-5 dagen)

**Doel**: data komt binnen, dashboard toont calls, geen automation, geen conversaties.

- Database schema aanmaken (alle 7 tabellen + RLS)
- GHL connector endpoint (Calendar polling cron)
- Zoom webhook ontvanger endpoint
- `/modules/follow-up.html` dashboard met 5 secties (geen conversaties-tab)
- `/modules/follow-up-lead.html` detail-scherm (Calls + Outcome + Notities tabs, geen WhatsApp-tab)
- Voicememo afvink-workflow + steekproef-logica
- Screenshot upload + Haiku review
- Mobile-responsive
- Notificatie laag 1 + 2 (banner + sidebar-badge)
- Admin view zichtbaar voor alle ADMIN_ROLES
- Smoke test → moet werken zonder enige messaging-feature

### Fase 1B — WhatsApp conversaties read-only (3-4 uur Claude Code, 2-3 dagen)

**Doel**: Dave ziet WhatsApp-historie per lead, kan nog niet antwoorden.

- GHL conversation webhook endpoint
- Initial sync logic (90 dagen per lead bij eerste verschijning)
- Polling safety-net cron
- WhatsApp-tab in detail-scherm (read-only)
- `follow_up_messages` tabel vullen
- Smoke test → Dave ziet messages, geen reply mogelijk

### Fase 1C — WhatsApp reply functionaliteit (2-3 uur Claude Code, 2 dagen)

**Doel**: Dave kan vanuit module antwoorden via GHL.

- 24u-venster detectie
- Free-text reply box binnen venster
- Template-keuze buiten venster
- POST naar GHL `/conversations/{id}/messages`
- Outbound bericht direct in chat-thread
- Smoke test → reply komt aan bij lead via bedrijfsnummer

### Fase 2 — Notificaties + No-show automation (3-4 uur Claude Code, 3-5 dagen)

- Notificatie laag 3 + 4 + 5 (WhatsApp EOD, dagelijks/wekelijks rapport)
- Resolve ADMIN_ROLES-users dynamisch in cron-jobs (geen hardcoded emails)
- GHL workflow trigger bij no-show
- GHL huidige no-show flow uitschakelen (handmatig ADMIN)
- Race-condition verificatie
- Reply detectie via conversation webhook → workflow stop

### Fase 3 — Post-call invul-flow (3-4 uur Claude Code, 3-5 dagen)

- Modal/form na completed call
- Bezwaar-tracking database
- "Niet meer opvolgen" exclusion logic
- Geplande opvolgingen (Sectie 4)
- Opvolging-aging cron

### Fase 4 — Follow-up drip via GHL (5-7 uur Claude Code, 1 week)

- GHL workflows per bezwaar (handmatig ADMIN)
- Module triggert workflow op basis van bezwaar + warmte
- Reply detectie → workflow stop
- Warmte ≥ 8 escalatie naar Dave
- Handover-knop

## Pre-work (vóór Fase 1A implementatie)

Uit te voeren door een super_admin of admin user.

### 1. GoHighLevel Private Integration Token (5-10 min)

Login GHL → Settings → Private Integrations. Token aanmaken met scopes:
- `contacts.readonly`
- `contacts.write` (custom field updates)
- `calendars.readonly`
- `calendars/events.readonly`
- `conversations.readonly`
- `conversations/message.readonly`
- `conversations/message.write`
- `workflows.readonly`
- `workflows.write` (API triggers)

Vercel env vars: `GHL_API_KEY`, `GHL_LOCATION_ID`

### 2. Zoom Marketplace App (10-15 min)

marketplace.zoom.us → Develop → Build App
- Type: "Server-to-Server OAuth"
- Naam: "De Forex Opleiding Follow-up"
- Webhooks: meeting.started, meeting.ended, meeting.participant_joined, meeting.participant_left
- Webhook URL: `https://forex-opleiding-interface.vercel.app/api/zoom-webhook`
- Vercel env vars: `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET`

### 3. GHL Conversation Webhook (Fase 1B pre-work)

GHL Dashboard → Settings → Webhooks
- Event: conversation.message.created (inbound + outbound)
- URL: `https://forex-opleiding-interface.vercel.app/api/ghl-conversation-webhook`
- Vercel env var: `GHL_WEBHOOK_SECRET`

### 4. GHL workflows voor Dave-notificaties (Fase 2 pre-work)

Drie workflows met "API trigger" startpunt:

**Workflow 1: Dave Daily Call List**
- Template: "Goedemorgen Dave! Je hebt {{count}} calls vandaag: {{call_list}}"

**Workflow 2: Dave Pre-Call Reminder**
- Template: "Hee Dave, over 2u call met {{lead_name}} ({{lead_phone}}). Stuur even een voicememo!"

**Workflow 3: Dave EOD Reminder**
- Template: "Hee Dave, je hebt nog {{count}} calls niet ingevuld. Doe dit even voordat je afsluit."

Meta-goedkeuring vragen voor templates (1-7 dagen).

### 5. GHL workflows voor no-show automation (Fase 2 pre-work)

- "No-show Immediate" workflow met API trigger
- "No-show 24u" workflow met API trigger
- Huidige GHL no-show flow op handmatig zetten bij Fase 2 go-live

## Afhankelijkheden

Vereist af voor Fase 1A start:
- Auth Fase A+B+C+D+E volledig live ✓ (15 mei 2026)
- Dave heeft sales role account ✓
- Admin panel werkt ✓
- RLS werkt op bestaande tabellen ✓ (17 tabellen)
- ADMIN_ROLES constante beschikbaar in api/supabase.js ✓

## Tijdsbudget totaal

| Fase | Claude Code tijd | Doorlooptijd |
|------|------------------|--------------|
| Pre-work admin (GHL + Zoom setup) | — | 30-60 min |
| Fase 1A — Foundation + Dashboard | 4-6 uur | 3-5 dagen |
| Fase 1B — WhatsApp conversaties read | 3-4 uur | 2-3 dagen |
| Fase 1C — WhatsApp reply | 2-3 uur | 2 dagen |
| Fase 2 — Notificaties + No-show | 3-4 uur | 3-5 dagen |
| Fase 3 — Post-call invul-flow | 3-4 uur | 3-5 dagen |
| Fase 4 — Drip via GHL | 5-7 uur | 1 week |
| **Totaal** | **~20-28 uur** | **4-5 weken** |

## Success metrics

Maandelijks meten:
- % calls met voicememo verzonden (target: 95%+)
- % screenshots succesvol bij steekproef (target: 100%)
- % formulieren ingevuld binnen 24u (target: 90%+)
- No-show recovery rate (target: 33%)
- Conversie call → klant (target: 25% → 33%)
- Aantal verstreken opvolgingen per maand (target: <5%)
- Aantal hot leads via drip naar Dave
- Extra omzet via follow-up (target: +€44k/maand)

## Beantwoorde vragen (referentie)

- **Voicememo timing**: flexibel
- **Notificatie-kanaal Dave**: WhatsApp via GHL
- **Dagelijkse lijst tijd**: 07:00
- **Pre-call reminder**: 2u voor elke call
- **EOD-reminder Dave**: 17:00 dagelijks bij openstaande acties
- **Wekelijks rapport**: zondag 17:00 via email + in-app, naar alle ADMIN_ROLES
- **Dagelijks rapport**: bij rode flags via email + in-app, naar alle ADMIN_ROLES
- **Rol-toegang**: alle ADMIN_ROLES krijgen gelijke admin-features (super_admin + admin + manager)
- **Mobile**: responsive (geen PWA)
- **Screenshot bewaartermijn**: 30 dagen
- **Bezwaar-categorieën**: 11 voorlopig, Dave verfijnt later
- **Invul-verplichting**: Optie C (niet blokkerend, alle nudges actief)
- **Klant-detectie**: handmatig door Dave (geen Teamleader-koppeling)
- **GHL no-show flow**: vervangen door API-getriggerde versie bij Fase 2
- **WhatsApp conversaties**: zichtbaar via webhook + 90 dagen sync
- **Conversatie UI**: detail-scherm per lead met tabs (Calls/WhatsApp/Outcome/Notities)
- **Reply mechanisme**: free-text binnen 24u-venster, template buiten

## Start prompt voor Fase 1A sessie

> "Follow-up Module Fase 1A — Foundation + Dashboard bouwen.
>
> Lees eerst CLAUDE.md, TODO-VOLLEDIG.md en het complete plan in `docs/sessie-logs/follow-up-module-plan.md`.
>
> Bevestig dat je de context begrijpt. Dan plan first met gefaseerd commit-plan + smoke tests tussen elke fase, daarna pas bouwen."
