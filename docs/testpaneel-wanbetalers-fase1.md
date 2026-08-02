# Testpaneel Wanbetalers — Fase 1 (foundation)

**Live op:** `/modules/wanbetalers-test.html` (super_admin only)

**Doel:** één aparte pagina die de bestaande 13 sandbox-endpoints bundelt onder één
super_admin-only paneel, met sticky DRY-RUN + test-ontvanger indicator.
**Nul nieuwe endpoints. Nul executor-wijzigingen. Nul cron-wijzigingen.**

## Wat fase 1 doet

- Nieuwe pagina `/modules/wanbetalers-test.html` (fysiek gescheiden van
  `/modules/wanbetalers.html`) — voorkomt dat een test-knop ooit naast een
  echte-klant-actie belandt.
- Sticky top-strip met (a) grote DRY-RUN-badge (groen "VEILIG" of rood
  pulsende "LIVE") en (b) huidige test-ontvanger (`sandbox_contact.phone`
  + `sandbox_contact.email`), plus (c) mismatch-badge als
  `sandbox_contact` en `customers.is_test=true.phone/email` niet matchen.
- Sectie 1: **Test-ontvanger opslaan** — schrijft naar
  `app_settings.dunning_sandbox_contact` én synct naar de test-klant via
  `wanbetalers-sandbox-seed` (upsert-pad).
- Sectie 2: **Seed-scenario** — 3 keuzes:
  - "1 factuur, 1 dag te laat" (workflow *Aanmaningen*)
  - "3 facturen, 14 dagen te laat" (workflow *Multi-factuur-aanmaning*)
  - "Custom" — eigen `invoice_count` / `days_overdue` / `amount`
  - Knop "Reset + Seed" én aparte "Alleen wissen (reset)" met bevestig-modal.
- Sectie 3: **Stap-voor-stap acties** — 1 kaart per bestaand endpoint:
  - `run-engine` · `fast-forward` (met dagen-input) · `simulate-inbound`
    (met tekst-input) · `mark-paid` · `run-breach-check` ·
    `run-conversation-reminders` · `oefengesprek-reset` ·
    `simulate-credit-round` · `run-bulk` (met template-dropdown dag7/14/17/21/37)
  - Elke actie toont een raw-response viewer onderaan de sectie.
  - Elke send-actie (run-engine / run-bulk / conv-reminders) triggert bij
    DRY-RUN=UIT eerst een confirm-modal met contact-preview.
- Sectie 4: **Live status** (auto-refresh 5s via `wanbetalers-sandbox-status`):
  - Test-klant + id
  - Pipeline-fase + laatst-gewisseld
  - Test-facturen (nummer / status / open / vervaldatum / `is_test`-vlag)
  - Conversations (nummer / status / last_inbound / last_message)
  - Meta-counts (globale `is_test`-totalen — verificatie dat reset compleet is)

## DRY-RUN toggle (twee-staps)

- **AAN → UIT** (gevaarlijker): modal met contact-preview en waarschuwing;
  bevestig met knop; typ dan exact `LIVE SEND AAN`; pas dan gaat de PATCH.
- **UIT → AAN** (veiliger): één-staps confirm.
- Rode pulsende badge blijft bovenaan zichtbaar zolang UIT is.

## Veiligheids-invariant: paneel opent ALTIJD in DRY-RUN=AAN

Bij het openen van het paneel wordt **onvoorwaardelijk** een
`POST /api/wanbetalers-sandbox-set-dry-run { enabled: true }` uitgevoerd,
ongeacht wat de serverstate op dat moment was. Idempotent (AAN → AAN is
no-op). Als de vorige staat UIT was, verschijnt boven het paneel een
groene notice-strip "DRY-RUN was UIT bij openen — automatisch teruggezet
naar AAN". Auto-hide na 12s.

Fail-safe: als deze forced-set faalt (netwerkfout, endpoint down), wordt
het paneel-actieoppervlak verborgen en toont het gate-blok "kon
veiligheidsstand niet forceren — herlaad de pagina". Beter niet openen
dan per ongeluk LIVE laten staan.

**Waarom deze extra stap:** de fail-safe in `dunning-dry-run.js` geldt
alleen bij missende key of DB-fout. Als iemand ooit
`dunning_dry_run.enabled=false` in `app_settings` heeft laten staan (bv.
na een live-test en tab geclosed), was dat de staat voor de volgende
sessie. Met deze force op page-load wordt die staat bij elke fris-open
weer op AAN gezet.

## Wat fase 1 NIET doet

- **Geen nieuwe API-endpoints** — hergebruikt alle bestaande
  `api/wanbetalers-sandbox-*.js` endpoints (13 stuks) zonder shape-verandering.
- **Geen wijziging aan productie-executor** —
  [api/_lib/dunning-step-executors.js](../api/_lib/dunning-step-executors.js)
  is byte-voor-byte identiek.
- **Geen wijziging aan engine / guards / cron**:
  - [api/_lib/dunning-engine.js](../api/_lib/dunning-engine.js) — ongewijzigd
  - [api/_lib/dunning-dry-run.js](../api/_lib/dunning-dry-run.js) — ongewijzigd
  - [api/_lib/wanbetalers-sandbox.js](../api/_lib/wanbetalers-sandbox.js) — ongewijzigd
  - [vercel.json](../vercel.json) — ongewijzigd
