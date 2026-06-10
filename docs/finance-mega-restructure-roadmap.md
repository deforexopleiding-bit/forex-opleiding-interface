# Finance Mega-Restructure — Roadmap

**Branch:** `feat/finance-mega-restructure`
**Foundation-commit:** `29fe398`
**Status:** WIP — foundation gelegd, vervolg-commits per gebied nodig.

## Doelstructuur (groen licht ontvangen)

```
💰 FINANCE (sidebar — badge inline op Finance-link)
   ├── 📊 Dashboard ← NIEUW
   ├── 👥 Klanten ← NIEUW (thin view)
   ├── ⚠️ Wanbetalers (top-tab met 4 sub-tabs)
   │     ├── Overzicht (= huidige view-dunning)
   │     ├── 📥 Inbox (= huidige view-inbox)
   │     ├── Arrangements (= huidige view-arrangements)
   │     └── Open Acties (= shared/finance-tasks.js via code-share)
   ├── 📄 Facturen (= huidige view-facturen)
   ├── 🏦 Bank (= huidige view-bank + view-camtbank)
   ├── 📈 Rapportage (bestaand)
   └── ⚙️ Instellingen ← NIEUW
         ├── Joost AI config (verhuisd uit Admin)
         ├── WhatsApp templates (verhuisd uit Admin)
         └── Afdeling-config (verhuisd uit Admin)

SIDEBAR:
- Open Acties nav-item: WEG (foundation done in 29fe398)

ADMIN:
- Joost AI tab, WhatsApp Templates tab, Afdeling-config tab: WEG (na verhuis)
- Behoudt: Users + RBAC + TL integraties + system settings
```

## Goedgekeurde beslissingen (plan-gate)

