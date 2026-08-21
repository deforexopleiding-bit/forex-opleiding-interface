# Instellingen v2 — GAP-tracker

Bron-van-waarheid voor de Instellingen-rebuild in `modules/klanten-v2/views/instellingen-v2.js`.
Geseed uit de GAP-analyse (2026-08-21) op basis van `SETS`-array (r152-215) + `setBody(cur)` (r2994-3042).

## Onderhoudsregel (verplicht)

**Elke commit die de status van een sectie verandert, werkt de betreffende rij + de samenvatting bovenaan bij in DEZELFDE commit.** Zo loopt de tracker nooit achter op de code.
Bij status → `done`: noteer de `v=`-versie in de laatste kolom.
Bij status → `in-progress`: noteer welk brok (bv. "com-wa media-headers").
Bij `deferred`: reden expliciet in de sectie-noten.

Legenda status: `open` · `in-progress` · `done` · `deferred`
Legenda classificatie: `quick-add` (endpoint + kleine UI) · `grote-brok` (subst. UI/schema) · `bewust-deferred` (incasso/secrets/legal/extern)

---

## Samenvatting

**0 quick-adds open · 11 grote-brokken open · 13 deferred · 14 done** (totaal 38) — **alle top-5 quick-adds klaar ✓**

| Status | Aantal | Volgende actie |
|---|---|---|
| done         | 14 | — |
| open (quick-add)   | 0  | — |
| open (grote-brok) | 11 | agents-lisa als eerste (na advies) |
| open (grote-brok) | 11 | volgorde-advies: agents-lisa → sales-trajecten → ev-auto |
| deferred     | 13 | wacht op secrets-brok / motor-brok / legal-review |

---

## Verkoop

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `sales-trajecten` | open | grote-brok | ja (`trajects` + `traject_variants` + TL-sync bestaan) | native read-native v30; volledige editor wacht op brok |
| `sales-producten` | open | grote-brok | ja (product-catalogus bestaat) | deep-link |
| `sales-offerte`   | done | — | ja | ≤v=30 (TL-mailtemplate + sales-uitzonderingen native) |
| `sales-bonus`     | open | grote-brok | ja (`team_members`) | deep-link |

## Financieel

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `fin-facturatie`  | deferred | bewust-deferred | orphan keys | writes vragen invoice-create-core refactor |
| `fin-entiteiten`  | done | — | ja (`/api/company-entities` CRUD) | v=32 |
| `fin-teamleader`  | done | — | ja | ≤v=30 (OAuth + webhook + TL-import native) |
| `fin-bank`        | deferred | bewust-deferred | supabase-direct + CAMT | dashboard-saldo risico; CRUD later |

## Wanbetalers *(incasso-zone — motor onaangeraakt)*

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `wb-joost`     | deferred | bewust-deferred | ja (persona wired v=33) | persona schrijfbaar; system-prompt + autonomy_config + KB read-only tot Finance-signoff |
| `wb-workflows` | deferred | bewust-deferred | ja (`dunning_workflows`) | deep-link — motor-consistentie |
| `wb-berichten` | deferred | bewust-deferred | ja (`dunning_templates`) | deep-link — WIK-legal |
| `wb-venster`   | deferred | bewust-deferred | cooldown ja (v=35) | office-hours setter ontbreekt — aparte brok met audit-log |
| `wb-incasso`   | done | — | ja | v=34 (bureaus + auto-settings native) |

## AI Agents

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `agents-lisa`    | open | grote-brok | ja (`/api/lisa-config` draft/publish/rollback) | **volgende grote brok — na quick-adds** |
| `agents-manager` | open | grote-brok | ja (`/api/super-admin-ai-manager`) | deep-link |
| `agents-kennis`  | open | grote-brok | ja (`/api/kennisbank-*`) | deep-link |

## Events & Leren

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `ev-auto`      | open | grote-brok | ja (`/api/events-automation-*`) | deep-link |
| `ev-templates` | deferred | bewust-deferred | via com-wa | volgt wanneer com-wa uitgebreid is |
| `ev-locaties`  | open | grote-brok | nee (nieuwe editor + tabel nodig) | deep-link |
| `lms-instel`   | deferred | bewust-deferred | extern (Bubble) | geen native mogelijk |

