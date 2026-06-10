# Finance Mega-Restructure — Smoke Tests

**PR:** #162 (`feat/finance-mega-restructure` -> `main`)
**Doel:** stap-voor-stap verificatie van alle nieuwe en geherstructureerde
finance-flows + regressie-checks op bestaande functionaliteit.

Gebruik dit doc als checklist voor de smoke-test ronde direct na deploy van
de preview-branch en na de productie-merge. Bij iedere stap staat het
**verwacht resultaat** expliciet — wijk je hiervan af, log een issue en
mark de stap als gefaald.

## 0. Pre-flight (verplicht voor elke ronde)

1. **Vercel build is groen** voor `feat/finance-mega-restructure`
   - GitHub PR #162 toont groene check "Vercel - forex-opleiding-interface"
   - Preview-URL beschikbaar via PR-comment (vorm:
     `forex-opleiding-interface-git-feat-finance-mega-restructure-<hash>.vercel.app`)
2. **SQL migratie gedraaid** in productie Supabase
   - File: `docs/sql-migrations/2026-06-10-finance-mega-restructure.sql`
   - Verificatie-query (Supabase SQL editor):
     ```sql
     SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'bank_accounts'
        AND column_name IN ('balance', 'balance_fetched_at')
      ORDER BY column_name;

     SELECT indexname
       FROM pg_indexes
      WHERE tablename = 'bank_accounts'
        AND indexname = 'idx_bank_accounts_balance_fetched_at';
     ```
   - Verwacht: 2 rijen (`balance` numeric, `balance_fetched_at` timestamptz,
     beide nullable) + 1 rij voor de index.
3. **Env-vars aanwezig in Vercel** (`Settings > Environment Variables`):
   - `INTERNAL_API_TOKEN` (Sensitive, Production + Preview + Development)
   - `ANTHROPIC_API_KEY` (Sensitive, alle environments)
   - `COMPANY_NAME`, `COMPANY_ADDRESS`, `COMPANY_KVK`, `COMPANY_BTW`,
     `COMPANY_PHONE`, `COMPANY_EMAIL` (niet-Sensitive, alle environments)
   - Bij ontbreken `COMPANY_*`: de template-resolver returnt lege strings —
     niet kritisch voor smoke-test, wel notitie voor Jeffrey.
4. **Login als super_admin** (Jeffrey: biemoldjeffrey@gmail.com) zodat
   alle Finance-permissions actief zijn.

## 1. Dashboard (nieuwe Finance > Dashboard tab)

Doel: verifieer dat de nieuwe Dashboard-tab als default opent, alle 12
KPI-tegels rendert, charts lazy-loaden en drill-down werkt.

