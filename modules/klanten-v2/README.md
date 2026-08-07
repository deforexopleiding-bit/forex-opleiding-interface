# Klanten-v2 (preview)

Preview-versie van de Klanten-module, herbouwd bovenop het nieuwe design-system.
Bestaat naast het oude scherm ([`modules/klanten.html`](../klanten.html)) totdat de
opdrachtgever het akkoord geeft om over te schakelen.

## Waar leeft dit
- Route: `/modules/klanten-v2/index.html` (zit NIET in de zijbalk; alleen via
  directe URL bereikbaar zolang v2 in preview zit).
- Shared design-tokens: [`../shared/design-system/tokens.css`](../shared/design-system/tokens.css)
- Shared componenten:      [`../shared/design-system/components.css`](../shared/design-system/components.css)
- Shared theme-toggle:     [`../shared/design-system/theme.js`](../shared/design-system/theme.js)
- Auth (bestaand):         [`../shared/supabase-client.js`](../shared/supabase-client.js)

Overige modules (Sales-v2, Finance-v2, Wanbetalers-v2) hergebruiken straks
dezelfde tokens + componenten. Alleen de module-accent (`--m`) wisselt.

## Kleur-toewijzing per module (voorstel)
| Module        | Accent    |
| ------------- | --------- |
| Sales-v2      | blue      |
| Klanten-v2    | emerald   |
| Finance-v2    | amber     |
| Wanbetalers   | violet    |

## Route-shell
Query-params:
- `?id=<uuid>`      — detail-view (PR-B, nu placeholder)
- `?tab=<slug>`     — tab binnen detail-view (PR-B)

Zonder params = lijst-view.

## Dark-mode
- Toggle-knop in de sidebar-foot (naast user-avatar).
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
