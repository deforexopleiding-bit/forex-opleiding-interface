# Sales-module tab-inventaris (re-skin scope-doc)

**Bron:** `modules/sales.html` (2207r) op main dd 2026-08-08. Analoog aan finance-inventaris #1157.

Doel: vaststellen welke tabs veilig incrementeel re-skinbaar zijn en welke stukken gevoelig zijn. Één PR per tab of cluster.

---

## Tab-registratie

| # | Tab | Regel-range (start) | Nav-knop | Status | Toelichting |
|---|---|---|---|---|---|
| 1 | tab-dashboard   | r156 | Dashboard (default active) | 🟢 **veilig** | Sales-KPIs (verkoop, deals, conversie). B3 rol-bewust filter komt hier bovenop. |
| 2 | tab-customers   | r206 | Klanten          | 🟢 **veilig** | Klanten-lijst-preview binnen sales. |
| 3 | tab-quotations  | r224 | Offertes         | 🟢 **veilig** | Offertes-lijst + status-pills. |
| 4 | tab-subscriptions | r257 | Abonnementen   | 🟢 **veilig** | Subscription-list + termijn-overzicht. |
| 5 | tab-retentie    | r274 | Retentie         | 🟡 **grens** | Verzachtings-/follow-up flow met bel-CTA's; **koppelt aan follow-up-endpoints** (buiten dunning-zone). Visuele wijzigingen OK; endpoints niet aanraken. |
| 6 | tab-aanbod      | r296 | Aanbod           | 🟢 **veilig** | Product-catalogus. |
| 7 | tab-reports     | r327 | Rapporten        | 🟢 **veilig** | Verkoopprestaties + bonus-overzicht. `#tab-btn-reports` heeft rol-gate (display:none default; JS-reveal per rol). Re-skin raakt gate NIET. |

**Beschermde regels** (elders in codebase, niet in sales.html): `api/dunning-*`, `api/joost-*`, `api/voys-*`, `api/arrangements-*`, `api/pending-actions-*`, `api/_lib/dunning-*`, `api/_lib/joost-*`, `modules/klanten.html`, `modules/finance.html` (met specifieke uitzonderingen). Sales.html zelf staat NIET in de beschermde zone — vrij te re-skinnen.

---

## Hex-inventaris (30 hits totaal, gegroepeerd)

### Groep A — Head-CSS (r24-95) — deels defensive, deels re-skinbaar
- `.tab.active`, `.search:focus`, `.btn`: **defensive** (`var(--ds-brand, var(--accent, #093d54))`). **Overslaan** — al DS-compliant.
- `.btn-danger`, `.err`, `.toast.error/.success`: **defensive** met `var(--red, #dc2626)` / `var(--green, #059669)`. **Overslaan**.
- `.badge.vat-0/vat-9/vat-21/active/archived/risk` (r48-54): **hardcoded rgba+hex** → tokeniseren naar emerald/teal/violet/slate/rose. ⭐ **hoge winst**.
- `.modal-overlay`, `.toast`, `box-shadow`: `rgba(0,0,0,x)` scrim/shadow — semantisch geen accent, laten.

### Groep B — Inline styles per tab
- r244 `#f59e0b` alert-triangle icoon in retentie-blok → `var(--amber)` ⭐
- r400 `#dc2626` sendErr color (defensive fallback aanwezig) → skip
- r1029 `#f87171` "geen abo"-tag → `var(--rose)` (of licht-rose) 
- r1368-1370 retentie-tabel: follow-up-tag `rgba(34,197,94,.14)` + `#15803d` + urgent-row `rgba(220,38,38,.05)` → tokeniseren naar emerald/rose ⭐
- r1742 verwijder-knop `color:#dc2626` → `var(--rose)` ⭐
- r1977 reports-tabel bonus-kleuren: `#b45309` (amber) + `#059669` (emerald) → tokens ⭐
- r2078 klant-notitie card: `var(--accent-cyan)` (al DS) → skip

### Groep C — Chart PALETTE (r1781)
```js
const PALETTE = ['#0891b2', '#059669', '#f59e0b', '#dc2626', '#7c3aed', '#0ea5e9', '#db2777', '#65a30d'];
```
Wordt doorgegeven aan Chart.js `borderColor/backgroundColor/pointBackgroundColor`. **Chart-props verwachten string** (Chart.js parseert 'em zelf), niet CSS-vars. Zonder chart-refactor met `getComputedStyle`-hack niet tokeniseerbaar. **Overslaan** — analoog aan finance-dashboard chart-decision.

### Groep D — MRR/reports charts (r1861, r1862, r2002)
- `borderColor: PALETTE[N]` + `backgroundColor: 'rgba(..,.12/.15)'`: hardcoded rgba samen met PALETTE[N]. **Overslaan** samen met PALETTE.

### Groep E — Fullscreen-overlay backdrops (r983, r1876)
- `background:rgba(0,0,0,.5/.45)`: standaard modal-scrim. Er is geen DS-token voor scrim; laten.

---

## Aanbevolen PR-volgorde

| # | Scope | Winst | Complexiteit |
|---|---|---|---|
| **PR-S1** | Groep A `.badge.*`-classes (r48-54): 5 pill-klassen | ⭐⭐⭐ visueel merkbaar op elke tab | Klein — CSS-only in `<style>`-block |
| **PR-S2** | Inline styles verspreid (Groep B): 6 hunks | ⭐⭐ semantisch clean-up | Medium — per-hunk unique-context edits |
| **PR-S3** | B3 Sales-dashboard rol-bewust | ⭐⭐⭐ direct gedragsverbetering | Medium — nieuw rol-filter op tab-dashboard KPIs |

Chart-cluster (Groep C + D) blijft **niet-tokeniseerbaar** zonder refactor — bewust overgeslagen.

---

## Wat NIET in deze scope zit

- **Gedrag/JS-refactor**: geen event-handler-wijzigingen, geen state-machine-refactors, geen endpoint-contract-wijzigingen.
- **tab-btn-reports rol-gate**: bestaande JS-reveal-logica per rol blijft ongewijzigd.
- **Retentie-tab endpoints**: follow-up-endpoints niet aanraken (visueel wel, gedrag niet).
- **Chart-refactor**: Chart.js PALETTE tokeniseren vergt `getComputedStyle`-hack per mount — aparte scope-beslissing.

---

## Effort per PR

| PR | Effort |
|---|---|
| PR-S1 (badges) | ~30 min |
| PR-S2 (inline-styles) | ~1u |
| PR-S3 (B3 rol-bewust) | ~1-2u (nieuwe rol-filter + smoke-test per rol) |

Totaal sales-re-skin scope: **~2-4u**.