1. **Navigeer naar `/modules/finance.html`** (zonder query-string)
   - Verwacht: Dashboard-tab is **default actief** (donker geaccentueerd in
     #financeNav)
   - Verwacht: URL toont geen `?tab=...` (default = dashboard)
   - Verwacht: bij eerste paint zie je de KPI-grid binnen 1-2s
2. **KPI-tegels (12 stuks)**
   - Verwacht: openstaand totaal, aantal openstaande facturen, gem.
     ouderdom, achterstallig totaal, actieve arrangements, breached
     arrangements, Joost auto-sent (24u), open acties pending, bank-balans,
     en 3 trend-cellen renderen allemaal getallen (niet `--` of `NaN`)
   - Klik op KPI "Open acties pending":
     - Verwacht: switcht naar Wanbetalers > Open Acties sub-tab
     - Verwacht: URL update naar `?tab=wanbetalers&sub=open-acties`
3. **Charts (Recharts lazy CDN)**
   - Aging chart: bars 0-30 / 30-60 / 60-90 / 90+
   - Top debtors chart: top 10 horizontale bar
   - Arrangements donut: per status (VOORGESTELD / ACTIEF / NAGEKOMEN /
     VERBROKEN / GEANNULEERD)
   - Verwacht: charts renderen binnen 3-4s na initiele KPI-paint
   - Bij CDN-fail: fallback-tabel verschijnt ipv crash (console toont
     warning, geen error)
4. **Period-filter**
   - Wissel filter `30d / 90d / 12m`
   - Verwacht: counts + charts re-fetchen, URL update via history.replaceState
5. **Manual refresh button**
   - Klik refresh-knop bovenaan dashboard
   - Verwacht: spinner kort, daarna verse data (KPI-getallen kunnen
     identiek zijn binnen 5min SWR-window)
6. **SWR-cache gedrag**
   - Refresh de pagina 2x snel achter elkaar
   - Verwacht: tweede load is merkbaar sneller (cached counts payload,
     stale-while-revalidate). Cache is in-memory per Vercel-instance.
7. **Permission-gating**
   - Tijdelijk uitloggen, in als gebruiker zonder `finance.dashboard.view`
   - Verwacht: dashboard-tab is verborgen of toont permission-error
     (geen JS-crash)

## 2. Klanten (nieuwe Finance > Klanten thin view)

Doel: verifieer dat de Klanten-tab een klant-lijst met finance-context
toont en doorklik naar het volledige klantdossier (`klanten.html`) werkt.

1. **Open Finance > Klanten**
   - Verwacht: tabel met kolommen Naam / Open bedrag / Arrangements /
     Dunning-status / Actie
   - Verwacht: pagineerbare lijst, 25-50 rijen zichtbaar
2. **Filter "boven 0 open bedrag"**
   - Toggle de filter-pill
   - Verwacht: alleen klanten met open_amount > 0 (geen rijen met EUR 0,00)
3. **Filter "actieve arrangements"**
   - Toggle de pill
   - Verwacht: alleen klanten waar `arrangements_count > 0` en minstens
     1 arrangement is `ACTIEF`
4. **Search-veld**
   - Type 3+ chars van een klantnaam (bv. "Jeffrey")
   - Verwacht: server-side search via `/api/finance-customers`, debounce
     ~300ms
5. **Doorklik naar klantdossier**
   - Klik op klantnaam in een rij
   - Verwacht: opent `/modules/klanten.html?id=<uuid>` in nieuwe tab
   - Verwacht: klant-detail rendert met 6 sub-tabs (sales-redesign 3 juni)
6. **Permission-gating**
   - Gebruiker zonder `finance.customers.view`
   - Verwacht: Klanten-tab is verborgen of toont permission-error
7. **Lege staat**
   - Filter tot 0 resultaten
   - Verwacht: melding "Geen klanten gevonden" (geen lege tabel)

## 3. Wanbetalers (nested 4 sub-tabs)

Doel: verifieer dat de Wanbetalers-wrapper de 4 sub-tabs correct
orchestreert en dat de bestaande Inbox / Dunning / Arrangements logica
intact blijft (geen state-loss, geen klant-modal regressie).

1. **Open Finance > Wanbetalers**
   - Verwacht: default opent op sub-tab **Overzicht** (= oude view-dunning)
   - Verwacht: URL update naar `?tab=wanbetalers&sub=overzicht`
   - Verwacht: bestaande dunning sub-nav (overzicht / probleemklanten /
     workflows / templates / geschiedenis / arrangements) zichtbaar binnen
     de Overzicht sub-tab
2. **Switch naar Inbox sub-tab**
   - Klik "Inbox" in de Wanbetalers sub-tab-balk
   - Verwacht: view-inbox toont conversation-lijst + WhatsApp-chat panel
   - Verwacht: URL `?tab=wanbetalers&sub=inbox`
   - Verwacht: inbox auto-poll start (verifieer in DevTools network: poll
     elke ~30s op `inbox-list` of vergelijkbaar)
3. **Klant-modal regressie (KRITIEK)**
   - In Wanbetalers > Inbox: klik op een klant-naam in een conversation
     header
   - Verwacht: klant-modal opent zonder fouten (PR #156/158 stabiel,
     niet aangeraakt in deze restructure)
   - Verwacht: modal-content toont klant-overzicht + arrangements +
     factuur-tabel
   - Verwacht: sluitknop sluit modal cleanly (geen overlay-residu)
4. **Switch naar Arrangements sub-tab**
   - Klik "Arrangements"
   - Verwacht: view-arrangements toont arrangement-overzicht +
     propose-wizard knop
5. **Switch naar Open Acties sub-tab**
   - Klik "Open Acties"
   - Verwacht: FinanceTasks module mount in `#wb-sub-open-acties` host
   - Verwacht: filter-pills (Alle / PENDING / Approved / Executed) +
     tabel met `pending_actions`-rijen
   - Verwacht: identiek gedrag aan oude `/modules/open-acties.html`
     (zelfde detail-modal + mark-executed-flow)
6. **Sub-tab state behouden bij wisselen**
   - Switch naar Inbox, dan naar Overzicht, dan terug naar Inbox
   - Verwacht: inbox-conversation-selectie blijft behouden (geen reload-
     spinner, geen verloren chat-state)
7. **Sidebar-badge target**
   - Hover op Finance-link in sidebar
   - Verwacht: badge-count is zichtbaar als > 0 (Open Acties PENDING)
   - Klik op de badge:
     - Verwacht: navigeert naar
       `/modules/finance.html?tab=wanbetalers&sub=open-acties&status=PENDING`
   - Verwacht: Open Acties sub-tab is direct actief met PENDING-filter

## 4. Instellingen (Joost AI verhuisd uit Admin)

Doel: verifieer dat Joost AI config volledig in Finance > Instellingen
werkt, dat WhatsApp Templates + Connection deep-linken naar Admin, en dat
de Admin-pagina geen 404 of broken tabs heeft.

1. **Open Finance > Instellingen**
   - Verwacht: sub-tab-balk met Joost / Templates / Connection (of
     equivalent label)
   - Verwacht: default opent op Joost-tab
2. **Joost AI > Algemeen**
   - Verwacht: kun je persona / system_prompt / kennisbank / model_id
     velden zien en wijzigen
   - Wijzig persona, klik Opslaan
   - Verwacht: POST naar `/api/joost-config-upsert` returnt 200, toast
     "Opgeslagen" verschijnt
3. **Joost AI > Autonomy**
   - Verwacht: feature-flags rendering (e2_decision_engine_logs,
     e2_auto_send_text, e2_outbound_cron, etc.)
   - Verwacht: mandate-config (allowed_types, min/max bedragen, etc.)
   - Wijzig een flag (bv. `e2_decision_engine_logs` toggle, weer terug
     zetten), Opslaan
   - Verwacht: POST returnt 200
4. **Joost AI > Decision Log**
   - Verwacht: tabel met recente autonomy-decisions (bron:
     `joost-autonomy-decisions-list`)
   - Verwacht: 30s polling (verifieer in DevTools network)
   - Switch weg van Instellingen-tab
   - Verwacht: polling stopt (beforeunload cleanup)
5. **WhatsApp Templates sub-tab**
   - Klik "WhatsApp Templates" (of equivalent)
   - Verwacht: deep-link naar `admin.html#whatsapp-templates` (opent in
     **nieuwe tab** zodat Finance-state behouden blijft)
   - Verwacht: admin-pagina opent direct op de Templates-sectie
6. **WhatsApp Connection sub-tab**
   - Verwacht: deep-link naar `admin.html#whatsapp-connection` in nieuwe tab
7. **Permission-gating**
   - Gebruiker zonder `admin.joost_config` permission
   - Verwacht: Joost-tab is verborgen of toont permission-error

## 5. Backward-compat + regressie-checks

Doel: verifieer dat oude URLs, sidebar-links en het admin-paneel niet
gebroken zijn door de restructure.

1. **`/modules/open-acties.html` redirector**
   - Open `/modules/open-acties.html` direct in browser
   - Verwacht: melding "Module verhuisd" + auto-redirect na ~2s naar
     `/modules/finance.html?tab=wanbetalers&sub=open-acties`
2. **`/modules/open-acties.html?status=PENDING` redirector**
   - Verwacht: query-string blijft behouden, redirect naar
     `/modules/finance.html?tab=wanbetalers&sub=open-acties&status=PENDING`
3. **Sidebar Open Acties link is weg**
   - Open elke module met sidebar (dashboard, klanten, etc.)
   - Verwacht: er is **geen** nav-item "Open Acties" meer
   - Verwacht: badge zit inline op de Finance nav-item
4. **Admin-tabs die weg zijn**
   - Open `/modules/admin.html`
   - Verwacht: er is **geen** Joost AI tab meer in de admin-nav
   - Verwacht: Users / RBAC / TL-integraties tabs werken nog
   - Verwacht: geen JS-errors in console (geen verwijzingen naar
     verwijderde Joost-handlers)
5. **Admin WhatsApp Templates blijft (deep-link target)**
   - Open `/modules/admin.html#whatsapp-templates`
   - Verwacht: WhatsApp Templates tab is actief, template-editor rendert
6. **Direct deep-link naar Wanbetalers Overzicht (oud gedrag)**
   - Open `/modules/finance.html?tab=dunning`
   - Verwacht: legacy `?tab=dunning` mapt naar Wanbetalers > Overzicht
     (backward-compat in setView)
7. **Klant-modal vanaf Wanbetalers > Inbox**
   - Volledige flow: open Finance > Wanbetalers > Inbox -> klik klantnaam
   - Verwacht: modal opent identiek als voor de restructure
   - Verwacht: Acties-tab in modal toont arrangements + invoice-overzicht
   - Verwacht: sluiten via Esc + X-knop + click-outside werken alle 3
8. **Finance > Facturen blijft werken**
   - Open Facturen-tab
   - Verwacht: factuur-tabel + filters + detail-modal werken identiek
9. **Finance > Bank blijft werken**
   - Open Bank-tab
   - Verwacht: bank-tx + balans-card renderen
   - Verwacht: bank-balans gebruikt nu `_lib/bank-balance.js` lazy-cache
     (15min TTL, verifieer in DevTools network dat tweede load uit cache komt)
10. **Roadmap-tab blijft werken**
    - Open Finance > Roadmap
    - Verwacht: bestaande roadmap-content rendert
11. **Console clean**
    - Open DevTools console
    - Verwacht: geen rode errors over `FinanceDashboard is not defined`,
      `FinanceKlanten`, `FinanceInstellingen` of `FinanceTasks` (alle
      shared modules mounten idempotent)

## SQL migratie verificatie (productie Supabase)

Vóór merge naar main: draai onderstaande in Supabase SQL editor.

```sql
-- 1. Bevestig kolommen bestaan
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'bank_accounts'
   AND column_name IN ('balance', 'balance_fetched_at');

-- 2. Bevestig index
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'bank_accounts'
   AND indexname = 'idx_bank_accounts_balance_fetched_at';

-- 3. (Optioneel) Bekijk huidige cache-staat
SELECT id, name, balance, balance_fetched_at
  FROM bank_accounts
 ORDER BY balance_fetched_at NULLS FIRST
 LIMIT 10;
```

Verwacht:
- Query 1: 2 rijen, beide nullable, geen default
- Query 2: 1 rij met `CREATE INDEX ... NULLS FIRST`
- Query 3: rijen renderen zonder fout (balance kan NULL zijn tot
  eerste TL-fetch)

## Acceptance criteria voor merge

Alle 5 secties (1-5) **groen** + SQL verificatie geslaagd + Vercel build
groen. Bij falen van een sectie:
- **Sectie 1-4 (nieuwe features)**: log issue, hotfix in dezelfde PR
- **Sectie 5 (backward-compat)**: KRITIEK, blokkeert merge tot fix
