# INVENTARIS — Sales · Klanten · Finance · Wanbetalers

**Datum**: 2026-08-06
**Doel**: uitputtende checklist van ALLE interactieve UI-elementen, filters, kolommen, modals en verborgen sub-views in de vier modules die worden herbouwd. Dit is de contractuele checklist waar elke PR van de redesign tegen wordt getoetst. Er mag GEEN enkele knop, functie, filter of actie verloren gaan.

## Bron-bestanden

| Bestand | Regels | Sectie in dit document |
|---|---:|---|
| `modules/sales.html` | 2207 | [Sales](#1-sales) |
| `modules/sales-wizard.html` | 1888 | [Sales — Wizard 1](#1-sales) |
| `modules/subscription-wizard.html` | 1010 | [Sales — Wizard 2](#1-sales) |
| `modules/offerte-detail.html` | 799 | [Sales — Offerte-detail](#1-sales) |
| `modules/klanten.html` | 5153 | [Klanten](#2-klanten) |
| `modules/finance.html` r1-11500 | 11500 | [Finance — top-level](#3-finance--top-level-views) |
| `modules/finance.html` r11500-22000 | 10500 | [Finance — Wanbetalers deel 1](#4-finance--wanbetalers-deel-1) |
| `modules/finance.html` r22000-31978 | 9978 | [Finance — Wanbetalers deel 2](#5-finance--wanbetalers-deel-2) |

## Totalen per module

| Module | Checklist-items |
|---|---:|
| **Sales** (`sales.html` + 3 wizards + offerte-detail) | **216** |
| **Klanten** (`klanten.html`) | **188** |
| **Finance — top-level** (Dashboard/Facturen/Creditnota's/CAMT-Bank/Bank/Uitgaven/Roadmap/Instellingen) | **285** |
| **Finance — Wanbetalers deel 1** (Gesprekken/Overzicht/Probleemklanten/Workflows/Templates/Geschiedenis/Arrangements) | **282** |
| **Finance — Wanbetalers deel 2** (Instellingen-hub/Joost/Brieven/Case-sheet/Thread-handlers/Sandbox/Overzicht-nieuw/Pipeline/Acties-werkcentrum) | **259** |
| **TOTAAL** | **1230** |

## Werkwijze

- Elk item begint met `- [ ]` — check `- [x]` af zodra herbouw dat element dekt.
- Regelnummers verwijzen naar de brontabellen bij deze snapshot; geldig zolang de bron-files niet drastisch veranderen. Bij grote wijzigingen re-run agents.
- **Verborgen elementen** (`hidden`, `display:none`, deep-link-only) staan MEE in de lijst — de belofte "geen enkele functie verloren" dekt ook wat vandaag verborgen is maar via URL-parameter bereikbaar blijft.
- **Zichtbaarheid** per item genoteerd: publiek · role:xxx · hidden default · deep-link only.

## Grote observaties (uit agent-reports)

**Sales-cluster**:
- Alle tabellen zijn server-side gepagineerd (25/50/100/200/500).
- 5 status-conditionele actie-branches op offerte-detail (draft/sent/accepted+signed/failed/overige) — de herbouw moet exact deze branches respecteren.
- Uitgebreide deep-linking: `?tab=`, `?sub=`, `?customer_id=`, `?edit_deal_id=`, `?deal_id=`, `?mode=standalone` + 5 externe TL-URLs.
- Auto-save + resume-modal in sales-wizard; sessionStorage-prefill vanuit Events-detail.
- RBAC-gates op tabs, primaire acties (omzet-knop, cleanup-panel, product-manage, onboarding-create, reservation-fee-bypass).

**Klanten**:
- **Lijst-view is dead code** — `init()` in klanten.html redirect naar `sales.html?tab=klanten`. HTML staat er wel voor referentie/onderhoud.
- Detail-view heeft **7 tabs, niet 6**: Profiel · Communicatie · Offertes · Abonnementen · Facturen · Wanbetalers · Audit. De prompt-taxonomie (Finance/Deals/Onboarding/Notes) mapt op Facturen+Abonnementen / Offertes / card-in-Profiel / sectie-in-Communicatie.
- Header mist een expliciete **Anonimiseren-knop** hoewel de audit-log de actie kent — via andere ingang bereikbaar.
- Softphone-UI is body-level (callbar + rich sheet met line-select/retry/num-input/dial/hangup/mute), overleeft tab-wissels + soft-navigation.

**Finance — top-level**:
- 8 modals in Facturen alleen (invModal, payModal, claimPaidModal, sendModal, creditModal, updModal, newInvModal, newCustCreateModal).
- CAMT-Bank heeft eigen matches-tabel met bulk-matcher en autopilot-config.
- Uitgaven-cluster: 3 charts, 8 filters, 3 tabellen (tegenpartijen + vaste-lasten + breakdown), 1 shared bank-tx-modal.
- Instellingen-view is **dormant** — host bestaat, geen content aangebracht.

**Finance — Wanbetalers deel 1**:
- 4 zichtbare + 6 **hidden default** sub-tabs (deep-link-only): te-doen · open-acties · facturen · opruimen · arrangements · pipeline. Verborgen sinds fase 8 herontwerp; `?sub=xxx` werkt nog voor bookmarks.
- Thread-header ⋮ menu heeft 6 items (Archiveer/Heropenen/Uit-archief/Markeer-gelezen/Ongelezen/Dossier/Stuur-brief/Pauzeer-flow).
- Compose-strip heeft eigen 3-item ⋮ meer-menu.
- Joost AI modal heeft 7 knoppen incl. contextuele intent-action (verify-payment / arrangement / escalation-flow trigger).
- Arrangements-detail heeft pending-actions-tabel met per-rij `mark-executed` / `not-executed`.

**Finance — Wanbetalers deel 2**:
- INSTEL_CARDS-hub heeft 7 kaarten (waarvan Sandbox super_admin-only).
- Brieven-overzicht: 4 status-pills + search + refresh + multi-select tabel + bulk-print + bulk-mark-sent.
- Case-sheet drawer heeft 5 kaarten (Factuur/Bellen/Gesprek/WIK/Timeline) + 8-knops actiebar + 10 CALL_OUTCOMES elk met dedicated vervolg-modal.
- `wbxOpenConfirm` is gedeelde confirm-primitive — 12+ callers (WIK/Sluit-dossier/Mark-*/Snooze/Bel-taak/Pauzeer/etc.).
- Sandbox heeft 6 seed-inputs + 7 test-actie-knoppen + reset (super_admin).
- Actie-maker popup heeft 6 types + assignee-picker.
- `_WBX_ACTIE_TYPES` = 4 taak-types + 2 doorlink-types.

## Herbouw-contract

Elke PR die een deel van de herbouw dekt:
1. Vinkt de betreffende items af (`- [x]`).
2. Verwijst in de PR-body naar de sectie(s) uit dit document die worden gedekt.
3. Als een item **niet** meer wordt herbouwd (bewust laten vervallen): document dat in de PR-body en verplaats het item naar sectie **"Bewust laten vervallen"** onderaan dit document (nu leeg).

**Elke uitzondering vereist expliciete goedkeuring van de opdrachtgever.**

---

## 1. Sales

**Bron**: `modules/sales.html` (2207 rgs) + `modules/sales-wizard.html` (1888 rgs) + `modules/subscription-wizard.html` (1010 rgs) + `modules/offerte-detail.html` (799 rgs).

<!-- BEGIN sales-cluster.md -->

# Sales-cluster — inventaris interactieve elementen

Contract-checklist voor herbouw (redesign). 4 bestanden, gebaseerd op main branch (e855017).

Bestanden (absolute paden):
- `C:\Users\jeffr\forex-opleiding-interface\.claude\worktrees\dazzling-cohen-d366bb\modules\sales.html` (2207 rgs)
- `C:\Users\jeffr\forex-opleiding-interface\.claude\worktrees\dazzling-cohen-d366bb\modules\sales-wizard.html` (1888 rgs)
- `C:\Users\jeffr\forex-opleiding-interface\.claude\worktrees\dazzling-cohen-d366bb\modules\subscription-wizard.html` (1010 rgs)
- `C:\Users\jeffr\forex-opleiding-interface\.claude\worktrees\dazzling-cohen-d366bb\modules\offerte-detail.html` (799 rgs)

RBAC feature-keys aangetroffen (per-tab en per-actie):
`sales.tab.dashboard`, `sales.tab.customers`, `sales.tab.quotations`, `sales.tab.subscriptions`,
`sales.tab.retentie`, `sales.tab.aanbod`, `sales.tab.reports`, `sales.product.manage`,
`sales.reservation_fee.bypass`, `onboarding.create`.

---

## Sales > Global > Page-head + Tabs (sales.html)

- [ ] sales.html:r142 — "+ Nieuwe klant + offerte" — id `newDealBtn` → `location.href='/modules/sales-wizard.html'`
  - zichtbaarheid: publiek (geen gate op knop; wizard-endpoint gate't zelf)
- [ ] sales.html:r146 — "Dashboard" — tab data-tab=`dashboard` → gate `sales.tab.dashboard`
- [ ] sales.html:r147 — "Klanten" — tab data-tab=`customers` → gate `sales.tab.customers`
- [ ] sales.html:r148 — "Offertes" — tab data-tab=`quotations` → gate `sales.tab.quotations`
- [ ] sales.html:r149 — "Abonnementen" — tab data-tab=`subscriptions` → gate `sales.tab.subscriptions`
- [ ] sales.html:r150 — "Retentie" — tab data-tab=`retentie` → gate `sales.tab.retentie`
- [ ] sales.html:r151 — "Aanbod" — tab data-tab=`aanbod` → gate `sales.tab.aanbod`
- [ ] sales.html:r152 — "Rapporten" — tab data-tab=`reports` id `tab-btn-reports` → gate `sales.tab.reports`
- URL-deep-link `?tab=dashboard|klanten|customers|offertes|quotations|onboardings|abonnementen|subscriptions|retentie|aanbod|trajecten|producten|products|rapporten|reports` (r2177 tabMap)
- URL-deep-link `?sub=trajecten|producten` (r2175) → wisselt Aanbod sub-tab

## Sales > Dashboard > Hero + KPI-strip

- [ ] sales.html:r160 — Volgende-afspraak hero — id `dashNextBanner` (dynamic HTML)
  - Bevat "Start call" (r2078, `toast('Start call — binnenkort')` placeholder) + link → `/modules/klanten.html?id=<customer_id>`
  - zichtbaarheid: hidden default voor rollen zonder `sales.tab.customers` (mentor)
- [ ] sales.html:r163 — "Omzet deze maand" KPI-tegel — id `dashRevenueMonth`
- [ ] sales.html:r170 — KPI-link "Mijn open offertes" — id `dashMyQuotes` href `/modules/sales.html?tab=offertes`
- [ ] sales.html:r171 — KPI-link "Sales deze maand" — id `dashSalesCount` href `/modules/sales.html?tab=offertes`
- [ ] sales.html:r172 — KPI-link "Bonus deze maand" — id `dashMyBonus` href `/modules/sales.html?tab=rapporten`
- [ ] sales.html:r173 — KPI-link "Retentie" — id `dashRetentionStat` href `/modules/sales.html?tab=retentie`
  - zichtbaarheid: hidden default voor rollen zonder `sales.tab.customers`
- [ ] sales.html:r174 — KPI-link "Hoogste omzet-offerte" — id `dashHighestDeal` href `/modules/sales.html?tab=offertes`

## Sales > Dashboard > Activity + Pending

- [ ] sales.html:r176-190 — Grid "Vandaag/Deze week" — id `dashActivityBlock`
  - Rows: `dashTodayLeads`, `dashTodayEvents`, `dashTodayAppts`, `dashWeekLeads`, `dashWeekEvents`, `dashWeekAppts`, `dashTomorrowAppts`, `dashOpenFollowups`
  - Endpoint: `GET /api/sales-dashboard-stats` (r2059)
  - zichtbaarheid: hidden default voor rollen zonder `sales.tab.customers`
- [ ] sales.html:r191 — "Wachten op subscription" card — id `dashPendingCard` (title bevat `dashPendingCount`)
  - Body id `dashPending` toont per klant "Omzetten naar abonnement" of "✓ Abbo al ingevoerd" → `/modules/subscription-wizard.html?deal_id=<id>`
  - Endpoint: `GET /api/sales-pending-subscriptions`
  - zichtbaarheid: hidden default voor rollen zonder `sales.tab.customers`; conversie-knop bovendien `sales.tab.subscriptions`
- [ ] sales.html:r200 — "Laatste 5 offertes" card — id `dashRecentQuotes`
  - Row-links → `/modules/offerte-detail.html?id=<id>` (r2116)
  - Endpoint: `GET /api/sales-dashboard-metrics` (r2086)

## Sales > Klanten > Filter-strip

- [ ] sales.html:r208 — Zoek-input — id `custSearch` — placeholder "Zoek naam, email of telefoon…"
- [ ] sales.html:r209 — Entiteit-dropdown — id `custEntity` (client-side filter, gevuld r752)
- [ ] sales.html:r210 — Toggle "Alleen mijne" — id `custAllToggle` → `owned_by_me=true`
- [ ] sales.html:r211 — Vernieuwen-icon-button — id `custRefresh`

## Sales > Klanten > Segmenten

- [ ] sales.html:r214 — Segment "Alle" — data-seg=`alle`
- [ ] sales.html:r215 — Segment "Actief" — data-seg=`actief`
- [ ] sales.html:r216 — Segment "In onboarding" — data-seg=`onboarding`
- [ ] sales.html:r217 — Segment "Loopt af" — data-seg=`loopt_af`
- [ ] sales.html:r218 — Segment "Inactief" — data-seg=`inactief` (server-side reload, `status=archived`)

## Sales > Klanten > Tabel + row-acties

- Endpoint: `GET /api/sales-customers` (r708) — params `owned_by_me`, `status`, `search`, `page`, `page_size`
- KOLOMMEN (r784): Klant · Entiteit · Offertes (count) · Status · Laatste activiteit · Verkoper · [acties]
- [ ] sales.html:r787 — Row-link "Klant" → `/modules/klanten.html?id=<c.id>` (deep-link)
- [ ] sales.html:r780 — Kebab-menu row-actie "Bekijk klant" → `/modules/klanten.html?id=<c.id>`
- [ ] sales.html:r780 — Kebab-menu row-actie "Open in Teamleader" → `https://focus.teamleader.eu/company.php?id=…` (B2B) of `contact.php?id=…`
- [ ] sales.html:r800 — Paginering select "Per pagina" — id `custPageSize` (25/50/100/200/500)
- [ ] sales.html:r801 — Pagineringsknop "Vorige" — id `custPrev`
- [ ] sales.html:r802 — Pagineringsknop "Volgende" — id `custNext`

## Sales > Offertes > Filter-strip

- [ ] sales.html:r226 — Zoek-input — id `quotSearch` — placeholder "Zoek klantnaam of email…"
- [ ] sales.html:r227 — Entiteit-dropdown — id `quotEntity` (client-side filter, gevuld uit response)
- [ ] sales.html:r228 — Verkoper-dropdown — id `quotSeller` (client-side filter)
- [ ] sales.html:r229 — Toggle "Alleen mijne" — id `quotMineToggle` → `owned_by_me=true` (rollen zonder `sales.tab.customers` worden geforceerd, r842)
- [ ] sales.html:r230 — Vernieuwen-icon — id `quotRefresh` (herlaadt lijst + cleanup-panel)
- [ ] sales.html:r231 — TL-sync-icon "Ververs alle statussen vanuit Teamleader" — id `quotTlSync` → `POST /api/sales-deal-sync-status {all:true}`

## Sales > Offertes > Status-segmenten

- [ ] sales.html:r234 — Segment "Alle" — data-status=`` (default active)
- [ ] sales.html:r235 — Segment "Concept" — data-status=`draft`
- [ ] sales.html:r236 — Segment "Verzonden" — data-status=`sent`
- [ ] sales.html:r237 — Segment "Bevestigd" — data-status=`accepted`
- [ ] sales.html:r238 — Segment "Afgewezen" — data-status=`declined`
- [ ] sales.html:r239 — Segment "Verlopen" — data-status=`expired`

## Sales > Offertes > Opschoon-banner

- [ ] sales.html:r243 — Opschoon-banner — id `quotCleanupBanner` — telt geaccepteerde offertes zonder abo
  - zichtbaarheid: hidden default; visible bij items>0 én `sales.tab.subscriptions`
- [ ] sales.html:r247 — Knop "Opschonen…" — id `quotCleanupOpen` → opent modal `quotCleanupModal`
  - Endpoint: `GET /api/sales-cleanup-quotations`

## Sales > Offertes > Tabel + row-acties

- Endpoint: `GET /api/sales-quotations` (r849) — params `owned_by_me`, `status`, `search`, `page`, `page_size`
- KOLOMMEN (r880): Klant + #OFF-nr · Traject · Entiteit · Bedrag incl. · Status · Datum · Verkoper · [acties]
  - Sortable-kolommen: `amount` (Bedrag), `date` (Datum) — r881, r882
- Polling: elke 30s terwijl tab open (r551)
- Row-link "Klant" → `/modules/offerte-detail.html?id=<deal_id>` (r887)
- Row-primaire-actie (status-conditioneel, r1110-1163):
  - [ ] status `accepted`/`signed` + `sales.tab.subscriptions` → link "Omzetten naar abonnement" of "✓ Abbo al ingevoerd" → `/modules/subscription-wizard.html?deal_id=<id>`
  - [ ] status `accepted`/`signed` zonder recht → oog-icoon + TL-link fallback
  - [ ] status `sent` → knop "Opnieuw versturen" data-send → `openSendModal`
  - [ ] status `failed` → knop "Retry push" data-push → `retryPush` (`POST /api/sales-deal-retry-push`)
  - [ ] status `draft` met tl-id → knop "Versturen" data-send → `openSendModal`
  - [ ] status `draft` zonder tl-id → knop "Push naar TL" data-push → `retryPush`
- Row eye-icon → `/modules/offerte-detail.html?id=<id>` (r1112)
- Row TL-link → `https://focus.teamleader.eu/quotations/<tl_id>` (r1113)
- Kebab-menu items:
  - [ ] "Bewerken" (r1119) — alleen niet-sent/niet-accepted/niet-signed → `editQuotation()` → `/modules/sales-wizard.html?edit_deal_id=<id>`
  - [ ] "Kopiëren" (r1122) — data-copy → `copyQuotation()` → `POST /api/sales-deal-copy`
  - [ ] "Verwijderen" (r1126) — draft/sent/failed/accepted/signed → `deleteQuotation()` → `POST /api/teamleader-delete-quotation` (2× confirm bij accepted/signed)
  - [ ] "Status vernieuwen" (r1127) → `loadQuotations()`
  - [ ] "Markeer afgehandeld" / "Weer openzetten" (r1136-1138) — data-mark-done — accepted/signed + `sales.tab.subscriptions` → `POST /api/sales-deal-mark-subscription-done`
  - [ ] "Open in Teamleader" (r1141) → `https://focus.teamleader.eu/quotations/<tl_id>`
- [ ] sales.html:r914 — Paginering select "Per pagina" — id `quotPageSize` (25/50/100/200/500)
- [ ] sales.html:r915 — Paginering "Vorige" — id `quotPrev`
- [ ] sales.html:r916 — Paginering "Volgende" — id `quotNext`

## Sales > Offertes > Opschoon-modal (dynamic)

- Modal-host: `quotCleanupModal` (r254), dynamisch geïnjecteerd door `openCleanupModal()` (r979)
- [ ] sales.html:r991 — Sluiten (icon) — id `quotCleanupClose`
- [ ] sales.html:r997 — Sluiten-knop — id `quotCleanupCancel`
- [ ] sales.html:r998 — "Markeer geselecteerde afgehandeld" — id `quotCleanupBulk` → `bulkMarkCleanup()` (loop `POST /api/sales-deal-mark-subscription-done`)
- KOLOMMEN (r1050): checkbox · Klant + offerte · Bedrag · Bestaande abo's van klant · [open-link]
- [ ] r1049 — "Selecteer alles" — id `quotCleanupAll`
- [ ] r1034 — Per-row checkbox `data-cleanup-cb=<deal_id>`
- [ ] r1042 — Row-link → `/modules/offerte-detail.html?id=<deal_id>` (target=_blank)

## Sales > Offertes > Verstuur-modal (`#sendModal`)

- Modal-shell: `sendModal` (r388)
- [ ] r392 — Sluiten-icon — id `sendModalClose`
- [ ] r395 — Ontvanger — id `sendRecipient` (readonly)
- [ ] r397 — Email-template select — id `sendTemplate` (default option "Standaard (instelling / vaste NL-tekst)")
  - Endpoint: `GET /api/teamleader-email-templates?type=quotation` (r1238)
  - Voorselectie op "Offerte verzenden DFO" (r1252-1257)
- [ ] r403 — "Annuleer" — id `sendCancel`
- [ ] r404 — "Verstuur nu" — id `sendConfirm` → `doSendQuotation()` → `POST /api/teamleader-send-quotation`

## Sales > Abonnementen > Filter-strip

- [ ] sales.html:r259 — Zoek-input — id `subSearch` — placeholder "Zoek klant of omschrijving…"
- [ ] sales.html:r260 — Toggle "Alleen mijne" — id `subMineToggle`
- [ ] sales.html:r261 — Link "+ Nieuw abonnement (zonder offerte)" — id `newSubBtn` → `/modules/subscription-wizard.html?mode=standalone`
  - zichtbaarheid: hidden default voor rollen zonder `sales.tab.subscriptions`
- [ ] sales.html:r262 — Vernieuwen-icon — id `subRefresh`

## Sales > Abonnementen > Status-segmenten

- [ ] sales.html:r265 — Segment "Actief" — data-status=`active` (default active)
- [ ] sales.html:r266 — Segment "Gepauzeerd" — data-status=`paused`
- [ ] sales.html:r267 — Segment "Alle" — data-status=`all`
- [ ] sales.html:r268 — Segment "Gedeactiveerd" — data-status=`cancelled`

## Sales > Abonnementen > Tabel + row-acties

- Endpoint: `GET /api/sales-subscriptions-list` (r1456) — params `owned_by_me`, `status`, `page`, `page_size`
- KOLOMMEN (r1484): Klant · Bedrijf (entity) · Omschrijving + tl-koppel-flag · Bedrag incl. · Termijnen · Start · Eind · Aangemaakt · Status · [acties]
  - Sortable-kolommen: `amount`, `start`, `created`
- Row-link "Klant" → `/modules/klanten.html?id=<customer_id>&tab=abonnementen` (r1493)
- Row-primaire-actie: link "Detail" → `/modules/klanten.html?id=<customer_id>&tab=abonnementen`
- Kebab-menu items (r1494-1499):
  - [ ] "Uitstellen" → `/modules/klanten.html?id=<customer_id>&tab=abonnementen`
  - [ ] "Looptijd verlengen" → idem detail-tab
  - [ ] "Status vernieuwen" → `loadSubscriptions()`
  - [ ] "Open in Teamleader" (indien tl-id) → `https://focus.teamleader.eu/subscriptions/<tl_id>`
  - [ ] "Deactiveren" (indien niet cancelled) — data-subdel → `subListDelete()` → `POST /api/sales-subscription-delete` (met force-fallback bij 502)
- [ ] sales.html:r1526 — Paginering select — id `subPageSize`
- [ ] sales.html:r1527 — Paginering "Vorige" — id `subPrev`
- [ ] sales.html:r1528 — Paginering "Volgende" — id `subNext`

## Sales > Retentie > Filter-strip

- Subtitle: `retSubtitle` (r275)
- [ ] sales.html:r277 — Zoek-input — id `retSearch` — placeholder "Zoek klant…"
- [ ] sales.html:r278 — Toggle "Alleen mijne" — id `retMineToggle`
- [ ] sales.html:r279 — Vernieuwen-icon — id `retRefresh`

## Sales > Retentie > Segmenten (2 rijen)

- [ ] sales.html:r282 — Segment "Alle" — data-seg=`alle` (default active)
- [ ] sales.html:r283 — Segment "Urgent <14d" — data-seg=`urgent`
- [ ] sales.html:r284 — Segment "15-30 dgn" — data-seg=`soon`
- [ ] sales.html:r285 — Segment "Verlopen" — data-seg=`verlopen`
- [ ] sales.html:r288 — Segment "Open" — data-marked=`open` (default active)
- [ ] sales.html:r289 — Segment "Niet-verlengen" — data-marked=`not_renewing`
- [ ] sales.html:r290 — Segment "Alle" — data-marked=`all`

## Sales > Retentie > Tabel + row-acties

- Endpoint: `GET /api/sales-retention` (r1301) — params `owned_by_me`
- KOLOMMEN (r1340): Klant · Bedrijf (entity) · Traject · Mentor · Laatste eind (sortable `end`) · Tot einde · Abo's (count) · [acties]
- Row-link "Klant" → `/modules/klanten.html?id=<customer_id>`
- Row-expand caret (r1363, indien >1 abo) — data-ret-toggle → expand-row met sub-tabel (Abonnement/Start/Eind)
- Row-primaire-actie: "Nieuwe offerte" — `/modules/sales-wizard.html?customer_id=<id>` (r1378)
- Kebab-menu items (r1357-1361):
  - [ ] "Klant-detail bekijken" → `/modules/klanten.html?id=<id>`
  - [ ] "Markeer 'Niet-verlengen'" / "Toch verlengen" — data-ret-mark → `POST /api/sales-retention-mark`
  - [ ] "→ Follow-up" (of disabled "Op follow-up") — data-ret-fu → `POST /api/sales-retention-to-followup`

## Sales > Aanbod > Sub-tabs + toggle

- [ ] sales.html:r299 — Sub-tab "Trajecten" — data-sub=`trajecten` (default active) + count `aanbodTrajCount`
- [ ] sales.html:r300 — Sub-tab "Producten" — data-sub=`producten` + count `aanbodProdCount`
- [ ] sales.html:r302 — Toggle "Incl. BTW" — id `btwToggle` (persisted in localStorage `sales_btw_incl`)

## Sales > Aanbod > Trajecten sub-tab

- Endpoint: `GET /api/trajecten` (r1657)
- [ ] sales.html:r309 — "+ Nieuw traject" — id `newTrajectBtn` → `openTrajectModal(null)`
- Per-traject-card acties (r1672-1674):
  - [ ] "+ Variant" — data-addvar → `openVariantModal(trajectId, null)`
  - [ ] "✎" edit — data-edittraject → `openTrajectModal(id)`
  - [ ] "🗄" archiveren — data-deltraject → `deleteTraject()` → `DELETE /api/trajecten?id=<id>`
- Per-variant-row acties (r1682-1683):
  - [ ] "✎" edit — data-editvar → `openVariantModal(trajectId, variantId)`
  - [ ] "×" verwijderen — data-delvar → `deleteVariant()` → `DELETE /api/traject-variants?id=<id>`

## Sales > Aanbod > Traject-modal (`#trajectModal`)

- [ ] r357 — Sluiten-icon — id `trajectModalClose`
- [ ] r359 — Naam-input — id `tmName` (verplicht)
- [ ] r360 — Beschrijving-textarea — id `tmDesc`
- [ ] r363 — "Annuleer" — id `tmCancel`
- [ ] r363 — "Opslaan" — id `tmSave` → `saveTraject()` → `POST/PUT /api/trajecten`

## Sales > Aanbod > Variant-modal (`#variantModal`)

- [ ] r370 — Sluiten-icon — id `vmClose`
- [ ] r372 — Naam-input — id `vmName` (verplicht)
- [ ] r374 — Looptijd-input — id `vmDuration`
- [ ] r375 — Checkbox "Standaard-variant" — id `vmDefault`
- [ ] r378 — Producten-lijst — id `vmProducts` (elk item met quantity-input `data-vq` + remove-btn `data-vrm`)
- [ ] r379 — Product-picker select — id `vmProductPicker` (voegt product toe aan variant)
- [ ] r383 — "Annuleer" — id `vmCancel`
- [ ] r383 — "Opslaan" — id `vmSave` → `saveVariant()` → `POST/PUT /api/traject-variants`

## Sales > Aanbod > Producten sub-tab

- Endpoint: `GET /api/sales-products?active=true|<geen filter>` (r558)
- [ ] sales.html:r317 — Zoek-input — id `prodSearch` — placeholder "Zoek product…"
- [ ] sales.html:r318 — Categorie-dropdown — id `prodCategory`
- [ ] sales.html:r319 — Toggle "Toon gearchiveerd" — id `prodArchivedToggle`
- [ ] sales.html:r320 — "+ Nieuw product" — id `newProductBtn` → `openProductModal()`
  - zichtbaarheid: gate `sales.product.manage` (r626)
- KOLOMMEN (r597-599): Product (naam + beschrijving) · Categorie · BTW · Looptijd (center) · Prijs (incl./excl. sortable) · Teamleader (✓ TL of —) · Status · [acties]
- Row-acties (r617):
  - [ ] "✎" bewerken — data-edit → `openProductModal(id)` (gate `sales.product.manage`)
- Kebab-menu items (r604-607):
  - [ ] "Dupliceren" — `toast('Binnenkort beschikbaar')` placeholder (r604)
  - [ ] "Archiveren" — data-archive → `archiveProduct()` → `DELETE /api/sales-products?id=<id>`
  - [ ] "Open in Teamleader" (indien tl_product_id) → `https://focus.teamleader.eu/products/<id>`

## Sales > Aanbod > Product-modal (`#productModal`)

- [ ] r414 — Sluiten-icon — id `prodModalClose`
- [ ] r417 — Naam-input — id `pmName` (verplicht)
- [ ] r418 — Beschrijving-textarea — id `pmDesc`
- [ ] r422-424 — BTW-radios `name=vat` value=0/9/21 (default 21)
- [ ] r427 — Standaardprijs-input — id `pmPrice`
- [ ] r431-432 — Radios "Prijs is" `name=priceVat` value=`excl`/`incl` (default excl)
- [ ] r436 — Looptijd-input — id `pmDuration`
- [ ] r437 — Categorie-input met datalist — id `pmCat` datalist `catSuggest`
- [ ] r439 — Teamleader Product-ID — id `pmTlId`
- [ ] r443 — "Annuleer" — id `pmCancel`
- [ ] r444 — "Opslaan" — id `pmSave` → `saveProduct()` → `POST/PUT /api/sales-products`

## Sales > Rapporten > View-tabs

- [ ] sales.html:r329 — Sub-tab "Sales-rapport" — data-view=`sales` (default active)
- [ ] sales.html:r330 — Sub-tab "Abonnementen MRR" — data-view=`mrr`

## Sales > Rapporten > Sales-view filter-strip

- [ ] sales.html:r335 — Segment "Vandaag" — data-range=`today`
- [ ] sales.html:r336 — Segment "Week" — data-range=`week`
- [ ] sales.html:r337 — Segment "Maand" — data-range=`month` (default active)
- [ ] sales.html:r338 — Segment "Kwartaal" — data-range=`quarter`
- [ ] sales.html:r339 — Segment "Jaar" — data-range=`year`
- [ ] sales.html:r341 — Van-datum — id `repFrom` (date)
- [ ] sales.html:r342 — Tot-datum — id `repTo` (date)
- [ ] sales.html:r343 — Groepering-select — id `repGroupBy` (day/week/month, default month)
- [ ] sales.html:r344 — "Toepassen" — id `repApply` → `loadReports()` → `GET /api/sales-reports`
- [ ] sales.html:r345 — "Export Excel" — id `repExport` → `repExport()` (XLSX-bundling van KPI/sales-users/trend/entiteit/trajecten/retentie/onboarding)
- [ ] sales.html:r346 — Vernieuwen-icon — id `repRefresh`

## Sales > Rapporten > Sales-view content

- KPI-tegels (r1963-1968): Pipeline (open) · Omzet periode · Bonus pending · Retentie
- Charts (r1970-1973, Chart.js): Conversie funnel · Omzet trend · Omzet per entiteit · Top trajecten
- Tabel "Per sales-medewerker" (r1976): KOLOMMEN Medewerker · Offertes · Conversie · Omzet · Bonus pending · Bonus paid
- Tabellen Retentie + Onboarding (r1980-1990): interne key/value-rijen

## Sales > Rapporten > MRR-view (`repMrrView`)

- [ ] sales.html:r1822 — Periode-select — id `mrrPeriod` (deze_maand/vorige_maand/dit_kwartaal/vorig_kwartaal/dit_jaar/vorig_jaar/custom, persisted `mrr_period`)
- [ ] sales.html:r1819 — Custom-datum-range — ids `mrrCustStart` + `mrrCustEnd` (visible bij `custom`)
- [ ] sales.html:r1824 — Entiteit-select — id `mrrEntity` (persisted `mrr_entity`)
- KPI-tegels (r1828-1831): MRR eind periode (clickable → drilldown) · Actieve abo's · Gem. MRR/abo · Inkomende omzet
- Charts (r1834-1839): MRR per maand (met projectie-stippellijn) · Aantal actieve abo's · New vs Churned MRR per maand · MRR per traject (doughnut)
- Tabel "Top 10 grootste actieve abonnementen" (r1842): KOLOMMEN Klant · Omschrijving · Cyclus · MRR (incl.)
- Row-link "Klant" → `/modules/klanten.html?id=<customer_id>`

## Sales > Rapporten > MRR drill-down modal (dynamic)

- Trigger: klik op KPI-tegel "MRR eind periode" (`mrrKpiCard` — r1854)
- Overlay id `mrr-drill-ov` (r1875)
- [ ] r1884 — Sluiten-icon — id `mrrDrillClose`
- [ ] r1879 — Entity-pills — id `mrrDrillPills` data-e (dynamisch)
- Tabel `mrrDrillTable` (r1880): KOLOMMEN Klant · Omschrijving · Bedrag/termijn · Billing cycle · MRR-bijdrage (+ Totaal-row)
- Row-link "Klant" → `/modules/klanten.html?id=<customer_id>`

---

## Sales > Wizard1 > Global (sales-wizard.html)

- Head-strip: id `saveInd` (auto-save status)
- [ ] sales-wizard.html:r192 — "Annuleer & verlaat" — id `exitBtn` → `confirmExit()` (autosave + terug naar sales.html)
- Progress-bar: id `progressBar` (5 stappen: Bedrijf/Klantgegevens/Offerte & producten/Betalingsvoorwaarden/Bevestiging & versturen)
- Footer:
  - [ ] r365 — "← Vorige" — id `prevBtn`
  - [ ] r366 — Link "Sla op als concept en sluit" — id `saveExitLink` → `confirmExit()`
  - [ ] r367 — "Volgende →" — id `nextBtn` (async; kan `exceptionModal` openen bij 4→5)
- URL-params:
  - `?customer_id=<uuid>` → prefill klant + lock stap (r965)
  - `?edit_deal_id=<uuid>` → bestaande offerte heropenen (r906)
- Session-storage prefill: `_prefill_event_attendee` (r943) — one-shot vanuit Events-detail
- Auto-save endpoint: `POST /api/sales-wizard-drafts` (r842); resume endpoint: `GET /api/sales-wizard-drafts` (r991); delete: `DELETE /api/sales-wizard-drafts` (r1022)

## Sales > Wizard1 > Stap 1: Bedrijf

- Entiteit-cards container: id `entityCards` (dynamisch, data-dept per kaart)
  - Endpoint: `GET /api/company-entities` (r886)
- [ ] r819 — Elke entity-card klikt → zet `state.wizard.tl_department_id`

## Sales > Wizard1 > Stap 2: Klantgegevens

- Bestaande-klant-banner: id `existingCustBanner` (getoond na dup-match)
  - [ ] r211 — Link "Wissel klant" — id `swapCustLink` → `hideExistingBanner()`
- [ ] r215 — Checkbox "Dit is een bedrijf (B2B)" — id `f_is_company`
- [ ] r219 — Bedrijfsnaam — id `f_company_name` (sw-company-only, verplicht bij B2B)
- [ ] r220 — KvK-nummer — id `f_kvk`
- [ ] r223 — BTW-nummer — id `f_vat`
- [ ] r227 — Voornaam — id `f_first`
- [ ] r228 — Achternaam — id `f_last`
- [ ] r231 — Email — id `f_email` (auto-trigger dup-check bij blur, r1204)
- [ ] r232 — Telefoon — id `f_phone`
- [ ] r235 — "🔍 Zoek in onze DB + Teamleader" — id `dupCheckBtn` → `POST /api/sales-customer-duplicate-check` + `POST /api/teamleader-search-contacts` → opent `dupModal`
- [ ] r241 — Checkbox "Ik heb de adresgegevens al (adres niet nodig in offerte)" — id `addrKnownCheck`
- [ ] r246 — Straat — id `f_street`
- [ ] r247 — Huisnr — id `f_number`
- [ ] r248 — Postcode — id `f_postal`
- [ ] r251 — Plaats — id `f_city`
- [ ] r252 — Land — id `f_country` (NL/BE, default NL)
- [ ] r253 — Geboortedatum — id `f_dob`
- Tags:
  - [ ] r259 — Chip-row — id `tagRow` (pre-tags: vip/risico/ambassadeur/pilot/oud-lead)
  - [ ] r261 — Nieuwe-tag-input — id `newTagInput`
  - [ ] r262 — "Voeg toe" — id `addTagBtn`
- [ ] r268 — Checkbox "Klant is geïnformeerd over privacyverklaring" — id `avgCheck` (verplicht)
  - Link "privacyverklaring" → `/privacy`
- Validatie-summary: id `step2Missing` (r271)

## Sales > Wizard1 > Stap 2: Duplicate-check-modal (`#dupModal`)

- [ ] r376 — Sluiten-icon — id `dupClose`
- [ ] r378 — Body — id `dupBody` (dynamisch: sectie DB-matches + sectie TL-matches)
  - Per DB-match: "Gebruik deze klant" (data-use-db) + "Negeer"
  - Per TL-match: "Gebruik dit contact" (data-use-tl → prefill velden uit TL) + "Negeer"
- [ ] r381 — Link "Geen van deze - doorgaan met nieuwe klant" — id `dupContinueNew`

## Sales > Wizard1 > Stap 3: Offerte & producten

- [ ] r280 — Traject-select — id `trajectSelect` (optgroups per traject; leeg = "Geen traject")
  - Endpoint: `GET /api/trajecten` (r887) + `GET /api/traject-variants?variant_id=…` bij keuze
- [ ] r281 — "Reset" — id `trajectReset`
- [ ] r285 — Type verkoop — id `saleType` (`domestic`/`intracommunautair`)
- [ ] r292 — Offerte-referentie — id `quoteRef`
- [ ] r293 — Lead-bron — id `leadSource` (nu "Binnenkort beschikbaar")
- [ ] r296 — Datum offerte — id `startDate` (verplicht)
- [ ] r300 — Looptijd input — id `durationMonths`
- [ ] r302-305 — Duur-chips 6/12/24/36 mnd (data-dur)
- [ ] r312 — "+ Product toevoegen" — id `addProductBtn` → opent `prodPicker`
- Deal-products lijst: id `dealProducts` (r314)
  - Per row: quantity `data-qty`, price `data-price`, remove `data-rm`, toggle incl/excl `data-toggle`
- Totalen-block: id `dealTotals` (r315)
  - Korting-link "+ Korting" / "Korting (…%) wijzigen" / "verwijderen" — ids `discountEdit` / `discountRemove` → opent `discountModal`

## Sales > Wizard1 > Stap 3: Product-picker-modal (`#prodPicker`)

- [ ] r389 — Sluiten-icon — id `prodPickerClose`
- [ ] r392 — Zoek-input — id `ppSearch`
- [ ] r393 — Categorie-select — id `ppCat`
- [ ] r395 — Lijst — id `ppList` (elke card `data-pid`, klik voegt product toe)
- [ ] r397 — Link "Annuleer" — id `ppCancel`

## Sales > Wizard1 > Stap 3: Korting-modal (`#discountModal`)

- [ ] r451 — Sluiten-icon — id `discountClose`
- [ ] r453 — Korting-input % — id `discountInput`
- [ ] r456 — "Annuleer" — id `discountCancel`
- [ ] r456 — "Toepassen" — id `discountApply`

## Sales > Wizard1 > Stap 4: Betalingsvoorwaarden

- [ ] r323 — Startdatum cursus — id `payStartDate` (verplicht; min = vandaag+3)
- [ ] r327 — Aanbetaling (€) — id `payDownAmount`
- [ ] r328 — Aanbetaling-datum — id `payDownDate` (max = startdatum-3)
- [ ] r331 — Aantal termijnen — id `payTermCount` (verplicht ≥1)
- [ ] r332 — Datum 1e termijn — id `payTermStartDate` (conditionele bounds: met aanbet → tot start+30; zonder → tot start-3)
- [ ] r334 — Termijnbedrag readonly — id `payTermAmount`
- Preview-block: id `payPreview` (r337)
- Uitzondering-approval-block (r342): id `exceptionApprovalBlock` (hidden default; toont summary + "Ongedaan maken"-knop id `exceptionUndoBtn`)
- Validatie-summary: id `payMissing` (r351)

## Sales > Wizard1 > Stap 4: Exception-modal (`#exceptionModal`)

- Trigger: overgang 4→5 als termijn te laag of startdatum te ver in toekomst
- Endpoint voor limits: `GET /api/app-settings?key=sales_min_term_amount` + `sales_max_start_days` (r863-864)
- [ ] r410 — Sluiten-icon — id `exceptionClose`
- Reasons-lijst: id `exceptionReasonsList` (dynamisch)
- [ ] r418 — Textarea "Reden van de uitzondering" — id `exceptionReasonNote` (verplicht)
- [ ] r421 — Checkbox "€100 reserveringsfee akkoord" — id `exceptionFeeCheck` (visible bij late_start)
- [ ] r427 — "Manager niet akkoord" — id `exceptionReject`
- [ ] r428 — "Goedgekeurd door manager" — id `exceptionApprove`

## Sales > Wizard1 > Concept-resume-modal (`#resumeModal`)

- Trigger: bestaand draft gevonden bij init
- Datum-label: `resumeDate` (r438)
- [ ] r442 — "Nieuw beginnen" — id `resumeNew` → `DELETE /api/sales-wizard-drafts`
- [ ] r443 — "Doorgaan" — id `resumeContinue` → laadt draft in state

## Sales > Wizard1 > Stap 5: Bevestiging & versturen

- Review-container: id `reviewMount` (r358) — 3 sections (Klant / Offerte / Betalingsvoorwaarden), elk met "Bewerken"-link data-back=2/3/4
- Banner-container: id `tlBanner` (r359) — ok/warn afhankelijk van TL-status (`GET /api/teamleader-test-connection`)
- Submit-block: id `submitBlock` (r360)
  - TL connected:
    - [ ] "Push naar Teamleader (concept, zonder versturen)" — id `submitWithTl` → `submitDeal(true)`
    - [ ] Link "Alleen lokaal opslaan (geen offerte versturen)" — id `submitLocalOnly` → `submitDeal(false)`
  - TL niet connected:
    - [ ] "Sla op (lokaal)" — id `submitLocal` → `submitDeal(false)`
- Submit endpoint: `POST /api/sales-deal-create` (r1618) OF `PUT /api/sales-deal-update` (r1609, edit-mode)

---

## Sales > Wizard2 > Global (subscription-wizard.html)

- Modes: `?mode=standalone` (r144) OR default deal-mode (`?deal_id=<uuid>`)
- Extra URL-params: `?customer_id=<uuid>` + `?customer_name=<str>` (standalone-prefill, r329)
- Terug-link: r73 → `/modules/sales.html?tab=abonnementen`
- Sub-title: id `topSub` (r75)
- Steps-nav: id `subSteps` (r77) — 3 stappen: Klant & offerte / Abonnementen / Bonus & bevestigen (in standalone: "Klant")
- Footer:
  - [ ] r134 — "← Vorige" — id `prevBtn`
  - [ ] r135 — "Volgende →" — id `nextBtn` (met stap-validatie: customer + subs)

## Sales > Wizard2 > Stap 1 (deal-mode): Klant & offerte

- Container: id `step1Body` (r85)
- Dynamisch: `reviewCard` toont klantnaam + email + totaal incl. + getekend-datum
- [ ] r363 — Link "↗ Zonder offerte aanmaken" (indien standalone-href beschikbaar) → `/modules/subscription-wizard.html?mode=standalone&customer_id=…&customer_name=…`
- Endpoint: `GET /api/sales-deal-detail?id=<deal_id>` (r313)

## Sales > Wizard2 > Stap 1 (standalone): Klant kiezen

- Container: id `step1Body`, gerenderd door `renderCustomerStep()` (r382)
- Chosen-block: id `custChosen` (r385)
  - "wijzig" link (r422) — id `clearChosen`
  - Openstaande-offertes-warning: id `openQuotWarn` (r421, endpoint `GET /api/sales-quotations?customer_id=…&page_size=100`)
    - Per open-offerte inline: link "Omzetten →" → `/modules/subscription-wizard.html?deal_id=…`
- [ ] r388 — Zoek-input bestaande klant — id `custSearch` (endpoint `GET /api/sales-customers?search=`)
- Zoekresultaten: id `custResults` (r388)
- [ ] r389 — Toggle "+ Nieuwe klant aanmaken" / "↩ Toch een bestaande klant zoeken" — id `toggleNewCust`
- Nieuwe-klant form (id `newCustForm`):
  - [ ] r392 — Voornaam — id `nc_first`
  - [ ] r393 — Achternaam — id `nc_last`
  - [ ] r396 — Email — id `nc_email` (auto-trigger TL-search bij blur, r473)
  - [ ] r397 — Telefoon — id `nc_phone`
  - [ ] r399 — "🔍 Zoek dit contact in Teamleader" — id `tlSearchBtn` → `POST /api/teamleader-search-contacts`
  - TL-resultaten: id `tlResults` (elke row `data-tl` — importeert)
  - [ ] r401 — Straat — id `nc_street`
  - [ ] r402 — Huisnr — id `nc_number`
  - [ ] r403 — Postcode — id `nc_postal`
  - [ ] r406 — Plaats — id `nc_city`
  - [ ] r407 — Geboortedatum — id `nc_dob`
  - [ ] r410 — Checkbox "Privacy geïnformeerd" — id `nc_avg` (verplicht)
- Foutmelding: id `custErr` (r413)

## Sales > Wizard2 > Stap 2: Abonnementen

- [ ] r92 — Bedrijfsentiteit — id `deptSelect` (gevuld uit `GET /api/company-entities`)
- [ ] r95 — Type verkoop (BTW-regeling) — id `saleTypeSel` (standalone-only, visible via `saleTypeWrap`)
- [ ] r100 — "+ Abonnement toevoegen" — id `addSub` → `state.subs.push(newEmptySub()); renderSubs()`
- Sub-lijst container: id `subList` (r102)
- Totaal-block: id `subTotal` (r103)
- Foutmelding: id `p2err` (r104)

### Per sub-card (dynamisch, r707):
- [ ] Delete-knop (indien >1 sub) — data-rm
- [ ] Omschrijving-select — data-descsel (opties: presets uit trajecten + "Andere omschrijving…")
  - Custom-invoer indien "__custom__" gekozen — data-desccustom
- [ ] Startdatum — data-f=`start_date` (min = vandaag NL; max conditioneel per kind)
- [ ] Aantal termijnen — data-f=`term_count` (verplicht ≥1, blur-clamp naar 1)
- [ ] Einddatum readonly — data-end (auto-berekend)
- Line-items lijst: data-lilist per sub (r718)
- [ ] "+ Regel toevoegen" — data-addli (r729)
- [ ] Sub-total row: data-subtot per sub

### Per line-item row (dynamisch, r720):
- [ ] Product-select — data-prod ("Vrije invoer" + producten uit `GET /api/sales-products?active=true`)
- [ ] Beschrijving — data-lf=`description`
- [ ] Excl. BTW — data-amt=`excl`
- [ ] Incl. BTW — data-amt=`incl`
- [ ] BTW-select — data-lf=`vat_percentage` (0/9/21, disabled bij zero-vat)
- [ ] Verwijder-regel — data-rmli (indien >1 regel)

### Override-block (r695, conditioneel):
- [ ] Checkbox "Startdatum-controle overslaan (alleen voor WIJZIGEN van bestaande abonnementen)" — id `overrideStartDate`

## Sales > Wizard2 > Stap 3: Bonus & bevestigen

- Bonus-block: id `bonusBlock` (r109) — dynamisch (indicatieve 3% over aanbetaling ≥ €1000)
- Preview-block: id `subPreview` (r110) — samenvatting subs + TL-push-preview
- Reserveringsfee-bypass card: id `bypassFeeCard` (r116)
  - zichtbaarheid: hidden default; visible bij permission `sales.reservation_fee.bypass` (r916)
  - [ ] r119 — Checkbox "Omzeil de €100 reserveringsfee" — id `bypassFeeChk`
  - Reason-wrap: id `bypassFeeReasonWrap`
  - [ ] r125 — Textarea reden — id `bypassFeeReason` (verplicht min. 10 tekens)
  - Reden-hint: id `bypassFeeReasonHint`
- Submit-block: id `submitBlock` (r130)
  - [ ] "Activeer abonnementen + push naar Teamleader" — id `submitTl` → `submit(true)`
  - [ ] Link "Alleen lokaal opslaan" — id `submitLocal` → `submit(false)`
- Submit endpoint: `POST /api/sales-subscription-create` (r992) — payload afhankelijk van mode (deal_id vs matched_customer_id/customer_data)

---

## Offerte-detail > Page-head (offerte-detail.html)

- URL-param: `?id=<deal_id>` (r205, verplicht)
- Terug-link: r117 → `/modules/sales.html`
- Titel: id `detailTitle` (r118)
- Sub-info: id `detailSub` (r119) — status-badge + TL-koppel-flag + meta (OFF-nr / aangemaakt / getekend)
- [ ] r122 — "🔄 Vernieuwen" — id `refreshBtn` → `load()`
- [ ] r123 — "↻ Ververs vanuit Teamleader" — id `tlSyncBtn` → `POST /api/sales-deal-sync-status {deal_id}`
- Acties-container: id `detailActions` (r124) — dynamische knoppen per status

## Offerte-detail > Detail-body panels

- Endpoint: `GET /api/sales-deal-detail?id=<deal_id>` (r267)

### Card "Klant" (r312):
- Row-link "Klant-detail" → `/modules/klanten.html?id=<c.id>` (r316)
- E-mail row: `mailto:<email>` link
- Telefoon row: `tel:<phone>` link

### Card "Offerte-info" (r318):
- Rows: Entiteit · Type verkoop · Looptijd · Startdatum cursus

### Panel "Producten" (r326):
- KOLOMMEN: Product · Aantal (center) · Prijs/stuk excl. (num) · BTW (center) · Subtotaal excl. (num) · Incl. BTW (num)

### Card "Totalen" (r340):
- Rows: Subtotaal excl. BTW · Korting · BTW per tarief · Totaal incl. BTW

### Card "Betalingsvoorwaarden" (r346):
- Rows: Aanbetaling · Termijnen · 1e termijn · Startdatum cursus

## Offerte-detail > Status-conditionele actie-knoppen (`detailActions`)

- **Bij status `accepted`/`signed`** (r357):
  - [ ] "Omzetten naar abonnement" / "✓ Abbo al ingevoerd" (link) — gate `sales.tab.subscriptions` → `/modules/subscription-wizard.html?deal_id=<id>`
  - [ ] "Onboarding-traject aanmelden" — gate `onboarding.create` → opent `obModal`
  - [ ] "Koppel aan historisch event" (link) — gate `sales.tab.subscriptions` (proxy) → `/modules/admin-historical-events.html?deal_id=<id>`
  - [ ] "Kopiëren" — `doCopy()` → `POST /api/sales-deal-copy`
  - [ ] "↗ Open in TL" (indien tl_id) → `https://focus.teamleader.eu/quotations/<tl_id>`
- **Bij status `sent`** (r390):
  - [ ] "Opnieuw versturen" — `openOdSendModal()` → opent `odSendModal`
  - [ ] "Markeer als getekend" — `doMarkAccepted()` → `POST /api/sales-quotation-mark-accepted`
  - [ ] "Kopiëren" — `doCopy()`
  - [ ] "Verwijderen" — `doDelete()` → `POST /api/teamleader-delete-quotation` (2× confirm)
  - [ ] TL-link (indien tl_id)
- **Bij status `draft`** (r392):
  - [ ] "Versturen" (met tl_id) — `openOdSendModal()` OR "Push naar TL" (zonder tl_id) — `doPush()` → `POST /api/sales-deal-retry-push`
  - [ ] "Bewerken" (link) → `/modules/sales-wizard.html?edit_deal_id=<id>`
  - [ ] "Kopiëren" — `doCopy()`
  - [ ] "Verwijderen" — `doDelete()`
  - [ ] TL-link (indien tl_id)
- **Overige statussen** (declined/expired/failed, r395):
  - [ ] "Kopiëren" + TL-link

## Offerte-detail > Verstuur-modal (`#odSendModal`)

- Trigger: "Versturen" / "Opnieuw versturen" op sent/draft-status
- [ ] r175 — Sluiten-icon — id `odSendModalClose`
- Ontvanger read-only: id `odSendRecipient` (r179)
- [ ] r181 — Template-select — id `odSendTemplate` (default option "Standaard (instelling)")
  - Endpoint: `GET /api/teamleader-email-templates?type=quotation` (r437)
  - Voorselectie op "Offerte verzenden DFO" (r455-459)
- Hint-text: id `odSendHint`
- Foutmelding: id `odSendErr`
- [ ] r186 — "Annuleren" — id `odSendCancel`
- [ ] r187 — "Verstuur nu" — id `odSendConfirm` → `odDoSend()` → `POST /api/teamleader-send-quotation`

## Offerte-detail > Onboarding-modal (`#obModal`)

- Trigger: "Onboarding-traject aanmelden" op accepted/signed-status
- [ ] r139 — Sluiten-icon — id `obModalClose`
- Klant-label read-only: id `obCustomerLabel` (r144)
- Type-switch segmented (r146):
  - [ ] "1-op-1 begeleiding" — data-ob-type=`1op1`
  - [ ] "Membership" — data-ob-type=`membership`
- [ ] r151 — Traject-select — id `obTrajectSel` (gevuld o.b.v. type-keuze uit `GET /api/onboarding-trajecten-list`)
- [ ] r153 — Startdatum — id `obStartDate` (min = vandaag NL + 3 kalenderdagen; prefill uit offerte)
- Foutmelding: id `obError`
- [ ] r163 — "Annuleren" — id `obCancelBtn`
- [ ] r164 — "Aanmelden" — id `obSubmitBtn` → `submitObCreate()` → `POST /api/onboarding-create`
- Post-success:
  - Success-block: id `obStepDone`
  - Persoonlijke link input: id `obLinkInput` (readonly)
  - [ ] "📋 Kopieer link" — id `obCopyBtn`
  - "Sluiten"-knop (cancel-btn hernoemd, r770)

---

## Cross-referenties (endpoints per module)

- `/api/sales-dashboard-stats` — dashboard KPI's
- `/api/sales-dashboard-metrics` — persoonlijke metrics
- `/api/sales-pending-subscriptions` — wachten-op-sub card
- `/api/sales-customers` — klantenlijst + zoek
- `/api/sales-quotations` — offertelijst + polling
- `/api/sales-cleanup-quotations` + `/api/sales-deal-mark-subscription-done` — cleanup-flow
- `/api/sales-deal-retry-push` — TL-push retry
- `/api/sales-deal-copy` — kopiëren
- `/api/sales-deal-sync-status` — TL-status ophalen (per-deal of `all:true`)
- `/api/sales-deal-detail` — offerte-detail + wizard-edit prefill
- `/api/sales-deal-create` / `/api/sales-deal-update` — wizard-submit
- `/api/sales-quotation-mark-accepted` — handmatig accepteren
- `/api/sales-subscriptions-list` — abbo-lijst
- `/api/sales-subscription-delete` — abbo deactiveren (met force-fallback)
- `/api/sales-subscription-create` — wizard2-submit
- `/api/sales-retention` + `/api/sales-retention-mark` + `/api/sales-retention-to-followup` — retentie-tab
- `/api/sales-products` — CRUD producten
- `/api/sales-customer-duplicate-check` + `/api/teamleader-search-contacts` — dup-check
- `/api/sales-wizard-drafts` — autosave/resume/delete
- `/api/sales-reports` + `/api/sales-mrr-report` — rapporten
- `/api/company-entities` — entiteiten
- `/api/trajecten` + `/api/traject-variants` — CRUD trajecten/varianten
- `/api/lead-sources` — placeholder
- `/api/teamleader-test-connection` — TL-status
- `/api/teamleader-email-templates?type=quotation` — email-template picker
- `/api/teamleader-send-quotation` — verstuur
- `/api/teamleader-delete-quotation` — verwijder (lokaal + TL)
- `/api/onboarding-trajecten-list` + `/api/onboarding-create` — F0.2 onboarding-aanmelden
- `/api/app-settings?key=sales_min_term_amount|sales_max_start_days` — wizard-limits
- `/api/customer` — legacy customer-fetch (wizard-prefill)

## Cross-referenties (deep-links)

- `/modules/sales.html?tab=<key>` — direct naar tab
- `/modules/sales.html?tab=aanbod&sub=trajecten|producten` — direct naar sub-tab
- `/modules/sales-wizard.html` — nieuwe wizard
- `/modules/sales-wizard.html?customer_id=<uuid>` — bestaande klant prefill
- `/modules/sales-wizard.html?edit_deal_id=<uuid>` — bestaande offerte bewerken
- `/modules/subscription-wizard.html?mode=standalone` — nieuw abo zonder offerte
- `/modules/subscription-wizard.html?mode=standalone&customer_id=<uuid>&customer_name=<str>` — standalone + prefill
- `/modules/subscription-wizard.html?deal_id=<uuid>` — omzetten offerte → abo
- `/modules/offerte-detail.html?id=<deal_id>` — offerte-detail
- `/modules/klanten.html?id=<uuid>` — klant-detail
- `/modules/klanten.html?id=<uuid>&tab=abonnementen` — klant-detail met sub-tab
- `/modules/admin-historical-events.html?deal_id=<uuid>` — historisch event koppelen (super_admin)
- Externe TL-URLs:
  - `https://focus.teamleader.eu/quotations/<tl_id>`
  - `https://focus.teamleader.eu/company.php?id=<id>` (B2B)
  - `https://focus.teamleader.eu/contact.php?id=<id>` (B2C)
  - `https://focus.teamleader.eu/products/<id>`
  - `https://focus.teamleader.eu/subscriptions/<tl_id>`

<!-- END sales-cluster.md -->

---

## 2. Klanten

**Bron**: `modules/klanten.html` (5153 rgs).

<!-- BEGIN klanten.md -->

# Inventaris — modules/klanten.html

Bestand: `modules/klanten.html` (5153 regels). Bestaat uit **twee routes**:
- **Lijst-view** (`#view-list`) — HTML aanwezig, maar bij `init()` (r1125)
  wordt de gebruiker direct doorgestuurd naar `sales.html?tab=klanten`
  zonder id-param. Alle lijst-code (KPI-bar, filters, tabel, bulk-selectie,
  create-modal-invocation) is dus **dead code in productie** maar wél
  bereikbaar via directe fetch — moet toch geïnventariseerd worden voor
  redesign-parity.
- **Detail-view** (`#view-detail`, ?id=uuid) — hoofdroute in productie.
  7 sub-tabs: Profiel · Communicatie · Offertes · Abonnementen ·
  Facturen · Wanbetalers · Audit (**NB: 7 tabs, niet de 6 uit de prompt** —
  de user noemde "Finance / Deals / Onboarding / Notes"; live zijn dat
  Facturen + Abonnementen (deel Finance), Offertes (deel Deals),
  Wanbetalers (extra), Audit (extra). Onboarding zit als card in Profiel,
  Notes zit als sectie in Communicatie.)

Iconen: Tabler-icons (`ti ti-*`). Styling: `agent-shared.css` +
`sales-redesign.css` + veel inline CSS. Modals: `.modal-overlay.hidden`
pattern via `openModal`/`closeModal` helpers.

Auth: `customer.module.access` verplicht (r1112). Overige checks via
`window.RBAC.can()`.

Deep-link syntax:
- `?id=<uuid>` — laadt detail-view.
- `?id=<uuid>&tab=<naam>` — activeert specifieke sub-tab. Whitelist =
  `profiel|communicatie|offertes|abonnementen|facturen|wanbetalers|audit`.
- Zonder `?id=` → redirect naar `sales.html?tab=klanten`.

---

## Klanten > Lijst-view > Page header

- [ ] r483 — "Selecteren" — button `#btn-selection-toggle`,
  `onclick="toggleSelectionMode()"` (r3625). Toggelt bulk-select mode
  (aria-pressed). Label wisselt naar "Klaar" wanneer actief.
  - zichtbaarheid: publiek in lijst-view (lijst-view zelf is dead code
    in productie route)
- [ ] r486 — "Nieuwe klant" — button `#btn-new-customer`, click-handler
  gebonden in `initListView` r3274 → `openCustomerModal('create', {})`.
  - modal/dialog: `#customerFormModal`

## Klanten > Lijst-view > Bulk-result banner

- [ ] r492 — `#bulk-result-banner` — read-only status-banner na bulk-actie.
  Rendered door `renderBulkResultBanner` (r3889). Toont
  `{success_count}/{total} {actie-label} geslaagd` + optionele
  `{N} mislukt: {reden}` breakdown.

## Klanten > Lijst-view > KPI-strip

Non-interactief; 4 tiles.

- r495 — `#kpi-grid`
  - `#kpi-active` (r498) "Actieve klanten"
  - `#kpi-new` (r502) "Nieuw deze maand"
  - `#kpi-risico` (r506) "Risico"
  - r508 "Wanbetalers" — placeholder `.kpi-placeholder`, sub-text
    "Komt later (Finance)"

## Klanten > Lijst-view > Filters-bar

- [ ] r517 — Zoekveld `#filter-search` — placeholder "🔍 Zoek op naam,
  email of telefoon…". Debounced input-listener (r3497, 300ms) →
  `state.search`, `loadCustomers()`.
- [ ] r521 — Tag-filter trigger `#filter-tags-trigger` — opent
  `.tag-multi-pop` popover. Click-handler r3507. Label
  `#filter-tags-label` toont "Tags (N)" bij selectie.
- [ ] r525 — Tag-multi-select popover `#filter-tags-pop` — checkboxen
  per tag (dynamisch, gerenderd door `renderTagFilterOptions` r3298).
  Verwijst naar `/api/customer-tag-definitions`.
  - close-behavior: click-outside (r3511) + Escape (r4570).
- [ ] r531 — Status-pills `#filter-status` — 3 checkboxes:
  - r532 "Actief" (checked default) — value=`active`
  - r535 "Gearchiveerd" — value=`archived`
  - r538 "Geanonimiseerd" — value=`anonymized`
  - Change-listener r3518; lege selectie geblokt (min. 1 actief).
- [ ] r541 — `.status-hint` "#status-hint" — hint-tekst "Verbergt
  gearchiveerd & geanonimiseerd", verborgen zodra archived/anonymized
  aan staat.
- [ ] r545 — Datum-from `#filter-from` (`type="date"`) — title
  "Klant sinds vanaf" → `state.createdFrom`.
- [ ] r547 — Datum-to `#filter-to` (`type="date"`) — title
  "Klant sinds tot" → `state.createdTo`.
- [ ] r549 — Sales-filter `#filter-sales` `<select>` — **disabled**
  placeholder. Optie: "Sales · Binnenkort".
  - zichtbaarheid: hidden default (disabled)
- [ ] r554 — "Reset filters" — button `#btn-reset-filters` →
  `resetFilters()` (r3543).

## Klanten > Lijst-view > Bulk-action-bar

Zichtbaar wanneer `selectedIds.size > 0` (CSS class `.visible`).

- r560 — `#bulk-action-bar` container
- [ ] r561 — Count-label `#bulk-count` — dynamisch "N geselecteerd".
- [ ] r563 — "Archiveren" — button `.btn-bulk-archive`,
  `onclick="openBulkArchiveModal()"` (r3760).
  - modal/dialog: `#bulkArchiveModal`
- [ ] r566 — "Tag-actie" — button `.btn-bulk-tag`,
  `onclick="openBulkTagModal()"` (r3810).
  - modal/dialog: `#bulkTagModal`
- [ ] r569 — "Annuleren" — button, `onclick="toggleSelectionMode()"`.

## Klanten > Lijst-view > Klantenlijst-tabel

Table `#customers-table` met tbody `#customers-tbody`. Data via
`/api/customers?...` (r3370).

**KOLOMMEN** (r578-588, th-elements):
- r579 col-select — checkbox `#select-all-checkbox`,
  `onchange="toggleSelectAll()"` (r3666). Kolom-header alleen zichtbaar in
  selection-mode (`.selection-mode` class op tabel).
- r580 "Naam" — `data-sort-key="last_name"`, klik → sort toggle
  (r3573).
- r581 "Email" — sortable=nee.
- r582 "Telefoon" — sortable=nee.
- r583 "Tags" — sortable=nee.
- r584 "Klant sinds" — `data-sort-key="created_at"`, default
  `aria-sort="descending"`.
- r585 "Status" — sortable=nee.
- r586 "Laatste contact" — sortable=nee.
- r587 acties-kolom (kebab-menu, geen header-label).

Per-row rendering `renderCustomers` r3397:
- [ ] r3420 — row click-handler — in selection-mode toggelt de rij,
  anders navigate naar `?id=<uuid>` (detail-view).
- [ ] r3437 — row-checkbox `input[data-row-select="<uuid>"]` — bind
  change-listener → `toggleRowSelection(id)` (r3652).
- [ ] r3462 — Kebab-menu per row (`koCustKebab`) — SVG-icoon `.sr-ibtn`
  toggelt `.sr-menu-pop` dropdown. Items:
  - "Bekijk klant" (r3469) — link naar `/modules/klanten.html?id=<uuid>`
  - "Open in Teamleader" (r3467) — link naar `focus.teamleader.eu`
    (voorwaardelijk; alleen als `tl_company_id` (bedrijf) of
    `tl_contact_id` (persoon) aanwezig).

## Klanten > Lijst-view > Empty-state

- [ ] r3407 — "Filters resetten" — inline empty-state button,
  `onclick="resetFilters()"`.

## Klanten > Lijst-view > Error-state

- [ ] r3477 — "Opnieuw proberen" — inline error-state button,
  `onclick="loadCustomers()"`.

## Klanten > Lijst-view > Pagination

- r597 `.pagination` container
- [ ] r598 — Page-info `#page-info` (read-only "N–M van T").
- [ ] r600 — Page-size `#page-size` `<select>` — opties: 20, 50
  (default), 100, 500. Change → `state.pageSize` (r3603).
- [ ] r607 — "‹ Vorige" button `#btn-prev` — r3593.
- [ ] r608 — Page-input `#page-input` (`type="number"`, min=1) —
  change → jump to page (r3599).
- [ ] r609 — "Volgende ›" button `#btn-next` — r3596.

---

## Klanten > Detail-view > Header

Container `#view-detail`, hoofdcontent `#detail-content`.

- [ ] r624 — Back-link "Terug naar klant-overzicht" — `<a
  href="/modules/sales.html?tab=klanten">`.
- [ ] r630 — Avatar `#detail-avatar` (`.sr-avatar lg`) — bedrijf →
  building-icoon; particulier → 2-letter initialen (kleur uit
  naam-hash). Non-interactief.
- [ ] r632 — Naam `#detail-name` — non-interactief titel.
- [ ] r633 — Status-badge `#detail-status` — dynamisch class
  `active|archived|anonymized` + label via `labelForStatus` (r3457):
  "Actief" / "Gearchiveerd" / "Geanonimiseerd". Non-interactief.
- [ ] r634 — Risk-tag container `#detail-risk` — rendert
  `<span class="sr-tag blue|gray">Bedrijf|Particulier</span>` + optioneel
  `<span class="sr-tag danger">Risico</span>` bij `c.risk_tag_auto`.
- [ ] r635 — Meta-strip `#detail-meta` — inline mail/tel/kvk/vat + "Klant
  sinds" info. Bevat `mailto:` en `tel:` hyperlinks in geëscapete vorm
  (r1215-1216).
- [ ] r639 — "Bewerken" — button `#btn-edit-customer`,
  bind-handler r3258 → `openCustomerModal('edit', detailState.customer)`.
  - zichtbaarheid: disabled bij status ≠ 'active' (r1231).
  - modal/dialog: `#customerFormModal`
- [ ] r642 — "Archiveren" — button `#btn-archive-customer`,
  bind-handler r3259 → `openArchiveModal()`.
  - zichtbaarheid: alleen bij status='active' (r1232).
  - modal/dialog: `#archiveModal`
- [ ] r645 — "Heractiveren" — button `#btn-unarchive-customer`
  (`.btn-unarchive`, groen), bind r3260 → `unarchiveCustomer()`
  (r4463). Directe POST naar
  `/api/customer-archive?...&action=unarchive`.
  - zichtbaarheid: alleen bij status='archived' (r1233).

## Klanten > Detail-view > Tab-strip

7 tabs (r651-672). Elke tab is `<button class="tab-btn"
data-tab="<name>">`, bind-handler r3242 → `activateDetailTab(tab, true)`
(r1243) die URL update via `history.pushState(?id=X&tab=Y)`.

- [ ] r652 — "Profiel" — `#tab-btn-profiel`, `data-tab="profiel"`
- [ ] r655 — "Communicatie" — `#tab-btn-communicatie`, count-badge
  `#tab-count-communicatie` (uit `notes_count`).
- [ ] r658 — "Offertes" — `#tab-btn-offertes`, count-badge
  `#tab-count-offertes`.
- [ ] r661 — "Abonnementen" — `#tab-btn-abonnementen`.
- [ ] r664 — "Facturen" — `#tab-btn-facturen`.
- [ ] r667 — "Wanbetalers" — `#tab-btn-wanbetalers`.
- [ ] r670 — "Audit" — `#tab-btn-audit`, count-badge `#tab-count-audit`.

Deep-link: `?tab=profiel|communicatie|offertes|abonnementen|facturen|wanbetalers|audit`.

## Klanten > Detail-view > Popstate

- [ ] r3247 — Browser back/forward — rerender bij URL-change (popstate).

---

## Klanten > Profiel-tab > Sidebar (linker kolom)

Container `#tab-panel-profiel` (r676). Layout: `.dash-grid` met
sidebar + main-content.

### Sidebar-card 1 (avatar-samenvatting)
- r681 — Avatar `#prof-avatar` — 64px, dynamisch via
  `applyCustomerAvatar` (r1091).
- r682 — Naam `#prof-sidebar-name` — H2 tag.
- r683 — Badges `#prof-sidebar-badges` — dynamische badge-strip:
  Bedrijf|Particulier + Actief|Status + optioneel "Risico".
- r684 — "Klant sinds …" `#prof-sidebar-since`.

### Sidebar-card 2 (Contact-links)
- [ ] r688 — Email-link `#prof-link-email` — `<a>` met dynamische
  `href="mailto:..."` en visible span, verborgen als geen email.
- [ ] r689 — Telefoon-link `#prof-link-phone` — `<a href="tel:...">`,
  verborgen als geen phone.
- [ ] r690 — Softphone-knop `#prof-klx-call-btn` — "Bel via softphone".
  Button (niet link). Bind-handler r5139 (delegated click) →
  `_klxOpenSheet({phone, name})`. Opent rich-sheet-belvenster.
  - zichtbaarheid: alleen als `c.phone` aanwezig (r2547).
  - opent: `#klxSoftphoneSheet` (dynamisch gegenereerd, r4969)
- [ ] r693 — WhatsApp-link `#prof-link-wa` — `<a>` met dynamische
  `href="https://wa.me/<digits>"`, `target="_blank"`.

### Sidebar-card 3 (Tags)
- [ ] r697 — "Bewerken" toggle `#prof-tags-edit-toggle`
  (`.tag-edit-toggle`), `onclick="toggleTagEditMode()"` (r4019). Label
  wisselt met check-icon "Klaar" in edit-mode.
  - zichtbaarheid: alleen als `c.status === 'active'` (r2592).
- [ ] r699 — Tags-lijst `#prof-tags` — read-mode: kleurige badges;
  edit-mode: badges met X-knopjes + "+ Tag toevoegen" popover.
  Rendering `renderTagsSection` r3951.
  - In edit-mode dynamisch:
    - [ ] `.tag-x` per tag (r3984) → `removeTag(slug)` (r4056), DELETE
      `/api/customer-tag`.
    - [ ] "+ Tag toevoegen" `.tag-add-button` (r3989),
      `onclick="toggleTagAddPopover(event)"`.
    - [ ] Per tag in popover `.tag-add-option` (r3994) → `addTag(slug)`
      (r4034), POST `/api/customer-tag`.
- [ ] r700 — Tag-error slot `#prof-tags-error`.

## Klanten > Profiel-tab > Main content

### Klantgegevens-card (r705)
- [ ] r706 — "Bewerken" — button `#prof-edit-btn` (`.sr-abtn`),
  `onclick="document.getElementById('btn-edit-customer').click()"`.
  Alias voor header-Bewerken-knop.

Read-only property-rows (allemaal non-interactief textContent):
- r708 Voornaam `#prof-first-name`
- r709 Achternaam `#prof-last-name`
- r710 Geboortedatum `#prof-dob`
- r711 Bedrijfsnaam `#prof-company-name` — row `#prof-row-company`, alleen zichtbaar bij `is_company=true`.
- r712 KvK-nummer `#prof-kvk` — row `#prof-row-kvk` idem.
- r713 BTW-nummer `#prof-vat` — row `#prof-row-vat` idem.
- r716 Email `#prof-email` — bevat `<a href="mailto:...">`.
- r717 Telefoon `#prof-phone` — bevat `<a href="tel:...">`.
- r720 Bedrijf-koppeling row `#prof-row-linked-company` — cell
  `#prof-linked-company`. Zichtbaar op **persoon-detail** (`is_company=false`).
  Zie sectie "Bedrijf-koppeling" hieronder.
- r726 Straat+nr `#prof-address-line1`.
- r727 Postcode+plaats `#prof-address-line2`.

### Bedrijf-koppeling (Fase v1 lokaal; sinds migratie 2026-07-18)
Rendering `renderLinkedCompanyRow` r2689 (persoon-view) en
`renderLinkedPersonsCard` r2715 (bedrijf-view).

Wanneer persoon **niet gekoppeld**:
- [ ] "Koppel aan bedrijf" — button (r2710),
  `onclick="openLinkCompanyModal()"` (r2747).
  - modal/dialog: `#linkCompanyModal`

Wanneer persoon **wel gekoppeld**:
- [ ] Bedrijf-link — `<a href="/modules/klanten.html?id=<company-id>">`
  (r2703). Deep-link naar bedrijf-detail.
- [ ] "Ontkoppelen" — button (r2705),
  `onclick="unlinkCompanyFromPerson()"` (r2851). POST
  `/api/customer-link-company` met `company_customer_id=null`. Bevat
  confirm-dialog.

### Onboarding-card (r730)
- Container `#prof-onboarding-card` — geheel non-interactief samenvatting.
  Rendering `renderOnboardingCard` r2647.
  - Status 'completed' → "Afgerond ✓ <datum>"
  - Status 'sent' → "Verzonden ✓ <datum>"
  - Status 'not_sent' + getekende offerte → tekst "Aanmelden via de offerte."
  - Anders → "Wordt zichtbaar na offerte-ondertekening."

### Abonnement-samenvatting-card (r731)
- [ ] Kaart `#prof-abo-card` — geheel klikbaar (`cursor:pointer`),
  `onclick="activateDetailTab('abonnementen', true)"` — deep-jump naar
  Abonnementen-tab.
  - Slot `#prof-abo-status` — dynamische status-tag (Actief / Loopt af / Geen actief).
  - Slot `#prof-abo` — content-rijen (rendering `renderProfielAboCard` r2608).
- [ ] Bij "geen actief" (r2629): "Aanmaken" — button-link `.sr-abtn primary`,
  href adaptief naar `/modules/subscription-wizard.html?...`.
  - zichtbaarheid: alleen als `koCanCreateSub === true`
    (RBAC `sales.deal.create`).

### Bedrijf-detail — Gekoppelde personen-card
- Container `#prof-linked-persons-card` (r735) — alleen zichtbaar bij
  `is_company=true`. Header "Gekoppelde personen (N)".
- [ ] Per persoon: link — `<a
  href="/modules/klanten.html?id=<person-id>">` (r2738). Deep-link naar
  persoon-detail.

### Metadata-card (r741)
Read-only rijen (allemaal non-interactief):
- r744 Verkoper `#prof-verkoper`
- r745 Laatst bijgewerkt `#prof-updated-at`
- r746 Teamleader ID `#prof-tl-id`
- r747 AVG `#prof-privacy`
- r748 Klant sinds `#prof-created-at`
- r749 GoHighLevel `#prof-ghl-id`
- r750 Risico-tag `#prof-risk-auto`

---

## Klanten > Communicatie-tab > Notities-sectie

Container `#tab-panel-communicatie` (r758).

### Nieuwe notitie editor
- [ ] r764 — Textarea `#new-note-body` — placeholder "Nieuwe notitie
  toevoegen…", maxlength=10000.
- [ ] r767 — "Opslaan" — button `#new-note-submit`,
  `onclick="submitNewNote()"` (r4081). POST `/api/customer-notes`.
- r766 — Error-slot `#new-note-error`.
- Zichtbaarheid: verborgen bij status ≠ 'active' (r2904). Vervangen door
  info-tekst "Klant is gearchiveerd; eerst heractiveren..." /
  "geanonimiseerd; notitie-mutaties niet beschikbaar."

### Notities-lijst
Container `#notes-list`. Rendering `renderNotesList` r2929.

Per notitie (read-mode, alleen bij status='active' én non-archived):
- [ ] "Bewerken" — icon-button `.note-icon-btn`, `data-edit-note=<id>`,
  bind r2984 → `editNote(id)` (r4116) → inline edit-form.
- [ ] "Archiveren" — icon-button `.note-icon-btn`,
  `data-archive-note=<id>`, bind r2986 → `archiveNote(id)` (r4164).
  POST `/api/customer-note-archive?...&action=archive` met confirm.

Per notitie in edit-mode:
- [ ] Textarea `data-edit-note-body=<id>`.
- [ ] "Opslaan" — button `data-save-note=<id>`, bind r2988 →
  `saveNoteEdit(id)` (r4126). PATCH `/api/customer-notes?id=<id>`.
- [ ] "Annuleren" — button `data-cancel-note=<id>`, bind r2990 →
  `cancelNoteEdit(id)` (r4121).

## Klanten > Communicatie-tab > WhatsApp + Email placeholders

- r780 — Section "WhatsApp gesprekken" — placeholder "Beschikbaar in Fase
  2C (WhatsApp infrastructuur)". Non-interactief.
- r785 — Section "Email correspondentie" — placeholder "Beschikbaar in
  latere fase (post-MVP)". Non-interactief.

---

## Klanten > Offertes-tab

Container `#tab-panel-offertes` (r790). Data via
`/api/sales-quotations?customer_id=...` (r1343).

### KPI-strip (r1367-1372)
Non-interactief: Totaal offertes / Totaalwaarde / Conversie / Laatste offerte.

### Segment-filter pills (r1375)
Container `#koOffSegments`. Bind r1402.
- [ ] "Alle" — `data-seg="alle"`
- [ ] "Concept" — `data-seg="draft"`
- [ ] "Verzonden" — `data-seg="sent"`
- [ ] "Bevestigd" — `data-seg="accepted"` (matcht ook 'signed')
- [ ] "Afgewezen" — `data-seg="declined"`

### "Nieuwe offerte" (r1377)
- [ ] "Nieuwe offerte" — link `.sr-abtn primary` naar
  `/modules/sales-wizard.html?customer_id=<id>`.

### Offertes-tabel

**KOLOMMEN** (r1397):
- statusstrip (4px kleur-bar)
- "Nummer" — offerte-referentie + traject-label sub.
- "Entiteit" — tag (Online/Fysiek/Retentie).
- "Bedrag" — incl. BTW (right-align).
- "Status" — tag (Concept/Verzonden/Bevestigd/Afgewezen/Verlopen).
- "Datum" — `created_at`.
- "TL" — check-tag als tl_quotation_id.
- acties-kolom (koQuotActions, r1276).

Status-conditionele acties per rij (r1290-1297):
- [ ] Bij `accepted|signed` — "Omzetten naar abonnement" — link naar
  `/modules/subscription-wizard.html?deal_id=<id>`.
- [ ] Bij `sent` — "Opnieuw versturen" — button, `koSend(id)` (r1299).
  POST `/api/teamleader-send-quotation`.
- [ ] Bij `failed` — "Retry push" — button, `koPush(id)` (r1300). POST
  `/api/sales-deal-retry-push`.
- [ ] Bij `draft` + tl_id — "Versturen" — button, `koSend`.
- [ ] Bij `draft` zonder tl_id — "Push naar TL" — button, `koPush`.
- [ ] "Bekijk" (oog-icoon) — link naar
  `/modules/offerte-detail.html?id=<deal_id>`.
- [ ] "Open in Teamleader" (extern-icoon) — link naar
  `https://focus.teamleader.eu/quotations/<tl_id>` (target=_blank).

Kebab-menu per rij (`.sr-menu`):
- [ ] "Bewerken" — button, `koEdit(id, needConfirm)` (r1301) →
  navigate naar `/modules/sales-wizard.html?edit_deal_id=<id>`. Bevat
  confirm bij accepted/signed.
- [ ] "Verwijderen" — button `.danger`, `koDelete(id, status)` (r1302).
  POST `/api/teamleader-delete-quotation`. Multi-step confirm (2×
  bij normaal, 3× bij accepted/signed).
- [ ] "Status vernieuwen" — button, `renderOffertesTab()` (refresh).
- [ ] "Open in Teamleader" — link (dubbel met eye-strip).

---

## Klanten > Abonnementen-tab

Container `#tab-panel-abonnementen` (r798). Data via
`/api/sales-customer-subscriptions?customer_id=...` (r2188).

### KPI-strip (r2215)
Non-interactief: Actieve abo's / MRR / Lifetime value / Loopt t/m.

### Bypass-banner
- r2225 — Non-interactieve waarschuwing wanneer reserveringsfee (€100)
  is omzeild. Rendered per `bypass_events` uit response.

### Segment-filter pills (r2251)
Container `#koAboSegments`. Bind r2301.
- [ ] "Actief" — `data-seg="active"`
- [ ] "Gepauzeerd" — `data-seg="paused"`
- [ ] "Alle" — `data-seg="alle"`
- [ ] "Gedeactiveerd" — `data-seg="cancelled"`

### Header-acties
- [ ] "Stel alle abo's uit (N)" — button `#postpone-all-btn`
  (`.sr-abtn warning`), bind r2306 →
  `openPostponeAllModal(customerId, count)` (r2354). Bulk-uitstel-modal.
  - zichtbaarheid: alleen als `active.length > 1` (r2236).
- [ ] "Nieuw abonnement" — link `.sr-abtn primary` (r2247), href
  adaptief:
  - Met `pending_deal_id` → `/modules/subscription-wizard.html?deal_id=<id>`
  - Anders (standalone) →
    `/modules/subscription-wizard.html?mode=standalone&customer_id=<id>&customer_name=<n>`
  - zichtbaarheid: alleen als `koCanCreateSub === true` (RBAC
    `sales.deal.create`).

### Abonnementen-tabel

**KOLOMMEN** (r2295):
- statusstrip
- caret-expand (bij multi-line abo's)
- "Omschrijving"
- "Bedrag" per termijn (incl.)
- "Termijnen" (center)
- "Periode" — start_date → end_date
- "TL" (center) — check-tag
- "Status" — tag (active/paused/cancelled)
- acties-kolom

Per-rij acties (r2262):
- [ ] Caret `data-sub-toggle=<i>` — bind r2302, klapt detail-rij
  (regels + BTW-breakdown) open/dicht.

Status ≠ cancelled:
- [ ] "Aanpassen" — button `data-sub-edit=<sub_id>`, bind r2305 →
  `openSubscriptionEditModal(subId)` (r2395). Overlay-modal
  `#sub-edit-overlay` dynamisch.
  - disabled bij `has_any_invoice=true` (r2277) — tooltip
    "Al gefactureerd — wijzig via crediteren + nieuw abonnement".
- [ ] "Uitstellen" — button `.sr-abtn warning` `data-sub-postpone=<id>`,
  `data-sub-running`, bind r2303 → `openPostponeModal(subId, running)`
  (r2311). Overlay-modal `#postpone-overlay` dynamisch.

Kebab-menu (`.sr-menu`) per rij, alleen bij ≠ cancelled:
- [ ] "Status vernieuwen" — `onclick="renderAbonnementenTab()"`.
- [ ] "Open in Teamleader" — link (voorwaardelijk).
- [ ] "Deactiveren" — button `.danger` `data-sub-delete=<id>`,
  bind r2304 → `deleteSubscription(subId)` (r2512). POST
  `/api/sales-subscription-delete`, met confirm en fallback (alleen
  lokaal deactiveren als TL faalt).

### Abonnement-edit-overlay (dynamisch, r2409)
Fields:
- `#se-description` — text input
- `#se-amount` — number (disabled bij TL-koppeling)
- `#se-vat` — number (disabled bij TL-koppeling)
- `#se-terms` — number (disabled bij TL-koppeling)
- `#se-start` — date
- `#se-end` — date
- Error-slot `#se-err`
- [ ] "Annuleren" — button `#se-cancel`.
- [ ] "Bevestig wijzigingen…" — button `#se-save`, bind r2441. Extra
  `window.confirm` met diff-samenvatting. PATCH
  `/api/sales-subscription-update`.

### Uitstel-overlay (dynamisch, r2311 / r2354)
- Number `#postpone-months` (min=1 max=12)
- Error-slot `#postpone-err`
- [ ] "Annuleren" — button `#postpone-cancel`.
- [ ] "Uitstellen"|"Verlengen"|"Alle uitstellen" — button
  `#postpone-ok`. POST `/api/sales-subscription-postpone` (single) of
  `/api/sales-customer-postpone-all` (bulk).

---

## Klanten > Facturen-tab

Container `#tab-panel-facturen` (r806), wrap `#facturen-wrap`. Data via
`/api/finance-invoices?page_size=200&customer_id=...` (r1444).

### Header
- [ ] "Nieuwe factuur" — button `#koNewInvBtn` (r1454, r1495),
  `onclick` bind r1461/1507 → `openKoNewInvoiceModal()` (r1524).
  - zichtbaarheid: alleen als RBAC `finance.invoice.create` (r1452).
  - modal/dialog: `#koNewInv` (lazy gecreëerd, r1716)

### Facturen-tabel

**KOLOMMEN** (r1500):
- 4px statusstrip
- "Factuurnr"
- "Totaal" (right)
- "Gecrediteerd" (right)
- "Open" (right)
- "Vervaldag"
- "Status" — tag (Concept/Open/Deels betaald/Betaald/Te laat/
  Gecrediteerd/Deels gecrediteerd/Afgeschreven)
- acties-kolom (kebab-menu, r1482)

Row-click (r1514):
- [ ] Klik op rij (behalve op .sr-menu/button/a) opent factuur-detail
  modal (`koOpenInvoice`, r1771).

Kebab-menu per rij (r1482):
- [ ] "Bekijk details" — button `data-ko-inv=<i>`, bind r1509 →
  `koOpenInvoice(inv)`.
- [ ] "Betaling registreren" — button `data-ko-pay=<i>` (voorwaardelijk:
  RBAC finance.invoice.payment.register + tl_id + status
  open|partially_paid|overdue), bind r1510 → `koPayModal(inv)` (r1959).
  - modal/dialog: `#koPay`
- [ ] "Betaling terugdraaien" — button `.danger` `data-ko-remove=<i>`
  (voorwaardelijk: RBAC finance.invoice.payment.remove +
  amount_paid > 0), bind r1511 → `koRemovePayment(inv)` (r1986). POST
  `/api/finance-invoice-remove-payment` met confirm.
- [ ] "Open PDF" — button `onclick="koInvoicePdf('<tl_id>')"` (r1481,
  r1428). GET `/api/finance-invoice-pdf?tl_invoice_id=...`.
- [ ] "Open in Teamleader" — link `focus.teamleader.eu/invoice_detail.php?id=<tl_id>`.

Empty-state (r1456):
- Tekst "Nog geen facturen gespiegeld voor deze klant."
- [ ] "Open in Teamleader" — extern-link naar
  `focus.teamleader.eu/invoices`.
- [ ] "+ Nieuwe factuur" — button (zelfde als header-versie).

## Klanten > Facturen-tab > Factuur-detail-modal (#koInvModal)

Dynamisch (r1637). Toont card met info-KV + acties + regels +
betalingen + activiteit.

Acties-strip (r1803):
- [ ] "Markeer betaald" — button `#koMarkPaid` (voorwaardelijk `payable`)
  → opent `#koPay` (`koPayModal`).
- [ ] "Verzenden" — button `#koBtnSend` (`sendEnabled`) →
  `openKoSendModal(inv)` (r2049). Anders disabled-placeholder met
  "geen rechten".
  - modal/dialog: `#koSend`
- [ ] "Aanpassen" — button `#koBtnUpdate` (`updateEnabled`) →
  `openKoUpdateModal(inv)` (r2133). Anders disabled met "geen rechten"
  of "geboekt".
  - modal/dialog: `#koUpd`
- [ ] "Incasso" — disabled placeholder, note "via TL". Non-interactief.
- [ ] "Creditnota" — button `#koBtnCredit` (`creditEnabled`) →
  `openKoCreditModal(inv)` (r2108). Anders disabled met "geen rechten"
  of "geboekt vereist".
  - modal/dialog: `#koCred`
- [ ] "PDF" — button (voorwaardelijk tl_id),
  `onclick="koInvoicePdf('<tl_id>')"`.
- [ ] "Teamleader" — link naar `focus.teamleader.eu/invoice_detail.php?id=<tl_id>`.

Betaal-link sectie (r1813, zichtbaar bij open/partially_paid/overdue +
tl_id):
- r1820 — Read-only input `#koInvPayLinkInput` — TL payment-URL.
- [ ] "Ververs betaal-link" — button `#invoicePaymentLinkRefreshBtn`,
  `data-invoice-id`, bind r1839 → `refreshInvoicePaymentLink()`
  (r1902). POST `/api/finance-invoice-payment-link` (Shift+klik =
  force=true).
- [ ] "Kopiëren" — button `#koInvPayLinkCopyBtn` — `navigator.clipboard`
  (r1930), initieel disabled.
- [ ] "Openen" — link `#koInvPayLinkOpenBtn`, target=_blank, initieel
  `display:none`.
- Badge `#koInvPayLinkBadge` — "Cache hit (Nd oud)" of "Vers opgehaald".

Betalingen-kaart (r1846):
- [ ] "terugdraaien" — inline link `#koRemoveLink` (voorwaardelijk),
  bind r1851 → `koRemovePayment(inv)`.

## Klanten > Facturen-tab > Betaal-modal (#koPay, r1647)

- Sub-tekst `#koPaySub` (readonly).
- [ ] `#koPayAmount` (number, default openstaand bedrag).
- [ ] `#koPayDate` (date, default vandaag).
- Error-slot `#koPayErr`.
- [ ] "Annuleren" — button (inline onclick).
- [ ] "Registreren" — button `#koPayOk`, bind r1967 → `koPaySubmit()`
  (r1970). POST `/api/finance-invoice-register-payment`.

## Klanten > Facturen-tab > Verzenden-modal (#koSend, r1659)

- Sub-tekst `#koSendSub`.
- [ ] `#koSendTpl` — `<select>` mail-template (TL-templates via
  `/api/finance-mail-templates`).
- [ ] `#koSendTo` — readonly email input (klant-email uit TL).
- Preview `#koSendPreview` (voorwaardelijk) met `#koSendPreviewSubject`
  en `#koSendPreviewBody`. Rendered door `_renderKoSendPreview` r2031.
- [ ] "Geavanceerd ▾" — toggle-link `#koSendAdvToggle`, bind r1751.
- [ ] `#koSendSubject` — text input (subject override, in advanced-section).
- [ ] `#koSendContent` — textarea (body override).
- Error-slot `#koSendErr`.
- [ ] "Annuleren" — button (inline onclick).
- [ ] "Verzenden" — button `#koSendOk`, bind r1747 → `submitKoSend()`
  (r2081). POST `/api/finance-invoice-send`. Enabled na valid template
  + email.

## Klanten > Facturen-tab > Credit-modal (#koCred, r1689)

- Sub-tekst `#koCredSub`.
- Info-banner (waarschuwing over Combidesk/e-boekhouden sync).
- [ ] `#koCredDesc` — optionele text-input omschrijving.
- Error-slot `#koCredErr`.
- [ ] "Annuleren" — button (inline onclick).
- [ ] "Crediteren" — button `#koCredOk` (rood), bind r1748 →
  `submitKoCredit()` (r2118). POST `/api/finance-invoice-credit`.

## Klanten > Facturen-tab > Update-modal (#koUpd, r1703)

- Sub-tekst `#koUpdSub`.
- Regels-editor `#koUpdLines`, rendering `renderKoUpdLines` r2149.
  Per regel:
  - `data-kupd-d<i>` — omschrijving input.
  - `data-kupd-q<i>` — aantal input.
  - `data-kupd-p<i>` — prijs input.
  - `data-kupd-v<i>` — BTW select (0/6/9/21%).
  - `data-kupd-x<i>` — X-knop → verwijder regel.
- [ ] "Regel toevoegen" — button `#koUpdAdd`, bind r1750.
- Error-slot `#koUpdErr`.
- [ ] "Annuleren" — button (inline onclick).
- [ ] "Opslaan" — button `#koUpdOk`, bind r1749 → `submitKoUpdate()`
  (r2167). POST `/api/finance-invoice-update`.

## Klanten > Facturen-tab > Nieuwe-factuur-modal (#koNewInv, r1716)

- Klant read-only label `#koNewInvCustLabel`.
- [ ] `#koNewInvDept` — `<select>` entiteit (Online/Fysiek/Retentie).
- Regels-editor `#koNewInvLines`, rendering `renderKoNewLines` r1541.
  Per regel (data-attrs zoals `data-konew-d/q/pr/v/x<i>`).
- [ ] "Regel toevoegen" — button `#koNewInvAddLine`, bind r1767.
- [ ] `#koNewInvPO` — text input Referentie/PO.
- [ ] `#koNewInvLang` — `<select>` taal (nl/en/fr).
- Error-slot `#koNewInvErr`.
- [ ] "Annuleren" — button `#koNewInvCancel`, bind r1762.
- [ ] "Opslaan als concept" — button `#koNewInvDraft`, bind r1764 →
  `submitKoNew('draft')`.
- [ ] "Boeken" — button `#koNewInvBook`, bind r1765 → `submitKoNew('book')`.
  Bevat window.confirm.
- [ ] "Boeken & Verzenden" — button `#koNewInvBookSend` (groen), bind
  r1766 → `submitKoNew('book', {autoOpenSend: true})`. Opent
  `#koSend`-modal na succesvol boeken.

---

## Klanten > Wanbetalers-tab

Container `#tab-panel-wanbetalers` (r813). Data via
`/api/wanbetalers-timeline?customer_id=...` (r3049).

### Notitie-form
- [ ] r821 — Textarea `#wb-note-input` — placeholder "Notitie toevoegen…"
- [ ] r823 — "Ververs" — button `#wb-note-refresh`, bind r3044 → reset
  cache + `renderWanbetalersTab()`.
- [ ] r826 — "Notitie plaatsen" — button `#wb-note-save`, bind r3043 →
  `submitWanbetalersNote()` (r3117). POST `/api/customer-notes`.

### Tijdlijn-lijst
Container `#wb-timeline-list`, rendering `renderWanbetalersEntry` r3094.
Non-interactieve items (icon + titel + timestamp + description + optional
"dry-run" badge). Zelfde bron als finance.html #caseSheet-tijdlijn.

- [ ] "Toon meer (N)" / "Inklappen" — button `#wb-tl-more-btn`
  (r3078-3081), bind r3086. Toggelt `detailState.wanbetalersShowAll`.

---

## Klanten > Audit-tab

Container `#tab-panel-audit` (r838). Data via
`/api/customer-audit?customer_id=...` (r2999).

Container `#audit-list`, rendering `renderAuditEntry` r3155.
Non-interactieve entries: actie-badge (Aangemaakt/Bewerkt/Gearchiveerd/
Heractiveerd/Geanonimiseerd) + actor + timestamp + reden + diff-list.

- [ ] "Volledige JSON tonen"/"Volledige JSON verbergen" — toggle-button
  `.audit-raw-toggle` per entry, `data-target="audit-raw-<id>"`, bind
  r3019. Klapt raw before/after JSON open.

---

## Klanten > Modals (globaal)

### `#customerFormModal` (r857) — Create/Edit klant

Titel `#customerFormTitle` wisselt tussen "Nieuwe klant" en "Klant
bewerken" via `openCustomerModal(mode, prefill)` (r4242). Form-mode
via `form.dataset.mode`.

Form-fields (in vaste volgorde):
- [ ] `#cf-is-company` — checkbox "Dit is een bedrijf (B2B)",
  `onchange="onCustTypeChange()"` (r4210). Toont/verbergt
  `.cf-company-only` velden.
- [ ] `#cf-company-name` — text, maxlength=200. VERPLICHT bij B2B.
  Errslot `#cf-err-company_name`.
- [ ] `#cf-kvk` — text, maxlength=20. Optioneel (B2B only).
- [ ] `#cf-vat` — text, maxlength=40. Optioneel (B2B only).
- [ ] `#cf-first-name` — text, maxlength=100. VERPLICHT bij particulier.
- [ ] `#cf-last-name` — text, maxlength=100. VERPLICHT bij particulier.
- [ ] `#cf-email` — email, maxlength=200.
- [ ] `#cf-phone` — tel, maxlength=40.
- [ ] `#cf-dob` — date (geboortedatum).
- [ ] `#cf-street` — text, maxlength=200.
- [ ] `#cf-number` — text, maxlength=20.
- [ ] `#cf-postal` — text, maxlength=20.
- [ ] `#cf-city` — text, maxlength=100.
- [ ] `#cf-tl` — text, maxlength=100 (TradersLeague/TL-ID).
- [ ] `#cf-ghl` — text, maxlength=100 (GHL-ID).
- [ ] `#cf-privacy` — checkbox "Klant is geïnformeerd over de
  privacyverklaring". Deep-link naar `/privacy` in label.
  - VERPLICHT bij create; bij edit disabled als reeds geaccepteerd.

Elk field heeft `.field-error` slot `#cf-err-<field>`.

Modal-banner `#customerFormBanner` — server-error-melding.

Modal-footer:
- [ ] "Annuleren" — button, `onclick="closeCustomerModal()"`.
- [ ] "Opslaan" — button `#customerFormSubmit`,
  `onclick="submitCustomerForm()"` (r4277). POST `/api/customer` (create)
  of PATCH `/api/customer?id=...` (edit).
  - Bij create + email/phone: pre-flight duplicate-check
    (`fetchDuplicateMatches` r4495) → opent `#duplicateConfirmModal`.

Close-triggers:
- Escape (r4568), overlay-click (r4578), sluitknop r861 (`.modal-close`).

### `#archiveModal` (r901)

- r909 — Bevestigings-tekst met klant-naam `#archive-customer-name`.
- [ ] `#archive-reason` — textarea, maxlength=500 (optioneel).
- Modal-banner `#archiveBanner`.
- [ ] "Annuleren" — button, `onclick="closeArchiveModal()"`.
- [ ] "Archiveren" — button `#archiveConfirmBtn`,
  `onclick="submitArchive()"` (r4435). POST
  `/api/customer-archive?...&action=archive`.

### `#duplicateConfirmModal` (r924) — Stackt bovenop `#customerFormModal`

- r931 — Match-count `#duplicate-match-count`.
- r933 — Match-lijst `#duplicate-match-list`, per match:
  - [ ] Link-item — `<a href="/modules/klanten.html?id=<match_id>"
    target="_blank">` — opent match in nieuw tab.
  - Reason-tag (email/phone/both).
- [ ] "Annuleren" — button, `onclick="closeDuplicateModal()"`.
- [ ] "Toch aanmaken" — button `#duplicateConfirmBtn`,
  `onclick="confirmDuplicateAndProceed()"` (r4540). Re-triggert
  submitCustomerForm met `_skipDuplicateCheck=true`.

### `#bulkArchiveModal` (r945)

- r953 — Count `#bulk-archive-count`.
- [ ] `#bulk-archive-reason` — textarea, maxlength=500.
- Modal-banner `#bulkArchiveBanner`.
- [ ] "Annuleren" — button, `onclick="closeBulkArchiveModal()"`.
- [ ] "Archiveren" — button `#bulkArchiveConfirmBtn`,
  `onclick="submitBulkArchive()"` (r3775). POST `/api/customer-bulk`
  action=archive.

### `#linkCompanyModal` (r970) — Persoon aan bedrijf koppelen

- r979 — Persoon-naam `#link-company-person-name`.
- [ ] `#link-company-search` — search input. Global input-listener r2769
  debounced 220ms → `_searchCompaniesForLink(q)` (r2782). GET
  `/api/customers?search=X&is_company=true&limit=20`.
- r986 — Resultaten `#link-company-results`. Per bedrijf-hit:
  - [ ] Button `data-link-company-id=<id>` — global click-listener r2810
    → `_submitLinkCompany(id)` (r2827). POST `/api/customer-link-company`.
- [ ] "Annuleren" — button, `onclick="closeLinkCompanyModal()"`.
- Modal-banner `#linkCompanyBanner`.

### `#bulkTagModal` (r997)

- r1000 — Count `#bulk-tag-count`.
- [ ] Radio-group "Tag toevoegen" / "Tag verwijderen" (r1006-1007) —
  `name="bulk-tag-action"`, values `tag-add` / `tag-remove`.
- [ ] `#bulk-tag-slug` — `<select>` met tag-opties (via
  `getTagDefinitions` r1059).
- Modal-banner `#bulkTagBanner`.
- [ ] "Annuleren" — button, `onclick="closeBulkTagModal()"`.
- [ ] "Toepassen" — button `#bulkTagConfirmBtn`,
  `onclick="submitBulkTag()"` (r3844). POST `/api/customer-bulk`.

---

## Klanten > Softphone (globale overlays — body-level)

Klx-softphone (init r4609), dupliceert wbx-pattern uit finance.html.
UI opgevoegd bij `document.body` (buiten `.main`).

### `#klxSoftphoneCallbar` (r4681) — Floating call-bar

Zichtbaar tijdens gesprek. Zelfstandig ook nadat het rich-sheet-venster
sluit.
- r4687 — Titel `#klxSoftphoneCallbarTitle` (Kiezen…/Gaat over…/In gesprek)
- r4689 — Timer `#klxSoftphoneCallbarTimer` (mm:ss)
- [ ] r4692 — Mute — button `#klxSoftphoneMuteBtn` (mic-icoon),
  bind r4697 → `_klxToggleMute` (r4739).
- [ ] r4693 — Ophangen — button `#klxSoftphoneHangupBtn` (phone-off-icoon,
  rood), bind r4698 → `_klxHangup` (r4936).

### `#klxSoftphoneSheet` (r4970) — Rich belvenster

Geopend door softphone-knop in Profiel-tab (r5139 delegated).
- r4979 — Titel `#klxCallSheetTitle` (met klant-naam).
- [ ] r4980 — Sluitknop `#klxCallSheetClose` (×), bind r4985 →
  `_klxCloseSheet`. Ook Escape (r4987).
- Body `#klxCallSheetBody`, dynamisch gerenderd door `_klxRenderSheet`
  (r5026).

Sheet-content (r5063):
- [ ] `#klxCallLineSel` — `<select>` "Uitbellen via" — opties: auto /
  NL-lijn (+31) / BE-lijn (+32) (BE alleen als configured). Change r5108.
- [ ] `#klxCallConnRetry` — retry-button (voorwaardelijk zichtbaar bij
  failed/disabled state). Bind r5115.
- [ ] `#klxCallNumberInput` — bewerkbaar tel-nummer input (bij idle).
  Input-listener r5097 → `numberOverride`.
- [ ] `#klxCallDial` — "📞 Bel nu" / "Vul nummer in" button (bij idle).
  Bind r5124 → `_klxPlaceCall(cust.phone, {displayName})`.
- [ ] `#klxCallHangup` — "Ophangen" button (bij in-call). Bind r5129.
- [ ] `#klxCallMute` — mute-toggle button (bij in-call). Bind r5130 →
  `_klxToggleMute` + re-render.

---

## Globale helpers en cross-cutting

- `openModal(id)` r4218 / `closeModal(id)` r4219 — CSS `.hidden`
  toggle.
- Modal ESC-order (bindModalGlobals r4562):
  duplicateConfirmModal → bulkArchiveModal → bulkTagModal →
  archiveModal → customerFormModal → filter-tags popover →
  tag-add-popover.
- Modal-overlay klik-buiten sluit modal (r4577).
- Click-outside voor tag-add-popover r4583, tag-multi-popover r3511.

## Auth-blockers / pre-checks

- `customer.module.access` — hard gate op init (r1112). Zonder →
  redirect naar `/index.html?error=forbidden`.
- `finance.invoice.view/create/send/update/credit/payment.register/payment.remove`
  — sub-permission-gates op Facturen-tab knoppen (r1466-1471).
- `sales.deal.create` — gate op "Nieuw abonnement"-knop (r2199).
- Softphone: `/api/voys-sip-config` en `/api/voys-call` gaten op
  `sales.tab.retentie` / `sales.customer.view` (server-side).

## Bijzonderheden / gaps t.o.v. prompt

1. De prompt beschrijft **6 sub-tabs** (Profiel/Finance/Deals/
   Communicatie/Onboarding/Notes). De code heeft **7 sub-tabs**:
   Profiel / Communicatie / Offertes / Abonnementen / Facturen /
   Wanbetalers / Audit. De prompt-taxonomie mapt als volgt:
   - "Finance" → Facturen + Abonnementen
   - "Deals" → Offertes
   - "Onboarding" → Card in Profiel-tab (geen aparte tab)
   - "Notes" → Notities-sectie in Communicatie-tab (geen aparte tab)
   - Extra: Wanbetalers-tijdlijn + Audit.
2. Lijst-view HTML is intact maar in productie **niet bereikbaar** via
   `init()` — user wordt naar `sales.html?tab=klanten` gestuurd.
   Redesign moet beslissen of dit terugkomt of definitief migreert.
3. Header-actiestrip mist een "Anonimiseren"-knop op detail-view
   (alleen Bewerken / Archiveren / Heractiveren). Anonymize-flow bestaat
   wel in de audit (`AUDIT_ACTION_LABELS.anonymized`), maar UI-trigger
   is niet vindbaar in dit bestand.
4. Softphone-UI is body-level en overleeft dus tab-wissels en soft-
   navigation.
5. De Wanbetalers-tab is uniek voor deze module (niet genoemd in prompt).

<!-- END klanten.md -->

---

## 3. Finance — top-level views

**Bron**: `modules/finance.html` r1-11500 — hoofdnavigatie + Dashboard + Facturen + Creditnota's + CAMT-Bank + Uitgaven + Bank + Roadmap + Instellingen-host.

<!-- BEGIN finance-A.md -->

# Finance-module Inventaris — Deel A (top-level, non-wanbetalers)

Bron: `C:\Users\jeffr\forex-opleiding-interface\.claude\worktrees\dazzling-cohen-d366bb\modules\finance.html` (regels 1-11500 in scope, plus modaal-definities elders in het bestand).

**Uit scope voor deze inventaris:** `view-wanbetalers` (r4294) en alles daarbinnen (inbox / dunning / arrangements / open acties / opruimen / brieven etc.). Modals die uitsluitend door de wanbetalers-cluster worden getriggerd (`inboxCustomerModal`, `inboxJoostModal`, `inboxLinkCustomerModal`, `inboxTplPickerModal`, `inboxQrPickerModal`, `joostEscalationModal`, `joostPauseModal`, `arrangementDetailModal`, `pendingActionDetailModal`, `paCreateArrangementModal`, `paCreateTaskModal`, `markExecutedModalFin`, `markNotExecutedModalFin`, `cancelArrangementModal`, `arrangProposeModal`, `dunTplModal`, `dunRunDetailsModal`) worden niet uitgesplitst.

---

## Finance > Hoofd-navigatie (financeNav)

Container: `#financeNav` (r4271). Tabs schakelen via `setView(view)` (r6879); click-listener op `#financeNav .sr-seg` (r20981). Actieve klasse `.sr-seg.active` bepaalt selected. URL-sync via `?tab=` en `?sub=` (r7223, r20988).

- [ ] r4273 — "Dashboard" — button `#navDashboard` `data-view="dashboard"` → `setView('dashboard')` → mount `FinanceDashboard` in `#view-dashboard`
  - zichtbaarheid: publiek (positie 1, default landing)
- [ ] r4274 — "Facturen" — button `data-view="facturen"` → `setView('facturen')`
  - zichtbaarheid: publiek; verborgen als user geen `finance.invoice.view` heeft (r20931)
- [ ] r4275 — "Creditnota's" — button `data-view="creditnotes"` → `setView('creditnotes')` → `_wireCreditnotesOnce()` + `loadCreditnotes()`
  - zichtbaarheid: publiek
- [ ] r4277 — "Klanten" — button `#navKlanten` `data-view="klanten"` → `setView('klanten')` → mount `FinanceKlanten` in `#view-klanten`
  - zichtbaarheid: publiek; verborgen zonder `finance.dunning.view` (r20932)
- [ ] r4278 — "Wanbetalers" — button `#navWanbetalers` `data-view="wanbetalers"` → out-of-scope
  - zichtbaarheid: `hidden default` (`style="display:none"`); zichtbaar bij `finance.inbox.view` OF `finance.dunning.view`
- [ ] r4279 — "Bank" — button `#navCamtBank` `data-view="camtbank"` → `setView('camtbank')`
  - zichtbaarheid: `hidden default`; zichtbaar bij `finance.bank.balance_view` OF `finance.bank.transactions_view`
- [ ] r4280 — "Uitgaven" — button `#navExpenses` `data-view="uitgaven"` → `setView('uitgaven')` → `initExpensesView()`
  - zichtbaarheid: `hidden default` (bewust uit — 2026-07-31 comment r20902); zichtbaar via deep-link `?tab=uitgaven`
- [ ] r4281 — "Roadmap" — button `data-view="roadmap"` → mount `FinanceViewRoadmap` in `#view-roadmap-host`
  - zichtbaarheid: publiek

### Deep-link URL-parameters op de nav

- [ ] `?tab=<dashboard|facturen|klanten|camtbank|uitgaven|bank|roadmap|wanbetalers>` — kiest de initiële view. Default (geen/onbekende): `dashboard`. Zie r20988-r21005.
- [ ] `?tab=wanbetalers&sub=<...>` — sub-view binnen wanbetalers (out-of-scope).
- [ ] `?conversation=<uuid>` — impliceert `sub=inbox` (out-of-scope).
- [ ] Legacy `?tab=instellingen` — niet meer in whitelist, valt terug op dashboard (r20999).

### Globale sneltoetsen

- [ ] r21063 — `Escape`-toets sluit alle modals: `invModal`, `payModal`, `sendModal`, `creditModal`, `updModal`, `newInvModal`, `newCustCreateModal`, `bankTxModal`, `claimPaidModal` (`document.addEventListener('keydown', … , true)`)

---

## Finance > Dashboard (view-dashboard)

Container: `#view-dashboard` (r4291), leeg host-element. Mount via `mountFinanceDashboardHost(host)` → `window.FinanceDashboard.mount({host, onDrillDown})` (r6987-r7013). Content wordt geleverd door `/modules/shared/finance-dashboard.js` (12 KPIs + 3 charts). Niet in `finance.html` gerenderd — inventarisatie hoort in de finance-dashboard.js audit.

- [ ] r4291 — `<div id="view-dashboard">` — mount-target voor externe module
  - zichtbaarheid: publiek (default landing-view)
- [ ] r6995 — `onDrillDown(target)` callback — reageert op KPI-klik. Doelen: `target.view = 'wanbetalers' (+ target.sub)`, `target.view = 'facturen' (+ target.status)` (klikt automatisch de status-pill), en generieke setView.

---

## Finance > Facturen (view-facturen)

Container: `#view-facturen` (r4386). Init via `init()` (r20874) + `load()` (r18315).

### Access-gates & banners

- [ ] r4387 — `#invLocked` — "Geen toegang tot facturen" banner (verborgen tenzij 403 op `finance.invoice.view`)
  - zichtbaarheid: hidden default; getoond wanneer response `/api/finance-invoices` 403 geeft (r18329)

### Sync TL → DB banner

- [ ] r4393 — `<details id="invSyncBanner">` — inklapbare pill "Sync TL → DB" (hidden default, wordt zichtbaar door `loadSyncStatus()` r19235)
- [ ] r4394 — `#invSyncSummary` — klikbare pill met `#invSyncText`
- [ ] r4398 — `#invSyncDetail` — grid met 4 resources (Facturen / Creditnota's / Contacten B2C / Bedrijven B2B), elk `[data-resource][data-field="lines"]`

### KPI-strip

- [ ] r4417 — `#invKpis` — `.ds-kpi-strip` (`--ds-kpi-cols:4`), gevuld door `renderKpis(kpis)` (in load-flow); labels/waardes komen uit `/api/finance-invoices` response.

### Filter-strip (`#invFilters`)

Container r4418. Status-pills (`#invStatusSeg`) staan boven aan; entiteit/periode/zoek/refresh/new rechts.

- [ ] r4419 — `#invStatusSeg` — segmented control voor status. Default active: `data-status="open"`.
  - [ ] r4420 — pill "Open" (`data-status="open"`, **default**)
  - [ ] r4421 — pill "Te laat" (`data-status="overdue"`)
  - [ ] r4422 — pill "Betaald" (`data-status="paid"`)
  - [ ] r4423 — pill "Concept" (`data-status="concept"`)
  - [ ] r4424 — pill "Gecrediteerd" (`data-status="credited"`)
  - [ ] r4425 — pill "Alle" (`data-status=""`)
- [ ] r4427 — `#invEntity` — select "Alle entiteiten". Opties gehardcoded (`ENTITIES` r6823): Online / Fysiek / Retentie. Filtert `state.entity` → `load()`.
- [ ] r4428 — `#invPeriodStart` — input `type="date"`, filter "Vanaf factuurdatum" (state.from).
- [ ] r4429 — `#invPeriodEnd` — input `type="date"`, filter "T/m factuurdatum" (state.to).
- [ ] r4430 — `#invSearch` — input `type="search"` placeholder "Zoek op nr of klantnaam…" (350ms debounce, state.q).
- [ ] r4432 — `#invRefresh` — icon-button `.sr-ibtn` title "Vernieuwen" (`i.ti-refresh`) → `load()`.
- [ ] r4433 — `#invNewBtn` — button `.sr-abtn.primary` "Nieuwe factuur" (`i.ti-plus`) → `openNewInvoiceModal()`.
  - zichtbaarheid: `display:none` tenzij `canCreate` (permission `finance.invoice.create`, r21056)

### Facturen-tabel (`#invTable`) — KOLOMMEN

Container r4436. Tbody = `#invTbody`. Renderer: `renderRows(items)` (r18261). Row = `<tr class="clickable-row" data-inv-row="i">`; click op rij (buiten menu/button/link) opent `openDetail(inv)`.

- [ ] r4438 — **KOL 1** — statusstrip-bar (4px, kleurblokje, geen tekst)
- [ ] r4439 — **KOL 2** — "Factuurnr" — cel toont `inv.invoice_number` + optioneel entiteits-sublabel
- [ ] r4439 — **KOL 3** — "Klant" — cel toont `inv.customer_name`
- [ ] r4440 — **KOL 4** — "Totaal" (num) — `eur(inv.amount_total)`
- [ ] r4440 — **KOL 5** — "Betaald" (num) — `eur(inv.amount_paid)`
- [ ] r4440 — **KOL 6** — "Open" (num) — `eur(inv.amount_open)`
- [ ] r4441 — **KOL 7** — "Vervaldag" — `fmtDate(inv.due_date)`
- [ ] r4441 — **KOL 8** — "Status" — `.sr-tag` met `stMeta(inv.display_status)` (concept/open/partially_paid/paid/overdue/credited/partially_credited/writeoff — r6829)
- [ ] r4441 — **KOL 9** — 3-dots kebab menu (`.sr-menu > .sr-menu-toggle` + `.sr-menu-pop`)

### Facturen kebab-menu (per-rij, r18276)

Positioned via `initMenus()` (r19186) — `position:fixed`, `getBoundingClientRect`, flip-up, close-on-scroll.

- [ ] r18277 — "Bekijk details" (`data-inv-detail`) → `openDetail(inv)` → toont `invModal`
- [ ] r18265 — "Betaling registreren" (`data-inv-pay`) → `openPayModal(inv)`
  - zichtbaarheid: `canRegister` (`finance.invoice.payment.register`) EN `inv.tl_invoice_id` EN status ∈ [open, partially_paid, overdue]
- [ ] r18266 — "Betaling terugdraaien" (`data-inv-remove`, .danger) → `removePayment(inv)` (confirm + `/api/finance-invoice-remove-payment`)
  - zichtbaarheid: `canRemove` (`finance.invoice.payment.remove`) EN `inv.tl_invoice_id` EN `amount_paid > 0`
- [ ] r18264 — "Open in Teamleader" (`<a target="_blank">`) → `https://focus.teamleader.eu/invoice_detail.php?id=<tl_invoice_id>`
  - zichtbaarheid: alleen als `inv.tl_invoice_id`

### Pager (`#invPager`)

Container r4446. Renderer `renderPager()` (r18297).

- [ ] r18305 — button `#invPrev` "Vorige" — vorige pagina
- [ ] r18306 — button `#invNext` "Volgende" — volgende pagina
- [ ] r18304 — select `#invPageSize` — opties 20 / 50 / 100 / 500 (default 50)

---

## Finance > Facturen > Modal: Factuur detail (invModal, r6573)

Geopend via `openDetail(inv)` (r18341). Titel `#invModalTitle`. Body `#invModalBody`, dynamisch opgebouwd.

### Info-kaart + Acties-rij (dynamisch in `#invModalBody`)

- [ ] r18370 — `#invBtnPay` — "Markeer betaald" (`.sr-abtn.success`, `i.ti-cash`) → sluit invModal + `openPayModal(inv)`
  - zichtbaarheid: `canRegister` + `tl_invoice_id` + status ∈ [open/partially_paid/overdue]
- [ ] r18371 — `#invBtnSend` — "Verzenden" (`i.ti-send`) → `openSendModal(inv)`
  - zichtbaarheid: `canSend` + `tl_invoice_id`; anders `dimBtn` grijsgemaakt
- [ ] r18372 — `#invBtnUpdate` — "Aanpassen" (`i.ti-edit`) → `openUpdateModal(inv)`
  - zichtbaarheid: `canUpdate` + `tl_invoice_id` + `status === 'concept'`
- [ ] r18373 — dim-knop "Incasso" (via TL, altijd disabled)
- [ ] r18374 — `#invBtnCredit` — "Creditnota" (`.sr-abtn.danger`, `i.ti-file-minus`) → `openCreditModal(inv)`
  - zichtbaarheid: `canCredit` + `tl_invoice_id` + status ≠ 'concept' + `credited_amount < amount_total`
- [ ] r18376 — `#invBtnPdf` — "PDF" (`i.ti-file-type-pdf`) → `/api/finance-invoice-pdf?tl_invoice_id=...` → opent PDF-URL in nieuw venster
  - zichtbaarheid: enabled bij `tl_invoice_id`
- [ ] r18377 — `<a>` "Teamleader" (`i.ti-external-link`) → `focus.teamleader.eu/invoice_detail.php?id=<tl_invoice_id>` (fallback `/invoices`) target=_blank

### Betaal-link sectie (dynamisch, alleen bij tl_invoice_id + open/partially_paid/overdue)

- [ ] r18386 — `#invPayLinkInput` (readonly text-input) — toont opgehaalde betaal-URL
- [ ] r18383 — `#invPayLinkBadge` — badge "Cache hit (Nd oud)" / "Vers opgehaald"
- [ ] r18387 — `#invoicePaymentLinkRefreshBtn` — "Ververs betaal-link" (`i.ti-refresh`), Shift+klik = force refresh (`?force=true`)
- [ ] r18388 — `#invPayLinkCopyBtn` — "Kopiëren" (`i.ti-copy`) → `navigator.clipboard.writeText(payment_url)`
  - zichtbaarheid: disabled tot payment_url beschikbaar
- [ ] r18389 — `#invPayLinkOpenBtn` — `<a target="_blank">` "Openen" (`i.ti-external-link`)
  - zichtbaarheid: `display:none` tot payment_url beschikbaar

### Sub-kaarten in factuur-detail

- [ ] r18393 — `#invLinesCard` — lazy-loaded factuurregels + BTW-verdeling via `/api/finance-invoice-lines?invoice_id=`
- [ ] r18393 — `#invCreditCard` — lazy creditnota's via `/api/finance-invoice-creditnotes?invoice_id=` (alleen bij `credited_amount > 0`)
- [ ] r18393 — `#invFeeCard` — lazy incassokosten via `/api/finance-invoice-late-fee?invoice_id=` (alleen bij overdue)
- [ ] r18394 — `#invPayCard` — betalingen-kaart; bevat inline `#invRemoveLink` "terugdraaien" bij `canRemove` + `amount_paid > 0`
- [ ] r18395 — `#invActCard` — afgeleide activiteit-tijdlijn (issue_date / due_date / paid_date)

### Modal-close controls

- [ ] r6578 — `#invModalClose` — "Sluiten" (`.sr-abtn.primary`)
- Click-outside op `#invModal` sluit modal (r21020)
- Escape-toets sluit modal (r21063)

---

## Finance > Facturen > Modal: Betaling registreren (payModal, r6584)

Geopend via `openPayModal(inv)` (r18548).

- [ ] r6587 — `#payModalSub` — subtitle (klant + openstaand)
- [ ] r6589 — `#payAmount` — input `type="number"` step 0.01 "Bedrag (€)" (default = amount_open)
- [ ] r6590 — `#payDate` — input `type="date"` "Betaaldatum" (default = vandaag)
- [ ] r6591 — `#payMethod` — input `type="text"` "Betaalmethode-id (optioneel)" placeholder "TL payment_method_id"
- [ ] r6593 — `#payModalErr` — error-text
- [ ] r6595 — `#payCancel` — "Annuleren"
- [ ] r6596 — `#paySubmit` — "Registreren" (`.sr-abtn.success`, `i.ti-cash`) → `submitPay()` → `/api/finance-invoice-register-payment`
- Click-outside sluit (r21025); Escape sluit (r21063)

---

## Finance > Facturen > Modal: Klant claimt betaald (claimPaidModal, r6602)

Geopend via `openClaimPaidModal()` (r18605). **NB:** trigger-knop `#inboxClaimPaidBtn` (r21028) zit in inbox-scope (wanbetalers). Modal + submit-logica staan echter buiten die scope.

- [ ] r6605 — `#claimPaidSub` — subtitle (klant + telefoon)
- [ ] r6608 — `#claimPaidInvoiceSelect` — select factuur (default = oudste open factuur)
- [ ] r6611 — `#claimPaidAmount` — input `type="number"` "Geclaimd bedrag (€)"
- [ ] r6614 — `#claimPaidText` — textarea (min 10 chars) "Claim-tekst (klant-bericht)" (auto-gevuld met laatste inbound bericht)
- [ ] r6620 — `#claimPaidErr` — error-text
- [ ] r6622 — `#claimPaidCancel` — "Annuleren"
- [ ] r6623 — `#claimPaidSubmit` — "Verstuur" (`.sr-abtn.primary`, `i.ti-send`) → `submitClaimPaid()` → creëert `MANUAL_VERIFY_PAYMENT` task

---

## Finance > Facturen > Modal: Factuur verzenden (sendModal, r6629)

Geopend via `openSendModal(inv)` (r18796).

- [ ] r6632 — `#sendSub` — subtitle
- [ ] r6635 — `#sendTpl` — select "Teamleader mail-template" (verplicht)
- [ ] r6637 — `#sendTo` — input `type="email"` "Ontvanger (e-mail)" (**readonly** — komt uit TL)
- [ ] r6640 — `#sendPreview` — preview-blok met `#sendPreviewSubject` + `#sendPreviewBody` (variabelen-substitutie)
- [ ] r6648 — `#sendAdvToggle` — link "Geavanceerd: onderwerp / inhoud overschrijven ▾" — toggle
- [ ] r6651 — `#sendSubject` — input "Onderwerp overschrijven" (leeg = template-default), in `#sendAdv`
- [ ] r6654 — `#sendContent` — textarea "Inhoud overschrijven" (leeg = template-default), in `#sendAdv`
- [ ] r6659 — `#sendErr` — error-text
- [ ] r6661 — `#sendCancel` — "Annuleren"
- [ ] r6662 — `#sendOk` — "Verzenden" (`.sr-abtn.primary`, `i.ti-send`) → `submitSend()`. Disabled tot template gekozen (`syncSendOk`).
- Click-outside sluit (r21038); Escape sluit (r21063)

---

## Finance > Facturen > Modal: Crediteren (creditModal, r6668)

Geopend via `openCreditModal(inv)` (r18904).

- [ ] r6671 — `#creditSub` — subtitle
- [ ] r6675 — `#creditDesc` — input `type="text"` "Omschrijving (optioneel)" placeholder "bv. annulering, retour, fout"
- [ ] r6676 — `#creditErr` — error-text
- [ ] r6678 — `#creditCancel` — "Annuleren"
- [ ] r6679 — `#creditOk` — "Crediteren" (`.sr-abtn.danger`, `i.ti-file-minus`) → `submitCredit()`
- Click-outside + Escape

---

## Finance > Facturen > Modal: Conceptfactuur aanpassen (updModal, r6685)

Geopend via `openUpdateModal(inv)` (r18920).

- [ ] r6688 — `#updSub` — subtitle
- [ ] r6689 — `#updLines` — dynamisch container met regels (`_updLines`)
- [ ] r6690 — `#updAddLine` — "Regel toevoegen" (`i.ti-plus`) → push nieuwe regel + `renderUpdLines()`
- [ ] r6691 — `#updErr` — error-text
- [ ] r6693 — `#updCancel` — "Annuleren"
- [ ] r6694 — `#updOk` — "Opslaan" (`.sr-abtn.primary`, `i.ti-check`) → `submitUpdate()`
- Click-outside + Escape

---

## Finance > Facturen > Modal: Nieuwe factuur (newInvModal, r6700)

Geopend via `openNewInvoiceModal()` (r19067).

- [ ] r6704 — `#newCustSearch` — input `type="search"` "Klant" placeholder "Zoek klant…" (autocomplete → `onNewCustSearch`)
- [ ] r6704 — `#newCustList` — dropdown zoekresultaten (verborgen tot input)
- [ ] r6704 — `#newCustSel` — geselecteerde klant (accent-cyan tekst)
- [ ] r6704 — `#newCustCreateLink` — link "Nieuwe klant aanmaken" (`i.ti-user-plus`) → `openNewCustCreateModal()`
- [ ] r6705 — `#newDept` — select "Entiteit" (dynamisch gevuld met ENTITIES)
- [ ] r6708 — `#newLines` — dynamische regels container (`_newLines`, elk met description/quantity/unit_price_excl/vat_percentage=21)
- [ ] r6709 — `#newAddLine` — "Regel toevoegen" (`i.ti-plus`) → push + `renderNewLines()`
- [ ] r6711 — `#newPO` — input `type="text"` "Referentie/PO (optioneel)"
- [ ] r6712 — `#newLang` — select "Taal" — opties: Nederlands (`nl`, default) / Engels (`en`) / Frans (`fr`)
- [ ] r6714 — `#newErr` — error-text
- [ ] r6716 — `#newCancel` — "Annuleren"
- [ ] r6717 — `#newDraft` — "Opslaan als concept" → `submitNew('draft')`
- [ ] r6718 — `#newBook` — "Boeken" (`i.ti-book`) → `submitNew('book')`
- [ ] r6719 — `#newBookSend` — "Boeken & Verzenden" (`.sr-abtn.success`, `i.ti-send`) → `submitNew('book', {autoOpenSend: true})`
- Click-outside sluit; Escape sluit

---

## Finance > Facturen > Sub-modal: Nieuwe klant aanmaken (newCustCreateModal, r6725)

Geopend via `openNewCustCreateModal()` (r18979). Sub-modal binnen newInvModal-flow (z-index 1100).

- [ ] r6730 — `#newCustIsCompany` — checkbox "Dit is een bedrijf (B2B)" → toggle B2B/B2C velden
- [ ] r6732 — `#newCustB2bFields` — container (verborgen tot B2B aan)
  - [ ] r6733 — `#newCustCompanyName` — input "Bedrijfsnaam" (verplicht bij B2B)
  - [ ] r6734 — `#newCustKvk` — input "KvK-nummer"
  - [ ] r6735 — `#newCustVat` — input "BTW-nummer"
- [ ] r6737 — `#newCustB2cFields` — container (default zichtbaar)
  - [ ] r6738 — `#newCustFirstName` — input "Voornaam" (verplicht)
  - [ ] r6739 — `#newCustLastName` — input "Achternaam" (verplicht)
- [ ] r6742 — `#newCustEmail` — input `type="email"` "Email"
- [ ] r6743 — `#newCustPhone` — input `type="tel"` "Telefoon"
- [ ] r6746 — `#newCustStreet` — input "Straat"
- [ ] r6747 — `#newCustNumber` — input "Huisnr."
- [ ] r6748 — `#newCustPostal` — input "Postcode"
- [ ] r6749 — `#newCustCity` — input "Plaats"
- [ ] r6752 — `#newCustPrivacy` — checkbox "Klant is geïnformeerd over de privacyverklaring" (verplicht)
- [ ] r6753 — `<a href="/privacy" target="_blank">` — link naar privacyverklaring
- [ ] r6756 — `#newCustCreateErr` — error-text
- [ ] r6758 — `#newCustCreateCancel` — "Annuleren"
- [ ] r6759 — `#newCustCreateOk` — "Aanmaken" (`.sr-abtn.primary`, `i.ti-check`) → `submitNewCustCreate()`
- Click-outside sluit; Escape sluit

---

## Finance > Creditnota's (view-creditnotes)

Container: `#view-creditnotes` (r4451). Init `_wireCreditnotesOnce()` (r7239) + `loadCreditnotes()` (r7255) bij view-open.

### Toolbar (`.fin-toolbar`, r4452)

- [ ] r4453 — `#cnSearch` — input `type="search"` placeholder "Zoek nummer of klant…" (250ms debounce → page=1 + load)
- [ ] r4454 — `#cnPeriodStart` — input `type="date"` "Vanaf datum"
- [ ] r4455 — `#cnPeriodEnd` — input `type="date"` "T/m datum"
- [ ] r4456 — `#cnRefreshBtn` — "Vernieuwen" → `loadCreditnotes()`

### KPI-strip (`#cnKpi`, r4458)

- [ ] r4461 — `#cnKpiCount` — "Aantal creditnota's" (kpi.count)
- [ ] r4465 — `#cnKpiSum` — "Totaal gecrediteerd" (kpi.sum_amount, in rood)

### Status-elementen

- [ ] r4468 — `#cnLoading` — "Laden…" text (display-toggle)
- [ ] r4469 — `#cnError` — error-blok

### Creditnota-tabel (`#cnTable`) — KOLOMMEN

Tbody = `#cnTbody`. Renderer inline in `loadCreditnotes()`.

- [ ] r4474 — **KOL 1** — "Nummer" (`credit_note_number`)
- [ ] r4475 — **KOL 2** — "Datum" (`credit_note_date`)
- [ ] r4476 — **KOL 3** — "Klant" (`customer_name`)
- [ ] r4477 — **KOL 4** — "Gekoppelde factuur" (`invoice_number`)
- [ ] r4478 — **KOL 5** — "Bedrag" (right-aligned, `− amount_total`, rood)
- [ ] r4479 — **KOL 6** — "Status" (badge met `credit_note.status`)

### Pager (`#cnPager`, r4485)

Renderer inline (r7301).

- [ ] `#cnPrev` — "Vorige" (dynamisch)
- [ ] `#cnNext` — "Volgende" (dynamisch)

---

## Finance > CAMT-Bank (view-camtbank)

Container: `#view-camtbank` (r4489). Lazy-init bij eerste view-open (`_camtBankLoadedOnce` r6953). Permission-gate: `canBankBalanceView` (`finance.bank.balance_view`) voor saldo + `canBankTxView` (`finance.bank.transactions_view`) voor tabel/filters/upload.

### Access-banner

- [ ] r4490 — `#camtBankLocked` — "Geen toegang tot bankoverzicht" (verborgen tenzij 403 op `/api/finance-bank-camt-transactions`)

### Sub-tabs (`#camtSubNav`, r4496)

Wisselt via `setCamtSubView(sub)` (r19829). Default active: transactions.

- [ ] r4497 — pill "Transacties" (`data-camt-sub="transactions"`, **default active**)
- [ ] r4498 — pill "Matches" (`data-camt-sub="matches"`) + `#camtMatchesBadge` (aantal open matches)
- [ ] r4499 — pill "Config" (`data-camt-sub="config"`)

### Sub-view: Transacties (`#camtSubTransactions`, r4503)

#### Saldo-card

- [ ] r4508 — `#camtBalanceVal` — bedrag "€ —" (renderer `loadCamtBalance` r19462)
- [ ] r4509 — `#camtBalanceMeta` — meta-tekst (datum + IBAN + bestand)
- [ ] r4511 — `#camtBalanceRefresh` — icon-button title "Saldo vernieuwen" (`i.ti-refresh`) → `loadCamtBalance()`

#### Filter-strip (`#camtBankFilters`, r4514)

- [ ] r4515 — `#camtBankDirSeg` — segmented control:
  - [ ] r4516 — pill "Alle" (`data-dir="all"`, **default**)
  - [ ] r4517 — pill "Inkomend" (`data-dir="in"`)
  - [ ] r4518 — pill "Uitgaand" (`data-dir="out"`)
- [ ] r4520 — `#camtBankFrom` — input `type="date"` "Vanaf datum"
- [ ] r4521 — `#camtBankTo` — input `type="date"` "T/m datum"
- [ ] r4522 — `#camtBankSearch` — input `type="search"` placeholder "Zoek op omschrijving, IBAN, factuurnr…" (350ms debounce)
- [ ] r4524 — `#camtBankRefresh` — icon-button title "Lijst vernieuwen" (`i.ti-refresh`) → `loadCamtBank()`

#### Tabel (`#camtBankTable`, r4528) — KOLOMMEN

Tbody = `#camtBankTbody`. Row-click → `openCamtBankTxModal(idx)`.

- [ ] r4530 — **KOL 1** — "Datum" (`booking_date`, nowrap)
- [ ] r4531 — **KOL 2** — "Omschrijving" (truncated, raw in title)
- [ ] r4532 — **KOL 3** — "Tegenpartij" (`counterparty_name`, truncated)
- [ ] r4533 — **KOL 4** — "IBAN" (`counterparty_iban`, monospace, truncated)
- [ ] r4534 — **KOL 5** — "Referentie" (`end_to_end_id`, blue tag)
- [ ] r4535 — **KOL 6** — "Gekoppelde factuur" — inline `<a data-open-invoice-id>` groene tag → `openInvoiceById()` (opent `invModal`)
- [ ] r4536 — **KOL 7** — "Bedrag" (right-aligned, groen/rood met sign)

#### Pager (`#camtBankPager`, r4541)

- [ ] `#camtBankPrev` — icon-button `i.ti-chevron-left`
- [ ] `#camtBankNext` — icon-button `i.ti-chevron-right`

### Sub-view: Matches (`#camtSubMatches`, r4545) — hidden default

#### Match-filter-strip (r4547)

- [ ] r4548 — `#matchStatusSeg` — segmented control:
  - [ ] r4549 — pill "Te beoordelen" (`data-status="open"`, **default**)
  - [ ] r4550 — pill "Bevestigd" (`data-status="confirmed_all"`)
  - [ ] r4551 — pill "Verworpen" (`data-status="rejected"`)
  - [ ] r4552 — pill "Alle" (`data-status="all"`)
- [ ] r4555 — `#matchRefresh` — icon-button title "Vernieuwen" (`i.ti-refresh`) → `loadMatches()`

#### Match-tabel (`#matchTable`, r4560) — KOLOMMEN

Tbody = `#matchTbody`. Renderer `loadMatches()` (r19894). Row-click → `openCamtBankTxModal(m.camt)`.

- [ ] r4562 — **KOL 1** — "Datum" (`m.camt.booking_date`)
- [ ] r4563 — **KOL 2** — "Bedrag" (num, groen +)
- [ ] r4564 — **KOL 3** — "Tegenpartij" (`m.camt.counterparty_name`)
- [ ] r4565 — **KOL 4** — "Omschrijving" (truncated tot 60 chars, raw in title)
- [ ] r4566 — **KOL 5** — "Score" (0-100, gekleurd badge: >=90 groen, >=70 oranje, anders geel)
- [ ] r4567 — **KOL 6** — "Redenen" (chips: Bedrag / Bedrag(deel) / Factuurnr / Naam / Datum / Handmatig)
- [ ] r4568 — **KOL 7** — "Factuur" (blue tag `invoice_number` + klantnaam)
- [ ] r4569 — **KOL 8** — "Status" (Te beoordelen / Auto-bevestigd / Bevestigd / Handmatig gekoppeld / Verworpen)
- [ ] r4570 — **KOL 9** — Acties (per rij):
  - [ ] `[data-match-confirm]` — "Bevestig" (`.sr-abtn.primary`, `i.ti-check`) → `confirmMatch(idx)` (confirm-dialog + `/api/finance-payment-match-confirm`) — alleen bij status='suggested'
  - [ ] `[data-match-reject]` — "×" icon of "Verwerp" tekst → `rejectMatch(idx)` (prompt reden + `/api/finance-payment-match-reject`) — bij suggested + auto_confirmed

#### Match-pager (`#matchPager`, r4575)

- [ ] `#matchPrev` — icon-button
- [ ] `#matchNext` — icon-button

### Sub-view: Config (`#camtSubConfig`, r4579) — hidden default

#### Card: CAMT-import (r4581)

- [ ] r4592 — `#camtFileInput` — verborgen file-input (`accept=".xml,application/xml,text/xml"`)
- [ ] r4593 — `#camtUploadBtn` — "Kies bestand" (`.sr-abtn.primary`, `i.ti-upload`) → triggert file-picker
- [ ] r4596 — `#camtUploadStatus` — status-tekst (kleurcodes bij success/error)
- [ ] r4597 — `#camtUploadDrop` — drop-zone "Of sleep een .xml-bestand op deze plek" (drag-and-drop → `uploadCamtFile`)
- [ ] r4600 — `#camtStatementsList` — lijst recente statements (renderer `loadCamtStatementsList` r19759)

#### Card: Matching → Autopilot-block (r4608)

- [ ] r4612 — `#matchAutoToggle` — checkbox "Automatisch matchen bij hoge zekerheid (autopilot)"
- [ ] r4615 — `#matchAutoMeta` — meta-tekst ("Aan · matches bij score ≥ N" / "Uit · handmatig")
- [ ] r4617 — `#matchAutoThresholdBox` — container (verborgen tot toggle aan)
- [ ] r4619 — `#matchAutoThreshold` — input `type="range"` min=50 max=100 step=5 value=95
- [ ] r4620 — `#matchAutoThresholdVal` — output-getal (default 95)
- [ ] r4621 — `#matchAutoSave` — "Opslaan" (`.sr-abtn.primary`) → `saveMatchAutopilotSetting()` → `/api/app-settings key=payment_match_autopilot`
- [ ] r4624 — `#matchAutoStatus` — status-tekst

#### Card: Matching → Bulk-matcher (r4627)

- [ ] r4632 — `#matchBulkRunBtn` — "Match historische data" (`.sr-abtn.primary`, `i.ti-player-play`) → `runBulkMatcher()` (confirm + `/api/finance-payment-matcher-run`)

#### Card: Onderhoud (r4639)

- [ ] r4648 — `#invBulkResyncBtn` — "Re-sync open facturen met TL" (`.sr-abtn.primary`, `i.ti-refresh`) → `runBulkInvoiceResync()` (confirm + `/api/finance-invoice-bulk-resync`)

---

## Finance > CAMT-Bank > Modal: Bank-tx detail (bankTxModal, r6529)

Geopend via `openBankTxModal(idx)` (r19293) OF `openCamtBankTxModal(idxOrTx)` (r19599). Gedeeld modal voor beide bank-tabs.

- [ ] r6532 — `#bankTxTitle` — titel (datum + type)
- [ ] r6533 — `#bankTxClose` — icon-close "×" (`i.ti-x`)
- [ ] r6535 — `#bankTxAmount` — bedrag met kleur + sign
- [ ] r6538 — `#bankTxDescription` — omschrijving (monospace, pre-wrap)
- [ ] r6540 — `#bankTxCounterparty` — tegenpartij
- [ ] r6542 — `#bankTxIban` — IBAN (monospace)
- [ ] r6544 — `#bankTxInvoiceNumber` — factuurnr / end_to_end_id
- [ ] r6546 — `#bankTxEbId` — e-Boekhouden ID / entry_reference
- [ ] r6548 — `#bankTxLedger` — Ledger / account_iban
- [ ] r6550 — `<details>` "Ruwe data (raw_payload)" (inklapbaar)
- [ ] r6552 — `#bankTxRaw` — `<pre>` met JSON dump

### Handmatige factuur-koppeling (bankTxLinkSection, alleen bij inkomende CAMT-tx)

- [ ] r6556 — `#bankTxLinkSection` — sectie (hidden voor e-Boekhouden tx)
- [ ] r6560 — `#bankTxLinkSearch` — input `type="search"` placeholder "Zoek klant of factuurnummer…" (300ms debounce → `bankTxLinkRunSearch`)
- [ ] r6561 — `#bankTxLinkSearchStatus` — status "Min 2 tekens" / "Zoeken…" / "N/M resultaten"
- [ ] r6563 — `#bankTxLinkResults` — resultaten-lijst (klikbare rijen `[data-link-pick]` → `bankTxLinkPickInvoice` → `/api/finance-payment-match-manual`)

### Footer

- [ ] r6567 — `#bankTxCloseBtn` — "Sluiten" (`.sr-abtn.primary`)
- Click-outside sluit (r21092); Escape sluit (r21063)

---

## Finance > Uitgaven (view-uitgaven)

Container: `#view-uitgaven` (r4661). Lazy-init `initExpensesView()` (r20042). Gates: `canExpensesView` (`finance.expenses.view`) + `canExpensesEdit` (`finance.expenses.category.edit`).

### Access-banner

- [ ] r4662 — `#expensesLocked` — "Geen toegang tot uitgaven-analyse" (hidden default)

### Header (r4668)

- [ ] r4670 — `<h2>` "Zakelijke uitgaven"
- [ ] r4673 — `#expUploadWrap` — upload-container (hidden tenzij `canExpensesEdit`)
- [ ] r4674 — `#paypalUploadInput` — verborgen file-input `accept=".csv,.CSV,text/csv"`
- [ ] r4675 — `#paypalUploadBtn` — "PayPal-CSV uploaden" (`.sr-abtn.primary`, `i.ti-upload`) → triggert file-picker → `onPaypalFile` → `/api/finance-bank-paypal-upload`
- [ ] r4676 — `#paypalUploadStatus` — status-tekst

### Dashboard-blok (`#expDashboardWrap`, r4681) — 3 charts

Renderer `renderExpDashboard(d)` (r20323). Verborgen bij total=0.

- [ ] r4686 — `#expChartCategories` — "Uitgaven per categorie" (horizontale staven, top 8 + rest)
- [ ] r4691 — `#expChartMonths` — "Uitgaven per maand" (verticale staven trend)
- [ ] r4696 — `#expChartGroups` — "Operationeel · vennoten · belasting" (3 KPI-blokken)

### KPI-strip (`#expKpiStrip`, r4702)

- [ ] r4703 — `#expKpiTotal` — "Totaal uitgaven" + `#expKpiPeriod` (van→tot)
- [ ] r4704 — `#expKpiUncat` — "Nog te categoriseren" + `#expKpiUncatSub` (tx-count + %)
- [ ] r4705 — `#expKpiCpCount` — "Tegenpartijen" (aantal unieke)

### Filters (`#expFilters`, r4709)

Alle filters triggeren `loadExpensesData()` via change-listener (r20071-r20077).

- [ ] r4711 — `#expFilterFrom` — input `type="date"` "Periode vanaf"
- [ ] r4713 — `#expFilterTo` — input `type="date"` "Periode tot"
- [ ] r4716 — `#expFilterSource` — select "Bron" — opties: "Alle" (`all`, **default**) / "CAMT (ING)" (`camt`) / "PayPal" (`paypal`)
- [ ] r4723 — `#expFilterCategory` — select "Categorie" (dynamisch gevuld uit `/api/finance-expenses-categories`)
- [ ] r4726 — `#expFilterUncat` — checkbox "Alleen ongecategoriseerd"
- [ ] r4729 — `#expFilterInternal` — checkbox "Toon vasthoudingen/intern"
- [ ] r4732 — `#expFilterIncoming` — checkbox "Toon inkomsten"
- [ ] r4735 — `#expFilterInternalTransfers` — checkbox "Toon interne overboekingen" (default off — vermijdt dubbeltelling)
- [ ] r4738 — `#expFilterOnlyAiSuggest` — checkbox "Alleen AI-suggesties" (client-side filter, geen refetch)

### Tegenpartijen-lijst — header-actiestrip (r4744)

- [ ] r4747 — `#expAiSuggestBtn` — "AI-suggesties genereren" (paars, `i.ti-sparkles`) → `onExpAiSuggestGenerate` (chunked via `/api/finance-expenses-ai-suggest`)
- [ ] r4748 — `#expAiConfirmSelectedBtn` — "Bevestig geselecteerde (N)" (groen, `i.ti-check`) + `#expAiSelectedCount` — hidden default → `onExpAiConfirmSelected`
- [ ] r4749 — `#expAiBulkConfirmBtn` — "Bulk bevestigen (drempel)" (`i.ti-check-all`) — hidden default → `onExpAiBulkConfirm` (prompt drempel + `/api/finance-expenses-confirm-suggestion`)
- [ ] r4750 — `#expRefreshBtn` — "Vernieuwen" (`i.ti-refresh`) → `loadExpensesData()`
- [ ] r4753 — `#expAiStatus` — AI status-blok

### Tegenpartijen-tabel (`.exp-cp-table`, r4755) — KOLOMMEN

Tbody = `#expCpTbody`. Renderer `renderExpCounterparties` (r20530).

- [ ] r4758 — **KOL 1** — checkbox `#expAiSelectAll` (title "Selecteer alle zichtbare AI-suggesties") — master voor per-row `.exp-ai-select` (`onExpAiSelectAll`)
- [ ] r4759 — **KOL 2** — "Tegenpartij" — link `.exp-cp-open` → opent `expDetailModal` (+ subtitle: first_date → last_date)
- [ ] r4760 — **KOL 3** — "Totaal" (right-aligned, kleur-gecodeerd)
- [ ] r4761 — **KOL 4** — "Aantal" (tx_count)
- [ ] r4762 — **KOL 5** — "Categorie" — `<select class="exp-cp-picker" data-cp="…">` (paarse rand + preselect bij AI-suggestie) → `onExpCpCategoryChange` → `/api/finance-expenses-set-counterparty-category`; ook inline "Bevestig" (`.exp-ai-confirm[data-cp][data-cat]`) → `onExpAiConfirmSingle` bij AI-suggestie
- [ ] r4763 — **KOL 6** — icon-button `.exp-cp-open` (`i.ti-list`) → open detail-modal

### Bulk-multiselect

- **Selectie-set**: `_expensesState.selectedForBulkConfirm` (Set van tegenpartij-names).
- **Geaccepteerde rijen**: alleen rijen met `ai_suggestion` zonder bevestigde categorie krijgen een checkbox — andere rijen tonen `—`.
- **Bulk-actie**: `#expAiConfirmSelectedBtn` → POST met `counterparties: [names]` naar `/api/finance-expenses-confirm-suggestion`.

### Vaste lasten & besparen (`.exp-recurring-wrap`, r4772)

- [ ] r4776 — sectie-header "Vaste lasten & besparen"
- [ ] r4776 — `#expRecurringCount` — aantal in header
- [ ] r4779 — `#expRecurringMonthlyTotal` — "Totaal €X / maand"
- [ ] r4782 — `#expRecurringInsights` — samenvattings-strip (mgl. ongebruikt / mgl. dubbel counts)
- Tabel — Tbody = `#expRecurringTbody`. Renderer `renderExpRecurring` (r20443).

Vaste-lasten tabel KOLOMMEN:
- [ ] r4787 — **KOL 1** — "Tegenpartij" (display_name + "N tx · mediaan Nd")
- [ ] r4788 — **KOL 2** — "Interval" (monthly/quarterly/yearly, gekleurd)
- [ ] r4789 — **KOL 3** — "Per maand" (rood, num, nowrap)
- [ ] r4790 — **KOL 4** — "Totaal" (dim, num, nowrap)
- [ ] r4791 — **KOL 5** — "Categorie" (badge)
- [ ] r4792 — **KOL 6** — "Laatst" (last_date + days_since)
- [ ] r4793 — **KOL 7** — "Signalen" (badges "⚠ ongebruikt?" / "🔄 dubbel?")

### Breakdown per categorie (`.exp-breakdown-wrap`, r4802)

Tabel — Tbody = `#expBreakdownTbody`. Renderer `renderExpBreakdown` (r20690).

- [ ] r4808 — **KOL 1** — "Categorie" (kleurbol + label; uncat row met alert-icon in oranje/rood)
- [ ] r4809 — **KOL 2** — "Bedrag" (num, right, kleur bij neg)
- [ ] r4810 — **KOL 3** — "%" (num)
- [ ] r4811 — **KOL 4** — "Aantal" (num)

---

## Finance > Uitgaven > Modal: Detail (expDetailModal, r4822)

Geopend via `openExpDetailModal(cpName)` (r20734).

- [ ] r4825 — `#expDetailTitle` — "Transacties · <cpName>"
- [ ] r4826 — `.modal-close` "×" (`onclick="closeExpDetailModal()"`)
- [ ] r4828 — `#expDetailBody` — dynamisch tabel via `renderExpDetailBody` (r20763)
- [ ] r4832 — `<button class="btn-secondary">` "Sluiten" (`onclick="closeExpDetailModal()"`)

### Expenses-detail tabel KOLOMMEN (dynamisch in `#expDetailBody`)

- [ ] r20778 — **KOL 1** — "Datum" (booking_date)
- [ ] r20779 — **KOL 2** — "Bedrag" (num right, kleur + currency)
- [ ] r20780 — **KOL 3** — "Omschrijving" (raw text in title)
- [ ] r20781 — **KOL 4** — "Type" (transaction_code)
- [ ] r20782 — **KOL 5** — "Bron" (source, uppercase)
- [ ] r20783 — **KOL 6** — "Categorie (override per tx)" — badge + `<select class="exp-tx-picker" data-tx="…">` → `onExpTxCategoryChange` → `/api/finance-expenses-set-category`
  - editable alleen bij `canExpensesEdit`

---

## Finance > Bank (view-bank) — LEGACY (e-Boekhouden mirror)

Container: `#view-bank` (r4838). Lazy-init `_bankLoadedOnce` (r6947). Zelfde permission-gates als CAMT-bank. Nav-knop `#navBank` is niet meer in `#financeNav` — sinds herstructurering renders alleen `#navCamtBank`. Deze view blijft dormant reachable via deep-link `?tab=bank`.

### Access-banner

- [ ] r4839 — `#bankLocked` — "Geen toegang tot bankoverzicht"

### Sync-banner

- [ ] r4845 — `<details id="bankSyncBanner">` — "Sync e-Boekhouden → DB"
- [ ] r4846 — `#bankSyncSummary` / `#bankSyncText`

### Saldo-kaart (`.bank-balance-card`, r4855)

- [ ] r4858 — `#bankBalanceVal` — bedrag (renderer `loadBankBalance` r19335 → `/api/finance-bank-balance`)
- [ ] r4859 — `#bankBalanceMeta` — meta-tekst
- [ ] r4861 — `#bankBalanceRefresh` — icon-button (`i.ti-refresh`)

### Filter-strip (`#bankFilters`, r4864)

- [ ] r4865 — `#bankDirSeg` — segmented (default "Alle"):
  - [ ] pill "Alle" (`data-dir="all"`)
  - [ ] pill "Inkomend" (`data-dir="in"`)
  - [ ] pill "Uitgaand" (`data-dir="out"`)
- [ ] r4870 — `#bankFrom` — input `type="date"` "Vanaf datum"
- [ ] r4871 — `#bankTo` — input `type="date"` "T/m datum"
- [ ] r4872 — `#bankSearch` — input `type="search"` "Zoek op omschrijving, IBAN, factuurnr…" (350ms debounce)
- [ ] r4874 — `#bankRefresh` — icon-button (`i.ti-refresh`)

### Bank-tabel (`#bankTable`, r4878) — KOLOMMEN

Tbody = `#bankTbody`. Row-click → `openBankTxModal(idx)` (via gedeelde `bankTxModal`).

- [ ] r4880 — **KOL 1** — "Datum" (transaction_date)
- [ ] r4881 — **KOL 2** — "Omschrijving" (truncated 80)
- [ ] r4882 — **KOL 3** — "Tegenpartij" (counterparty_name)
- [ ] r4883 — **KOL 4** — "IBAN" (monospace)
- [ ] r4884 — **KOL 5** — "Factuur" (blue tag invoice_number)
- [ ] r4885 — **KOL 6** — "Bedrag" (num, kleur + sign)

### Pager (`#bankPager`, r4890)

- [ ] `#bankPrev` — icon-button
- [ ] `#bankNext` — icon-button

---

## Finance > Roadmap (view-roadmap)

Container: `#view-roadmap` (r5475). Mount-target `#view-roadmap-host` (r5476). Rendering + interactieve elementen worden geleverd door externe module `/modules/shared/finance-views/roadmap.js` — buiten scope van dit bestand.

- [ ] r5476 — `<div id="view-roadmap-host">` — mount-target voor `FinanceViewRoadmap.mount({host})` (r6942)
  - zichtbaarheid: publiek

---

## Finance > Instellingen (view-instellingen)

Container: `#view-instellingen` (r5484). Leeg host-element; mount via `mountFinanceInstellingenHost(host)` → `window.FinanceInstellingen.mount({host})` (r6975). Content wordt geleverd door `/modules/shared/finance-instellingen.js`.

- [ ] r5484 — `<div id="view-instellingen">` — mount-target voor externe module
  - zichtbaarheid: hidden default; nav-knop is verwijderd (comment r4282). Deep-link `?tab=instellingen` valt sinds Agent center-migratie terug op dashboard (r20999).

---

## Cross-cutting elementen (in scope, niet aan één view gebonden)

### `#noAccess` (r6764)

- [ ] r6764 — `<div id="noAccess">` — "Geen toegang" full-page fallback (getoond bij ontbreken `finance.module.access`, r6789)
- [ ] r6767 — link "Terug naar dashboard" → `/index.html`

### `#sidebar-mount` (r4268)

- [ ] r4268 — mount-target voor sidebar-module (`/modules/shared/sidebar.js`, r6798) — inhoud extern

### Toast + user section

- Wordt geladen via `agent-shared.js` (`window.AgentShared.showToast`, `renderUserSection`). Geen expliciete UI-elementen in `finance.html`.

---

## Notes voor herbouw

- **Permission-gates op nav-knoppen zijn UI-only** — server-side gates (via `/api/finance-*`-endpoints) blijven autoritatief. UI verbergt knoppen bij ontbreken van perms via `style.display='none'` (r20920, r20933).
- **Deep-linkable tabs**: `dashboard` / `facturen` / `klanten` / `camtbank` / `uitgaven` / `bank` / `roadmap`. Legacy `bank` / `uitgaven` blijven werken via `?tab=bank|uitgaven`.
- **Lazy-init pattern**: view-content laadt pas bij eerste view-open via one-shot guards (`_bankLoadedOnce`, `_camtBankLoadedOnce`, `_expensesInited`, `_cnInited`). Bij herbouw dit patroon behouden om initial page-load snel te houden.
- **Modal-close pattern**: alle modals sluiten via (a) close-`×`-knop / -"Annuleren", (b) click-outside op overlay, (c) Escape-toets (r21063).
- **Menu-positionering**: 3-dots kebab (`.sr-menu-toggle`) gebruikt `initMenus()` — `position:fixed` + `getBoundingClientRect` + flip-up + close-on-scroll (r19186-r19204).
- **Sync-banners**: `#invSyncBanner` (Facturen) en `#bankSyncBanner` (legacy Bank) laden `/api/finance-sync-status` lazy en tonen laatste run-tijd + processed/errors.

<!-- END finance-A.md -->

---

## 4. Finance — Wanbetalers deel 1

**Bron**: `modules/finance.html` r11500-22000 — Gesprekken (inbox) + Dunning-subnav (Overzicht/Probleemklanten/Workflows/Templates/Geschiedenis) + Arrangements + Instellingen-hub-header.

<!-- BEGIN finance-B-wanbetalers-1.md -->

# Finance > Wanbetalers — inventaris deel 1 (r11500–r22000)

> Scope: interactieve UI-elementen die binnen `modules/finance.html` regels 11500–22000 gedefinieerd of gewired worden. Voor de HTML-markup van sub-view containers en Inbox-thread-header verwijzen we naar de referentie-regels buiten die range (met explicit prefix `[HTML r####]`) omdat de wiring binnen scope naar die id's grijpt.
>
> Volgende agent pakt: Joost admin/config panel, Brieven-inline handlers, Dashboard-KPI klik-through targets, Aanmaanronde / Verzenden-flow (`mountFacturenHost`, `mountOpruimenHost`, `mountSandboxHost`), plus `#view-inbox` no-reply-banner + threadOpen/thread-more handlers vanaf r22000.

---

## Finance > Wanbetalers > Sub-nav (top level)

- [ ] r4304 — Container `#wanbetalersSubNav` (delegated click-handler r7020 `setSubView`)
- [ ] r4313 — "Gesprekken" (`.active`) — `data-wb-sub="inbox"` → `setSubView('inbox')`
  - zichtbaarheid: default active
- [ ] r4318 — "Acties" — `data-wb-sub="openacties-nieuw"` → `mountActiesWerkcentrumHost` (buiten scope; door volgende agent)
- [ ] r4322 — "Overzicht" — `data-wb-sub="overzicht-nieuw"` → `mountOverzichtNieuwHost` (buiten scope)
- [ ] r4325 — "Instellingen" — `data-wb-sub="instellingen"` → `mountInstellingenHubHost` (in scope, r21667)
- [ ] r4328 — "Te doen" — `data-wb-sub="te-doen"` — **hidden default** (deep-link `?sub=te-doen`) — `mountTeDoenHost`
- [ ] r4329 — "Acties" (oude) — `data-wb-sub="open-acties"` — **hidden default** + `<span id="wbxNavActiesBadge">` badge — `mountFinanceTasksHost`
- [ ] r4330 — "Facturen" — `data-wb-sub="facturen"` — **hidden default** — `mountFacturenHost`
- [ ] r4331 — "Opruimen" — `data-wb-sub="opruimen"` — **hidden default** — `mountOpruimenHost`
- [ ] r4332 — "Afspraken" — `data-wb-sub="arrangements"` — **hidden default** → `activateDunningSub('arrangements')` (in scope)
- [ ] r4333 — "Pipeline" — `data-wb-sub="pipeline"` — **hidden default** — `mountDunPipelineHost`
- [ ] r4339 — "Verversen" — `#tdRefreshBtn` — inline-flex alleen bij `sub==='te-doen'` — click handler r7055 (extern gewired in te-doen-shell)
  - zichtbaarheid: `display:none` default, sub-specifiek

**Deep-link params (r20988–r20997)**: `?tab=wanbetalers&sub=<sub>` en `?conversation=<uuid>` → impliciet `sub=inbox`.

---

## Finance > Wanbetalers > Gesprekken (view-inbox) — Gesprekkenlijst (linker kolom)

Container `#view-inbox` (r4895) · lazy `ensureInboxLoaded` bij eerste sub-open.

### Filter-strip + status-tabs
- [ ] [HTML r4909] `#inboxConvSearch` — text input, placeholder "Zoeken op naam of nummer…" — wired r17949 `input` (300 ms debounce) → `loadInboxConvList()`
- [ ] [HTML r4910] `#inboxConvRefresh` — sr-ibtn (`ti-refresh`) — wired r17961 → `loadInboxConvList()`
- [ ] [HTML r4912] `#inboxFiltersToggle` — icon-only (`ti-adjustments`) met `#inboxFiltersBadge` — wired r13855 → toggle popover `#inboxFiltersPopover`
- [ ] [HTML r4916] Popover `#inboxFiltersPopover` — bevat 4 checkboxes:
  - [ ] r4918 `#inboxFilterUnread` "Ongelezen" → `_inboxUiState.onlyUnread` (r13848)
  - [ ] r4919 `#inboxFilterDebtor` "Wanbetalers" → `_inboxUiState.onlyDebtor` (r13849)
  - [ ] r4920 `#inboxFilterLinked` "Gekoppeld" → `_inboxUiState.onlyLinked` (r13850)
  - [ ] r4921 `#inboxFilterUnlinked` "Niet-gekoppeld" → `_inboxUiState.onlyUnlinked` (r13851)
  - [ ] r4923 `<select id="inboxSortSelect">` — opties: `default` (Ongelezen eerst), `latest` (Nieuwste bericht), `amount` (Hoogste openstaand), `unread_only` (Alleen ongelezen) — wired r13852 → `_inboxUiState.sortMode`
- [ ] [HTML r4935] Status-tabs `#inboxConvStatusTabs` — 4 knoppen, wired r13815:
  - [ ] r4936 "Actief" `data-conv-status="active"` (default active)
  - [ ] r4937 "Afgehandeld" `data-conv-status="afgehandeld"`
  - [ ] r4938 Archief-icon `data-conv-status="archief"` (`ti-archive`)
  - [ ] r4939 "Alles" `data-conv-status="all"`

### Conversatielijst
- [ ] [HTML r4942] `#inboxConvList` — scroll-container, klikbare rijen gerenderd r13785 (`data-conv-id`) → `openInboxConv(convId)` r14298
  - Rij bevat: avatar (`.inbox-conv-avatar`, hash-color), naam+status-icon (closed/archived), tijd, preview, unread-badge (`.inbox-conv-unread` = WA + mail totaal), autonomy-badge (Joost r15586)
  - Scroll-listener r14031 → `loadInboxConvListMore()` (dead-code sinds refactor 2026-08-04 cap 1000)

---

## Finance > Wanbetalers > Gesprekken (view-inbox) — Thread-header (5-knops strip + ⋮)

Container `#inboxThread` (r4957) — zichtbaar zodra actieve conv gekozen.

### Header-info + avatar
- [ ] [HTML r4963] `#inboxBackToListBtn` — sr-ibtn `ti-arrow-left` — **mobiel-only** (CSS-verborgen op desktop) — wired r17854 → `document.body.classList.remove('inbox-thread-open')`
- [ ] [HTML r4964] `#inboxThreadAvatar` — initialen-cirkel (hash-color)
- [ ] [HTML r4966] `#inboxThreadName` — bevat gerenderde `<button id="inboxThreadCustomerLink">` (r14330) → wired r18159 delegated click → `openInboxCustomerModal()`
- [ ] [HTML r4967] `#inboxThreadPhone`
- [ ] [HTML r4970] `#inboxThreadWindowBadge` — `.open` / `.expired` — 24h-tag, tooltip = laatste inbound

### Header-actie-strip (5 knoppen + ⋮ menu)
- [ ] [HTML r4975] `#inboxThreadResolveBtn` — sr-ibtn `ti-check` (groen) — "Gesprek afhandelen" — **hidden** tenzij `conv.status==='open'` — wired r17818 → `_inboxSetConvStatus(conv, 'afgehandeld')`
- [ ] [HTML r4976] `#inboxThreadOpenActionBtn` — sr-ibtn `ti-plus` (cyaan) — "Actie maken vanuit dit gesprek" — wired r30753 (buiten scope; volgende agent)
- [ ] [HTML r4977] `#inboxThreadCustomerBtn` — sr-ibtn `ti-user` — "Klant-info" — wired r18140 → `openInboxCustomerModal()` r16032
- [ ] [HTML r4980] `#inboxThreadMoreBtn` — sr-ibtn `ti-dots-vertical` — `aria-haspopup="menu"` — opent `#inboxThreadMoreMenu` (r30778 buiten scope)

### ⋮-Menu items (`#inboxThreadMoreMenu` — hidden default)
- [ ] [HTML r4982] `#inboxThreadArchiveBtn` — `ti-archive` "Archiveren" — **hidden** tenzij `status!=='archived'` — wired r17824 → confirm() + `_inboxSetConvStatus('gearchiveerd')`
- [ ] [HTML r4983] `#inboxThreadReopenBtn` — `ti-refresh` "Heropenen" — **hidden** tenzij `status==='closed'` — wired r17821 → `_inboxSetConvStatus('open')`
- [ ] [HTML r4984] `#inboxThreadUnarchiveBtn` — `ti-archive-off` "Uit archief halen" — **hidden** tenzij `status==='archived'` — wired r17829 → `_inboxSetConvStatus('open')`
- [ ] [HTML r4985] `#inboxThreadMarkReadBtn` — `ti-mail-check` "Markeer gelezen" — wired r17863 → parallel POST `/api/inbox-mark-read` + `/api/inbox-email-mark-read`
- [ ] [HTML r4986] `#inboxThreadMarkUnreadBtn` — `ti-mail` "Markeer ongelezen" — wired r17923 → POST `/api/inbox-mark-unread`
- [ ] [HTML r4987] `#inboxThreadDossierBtn` — `ti-layout-sidebar-right-expand` "Dossier openen" — **disabled** tenzij matched customer — wired r18146 → `window.AgentShared.openCustomerDossier(customerId)`
- [ ] [HTML r4991] `#inboxThreadSendLetterBtn` — `ti-mail-forward` "Stuur een brief" — wired r30757 (buiten scope)
- [ ] [HTML r4992] `#inboxThreadPauseBtn` — `ti-player-pause` "Pauzeer aanmaan-flow" — wired r30750 (buiten scope)

### No-reply banner + autonomy strip
- [ ] [HTML r5003] `#inboxNoReplyBanner` — hidden default — populated door externe fn (r30652 buiten scope) uit `dunning_workflow_runs`
- [ ] [HTML r5010] `.joost-autonomy-strip #inboxJoostAutonomyStrip` — hidden tot `loadJoostConvState()` autonomy_enabled bevestigt (r15620–15664):
  - [ ] r5011 `#inboxJoostAutonomyStatus` + `#inboxJoostAutonomyStatusLabel` — "Joost: actief" / "Joost: gepauzeerd — <reden>"
  - [ ] r5012 `#inboxJoostAutonomyCounter` — "Berichten vandaag: X/Y"
  - [ ] r5014 `#inboxJoostAutonomyPauseBtn` — `ti-player-pause` "Pauzeer Joost" — wired r18222 → `openJoostPauseModal()` r15668
  - [ ] r5015 `#inboxJoostAutonomyResumeBtn` — `ti-player-play` "Hervat Joost" — wired r18225 → `resumeJoost()` r15754

---

## Finance > Wanbetalers > Gesprekken (view-inbox) — Compose-strip

Container `.inbox-c-compose` (r5024) — onder de messages-container.

### Bijlage-preview (`#inboxAttachPreview`, hidden default)
- [ ] [HTML r5032] Preview-strook: icon, filename, size, upload-status
- [ ] [HTML r5039] `#inboxAttachClearBtn` — sr-ibtn `ti-x` — wired r17980 → `_inboxAttachClear()` r14585

### Textarea
- [ ] [HTML r5045] `#inboxComposeTextarea` — hoofdinput (disabled default) — wired r18123 `keydown`: Ctrl/Cmd+Enter → `sendInboxText()`; `input` → `autoResizeComposeTextarea()` (r14504)
  - state via `_inboxApplyComposeState()` r14513: disabled / placeholder aan/uit op basis van `_inboxConvCanSendText` (24h window)

### Actie-rij links (pickers)
- [ ] [HTML r5058] `#inboxAttachInput` — `<input type="file">` verborgen, accept image/pdf/office/video — wired r17976 → `_inboxAttachOnFilePicked()` r14601 → `/api/whatsapp-media-upload`
- [ ] [HTML r5059] `#inboxAttachBtn` — sr-abtn `ti-paperclip` "Bijlage" — disabled default — wired r17975 → triggert `#inboxAttachInput.click()`
- [ ] [HTML r5060] `#inboxTplBtn` — sr-abtn `ti-template` "Template" — disabled default — wired r17984 → `openInboxTplPicker()` r17189
  - modal: `#inboxTplPickerModal` (2-step wizard, buiten scope voor markup — wiring r17989+)
- [ ] [HTML r5061] `#inboxQrBtn` — sr-abtn primary `ti-message-bolt` "Snel antwoord" — disabled default — wired r17987 → `openInboxQrPicker()` r17744
  - modal: `#inboxQrPickerModal` (wiring r18042+)
- [ ] [HTML r5066] `#inboxJoostBtn` — sr-abtn `ti-sparkles` (paars) "Vraag Joost" — disabled + hidden default (`_joostInit` r15510 zichtbaar bij `finance.joost.use`) — wired r15519 → `openInboxJoostModal()` r15467
  - visuele indicator via `data-joost-has-recent="true"` (groene pulserende dot) — `_joostUpdateButtonBadge()` r14819
  - rol: rol:finance.joost.use

### Actie-rij "meer" wrap (`#inboxMoreActionsWrap`, hidden default)
- [ ] [HTML r5077] Wrapper — `display:none` tenzij matched customer (fase 4 blok 1, buiten scope)
- [ ] [HTML r5078] `#inboxMoreActionsBtn` — sr-abtn `ti-dots-vertical` — wired r30675+ (buiten scope)
- [ ] [HTML r5080] `#inboxFollowupBtn` — `ti-phone-plus` "Bel-taak" — wired r30743
- [ ] [HTML r5081] `#inboxArrangementBtn` — `ti-notes` "Regeling" — wired r30745
- [ ] [HTML r5082] `#inboxPauseDunningBtn` — `ti-player-pause` "Pauzeer flow" — wired r30747

### Actie-rij rechts
- [ ] [HTML r5087] `#inboxComposeWindowHint` — visuele tag "24h open" / "24h verlopen" — hidden default
- [ ] [HTML r5088] `#inboxComposeSendBtn` — sr-abtn primary `ti-send` "Verstuur" — disabled default — wired r17966 → `sendInboxText()` r14666
  - flow: text-send default; media-send-path als `_inboxAttachState` gezet
  - 422 op `24h_window_expired` → auto-sync UI naar verlopen-state
  - hook: `_maybeMarkJoostOutcomeAfterSend(sentText)` (USED_EDITED bij `_joostEditMode`)

---

## Finance > Wanbetalers > Gesprekken > Klant-info modal (`#inboxCustomerModal`, r6260)

Opent via `#inboxThreadCustomerBtn` of `#inboxThreadCustomerLink`. State-machine `renderInboxCustomerPanel(state, data)` r16538 met states: empty / matched / unknown.

### Header
- [ ] [HTML r6177] `#inboxCustPanelAvatar`
- [ ] [HTML r6179] `#inboxCustPanelName`, [HTML r6180] `#inboxCustPanelPhone`
- [ ] [HTML r6182] `#inboxCustPanelWindow` — 24h badge (`.open` / `.expired`)

### Actie-strip (top)
- [ ] [HTML r6189] `#inboxCustPanelCallBtn` — "Bel nu" (`ti-phone`) — disabled zonder telefoon — wired r17838 → `_inboxOpenCallSheet(phone, displayName)` r16429
  - opent DOM-modal `#inboxCallSheet` met `#inboxCallLineSel` (Auto/NL/BE), `#inboxCallNumberInput`, `#inboxCallDialBtn` "Bel nu" (r16467)

### Openstaand-strip (`#inboxCustPanelOpenStrip`, hidden bij 0 open)
- [ ] `#inboxCustPanelOpenStripAmount`, `#inboxCustPanelOpenStripCount`, `#inboxCustPanelOpenStripOverdue`

### Sectie: open facturen (`#inboxCustPanelInvoices` — geen row-acties, alleen display)

### Sectie: actieve abonnementen (`#inboxCustPanelSubs` + `#inboxCustPanelSubsSection` hidden bij 0)

### Sectie: klant-info (`#inboxCustPanelInfoSection`)
- [ ] `#inboxCustPanelSince`, `#inboxCustPanelEmailRow`+`#inboxCustPanelEmail`

### Sectie: acties (`.incm-actions-row`)
- [ ] [HTML r6245] `#inboxCustPanelOpen` — `<a>` — matched: link naar `/modules/klanten.html?id=` / unknown: opens `openInboxLinkModal()` r16087
- [ ] [HTML r6246] `#inboxCustPanelInvoice` — `<a>` — link naar `/modules/klanten.html?id=X&tab=facturen`
- [ ] [HTML r6247] `#inboxClaimPaidBtn` — sr-abtn secondary `ti-cash-check` "Klant claimt betaald" — disabled tenzij matched + >=1 open — wired r21027 → `openClaimPaidModal()` r18605
  - modal: `#claimPaidModal` (submit r18664 → POST `/api/tasks-create-verify-payment`)
- [ ] [HTML r6248] `#inboxToezeggingBtn` — sr-abtn secondary `ti-calendar-check` "Leg afspraak vast" — disabled tenzij matched + >=1 open — wired r16800 (`onclick`) → `openToezeggingModal({customerId, customerName, openInvoices, ...})` (buiten scope)
- [ ] [HTML r6249] `#inboxEscalateBtn` — sr-abtn secondary `ti-alert-triangle` "Escaleren" — disabled tenzij matched — wired r16781 (`onclick`) → `openEscalationModal({manual:true})` r15128

### Close-paden
- [ ] `#inboxCustomerClose`, `#inboxCustomerCloseBtn` (r6257), backdrop-click, Escape (wired r18167+)

---

## Finance > Wanbetalers > Gesprekken > Link-klant modal (`#inboxLinkCustomerModal`)

Opent uit unknown-state `openLnk.onclick` (r16842). Wired r18075+.

- [ ] `#inboxLinkPhone` — leest van conv (readonly)
- [ ] `#inboxLinkSearch` — input, debounce 300ms → `searchInboxCustomers(query)` r16125 (endpoint `/api/inbox-customer-search`)
- [ ] `#inboxLinkResults` — `<ul>` — delegated click op `[data-link-select]` of `[data-link-idx]` → `selectInboxLinkCustomer(item)` r16179
- [ ] `#inboxLinkSelectedRow` + `#inboxLinkSelectedName` — hidden default
- [ ] `#inboxLinkAddPhone` — checkbox "Voeg phone toe" — default check indien klant zonder telefoon
- [ ] `#inboxLinkSubmitBtn` — "Koppel" — wired → `submitInboxLink()` r16213 → POST `/api/inbox-link-conversation-to-customer`
- [ ] `#inboxLinkCloseX`, `#inboxLinkCancelBtn`, backdrop, Escape (r18117)

---

## Finance > Wanbetalers > Gesprekken > Template-picker modal (`#inboxTplPickerModal`)

Opent uit `#inboxTplBtn`. 2-step wizard (`_inboxTplShowStep()` r17178). Wired r17989+.

### Stap 1 — Template-lijst
- [ ] `#inboxTplSearchInput` — filter (`input` → `_inboxTplRenderList()`)
- [ ] `#inboxTplListUl` — gegroepeerd per folder (r17131) — click op `<li data-tpl-idx>` → `selectInboxTpl(tpl)` r17344

### Stap 2 — Template-detail + preview
- [ ] `#inboxTplStep2Name`, `#inboxTplStep2Meta`, `#inboxTplStep2Body` — display
- [ ] `#inboxTplVarsForm` — dynamische inputs voor legacy positionele `{{N}}`-vars (data-tpl-var)
- [ ] `#inboxTplInvoiceWrap` + `#inboxTplInvoiceSelect` — invoice-selector (voor named `factuur.*` templates) — wired r18026 → re-render preview
- [ ] `#inboxTplResolvedWrap` + `#inboxTplResolvedList` — read-only lijst auto-resolved values
- [ ] `#inboxTplMediaWrap` + `#inboxTplMediaInput` (file), `#inboxTplMediaClearBtn`, `#inboxTplMediaStatus`, `#inboxTplMediaKindLabel` — Fase A media-picker voor IMAGE/VIDEO/DOCUMENT headers, wired in `_inboxTplConfigureMediaPicker()` r17457
- [ ] `#inboxTplPreviewBubble` — live-render van body met substitutie
- [ ] `#inboxTplError` — error-banner

### Modal-acties
- [ ] `#inboxTplCloseX` → `closeInboxTplPicker()`
- [ ] `#inboxTplCancelBtn`
- [ ] `#inboxTplBackBtn` — hidden op stap 1 — reset naar stap 1 (r17998)
- [ ] `#inboxTplSendBtn` — "Verstuur" (hidden op stap 1) — wired r18013 → `sendInboxTpl()` r17618 → POST `/api/inbox-send-template`

Backdrop + Escape: r18020, r18034.

---

## Finance > Wanbetalers > Gesprekken > Quick-reply modal (`#inboxQrPickerModal`)

Opent uit `#inboxQrBtn`. Wired r18041+.

- [ ] `#inboxQrList` — `<ul>` — delegated click op `[data-qr-select]` → `selectInboxQr(item)` r17781
- [ ] `#inboxQrError`
- [ ] `#inboxQrCloseX`, `#inboxQrCancelBtn`, backdrop, Escape (r18069)

---

## Finance > Wanbetalers > Gesprekken > Joost AI modal (`#inboxJoostModal`)

Opent uit `#inboxJoostBtn`. Wired r18204+. Body render via `_joostRenderCard(sugg)` r14871 in `#joostResults`.

### Suggestion-card acties
- [ ] `#joostReplyText` — textarea (editable) — pre-filled met `suggestion.suggested_reply`
- [ ] `#joostIgnore` — sr-abtn `ti-x` "Negeer" — wired r14969 → `applyJoostIgnore()` r15440 → `_joostMarkOutcome('IGNORED')`
- [ ] `#joostEditSend` — sr-abtn `ti-edit` "Bewerk + verstuur" — wired r14967 → `applyJoostEdit()` r15423 (copiëert naar compose textarea + `_joostEditMode=true`)
- [ ] `#joostUseAsIs` — sr-abtn primary `ti-send` "Verstuur als-is" — wired r14965 → `applyJoostUseAsIs()` r15399 → mark USED_AS_IS + `sendInboxText()`
- [ ] `#joostIntentAction` — contextuele knop (intent-specific) — wired r14992:
  - `verify_payment` → `handleJoostVerifyPayment(snapshot)` r15016 → POST `/api/joost-create-task-from-suggestion`
  - `arrangement_request` → `handleJoostArrangementRequest(snapshot)` r15064 → `openArrangPropose(...)`
  - `escalation_needed` → `handleJoostEscalation(snapshot)` r15108 → `openEscalationModal({suggestion})`

### Herschrijf-op-instructie
- [ ] `#joostReviseInstruction` — text input — Enter zonder Shift triggert revise (r14979)
- [ ] `#joostReviseBtn` — sr-abtn `ti-sparkles` "Pas aan" — wired r14977 → `_joostRevise()` r15327 → POST `/api/joost-suggest-revise`
- [ ] `#joostReviseStatus` — status-tekst

### Empty state
- [ ] `#inboxJoostModalAskBtn` — sr-abtn primary `ti-wand` "Vraag Joost om suggestie" — wired r15493 → `requestJoostSuggestion()` r15244 → POST `/api/joost-suggest`

### Modal-close
- [ ] `#inboxJoostModalCloseX`, `#inboxJoostModalCloseBtn`, backdrop, Escape (r18215)

---

## Finance > Wanbetalers > Gesprekken > Joost escalation-modal (`#joostEscalationModal`, r6263)

Opent uit intent-knop (`handleJoostEscalation`) of manual (uit `#inboxEscalateBtn`). Wired r18184+.

- [ ] `#joostEscReason` — textarea, min 10 chars — pre-filled met suggestion.reasoning bij Joost-pad
- [ ] `#joostEscSeverity` — `<select>` — opties: Laag / Medium / Hoog (default medium)
- [ ] `#joostEscError`
- [ ] `#joostEscSubmit` — wired r18191 → `submitEscalationModal()` r15163 → POST `/api/tasks-create-escalation`
- [ ] `#joostEscCloseX`, `#joostEscCancel`, backdrop, Escape (r18197)

---

## Finance > Wanbetalers > Gesprekken > Joost pauze-modal (`#joostPauseModal`)

Opent uit `#inboxJoostAutonomyPauseBtn`. Wired r18227+.

- [ ] `#joostPauseReason` — textarea
- [ ] `#joostPauseDuration` — `<select>` — opties: 24h / 48h (default) / 7d / manual
- [ ] `#joostPauseError`
- [ ] `#joostPauseSubmit` — wired r18233 → `submitJoostPause()` r15703 → PATCH `/api/joost-conversation-state`
- [ ] `#joostPauseCloseX`, `#joostPauseCancel`, backdrop, Escape (r18239)

---

## Finance > Wanbetalers > Gesprekken > Klant-claimt-betaald modal (`#claimPaidModal`)

Opent uit `#inboxClaimPaidBtn`. Wired r21027+.

- [ ] `#claimPaidSub` — subtitle (klant + phone)
- [ ] `#claimPaidInvoiceSelect` — factuur-dropdown (default: oudste) — wired r18654 (change → amount-sync)
- [ ] `#claimPaidAmount` — number input (default: `amount_open` van geselecteerde factuur)
- [ ] `#claimPaidText` — textarea — pre-filled met laatste inbound message body
- [ ] `#claimPaidErr`
- [ ] `#claimPaidSubmit` — wired → `submitClaimPaid()` r18664 → POST `/api/tasks-create-verify-payment`
- [ ] `#claimPaidCancel`, backdrop, Escape (r21063)

---

## Finance > Wanbetalers > Wanbetalers-view (view-dunning) — Dunning-subnav (verborgen wrapper)

Container `#dunningSubNav` (HTML r5109) — **`display:none` gezet in setSubView** (r7108). De 6 sub-panels blijven bereikbaar via de wanbetalers-subs `overzicht`, `probleemklanten`, `workflows`, `templates`, `geschiedenis`, `arrangements` die via `activateDunningSub()` de verborgen knop-klik simuleren.

- [ ] [HTML r5110] `data-dunning-sub="overzicht"` (default active)
- [ ] [HTML r5111] `data-dunning-sub="probleemklanten"`
- [ ] [HTML r5112] `data-dunning-sub="workflows"`
- [ ] [HTML r5113] `data-dunning-sub="templates"`
- [ ] [HTML r5114] `data-dunning-sub="geschiedenis"`
- [ ] [HTML r5115] `data-dunning-sub="arrangements"` (`data-view="arrangements"`) "Afspraken"

Wired r9108 delegated click.

---

## Finance > Wanbetalers > Overzicht (dunningSubOverzicht) — deep-link/legacy

Container [HTML r5119]. Sub-key `overzicht` (fallback in setSubView r7212).

### KPI-strip (5 cards, `#dunOvKpis` r5121)
- [ ] "Openstaand" (KPI-val)
- [ ] "Wanbetalers"
- [ ] "Probleemklanten"
- [ ] "Actieve workflows"
- [ ] "Voltooid (30d)"

### Actieve workflows panel
- [ ] [HTML r5136] `#dunOvRefreshBtn` — "Vernieuw" (`ti-refresh`) — click → `loadDunOverview()` (buiten scope: r8500-9099)
- [ ] Tabel `#dunOvActiveTable` / `<tbody id="dunOvActiveTbody">` — **kolommen**: Klant · Workflow · Huidige stap · Volgende actie · Acties (240px)
  - row-actie: opens `openDunRunDetailsModal(runId)` r11516

### Recente acties panel
- [ ] Tabel `#dunOvRecentTable` / `<tbody id="dunOvRecentTbody">` — **kolommen**: Tijd (140px) · Klant · Event (160px) · Stap (120px) · Details
  - row-klik → detail (in `renderDunRunDetailsEvents` r11655)

### Run-details modal (`#dunRunDetailsModal`, HTML r5488)
Wired `wireDunRunDetailsModal()` r11503.
- [ ] `#dunRunDetailsClose`, `#dunRunDetailsCloseBtn` — close
- [ ] `#dunRunDetailsPauseBtn` — click → `runDetailsAction('pause')` r11682 — POST `/api/finance-dunning-run-control` — **hidden** tenzij status='active'
- [ ] `#dunRunDetailsResumeBtn` — action='resume' — **hidden** tenzij status='paused'
- [ ] `#dunRunDetailsCancelBtn` — action='cancel' (confirm()) — **hidden** tenzij active/paused
- [ ] `#dunRunDetailsSteps`, `#dunRunDetailsEvents`, `#dunRunDetailsStatus`, `#dunRunDetailsError` — display

---

## Finance > Wanbetalers > Probleemklanten (dunningSubProbleemklanten) — via activateDunningSub

Container [HTML r5176]. Sub-key `probleemklanten` (setSubView r7130).

### Header-acties
- [ ] [HTML r5183] `#dunBulkOpenBtn` — sr-abtn primary `ti-send` "Bulk aanmanen (`<span id="dunBulkCount">`)" — disabled tot ≥1 checkbox aangevinkt — wired in `_wireDunBulkOnce` (buiten scope)
- [ ] [HTML r5186] `#dunBriefOpenBtn` — sr-abtn `ti-file-text` "Brieven genereren" — disabled default — wired in externe brief-modal (buiten scope)
- [ ] [HTML r5189] `#dunProbRefreshBtn` — sr-abtn `ti-refresh` "Vernieuw"

### Filter-strip (`#dunProbFilters`, HTML r5195)
- [ ] `#dunProbSearch` — text-input search
- [ ] `#dunProbDaysBucket` — `<select>` — opties: (Alle) / 0-30 / 30-60 / 60+
- [ ] `#dunProbAmountBucket` — `<select>` — opties: (Alle) / >€100 / >€500 / >€1000
- [ ] `#dunProbWorkflowFilter` — `<select>` — opties: (Alle) / with (Met actieve workflow) / without (Zonder workflow)
- [ ] `#dunProbFiltersReset` — sr-abtn "Reset"
- [ ] `#dunProbFilterInfo` — info-tekst (rechts)

### Tabel (`#dunProbTable`, `<tbody id="dunProbTbody">`)
- **KOLOMMEN** (r5219–5228):
  - [ ] col1 [HTML r5220] `#dunProbSelectAll` (checkbox — "Selecteer alles (gefilterde set)")
  - [ ] col2 `data-sort-key="name"` — Klant (met sort-arrow)
  - [ ] col3 `data-sort-key="open_invoice_count"` — Facturen (80px)
  - [ ] col4 `data-sort-key="total_open_amount"` — Openstaand (120px)
  - [ ] col5 `data-sort-key="oldest_due_date"` — Vervaldatum (110px)
  - [ ] col6 `data-sort-key="days_overdue_oldest"` — Dagen (88px)
  - [ ] col7 — Workflow (90px, geen sort)
  - [ ] col8 — Acties (210px, row-buttons uit externe render)

**Bulk-actie**: aangevinkte rijen (`data-prob-select`) → `#dunBulkOpenBtn` triggert `openDunningBulkModal` (buiten scope).

---

## Finance > Wanbetalers > Workflows (dunningSubWorkflows) — via activateDunningSub

Container [HTML r5235]. Sub-key `workflows`.

### Cooldown-instellingen (`#dunSettingsBar`, HTML r5237)
- [ ] `#dunCooldownInput` — number 1-90 dagen (default 7)
- [ ] `#dunCooldownSaveBtn` — sr-abtn primary `ti-device-floppy` "Opslaan" — disabled tot wijziging
- [ ] `#dunCooldownFeedback` — status-tekst

### Master-detail layout (`.dunwf-outer`)
**Links: lijst (r5251)**
- [ ] `#dunWfNewBtn` — sr-abtn primary `ti-plus` "Nieuw"
- [ ] `#dunWfList` — workflow-lijst (row-klik → editor)

**Rechts: editor (`#dunWfEditor`, r5261)**
- [ ] `#dunWfEmpty` — placeholder tot selectie
- [ ] `#dunWfBackBtn` — `ti-arrow-left` "Terug naar lijst" — **mobiel-only** (via `.dunwf-detail-open` class)
- [ ] `#dunWfName` — text input, workflow-naam (maxlength 200)
- [ ] `#dunWfActive` — checkbox "Actief"
- [ ] `#dunWfDeleteBtn` — sr-abtn danger `ti-trash` "Verwijder" — hidden default
- [ ] `#dunWfDescription` — textarea (optioneel)
- [ ] `#dunWfPriority` — number (0-1000, default 100)

**Trigger-condities panel (r5288–5320)**:
- [ ] `#dunWfTrgMinDays` — number (default 14)
- [ ] `#dunWfTrgCustomerType` — `<select>` — opties: any/b2c/b2b
- [ ] `#dunWfTrgMinAmount` — number (EUR, default 0)
- [ ] `#dunWfTrgMinDaysSinceInvoice` — number (optioneel, dag-N-duwtje)
- [ ] `#dunWfTrgRunOnce` — checkbox "Max 1× per klant (ooit)"
- [ ] `#dunWfTrgArrangementBreached` — checkbox "Vuur bij verbroken betaalafspraak"

**Stappen-editor (r5321)**:
- [ ] `#dunWfAddStepBtn` — sr-abtn `ti-plus` "Stap toevoegen"
- [ ] `#dunWfSteps` — dynamische lijst (step-type / config / verwijder — gerenderd door externe fn, buiten scope)

**Footer**:
- [ ] `#dunWfError` — error-banner (hidden default)
- [ ] `#dunWfCancel` — sr-abtn "Annuleer"
- [ ] `#dunWfSave` — sr-abtn primary "Opslaan"

Wire-functies: `wireDunWfEditor`, `wireDunWfList` (buiten scope, r9500+).

---

## Finance > Wanbetalers > Templates (dunningSubTemplates)

Container [HTML r5341]. Sub-key `templates`.

- [ ] [HTML r5347] `#dunTplNewBtn` — sr-abtn primary `ti-plus` "Nieuwe template" — opens modal (buiten scope)
- [ ] Tabel `#dunTplTable` / `<tbody id="dunTplTbody">` — **KOLOMMEN**:
  - [ ] Naam
  - [ ] Type (100px) — kind ∈ {email, whatsapp, brief}
  - [ ] Taal (70px)
  - [ ] Actief (80px)
  - [ ] Acties (150px) — row-buttons (bewerk/verwijder — buiten scope)

**Template-modal**: 3 kinds (email / whatsapp / brief) — markup + wiring buiten scope (r5450+ modals bestaan later in het bestand).

---

## Finance > Wanbetalers > Geschiedenis (dunningSubGeschiedenis)

Container [HTML r5366]. Sub-key `geschiedenis`.

### Filter-strip (grid, r5374)
- [ ] `#dunHistSearch` — search input "Klantnaam…"
- [ ] `#dunHistEventType` — `<select>` — opties: (Alle) / started / email_attempted / email_skipped_no_infra / whatsapp_skipped_no_meta / wait / task_created / completed / paused / resumed / cancelled / run_control_pause / run_control_resume / run_control_cancel / stop_step
- [ ] `#dunHistFromDate` — date input "Vanaf datum"
- [ ] `#dunHistRefreshBtn` — sr-abtn `ti-refresh` "Vernieuw"

### Tabel (`#dunHistTable`, `<tbody id="dunHistTbody">`)
- **KOLOMMEN** (r5410–5416):
  - Tijd (140px)
  - Klant
  - Workflow
  - Event (170px)
  - Stap (120px)
  - Details

### Pager
- [ ] `#dunHistPagerInfo` — "N events geladen"
- [ ] `#dunHistMoreBtn` — sr-abtn `ti-chevron-down` "Meer laden" — hidden default

Load-functie: `loadDunHistory({reset:true})` — buiten scope; sub-key activatie triggert de wire.

---

## Finance > Wanbetalers > Afspraken / Arrangements (view-arrangements) — in scope

Container [HTML r5429] `#view-arrangements`. Sub-key `arrangements` in setSubView (r7113) roept `wireArrangOnce()` + `wireArrangProposeOnce()` + `loadArrangements()`.

### Header-acties (r5435)
- [ ] [HTML r5436] `#arrangProposeBtn` — sr-abtn primary `ti-plus` "Stel afspraak voor" — wired r12608 → `openArrangPropose()` r12662 (opent 5-step wizard)
- [ ] [HTML r5439] `#arrangRefreshBtn` — sr-abtn `ti-refresh` "Vernieuw" — wired r11737 → `loadArrangements()` r12020

### Status-pills (`#arrangStatusNav`, HTML r5445 — 5 pills)
- [ ] [HTML r5446] `data-arrang-status="VOORGESTELD"` (default active)
- [ ] [HTML r5447] `data-arrang-status="ACTIEF"`
- [ ] [HTML r5448] `data-arrang-status="NAGEKOMEN"`
- [ ] [HTML r5449] `data-arrang-status="VERBROKEN"`
- [ ] [HTML r5450] `data-arrang-status="GEANNULEERD"`
- Wired r11728 → `switchArrangStatus(s)` r11836

### Tabel (`#arrangementsTable`, `<tbody id="arrangementsTbody">`, r5453)
- **KOLOMMEN** (r5455–5460):
  - Klant (naam + email onderregel)
  - Type (130px) — badge: Uitstel / Splitsing / Abonnement pauze / Abonnement stop / Kwijtschelding / Betaalafspraak
  - #Facturen (100px)
  - Effectief (200px) — from → until (via `arrangEffective`)
  - Status (130px) — colored badge
  - Acties (180px)

**Row-acties (delegated in tbody, wire r11740)**:
- [ ] `[data-arrang-detail=<id>]` — sr-abtn `ti-eye` "Details" — → `openArrangDetail(id)` r12082 (opent `#arrangementDetailModal`)
- [ ] `[data-arrang-cancel=<id>]` — sr-abtn danger `ti-x` "Annuleer" — alleen bij VOORGESTELD/ACTIEF — → `cancelArrang(id)` → `openCancelArrangementModal(arr)` r12481
- [ ] Row-click (buiten a/button) → `openArrangDetail(id)`

### Detail-modal (`#arrangementDetailModal`)
Wired r11768+.
- [ ] `#arrangDetailTitle`, `#arrangDetailSubtitle`
- [ ] `#arrangDetailStatusBanner` — lifecycle-banner (ACTIEF/NAGEKOMEN/VERBROKEN/GEANNULEERD kleuren + iconen) — r12118
- [ ] `#arrangDetailSection1` — rows-list met arrangement-details (type, status, dates, notes, cancellation_reason indien GEANNULEERD)
- [ ] `#arrangDetailActionsTbody` — pending-actions tabel; delegated click r11778 op:
  - `[data-pa-mark-executed=<id>]` — sr-abtn primary `ti-check` "Verwerkt" (alleen APPROVED + arrangement niet GEANNULEERD/VERBROKEN) → `openMarkExecutedModalFin(id)` r12324
  - `[data-pa-mark-not-executed=<id>]` — sr-abtn danger `ti-x` "Niet door te voeren" → `openMarkNotExecutedModalFin(id)` r12413
- [ ] `#arrangDetailError`
- [ ] `#arrangDetailClose`, `#arrangDetailCloseBtn` — sluiten

### Mark-executed sub-modal (`#markExecutedModalFin`)
Wired r11797+.
- [ ] `#markExecFinCtxLine1`, `#markExecFinCtxLine2` — context readout
- [ ] `#markExecFinCreditIds` — text (CSV van TL credit-note IDs)
- [ ] `#markExecFinSubscriptionId` — text (TL sub-ID)
- [ ] `#markExecFinInvoiceIds` — text (CSV van TL invoice IDs)
- [ ] `#markExecFinNotes` — textarea (min 10 chars, verplicht)
- [ ] `#markExecFinError`
- [ ] `#markExecFinConfirmBtn` "Bevestig" — → `submitMarkExecutedFin()` r12359 → POST `/api/pending-actions-mark-executed`
- [ ] `#markExecFinCancelBtn`, `#markExecFinClose`

### Mark-not-executed sub-modal (`#markNotExecutedModalFin`)
Wired r11806+.
- [ ] `#markNotExecFinReason` — textarea (min 10 chars, verplicht)
- [ ] `#markNotExecFinError`
- [ ] `#markNotExecFinConfirmBtn` "Bevestig" — → `submitMarkNotExecutedFin()` r12430 → POST `/api/pending-actions-mark-not-executed`
- [ ] `#markNotExecFinCancelBtn`, `#markNotExecFinClose`

### Cancel-arrangement modal (`#cancelArrangementModal`)
Wired r11815+.
- [ ] `#cancelArrangementContext` — grid readout (klant/type/facturen/bedrag)
- [ ] `#cancelArrangementReason` — textarea (min 5 chars); input listener enables submit r11827
- [ ] `#cancelArrangementError`
- [ ] `#cancelArrangementConfirmBtn` "Annuleer regeling" — disabled default — → `submitCancelArrangement()` r12529 → POST `/api/arrangements-cancel`
- [ ] `#cancelArrangementCancelBtn`, `#cancelArrangementCloseBtn`, Escape (r11822)

---

## Finance > Wanbetalers > Afspraken > Propose-wizard (`#arrangProposeModal`)

Opent via `#arrangProposeBtn` óf `handleJoostArrangementRequest` óf externe callers met `openArrangPropose(opts)`. Wired `wireArrangProposeOnce()` r12604.

### Stepper + navigatie (r12707)
- [ ] `#arrangWizSubtitle` — "Stap X van 5: <label>"
- [ ] `.arrang-wiz-dot[data-step]` — 5 dots
- [ ] `#arrangWizPrevBtn` — wired r12611 → `arrangWizPrev()`
- [ ] `#arrangWizNextBtn` — wired r12612 → `arrangWizNext()` — hidden op stap 5
- [ ] `#arrangWizConfirmBtn` — wired r12613 → `arrangWizConfirm()` r13464 → POST `/api/arrangements-propose` — hidden vóór stap 5
- [ ] `#arrangWizCancelBtn`, `#arrangWizClose`, backdrop click (r12615)
- [ ] `#arrangWizError` — error-banner

### Stap 1 — Type + klant (`#arrangWizStep1`)
- [ ] `#arrangWizType` — `<select>` (types: UITSTEL / SPLITSING / ABONNEMENT_PAUZE / ABONNEMENT_STOP / KWIJTSCHELDING) — wired r12620 → reset invoice/sub state
- [ ] `#arrangWizCustomerSearch` — text input, debounce 250 ms → `arrangWizCustomerSearch(q)` r12870 (endpoint `/api/customers?search=`)
- [ ] `#arrangWizCustomerResults` — results-list (`.arrang-cust-row` klik → select)
- [ ] `#arrangWizCustomerSelected` — geselecteerde-klant readout (`#arrangWizCustomerSelectedName`)
- [ ] `#arrangWizCustomerClear` — wired r12642 → clear-selectie

### Stap 2 — Facturen / abonnement (`#arrangWizStep2`)
- [ ] `#arrangWizInvoiceMode` (wrapper) — zichtbaar bij niet-abonnement types
  - `#arrangWizInvoiceList` — checkboxes `[data-arrang-inv]` (open + partially_paid facturen; endpoint `/api/finance-invoices?customer_id`)
  - `#arrangWizInvoiceCount`, `#arrangWizInvoiceTotal` — totalen
- [ ] `#arrangWizSubMode` (wrapper) — zichtbaar bij ABONNEMENT_PAUZE/STOP
  - `#arrangWizSubList` — radio-buttons `[data-arrang-sub]` (endpoint `/api/sales-customer-subscriptions`)

### Stap 3 — Details (`#arrangWizStep3`)
Type-specifieke panels toggled in `arrangWizInitStep3()` r13069:

**UITSTEL** (`#arrangWizDet_UITSTEL`) — consolidate-flow (D1.5):
- [ ] `input[name="arrangWizUitstelMode"]` — radios: `termijnen` / `bedrag`
- [ ] `#arrangWizUitstelTermijnen` — number 2-60 (mode=termijnen)
- [ ] `#arrangWizUitstelTermijnenReadonly` — display bij mode=bedrag
- [ ] `#arrangWizUitstelBedragPerTermijn` — number ≥0 (mode=bedrag)
- [ ] `#arrangWizUitstelBedragReadonly` — display bij mode=termijnen
- [ ] `#arrangWizUitstelStartsOn` — date input (default: 1e vd volgende maand)
- [ ] `#arrangWizUitstelEndsOn`, `#arrangWizUitstelTotaal`, `#arrangWizUitstelOutstanding` — display (computed)
- [ ] `#arrangWizUitstelVatPreview` — BTW-mix (grid, uit `/api/arrangements-vat-preview`)
- [ ] `#arrangWizUitstelVatError`

**SPLITSING** (`#arrangWizDet_SPLITSING`):
- [ ] `#arrangWizSplitTotalLbl` — factuur-totaal display
- [ ] `#arrangWizSplitCount` — number 2-12 termijnen — change → `arrangWizRegenSplitParts()` r13318
- [ ] `#arrangWizSplitRegen` — button — wired r12651 → regen
- [ ] `#arrangWizSplitTbody` — dynamische tabel per termijn:
  - `[data-arrang-part-amt=<i>]` — number bedrag
  - `[data-arrang-part-date=<i>]` — date vervaldatum
- [ ] `#arrangWizSplitSumWarn` — warning bij sum-mismatch

**ABONNEMENT_PAUZE** (`#arrangWizDet_ABONNEMENT_PAUZE`):
- [ ] `#arrangWizPauseFrom` — date
- [ ] `#arrangWizPauseUntil` — date
- [ ] `#arrangWizPauseReason` — text

**ABONNEMENT_STOP** (`#arrangWizDet_ABONNEMENT_STOP`):
- [ ] `#arrangWizStopDate` — date
- [ ] `#arrangWizStopReason` — text

**KWIJTSCHELDING** (`#arrangWizDet_KWIJTSCHELDING`):
- [ ] `#arrangWizWriteOffAmount` — number >0
- [ ] `#arrangWizWriteOffReason` — text

### Stap 4 — Toelichting (`#arrangWizStep4`)
- [ ] `#arrangWizRationale` — textarea (min 10 chars) — input listener r12655 update `#arrangWizRationaleLen`
- [ ] `#arrangWizRationaleLen` — char counter

### Stap 5 — Preview (`#arrangWizStep5`)
- [ ] `#arrangWizPreview` — rows-list met samenvatting
- [ ] `#arrangWizPreviewImpact` — impact-tekst ("Dit voorstel maakt N pending actions aan")

---

## Finance > Wanbetalers > Instellingen (mountInstellingenHubHost r21667)

Container `#wb-sub-instellingen`. Sub-key `instellingen`.

### Kaarten-raster (`#instelCardGrid`) — `INSTEL_CARDS` r21657
- [ ] r21658 — 💬 "Joost — de toon" `data-instel-target="joost"` → `setSubView('joost')`
- [ ] r21659 — ⏱️ "Wanneer starten & regels" `data-instel-target="workflows"` → `setSubView('workflows')`
- [ ] r21660 — ✉️ "Berichten" `data-instel-target="templates"` → `setSubView('templates')`
- [ ] r21661 — 📬 "Brieven" `data-instel-target="brieven"` → `setSubView('brieven')`
- [ ] r21662 — 🏢 "Incassobureaus" `data-instel-target="incasso"` → `setSubView('incasso')`
- [ ] r21663 — 🧪 "Testmodus" `data-instel-target="sandbox"` — **hidden default** (super_admin gating via r21690)
  - zichtbaarheid: rol:super_admin only
- [ ] r21664 — 📜 "Geschiedenis & log" `data-instel-target="geschiedenis"` → `setSubView('geschiedenis')`

Wire delegated r21699 (backward-compat: `joost-admin` → `joost`).

---

## Finance > Wanbetalers > Instellingen > Brieven (mountBrievenHost r21742)

Container `#wb-sub-brieven`. Sub-key `brieven`.

### Filter-pills + zoek (`.brieven-pills`, r21752)
- [ ] `data-brv-status="all"` "Alle" (default `aria-pressed=true`) — met `.brv-cnt[data-brv-cnt="all"]`
- [ ] `data-brv-status="aangemaakt"` "Aangemaakt"
- [ ] `data-brv-status="gedownload"` "Gedownload"
- [ ] `data-brv-status="verstuurd"` "Verstuurd"
- Wired r21796 → `_brievenState.status` + `_brievenLoad()`

- [ ] `#brvSearchInput` — search input, debounce 250 ms → `_brievenState.search` + reload (r21804)
- [ ] `#brvRefreshBtn` — sr-btn `ti-refresh` "Herlaad" — wired r21812

### Bulk-bar (`#brvBulkBar`, hidden default zichtbaar bij selection>0)
- [ ] `#brvBulkCount` — "N geselecteerd"
- [ ] `#brvBulkPrintBtn` — wbx-primary `ti-printer` "Print / Download selectie" — wired r21816 → `_brievenBulkPrint()` r21931 → POST `/api/dunning-briefs-bulk-print` (blob → open in new tab)
- [ ] `#brvBulkMarkSentBtn` — wbx-btn `ti-mail-check` "Markeer als verstuurd" — wired r21818 → `_brievenBulkMarkSent()` r21968 → POST `/api/dunning-briefs-bulk-mark-sent` (wbxOpenConfirm indien beschikbaar)
- [ ] `#brvBulkClearBtn` — "Deselecteer" — wired r21820

### Tabel (`<tbody id="brvTbody">`) — **KOLOMMEN** r21777–5:
- [ ] col1 `#brvSelectAll` (checkbox, header — wired r21823 → all/none toggle)
- [ ] col2 Klant (`it.customer_name`)
- [ ] col3 Aangemaakt (`generated_at`)
- [ ] col4 Status (Aangemaakt/Gedownload/Verstuurd — gekleurd)
- [ ] col5 Gedownload (`downloaded_at`)
- [ ] col6 Verstuurd (`sent_at` + `sent_via`)
- [ ] col7 Door (`generated_by_name`)
- [ ] col8 Land (`country`)
- [ ] col9 Actie — `<a>↓ PDF</a>` (`download_url` — r21891)

Row-checkboxes `[data-brv-select=<id>]` — wired r21906.

---

## Finance > Wanbetalers > Instellingen > Joost inline (mountJoostConfigHost r22006)

Container `#wb-sub-joost`. Sub-key `joost`.

### Tab-strip (r22015)
- [ ] `.joost-tab-btn[data-joost-tab="oefengesprek"]` (default active) `ti-messages` "Oefengesprek" — wired r22032
- [ ] `.joost-tab-btn[data-joost-tab="instellingen"]` `ti-adjustments` "Instellingen" — lazy-mounts `FinanceInstellingen.mount()` r22056 (buiten scope: shared/finance-instellingen.js)

### Oefengesprek-panel (`#joost-tab-oefengesprek`, r22156) — `_mountJoostOefengesprekPanel()`
- [ ] `#joostOgBar` — status-bar met `#joostOgBarDot` + `#joostOgBarText` (`Oefening op X · Dry-run AAN/UIT`)
  - deep-link: `data-joost-og-goto="testmodus"` in error-state → `setSubView('testmodus')`
- [ ] `#joostOgResetBtn` — wbx-btn `ti-refresh` "Nieuw gesprek" — wired r22190 → `_joostOgReset()` (buiten scope, na r22499)
- [ ] `#joostOgModes` — mode-pills per intent (labels: betaal-belofte / al betaald / regeling / vraag / escalatie / anders) — read-only display
- [ ] `#joostOgThread` — chat-stream (klant = outbound rechts, Joost = inbound links); per-message meta-rij (intent/confidence/mode/blocked_reason) + productie-rij ("dit was verstuurd" / "gezwegen — <reden>")
  - inline rate-limit-teller `[data-rate-limit-timer]` (r22391)
  - meta-buttons `.joost-og-meta-why[title=...]` — hover-tooltip met reasoning
- [ ] `#joostOgInput` — textarea (Enter zonder Shift = send)
- [ ] `#joostOgStatus` — status-tekst rechts van send
- [ ] `#joostOgSendBtn` — sr-abtn primary `ti-send` "Verstuur" — wired r22182 → `_joostOgSend()` r22479 → POST `/api/wanbetalers-sandbox-simulate-inbound`

---

## Referentie-modals gedeeld met andere sub-views

- [ ] `#invModal` (view-facturen — factuur-detail) — Escape-handler globaal (r21063) wist óók `bankTxModal` + `claimPaidModal`
- [ ] `#payModal`, `#sendModal`, `#creditModal`, `#updModal`, `#newInvModal`, `#newCustCreateModal`, `#bankTxModal` — buiten scope wanbetalers

---

## Gaten / follow-ups voor volgende agent

- **Vandaag** (`mountDunVandaagHost`) — HTML/wiring rond r27920+ (na r22000).
- **Pipeline** (`mountDunPipelineHost`) — kanban + lijst view (r10230+, wiring buiten deel-1 range).
- **Sandbox** (`mountSandboxHost`) — r27572+.
- **Opruimen** (`mountOpruimenHost`) — r22565+.
- **Facturen** (`mountFacturenHost`) — r23043+.
- **Open Acties oude** (`mountFinanceTasksHost`) — externe module?
- **Open Acties nieuwe werkcentrum** (`mountActiesWerkcentrumHost`) — r29655+.
- **Overzicht nieuw** (`mountOverzichtNieuwHost`) — r28346+.
- **Incasso** (`mountIncassoHost`) — r21283 stub in scope, maar shell/handlers buiten range.
- **Crediteren** (`mountCrediteerHost`) — r21299 delegeert naar `window.FinanceCrediteer.mount`.
- **Te doen** (`mountTeDoenHost`) — shell r21323+, maar case-sheet + row-handlers deels buiten range (r24389, r26585).
- **Case-sheet** (`openCaseSheet(cid, opts)`) — r21539 wordt aangeroepen maar de body wordt elders gedefinieerd.
- **Inbox `#inboxThreadOpenActionBtn` / `#inboxThreadSendLetterBtn` / `#inboxThreadPauseBtn`** — click-handlers r30750+.
- **Inbox `#inboxMoreActionsBtn` compose-strip menu** — handlers r30675+.
- **No-reply banner logic** (`inboxNoReplyBanner`) — r30652+.
- **Toezegging modal** (`openToezeggingModal`) — buiten scope.
- **Global constants** `INSTEL_CARDS` referenced elders zoals `Testmodus` sub-key (`setSubView('testmodus')` r22269) — geen mount-branch in setSubView vóór r22000; check r7020+ zone.

<!-- END finance-B-wanbetalers-1.md -->

---

## 5. Finance — Wanbetalers deel 2

**Bron**: `modules/finance.html` r22000-31978 — INSTEL_CARDS grid + Joost inline + Brieven-overzicht + Opruimen + Facturen + Case-sheet + Incasso + Sandbox + Vandaag + Actie-widget + Overzicht-nieuw + Pipeline + Acties-werkcentrum + Thread-header handlers + Compose-menu + Actie-maker popup + Unified inbox reply-modal.

<!-- BEGIN finance-C-wanbetalers-2.md -->

# Finance-Wanbetalers — Inventaris Deel 2 (r21650-32000)

Scope: `modules/finance.html` — Instellingen-hub + zes kaarten (Joost / Workflows / Berichten / Brieven / Bureaus / Sandbox / Geschiedenis) · Brieven-overzicht · Case-sheet (klant-drawer met Dossier/Bellen/Gesprek/WIK/Timeline) · Actie-bar en modals (Toezegging, Uitkomst, Close-dossier, Mark-disputed, Mark-bewind, Resolve-dispute, Info-sent) · Opruimen (subtabs) · Facturen · Bulk-multiselect + acties · Sandbox · Vandaag · Actie-widget · Overzicht-nieuw · Pipeline · Acties-werkcentrum · Thread-header handlers · Actie-maker popup · Unified inbox reply.

Legenda `zichtbaarheid`: `publiek` = altijd zichtbaar voor rol met module-access; `rol:X` = RBAC-gated (permissions_cache); `hidden default` = start met `hidden` en wordt runtime enabled; `super_admin` = super_admin gate; `deep-link only` = alleen bereikbaar via url-hash of programmatische navigatie.

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Instellingen-hub (kaartraster) — r21657-21708
- [ ] r21674 — **container `#instelCardGrid`** — 6 kaarten (7 met super_admin=Sandbox), gerenderd via `INSTEL_CARDS.map()`
- [ ] r21680 — kaart `[data-instel-target]` "💬 Joost — de toon" — click → `setSubView('joost')`
  - zichtbaarheid: publiek
- [ ] r21680 — kaart `[data-instel-target]` "⏱️ Wanneer starten & regels" (Workflows) — click → `setSubView('workflows')` → `activateDunningSub('workflows')`
  - zichtbaarheid: publiek
- [ ] r21680 — kaart `[data-instel-target]` "✉️ Berichten" (Templates) — click → `setSubView('templates')` → `activateDunningSub('templates')`
  - zichtbaarheid: publiek
- [ ] r21680 — kaart `[data-instel-target]` "📬 Brieven" — click → `setSubView('brieven')` → `mountBrievenHost()`
  - zichtbaarheid: publiek
- [ ] r21680 — kaart `[data-instel-target]` "🏢 Incassobureaus" — click → `setSubView('incasso')` (opent Incasso met bureau-mgr)
  - zichtbaarheid: publiek
- [ ] r21680 — kaart `[data-instel-target]` "🧪 Testmodus" (Sandbox) — click → `setSubView('sandbox')`
  - zichtbaarheid: super_admin (data-super-admin-only + hidden; check via `AuthShared.getProfile().role==='super_admin'`, r21692-21697)
- [ ] r21680 — kaart `[data-instel-target]` "📜 Geschiedenis & log" — click → `setSubView('geschiedenis')` → `activateDunningSub('geschiedenis')`
  - zichtbaarheid: publiek
- Backward-compat: `data-instel-target='joost-admin'` wordt alias voor `joost` (r21704)

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Instellingen > Brieven (WIK-brieven overzicht) — r21716-21994

### Filter-pills (segmented) — r21753-21756
- [ ] r21753 — `[data-brv-status="all"]` "Alle" — pill met count `[data-brv-cnt="all"]`
- [ ] r21754 — `[data-brv-status="aangemaakt"]` "Aangemaakt"
- [ ] r21755 — `[data-brv-status="gedownload"]` "Gedownload"
- [ ] r21756 — `[data-brv-status="verstuurd"]` "Verstuurd"
- Elk zet `_brievenState.status` + clear selection + reload

### Search + refresh — r21758-21761
- [ ] r21759 — `#brvSearchInput` (search input) — 250ms debounce → `_brievenState.search` → `_brievenLoad()`
- [ ] r21761 — `#brvRefreshBtn` "↻ Herlaad"

### Bulk-bar (sticky, verschijnt bij ≥1 selectie) — r21764-21771
- [ ] r21767 — `#brvBulkPrintBtn` "🖨 Print / Download selectie" → `_brievenBulkPrint()` → POST `/api/dunning-briefs-bulk-print` (merged PDF; opent nieuwe tab of download-fallback)
- [ ] r21768 — `#brvBulkMarkSentBtn` "✉ Markeer als verstuurd" → `_brievenBulkMarkSent()` → wbxOpenConfirm(warn) → POST `/api/dunning-briefs-bulk-mark-sent`
  - modal: wbxOpenConfirm — "Markeer als verstuurd per post"
- [ ] r21769 — `#brvBulkClearBtn` "Deselecteer" — leegt `_brievenState.selection`

### Tabel met multi-select — r21773-21792
- **KOLOMMEN**: checkbox / Klant / Aangemaakt / Status / Gedownload / Verstuurd / Door / Land / Actie
- [ ] r21777 — `#brvSelectAll` (kolom-checkbox) — toggle all zichtbare rijen
- [ ] r21894 — per rij `input[data-brv-select="<id>"]` — toggle in `_brievenState.selection`
- [ ] r21891 — per rij `<a>` "↓ PDF" (Actie-kolom) — link naar `it.download_url` (target=_blank)

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Instellingen > Joost — inline UI — r22006-22562

### Joost-shell met sub-tabs (Oefengesprek / Instellingen) — r22006-22070
- [ ] r22016 — `[data-joost-tab="oefengesprek"]` "💬 Oefengesprek" (default active)
- [ ] r22017 — `[data-joost-tab="instellingen"]` "🎛 Instellingen" — lazy mount `FinanceInstellingen.mount({host:#wb-sub-joost-mount})` (r22063)
- Instellingen-tab verbergt de shared `#fiTabs` (top-level fi-tabs) via inline style (r22025)

### Oefengesprek — chat sandbox — r22152-22562
- [ ] r22162 — `#joostOgResetBtn` "🔄 Nieuw gesprek" — confirm → POST `/api/wanbetalers-sandbox-oefengesprek-reset`
  - confirm: window.confirm "Nieuw gesprek starten? Alle berichten…"
- [ ] r22171 — `#joostOgInput` (textarea) — Enter=send / Shift+Enter=newline
- [ ] r22174 — `#joostOgSendBtn` "📤 Verstuur" — `_joostOgSend()` → POST `/api/wanbetalers-sandbox-simulate-inbound`
- Status-bar + intent-mode-pills (autonoom / draft / disabled per intent)
- Deep-link uit statusbalk: `[data-joost-og-goto="testmodus"]` — `setSubView('testmodus')` (r22267)
- "Waarom?"-inline button per Joost-antwoord: `.joost-og-meta-why` — tooltip met reasoning (r22446)

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Opruimen (2 sub-tabs) — r22564-23040

### Sub-tab bar — r22574-22577
- [ ] r22576 — `[data-opruim-tab="opruim"]` "Opruimen" (default) → `_opruimShowSubtab('opruim')`
- [ ] r22577 — `[data-opruim-tab="runs"]` "Lopende aanmaningen" — lazy fetch bij eerste opening of stale-flag

### Sub-tab "Opruimen" — landing + lijst — r22580-22620
- [ ] r22586 — `[data-opruim-go="crediteren"]` "Open crediteer-overzicht →" — `setSubView('crediteren')`
- [ ] r22591 — `[data-opruim-go="incasso"]` "Open incasso-dossiers →" — `setSubView('incasso')`
- [ ] r22603 — `#opruimEngineRunBtn` "Engine nu draaien" — POST `/api/finance-dunning-engine-run-now` (RBAC finance.dunning.execute)
  - zichtbaarheid: rol:finance.dunning.execute (server 403 fallback)
- [ ] r22607 — `#opruimReloadBtn` "Herlaad"
- Filter-pills — r22614-22616:
  - [ ] `[data-opruim-filter="all"]` "Alle (n)"
  - [ ] `[data-opruim-filter="todo"]` "Nog aanmanen (n)" (stage `nieuw`)
  - [ ] `[data-opruim-filter="active"]` "Al in workflow (n)" (stage != `nieuw`)

### Klanten-tabel met bulk multi-select — r22989-23040
- **KOLOMMEN**: checkbox / Klant / Open facturen / Totaal open / Oudste / Status
- [ ] r22993 — `input[data-bulk-cb-all]` (kop-checkbox) — toggle all
- [ ] r23013 — per rij `input[data-bulk-cb="<cid>"]` — toggle selection
- [ ] r23033 — rij click → `openCaseSheet(cid)`

### Sub-tab "Lopende aanmaningen" (Runs-paneel) — r22627-22653
- [ ] r22633 — `#opruimRunsReloadBtn` "Ververs" — resets `_opruimRunsStale` en laadt runs opnieuw
- KPI-strip 3 cellen: Actieve runs / Totaal openstaand / Afgerond (30d)
- **Actieve runs tabel — KOLOMMEN**: Klant / Workflow / Stap / Volgende actie / Openstaand
- **Recent verzonden tabel — KOLOMMEN**: Klant / Kanaal / Tijdstip

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Facturen — r23042-23370

### Toolbar — r23064-23076
- [ ] r23066 — `[data-fc-view="invoice"]` "Per factuur" (default active) — `_fcState.view='invoice'`
- [ ] r23067 — `[data-fc-view="customer"]` "Per klant" — `_fcState.view='customer'`
- [ ] r23070 — `#fcBacklogChk` (checkbox) "Alleen achterstand (≥2)" — `_fcState.backlog`

### Status-strip (fase-tellers, klikbaar) — r23168-23196
- [ ] r23180 — `[data-fc-strip="all"]` "Alles"
- [ ] r23180 — `[data-fc-strip="nieuw"]` "Nieuw te laat"
- [ ] r23180 — `[data-fc-strip="aangemaand"]` "Aangemaand"
- [ ] r23180 — `[data-fc-strip="in_gesprek"]` "In gesprek"
- [ ] r23180 — `[data-fc-strip="regeling"]` "Regeling"
- [ ] r23180 — `[data-fc-strip="backlog"]` "Achterstand"

### Tabel "Per factuur" — r23260-23273
- **KOLOMMEN**: Klant / Factuur / Bedrag / Te laat / Status
- [ ] r23349 — rij click → `openCaseSheet(cid, {invoiceId, invoiceNr, daysOverdue})`

### Tabel "Per klant" (met bulk multi-select) — r23281-23295
- **KOLOMMEN**: checkbox / Klant / Open facturen / Totaal open / Oudste / Status
- [ ] r23284 — `input[data-bulk-cb-all]` (kop-checkbox)
- [ ] r23339 — per rij `input[data-bulk-cb="<cid>"]`
- [ ] r23362 — rij click (niet op checkbox) → `openCaseSheet(cid)`

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Bulk multiselect (sticky bar + acties) — r23384-23960

### Bulk-bar `#wbxBulkBar` (verschijnt bij ≥1 selectie, floating body-level) — r23477-23504
- [ ] r23486 — `[data-bulk-act="aanmaan"]` "Aanmaning sturen" → `_bulkActionAanmaan()`
  - modal: `_bulkOpenActionModal` — preview (klanten + open facturen) → POST `/api/wanbetalers-bulk-start-workflow` (chunks van 100)
- [ ] r23487 — `[data-bulk-act="crediteren"]` "Crediteren" → `_bulkActionCrediteren()`
  - modal: preview → POST `/api/crediteer-ronde-preview` → confirm → POST `/api/crediteer-ronde-execute`
  - dangerTint: true (fiscaal impact waarschuwing)
- [ ] r23488 — `[data-bulk-act="incasso"]` "Naar incasso" → `_bulkActionIncasso()`
  - modal: preview (skip al-in-incasso) → per-customer POST `/api/incasso-dossier-create` (needs_brief handling)
  - dangerTint: true
- [ ] r23489 — `[data-bulk-act="opgelost"]` "Markeer opgelost" → `_bulkActionOpgelost()`
  - modal: preview → per-customer POST `/api/dunning-pipeline-set-stage` (stage='opgelost')
- [ ] r23490 — `[data-bulk-act="clear"]` "Legen" — `_bulkResetSelection()`

### Bulk-modal (`_bulkOpenActionModal`) shared structure — r23521-23567
- [ ] r23534 — `[data-bulk-close]` ✕ (kruis) — sluit modal
- [ ] r23538 — `[data-bulk-close]` "Annuleren"
- [ ] r23539 — `[data-bulk-confirm]` "Bevestig & uitvoeren" (of `wbx-danger` variant) — voert `onConfirm` uit

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Case-sheet drawer (klant-dossier, right-slide) — r23962-27562

Sheet-container: `#caseSheet` + scrim `#caseScrim`. Opent via `openCaseSheet(customerId, opts)`. Optionele `wideDrawerMode` (Overzicht-nieuw). Escape sluit (r24106).

### Top-header (universeel) — r24332-24344
- [ ] r24335 — `[data-case-close]` "← Terug" (backlink)
- [ ] r24336 — `[data-case-close]` "✕" (kruis, Escape ook)
- Pill met stage-label + fase-strip (4 steps: nieuw → aangemaand → in gesprek → uitkomst) — read-only visualisatie

### Kaart: "De factuur" — r24349-24355
- [ ] r24329 — `[data-case-goto="crediteren"]` "opruimactie" (inline link) — sluit sheet + `setSubView('crediteren')` (r24389)

### Kaart: "Bellen" (`_caseBellenCardHtml`) — r25204-25342
- [ ] r25308 — `select[data-case-line-sel]` "Uitbellen via" — opties: `auto` / `nl` / `be` (BE tonen bij configured)
  - update `_wbxSoftphone.lineOverride`, triggert re-render
- [ ] r25318 — `[data-case-conn-retry]` (icon-refresh) — SIP reconnect (bij failed/disabled state)
- [ ] r25322 — `#wbxCallNumberInput` + `[data-case-num]` — bewerkbaar telefoonnummer
- [ ] r25329 — `[data-case-bel]` "📞 Bel nu" — `_wbxPlaceCall(cust.phone)` → outcome-modal opent na Terminated
- [ ] r25327 — `[data-case-hangup]` "📵 Ophangen" (in-call) — `_wbxHangup()`
- [ ] r25328 — `[data-case-mute]` (🎤 icon) — `_wbxToggleMute()`
- [ ] r25331 — `[data-case-log-manual]` "Uitkomst noteren" — `_caseOpenOutcomeModal(cust)`
- Nudge bij 3+ pogingen zonder resolutie:
  - [ ] r25276 — `[data-case-action="to_incasso"]` "→ naar incasso" (in nudge-box)

### Floating callbar (body-level, tijdens gesprek) — r24855-24877
- [ ] r24869 — `#wbxSoftphoneMuteBtn` (🎤) — `_wbxToggleMute()`
- [ ] r24870 — `#wbxSoftphoneHangupBtn` (📵) — `_wbxHangup()`

### Kaart: "Gesprek" (WhatsApp bubbles + Joost-suggestie) — r24357-24363
- Bij aanwezige Joost-suggestion (`_caseState.suggestion`):
  - [ ] r24299 — `[data-case-joost="send"]` "Verstuur zo" — POST `/api/inbox-send` (mode text, body=suggested_reply); disabled buiten 24u
  - [ ] r24300 — `[data-case-joost="edit"]` "Bewerken" — window.prompt → send bewerkte tekst
  - [ ] r24301 — `[data-case-joost="arrangement"]` "Stel regeling voor" — closeCaseSheet + `setSubView('arrangements')` (alleen bij intent=payment_promise of stage=in_gesprek)

### Kaart: "WIK-brief — bewijs" (`_caseWikCardHtml`) — r24519-24591
Als geen brief bestaat:
- [ ] r24531 — `[data-wbx-wik="gen-nl"]` "📄 Genereer NL" — confirm → POST `/api/incasso-pre-brief` (country=NL) — download PDF
  - confirm: wbxOpenConfirm "WIK-brief NL genereren" (dangerLevel:neutral)
- [ ] r24532 — `[data-wbx-wik="gen-be"]` "📄 Genereer BE" — confirm → POST country=BE

Als brief bestaat:
- [ ] r24554 — `<a>` "↓ Bewijs" — download_url (target=_blank) van laatste brief
- [ ] r24558 — `[data-wbx-wik="email"]` "✉ Mail via administratie@" — confirm → POST `/api/dunning-brief-email-send`
  - confirm: wbxOpenConfirm "WIK-brief mailen" (dangerLevel:warn)
- [ ] r24561 — `[data-wbx-wik="mark-post"]` "✉ Verstuurd per post" — confirm → POST `/api/dunning-brief-mark-post`
  - confirm: wbxOpenConfirm "Verstuurd per post markeren" (dangerLevel:warn)
- [ ] r24581 — `[data-wbx-wik="gen-nl"]` "↻ Nieuwe NL" — extra brief genereren
- [ ] r24582 — `[data-wbx-wik="gen-be"]` "↻ Nieuwe BE" — extra brief genereren
- [ ] r24568 — `<a>` (in details) per eerder brief — download link

### Kaart: "Tijdlijn & notities" (`_caseTimelineCardHtml`) — r24413-24451
- [ ] r24443 — `#wbxTlNoteInput` (textarea) "Notitie toevoegen…"
- [ ] r24445 — `[data-wbx-tl="refresh"]` "↻" (refresh)
- [ ] r24446 — `[data-wbx-tl="save"]` "Notitie plaatsen" — POST `/api/customer-notes`
- [ ] r24432 — `[data-wbx-tl="more"]` "Toon meer (n)" — expand tijdlijn
- [ ] r24434 — `[data-wbx-tl="less"]` "Inklappen"

### Actie-bar (onderaan sheet) — r24368-24381
- [ ] r24369 — `[data-case-action="<primary.key>"]` — primaire actie afhankelijk van stage:
  - `nieuw` → "Start aanmaning" (to_aangemaand: stage naar aangemaand)
  - `aangemaand` → "Vraag Joost" (ask_joost: fresh suggestion)
  - `in_gesprek` → "Bekijk gesprek" (focus_chat: scroll)
  - `regeling` → "Keur regeling goed" (go_arrangements: setSubView)
  - `brief_verstuurd` → "Naar incasso"
- [ ] r24370 — `[data-case-action="toezegging"]` "Betaalafspraak vastleggen" — `openToezeggingModal(...)`
- [ ] r24371 — `[data-case-action="reminder"]` "Herinnering sturen" — als fase='nieuw' → `_caseSetStage('aangemaand')`, anders `_caseAddLog`
- [ ] r24372 — `[data-case-action="ask_joost"]` "Vraag Joost" — POST `/api/joost-suggest`
- [ ] r24373 — `[data-case-action="close_dossier"]` "✓ Sluit dossier" — `_caseOpenCloseDossierModal()`
  - zichtbaarheid: rol:finance.dunning.execute (`_caseCanCloseDossier()`)
- [ ] r24376 — `[data-case-action="resolve_dispute"]` "⚖ Geschil opgelost" — `_caseOpenResolveDisputeModal()`
  - zichtbaarheid: rol:finance.dunning.execute + stage=='dispuut'
- [ ] r24377 — `[data-case-action="mark_disputed"]` "⚖ Geschil" — `_caseOpenMarkDisputedModal()`
  - zichtbaarheid: rol:finance.dunning.execute + stage!='dispuut'
- [ ] r24379 — `[data-case-action="mark_bewind"]` "🛡 Bewind" — `_caseOpenMarkBewindModal()`
  - zichtbaarheid: rol:finance.dunning.execute
- [ ] r24380 — `[data-case-action="to_incasso"]` "Naar incasso" (danger) — wbxOpenConfirm → `_openNaarIncassoDialog(cid)`

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Case-sheet > Modals

### `wbxOpenConfirm` — generieke bevestigings-modal (`#wbxConfirmModal`) — r25362-25468
Herbruikbaar. Parameters: title / subtitle / dangerLevel (neutral/warn/danger/bewind) / whatHappens / nextStep / requireReason / primaryLabel / bodyHtml.
- [ ] r25422 — `[data-wbx-cf-cancel]` ✕ / "Annuleer"
- [ ] r25434 — `[data-wbx-cf-ok]` primary-btn — voert `onConfirm(reasonVal)`
- Optioneel textarea `#wbxConfirmReason` (min-length validatie)

### `_caseOpenCloseDossierModal` (`#wbxCloseDossierModal`) — r25497-25606
Sluit dossier met verplichte reden + soepele betaald-check (409 HAS_OPEN_INVOICES → confirm-loop met force).
- [ ] r25532 — `[data-close-cancel]` ✕
- [ ] r25537 — `#wbxCloseReason` (textarea, min 5 chars)
- [ ] r25543 — `[data-close-cancel]` "Annuleer"
- [ ] r25544 — `[data-close-save]` "Sluit dossier" — POST `/api/finance-dunning-close-customer`
- Ctrl/Cmd+Enter in textarea → submit
- zichtbaarheid: rol:finance.dunning.execute (fail-secure)

### `_caseOpenMarkDisputedModal` (`#wbxMarkDisputedModal`) — r25615-25691
- [ ] r25635 — `[data-md-cancel]` ✕ / r25646 "Annuleer"
- [ ] r25640 — `#wbxMdReason` (textarea, min 5 chars, verplicht)
- [ ] r25647 — `[data-md-save]` "Markeer geschil" — POST `/api/finance-dunning-mark-disputed`
- zichtbaarheid: rol:finance.dunning.execute

### `_caseOpenMarkBewindModal` (`#wbxMarkBewindModal`) — r25693-25799
- [ ] r25713 — `[data-mb-cancel]` ✕ / r25743 "Annuleer"
- [ ] r25718 — `#wbxMbReason` (textarea, min 5 chars)
- [ ] r25723 — `#wbxMbName` (input, min 2 chars, verplicht)
- [ ] r25727 — `#wbxMbEmail` (input, optioneel)
- [ ] r25730 — `#wbxMbPhone` (input, optioneel)
- [ ] r25734 — `#wbxMbRef` (input, "Dossiernummer / referentie")
- [ ] r25737 — `#wbxMbNote` (textarea, optioneel)
- [ ] r25744 — `[data-mb-save]` "Markeer bewind" — POST `/api/finance-dunning-mark-bewind` met curator_contact-object
- zichtbaarheid: rol:finance.dunning.execute

### `_caseOpenResolveDisputeModal` (`#wbxResolveDisputeModal`) — r25801-25877
- [ ] r25821 — `[data-rd-cancel]` ✕ / r25839 "Annuleer"
- [ ] r25826 — `input[name="wbxRdResolution"][value="resume"]` (radio, default) "Aanmanen hervatten"
- [ ] r25830 — `input[name="wbxRdResolution"][value="close"]` (radio) "Dossier sluiten"
- [ ] r25834 — `#wbxRdReason` (textarea, min 5 chars)
- [ ] r25840 — `[data-rd-save]` "Opslaan" — POST `/api/finance-dunning-resolve-dispute`
- zichtbaarheid: rol:finance.dunning.execute

### `_caseOpenOutcomeModal` — belpoging uitkomst (`#wbxCallOutcomeModal`) — r25949-26128
- [ ] r25962 — `[data-outcome-close]` ✕ / r25978 "Annuleer"
- 10 outcome-opties via `[data-outcome="<key>"]` (CALL_OUTCOMES r24815-24834):
  - [ ] `no_answer` "Geen gehoor"
  - [ ] `voicemail` "Voicemail ingesproken"
  - [ ] `callback` "Terugbelafspraak" — toont datetime-field verplicht
  - [ ] `payment_promise` "Toezegging tot betaling" — triggert Toezegging-modal na save
  - [ ] `payment_plan` "Betalingsregeling" — triggert Toezegging-modal met 2 parts
  - [ ] `refused` "Weigert te betalen"
  - [ ] `disputed` "Betwist factuur" — triggert Mark-disputed-modal na save
  - [ ] `wrong_number` "Verkeerd nummer"
  - [ ] `paid_during_call` "Betaald tijdens gesprek" — triggert Close-dossier-modal met preset reason
  - [ ] `info_sent` "Info toegestuurd" — triggert `_caseInfoSentFollowup` (factuur-mail confirm + auto-followup +3d)
- [ ] r25969 — `#wbxCallOutcomeCallbackAt` (datetime-local, verplicht bij callback)
- [ ] r25973 — `#wbxCallOutcomeNote` (textarea, optioneel)
- [ ] r25979 — `[data-outcome-save]` "Opslaan" — POST `/api/dunning-call-log-create`

### `openToezeggingModal` — betaalafspraak (`#wbxToezeggingModal`) — r26148-26340
Voor payment_promise / payment_plan. 1+ termijnen (add/remove).
- [ ] r26198 — `select[data-toezegging-inv="<idx>"]` — factuur-keuze per part (optioneel; default "Alle openstaande")
- [ ] r26204 — `input[type=date][data-toezegging-date="<idx>"]` — vervaldatum (verplicht per part)
- [ ] r26209 — `input[type=number][data-toezegging-amt="<idx>"]` — bedrag EUR (optioneel)
- [ ] r26193 — `[data-toezegging-remove="<idx>"]` "✕" — verwijder termijn
- [ ] r26228 — `[data-toezegging-add]` "+ Termijn toevoegen"
- [ ] r26230 — `#wbxToezeggingNote` (textarea, optioneel)
- [ ] r26224 — `[data-toezegging-close]` ✕ / r26235 "Annuleer"
- [ ] r26236 — `[data-toezegging-save]` "Afspraak vastleggen" — POST `/api/arrangements-propose` (type=TOEZEGGING)

### `_caseInfoSentFollowup` — fallback prompts — r25889-25947
- window.confirm "Kopie factuur mailen naar klant?" → POST `/api/finance-invoice-send`
- window.prompt bij >1 open factuur (picker via index) 
- Auto-followup: POST `/api/dunning-call-log-create` (outcome=callback, +3d)

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Incasso (sub) — r26855-27562

### Toolbar — r26871-26875
- [ ] r26873 — `#incBureauMgrBtn` "Bureaus beheren" — opent `#incBureauModal`
- [ ] r26874 — `#incRefreshBtn` "Herlaad"

### Status-pill filters (dynamic) — r27107-27126
- [ ] r27115 — `[data-inc-filter="<slug>"]` — per status; incl. "Alle"

### Dossier-lijst — r27140-27170
- **KOLOMMEN**: Klant / Openstaand / Status / Bureau / Aangemeld
- [ ] r27167 — rij `.inc-row[data-id]` — click → `incOpenDetail(id)` → `#incDetailOverlay`

### Auto-route blok (`<details id="incAutoWrap">`) — r26881-26914
- [ ] r26887 — `#incAutoEnabled` (checkbox) "Auto-modus ingeschakeld"
- [ ] r26891 — `#incAutoMinDays` (number) "Minimaal dagen te laat"
- [ ] r26894 — `#incAutoMinEur` (number) "Minimaal openstaand bedrag"
- [ ] r26899 — `#incAutoTrgBroken` (checkbox) "Verbroken payment_arrangement"
- [ ] r26900 — `#incAutoTrgNoResp` (checkbox) "Laatste aanmaning zonder inkomende reactie erna"
- [ ] r26901 — `#incAutoTrgRefusal` (checkbox) "Handmatige betalingsonwil-marker"
- [ ] r26904 — `#incAutoSaveBtn` "Instellingen opslaan" → POST `/api/incasso-auto-settings-set`
- [ ] r26905 — `#incAutoPreviewBtn` "Toon kandidaten" → GET `/api/incasso-auto-preview`
- [ ] r26906 — `#incAutoRunBtn` "Verwerk kandidaten nu" — confirm → POST `/api/incasso-auto-run`
  - confirm: window.confirm "Verwerk de huidige kandidaten NU…"

### Bureau-modal (`#incBureauModal`) — r26916-26948
- [ ] r26921 — `#incBureauCloseBtn` ✕
- [ ] r26929 — `#incBurName` (input) "Naam bureau"
- [ ] r26932 — `#incBurEmail` (input) "E-mail"
- [ ] r26935 — `#incBurCountry` (select NL/BE)
- [ ] r26938 — `#incBurAddress` (input) "Adres"
- [ ] r26942 — `#incBurAddBtn` "Bureau toevoegen" / "Wijzigingen opslaan" (bij edit) — POST `/api/incasso-bureaus-upsert`
- [ ] r26943 — `#incBurCancelEditBtn` "Annuleer" (hidden default)
- Per bureau in lijst:
  - [ ] r27194 — `[data-bur-edit="<id>"]` "Bewerk"
  - [ ] r27195 — `[data-bur-del="<id>"]` "Verwijder" — confirm → POST `/api/incasso-bureaus-delete`

### Dossier-detail overlay (`#incDetailOverlay`) — r26950-26959
- [ ] r26955 — `#incDetailCloseBtn` ✕
- [ ] r27317 — `#incEditStatus` (select) — status update
- [ ] r27320 — `#incEditBureau` (select) — bureau-koppeling
- [ ] r27324 — `#incEditNotes` (textarea) — dossier-notities
- [ ] r27327 — `#incSaveBtn` "Opslaan" — POST `/api/incasso-dossier-update`
- [ ] r27328 — `#incPdfBtn` "Genereer dossier-PDF" — POST `/api/incasso-dossier-pdf` (blob download)
- [ ] r27329 — `#incMailBtn` "E-mail naar bureau" — confirm → POST `/api/incasso-dossier-email`
- [ ] r27330 — `#incPreBriefBtn` "Verstuur pre-incassobrief" — POST `/api/incasso-pre-brief` (download PDF)

### `_openNaarIncassoDialog` — global function (window scope) — r27466-27532
- Multi-step prompt-flow: window.prompt bureau-keuze → land → POST `/api/incasso-dossier-create`
- Bij needs_brief → window.confirm "verstuur brief nu" → `incDownloadPreBrief` → retry create
- Fallback: window.confirm "toch doorgaan zonder brief" → create met `confirm_no_brief:true`

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Sandbox (Testmodus) — r27571-27908
- Zichtbaarheid: super_admin (endpoints gaten zelf super_admin)

### Dry-run-card — r27593-27599
- [ ] r27598 — `#sbxDryRunToggle` "Schakel" — confirm bij uit-zetten → POST `/api/wanbetalers-sandbox-set-dry-run`
  - confirm: window.confirm bij UIT-zetten "⚠️ Weet je zeker…"

### 1. Test-persoon seed — r27601-27622
- [ ] r27605 — `#sbxSeedName` (input) "Naam"
- [ ] r27606 — `#sbxSeedPhone` (input) "Telefoon"
- [ ] r27607 — `#sbxSeedEmail` (input) "E-mail"
- [ ] r27608 — `#sbxSeedCount` (number) "# facturen"
- [ ] r27609 — `#sbxSeedAmount` (number) "€ per factuur"
- [ ] r27610 — `#sbxSeedDays` (number) "Dagen te laat"
- [ ] r27616 — `#sbxSeedMonthly` (number) "Maandbedrag abo"
- [ ] r27617 — `[data-sbx-monthly="80"]` (€80 suggest)
- [ ] r27618 — `[data-sbx-monthly="300"]` (€300 suggest)
- [ ] r27621 — `#sbxSeedBtn` "👤+ Seed / refresh test-persoon" — POST `/api/wanbetalers-sandbox-seed`

### 2. Versneld testen — r27624-27639
- [ ] r27629 — `#sbxFfDays` (number) "Fast-forward"
- [ ] r27630 — `#sbxFfBtn` "Backdate" — POST `/api/wanbetalers-sandbox-fast-forward`
- [ ] r27631 — `#sbxInboundBtn` "💬+ Simuleer inkomend WA" — window.prompt tekst → POST `/api/wanbetalers-sandbox-simulate-inbound`
- [ ] r27632 — `#sbxPaidBtn` "💰 Markeer alle facturen betaald" — confirm → POST `/api/wanbetalers-sandbox-mark-paid`
- [ ] r27633 — `#sbxRunEngineBtn` "▶️ Run engine (test)" — POST `/api/wanbetalers-sandbox-run-engine`
- [ ] r27634 — `#sbxRunBreachBtn` "🛡✓ Bewaking draaien (test)" — POST `/api/wanbetalers-sandbox-run-breach-check`
- [ ] r27635 — `#sbxRunConvRemindersBtn` "🕐▶ Herinneringen draaien (test)" — POST `/api/wanbetalers-sandbox-run-conversation-reminders`
- [ ] r27636 — `#sbxRunBulkBtn` "📤 Bulk-job (test)" — window.prompt channel → POST `/api/wanbetalers-sandbox-run-bulk`
- [ ] r27637 — `#sbxSimCreditBtn` "🧪 Simuleer crediteerronde" — confirm → POST `/api/wanbetalers-sandbox-simulate-credit-round`

### Deep-link naar Joost-oefengesprek — r27643-27646
- [ ] r27645 — `[data-sbx-goto="joost"]` link "Instellingen → Joost → Oefengesprek" — `setSubView('joost')`

### Gevarenzone — r27648-27652
- [ ] r27651 — `#sbxResetBtn` "🗑 Reset (wis alle testdata)" — confirm → POST `/api/wanbetalers-sandbox-reset`
  - confirm: window.confirm "⚠️ ALLE is_test-data verwijderen…"

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Vandaag (sub-view) — r27918-27974
- [ ] r27933 — `#vdgStartAanmaanBtn` "📤 Start aanmaanronde" — `setSubView('probleemklanten')`
- KPI-strip 3 cellen: Openstaand / Wanbetalers / Vragen aandacht (read-only render via `renderDunOvKpis`)
- Inner-host `#wb-sub-vandaag-actie` → `mountDunActiesHost()` (Actie-widget)

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Actie-widget (mountDunActiesHost) — r27986-28227

### KPI-strip (3 klikbare cellen) — r28006-28022
- [ ] r28007 — `[data-act-goto="appts"]` "Afspraken vandaag" — scroll naar `#actSectionAppts`
- [ ] r28012 — `[data-act-goto="await"]` "Wacht op reactie" — scroll naar `#actSectionAwait`
- [ ] r28017 — `[data-act-goto="stale"]` "Lang geen contact" — scroll naar `#actSectionStale`
- [ ] r28025 — `#actRefreshBtn` "↻ Herlaad" — `loadDunActies()`

### Item-rows in 3 secties — r28213-28226
- [ ] rij `.act-item[data-cid]` — click → `openPipelineDetail(cid)` (load stages first if needed)

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Overzicht-nieuw (mountOverzichtNieuwHost) — r28345-28654

### Toolbar — r28356-28378
- [ ] r28356 — `#oznRefresh` "↻ Verversen"
- [ ] r28369 — `#oznSearch` (search input) — client-side filter op naam/email/telefoon
- Tab (1 / multi):
  - [ ] r28372 — `[data-oznt="one"]` "1 factuur" (default)
  - [ ] r28373 — `[data-oznt="multi"]` "Meerdere facturen"
- Sub-tab (actief / afgerond):
  - [ ] r28375 — `[data-oznst="actief"]` "Actief" (default)
  - [ ] r28376 — `[data-oznst="afgerond"]` "Afgerond"

### Tabel — r28511-28533
- **KOLOMMEN**: Klant / # / Open (sort) / Dagen (sort) / Fase (sort) / Volgende actie (sort) / Status / 💬
- [ ] r28536 — `th.sortable[data-oznsort="<key>"]` — kolomsortering: open / days / stage / next
- [ ] r28551 — `.ozn-name-btn[data-cid]` (klantnaam) — click → `openCaseSheet(cid, {wideDrawerMode:true})`
- [ ] r28558 — `.ozn-stage-badge[data-cid]` (fase-badge) — click → `_oznOpenStageModal(it)` (read-only mini-modal)
- [ ] r28570 — `.ozn-conv-btn[data-conv-id]` (💬 icoon) — deep-link: `setSubView('inbox')` + `openInboxConv(convId)`

### Stage-modal (read-only) `#oznStageModal` — r28623-28654
- [ ] r28636 — `#oznStageClose` ✕
- **Kolommen tabel** (fase sinds / laatste activiteit / open facturen / oudste vervaldatum / workflow-run / volgende actie / [aandacht nodig])

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Pipeline (mountDunPipelineHost, PR-C — r28660-29622)

### Header + zoek — r28666-28709
- [ ] r28670 — `#dunPlRefreshBtn` "↻ Vernieuwen"
- [ ] r28679 — `#dunPlSearchInput` (search) "Zoek op naam, e-mail of telefoon…"
- [ ] r28681 — `#dunPlSearchClear` (✕) — wis zoekopdracht

### KPI-strip + filters `#dunPlKpis` — dynamisch gerenderd
- Reset-knop:
  - [ ] r28692 — `#dunPlResetFilters` "✕ Filters wissen"

### Klassiek pipe (fallback shell + row-menu, `_pipeState`, list-view) — r28712-29213
- [ ] r28716 — `#pipeSearchInput` (input) — client filter
- [ ] r28717 — `#pipeSortSelect` (select) — bedrag ↓ / dagen ↓ / contact ↓
- [ ] r28722 — `#pipeRefreshBtn` "↻ Herlaad"
- Stage-filter pills (dynamic):
  - [ ] r28997 — `[data-stage-filter="<slug>"]` — filter per fase
- Sectie-toggle (in-/uitklappen per fase):
  - [ ] r29106 — `[data-stage-toggle="<slug>"]` — collapse/expand
- Rij:
  - [ ] r29088 — `.pipe-list-row[data-cid]` — click → `openPipelineDetail(cid)`
  - [ ] r29099 — `[data-row-menu-cid]` "⋮" — opens row-menu (popover)

### Row-menu popover — r29143-29192
- [ ] r29157 — `[data-action="open"]` "🔗 Open dossier" → `openPipelineDetail(cid)`
- [ ] r29158 — `[data-action="note"]` "📝 Notitie toevoegen" → `_pipeAddLogPrompt(cid)` (window.prompt → POST `/api/dunning-pipeline-add-log`)
- [ ] r29151 — `[data-move-slug="<slug>"]` × N — verplaats klant naar fase (POST `/api/dunning-pipeline-set-stage`)
  - Elk fase-item toont dot + label; huidig fase disabled

### Detail-modal `#pipeDetailOverlay` — r28728-28739
- [ ] r28732 — `#pipeDetailCloseBtn` "✕"
- Bij klik op backdrop sluit
- [ ] r29327 — `#pipeDetailStageSel` (select) — fase-wijziging → POST `/api/dunning-pipeline-set-stage`
- [ ] r29328 — `#pipeNaarIncassoBtn` "⚖ Naar incasso" — `_openNaarIncassoDialog(cid)` 
  - zichtbaarheid: rol:finance.incasso.manage (hidden default)
- [ ] r29336 — `#pipeApptTitle` (input) — nieuwe afspraak titel
- [ ] r29337 — `#pipeApptDue` (datetime-local)
- [ ] r29338 — `#pipeApptAddBtn` "Toevoegen" — POST `/api/dunning-pipeline-appointment`
- [ ] r29345 — `#pipeLogInput` (input) — notitie
- [ ] r29346 — `#pipeLogAddBtn` "Plaats" — POST `/api/dunning-pipeline-add-log`
- Per afspraak (open):
  - [ ] r29367 — `.pipe-appt-done` "✓" — mark done (POST `/api/dunning-pipeline-appointment` status=done)

### Chat-paneel (rechts in detail-modal) — r29537-29622
- [ ] r29564 — `#pipeChatText` (textarea) — WA compose
- [ ] r29565 — `#pipeChatSendBtn` "Verstuur" (disabled buiten 24u) — POST `/api/inbox-send`
- [ ] r29552 — `#pipeChatArchiveBtn` (🗄) — confirm → POST `/api/inbox-conversation-set-status` (status=gearchiveerd)
  - confirm: window.confirm "Dit WhatsApp-gesprek archiveren?…"

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Acties-werkcentrum (`mountActiesWerkcentrumHost`) — r29655-30606

### Tabs — r29662-29669
- [ ] r29663 — `[data-awn-tab="todo"]` "Te doen (n)" (default active)
- [ ] r29664 — `[data-awn-tab="later"]` "Later (n)"
- [ ] r29665 — `[data-awn-tab="done"]` "Afgehandeld (n)"
- [ ] r29666 — `[data-awn-tab="rej"]` "Afgewezen (n)"
- [ ] r29668 — `[data-awn-refresh]` "↻"

### Zoekbalk — r29675-29682
- [ ] r29675 — `[data-awn-search]` (input) — client-side filter op klantnaam
- [ ] r29679 — `[data-awn-search-clear]` (✕)

### Per rij-actie (dynamisch per action_type / status) — r29993-30110
- [ ] r30013 — `[data-awn-call="<id>"]` "📞 Bel" (op MANUAL_FOLLOWUP) — `openCaseSheet(cid, {autoOpenCallOutcomeForPendingActionId})`
- Per type PENDING (unique labels):
  - MANUAL_CONFIRM_PROMISE: [ ] "Bevestigen" (approve) / [ ] "Niet nagekomen" (reject) — r30017-30018
  - MANUAL_ESCALATION:      [ ] "Oppakken" (approve) / [ ] "Afgehandeld" (reject → mark-executed resolved) — r30020-30021
  - MANUAL_FOLLOWUP:        [ ] "Afgehandeld" (approve → mark-executed) / [ ] "Overslaan" (reject) — r30023-30024
  - MANUAL_VERIFY_PAYMENT:  [ ] "Bevestigen" (approve) / [ ] "Afwijzen" (reject) — r30026-30027
  - TL_* + others:          [ ] "Goedkeuren" (approve) / [ ] "Afwijzen" (reject) — r30029-30030
- [ ] r30033 — `[data-awn-snooze="<id>"]` "🕐 Later…" — opent `_awnOpenSnoozeModal`
- Voor done/rej rijen:
  - [ ] r30038 — `[data-awn-restore="<id>"]` "↺ Terug naar Te doen" (verborgen voor TL_*+EXECUTED)
- [ ] r30073 — `.awn-cust-link[data-awn-open-cust="<cid>"]` (klantnaam) — click → `openCaseSheet(cid, {wideDrawerMode:true})`

### Snooze-modal (`#awnSnoozeModal`) — r30171-30229
- [ ] r30194 — `[data-awn-cancel]` ✕
- Kwik-picks:
  - [ ] r30198 — `[data-awn-pick="<date>"]` "Morgen"
  - [ ] r30199 — `[data-awn-pick="<date>"]` "Over 3 dagen"
  - [ ] r30200 — `[data-awn-pick="<date>"]` "Volgende week"
- [ ] r30203 — `#awnSnoozeDate` (date input)
- [ ] r30207 — `[data-awn-cancel]` "Annuleren"
- [ ] r30208 — `[data-awn-confirm]` "Verplaats" — POST `/api/pending-action-snooze`

### Wbx-confirms per approve/reject (via `wbxOpenConfirm`)
- Approve-flows in `_awnApprove` — r30277-30362 (title/whatHappens/primaryLabel per action_type)
- Reject-flows in `_awnReject` — r30398-30487 (requireReason met minLen 5-10 per type)
- Restore-flows in `_awnRestore` — r30529-30592 (requireReason min 5)

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Thread-header handlers (inbox)

### Thread-header compacte knoppen — r4969-4996 (wired in ../30619+ blok)
- [ ] r4963 — `#inboxBackToListBtn` "←" (mobile-only, wist body.inbox-thread-open) — r17854
- [ ] r4975 — `#inboxThreadResolveBtn` "✓" "Gesprek afhandelen" (hidden default; toon bij status=open) — `_inboxSetConvStatus('afgehandeld')` — r17818
- [ ] r4976 — `#inboxThreadOpenActionBtn` "+" "Actie maken vanuit dit gesprek" — `_wbxGesprekActieOpen()` — r30753
- [ ] r4977 — `#inboxThreadCustomerBtn` "👤" "Klant-info" — `openInboxCustomerModal()` — r18141
- [ ] r4980 — `#inboxThreadMoreBtn` "⋮" "Meer acties" — toggle `#inboxThreadMoreMenu` — r30763-30796

### Thread-header ⋮-menu items `#inboxThreadMoreMenu` — r4982-4992
- [ ] r4982 — `#inboxThreadArchiveBtn` "🗄 Archiveren" (hidden default) — confirm → `_inboxSetConvStatus('gearchiveerd')` — r17824
  - confirm: window.confirm "Dit gesprek archiveren? Het komt NIET automatisch terug…"
- [ ] r4983 — `#inboxThreadReopenBtn` "↻ Heropenen" (hidden default) — `_inboxSetConvStatus('open')` — r17821
- [ ] r4984 — `#inboxThreadUnarchiveBtn` "🗄✕ Uit archief halen" (hidden default) — `_inboxSetConvStatus('open')` — r17829
- [ ] r4985 — `#inboxThreadMarkReadBtn` "✉✓ Markeer gelezen" — parallel POST `/api/inbox-mark-read` + POST `/api/inbox-email-mark-read` — r17863
- [ ] r4986 — `#inboxThreadMarkUnreadBtn` "✉ Markeer ongelezen" — POST `/api/inbox-mark-unread` — r17923
  - zichtbaarheid: rol:finance.inbox.view (403 fail)
- [ ] r4987 — `#inboxThreadDossierBtn` "🡻 Dossier openen" (disabled default) — `AgentShared.openCustomerDossier(cid)` — r18147
- [ ] r4991 — `#inboxThreadSendLetterBtn` "✉→ Stuur een brief" — `_wbxSendLetterFromInbox()` — r30757
  - modal: `wbxOpenConfirm` "WIK-brief aanmaken" (met warn als brief-vandaag-al-gedaan) → POST `/api/incasso-pre-brief`
  - fail-loud: 422 ADDRESS_INCOMPLETE toont warning-toast met missende velden
- [ ] r4992 — `#inboxThreadPauseBtn` "⏸ Pauzeer aanmaan-flow" — `_wbxF4PauseDunning()` — r30750
  - modal: `wbxOpenConfirm` (dangerLevel:warn) met requireReason min 5 chars → POST `/api/finance-dunning-pause-by-customer`

### Alternative ⋮-menu in compose-strip `#inboxMoreActionsMenu` — r5077-5083
- [ ] r5078 — `#inboxMoreActionsBtn` "⋮" — toggle compose-menu
- [ ] r5080 — `#inboxFollowupBtn` "📞+ Bel-taak" — `_wbxF4CreateFollowup()` → wbxOpenConfirm → POST `/api/tasks-create-followup`
- [ ] r5081 — `#inboxArrangementBtn` "📝 Regeling" — `_wbxF4OpenArrangement()` → `openCaseSheet(cid, {wideDrawerMode:true})`
- [ ] r5082 — `#inboxPauseDunningBtn` "⏸ Pauzeer flow" — zelfde als thread-pauzeer
- Wrap `#inboxMoreActionsWrap` gated op hasCust (display:inline-flex / none) — r30662

### No-reply banner `#inboxNoReplyBanner` — r5003-5006
- Read-only banner (geen interactieve elementen; tekst gerender via `_wbxF4LoadNoReplyBanner`)

### Joost autonomy-strip `#inboxJoostAutonomyStrip` — r5010-5016 (context: r30619+)
- [ ] r5014 — `#inboxJoostAutonomyPauseBtn` "⏸ Pauzeer Joost" (hidden default)
- [ ] r5015 — `#inboxJoostAutonomyResumeBtn` "▶ Hervat Joost" (hidden default)
  - (Handlers elders in bestand — buiten scope 22000+)

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Actie-maker popup (`_wbxGesprekActieOpen` — `#wbxGesprekActieModal`) — r31031-31248

### 6 type-buttons `.wbx-actie-type-btn[data-actie-type]` (grid 2×3) — r31045-31053
- [ ] `data-actie-type="bel"` "🎧 Bellen" — Bel-taak (voor mij of collega)
- [ ] `data-actie-type="verify"` "💵 Betaling checken" — Verify-taak (auto-pick oudste open factuur)
- [ ] `data-actie-type="escalatie"` "⚠ Escalatie" — MANUAL_ESCALATION
- [ ] `data-actie-type="vrije_taak"` "📋+ Vrije taak" — free-form met eigen titel
- [ ] `data-actie-type="regeling"` "📓 Regeling doorlink" — opent dossier
- [ ] `data-actie-type="wik"` "📃 WIK doorlink" — opent dossier

### Velden (dynamisch tonen per type)
- [ ] r31082 — `#wbxActieTitleInput` (input, alleen bij vrije_taak) "Titel"
- [ ] r31088 — `#wbxActieNoteInput` (textarea, verplicht bij taak-types; min 10 bij verify/escalatie, min 5 anders) "Notitie"

### Assignee-picker (alleen bij taak-types) — r31093-31108
- [ ] r31096 — `input[name="wbxActieAssignee"][value="self"]` (radio, default) "Voor mij (verschijnt in finance → Acties)"
- [ ] r31100 — `input[name="wbxActieAssignee"][value="team"]` (radio) "Toewijzen aan teamlid (verschijnt in Takenbeheer)"
- [ ] r31103 — `#wbxActieAssigneeSelect` (select, disabled tot 'team' gekozen) — profielen uit `/api/finance-active-profiles-list`

### Footer — r31117-31121
- [ ] r31069/r31118 — `[data-actie-cancel]` ✕ / "Annuleer"
- [ ] r31119 — `[data-actie-ok]` "Aanmaken" (of "Open dossier" bij doorlink-types)
  - `self` → `_wbxActieCreatePendingAction` — routes per type:
    - `bel` / `vrije_taak` → POST `/api/tasks-create-followup` (kind='bel' / 'free_task')
    - `verify` → auto-fetch oudste open factuur → POST `/api/tasks-create-verify-payment` (fallback: tasks-create-followup kind='verify_payment_no_invoice')
    - `escalatie` → POST `/api/tasks-create-escalation` (vereist conversation_id)
  - `team` → `_wbxActieCreateTakenItem` → POST `/api/taken` (task-object met camelCase assignedToId/customerId)
  - `regeling`/`wik` (doorlink) → `openCaseSheet(cid, {wideDrawerMode:true})`

────────────────────────────────────────────────────────────────────

## Finance > Wanbetalers > Unified inbox thread (feature-flag `unified_inbox_enabled`) — r31391-31971

### Per e-mail bubble in unified render — r31710-31723
- [ ] r31711 — `.f4u-reply-btn[data-f4-email-reply]` "✉→ Beantwoord per e-mail"
  - Als RBAC email.reply.send + emailIdComposite → opent reply-modal `_wbxF4OpenReplyModal`
  - Fallback: mailto: link + POST `/api/email-actions` (action=reply_sent)

### Reply-compose modal (scrim body-level) — r31865-31928
- [ ] r31886 — `[data-f4r-cancel]` "✕" (kruis)
- [ ] r31894 — `#f4rSubjectInput` (input) — onderwerp aanpassen (Re: prefix auto)
- [ ] r31896 — `#f4rBody` (textarea, 10 rows) — bericht + auto-prefill quote
- [ ] r31903 — `[data-f4r-cancel]` "Annuleren"
- [ ] r31904 — `[data-f4r-send]` "📤 Versturen" — POST `/api/send-email` (from_mailbox=administratie@…, handtekening=true, email_id=composite)
- Escape sluit; klik-op-backdrop sluit

### Per WA bubble (media-render, geen extra interactieve knoppen buiten media-open links)

────────────────────────────────────────────────────────────────────

## Samenvattende opmerkingen

- **wbxOpenConfirm** is de shared confirm-modal (r25362-25468). Gebruikt door: WIK-generate/mail/mark-post · Sluit-dossier · Mark-disputed/bewind · Resolve-dispute · Snooze · Bel-taak · Pauzeer flow · Naar-incasso · Brief-aanmaken · Bulk-mark-sent brieven · Awn approve/reject/restore.
- **RBAC-gated buttons** in case-sheet (dossier-sluiten/mark-disputed/mark-bewind/resolve-dispute): fail-secure via `_caseCanCloseDossier()` (perms cache) — knop verborgen; server 403 = definitieve poort.
- **RBAC-gated in Vandaag/Opruimen/Pipeline**: `finance.dunning.execute` (Engine-run knop), `finance.dunning.view` (Runs-paneel), `finance.incasso.manage` (naar-incasso in pipe-detail), `finance.inbox.view` (mark-unread).
- **Super_admin-gated**: Instellingen-hub Testmodus-kaart (r21663 + r21694), Sandbox subview zelf.
- **Deep-link only**: `wideDrawerMode:true` (openCaseSheet variant, wordt door Overzicht-nieuw, Acties-werkcentrum en compose-menu Regeling gebruikt).
- **Modal-conventies**: alle case-sheet modals gebruiken `wbx wbx-call-outcome-scrim` + `wbx-call-outcome-modal` styling; sluitpaden = ✕ + Annuleer + backdrop-click. `wbxOpenConfirm` volgt zelfde patroon met optionele requireReason-textarea.
- **CALL_OUTCOMES tabel** (10 opties, r24815-24834): no_answer / voicemail / callback / payment_promise / payment_plan / refused / disputed / wrong_number / paid_during_call / info_sent — elk triggert een dedicated follow-up modal of flow.
- **_WBX_ACTIE_TYPES** (6 opties, r31018-31025) — 4 taak-types (bel/verify/escalatie/vrije_taak) + 2 doorlink-types (regeling/wik).
- **INSTEL_CARDS** (7 kaarten, r21657-21665) — Joost/Workflows/Templates/Brieven/Bureaus/Sandbox/Geschiedenis (2 subs — templates/workflows/geschiedenis — landen buiten scope 22000+ via `activateDunningSub`).

<!-- END finance-C-wanbetalers-2.md -->

---

## Bewust laten vervallen

_(nog leeg — vullen bij elke PR die een item bewust niet herbouwt, met reden en goedkeuring)_
