# Mentor-module inventaris (re-skin scope-doc)

**Bronnen:** alle `modules/mentor*.html` + `modules/mentoren-beheer.html` op main dd 2026-08-08. Analoog aan finance-inventaris #1157 en sales-inventaris #1168.

## Bestandsoverzicht

| # | File | LOC | Tabs / views | hex/rgba | Status |
|---|---|---:|---|---:|---|
| 1 | `mentor-grootboek.html` | 86 | redirect-card → `events.html#mentor-grootboek` | 4 | 🟢 **veilig** — warm-up |
| 2 | `mentoren-beheer.html` | 268 | hub met 5 iframe-tabs (`overview`/`payouts`/`funded`/`assessments`/`cash-trajects`) | 1 | 🟢 **veilig** — shell + injectie-CSS |
| 3 | `mentor-home.html` | 1253 | period-tabs day/week/month; agenda + coaching-earnings + inbox | 36 | 🟡 **grens** — mentor-facing cijfers |
| 4 | `mentor-dashboard.html` | 2115 | dashboard + verdiensten | 57 | 🟡 **grens** — bonus + payouts lees-endpoints |
| 5 | `mentor-students.html` | 1728 | studenten / 1on1 / noshows | 63 | 🟡 **grens** — invoice-resend triggert mail |
| 6 | `mentor-detail.html` | 780 | admin detail-view (secties, geen tabs) | 13 | 🔴 **payout-config-write** |
| 7 | `mentor-onboarding.html` | 2307 | students / inbox; `mo-filt` chips | 84 | 🔴 **credential-reset + inbox-send** |
| 8 | `mentor-payouts-admin.html` | 1354 | admin-list (goedkeuring / generate / mark-paid / revert) | 36 | 🔴 **geldstroom-writes** |
| 9 | `mentor-cash-trajects-admin.html` | 582 | admin-list (release-now / pause / resume) | 20 | 🔴 **geldvrijgave** |

**Totaal: 9 files, ~10.5K regels, 314 hex-hits.**

## Belangrijkste gevoeligheden

- **Cash / payout-write-paden** — `mentor-payouts-admin.html` (goedkeuring, generate, mark-paid, revert, bonus-release-sync) + `mentor-cash-trajects-admin.html` (release-now = geld vrijgeven). Elke wijziging riskeert **dubbele uitbetaling** of foute status. Alleen visueel-tokens, geen structuur/handler-refactor.
- **Payout-configuratie** — `mentor-detail.html` → `mentor-payout-config-set` + `mentor-recurring-save`. Formulier-refactor kan **silent config wijzigen**.
- **Invoice-resend + credential-reset** — `mentor-students.html` + `mentor-onboarding.html` — triggeren mails naar studenten/mentors.
- **Zelf-earnings dashboards** — `mentor-dashboard.html`, `mentor-home.html`: lees-endpoints, maar cijfer-rendering (`toFixed`, `Intl.NumberFormat`) niet aanraken.

## Aanbevolen PR-volgorde (klein → hoog risico)

| # | File | Effort | Risico |
|---|---|---|---|
| M1 | `mentor-grootboek.html` — warm-up | 15 min | ⚫ nul (redirect-card) |
| M2 | `mentoren-beheer.html` — hub-shell | 30 min | 🟢 laag (iframes ongewijzigd) |
| M3 | `mentor-home.html` | 1u | 🟡 medium (mentor-facing) |
| M4 | `mentor-dashboard.html` | 1-2u | 🟡 medium (verdiensten-tab) |
| M5 | `mentor-students.html` | 1-2u | 🟡 medium (invoice-resend label + endpoint intact) |
| M6 | `mentor-onboarding.html` | 2u | 🔴 hoog (inbox-render + credential-reset) — inbox-code eerst extractrn of samen met events-inbox tokeniseren om drift te voorkomen |
| M7 | `mentor-detail.html` | 1u | 🔴 hoog (payout-config-set achter feature-flag) |
| M8 | `mentor-cash-trajects-admin.html` | 1-2u | 🔴 hoog (release/pause/resume-flow test) |
| M9 | `mentor-payouts-admin.html` | 2u | 🔴 hoog (release-notes + regressie-check op geldbedragen verplicht) |

**Totale scope:** ~10-13u verspreid over meerdere sessies.

## Uit-scope

- **Endpoint-contract-wijzigingen**: geen enkele write-endpoint aanraken.
- **Cijfer-format-refactor**: `toFixed`, `Intl.NumberFormat`, valuta-render blijven letterlijk zoals ze zijn.
- **Payout-config-form-refactor**: alleen styling, geen field-toevoegingen/verplaatsingen.
- **RBAC-gates**: eventuele rol-checks (`admin.mentor.*`, `mentor.*`) niet strippen.

## Notities voor de volgende run

- Gedeelde CSS-basis: `/modules/shared/agent-shared.css` + shared sidebar/theme via `shared/{sidebar,theme-shared,permissions}.js`.
- Er is **geen** `shared/finance-views/mentor-*.js` — alles zit in de HTML-files zelf. Refactor naar shared component is aparte scope, niet nodig voor re-skin.
- Inbox-render in `mentor-onboarding.html` deelt code met `events.html` + `onboarding-admin.html` — zie events-inventaris.
