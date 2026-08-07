# Migratie-map — prototype naar productie

Één-op-één mapping van elke module uit `docs/redesign/systeemprototype-v45.html` (`MODS`-array regel 1067-1099, 25 modules) tegen wat er nu al in de repo staat. Doel: exact weten wat er per module verandert, welke bestaande code we hergebruiken, en een reëel PR-aantal zodat we niet dubbel of onnodig werken.

**Bronnen die dit document consumeert**:
- [REDESIGN-BOUWPLAN.md](REDESIGN-BOUWPLAN.md) — het contract (wat & waarom per module)
- [SYSTEEMKAART.md](SYSTEEMKAART.md) — bestaand systeem-overzicht + Bijlage 3 wanbetalers protected zone + Bijlage 4 softphone
- [INVENTARIS.md](INVENTARIS.md) (branch `docs/redesign-inventaris-fase1`, PR #1111) — 1230 items Sales/Klanten/Finance/Wanbetalers
- `systeemprototype-v45.html` — exacte UI/interactie-spec

**Wijzigings-typen**:
- `[re-skin]` — bestaand scherm, alleen HTML/CSS matcht straks prototype; endpoints + data ongewijzigd.
- `[re-skin+]` — re-skin plus 1-3 UI-features toevoegen (nieuwe filter, kolom, actie).
- `[nieuw scherm op bestaande data]` — nieuwe pagina, alleen bestaande endpoints hergebruiken (geen schema-wijziging).
- `[nieuw scherm + nieuwe data]` — nieuwe pagina EN nieuwe tabel/velden nodig.
- `[alleen inhangen]` — externe link of pure aggregator zonder eigen data.

**Nul code-wijzigingen in deze PR** — puur mapping-document.

---

## Fundament (geen module, wél voorwaarde)

Fase 0 uit REDESIGN-BOUWPLAN — sinds gemerged / in-progress:
- **PR 0-A** ✅ gemerged: bouwplan + prototype in de repo
- **PR 0-B1** ✅ gemerged: `tokens.css` prototype-pariteit
- **PR 0-B2** 👉 volgend: app-shell primitives + demo-harness — sidebar/topbar/tab-balk/paneel/modal + `openPanel/closePanel/stepRow`, rol-render uit `MODS` + `TAB_RESTRICT` + `MOD_LOCK`, dark-mode toggle, mobiel `100dvh`/`env(safe-area-inset-bottom)`/off-canvas sidebar, grid-stacking ≤760px
- **PR 0-C** wachtend: klanten-v2 aanhaken op shared shell (haakt oude eigen sidebar/topbar eruit)
- **PR 0-D** wachtend: `user_roles` many-to-many activeren + auth-helpers migreren + RLS-basis + `admin`/`administratie`/`viewer` opruimen (SYSTEEMKAART Bijlage 2)
- **PR 0-E** 🆕 wachtend: **softphone-extract** — `modules/shared/klx-softphone.js` met publieke API (Bijlage 4 SYSTEEMKAART). Verhuisd uit Klanten en Follow-up naar fundament omdat 4 consumenten hetzelfde script laden (Klanten/Follow-up/Events/Mentoren voor bel-taken).

**Sub-totaal fundament: 6 PR's** (2 gemerged, 4 nog te bouwen).

### Wat CENTRAAL in Fase 0 landt (voor alle latere re-skins)

Deze bouwstenen komen één keer in Fase 0 en worden NIET herhaald per module. Zo blijven de module-re-skins puur markup + module-specifieke logica:

| Bouwsteen | Landt in | Consequentie voor module-PR's |
|---|---|---|
| Design-tokens (8 accents, 3 varianten, dark) | 0-B1 ✅ | Modules gebruiken `var(--<accent>)` — geen eigen kleuren |
| App-shell (sidebar/topbar/tab-balk/paneel/modal + JS helpers) | 0-B2 | Modules leveren alleen content in de shell-slot — geen eigen sidebar |
| Bouwstenen (`kpi/card/pill/table/toolbar/chips/switch/segmented/progress/hbar/funnel/targetGauge/areaChart/dualChart/timeline`) | 0-B2 | Modules importeren als partials — geen eigen `<table>`-styling |
| Rol-gestuurde nav (`MODS`/`TAB_RESTRICT`/`MOD_LOCK` interpretatie) | 0-B2 | Modules registreren zich in `MODS`, shell doet zichtbaarheid |
| Dark-mode toggle (`data-theme` + localStorage, GEEN prefers-color-scheme) | 0-B2 | Modules gebruiken tokens die auto-switchen |
| Mobiele fundamenten (`100dvh`, `env(safe-area-inset-bottom)`, off-canvas sidebar + scrim, grid-stacking ≤760px) | 0-B2 | Modules mogen aannemen dat de shell mobiel-safe is; alleen inline-grids ≤760px overschrijven |
| Softphone-primitieve (`window.KlxSoftphone.open/hangup/isActive/getConfig/onStateChange`) | 0-E | Modules met bel-actie roepen `KlxSoftphone.open(customer)` aan — geen eigen SIP-integratie |
| `user_roles` many-to-many + `verifyAdmin`/`requirePermission`-migratie | 0-D | Modules doen `RBAC.canSync(key)` — architectuur ondersteunt additieve rollen |

**Contract voor elke module-PR na Fase 0**: als je eigen tokens/mobiele-media/dark-mode-CSS/shell/nav-code toevoegt in een module-PR → PR gaat retour. Alles wat gedeeld is, hoort centraal.

---

## Groep Overzicht

### 1. Dashboard (`dashboard`) — alle rollen · tabs [Vandaag]

**Bestaand**:
- `index.html` (1131 regels) — bento-dashboard voor manager/admin/marketing/administratie/viewer
- `modules/super-admin-dashboard.html` — rol-landing voor super_admin
- `modules/sales-dashboard.html` — thin redirect naar `sales.html?tab=dashboard`
- `modules/mentor-home.html` — rol-landing voor mentor
- 15 `api/dashboard-*.js` + `api/super-admin-*.js` endpoints (dashboard-stats, super-admin-omzet, super-admin-leads-by-soort, super-admin-inbox-counts, etc.)

**Type**: `[re-skin + nieuwe UI-feature]` — rol-specifieke inhoud consolideren in één `/index.html`; huidige rol-landings verhuizen naar archief.

**Wat ontbreekt** — per rol een render-tak:
- **sales-tak**: pijplijn/op te volgen — linkt naar Sales/Follow-up/Klanten
- **mentor-tak**: agenda/aandacht-leerlingen/voortgang + onboarding-sectie + reiskosten-herinnering — linkt naar Studenten/Verdiensten/Onboarding
- **manager+SA-tak**: bedrijfsbreed dashboard, "vereist actie"-strip + postvakken — linkt naar Leads/Wanbetalers/Klanten/Finance/Follow-up/Events
- **marketing-tak**: kanaalstats + postplanner-preview — linkt naar Meta Ads/Nieuwsbrief/Leads

**PR-schatting: 4 PR's** — bewust opgesplitst per rol-tak zodat **elke tak pas komt na de modules waar hij naar linkt** (voorkomt dode knoppen):
1. `dashboard-v2 shell + sales-tak` — komt **na Fase 2** (Sales+Finance klaar).
2. `dashboard-v2 mentor-tak` — komt **na Fase 3** (Studenten+Verdiensten+Mentoren+Onboarding klaar).
3. `dashboard-v2 manager+SA-tak` — komt **na Fase 5** (Wanbetalers+alle werkschermen klaar).
4. `dashboard-v2 marketing-tak (placeholder + kanaalstats)` — komt **na Fase 8** (Nieuwsbrief klaar).

**Risico's**: bestaande `super-admin-dashboard.html` / `sales-dashboard.html` / `mentor-home.html` blijven live tot alle 4 PR's mergen. Sales-tak-PR (fase 2) mag al `ROLE_LANDING` in `supabase-client.js` bijwerken voor sales-rol; overige rol-landings verhuizen wanneer hun eigen tak-PR mergedt. Beschermde zone niet relevant.

---

### 2. Inbox (`inbox`) — SAMS (sales vergrendeld) · geen tabs

**Bestaand**:
- Er is **géén** `modules/inbox.html`. De WhatsApp-inboxen leven verspreid: `finance.html` Wanbetalers-tab (Finance-inbox), `events.html` Inbox-tab, `onboarding-hub.html` Overzicht > Inbox, `leadsonderhoud.html` Gesprekken-tab.
- 50 `api/inbox-*.js`-endpoints (inbox-webhook, inbox-messages-list, inbox-conversations-list, inbox-send, inbox-mark-read, inbox-link-conversation-to-*, etc.) — allemaal live.
- Tabel `whatsapp_conversations` gescheiden op `phone_number_id` uit `whatsapp_module_config.module`.

**Type**: `[nieuw scherm op bestaande data]` — centrale aggregator die bovenop bestaande WA-lijnen bouwt. Alle bron-inboxen blijven bestaan in eigen module.

**Wat ontbreekt**:
- Nieuw scherm `modules/inbox-v2/` met kolom-links (bron-filter-chips), midden (item-lijst), rechts (detail-preview via bestaande render-code).
- `MOD_LOCK` voor sales → "binnenkort beschikbaar"-scherm.
- Endpoint `inbox-aggregated-list` (union over WA-lijnen + optionele e-mail) — kan als thin wrapper over bestaande `inbox-conversations-list?module=…`.

**PR-schatting: 2 PR's**
1. `inbox-v2 skelet + WA-aggregator` — hergebruik `inbox-conversations-list` per module, geen nieuwe writes.
2. `inbox-v2 e-mail-integratie + sales-lock-view`.

**Risico's**: geen writes op wanbetalers-endpoints. Wel: nauw luisteren dat mark-read-actie naar juiste bron-endpoint gaat (finance/events/onboarding hebben elk hun eigen `mark_as_read`-hook).

---

### 3. Takenbeheer (`taken`) — alle rollen · tabs [Mijn taken / Team / Afgerond]

**Bestaand**:
- `modules/taken.html` (1797 regels) — kanban Todo/Bezig/Klaar, gefixt op mobiel.
- 7 `api/taken*.js`-endpoints (taken-list, taken (POST/PATCH), taken-comments, etc.).
- Tabel `taken_items` met `customer_id`-FK (mig sinds 2026-05).

**Type**: `[re-skin + nieuwe UI-feature]` — nieuwe lijsten (Mijn/Team/Afgerond met status-pill + betrokkenen-avatarstack) + **CC-volgers** (nieuw) + **bijlagen (afbeelding/video)** (nieuw) + detailpaneel + aanmaakmodal.

**Wat ontbreekt** (schema-wijzigingen):
- **`taak_volgers`-tabel** (taak_id, user_id) — nieuw.
- **`taak_bijlagen`-tabel** (taak_id, type afbeelding/video, naam, storage_url) — nieuw. Supabase-storage-bucket `taak-bijlagen`.
- Filter "Ik volg (CC)" — client-side + endpoint-filter.
- Bijlage-picker met echte file-upload + preview thumbnail / video-icoon (bouwsteen uit prototype).

**PR-schatting: 4 PR's**
1. `taken-v2 schema` — SQL-migratie `taak_volgers` + `taak_bijlagen` + storage-bucket + RLS.
2. `taken-v2 skelet + Mijn/Team/Afgerond lijsten + detailpaneel` (hergebruik bestaande endpoints).
3. `taken-v2 aanmaakmodal + CC-volgers` (endpoint-uitbreiding taken POST/PATCH).
4. `taken-v2 bijlagen-flow` (upload-endpoint + preview + verwijder).

**Risico's**: bestaande `taken.html` blijft live tot PR 3-4 mergen. Beschermde zone niet relevant.

---

## Groep Klanten & communicatie

### 4. Klanten (`klanten`) — SAMS · tabs [Overzicht]

**Bestaand**:
- `modules/klanten.html` (14000+ regels, klant-detail met 7 sub-tabs) — huidige productie
- `modules/klanten-v2/` (skelet + design-tokens + lijst-view) op branch `feat/klanten-v2-pr-a-skeleton-lijst` (PR #1112, open)
- `docs/redesign/INVENTARIS.md` heeft **188 items** voor Klanten (branch `docs/redesign-inventaris-fase1`, PR #1111)
- 14 `api/customer*.js` + `api/customers.js`-endpoints (customer-dossier, -audit, -archive, -notes, -tag*, -check-duplicate, -link-company, -bulk)

**Type**: `[re-skin + nieuwe UI-feature]` — dossier met 7 tabs matcht prototype (Overzicht/Facturen/Abonnementen/Offertes/Communicatie/Onboarding/Notities). Softphone-actie in rij + dossier-header (Bijlage 4 SYSTEEMKAART).

**Wat ontbreekt**:
- Klanten-v2 PR-B (dossier + 7 tabs) — 149 items uit INVENTARIS.
- Klanten-v2 PR-C (6 modals: create/edit klant, archiveer, dupliceer, bulk-tag, bulk-archiveer, koppel-bedrijf) — 26 items uit INVENTARIS.
- Softphone-integratie via `window.KlxSoftphone` (uit fundament-PR **0-E**).

**PR-schatting: 2 PR's**
1. Klanten-v2 **PR-B** (dossier-orchestrator + 7 tabs) — hergebruik alle bestaande endpoints + `KlxSoftphone.open()` in dossier-header.
2. Klanten-v2 **PR-C** (6 modals + rij-actie "Bel" via `KlxSoftphone.open()` in lijst-view).

**Risico's**: `modules/klanten.html` blijft live tot alle 3 gemerged + Sales-Klanten-tab overzet. Beschermde zone niet relevant.

---

### 5. Studenten (`studenten`) — mentor · geen tabs

**Bestaand**:
- `modules/mentor-students.html` (1728 regels) — Mijn studenten / 1-op-1 sessies / No shows
- 24 `api/student*.js` + veel `api/mentor-student-*.js`
- Bubble-mirror: `mentor-my-students` doet live Bubble-fetches

**Type**: `[re-skin]` — prototype toont detailpaneel (voortgang per module, sessies, contact, notitie). Bestaande scope-logica (mentor-only via `bubble.user.mentor_user`) blijft.

**Wat ontbreekt**:
- LMS-integratie: student-voortgang per module leest uit externe `dfo-lms-prototype` — endpoint hiervoor bestaat nog niet. Prototype toont `student_voortgang` + `lms_modules`.

**PR-schatting: 2 PR's**
1. `studenten-v2 (mentor) re-skin` — Mijn studenten/1-op-1/no-shows met nieuwe UI + detailpaneel.
2. `studenten-v2 LMS-voortgang-integratie` — nieuwe endpoints tegen Bubble/LMS (leest `student_voortgang`) — kan later als LMS-team-afspraak rond is (zie eerdere sessie over `lms_gebruikers`/`enrollments`).

**Risico's**: Bubble-fetches zijn fail-soft. LMS-integratie hangt af van externe schema.

---

### 6. Wanbetalers (`wanbetalers`) — SAM · tabs [Gesprekken/Acties/Overzicht/Brieven] · **BESCHERMD**

**Bestaand**:
- `modules/finance.html` Wanbetalers-tab (100+ regels binnen finance.html, is bewust dead-scoped op `finance.html` niveau)
- Beschermde files: alle `api/cron-dunning-*.js`, `api/finance-dunning-*.js`, `api/dunning-*.js`, `api/joost-*.js`, `api/voys-*.js`, `api/arrangements-*.js`, `api/pending-actions-*.js`, `api/_lib/dunning-*.js`, `api/_lib/joost-*.js` (zie SYSTEEMKAART Bijlage 3 voor complete lijst — 60+ files)

**Type**: `[re-skin]` — puur uiterlijk. Contract: **lege `git diff --stat`** op alle Bijlage 3-paden per wanbetalers-PR.

**Wat ontbreekt**:
- Nieuwe HTML/CSS voor 4 tabs die bovenop bestaande endpoints rendert.
- Elke fetch-call in de nieuwe UI moet exact hetzelfde endpoint met exact dezelfde params aanroepen als de huidige.

**PR-schatting: 4 PR's** (één per tab, elk met eigen protected-zone-bewijs)
1. `wanbetalers-v2 Gesprekken-tab re-skin`.
2. `wanbetalers-v2 Acties-tab re-skin`.
3. `wanbetalers-v2 Overzicht-tab re-skin`.
4. `wanbetalers-v2 Brieven-tab re-skin`.

**Risico's**: **hoogste van alle modules**. Wanbetalers = 5 dagen debug-werk in de engine (Joost, cron-office-hours, claim-locks). Contract per PR-body:
- Sectie "Protected files onveranderd" met commando-output (leeg diff-stat).
- Sectie "API-call inventaris" met bewijs dat elke fetch identiek is.
- Sectie "Live-test-scenario" (aanmaan-run/reminder-cirkel/Joost/brief/bulk) — allemaal identieke resultaten als productie.
- Zie SYSTEEMKAART D0.1 regel 1 voor het complete contract.

---

### 7. E-mail (`email`) — SAMS (sales vergrendeld) · geen tabs

**Bestaand**:
- `modules/email.html` (6117 regels) — 8-tabs (Te beantwoorden/Sales/Klanten/Finance/Reclame/Overig/Alle/Verzonden), 4 postvakken (leads/info/partners/administratie).
- 34 `api/email-*.js` + `api/sync-emails.js` + `api/backfill-*.js` + `api/inbox-emails-list.js`.

**Type**: `[re-skin]` — prototype: 3-koloms (mappen · lijst · leesvenster). Sales: `MOD_LOCK` → "binnenkort beschikbaar".

**Wat ontbreekt**:
- 3-koloms layout die matcht prototype (email.html heeft nu 2-koloms).
- Sales-lock-view.
- Handtekening-modal verhuist naar Instellingen > Communicatie.

**PR-schatting: 3 PR's**
1. `email-v2 3-koloms re-skin + tab-preservatie` (8 tabs blijven).
2. `email-v2 sales-lock + MOD_LOCK-integratie`.
3. `email-v2 handtekening-modal verhuizen naar Instellingen > Communicatie` (koppelt aan Instellingen-PR, module 22).

**Risico's**: 6117 regels is groot. IMAP-sync ongewijzigd; alleen UI. Beschermde zone niet relevant.

---

### 8. Tickets (`tickets`) — SAMSM · tabs [Open/Wacht op klant/Afgehandeld]

**Bestaand**:
- `modules/tickets.html` (563 regels) + `modules/tickets-detail.html`.
- 4 `api/tickets*.js`-endpoints (tickets, ticket-detail, ticket-comments, tickets-badge).
- Tabel `tickets` met `status ∈ open/wachten/opgelost/gesloten` (hardcoded enum in `api/tickets.js`).

**Type**: `[re-skin + nieuwe UI-feature]` — prototype: 3-tab-model (Open/Wacht op klant/Afgehandeld) i.p.v. huidige 4 statussen. Mentor mag zien + aanmaken (nieuw — nu is `tickets.module.access` niet aan mentor gegund).

**Wat ontbreekt**:
- Status-mapping: `open → Open`, `wachten → Wacht op klant`, `opgelost + gesloten → Afgehandeld`. Geen schema-wijziging nodig; alleen UI-groepering.
- Mentor toevoegen aan zichtbaarheid (rol-check).
- KPI-strip + statuspills + filters uit prototype.

**PR-schatting: 2 PR's**
1. `tickets-v2 re-skin + 3-tab-groepering` — behoud bestaande 4-status DB.
2. `tickets-v2 mentor-rol + comment-notifications` (nu zit ticket.replied al in notify.js).

**Risico's**: geen. Enum-groepering is puur client-side.

---

### 9. Follow-up (`followup`) — SAMS · tabs [Werklijst/Event-bellijst/Opvolglijst/Retenties/Afspraken/Sluimerpot/Statistieken/Afgeboekt]

**Bestaand**:
- `modules/follow-up.html` (12377 regels — grootste file van de repo), `follow-up-lead.html`, `follow-up-admin.html`.
- 30+ `api/follow-up-*.js`-endpoints + GHL-polls + admin-daily/weekly rapport-mails.
- **Twee outcome-motoren** (`follow-up-lead-outcome.js` vs `follow-up-appointment-outcome.js`) — **niet consolideren** (comment in source waarschuwt expliciet).
- Softphone-integratie in Werklijst-cockpit (`_softphoneCallLead`).

**Type**: `[re-skin]` — 8 tabs bestaan al. Zelfde outcome-motoren, zelfde crons.

**Wat ontbreekt**:
- Nieuwe HTML/CSS die alle 8 tabs matcht prototype.
- Softphone-consumatie via `window.KlxSoftphone.open()` in Werklijst-belkaart (shared uit fundament **0-E**).

**PR-schatting: 4 PR's** (te groot voor 1 PR — file is 12k regels)
1. `follow-up-v2 shell + Werklijst-tab (master-detail split + belkaart + uitkomst-panel + KlxSoftphone-integratie)`.
2. `follow-up-v2 Event-bellijst + Opvolglijst`.
3. `follow-up-v2 Retenties + Afspraken + Sluimerpot`.
4. `follow-up-v2 Statistieken + Afgeboekt`.

**Risico's**: outcome-motoren NIET consolideren (source-comments). Softphone-extract raakt Klanten-v2 (module 4) — één shared klx-softphone.js.

---

## Groep Verkoop & Financiën

### 10. Sales (`sales`) — SAMSM · tabs [Dashboard/Offertes/Retentie¹/Verkoopprestaties¹] · mentor beperkt

**Bestaand**:
- `modules/sales.html` (grootste post-Klanten, met 7-tabs Dashboard/Klanten/Offertes/Abonnementen/Retentie/Aanbod/Rapporten).
- `sales-wizard.html`, `subscription-wizard.html`, `offerte-detail.html`.
- INVENTARIS.md heeft **216 items** Sales (branch `docs/redesign-inventaris-fase1`).
- 20+ `api/sales-*.js` + `api/deals-*.js`-endpoints.

**Type**: `[re-skin + nieuwe UI-feature]` — prototype heeft 4 tabs (i.p.v. 7). Klanten-tab → verhuist naar Klanten-module. Aanbod-tab → verhuist naar Instellingen. Abonnementen → verhuist naar Finance. Uniek: **verkooptrechter/funnel**, omzet-vs-target, conversie per bron, verkopers-leaderboard.

**Wat ontbreekt**:
- Funnel-visualisatie (bouwsteen in prototype).
- Omzet-vs-target-gauge (`targetGauge`).
- Conversie-per-bron-tabel.
- Verkopers-leaderboard.
- Mentor-beperkte view (sales/Retentie + Verkoopprestaties hidden voor mentor).

**PR-schatting: 4 PR's**
1. `sales-v2 shell + Dashboard (funnel/gauge/leaderboard)` — nieuwe widgets.
2. `sales-v2 Offertes-tab re-skin` — 216 INVENTARIS-items grotendeels hier + Klanten-verhuizing naar Klanten-module.
3. `sales-v2 Retentie-tab re-skin`.
4. `sales-v2 Verkoopprestaties-tab (nieuw scherm) + `TAB_RESTRICT` mentor`.

**Risico's**: bestaande `sales.html` link-graf naar wizards/offerte-detail — die 3 wizards blijven live, of ze migreren mee. Kandidaat voor eigen sub-PR's binnen module 10.

---

### 11. Finance (`finance`) — SAMS · tabs [Dashboard/Facturen/Abonnementen/Creditnota's/Bank²/Omzet & MRR²] · sales beperkt

**Bestaand**:
- `modules/finance.html` (~30k regels — één van de grootste files) — 8 hoofdtabs incl. Wanbetalers/Uitgaven/Roadmap.
- INVENTARIS.md heeft **227 items** Finance top-level + **382 items** in de 2 Wanbetalers-secties.
- 40+ `api/finance-*.js`-endpoints.

**Type**: `[re-skin + nieuwe UI-feature]` — Wanbetalers-tab verhuist naar eigen module (6, boven). Roadmap-tab weg (SCHRAPPEN). Uitgaven blijft. Nieuw: **MRR + churn**, cashflow, **aging (0-30/30-60/60-90/90+)**, betaalstatus.

**Wat ontbreekt**:
- Aging-analyse-tabel (nieuw).
- MRR + churn-berekening (nieuw endpoint of bestaand omzet-endpoint uitbreiden).
- Cashflow-chart (bouwsteen `areaChart`).
- Sales-focus-view zonder Bank/MRR (`TAB_RESTRICT`).

**PR-schatting: 5 PR's**
1. `finance-v2 shell + Dashboard (MRR/churn/cashflow/aging)`.
2. `finance-v2 Facturen-tab re-skin`.
3. `finance-v2 Abonnementen-tab re-skin`.
4. `finance-v2 Creditnota's-tab re-skin`.
5. `finance-v2 Bank + Omzet & MRR (SAM-only) + sales-lock`.

**Risico's**: Wanbetalers-tab wordt losgetrokken → eigen module (6). Uitgaven-tab blijft in Finance of verhuist naar Instellingen? — nu geen conflict, maar besluit vereist. Bank-endpoints staan buiten beschermde zone maar zijn wél TL-sync (customers-scope).

---

### 12. Mijn verdiensten (`verdiensten`) — mentor · tabs [Overzicht/Uitbetalingen/Reiskosten/Certificaten]

**Bestaand**:
- `modules/mentor-dashboard.html` (2115 regels) — Financiën-tab voor mentor. Bevat al Overzicht/Verdiensten met 4 subtabs (Overzicht/Coaching/Events/Uitbetalingen).
- 93 `api/mentor-*.js`-endpoints (payout, coaching-earnings, my-events, calendar, travel-days, funded-cert-save, bonus-overview, etc.).
- Storage-bucket `funded-certificates`.
- Tabel `mentor_travel_days` (bestaat), `mentor_funded_certificates` (bestaat, €100/certificaat), `mentor_payouts`.

**Type**: `[re-skin + nieuwe weergave]` — **de backend/data voor reiskosten (dagmodel) én certificaten (€100 per goedgekeurd) bestaat al**. Alleen de UI-weergave in de mentor-eigen module ontbreekt.

**Wat ontbreekt** — puur UI, geen nieuwe tabellen:
- Reiskosten-tab als losstaand (nu sub-tab van Verdiensten in mentor-dashboard). Backend: `mentor_travel_days`-tabel + `mentor-travel-days-save`/`-self`-endpoints bestaan. `mentor_payout_config.travel_day_rate_incl` = het dagbedrag per mentor.
- Certificaten-tab in de mentor-eigen module. Backend: `mentor_funded_certificates`-tabel + `mentor-funded-cert-save`-endpoint + storage-bucket `funded-certificates` + `RATE_FUNDED = €100` in `computeCoachingEarnings` bestaan.
- Automatische reiskosten-herinnering op eerste vrijdag maand (nieuw — cron + notification). **Kan later als aparte PR** — niet-blokkerend voor Fase 3.

**PR-schatting: 3 PR's**
1. `verdiensten-v2 shell + Overzicht + Uitbetalingen (re-skin uit mentor-dashboard)`.
2. `verdiensten-v2 Reiskosten-tab + dag-model UI` — hergebruikt bestaande `mentor-travel-days-save` + `mentor_payout_config.travel_day_rate_incl`.
3. `verdiensten-v2 Certificaten-tab (mentor-eigen upload-view)` — hergebruikt bestaande `mentor-funded-cert-save` + storage-bucket. Dubbelt met mentor-students; consolideren of scheiden — voorstel: scheiden per doel (student-context vs mentor-eigen).

**Optionele latere PR** (uit fase-count):
- `verdiensten reiskosten-cron + notification` — eerste-vrijdag-trigger, gebruikt bestaande `notify.js` fan-out. Klein, staat los, niet in de Fase 3 build-lijst.

**Risico's**: mentor-payout write-endpoints staan onder mentor-admin-scope (`mentor.payout.manage`). Self-scope endpoints (`mentor-payouts-list-self`, `mentor-travel-days-save`) blijven.

---

## Groep Leren & Events

### 13. LMS (`lms`) — SA + manager + mentor · externe link

**Bestaand**: alleen sidebar-entry naar `https://dfo-lms-prototype.vercel.app/mentor`. Geen `modules/lms.html`.

**Type**: `[alleen inhangen in shell]` — externe link met `target="_blank"`. Rol-gate `mentor.module.access`.

**Wat ontbreekt**: niets in ons systeem. LMS-team bouwt eigen omgeving op shared Supabase (`lms_gebruikers`, `lms_toegang`, `lms_producten` — LIVE gebruikt door `api/_lib/lms-provisioning.js`).

**PR-schatting: 0 PR's** (komt automatisch mee in de app-shell van PR 0-B2 als externe sidebar-item).

**Risico's**: geen.

---

### 14. Events (`events`) — SAMSM · tabs [Overzicht/Inbox³/Inschrijvingen³/Mentor-grootboek³] · mentor read-only

**Bestaand**:
- `events.html` (5947 regels), `events-detail.html` (3240 regels), `events-wizard.html`, `events-automations.html`, `event-keuze.html`, `assessment.html`, `admin-historical-events.html`.
- INVENTARIS.md: geen expliciete count (Events niet in scope Fase 1); zie Fase 3 recon.
- 40+ `api/events-*.js` + `api/event-*.js` + `api/cron-events-*.js`-endpoints.
- 2 aparte inboxen: WhatsApp-inbox (bestaande WA-lijn) + Inschrijvingen-inbox (`event_signup_inbox`).

**Type**: `[re-skin]` — 4 tabs matcht prototype. Mentor-restricted view: alleen Overzicht read-only, geen aanmaak/afrond-acties.

**Wat ontbreekt**:
- Event-detail: Info/Aanwezigen/Mentoren/Audit + **afrond-venster** (aanwezigheid → opvolging → bonus/uitgaven) al bestaand als `evCompleteModal`.
- Mentor `TAB_RESTRICT` op Inbox/Inschrijvingen/Mentor-grootboek.
- Automations-editor verhuist naar Automatiseringen-module (23).

**PR-schatting: 4 PR's**
1. `events-v2 shell + Overzicht-tab re-skin` (mentor read-only variant).
2. `events-v2 Inbox + Inschrijvingen-tab re-skin`.
3. `events-v2 Mentor-grootboek-tab re-skin`.
4. `events-v2 detail-page (Info/Aanwezigen/Mentoren/Audit)` — 3240-regel-file port + afrond-venster.

**Risico's**: `event_signup_inbound` webhook + `cron-events-automations` + `cron-event-belronde` blijven ongewijzigd. Simone-config leeft in `joost_config` module='events' — buiten scope.

---

### 15. Onboarding (`onboarding`) — SAMSM · tabs [Actief/Inbox⁴/Archief⁴] · mentor beperkt

**Bestaand**:
- `onboarding-hub.html` (Overzicht + Wizard + Automations sub-tabs), `onboarding-admin.html`, `onboarding-wizard-editor.html`, `onboarding-automations.html`, `onboarding.html` (student-facing wizard), `mentor-onboarding.html` (mentor eigen intake-pijplijn).
- 25+ `api/onboarding-*.js` + `api/cron/onboarding-*.js`-endpoints.
- Mentor-assign gebeurt hier (`onboardings.mentor_user_id` write; Bubble-mirror).

**Type**: `[re-skin]` — 3 tabs (Actief/Inbox/Archief). Mentor-restricted: alleen Actief (eigen toegewezen studenten).

**Wat ontbreekt**:
- Nieuwe HTML/CSS voor 3 tabs.
- Wizard-editor + Automations verhuizen naar Instellingen > Onboarding.
- Mentor-onboarding.html gaat op in Onboarding met scope-filter "Mijn/Alle".

**PR-schatting: 3 PR's**
1. `onboarding-v2 shell + Actief-tab (mentor scope-filter)`.
2. `onboarding-v2 Inbox-tab + Archief-tab (SAMS only)`.
3. `onboarding-v2 mentor-toewijzing verhuizen naar Onboarding (uit Mentoren)` — SYSTEEMKAART bevestigt: "Mentor-toewijzing gebeurt in Onboarding, niet in Mentoren."

**Risico's**: `cron/onboarding-automations` + `cron/archive-completed-onboardings` + Mila-suggest via inbox-webhook blijven ongewijzigd. Wizard-editor legacy — kandidaat voor archief zodra Instellingen-verhuis klaar is.

---

### 16. Mentoren (`mentoren`) — SAM · tabs [Overzicht/Grootboek/Uitbetalingen/Beoordelingen/Certificaten/Signalen]

**Bestaand**:
- `mentoren-beheer.html` (iframe-hub met 5 tabs), `mentor-detail.html`, `mentor-payouts-admin.html`, `funded-certificates-admin.html`, `student-assessments-admin.html`, `mentor-cash-trajects-admin.html`, `students-overview.html`.
- 93 `api/mentor-*.js`-endpoints.

**Type**: `[re-skin + nieuwe weergave]` — 6 tabs. Overzicht krijgt **per-mentor reiskosten-toggle + bedrag/dag** (bestaande `mentor_payout_config.travel_enabled` + `travel_day_rate_incl` — geen nieuwe kolommen). Certificaten krijgt **download-knop** (Storage signed-URL en admin-list-endpoint bestaan al; alleen UI-knop ontbreekt).

**Wat ontbreekt** — puur UI, geen nieuwe tabellen:
- UI-mapping voor `mentor_payout_config.travel_enabled` + `travel_day_rate_incl` in Overzicht-tab (schrijf via bestaande `mentor-payout-config-set`).
- Download-knop in Certificaten-tab (bestaande signed-URL uit `funded-certs-admin-list`).

**PR-schatting: 6 PR's**
1. `mentoren-v2 shell + Overzicht-tab (reiskosten-toggle + bedrag/dag)`.
2. `mentoren-v2 Grootboek-tab re-skin`.
3. `mentoren-v2 Uitbetalingen-tab re-skin (uit mentor-payouts-admin)`.
4. `mentoren-v2 Beoordelingen-tab re-skin (uit student-assessments-admin)`.
5. `mentoren-v2 Certificaten-tab (bekijken/goedkeuren/downloaden)`.
6. `mentoren-v2 Signalen-tab (uit student-signals)`.

**Risico's**: geen writes op mentor_payouts zonder `mentor.payout.manage`-gate. Cash-trajects verhuizen naar Instellingen? — of blijft als sub-view. Besluit nodig.

---

## Groep Groei

### 17. Leads (`leads`) — SAMMK + sales · tabs [Actief/Gearchiveerd]

**Bestaand**:
- `leads.html`, `leads-detail.html`.
- 20+ `api/leads-*.js`-endpoints.
- Sinds mig 2026-07-28: `leads.view`-gate, uitgedeeld aan super_admin/manager/sales/mentor.

**Type**: `[re-skin]` — 2 tabs. Marketing krijgt view (nieuw rol-toevoeging).

**Wat ontbreekt**:
- Nieuwe HTML/CSS voor 2 tabs.
- Marketing-rol toevoegen aan `leads.view`-grants (mig).

**PR-schatting: 2 PR's**
1. `leads-v2 shell + Actief-tab re-skin`.
2. `leads-v2 Gearchiveerd-tab + marketing-rol-grant`.

**Risico's**: geen.

---

### 18. Nieuwsbrief (`nieuwsbrief`) — marketing · geen tabs

**Bestaand**: **NIETS**. Geen `modules/nieuwsbrief*`, geen `api/nieuwsbrief*`. Marketing-rol nog niet uitgegeven.

**Type**: `[nieuw scherm + nieuwe data]` — volledig nieuw.

**Wat ontbreekt**:
- Tabel `nieuwsbrieven` (onderwerp, verzonden_op, ontvangers, open_rate, klik_rate, status).
- E-mail-verzend-integratie (bestaand `sendEmailViaSmtp` in `_lib`?).
- Composer + verzend-flow + rapportage.

**PR-schatting: 3 PR's**
1. `nieuwsbrief-v2 schema + verzend-endpoint` (SQL-migratie + `nieuwsbrief-send.js`).
2. `nieuwsbrief-v2 composer + verzend-UI`.
3. `nieuwsbrief-v2 rapportage-tab (open/klik/tijd)` — vereist tracking-pixel + link-shortener (nieuw).

**Risico's**: e-mail-deliverability + spam-signalen. Kan uitgesteld tot Fase 6+.

---

### 19. Leadsonderhoud (`leadsonderhoud`) — SAMS · tabs [Inbox/Contacten/Bulk versturen/Statistieken]

**Bestaand**:
- `leadsonderhoud.html` (1215 regels) — 6 tabs (Overzicht/Wachtrij/Gesprekken/Trajecten/Berichten/Vragenlijst).
- 21 `api/leadsonderhoud-*.js` + `api/cron-leadsonderhoud.js`.
- **Bekende bug**: cron valt terug op onboarding-WA-lijn stil (SYSTEEMKAART Fase 3 recon; REDESIGN-BOUWPLAN §8).

**Type**: `[re-skin + nieuwe UI-feature]` — prototype: 4 tabs (Inbox/Contacten/Bulk versturen/Statistieken). Andere structuur dan huidige 6 tabs. Trajecten + Berichten + Vragenlijst-editor verhuizen naar Instellingen > Leads & follow-up.

**Wat ontbreekt**:
- Nieuwe 4-tab-structuur.
- Bulk-versturen-UI (bestaande wachtrij + nieuwe compose).
- Bug-fix: cron eist eigen `leadsonderhoud`-WA-lijn (zie §8 REDESIGN-BOUWPLAN).

**PR-schatting: 3 PR's**
1. `leadsonderhoud-v2 shell + Inbox + Contacten-tab`.
2. `leadsonderhoud-v2 Bulk versturen + Statistieken`.
3. `leadsonderhoud cron-fix (WA-lijn fallback)` — kan parallel als kleine bug-fix.

**Risico's**: motor (`cron-leadsonderhoud`) blijft ongewijzigd. Vragenlijst-editor verhuizen naar Instellingen (module 22).

---

### 20. Lisa — Instagram (`lisa`) — SAM · tabs [Dashboard/Gesprekken/Statistieken]

**Bestaand**:
- `lisa.html` (2291 regels) — Live/Stats/Sandbox/Logs (Config-tab is bewust verborgen, verhuisd naar agent-center).
- 15+ `api/lisa-*.js` + `api/cron-lisa-delayed.js`.
- **Dode tabellen**: `lisa_qualification` (schema aanwezig, geen writer), `lisa_stats` (aggregaat-tabel, nooit geschreven).

**Type**: `[re-skin]` — 3 tabs. Config zit al in Agent-center (module 24).

**Wat ontbreekt**:
- Nieuwe HTML/CSS voor 3 tabs.
- Opruimen dode tabellen (of vullen).
- Naam-wijziging: **Lisa — Instagram** (prototype).

**PR-schatting: 3 PR's**
1. `lisa-v2 shell + Dashboard-tab`.
2. `lisa-v2 Gesprekken-tab (Live) + Statistieken-tab`.
3. `lisa cleanup: dode tabellen + naam` — SQL + rename.

**Risico's**: `lisa_config` blijft ongewijzigd. Config-flow blijft in agent-center.

---

## Groep Operatie

### 21. Automatiseringen (`automatiseringen`) — SAM · tabs [Overzicht/Events/Onboarding/Leadsonderhoud/Wanbetalers⁵/Lisa] · Wanbetalers alleen-lezen

**Bestaand**:
- Nog geen aggregator-module. Motoren leven verspreid:
  - Events-automations: `events-automations.html`
  - Onboarding-automations: `onboarding-automations.html` (dormant sinds Hub-merge)
  - Leadsonderhoud sequences: `leadsonderhoud.html` Trajecten-tab
  - Wanbetalers dunning-workflows: `finance.html` Wanbetalers > Workflows
  - Lisa follow-up: `lisa.html` Config > Follow-up

**Type**: `[nieuw scherm op bestaande data]` — aggregator-shell die de bestaande editors embed of erop deep-linkt. **Geen nieuwe motor.**

**Wat ontbreekt**:
- `modules/automatiseringen.html` — shell met 6 tabs.
- Overzicht-tab: dashboard met actieve motoren, laatste runs, failures (leest bestaande run-tabellen).
- Wanbetalers-tab: alleen-lezen embed van dunning-workflows.

**PR-schatting: 3 PR's**
1. `automatiseringen-v2 shell + Overzicht (dashboard met motoren-status)`.
2. `automatiseringen-v2 tabs 2-4 (Events/Onboarding/Leadsonderhoud) embed bestaande editors`.
3. `automatiseringen-v2 tabs 5-6 (Wanbetalers read-only + Lisa follow-up)` — Wanbetalers is Bijlage 3 → alleen embed/iframe, geen writes.

**Risico's**: Wanbetalers-tab moet echt alleen-lezen zijn (protected zone). Iframe of read-only-view.

---

### 22. AI Agents (`agents`) — SAM · tabs [Overzicht/Configuratie/Kennisbank/Prestaties]

**Bestaand**:
- `agent-center.html` (5110 regels) — al de canonieke hub voor Joost/Simone/Mila/Lisa-config. Command deck + agents-view + kanalen-view.
- Legacy `agents.html` (Simon/Leon/Aron chat-shell) — voor chat, niet config.
- 20+ `api/joost-*.js` + `api/simone-*.js` + `api/lisa-*.js` + `api/mila-*.js`.

**Type**: `[re-skin + nieuwe UI-feature]` — grotendeels bestaand als agent-center; opnieuw structureren in 4 tabs (Overzicht/Configuratie/Kennisbank/Prestaties). Kanalen-view (WhatsApp Templates + Verbindingen) verhuist naar Instellingen > Communicatie.

**Wat ontbreekt**:
- Overzicht-tab: kaarten per agent met live-status/cost/laatste activiteit — bestaat als command-deck; herstructureren.
- Kennisbank-tab: tag-catalogus + bedrijfsprofiel-editor.
- Prestaties-tab: per-agent metrics (suggesties/geaccepteerd/kosten) — bestaat Decision Log; uitbreiden.

**PR-schatting: 3 PR's**
1. `agents-v2 shell + Overzicht (uit agent-center command-deck)`.
2. `agents-v2 Configuratie-tab (Joost/Simone/Mila/Lisa per sub-card + versioning-flow)`.
3. `agents-v2 Kennisbank + Prestaties + Kanalen-verhuizing naar Instellingen`.

**Risico's**: Joost-config beheert `joost_config` (module='finance'). Joost = beschermde zone (SYSTEEMKAART Bijlage 3). Config-writes moeten via bestaande `joost-config-upsert` — geen alternatief path bouwen.

---

### 23. Toegangslog (`logboek`) — SAM · tabs [Activiteit/Per gebruiker]

**Bestaand**:
- `activity-log.html` (563 regels) — Activiteit + Per gebruiker tabs.
- 2 `api/activity-log-*.js` + `api/activity-record-login.js` + `api/_lib/activity-logger.js` + `api/cron-activity-log-cleanup.js`.
- **Kernbeperking**: logt alleen permission-checks, niet business-events. 20+ andere `_log`/`_audit`-tabellen zijn niet zichtbaar.

**Type**: `[re-skin]` — Optie 1 uit Fase 3 recon: herbrand als "Toegangslog", 2 tabs (matcht prototype).

**Wat ontbreekt**:
- Rij-detail (payload jsonb + user-agent zichtbaar).
- Export (CSV).
- Customer-filter (ilike op endpoint).

**PR-schatting: 2 PR's**
1. `logboek-v2 shell + Activiteit + Per gebruiker + rij-detail`.
2. `logboek-v2 export + customer-filter`.

**Risico's**: geen. Federated event-log (Optie 2) is grote latere ingreep — geen scope Fase 0-6.

---

## Groep Systeem

### 24. Instellingen (`instellingen`) — SAM · 9 categorieën

**Bestaand**:
- Verspreid: `admin.html` (Gebruikers/Rechten/Integraties/Approval-queue/Menu beheer), `finance.html` Wanbetalers > Instellingen, `events.html` Settings, `onboarding-hub.html` Wizard + Automations, `lisa.html` Config (verborgen), `agent-center.html` (Joost/Simone/Mila-config), `email.html` Handtekening-modal, `leadsonderhoud.html` Trajecten/Berichten/Vragenlijst.
- 30+ endpoints (admin-users, admin-rbac-*, admin-meta-templates-*, finance-dunning-templates-*, etc.).

**Type**: `[nieuw scherm op bestaande data]` — één samenvattings-module met 9 categorieën. Per categorie deep-link naar bestaande editor OF embed nieuwe UI die bestaande endpoints aanroept.

**Wat ontbreekt**:
- `modules/instellingen.html` — shell met 9 categorieën:
  1. Verkoop, 2. Financieel, 3. Wanbetalers, 4. AI Agents, 5. Events & Leren, 6. **Communicatie** (WhatsApp-templatebeheer verhuist hierheen), 7. Marketing, 8. Team & toegang, 9. Algemeen.
- WhatsApp-template-editor + mappen/categorieën/statusfilter/preview verhuist uit agent-center.

**PR-schatting: 5 PR's**
1. `instellingen-v2 shell + Team & toegang (uit admin.html Gebruikers + Rechten)`.
2. `instellingen-v2 Communicatie (WhatsApp-templates + WABA-verbindingen verhuizen)`.
3. `instellingen-v2 Verkoop + Financieel + Wanbetalers (deep-links)`.
4. `instellingen-v2 AI Agents + Events & Leren + Marketing`.
5. `instellingen-v2 Algemeen (feature-flags + cron-status + bedrijfsgegevens)`.

**Risico's**: Wanbetalers-Instellingen (dunning-templates) blijft beschermde zone — deep-link naar bestaand scherm, geen re-implementatie.

---

### 25. Binnenkort (`binnenkort`) — SAM · geen tabs

**Bestaand**: **NIETS**. `modules/binnenkort.html` bestaat niet.

**Type**: `[nieuw scherm op bestaande data]` — kaartenraster naar bestaande modules die uit hoofdnav verdwijnen.

**Wat ontbreekt**:
- `modules/binnenkort.html` — kaartenraster met 9 kaarten volgens prototype: Nieuwsbrief · Enquêtes · Meta Ads · Creative Studio · Kennisbank · Control Center · Secret Area · Vergaderruimte · Simon/Leon/Aron-chat.
- Elke kaart is link naar bestaand scherm (behalve Enquêtes = nieuw, later).

**PR-schatting: 1 PR**
1. `binnenkort-v2 kaartenraster` — pure link-navigator.

**Risico's**: geen. Alle bestaande modules blijven bereikbaar via directe URL.

---

## Totaaltelling

### PR's per module (bijgewerkt na consolidaties)

| # | Module | Type | PR's | Complexiteit |
|---|---|---|---|---|
| Fundament | Fase 0 (A/B1/B2/C/D/E) | fundament | **6** | hoog (incl. softphone-extract + rol-migratie) |
| 1 | Dashboard | re-skin+ | 4 | hoog (4 rol-taken, verspreid over fases) |
| 2 | Inbox | nieuw op bestaande data | 2 | midden |
| 3 | Takenbeheer | re-skin+ | 4 | midden-hoog (nieuwe schema's) |
| 4 | Klanten | re-skin+ | 2 | midden (klanten-v2 loopt al; softphone naar 0-E) |
| 5 | Studenten | re-skin | 2 | laag (kan wachten op LMS) |
| 6 | Wanbetalers | re-skin (BESCHERMD) | **4** | hoog (contract per PR) |
| 7 | E-mail | re-skin | 3 | midden (grote file) |
| 8 | Tickets | re-skin+ | 2 | laag |
| 9 | Follow-up | re-skin | 4 | hoog (12k regels; softphone naar 0-E) |
| 10 | Sales | re-skin+ | 4 | hoog (INVENTARIS 216) |
| 11 | Finance | re-skin+ | 5 | hoog (INVENTARIS 227) |
| 12 | Mijn verdiensten | re-skin+ | 3 | midden (cron optioneel losstaand) |
| 13 | LMS | inhangen | 0 | nul (in shell PR 0-B2) |
| 14 | Events | re-skin | 4 | hoog (5 files) |
| 15 | Onboarding | re-skin | 3 | midden |
| 16 | Mentoren | re-skin+ | 6 | midden (6 tabs) |
| 17 | Leads | re-skin | 2 | laag |
| 18 | Nieuwsbrief | nieuw + data | 3 | midden (nieuwe motor) |
| 19 | Leadsonderhoud | re-skin+ | 3 | midden (bug-fix) |
| 20 | Lisa | re-skin | 3 | laag (cleanup) |
| 21 | Automatiseringen | nieuw op bestaande data | 3 | laag (aggregator) |
| 22 | AI Agents | re-skin+ | 3 | midden |
| 23 | Toegangslog | re-skin | 2 | laag |
| 24 | Instellingen | nieuw op bestaande data | 5 | hoog (9 categorieën) |
| 25 | Binnenkort | nieuw op bestaande data | 1 | laag |
| **Totaal** |  |  | **83 PR's** | |

**Netto delta t.o.v. eerste map** (was 84, is 83):
- +1 fundament (softphone-extract 0-E gebundeld)
- −1 klanten (softphone weg uit module)
- −1 follow-up (softphone weg uit module)
- −1 verdiensten (reiskosten-cron losgekoppeld als optionele latere PR — geen nieuwe data-eis)
- +1 dashboard (rol-tak-split over 4 fases i.p.v. 3 gebundeld)
- Netto: **−1**

### Splitsing type

| Type | PR's | % |
|---|---|---|
| Fundament (Fase 0) | 6 | 7% |
| Pure re-skin | 25 | 30% |
| Re-skin + UI-feature | 31 | 38% |
| Nieuw scherm op bestaande data | 15 | 18% |
| Nieuw scherm + nieuwe data | 5 | 6% |
| Inhangen in shell | 0 | (LMS zit in shell-PR) |

**Kern-inzicht**: 68% (56 PR's) is pure re-skin of re-skin+UI bovenop bestaande endpoints/data. 32% (26 PR's) is echt nieuw werk (fundament + Nieuwsbrief + Inbox-aggregator + Automatiseringen-aggregator + Instellingen-shell + Binnenkort). Reiskosten dagmodel + certificaten zijn nu correct als re-skin+ geclassificeerd — backend bestaat al.

---

## Voorgestelde volgorde

Regel: **elk rol-dashboard komt NA de modules waar het naar linkt** (voorkomt dode knoppen). Fundament + kleine modules eerst binnen elke fase om momentum te houden.

### Fase 0 — Fundament (6 PR's)
0-A ✅ · 0-B1 ✅ · 0-B2 · 0-C · 0-D · **0-E (softphone-extract)**

### Fase 1 — Klanten-v2 + Takenbeheer (6 PR's)
- Klanten-v2 PR-B + PR-C (module 4 — 2 PR's, softphone al in 0-E)
- Takenbeheer schema + 3 build-PR's (module 3 — 4 PR's)

### Fase 2 — Sales & Finance (10 PR's)
- Sales-v2 (4 PR's — module 10)
- Finance-v2 (5 PR's — module 11)
- **Dashboard sales-tak** (1 PR — module 1, tak 1/4) ← na Sales/Finance klaar

### Fase 3 — Mentor-rol compleet (12 PR's)
- Studenten-v2 (2 PR's — module 5)
- Verdiensten-v2 (3 PR's — module 12, reiskosten-cron als optionele latere PR)
- Mentoren-v2 (6 PR's — module 16)
- **Dashboard mentor-tak** (1 PR — module 1, tak 2/4) ← na Studenten+Verdiensten+Mentoren klaar

### Fase 4 — Events & Onboarding (7 PR's)
- Events-v2 (4 PR's — module 14)
- Onboarding-v2 (3 PR's — module 15)

### Fase 5 — Wanbetalers re-skin + Lisa + Agents + Automatiseringen + Manager-Dashboard (14 PR's)
- Wanbetalers-v2 (4 PR's — module 6, elk met contract-bewijs lege diff-stat)
- Lisa-v2 (3 PR's — module 20)
- Agents-v2 (3 PR's — module 22)
- Automatiseringen-v2 (3 PR's — module 21)
- **Dashboard manager+SA-tak** (1 PR — module 1, tak 3/4) ← na alle werkschermen klaar

### Fase 6 — Instellingen + Communicatie + Toegangslog (7 PR's)
- Instellingen-v2 (5 PR's — module 24)
- Toegangslog-v2 (2 PR's — module 23)

### Fase 7 — Kleine modules + Leadsonderhoud (13 PR's)
- Inbox-v2 (2 PR's — module 2)
- E-mail-v2 (3 PR's — module 7)
- Tickets-v2 (2 PR's — module 8)
- Follow-up-v2 (4 PR's — module 9, grootste file)
- Leads-v2 (2 PR's — module 17)

### Fase 8 — Groei + Marketing (8 PR's)
- Leadsonderhoud-v2 (3 PR's — module 19)
- Nieuwsbrief-v2 (3 PR's — module 18)
- Binnenkort-v2 (1 PR — module 25)
- **Dashboard marketing-tak** (1 PR — module 1, tak 4/4) ← na Nieuwsbrief klaar

### Loose ends
- Marketing-rol grants aan Meta Ads / Creative Studio / etc. — komen mee met Binnenkort-PR (module 25).
- Bekende bugs uit REDESIGN-BOUWPLAN §8 (25 dunning-runs, reminder-cirkel-bug, Muno-reactie, WA template-variabelen, intent-key-consolidatie) — behoren tot Fase 7+ als aparte bug-PR's (buiten module-count).
- Optionele latere PR's die niet blokkerend zijn: reiskosten-cron + notification (module 12), Follow-up cron-fix WA-lijn (module 19 bug-tag).

**Fase-totalen**: 6 + 6 + 10 + 12 + 7 + 14 + 7 + 13 + 8 = **83 PR's**. Consistent met de module-tabel (Dashboard-4-taken zijn over 4 fases verdeeld i.p.v. samen in één fase).

---

## Kritieke bevestigingen

1. **Beschermde wanbetalers-zone**: Bijlage 3 SYSTEEMKAART lijst geldt onverkort. Elke wanbetalers-PR moet lege `git diff --stat` op protected-paden bewijzen. Feasible = **JA**, want puur HTML/CSS-vervanging in `finance.html` Wanbetalers-tab (of nieuwe standalone-file). Endpoint-fetches identiek.
2. **Softphone-extract** (Bijlage 4) is voorwaarde voor Klanten-v2 PR-B én Follow-up-v2 shell-PR. Één shared file, twee consumenten.
3. **Klanten-v2 branch #1112**: bevat oudere `tokens.css` → merge-conflict na 0-B1. Rebase-instructie in PR #1118 body.
4. **Rol-migratie (0-D)**: `admin/administratie/viewer` opruimen kan parallel met Fase 1-3 mits DB-updates éérst (SYSTEEMKAART Bijlage 2 B2.3 stappenplan).
5. **LMS-datalaag**: `lms_gebruikers` + `lms_toegang` + `lms_producten` LIVE. LMS-collega bouwt eigen features aan die tabellen. Enige raakvlak = extern link in shell (module 13).
6. **Aparte student-rol**: nog niet ingevoerd. Beslissing uit LMS-overdracht: aparte tabel, niet in `profiles`. Kan wachten tot LMS-team het aandraagt.

Geen ander open besluit dat de bouwvolgorde blokkeert.
