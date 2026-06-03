# Sales Redesign — Test Plan

Test-cases per pagina voor de complete sales-redesign (`feature/sales-complete-redesign`, PR #79).
Test op de Vercel-preview: **https://forex-opleiding-int-git-ab64ff-de-forex-opleiding-bv-s-projects.vercel.app**

Behouden functionaliteit: zie [`docs/sales-ui-inventaris.md`](./sales-ui-inventaris.md).

## Status per fase
| Fase | Scope | Status |
|---|---|---|
| A | Design-system CSS + Dashboard-tab + redirect | ✅ klaar |
| B.1 | Offertes-tab + label-fix + badge-fix | ✅ klaar |
| B.2/B.3 | Klanten + Abonnementen + Retentie (+mentor) | ✅ klaar |
| B.4/B.5 | Aanbod (merge + BTW-toggle) + Rapporten | ✅ klaar |
| C.2 | Offerte-detail reskin | ✅ klaar |
| E | Onboarding eigen module + sidebar + redirect | ✅ klaar |
| G | Docs + PR | ✅ klaar |
| **C.1** | **Klant-detail 6-tab visuele reskin + Abonnement-card** | ⏳ functioneel intact, visuele reskin nog te doen |
| **D.1/D.2** | **Sales-wizard + subscription-wizard visuele reskin** | ⏳ functioneel intact, visuele reskin nog te doen |

---

## Sales — Dashboard (default landing)
- [ ] `/modules/sales.html` opent op Dashboard (niet Klanten).
- [ ] Volgende-afspraak banner toont naam + countdown, of "Geen geplande afspraken".
- [ ] Vandaag/Deze week/Werkvoorraad stats vullen zich.
- [ ] 4 metric-cards klikbaar → juiste bestemming (offertes / onboarding-module / retentie).
- [ ] "Wachten op subscription": avatars + "Omzetten naar abonnement"-knop.
- [ ] `/modules/sales-dashboard.html` → redirect naar `?tab=dashboard`.

## Sales — Klanten
- [ ] Filter strip: zoek + entiteit-dropdown + "Alleen mijne".
- [ ] Segment-pills met counts (Alle/Actief/In onboarding/Loopt af/Inactief); "Inactief" laadt gearchiveerden.
- [ ] sr-table: avatar + email, entiteit-tag, offertes-count, status-badge, laatste activiteit, verkoper, arrow → detail.
- [ ] Risico-badge bij `risk_tag_auto`.

## Sales — Offertes
- [ ] Segment-pills (status) + entiteit/verkoper-filter + "Alleen mijne" + zoek.
- [ ] Sorteerbaar op Bedrag + Datum.
- [ ] Per status correcte primary-actie + `ti-eye` + `↗TL` + 3-dots.
- [ ] **BUG 1:** getekende offerte toont **"Omzetten naar abonnement"**.
- [ ] **BUG 2:** status `accepted` toont badge **"Bevestigd"** (groen), niet rauwe tekst.
- [ ] Polling (30s) actief terwijl tab open.

## Sales — Abonnementen
- [ ] Segment-pills (Alle/Actief/Gepauzeerd/Geannuleerd) + zoek.
- [ ] sr-table: avatar+email, bedrijf-tag, omschrijving + TL/Lokaal, sorteerbaar bedrag/start.
- [ ] Detail-knop → klant-detail abonnementen-tab; 3-dots (Uitstellen/Verlengen/Status/Open TL/Verwijderen).
- [ ] Cancelled sub → acties "—". Verwijderen werkt (confirm + reload).

## Sales — Retentie
- [ ] Subtitle "X aflopend · Y urgent".
- [ ] Segment-pills (Alle/Urgent<14d/15-30dgn/Verlopen) + zoek.
- [ ] **Mentor-kolom** (avatar-sm + naam of "Niet toegewezen").
- [ ] "Tot einde"-badge met icon; urgente rij rood getint; Einddatum sorteerbaar.
- [ ] "Nieuwe offerte" → sales-wizard?customer_id=; 3-dots placeholders.

## Sales — Aanbod
- [ ] Sub-tabs Trajecten / Producten / Bonussen(disabled "Binnenkort").
- [ ] **BTW-toggle** wisselt productprijzen incl/excl; sticky na page-refresh (localStorage).
- [ ] Producten sr-table: categorie-icon, BTW-tag (0/9/21 kleuren), sorteerbare prijs, gearchiveerd=opacity, Bewerken + 3-dots.
- [ ] Trajecten card-layout met varianten; + Variant / Edit / + Nieuw traject.
- [ ] Oude `?tab=trajecten` / `?tab=producten` → `?tab=aanbod` (juiste sub).

## Sales — Rapporten
- [ ] Periode-pills met active-state + datum-range + group-by + Vernieuwen.
- [ ] 4 KPI-cards met icon/kleur.
- [ ] 4 charts laden op vaste hoogte (geen groei-loop, PR#78-fix intact).
- [ ] "Per sales-medewerker" tabel met avatars; Export Excel werkt (7 sheets).
- [ ] Alleen zichtbaar met `sales.reports.view`.

## Onboarding (eigen module)
- [ ] Sidebar-link "Onboarding" → `/modules/onboarding-overzicht.html` (active-highlight).
- [ ] sr-table: avatar, verkoper, traject, entiteit, status-badge, eerste call, mentor "Binnenkort".
- [ ] "Alleen mijne" + Vernieuwen werken.
- [ ] Oude `/modules/sales.html?tab=onboardings` → redirect naar de module.

## Klant-detail (`klanten.html?id=`) — ⏳ reskin pending
- [ ] (functioneel) 6 sub-tabs werken; Abonnementen-tab: Uitstellen/Verlengen/Verwijderen/bulk + caret-expand.
- [ ] (reskin TODO) header avatar-lg + badges; Abonnement-card in Profiel; Offertes-tab status-acties gelijk aan hoofd-tab.

## Offerte-detail (`offerte-detail.html?id=`)
- [ ] Header: status-tag + "TL gekoppeld" + meta (#OFF · Aangemaakt · Getekend).
- [ ] Klant-card (avatar, mailto/tel, risico) + Offerte-info-card.
- [ ] Producten sr-table (prijs excl, subtotaal, incl, BTW-tag).
- [ ] Totalen-card met BTW per tarief + totaal-box; Betalingsvoorwaarden-card.
- [ ] Status-acties per status (Concept/Verzonden/Bevestigd/Afgewezen) correct; "Omzetten naar abonnement" bij bevestigd; onboarding-knop onderdrukt bij Retentie.

## Sales-wizard (5 stappen) — ⏳ reskin pending
- [ ] (functioneel) 5 stappen + auto-save + dup-check + producten + betaling + submit werken ongewijzigd.

## Subscription-wizard (3 stappen, beide modes) — ⏳ reskin pending
- [ ] (functioneel) deal-mode + standalone-mode + multi-line + excl/incl + bonus + submit werken ongewijzigd.

## Bug-fix verificaties
- [ ] "Omzetten naar abonnement" overal (offertes-tabel + offerte-detail + dashboard pending).
- [ ] `accepted`-status → "Bevestigd"-badge (offertes-tab + klant-detail offertes).
