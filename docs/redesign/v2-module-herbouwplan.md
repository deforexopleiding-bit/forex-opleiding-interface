# v2-preview module-voor-module herbouwplan

**Status:** PLAN. Wacht op goedkeuring shell (PR #1208) voordat er een module in v2 gebouwd wordt. Elke module = eigen preview-PR, geen self-merge.

## Uitgangspunten

- **Shell blijft eigenaar van nav/tabs/rolwissel/topbar** — modules registreren enkel `DFO.VIEWS[<mod>/<tab>] = () => 'html'`
- **1 module per PR** (met tabs desnoods opsplitsbaar per PR bij grote scope)
- **Bestaande endpoints hergebruiken** (die zijn allemaal live; alleen render-laag is nieuw)
- **Oude module blijft live** in `/modules/<oud>.html` tot v2-cutover per module (vercel-redirect zoals #1152 klanten-v2 al deed)
- **1-op-1 prototype-layout** uit `docs/redesign/systeemprototype-v45.html` — dat file bevat de complete render-code per module (r1400-2600+)
- **Geen self-merge**; elke PR levert Vercel-preview voor review

## Volgorde (klein → groot, per rol-groep waar zinvol)

### Fase A — Overzicht (3 modules; snel + hoge zichtbaarheid)

| # | Module | Prototype-render | Endpoints | Complexiteit |
|---|---|---|---|---|
| A1 | **dashboard** (Vandaag) | KPI-strip · 3 rol-kaarten · activity-feed | `/api/dashboard-stats`, `/api/dashboard-activity` | S — 1 tab, veel bestaande hooks |
| A2 | **inbox** (Centrale inbox) | Master-detail · filter-chips · counters | `/api/inbox-conversations-list` etc. | M — reuse Meta van finance-inbox |
| A3 | **taken** (Takenbeheer) | Kanban of lijst · 3 tabs (Mijn/Team/Afgerond) | `/api/taken?scope=...` | M — herbouw huidige taken.html-view (T2/T3 blijven werken) |

### Fase B — Klanten & communicatie (5 modules; klanten is al af)

| # | Module | Prototype-render | Endpoints | Complexiteit |
|---|---|---|---|---|
| — | ~~klanten~~ | ✓ al gebouwd | | |
| B1 | **studenten** (mentor-only) | Lijst met traject-progress + kolommen | `/api/mentor-my-students` | S |
| B2 | **email** | Master-detail (inbox/verzonden/spam) + compose-modal | `/api/emails-list`, `/api/email-send` | L — grote UI-oppervlakte |
| B3 | **tickets** | 3 tabs (Open/Wacht/Afgehandeld) + detail-modal | `/api/tickets`, `/api/ticket-detail` | M |
| B4 | **followup** | 8 tabs — grootste (werklijst/bellijst/opvolg/retenties/afspraken/sluimerpot/stats/afgeboekt) | `/api/follow-up-*` (12+ endpoints) | XL — splitsbaar in 3-4 sub-PRs |

### Fase C — Verkoop & Financiën (3 modules)

| # | Module | Prototype-render | Endpoints | Complexiteit |
|---|---|---|---|---|
| C1 | **sales** | 4 tabs (Dashboard/Offertes/Retentie/Prestaties) | `/api/sales-*` | L |
| C2 | **finance** | 6 tabs (Dashboard/Facturen/Abonnementen/Creditnotes/Bank/Omzet-MRR) | `/api/finance-*` | XL — splitsbaar per tab |
| C3 | **verdiensten** (mentor-only) | 4 tabs (Overzicht/Uitbetalingen/Reiskosten/Certificaten) | `/api/mentor-my-payouts` etc. | M |

### Fase D — Leren & Events (4 modules)

| # | Module | Prototype-render | Endpoints | Complexiteit |
|---|---|---|---|---|
| D1 | **lms** | ext-link naar dfo-lms-prototype (al configured in MODS.ext) | geen — nav opent nieuwe tab | XS |
| D2 | **events** | 4 tabs (Overzicht/Inbox/Inschrijvingen/Mentor-grootboek) | `/api/events-*` | L |
| D3 | **onboarding** | 3 tabs (Actief/Inbox/Archief) | `/api/onboarding-*` | M |
| D4 | **mentoren** | 6 tabs (Overzicht/Grootboek/Uitbetalingen/Beoordelingen/Certificaten/Signalen) | `/api/mentor-admin-*` | L |

### Fase E — Groei (4 modules)

| # | Module | Prototype-render | Endpoints | Complexiteit |
|---|---|---|---|---|
| E1 | **leads** | 2 tabs (Actief/Gearchiveerd) | `/api/leads` | M |
| E2 | **nieuwsbrief** (marketing-only) | Placeholder afhankelijk van build-spec beslissing | zie `marketing-nieuwsbrief-buildspec.md` | XS-XL |
| E3 | **leadsonderhoud** | 4 tabs (Inbox/Contacten/Bulk/Stats) | `/api/leadsonderhoud-*` | L |
| E4 | **lisa** (Instagram) | 3 tabs (Dashboard/Gesprekken/Statistieken) | `/api/lisa-*` | L |

### Fase F — Operatie (3 modules; admin-only)

| # | Module | Prototype-render | Endpoints | Complexiteit |
|---|---|---|---|---|
| F1 | **automatiseringen** | 6 tabs (Overzicht + 5 per-domein) | `/api/automations-*` | L |
| F2 | **agents** (AI Agents) | 4 tabs (Overzicht/Config/Kennisbank/Prestaties) | `/api/agent-*` | L |
| F3 | **logboek** (Toegangslog) | 2 tabs (Activiteit/Per-gebruiker) | `/api/activity-log-*` | S |

### Fase G — Systeem (2 modules)

| # | Module | Prototype-render | Endpoints | Complexiteit |
|---|---|---|---|---|
| G1 | **instellingen** | Sub-tabs afhankelijk van scope (WA-templates, workflows, integraties) | `/api/admin-*` | M |
| G2 | **binnenkort** | Empty-state / roadmap-view | — | XS |

### Fase H — Wanbetalers (apart, GEEL)

**Uitgesteld** tot review van `docs/redesign/wanbetalers-reskin-plan.md` — deze module zit in de beschermde zone en heeft eigen review-cyclus per sub-view. Rendering-strategie:
- **Optie 1**: `wanbetalers/*`-views registreren in v2 als iframe naar bestaande `modules/finance.html?tab=wanbetalers&sub=...` — 0 renderwerk, cutover later
- **Optie 2**: sub-view-per-sub-view herbouwen na wanbetalers-reskin-plan groen-licht

Beslissing bij review van shell.

## Per-PR checklist (template)

Elke module-PR volgt hetzelfde patroon:

- [ ] `modules/klanten-v2/views/<mod>.js` — 1 export per tab (of 1 hoofd-view als 0-1 tab)
- [ ] Import + register in `klanten-v2.js` boot (`window.DFO.VIEWS['<mod>/<tab>'] = ...`)
- [ ] Reuse bestaande endpoints via `KV.authedJson()` — geen nieuwe endpoints tenzij UI-only endpoint ontbreekt
- [ ] CSS: reuse van `design-system/components.css` + module-scoped `.mod-<id>-*` als nodig; **geen** hardcoded hex, alleen DS-tokens
- [ ] Handmatige test in preview: lijst laadt / detail werkt / rolwissel gedrag
- [ ] Screenshot van v2-render naast prototype-render in PR-body voor visual review
- [ ] Beschermde zone: leeg diff (alleen `modules/klanten-v2/views/*.js` + optioneel `klanten-v2.js` + `.css`)
- [ ] Niet self-mergen — Vercel-preview voor review

## Cross-fase leveringsritme

- **1 PR per module tenzij XL** (dan splitsen per tab of per feature)
- **Volgorde flexibel**: Fase A eerst (dashboard hoofdlanding), dan fase B (Klanten al af); daarna vrij bespreekbaar op basis van welke rol/user het meeste ziet
- **Elke fase-afsluiter**: sanity-run door hele shell met verschillende rollen om regressies te vangen

## Cutover-strategie (na alle modules af)

- Per module: `vercel.json` redirect zoals #1152 klanten-v2 (`/modules/<oud>.html` → `/modules/klanten-v2/?mod=<id>`). Rollback = redirect weghalen.
- Volledige cutover: `modules/klanten-v2/` hernoemen naar `modules/app/` en oude flat `modules/*.html` naar `modules/legacy/` verplaatsen (aparte cleanup-PR na 2 sprints stabiele run).

## Buiten scope van dit plan

- Wanbetalers-zone re-skin (aparte plan `wanbetalers-reskin-plan.md`)
- Marketing-rolpagina + Nieuwsbrief bouw (aparte spec `marketing-nieuwsbrief-buildspec.md` — go/no-go beslissing eerst)
- QA-punchlist BLOCKERs / MEDIUM opruimen in oude modules (`qa-punchlist.md`) — die zijn los van v2-uitbouw
- BOUWPLAN §8 bugs (`bekende-bugs-status.md`) — die raken beschermde zone en zijn los review-traject
