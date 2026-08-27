# Opstartsessie — DEEL 1 fundament (CRM-repo)

**Datum**: 2026-08-27
**Scope**: dit document beschrijft wat er in de `forex-opleiding-interface`-repo
is gebouwd voor het Opstartsessie-project. DEEL 2 (de publieke pagina op
`deforexopleiding.nl`) hoort in de `dfo-website`-repo — zie sectie "Handover
naar dfo-website" onderaan.

## Doel

Publieke kwalificatie + call-inplan-pagina met bron-tracking. Elke link
`https://deforexopleiding.nl/opstartsessie/<bron>` heeft een eigen bron
(nieuwsbrief, romy, dave, opvolging, verlengen, …). De bron reist mee tot
op de afspraak-rij (`follow_up_appointments.booking_source`) + als GHL-tag
(`bron-<slug>`) op het contact.

**Één GHL-agenda** (env `GHL_CALENDAR_ID`) — geen 20 aparte agenda's meer.

## DEEL A — Datamodel

Migratie: [`migrations/046_booking_sources.sql`](../migrations/046_booking_sources.sql)

1. Tabel `public.booking_sources` — `id, slug, label, actief, created_at, updated_at`.
   Slug is `UNIQUE` en `CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$')`.
2. Kolom `public.follow_up_appointments.booking_source text NULL` + partial
   index voor stats-queries.
3. Seed 5 startbronnen (`nieuwsbrief`, `romy`, `dave`, `opvolging`, `verlengen`).
4. RLS: `authenticated read-all`; writes via `service_role` (RBAC-gate zit
   in de API-endpoints).

## DEEL B — Bronnen-tab (Leadsonderhoud)

Nieuwe tab **"Bronnen"** in [`modules/leadsonderhoud.html`](../modules/leadsonderhoud.html)
naast Vragenlijst:

- Lijst uit `booking_sources` (label, slug, status, calls) + onbekende
  slugs (uit `follow_up_appointments.booking_source` die niet in de tabel
  staan) onder een "Onbekend"-badge met een **Registreren**-knop.
- Periode-filter: **Deze week / Deze maand / Alles**.
- Per rij: kant-en-klare link `https://deforexopleiding.nl/opstartsessie/<slug>`
  met **Kopiëren**-knop.
- **Bewerken** (label wijzigen), **Deactiveren/Activeren**.
- **Nieuwe bron toevoegen** (slug + label, actief=true default).
- RBAC: `leads.view` (read) + `leads.update` (write) — spiegelt bestaande
  Vragenlijst-tab.

**API's**:
- `GET  /api/booking-sources-list?periode=week|maand|alles` → lijst + tellingen
- `POST /api/booking-sources-upsert { id?, slug, label, actief }` → toevoegen/bewerken

## DEEL C-API — publieke endpoints (server-to-server)

Auth-pattern volgt `api/lead-melding.js`: **shared secret**
`OPSTARTSESSIE_SECRET` via header `x-internal-token`. Geen browser-CORS —
`dfo-website` proxyt server-side (Vercel serverless in eigen repo).

**Voor Vercel (Sensitive env-var):**
```
OPSTARTSESSIE_SECRET = <random 32+ byte hex, bv. `openssl rand -hex 32`>
```
Backup in 1Password.

### 1) Vrije slots
`GET /api/public-opstartsessie-free-slots?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

- Header `x-internal-token: <OPSTARTSESSIE_SECRET>`.
- Default venster = vandaag t/m +14 dagen. Hard-cap 21 dagen (anti-spoof).
- Wrapt de ene GHL-agenda (`GHL_CALENDAR_ID`); GHL PIT-token blijft server-side.
- Response: `{ slots:[{ date:'YYYY-MM-DD', times:['09:00',…] }], timezone, window }`.
- Fail-soft: bij GHL-fout → 200 met `slots:[]` + `error:'onbeschikbaar'` (UI toont
  lege agenda i.p.v. crash).

### 2) Afspraak boeken (met bron)
`POST /api/public-opstartsessie-book`

Body:
```json
{
  "voornaam": "Anna",
  "achternaam": "de Vries",
  "email": "anna@example.com",
  "telefoon": "+31612345678",
  "scheduledAt": "2026-09-05T13:00:00+02:00",
  "source": "nieuwsbrief",
  "noshow_akkoord": true,
  "durationMinutes": 20
}
```

- Header `x-internal-token: <OPSTARTSESSIE_SECRET>`.
- Doet: `upsert_lead` RPC → GHL-contact-upsert → GHL-appointment + Zoom-link →
  `follow_up_appointments`-rij insert met `booking_source` → fail-soft
  GHL-tag `bron-<slug>`.
- `noshow_akkoord: true` verplicht (€50-no-show-vinkje).
- Response 200: `{ ok:true, appointment_id, ghl_appointment_id, zoom_join_url, source }`.
- Errors: 400 (validatie), 401 (token), 422 (`NO_GHL_CONTACT` / `GHL_CONFIG_MISSING`),
  502 (GHL API-fout met NL-tekst), 503 (secret niet geconfigureerd).

### 3) Vragenlijst-content
Wordt door de publieke pagina **direct uit Supabase** gelezen via de anon-key
(bestaand pattern, zoals de 7-daagse-modal). Slug: **`student`**. Tabel:
`website_quiz_publicaties` waar `is_actueel = true` (jsonb `inhoud`-veld met
vragen + opties). Editor draait op `crm.deforexopleiding.nl/modules/leadsonderhoud.html`
→ tab Vragenlijst.

## Handover naar `dfo-website` (DEEL 2)

De publieke pagina zelf hoort in de `dfo-website`-repo. Wat die repo moet
bouwen:

1. **Route** `/opstartsessie/<bron>` (catch-all) + `/opstartsessie` (bron=`direct`).
2. **Design**: 1-op-1 het goedgekeurde prototype
   (`https://claude.ai/code/artifact/64399bc4-c780-44b4-8d46-89f07493d183`).
   Split-layout foto + glaskaart | vragen-card. Navy `#0a2f63`,
   actie `#1473d6`, accent `#1f9fe0`. Fonts: Space Grotesk + Inter.
   Pill-antwoorden, progress-balk, €50-no-show met uitleg, 14-dagen-agenda,
   neutrale afwijzing.
3. **Flow**:
   - Slug uit URL → onthoud in state (`source`).
   - Vragen lezen: anon-Supabase op `website_quiz_publicaties.slug='student'`.
   - Scoring: één `afwijzer:true` → afgewezen (neutrale afsluiting, geen agenda).
     Anders `som(punten) ≥ drempel` (12) → gekwalificeerd.
   - Contactgegevens (naam/mail/telefoon) → €50-no-show-vinkje → agenda.
   - Agenda: `GET https://crm.deforexopleiding.nl/api/public-opstartsessie-free-slots`
     (via server-side proxy die `x-internal-token: OPSTARTSESSIE_SECRET` toevoegt).
   - Boeken: `POST https://crm.deforexopleiding.nl/api/public-opstartsessie-book`
     (idem via proxy, met alle body-velden hierboven).
4. **Env**: `OPSTARTSESSIE_SECRET` in de `dfo-website` Vercel-vars (dezelfde
   waarde als in de CRM).

## Constraints bevestigd
- **0 incasso-writes** ✅
- **Incasso-zone onaangeroerd** ✅ (`finance.html`, `*dunning*`, `*arrangement*`,
  `pending-action*`, `_lib/dunning-*`)
- **Één GHL-agenda** ✅ (env `GHL_CALENDAR_ID`)
- **RBAC Bronnen-tab** ✅ (`leads.view` / `leads.update`)
