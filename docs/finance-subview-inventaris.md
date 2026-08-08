# Finance-module sub-view inventaris (re-skin scope-doc)

**Bron:** `modules/finance.html` (32008 regels, main-branch dd 2026-08-08).

Doel: vaststellen welke sub-views veilig re-skinbaar zijn en welke off-limits blijven vanwege de wanbetalers/dunning-beschermingszone. Één PR per veilig cluster, alleen uiterlijk/DS-tokens, geen gedragswijziging.

---

## Sub-view registratie

Gevonden via `grep 'id="view-'` in `finance.html`:

| # | View-ID | Regel | Nav-knop | Status | Toelichting |
|---|---|---|---|---|---|
| 1 | `view-dashboard` | 4291 | `Dashboard` | ⚠️ **grens** | Host voor `FinanceDashboard` (shared/finance-dashboard.js). Dashboard-content is een aparte file (976r) buiten finance.html. Host-CSS in finance.html is klein en veilig te tokenen. Dashboard-cards zelf verwijzen NAAR wanbetalers/joost/arrangements KPIs — file zelf is niet beschermd, wel voorzichtig scope-bepalen. |
| 2 | `view-facturen` | 4386 | `Facturen` (default) | 🟢 **veilig** | Main facturen-lijst + KPIs + acties. Kern-werkstroom finance. |
| 3 | `view-creditnotes` | 4451 | `Creditnota's` | 🟢 **veilig** | Creditnota-lijst |
| 4 | `view-klanten` | 4383 | `Klanten` | ⚠️ **grens** | Klanten-in-finance-view (shared/finance-klanten.js host). Bevat wanbetalers-tab-tellers en drilldown naar dunning-inbox. Voorzichtig — links naar wanbetalers/dunning zitten er in. |
| 5 | `view-wanbetalers` | 4294 | `Wanbetalers` (hidden default) | 🔴 **BESCHERMD** | Complete wanbetalers-cluster. Niet aanraken. |
| 6 | `view-camtbank` | 4489 | `Bank` (hidden default) | 🟢 **veilig** | CAMT-bank-view (nieuwer). |
| 7 | `view-uitgaven` | 4661 | `Uitgaven` (hidden default) | 🟢 **veilig** | PayPal + CAMT uitgaven-categorisatie. |
| 8 | `view-bank` | 4838 | — (legacy?) | ⚠️ **onderzoek** | Oude bank-view zonder eigen nav-knop; mogelijk deprecated. Eerst check of nog gebruikt. |
| 9 | `view-inbox` | 4895 | — (wanbetalers-sub) | 🔴 **BESCHERMD** | Sub-view van wanbetalers (`view-wanbetalers` ↔ `view-inbox`+`view-dunning`). |
| 10 | `view-dunning` | 5102 | — (wanbetalers-sub) | 🔴 **BESCHERMD** | Complete dunning-timeline. |
| 11 | `view-arrangements` | 5429 | — (wanbetalers-sub, nested in view-dunning) | 🔴 **BESCHERMD** | Payment arrangements. |
| 12 | `view-roadmap` | 5475 | `Roadmap` | 🟢 **veilig** | Roadmap-view (docs-achtig). |
| 13 | `view-instellingen` | 5484 | — (settings-modal) | 🟢 **veilig** | Instellingen-host (Joost/templates/deps). ⚠️ let op: bevat Joost-config-UI die naar `api/joost-config-*` writes doet — écht alleen re-skin, geen gedrag/write-shape aanraken. |

**View-switch-logica** (regel 6889-6898): `document.getElementById('view-X').hidden = (view !== 'X')` per view, plus geneste toggle voor view-inbox/view-dunning binnen view-wanbetalers.

---

## Beschermde zone — expliciet off-limits

**Niet aanraken deze run:** `view-wanbetalers` (r4294-4382), `view-inbox` (r4895-5101), `view-dunning` (r5102-5474), `view-arrangements` (r5429-... nested in view-dunning). Samen ~1300r van finance.html.

**Verifieer per PR** met:
```bash
git diff main -- modules/finance.html | grep -E 'view-wanbetalers|view-inbox|view-dunning|view-arrangements'
```
Output moet **leeg** zijn.

Óók off-limits: alle API-endpoints `api/cron-dunning-*`, `api/finance-dunning-*`, `api/dunning-*`, `api/joost-*` (behalve: joost-config-write endpoints mogen NIET gemuteerd worden qua contract; alleen UI-re-skin op `view-instellingen`-blok mag), `api/voys-*`, `api/arrangements-*`, `api/pending-actions-*`, `api/_lib/dunning-*`, `api/_lib/joost-*`.

---

## Aanbevolen PR-volgorde (van klein → groot risico)

Elke PR = alleen CSS-tokens + kleine markup-tweaks (bv. `class="fin-input"` → gedeeld DS-token). Geen JS-gedrag-wijziging, geen endpoint-aanraking.

