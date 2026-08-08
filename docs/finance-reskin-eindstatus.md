# Finance-module re-skin — eindstatus (uit inventaris #1157)

**Sessies:** 2026-08-08 twee autonome runs.

## ✅ Wat is getokeniseerd (self-merged)

| # | View | PR | Wijziging |
|---|---|---|---|
| 1 | view-roadmap | #1159 | 6 rgba/hex-clusters → amber/slate/teal tokens (36 regels) |
| 2 | view-camtbank + view-uitgaven | #1160 (pass 1) + #1162 (pass 2) | Banners, saldo-cards, AI-cluster, submit-buttons |
| 3 | view-creditnotes | #1161 | KPI + error-banner → rose |
| 4 | view-facturen | ⏭️ overgeslagen | 2 subtle rgba's met defensive fallback; geen re-skin-winst |
| 5 | view-dashboard cosmetisch | ⏭️ **niets te doen** | shared/finance-dashboard.js 100% defensive `var(--x, fallback)`; chart-fills zijn Recharts-props (string, geen CSS-vars) |
| 6 | view-instellingen | #1164 (pass 1) + #1166 (pass 2) + #1172 (pass 3) + #1174 (pass 4) | Status-colors, WA-mapping banner, WA-status-map, action-buttons, chips |
| 7 | view-klanten host | #1163 | 9 pill-klassen (finance-klanten.js) → tokens |
| 8 | view-bank | #1167 | Banners + balance-card → tokens (niet deprecated, actief in gebruik) |

**Totaal: 10 self-merged PRs** deze cyclus.

## ⏭️ Bewust overgeslagen (met reden)

- **Chart PALETTE / Chart.js chart-fills** (finance-dashboard.js, sales.html): worden aan chart-libraries als string doorgegeven — CSS-vars werken niet. Vergt `getComputedStyle`-hack per mount = extra scope + regressie-risico.
- **Defensive fallbacks** (form-error, sr-segment, fi-tab.active, decision-rows Joost-config, invSyncSummary, div veel andere hits): syntax `var(--x, var(--y, #hex))` = al DS-compliant, wijzigen geeft geen visueel resultaat.
- **WhatsApp bubble merkkleuren** (`#d9fdd3` groen, `#e5ddd5` wallpaper): imitatie van WhatsApp-merkbeeld, niet tokeniseerbaar zonder afwijking van bekende UX.
- **Modal-scrims** (`rgba(0,0,0,.5)`): geen semantisch DS-token voor scrim; laten.

## 🔴 Off-limits gebleven (nooit aangeraakt)

- **view-wanbetalers** (r4294-4382)
- **view-inbox** (r4895-5101)
- **view-dunning** (r5102-5474)
- **view-arrangements** (r5429+)
- Alle `api/dunning-*`, `api/finance-dunning-*`, `api/cron-dunning-*`, `api/joost-*`, `api/voys-*`, `api/arrangements-*`, `api/pending-actions-*`, `api/_lib/dunning-*`, `api/_lib/joost-*`
- `modules/shared/klx-softphone.*`
- `modules/klanten.html`

Per-PR `git diff --stat` op deze zones altijd leeg.

## Nog open (wacht op input)

- **B4 Finance-dashboard rol-filter** (client-side visibleFor per KPI-card, sales ziet geen incasso/wanbetalers/dunning/joost) — matrix-PR #1165 wacht op jouw aftik van 4 keuze-vragen.

## Wrap-up

Finance-module cosmetisch af binnen safe scope. Volgende cyclus: B4 rol-filter (na aftik) + mentor/events-onboarding (aparte inventarissen).