## Communicatie

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `com-mail`         | deferred | bewust-deferred | env-vars (STRATO_*) | secrets-brok |
| `com-handtekening` | done | — | ja (`/api/email-signatures`) | ≤v=30 |
| `com-wa`           | done | — | ja | v=40 (media-headers IMAGE/VIDEO/DOCUMENT + example_url + upload; buttons URL/PHONE/QUICK_REPLY max 3; body_examples per {{N}}) |
| `com-tel`          | deferred | bewust-deferred | env-vars (Voys) | secrets-brok |
| `com-sjabloon`     | done | — | ja (`/api/email-templates`) | ≤v=30 |

## Marketing

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `mk-meta`       | deferred | bewust-deferred | extern (Meta BM) | geen native mogelijk |
| `mk-bronnen`    | open | grote-brok | nee (mapping-editor nieuw) | read-only distributie live v=37; mapping-editor = brok |
| `mk-sequenties` | open | grote-brok | ja (Leadsonderhoud-sequenties) | deep-link |
| `mk-webflow`    | done | — | ja | ≤v=30 (auto-publish + publish-now native) |

## Team & toegang

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `team-gebruikers` | done | — | ja | ≤v=30 (user-CRUD + rol + activate + impersonate) |
| `team-rechten`    | done | — | ja | ≤v=30 (matrix + diff-save + role-sync backfill) |
| `team-mentoren`   | done | — | ja | v=41 (Bubble-koppeling + cash-vergoedingen: list + pause/resume/delete + globale vrijval-motor) |
| `team-api`        | deferred | bewust-deferred | env-vars | secrets-brok |

## Algemeen

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `alg-bedrijf`     | deferred | bewust-deferred | env-vars COMPANY_* | secrets-brok (incasso-zone raakvlak) |
| `alg-meldingen`   | open | grote-brok | nee (notification_preferences schema + endpoint nieuw) | deep-link/notice v=27 |
| `alg-weergave`    | done | — | ja | v=43 (drag-reorder + toggle + add/remove: ✕-knop per rij, + Toevoegen-picker met beschikbare DFO.MODS) |

## Systeem

| sectie | status | classificatie | endpoint? | v= / noot |
|---|---|---|---|---|
| `sys-followup-admin` | done | — | ja | ≤v=30 (4 admin-tools met 3-staps-guard native) |
| `sys-bubble-schema`  | done | — | ja | v=42 (User + Session + User-option-waarden probes; endpoint-param fix ?objtype→?type + options=1) |

---

## Prioriteits-menu (advies)

**Volgende ronde (quick-adds, 1 bouwronde):**
1. `com-wa` — media-headers (IMAGE/VIDEO/DOCUMENT + example_url)
2. `com-wa` — buttons (URL/PHONE/QUICK_REPLY, max 3)
3. `com-wa` — body_examples per `{{N}}`
4. `team-mentoren` — cash-vergoedingen sectie
5. `sys-bubble-schema` — option-waarden probe

**Grote brokken volgorde (advies):**
1. `agents-lisa` (hoogste operationele impact per dag, endpoint compleet)
2. `sales-trajecten` (business-impact + TL-sync scope)
3. `ev-auto` (automation-editor)
4. `agents-kennis`
5. `mk-sequenties`
6. `mk-bronnen` mapping-editor
7. `alg-meldingen` (schema + UI)
8. `alg-weergave` items add/remove
9. `sales-producten`
10. `sales-bonus`
11. `agents-manager`
12. `ev-locaties`

**Deferred — wacht op:**
- **Motor + WIK-legal:** wb-workflows / wb-berichten / wb-joost (prompt/autonomy) / wb-venster (office-hours)
- **Secrets-brok:** com-mail / com-tel / team-api / alg-bedrijf (env-vars)
- **Refactor-blocker:** fin-facturatie (invoice-create-core), fin-bank (dashboard-saldo risico)
- **Extern platform:** mk-meta, lms-instel
- **Downstream van com-wa:** ev-templates

## Verdwenen acties (uit admin.html, nergens meer)

- Bubble option-waarden probe (admin.html r562) → deel van `sys-bubble-schema` quick-add
- Menu-manager item add/remove → deel van `alg-weergave` quick-add
- Mentor cash-vergoedingen → deel van `team-mentoren` quick-add
