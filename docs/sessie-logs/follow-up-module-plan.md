# Follow-up Module — Volledig project plan

> Quick Win #1 voor De Forex Opleiding (Jeffrey Biemold).
> Doel: volledige follow-up flow voor sales calls die via
> GoHighLevel + Zoom worden ingepland.

## Economische onderbouwing

- 50-100 calls per maand
- Gemiddelde klantwaarde €4000 (range €2880-€12000)
- Huidige no-show rate: ~25%
- Huidige conversie call → klant: ~25%
- Doel no-show recovery: 33% (van 25 → 8 extra effectieve calls/mnd)
- Doel conversie verbetering: 25% → 33% (+8 klanten/mnd)
- Extra omzet bij realistische doelen: **+€44.000/maand = €528.000/jaar**
- Conservatieve schatting bij halve resultaten: +€264.000/jaar

## Hoofdflow — 3 follow-up momenten

1. **Pre-call** (2u voor de call): warm voicememo van Dave
2. **No-show** (10 min over tijd): direct WhatsApp + 24u later opnieuw
3. **Post-call niet-koper**: gestructureerde drip-campagne op basis van bezwaar + warmte

## Pre-call: voicememo strategie

### Definitieve beslissing (na lange brainstorm)

- Dave neemt voicememo **handmatig** vanaf eigen telefoon
- Module dient als verplicht afvinkpunt + accountability
- Geen automation vanaf Dave's persoonlijke WhatsApp (ban-risico bij Meta detection)
- Geen AI-stem klonen (ethisch + reputatie-risico in financiële sector)

### Waarom handmatig via Dave's eigen telefoon

- WhatsApp Business API automation = afzender wordt "De Forex Opleiding" niet "Dave persoonlijk"
- WhatsApp Coexistence Mode (zowel API als app op zelfde nummer) is **NIET beschikbaar voor EU/NL nummers** (verified bij Meta docs)
- Dave's 1-tap actie per call (~2 sec) is geen probleem bij 5/dag volume
- Persoonlijke ervaring voor lead = warmer + hogere conversie

### Dave's workflow per dag

's Ochtends (09:00 of bij eerste login) krijgt Dave de lijst van calls van die dag via:
- WhatsApp notificatie (via Business API geverifieerd nummer)
- Email
- In-module dashboard view

