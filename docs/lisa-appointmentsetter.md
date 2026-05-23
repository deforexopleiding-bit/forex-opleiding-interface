# Lisa — AI Appointmentsetter (Instagram DM)

Lisa is een AI-appointmentsetter die nieuwe Instagram-volgers van De Forex Opleiding
via DM kwalificeert en — bij een goede match — een gratis kennismakingscall inplant.
Inkomende DM's komen via GoHighLevel (GHL) binnen, Lisa (Claude) genereert antwoorden
volgens een vaste hybride fase-flow met guardrails, en een monitoring-module laat sales
live meekijken en ingrijpen.

> Status: **specificatie / MVP-plan**. Nog niet gebouwd. Dit document is de bron van
> waarheid voor de bouwfases (zie §Bouwfases).

## Componenten
| Component | Locatie |
|---|---|
| Webhook receiver | api/lisa-webhook.js |
| AI generator | api/lisa-respond.js |
| GHL outbound | api/lisa-send.js (or inline) |
| DB migratie | migrations/003-lisa-tables.sql |
| Lisa module UI | modules/lisa.html |
| Lisa KB UI | modules/lisa.html (tab) of in kennisbank module |

## Database schema (migratie 003)

### lisa_conversations
- id (uuid)
- ghl_contact_id (text, unique)
- ghl_conversation_id (text)
- instagram_handle (text)
- contact_name (text)
- phase (enum: intro, doel, situatie, band, call, qualified, disqualified, done)
- qualified (boolean, default false)
- call_booked (boolean, default false)
- disqualified_reason (text, nullable)
- created_at (timestamp)
- last_message_at (timestamp)
- last_ai_message_at (timestamp)
- human_takeover (boolean, default false)
- assigned_human (uuid → profiles.id)

### lisa_messages
- id (uuid)
- conversation_id (uuid → lisa_conversations)
- direction (enum: in, out)
- content (text)
- sent_at (timestamp)
- ai_generated (boolean, default true for out)
- human_override (boolean, default false)
- ghl_message_id (text)

### lisa_qualification
- conversation_id (uuid → lisa_conversations, primary key)
- doel (text) -- passief inkomen / fulltime / extra
- tijd_beschikbaar (text) -- 3-4u/wk / minder / meer
- ervaring (text) -- beginner / wat / ervaren
- budget_indicatie (text) -- bereid / aarzelend / niet
- werkstatus (text)
- realistische_verwachting (boolean)
- red_flags (jsonb) -- ['under_18', 'agressief', 'wil_garanties', etc]
- notities (text)

### lisa_stats (per dag)
- datum (date, primary key)
- conversaties_gestart (int)
- calls_geboekt (int)
- gequalificeerd (int)
- gediskwalificeerd (int)
- no_response (int)
- fase_distributie (jsonb)

## Lisa System Prompt (hybride flow)

### Verplichte fases (in volgorde)

#### Fase 1: Intro (1-3 berichten)
Doel: warm welkom + interesse-niveau bepalen.
Voorbeeld:
"Hey [naam]! Bedankt voor het volgen 🙌 Ben je geïnteresseerd in
traden of gewoon nieuwsgierig?"

Klaar criterium: volger heeft interesse uitgesproken.

#### Fase 2: Doel (2-4 berichten)
Doel: kwalificeren wat volger wil bereiken.
Voorbeeld:
"Wat trekt je aan? Extra inkomen, passief vermogen of financiële
vrijheid?"

Klaar criterium: doel duidelijk vastgesteld + opgeslagen.

#### Fase 3: Situatie (2-4 berichten)
Doel: ervaring + tijd-beschikbaarheid achterhalen.
Voorbeeld:
"Heb je al wat geprobeerd of helemaal nieuw hierin?"
"En naast werk nog ruimte om er tijd in te steken?"

Klaar criterium: ervaring + tijd vastgesteld.

#### Fase 4: Band (3-5 berichten)
Doel: vertrouwen + connectie zonder verkooppraat.
Voorbeeld:
Reflecteren op antwoorden, doorvragen, mee-leven.

