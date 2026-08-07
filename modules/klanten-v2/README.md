# Klanten-v2 (preview)

Preview-versie van de Klanten-module, herbouwd bovenop het redesign-fundament
(Fase 0). Bestaat naast het oude scherm ([`modules/klanten.html`](../klanten.html))
totdat de opdrachtgever het akkoord geeft om over te schakelen.

## Waar leeft dit
- Route: `/modules/klanten-v2/index.html` (zit NIET in de zijbalk; alleen via
  directe URL bereikbaar zolang v2 in preview zit).
- Gedeelde tokens:     [`../shared/design-system/tokens.css`](../shared/design-system/tokens.css) (PR 0-B1)
- Gedeelde app-shell:  [`../shared/design-system/app-shell.css`](../shared/design-system/app-shell.css) + [`app-shell.js`](../shared/design-system/app-shell.js) (PR 0-B2)
- Gedeelde componenten: [`../shared/design-system/components.css`](../shared/design-system/components.css) (PR 0-C — content-level primitives .ds-*)
- Iconen:              [`../shared/design-system/icons.js`](../shared/design-system/icons.js) (PR 0-B2)
- Auth (bestaand):     [`../shared/supabase-client.js`](../shared/supabase-client.js)

Overige modules (Sales-v2, Finance-v2, Wanbetalers-v2) hergebruiken straks
dezelfde 4 shared files. De module-accent wordt automatisch gezet door
`DFO.applyColor()` op basis van `MODS[id='klanten'].color` in app-shell.js.

## Kleur-toewijzing per module (uit MODS in app-shell.js)
| Module        | Accent    |
| ------------- | --------- |
| Klanten-v2    | emerald   |
| Sales-v2      | blue      |
| Finance-v2    | blue      |
| Wanbetalers   | rose      |

## Route-shell
Query-params:
- `?id=<uuid>`      — detail-view (PR-B, nu placeholder)
- `?tab=<slug>`     — tab binnen detail-view (PR-B)

Zonder params = lijst-view. `popstate` triggert `DFO.render()` zodat back/forward
netjes tussen lijst en detail wisselt.

## Dark-mode
Geleverd door de gedeelde shell (`DFO.toggleTheme()` in de sidebar-foot):
- Keuze opgeslagen in `localStorage["dfo-crm-theme"]`.
- Geen `prefers-color-scheme`-detect (opdrachtgevers-keuze 2026-08-06).
- FOUC-preventie: inline `<script>` in `<head>` van `index.html` zet
  `data-theme` vóór het CSS-laden.

## Scope PR-A vs PR-B vs PR-C
| PR   | Scope                                                                     |
| ---- | ------------------------------------------------------------------------- |
| PR-A | Skeleton (sidebar, topbar, routing, dark-mode) + Lijst-view compleet.     |
| PR-B | Dossier/Detail-view + 7 tabs (Profiel, Communicatie, Offertes, Abonnementen, Facturen, Wanbetalers, Audit). |
| PR-C | Modals (create/edit klant, archiveren, dupliceren, bulk-tag, bulk-archiveer, koppel-bedrijf). |

Zie [`docs/redesign/INVENTARIS.md`](../../docs/redesign/INVENTARIS.md) (branch
`docs/redesign-inventaris-fase1`, PR #1111) voor de complete 188-items
Klanten-checklist. Elke PR-body dekt de items die die PR closet.