1. **PR-strategie:** 1 mega-PR (Jeffrey's keuze, accepteert risico)
2. **Open Acties code-share** via `modules/shared/finance-tasks.js` (geen iframe)
3. **Klanten thin view** met finance-context (geen full clone)
4. **Dashboard endpoints chunked + cached** (1 fast KPI-endpoint + per-chart lazy)
5. **Auto-refresh:** manual refresh button (geen interval)
6. **open-acties.html:** thin redirector met melding (FOUNDATION DONE)
7. **RBAC:** behoud bestaande keys (geen rename)
8. **Open Acties sidebar:** WEG, badge naar Finance (FOUNDATION DONE)

## Extra constraints

- Modulariseer finance.html JS in losse bundles (finance-dashboard.js / finance-klanten.js / finance-wanbetalers.js / finance-instellingen.js)
- Klant-modal logica NIET aanraken (PR #156/158 net gestabiliseerd)
- Strict merge-assertion (PR #148 lesson)
- TL bank-balans 15min cache (FOUNDATION DONE: SQL + bank_accounts.balance_fetched_at)
- Recharts lazy-import
- Backward compat URLs

## Foundation - commit 29fe398 (DONE)

1. **modules/shared/sidebar.js**
   - Open Acties nav-item verwijderd
   - Badge `navFinanceTasksBadge` hangt nu inline op Finance nav-item
   - Click-target naar `/modules/finance.html?tab=wanbetalers&sub=open-acties&status=PENDING`
   - `highlightActive()` routeert legacy URLs (`open-acties.html`, `wanbetalers.html`) onder Finance
   - `MODULE_FEATURE_MAP['finance-tasks']` verwijderd (badge-gating zit nu in `financeTasksBadgeAllowed()`)

2. **modules/open-acties.html** vervangen door thin redirector
   - "Module verhuisd" melding + auto-redirect na 2s
   - Behoudt query-string (`?status=PENDING` etc.)

3. **docs/sql-migrations/2026-06-10-finance-mega-restructure.sql**
   - `bank_accounts.balance` + `balance_fetched_at` kolommen
   - Index op `balance_fetched_at NULLS FIRST`

## Resterende werk - per commit-groep

Tab-pattern in finance.html is: top-level views met `id="view-X"`, knoppen met `data-view="X"` in `#financeNav`, switcher = `setView(view)` op regel 3059. Bestaande views: facturen, camtbank, bank, inbox, dunning, arrangements, roadmap.

### Groep A — Wanbetalers nested (4-6 commits)

**Doel:** view-inbox + view-dunning + view-arrangements groeperen onder Wanbetalers parent met 4 sub-tabs.

A1. **Wanbetalers wrapper-view** in finance.html (HTML+CSS)
- Nieuwe `<div id="view-wanbetalers" hidden>` wrapper met sub-tab balk (4 knoppen: Overzicht / Inbox / Arrangements / Open Acties)
- Sub-tab-state via `?sub=overzicht|inbox|arrangements|open-acties` URL-param
- CSS: nested-tab-bar styling consistent met sales.html pattern

A2. **setView() uitbreiding** in finance.html (JS)
- Wanneer `view='wanbetalers'`: toon wrapper, hide alle losse views, init sub-tab via setSubView()
- Nieuwe `setSubView(sub)` functie die binnen Wanbetalers schakelt
- URL-param sync via `history.replaceState`

A3. **#financeNav herstructurering**
- Wanbetalers-knop vervangt 3 losse knoppen (Inbox/Dunning/Arrangements)
- Volgorde-update: Dashboard / Klanten / Wanbetalers / Facturen / Bank / Rapportage / Instellingen

A4. **shared/finance-tasks.js extract**
- Module: tabel + filter-pills + detail-modal + mark-executed actions
- Mount: `FinanceTasks.mount({ host: HTMLElement, statusFilter, actionTypeFilter, customerId })`
- Lees uit `git show 29fe398~1:modules/open-acties.html` (vóór redirector-replace) voor de bron-logica

A5. **Wanbetalers > Open Acties sub-tab integratie**
- Mount `FinanceTasks.mount(host)` in sub-tab container
- Bestaande `view-inbox` / `view-dunning` / `view-arrangements` content blijft in eigen DOM-nodes, alleen visibility-toggle via setSubView

A6. **Klant-modal verschuiving check**
- KLANT-MODAL JS LOGICA NIET AANRAKEN (PR #156/158 stabiel)
- Alleen testen dat de modal nog correct opent vanaf nieuwe Wanbetalers > Inbox locatie

### Groep B — Finance > Klanten thin view (3-4 commits)

B1. **`shared/finance-klanten.js`** — module met:
- Klant-lijst (hergebruik `/api/customer-list`)
- Filters: status (actief/inactief), open bedrag (boven 0), arrangement-status
- Kolommen: naam / open bedrag / arrangements-count / dunning-status / actie-knop
- Detail-link → opent klant-modal (zelfde als Inbox)

B2. **finance.html: `<div id="view-klanten">`** toevoegen
- Mount `FinanceKlanten.mount(host)` bij setView('klanten')

B3. **#financeNav knop** "Klanten" toevoegen op positie 2

### Groep C — Finance Dashboard (8-10 commits)

**STATUS: PARTIAL (60-80% scope geleverd)**

GEDAAN:
- C1: `/api/finance-dashboard-counts.js` met 12 KPIs + in-memory SWR cache 5min.
- C2: `/api/finance-dashboard-chart-aging.js` (buckets 0-30/30-60/60-90/90+).
- C3: `/api/finance-dashboard-chart-top-debtors.js` (top 10 grootste openstaande klanten).
- C5: `/api/finance-dashboard-chart-arrangements.js` (donut per status).
- C9: `modules/shared/finance-dashboard.js` met 12 KPIs grid + 3 charts + period filter + manual refresh + Recharts CDN lazy-load.
- C10: `view-dashboard` container + financeNav knop op positie 1 + DOMContentLoaded default setView('dashboard').
- E1: `api/_lib/bank-balance.js` lazy-cache helper (15min TTL).

PARTIAL / TODO (vervolg-PR):
- C4: `/api/finance-dashboard-chart-joost-intents.js` (Joost suggestions stacked line over tijd).
- C6: `/api/finance-dashboard-chart-tasks.js` (Open Acties per type bar).
- C7: `/api/finance-dashboard-chart-cashflow.js` (3-maands cashflow line).
- C8: `/api/finance-dashboard-chart-payments.js` (nieuwe vs herhaal stacked bar).
- E2: `/api/finance-bank-balance.js` rewrite naar TL-source (huidige endpoint
  blijft op e-Boekhouden voor backward-compat; helper is klaar voor wissel).
- SWR-cache persistent in app_settings (huidige cache is in-memory per Vercel-instance).

Cache: in-memory SWR 5min per period acceptabel voor MVP; persistent later.
Recharts lazy-loaded via unpkg (React 17 + ReactDOM + Recharts 2). Bij CDN-fail:
fallback tabellen ipv crash.

### Groep D — Admin → Finance Settings migratie (4-6 commits)

**STATUS: PARTIAL (Joost AI verhuisd, Templates + Afdeling deep-link)**

GEDAAN (juni 2026):
- D1: `modules/shared/finance-instellingen.js` — wrapper-module met
  3 sub-tabs (Joost / Templates / Connection) + idempotente mount.
- D2: Joost AI volledig geporteerd — algemeen + autonomy + decision-log
  met identieke handlers (loadJoostConfig, saveJoostConfig,
  loadJoostAutonomyConfig, saveJoostAutonomyConfig, loadDecisionLog,
  switchJoostSubTab) + 30s decision-log polling + beforeunload cleanup.
- D5: `<div id="view-instellingen">` in finance.html + financeNav-knop
  op laatste positie + setView('instellingen') mount.
- D6: Joost-tab + ~500 regels JS uit admin.html verwijderd
  (admin.html: 5494 -> 4655 lines, netto -839 lines).

PARTIAL / TODO (vervolg-PR):
- D3: WhatsApp Templates volledige verhuis — tijdelijk deep-link naar
  admin.html#whatsapp-templates. Reden: template-editor met variabelen-
  paneel + Meta-sync + quick-replies is ~1400 regels code + grote modal-
  HTML (~200 regels). Veilig porteer-werk voor aparte PR.
- D4: WhatsApp Connection / Afdeling-config volledige verhuis —
  tijdelijk deep-link naar admin.html#whatsapp-connection. Reden:
  module-koppelings-tabel + Meta webhook-subscribe flow zit met
  WhatsApp-templates verweven; samen porteren is logischer.
- Beide deep-links gebruiken `target="_blank"` zodat de admin-flow
  niet de Finance-tab-state breekt.

RBAC-keys (admin.joost_config / admin.whatsapp_templates /
admin.arrangement_settings / finance.joost.*) zijn ONGEWIJZIGD in
FEATURE_REGISTRY — alleen Joost host-pagina is verplaatst.
Endpoints (joost-config-*, admin-meta-templates-*,
admin-whatsapp-modules-*) blijven server-side identiek.

### Groep E — Backend (3-4 commits)

E1. **`api/_lib/bank-balance.js`** — TL fetch + 15min cache
- Read `bank_accounts.balance_fetched_at`
- Als stale: TL fetch via teamleader-client, persist `balance` + `balance_fetched_at`
- Force-bypass via `{ force: true }`

E2. **`api/finance-bank-balance.js`** — thin HTTP endpoint
- Auth + RBAC `finance.bank.balance_view`
- Roept `_lib/bank-balance.js` aan
- Backward-compat: bestaande `finance-bank-balance` als deze al bestaat behouden

E3. **`api/finance-dashboard-counts.js`** — zie C1

E4. **`api/finance-dashboard-chart-*.js`** — zie C2-C8

### Groep F — Polish + smoke tests (2-3 commits)

F1. **Smoke-test doc** in `docs/finance-mega-smoke-tests.md`
- 4 secties (Dashboard / Klanten / Wanbetalers-nested / Settings)
- Per sectie: stappen + verwacht resultaat + regressie-checks

F2. **PR-beschrijving + screenshots**
- Preview-URL met all-tabs visible
- Diff-stat per groep

F3. **Eventuele bugfixes uit smoke tests**

## Risico's

1. **finance.html groeit naar 13-15k regels** — onderhoudbaarheid. Mitigatie: modularisatie via `shared/finance-*.js` bundles per tab.
2. **Klant-modal saga** (PRs #150-#158) — niet aanraken. Mitigatie: alleen tab-host verschuiven, modal-JS rust.
3. **Mega-PR merge risico** (PR #148 lesson) — Strict `"merged": true` assertion bij merge-script.
4. **Vercel cold-boot** — Recharts lazy-import om bundle-size te beperken.
5. **Backward-compat URLs** — `/modules/open-acties.html` is nu redirector. `/modules/wanbetalers.html` (legacy) moet vergelijkbare redirector krijgen (TODO in Groep A).
6. **Dashboard endpoint 60s limit** — `finance-dashboard-counts.js` moet sub-200ms zijn, charts apart via lazy. SWR-cache 5min in `app_settings`.

## Vervolg-prompts per groep (te plakken in nieuwe sessies)

Per groep een schone prompt opzetten in nieuwe chat-sessie zodat context beperkt blijft tot de relevante files. Mogelijke aanpak:

- **Sessie 2:** Groep A (Wanbetalers nested) — focus op finance.html sub-tab structuur + shared/finance-tasks.js extract
- **Sessie 3:** Groep B (Klanten thin view) — focus op finance-klanten.js + finance.html tab-knop
- **Sessie 4:** Groep C+E (Dashboard + backend) — endpoints + finance-dashboard.js. Eventueel via Workflow tool als gebruiker "ultracode" zegt.
- **Sessie 5:** Groep D (Settings migratie) — admin.html → finance-instellingen.js verhuis
- **Sessie 6:** Groep F (smoke tests + polish) + PR merge

## Alternatief: Workflow tool

Als Jeffrey "ultracode" of "use a workflow" zegt: Groep B + C + D zijn ideale fanout-kandidaten voor multi-agent parallel execution. Groep A moet sequential blijven omdat sub-tab structuur de basis is voor de rest.