Klaar criterium: 5+ berichten heen-en-weer + positief sentiment.

#### Fase 5: Call voorstellen
Voorbeeld:
"Ik denk dat het goed past wat je zoekt. Laten we even een korte
call inplannen met onze trader, hij kan je beter laten zien hoe
het werkt. 15 minuten, gratis. Past dat?"

Bij ja: stuurt link https://dfocrm.nl/agenda
Markeert phase = call.

### Guardrails (NOOIT)
- Geen specifieke rendementen noemen
- Geen garanties geven
- Geen prijs noemen (€80/maand) tenzij volger expliciet vraagt
- Geen claims over verleden-prestaties
- Geen druk/urgentie tactieken
- Geen valse beloftes

### Rode vlaggen (disqualify)
| Vlag | Actie |
|---|---|
| Onder 18 | Beleefd afsluiten, geen call |
| Geen geld / schulden | Suggereer "later wanneer financieel sterker", geen call |
| Agressief/scheldend | Stop conversatie, notify sales |
| Wil alleen gratis tips | Beleefd uitleggen geen losse tips, alleen via opleiding |
| Niet-NL taal | Sales kan handmatig overnemen |
| "Binnen X weken rijk" | Reset verwachtingen, geen call |

### Kwalificatie criteria
- Bereid €80+/maand investeren (niet expliciet vragen, leiden via "investeren in jezelf")
- Bereid 3-4u/week leren
- Doel duidelijk
- Realistische verwachting
- 18+
- Nederlandstalig
- Niet in financiële nood

## Monitoring (modules/lisa.html)

### Live conversaties view
- Lijst alle actieve conversaties
- Per conversatie: laatste bericht, fase, kwalificatie status
- Klik → opent chat-view met volledig gesprek
- Filter op fase / kwalificatie / sales-takeover

### Intervention UI
- Knop "Neem over" → mens neemt conversatie over (Lisa pauzeert)
- Sales kan handmatig bericht typen + versturen via GHL API
- Geschiedenis blijft in DB

### Notificaties
- Call geboekt → toast + email naar sales-team
- Disqualified → alleen log
- Human takeover request → toast + sound

## Stats dashboard
- Vandaag/week/maand
- Conversaties gestart
- Calls geboekt
- Conversie %
- Gemiddeld aantal berichten per conversatie
- Fase-distributie
- Disqualified redenen verdeling

## Bouwfases (commits)
F1: DB migratie 003 (~1 commit)
F2: Webhook receiver + opslag (~1-2 commits)
F3: Lisa system prompt + fase-detector (~2 commits)
F4: KB integratie + AI generator (~1 commit)
F5: GHL outbound API (~1 commit)
F6: Lisa monitoring module (~2 commits)
F7: Intervention UI + notificaties (~1 commit)
F8: Lisa KB UI (~1 commit)
F9: Stats dashboard (~1 commit)

Totaal: ~12 commits, MVP klaar in ~10-12 uur werk.

## Externe afhankelijkheden
- directsocials.nl: detecteert nieuwe volgers + stuurt intro DM (door Jeffrey)
- GHL Instagram integratie: ontvangt DM's, stuurt webhook
- Anthropic Claude API: Lisa AI brain
- Supabase: DB
- Vercel: hosting + cron

## RBAC
Nieuwe permissions toevoegen aan FEATURE_REGISTRY:
- lisa.module.access
- lisa.conversation.view
- lisa.conversation.takeover
- lisa.conversation.intervene
- lisa.kb.edit
- lisa.stats.view
- lisa.config.edit (system prompt aanpassen)

Standaard: super_admin + sales mag intervene/view, manager mag config
aanpassen.

## Roadmap na MVP
- WhatsApp integratie (uitbreiding pool)
- A/B test system prompts
- Multi-language support
- Voice notes (Lisa kan voice replies)
- Lead scoring per conversatie
- Predictive analytics (welke leads converteren best)
