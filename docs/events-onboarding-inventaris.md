# Events + Onboarding-cluster inventaris (re-skin scope-doc)

**Bronnen:** alle `modules/events*.html` + `modules/onboarding*.html` op main dd 2026-08-08. Analoog aan finance/sales/mentor inventarissen.

## Bestandsoverzicht

| # | File | LOC | Tabs / views | hex/rgba | Status |
|---|---|---:|---|---:|---|
| 1 | `events-wizard.html` | 556 | single-flow create-wizard | 10 | 🟢 **veilig** — geïsoleerde flow |
| 2 | `events.html` | 5947 | overzicht / inbox / signup-inbox / mentor-grootboek; iframe-embed automations | 169 | 🟡 **grens** — grote shell, deel-tabs |
| 3 | `events-detail.html` | 3416 | info / attendees / mentors / audit | 86 | 🔴 **lifecycle-writes** — publish/complete/close/reopen, send-invite/questionnaire |
| 4 | `events-automations.html` | 1819 | list + editors (runs/test/edit/att-lib) | 28 | 🔴 **automation-editors** — test-runs versturen echt |
| 5 | `onboarding.html` (externe wizard) | 1536 | kandidaat-facing; eigen `:root` (niet gedeeld met admin) | 58 | 🟡 **grens** — mobile safe-area + 100dvh test |
| 6 | `onboarding-hub.html` | 532 | 3 secties (overzicht/wizard/automations) mount-shell | 42 | 🟢 **veilig** — geen writes |
| 7 | `onboarding-admin.html` | 1828 | scope-tabs active/archived/inbox | 78 | 🔴 **invite + provisioning** — user-account writes |
| 8 | `onboarding-automations.html` | 1286 | list + editors | 26 | 🔴 **automation-editors** |
| 9 | `onboarding-wizard-editor.html` | 2035 | flow-tabs (o.a. membership), page-acts up/down/delete | 55 | 🟡 **grens** — publish-knop is direct live |

**Totaal: 9 files, ~19K regels, 552 hex-hits** — grootste re-skin-cluster tot nu toe.

## Belangrijkste gevoeligheden

- **Event-lifecycle writes** (`events-detail.html`): publish/complete/close-signups/reopen-signups + send-invite/send-questionnaire → cursisten krijgen mail bij verkeerde klik. **Bestaande RBAC-gating niet strippen.**
- **Automation-editors** (`events-automations.html` + `onboarding-automations.html`): slaan e-mail/WhatsApp-triggers op; test-runs versturen **echt**. Formulier-refactor kan template-vars silent breken.
- **Provisioning/invite** (`onboarding-admin.html`): `onboarding-invite-send`, `onboarding-provision-retry`, `onboarding-assign-mentor` → maakt user-accounts + koppelt mentor.
- **Wizard-publish** (`onboarding-wizard-editor.html`): `config-publish` is direct live voor kandidaten.
- **Externe wizard** (`onboarding.html`): eigen kleuren-`:root` (niet `var(--brand-*)`); re-skin moet apart getest op mobiel (`env(safe-area-inset-*)`, `100dvh` fallback).
- **Mentor-grootboek-tab in events.html**: leest `mentor-ledger-overview`; scope-gating `mentor.ledger.view` niet raken.

## Aanbevolen PR-volgorde

| # | File | Effort | Risico |
|---|---|---|---|
| E1 | `onboarding-hub.html` — mount-shell | 30 min | 🟢 laag (geen writes) |
| E2 | `events-wizard.html` — create-flow | 45 min | 🟢 laag (geïsoleerd) |
| E3 | `onboarding.html` — externe wizard | 1-2u | 🟡 medium (mobile smoke-test verplicht) |
| E4 | `onboarding-wizard-editor.html` — editor-chrome | 2u | 🟡 medium (publish-knop achter bestaand gate laten) |
| E5 | `events.html` — per tab in aparte commit binnen 1 PR: overzicht → inbox → signup-inbox → mentor-grootboek | 4-6u | 🟡 medium (iframe-embed automations NIET aanraken) |
| E6 | `onboarding-admin.html` — scope-tabs + list-rendering | 2-3u | 🔴 hoog (invite/provision/archive acties bevriezen) |
| E7 | `events-detail.html` — per tab-panel apart: info → mentors → attendees → audit | 3-4u | 🔴 hoog (send-invite/publish-buttons pas na rest groen) |
| E8 | `onboarding-automations.html` + `events-automations.html` — parallel of laatst | 3-4u | 🔴 hoog (dry-run + stg-mailserver test verplicht) |

**Totale scope:** ~16-22u verspreid over meerdere sessies.

## Belangrijke uitvoerings-notities

- **Inbox-render-drift**: prefix `evx-` / `oi-` / `mo-` (events / onboarding-admin / mentor-onboarding) — inbox-CSS + markup is **verbatim gekopieerd** tussen deze 3 files. Twee opties vóór je één ervan aanraakt:
  1. **Extract eerst** naar `shared/inbox-render.js` (aparte scope; zwaar).
  2. **Consequent op tokens zetten** — in 1 PR alle 3 tegelijk om drift te voorkomen.
- **Iframe-embed automations** in `events.html` (`events-automations.html?embed=1`): de embed-parent (events.html) mag niet raken op de embed-view; alleen inhoudelijke re-skin van `events-automations.html` zelf.
- **Externe wizard `onboarding.html`**: heeft eigen `:root { --brand: ... }` in de HTML zelf. Migratie naar shared DS-tokens vereist mapping-tabel (bijv. `--brand → var(--m)` waar --m module-accent is).

## Hex-hotspots (>60)

1. `events.html` — 169
2. `events-detail.html` — 86
3. `mentor-onboarding.html` — 84 (in mentor-inventaris)
4. `onboarding-admin.html` — 78
5. `mentor-students.html` — 63 (in mentor-inventaris)

Verwacht meeste review-tijd hier.

## Uit-scope

- **Endpoint-refactors**: geen enkele write-endpoint aanraken.
- **Inbox-shared extract**: aparte PR-track, niet in re-skin.
- **RBAC-gates**: niet strippen.
