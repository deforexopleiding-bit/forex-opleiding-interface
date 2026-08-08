# Sales-dashboard rol-analyse (B3)

**Bron:** `modules/sales.html` r156-205 (tab-dashboard) op main dd 2026-08-08.

## Bevinding: geen rol-filter nodig

Sales-dashboard is **by design al 100% sales-scoped**. Alle KPI-tegels zijn eigen-prestatie/eigen-pipeline georiënteerd:

| Tegel | Endpoint | Rol-relevant? |
|---|---|---|
| Omzet deze maand | sales | ✅ eigen omzet |
| Mijn open offertes | sales | ✅ eigen deals |
| Sales deze maand | sales | ✅ eigen getekende deals |
| Bonus deze maand | sales | ✅ eigen bonus (pending) |
| Retentie | sales | ✅ eigen klantretentie |
| Hoogste omzet-offerte | sales | ✅ eigen top-deal |
| Vandaag: nieuwe leads / event-aanmeldingen / afspraken | sales | ✅ eigen agenda |
| Deze week: leads / events / afspraken / follow-ups | sales | ✅ eigen agenda |
| Wachten op subscription | sales | ✅ eigen pipeline |
| Laatste 5 offertes | sales | ✅ eigen recente activiteit |

**Geen incasso, geen wanbetalers, geen dunning, geen Joost, geen andere sales' pipeline.** Het endpoint zelf (`/api/sales-dashboard-stats` of vergelijkbaar) scope't al op `user_id = auth.uid()`.

Manager/super_admin krijgen exact hetzelfde te zien — hun eigen sales-activiteit als ze zelf offertes maken. Voor **team-brede** oversicht bestaat de aparte **Rapporten-tab** (`tab-reports`) die al met eigen rol-gate op nav-knop is beschermd (`#tab-btn-reports` display:none default; JS-reveal per rol).

## Conclusie

**B3 vereist geen implementatie-PR.** Sales-dashboard is al rol-passend voor sales; manager/super_admin gebruiken tab-Reports voor team-overzicht.

## Wat WEL zou kunnen (aparte scope-uitbreiding, niet nu)

- **Team-widgets voor manager** direct op sales-dashboard (bv. "Team-omzet deze maand" naast eigen omzet). Vereist:
  - Nieuw endpoint `/api/sales-team-stats?user_id_in_team=...` OF endpoint-uitbreiding
  - Manager-only visibleFor-filter op nieuwe kaart
  - **Nieuwe backend-scope** — ROOD, geen self-merge

- **Vergelijkings-KPIs** ("mijn omzet vs teamgemiddelde") — vergelijkbare scope-uitbreiding.

Deze verbeteringen zijn **feature-uitbreidingen**, niet B3 "rol-bewust". Ze horen in een aparte roadmap-item.