Per call moet Dave:
1. Voicememo opnemen op eigen telefoon (via WhatsApp Business App naar lead's nummer)
2. In module aanvinken "voicememo verstuurd"
3. Steekproefgewijs (3e, 8e, 13e... met willekeurig interval) screenshot uploaden als bewijs

### Steekproef-logica

- Dave's afvink-teller per dag begint op 0
- Op de 3e, 8e, 13e (random tussen elke 3-5) afvinking: screenshot upload **verplicht**
- Dave kan niet verder afvinken zonder screenshot
- Screenshot upload via mobile of laptop

### Screenshot review

**Optie D gekozen:** AI Haiku eerste check + Jeffrey alleen verdachte cases.

Haiku analyseert:
- Is het een WhatsApp screenshot?
- Met verzonden voicememo (microfoon-icoon zichtbaar)?
- Naar juiste lead-nummer (match met appointment)?
- Op juiste tijd (binnen 30 min van verwachte verzending)?

Bij OK → groen vinkje, geen actie.
Bij verdacht → notificatie naar Jeffrey voor handmatige review.

## No-show automation

### Detectie

- Lead is "no-show" als 10 min na call-start tijd niet in Zoom is verschenen
- Zoom webhooks gebruikt: `meeting.started`, `meeting.participant_joined`
- Match Zoom meeting ID met GHL appointment in database
- Trigger no-show flow als geen participant joined binnen 10 min

### Automatische acties bij no-show

- **T+10min**: WhatsApp via Business API "Hey {naam}, je had een call met ons om {tijd}. Geen probleem - hier kun je een nieuwe inplannen: {link}"
- **T+10min**: Email met zelfde boodschap
- **T+24u**: WhatsApp herinnering + email
- Beide via geverifieerd bedrijfsnummer (**niet** Dave's persoonlijke)
- Pre-call reminders blijven via bestaande GHL automation (2u, 10min, bij start) — niet aanraken

## Post-call invul-flow

Na elke call moet Dave invullen (sterk geadviseerd, niet hard verplicht).

### Velden

**Uitkomst** (single select):
- Klant geworden
- Follow-up nodig (warme lead)
- No-show (geen reactie tijdens call)
- Niet relevant voor follow-up (slechte fit, niet ICP)
- No-decision yet (denkt erover na)

**Bezwaar** (multi-select, alleen bij follow-up/no-decision):
- Te duur
- Timing niet goed
- Partner overleg
- Twijfel winstgevendheid
- Technische zorgen
- Anders: ___ (vrij tekst)

**Volgende actie**:
- Bellen op datum
- Email sturen
- Event-uitnodiging
- Sluiten zonder follow-up

**Overige velden**:
- Wanneer terugkomen: datum picker (optioneel)
- Warmte: 1-10 score (hoe waarschijnlijk koopt deze nog)
- Korte notitie: vrij tekstveld

### Uitzondering

"Niet relevant voor follow-up" → lead wordt **uitgesloten** van alle automatische follow-up drip-campagnes. Reden wordt wel bijgehouden voor data-analyse.

## Follow-up drip campagnes (niet-kopers)

### Trigger

Post-call invul met "Follow-up nodig" of "No-decision yet" + warmte ≥ 5 + niet "niet relevant".

### Campagne-varianten per bezwaar-categorie

- **Te duur**: 3-mail sequentie over ROI + betalingsplan
- **Timing**: 2-week follow-up + 1-maand check-in
- **Partner overleg**: helpdesk-content + getuigenissen
- **Twijfel winstgevendheid**: case studies + Trustpilot reviews

### Kanaal

- Email + WhatsApp via Business API (geverifieerd bedrijfsnummer)
- Niet via Dave's persoonlijke telefoon (volume te hoog)
- Bestaande GHL contacts geüpdatet met tags

### Escalatie

- Bij warmte ≥ 8 of expliciete reply: notificatie naar Dave
- Dave kan dan persoonlijk overnemen (voicememo, bel)

## Externe systemen stack

### Bevestigd beschikbaar

- **GoHighLevel**: Agency Pro account
  - V2 API beschikbaar (Calendar, Contacts, Webhooks endpoints OK)
  - Private Integration Tokens kunnen worden aangemaakt
  - Custom field updates mogelijk
- **Zoom**: Pro account
  - Webhooks ondersteund: meeting.started, meeting.ended, meeting.participant_joined, meeting.participant_left
  - Marketplace App aanmaken voor webhook configuratie
- **WhatsApp Business API**: actief via GHL relatie
  - Geverifieerd bedrijfsnummer beschikbaar
  - Template berichten en automation reeds in gebruik
- **Teamleader**: voor klant-conversie data (klanten worden hierin vastgelegd via offertes)
- **Supabase Pro**: 8GB plan, voor onze module-data

### Niet via dit systeem

- Dave's persoonlijke telefoon: alleen handmatige voicememo's vanaf eigen WhatsApp (niet via API)

## Database schema (te bouwen in Fase 1)

### follow_up_appointments

| Kolom | Type | Omschrijving |
|-------|------|--------------|
| `id` | uuid | Primary key |
| `ghl_appointment_id` | string, unique | GHL calendar event ID |
| `zoom_meeting_id` | string, nullable | Zoom meeting ID |
| `lead_name` | text | Naam lead |
| `lead_email` | text | Email lead |
| `lead_phone` | text | Telefoonnummer lead |
| `lead_ghl_contact_id` | string | GHL contact ID |
| `scheduled_at` | timestamp | Geplande tijd |
| `duration_minutes` | int | Duur in minuten |
| `status` | enum | scheduled / in_progress / completed / no_show / cancelled |
| `voicememo_status` | enum | pending / sent / skipped |
| `voicememo_sent_at` | timestamp, nullable | Tijdstip verzending |
| `voicememo_sent_by` | text, default 'Dave' | Wie heeft verzonden |
| `requires_screenshot` | boolean | Steekproef verplicht |
| `screenshot_url` | text, nullable | URL bewijs-screenshot |
| `screenshot_uploaded_at` | timestamp, nullable | Upload tijdstip |
| `created_at`, `updated_at` | timestamptz | Metadata |

### follow_up_outcomes

| Kolom | Type | Omschrijving |
|-------|------|--------------|
| `id` | uuid | Primary key |
| `appointment_id` | uuid, FK | Koppeling aan appointment |
| `outcome` | enum | Uitkomst call |
| `bezwaren` | text[] | Geselecteerde bezwaren |
| `volgende_actie` | enum | Vervolgactie |
| `terugkom_datum` | date, nullable | Geplande terugkomst |
| `warmte_score` | int 1-10, nullable | Koopwaarschijnlijkheid |
| `notitie` | text, nullable | Vrije notitie |
| `ingevuld_door` | text | Naam invuller |
| `ingevuld_at` | timestamp | Invultijdstip |

### follow_up_messages_sent

| Kolom | Type | Omschrijving |
|-------|------|--------------|
| `id` | uuid | Primary key |
| `appointment_id` | uuid, FK | Koppeling |
| `channel` | enum | whatsapp / email / voicememo_manual |
| `type` | enum | no_show_immediate / no_show_24h / follow_up_drip / pre_call_reminder |
| `sent_at` | timestamp | Verzenddatum |
| `ghl_message_id` | string, nullable | GHL bericht ID |
| `response_received` | boolean | Reactie ontvangen? |
| `response_at` | timestamp, nullable | Tijdstip reactie |

### follow_up_events_log

| Kolom | Type | Omschrijving |
|-------|------|--------------|
| `id` | uuid | Primary key |
| `source` | enum | ghl / zoom / manual |
| `event_type` | string | Type event |
| `payload` | jsonb | Volledige event payload |
| `received_at` | timestamp | Ontvangstijdstip |
| `processed` | boolean | Verwerkt? |

### follow_up_screenshot_audit

| Kolom | Type | Omschrijving |
|-------|------|--------------|
| `id` | uuid | Primary key |
| `dave_user_id` | string | Dave's user ID |
| `screenshot_url` | text | Screenshot URL |
| `appointment_id` | uuid, FK | Koppeling |
| `ai_review_result` | enum | ok / suspicious / missing |
| `jeffrey_reviewed` | boolean, default false | Handmatig nagekeken? |
| `review_notes` | text, nullable | Opmerkingen Jeffrey |
| `uploaded_at` | timestamp | Upload tijdstip |

### RLS

- Dave (sales role) ziet alleen eigen voicememo workflows + leads
- Jeffrey (admin) ziet alles
- Niet relevant voor mentoren/administratie

## Fase planning

### Fase 1 — Detectie + Visibiliteit (1 week werk, ~5-7 uur Claude Code)

**Doel**: data komt binnen, dashboard toont status, geen automation.

- GHL connector endpoint (Calendar polling elke 15 min)
- Zoom webhook ontvanger endpoint
- Database schema aanmaken
- `/modules/follow-up.html` dashboard
  - Vandaag's lijst met voicememo afvinklijst
  - Aankomende week overzicht
  - Jeffrey ziet alle Dave's activiteit
  - Mobile-first design (Dave gebruikt telefoon)
- No-show detectie logica (10 min over tijd flag)
- Steekproef-screenshot logica + upload UI

### Fase 2 — No-show automation (3-5 dagen)

- WhatsApp + Email automation bij T+10min
- 24u herinnering
- GHL contact tag updates
- Verificatie geen race-condities

### Fase 3 — Post-call invul flow (3-5 dagen)

- Modal/form na elke completed call
- Bezwaar-tracking database
- "Niet relevant" exclusion logic
- Screenshot upload + AI review (Haiku)
- Jeffrey notificatie bij verdachte screenshots

### Fase 4 — Follow-up drip campagnes (1 week)

- Drip-campagne templates per bezwaar-categorie
- WhatsApp + Email via Business API
- Warmte-gebaseerde escalatie
- Jeffrey notificatie bij hot leads
- Reply detectie en handoff

## Pre-work voor Jeffrey (vóór Fase 1 implementatie)

### 1. GoHighLevel Private Integration Token (5-10 min)

- Login GHL → Settings → Private Integrations
- Token aanmaken met scopes:
  - `contacts.readonly`
  - `calendars.readonly`
  - `calendars/events.readonly`
  - `conversations.readonly`
  - `conversations/message.write`
- Vercel env var: `GHL_API_KEY`

### 2. Zoom Marketplace App (10-15 min)

- marketplace.zoom.us → Develop → Build App
- Type: "Server-to-Server OAuth"
- Naam: "De Forex Opleiding Follow-up"
- Webhooks aanzetten voor:
  - meeting.started
  - meeting.ended
  - meeting.participant_joined
  - meeting.participant_left
- Webhook URL: `https://forex-opleiding-interface.vercel.app/api/zoom-webhook`
- Vercel env vars: `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET`

### 3. WhatsApp templates voorbereiden (via GHL)

- No-show direct template
- No-show 24u herinnering template
- Pre-call dagelijkse lijst voor Dave template
- Goedkeuring door Meta vragen (1-7 dagen verwerking)

## Afhankelijkheden

### Vereist af voor Fase 1 start

- Auth Fase A+B+C+D+E volledig live ✓ (15 mei 2026)
- Dave heeft een sales role account ✓ (15 mei 2026)
- Jeffrey kan via admin panel Dave's account beheren ✓
- RLS werkt op bestaande tabellen (Fase D voltooid) ✓ (17 tabellen)

**Reden**: module heeft user-context nodig (Dave logt in, ziet eigen workflow), mobile-first design vereist sessie-management, screenshot uploads moeten aan user gekoppeld worden, Jeffrey notificaties hebben admin-context nodig.

## Tijdsbudget totaal

| Fase | Claude Code tijd | Doorlooptijd |
|------|------------------|--------------|
| Voorbereidings-werk Jeffrey | ~30-45 min | — |
| Fase 1 | 5-7 uur | 1 week |
| Fase 2 | 3-4 uur | 3-5 dagen |
| Fase 3 | 3-4 uur | 3-5 dagen |
| Fase 4 | 5-7 uur | 1 week |
| **Totaal** | **~16-22 uur** | **3-4 weken** |

## Success metrics

Maandelijks meten:

- % calls met voicememo verzonden (target: 95%+)
- % screenshots succesvol bij steekproef (target: 100%)
- No-show recovery rate (target: 33%)
- Conversie call → klant (target: 25% → 33%)
- Aantal hot leads via drip naar Dave (track in dashboard)
- Extra omzet via follow-up (target: +€44k/maand)

## Openstaande vragen voor eerste Fase 1 sessie

1. WhatsApp template content schrijven (no-show, 24u, daily lijst)
2. Exacte tijd dagelijkse notificatie naar Dave (08:30 / 09:00 / 06:00?)
3. Mobile-first design: PWA installeerbaar of mobile-responsive genoeg?
4. Screenshot bewaartermijn (voor audit): 30 dagen? 90 dagen? Voor altijd?
5. Bezwaar-categorieën: zijn er nog meer specifiek voor forex opleiding sector?

## Start prompt voor Fase 1 sessie

Wanneer Auth is afgerond en Fase 1 start, gebruik:

> "Follow-up Module Fase 1 — Detectie + Visibiliteit bouwen.
>
> Lees eerst CLAUDE.md, TODO-VOLLEDIG.md en het complete follow-up plan in `docs/sessie-logs/follow-up-module-plan.md`.
>
> Bevestig dat je de context begrijpt, beantwoord de 5 openstaande vragen door me te vragen, daarna plan first voordat je gaat bouwen."