- **Geen individuele email-template-testknop** — komt in fase 2 (combined
  email + WA test naar zelfde nummer).
- **Geen scripted flows** (single/multi/arrangement) — komt in fase 3.
- **Geen realtime-log-timeline in het paneel** — komt in fase 4.

## Veiligheidslagen — status in fase 1

| Laag | Status | Toelichting |
|---|---|---|
| 1 — Auth (`requireSuperAdmin`) | ✅ actief | Bestaand op alle 13 endpoints. UI-check via `AuthShared.requireAuth()` + `profile.role==='super_admin'` gate op paneel-render. |
| 2 — SQL-scope (`is_test=true`) | ✅ actief | Bestaand: `runEngine({scope:'test'})`, alle sandbox-endpoints filteren `is_test=true`. |
| 3 — Recipient-guard (`assertRecipientMatchesSandbox`) | ✅ actief | Bestaand in executor, ongewijzigd. Werkt automatisch omdat elke test-send door dezelfde executor loopt. |
| 4 — DRY-RUN default AAN (fail-safe) | ✅ actief | Bestaand: `isDryRunEnabled()` returnt AAN bij missende key/DB-fout. Paneel toont dit prominent en vraagt 2-staps bevestiging om te wisselen. |
| 5 — UI context-pin | 🟡 gedeeltelijk | Mismatch-badge zichtbaar als `sandbox_contact` ≠ `customers.is_test.phone/email`. Volledige context-pin (verify vóór send met live sandbox_contact read) komt in fase 2. |

## Verificatie-checklist (20 punten)

### A — Super_admin gate
- [ ] Uitgelogd → `/modules/wanbetalers-test.html` → redirect naar
      `/login.html?returnTo=/modules/wanbetalers-test.html`
- [ ] Ingelogd als niet-super_admin (bv. `manager`) →
      `/modules/wanbetalers-test.html` → "Alleen super_admin heeft toegang"
- [ ] Niet-super_admin bekijkt `/modules/wanbetalers.html` → GEEN
      "🧪 Testpaneel"-link in de page-header
- [ ] Ingelogd als super_admin → paneel laadt succesvol
- [ ] `curl -X POST /api/wanbetalers-sandbox-status` zonder JWT → 401/403

### B — DRY-RUN standaard AAN
- [ ] Open paneel na `dunning_dry_run`-key verwijderen uit `app_settings`
      → top-strip toont 🟢 "VEILIG — DRY-RUN staat AAN"
- [ ] Klik "Engine draaien" bij DRY-RUN=AAN → geen 2-staps confirm nodig,
      response OK, geen echte send
- [ ] Wissel DRY-RUN → UIT: eerste modal komt met contact-preview; klik
      door; tweede modal komt met typebevestiging; button pas actief bij
      exacte `LIVE SEND AAN`

### C — Test-ontvanger prominent
- [ ] Top-strip toont phone + email uit `dunning_sandbox_contact`
      continu, ook bij scrollen (sticky)
- [ ] Bij mismatch `dunning_sandbox_contact.phone` vs
      `customers.is_test.phone`: oranje ⚠️-badge zichtbaar
- [ ] Nieuwe seed met nieuw nummer → top-strip refresht binnen 5s met
      nieuw nummer (polling)

### D — Test-data gescheiden
- [ ] `SELECT count(*) FROM customers WHERE is_test=true` = 1 na seed
- [ ] `SELECT count(*) FROM invoices WHERE is_test=true` = N (per seed)
- [ ] Klik "Engine draaien" → check dat nieuwe rijen in
      `dunning_workflow_runs` alleen bestaan voor test-customer_id
- [ ] `SELECT count(*) FROM dunning_workflow_runs WHERE customer_id NOT IN
      (SELECT id FROM customers WHERE is_test=true) AND created_at > <voor-test>`
      = 0
- [ ] `SELECT count(*) FROM invoices WHERE is_test=false AND updated_at >
      <voor-test>` = 0

### E — Geen echte sends bij DRY-RUN=AAN
- [ ] Klik "Bulk aanmaning_dag7" bij DRY-RUN=AAN → `dunning_log` krijgt
      event met `payload.dry_run=true`, geen Meta-call in de netwerk-tab
- [ ] Klik "Engine draaien" bij DRY-RUN=AAN → geen WhatsApp op je
      telefoon binnen 30s

### F — Executor + productie-cron ongewijzigd
- [ ] `git diff main -- api/_lib/dunning-step-executors.js` → geen output
- [ ] `git diff main -- api/_lib/dunning-engine.js api/_lib/dunning-dry-run.js api/_lib/wanbetalers-sandbox.js vercel.json` → geen output

## Vervolgfases (nog niet gebouwd)

- **Fase 2** — ontbrekende scenario's + 5e guard-laag: preset
  "1-dag-te-laat" al gedaan; individuele email-template-testknop;
  gecombineerde email+WA test naar zelfde nummer; volledige UI-context-pin.
- **Fase 3** — scripted flows (macro-endpoints): `sandbox-flow-single`,
  `sandbox-flow-multi`, plus extra nuttige flows (arrangement-flow).
- **Fase 4** — realtime log-timeline in paneel, verwachte-vs-werkelijke
  checklist per scripted flow, JSON-export voor bug-reports.