| Volgorde | View(s) | Complexiteit | Waarom eerst |
|---|---|---|---|
| 1 | `view-roadmap` | Klein | Bijna pure content-render. Perfect als proof-of-concept + tooling-verify. |
| 2 | `view-camtbank` + `view-uitgaven` (samen, bank-cluster) | Medium | Beide gerelateerd (bank + uitgaven van bank), gedeelde stijl-conventies logisch. |
| 3 | `view-creditnotes` | Medium | Zelfstandige lijst, geen dunning-links, spiegelt facturen-patroon. |
| 4 | `view-facturen` (default view, hoogste zichtbaarheid) | Groot | Vertrouwen opgebouwd na 1-3; grootste blast radius bij regressie. |
| 5 | `view-dashboard` (host-CSS + `shared/finance-dashboard.js` KPI-styling) | Groot | Raakt shared/finance-dashboard.js — hoge zichtbaarheid maar géén beschermde-zone-code, alleen KPI-drilldown-hrefs. |
| 6 | `view-instellingen` | Klein-medium | Alleen als tijd over — Joost-config-UI is best-of-class-refactor-target maar contract-gevoelig. |
| 7 | `view-klanten` (host + `shared/finance-klanten.js`) | Medium-groot | Bevat wanbetalers-tellers + drilldowns — visueel re-skinnen kan, drilldown-URLs NIET wijzigen. |
| 8 | `view-bank` | Onderzoek eerst | Mogelijk deprecated (geen nav-knop). Check of nog actief. Zo niet: aparte cleanup-PR. |

---

## Concrete scope per re-skin-PR (patroon)

1. **Recon:** open sub-view in `finance.html`, meet regel-range + inline-style / hardcoded-hex count.
2. **Kopieer huidige HTML** naar branch, vervang hardcoded kleuren met DS-tokens (bv. `#3b82f6` → `var(--blue)`, `#059669` → `var(--emerald)`).
3. **Tabellen** naar `.ds-tbl` + `.ds-tbl-wrap` (bestaande DS-primitives in `modules/shared/design-system/components.css`).
4. **Knoppen** naar `.ds-btn` + `.ds-btn-primary`/`.ds-btn-ghost`/etc.
5. **Inputs** naar `.ds-filter-sel` / DS-input als toepasbaar.
6. **Pills/badges** naar `.ds-pill` + accent-varianten.
7. **Modals** houden bestaande markup, alleen tokens.
8. **Cache-buster:** finance.html laadt geen versioned assets in de gebruikelijke `?v=1dX`-vorm — check of er module-lokale CSS bij komt of dat we tokens hoisten naar shared CSS.
9. **Verify:** `git diff` op wanbetalers-zone leeg + syntax + smoke-test op preview.
10. **Self-merge** als GROEN.

---

## Wat NIET in deze scope zit

- **Gedrag/JS-refactor**: geen event-handler-wijzigingen, geen state-machine-refactors, geen endpoint-contract-wijzigingen.
- **Layout-herstructurering**: geen kolom-verplaatsingen, geen tab-reorder. Alleen visueel.
- **Data-model / API**: geen nieuwe endpoints, geen kolom-veranderingen.
- **Wanbetalers-tab-mutaties**: zoals bekend, blijven off-limits.
- **Rol-bewuste widgets** (B4): aparte PR (rol-filter op KPI-cards in `shared/finance-dashboard.js`), NIET in re-skin-PRs.

---

## Realistische effort per PR

| PR | Effort (kleine tot medium sub-view) | Effort (grote sub-view) |
|---|---|---|
| Recon + tokenisatie | 45min-1u | 1-2u |
| Smoke-test + syntax + protected-zone-diff | 15-20min | 30min |
| **Totaal per PR** | **~1-1.5u** | **~2-3u** |

Voor de 8 items in de tabel: ~10-15u totale scope. Verspreid over meerdere sessies.

---

## Deze sessie — realiteits-check

De autonome-batch-instructie zegt "doorwerken tot af of window om". Ik heb in deze sessie al opgeleverd:
- Parity-audit klanten vs klanten-v2 (agent)
- Sidebar-swap-PR (#1152, HOLD)
- Finance-dashboard redirect (#1153, self-merged)
- Parity-must-items (#1155, self-merged: rij-kebab + CSV + Laatste-contact)
- Takenbeheer PLAN + storage-correctie op tickets-hergebruik (#1156, review)
- Deze inventaris (docs-PR)

Voor een échte sub-view-reskin moet ik voor 1 concrete PR minimaal ~1-1.5u kwaliteitswerk doen (voorbeeld: view-roadmap of view-uitgaven). Ik doe dit niet meer in dit sessie-venster want dat wordt half werk. Bewuste keuze: **eerst deze inventaris landen als contract voor de volgende sessies**, dan bij de volgende sessie beginnen met PR-1 (view-roadmap) als proof-of-concept.
