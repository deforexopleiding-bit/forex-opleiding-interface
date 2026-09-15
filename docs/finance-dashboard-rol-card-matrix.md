# Finance-dashboard rol × KPI-card matrix (voor jouw aftikking)

**Doel:** B4 uit werkpakket — sales ziet GEEN incasso/wanbetalers/dunning/joost-cards; super_admin+manager zien alles. Andere rollen (administratie, marketing, mentor) hebben nog geen expliciete Finance-toegang in de huidige `MOD_LOCK`/`TAB_RESTRICT`-config — deze matrix stelt voor wat ze zien als/wanneer ze wél toegang krijgen.

Bron: `modules/shared/finance-dashboard.js` regels 373–450 (11 KPI-cards + 1 MRR-card).

---

## Voorstel-matrix

Legenda: ✅ = kaart zichtbaar · ❌ = kaart verborgen (rol-filter)

| # | Card-label | Drilldown-target | super_admin | manager | sales | administratie | mentor |
|---|---|---|---|---|---|---|---|
| 1 | Totaal openstaand | facturen (alle) | ✅ | ✅ | ✅ | ✅ | ❌ |
| 2 | Open facturen | facturen (open) | ✅ | ✅ | ✅ | ✅ | ❌ |
| 3 | Te late facturen | facturen (overdue) | ✅ | ✅ | ✅ | ✅ | ❌ |
| 4 | **Actieve arrangements** | wanbetalers > arrangements | ✅ | ✅ | **❌** | ✅ | ❌ |
| 5 | **Open verify-payment** | wanbetalers > open-acties | ✅ | ✅ | **❌** | ✅ | ❌ |
| 6 | **Open escalaties** | wanbetalers > open-acties | ✅ | ✅ | **❌** | ✅ | ❌ |
| 7 | Bank-balans | bank | ✅ | ✅ | ❌ | ✅ | ❌ |
| 8 | Cashflow 30 dagen | facturen | ✅ | ✅ | ✅ | ✅ | ❌ |
| 9 | **Joost autonoom verzonden** | wanbetalers > inbox | ✅ | ✅ | **❌** | ✅ | ❌ |
| 10 | **Conversie wanbetaler-flow** | wanbetalers > overzicht | ✅ | ✅ | **❌** | ✅ | ❌ |
| 11 | Mentor-bonus pending | — | ✅ | ✅ | ❌ | ✅ | ❌ (mentor ziet eigen bonus in mentor-portal) |
| 12 | MRR uit subscriptions | — | ✅ | ✅ | ✅ | ✅ | ❌ |

**Vetgedrukt** = de 5 "incasso/wanbetalers/dunning/joost"-cards die volgens jouw voorwaarde voor sales verborgen moeten zijn.

---

## Consistentie-checks

**Sales zichtbaar:** kaarten 1, 2, 3, 8, 12 (5 stuks).
- **Rechtvaardiging:** sales heeft toegang tot Finance-tab (SAMS in `app-shell.js`) maar **niet** tot de wanbetalers-tabs (`finance/Bank` en `finance/Omzet & MRR` reeds via TAB_RESTRICT beperkt tot super_admin+manager) — MRR is uitzondering vanwege sales-omzet-context; check of `finance/Omzet & MRR` gedrag consistent moet blijven met dashboard-tegel.
- **Vraag:** moet sales ook "Bank-balans" (kaart 7) zien? Nu voorgesteld ❌ omdat `finance/Bank`-tab al TAB_RESTRICT'd is voor sales — consistent. Als je "ja" wilt, dan moet ook TAB_RESTRICT eraf.
- **Vraag:** "Mentor-bonus pending" (kaart 11) — hoort dit sowieso op finance-dashboard voor sales, of alleen voor managers/administratie? Voorgesteld ❌ voor sales.

**Administratie:** zie ik als "backoffice-financieel" — mag alles zien maar niet noodzakelijk muteren. Als administratie momenteel geen Finance-toegang heeft, is deze kolom hypothetisch tot toegang wordt verleend.

**Mentor:** heeft eigen mentor-portal met bonus-info; op Finance-dashboard krijgt de mentor nu geen toegang tot Finance-module (roles: `['mentor']` in `verdiensten`-module). Alle ❌.

---

## Implementatie-schets (na jouw aftikking)

**Locatie:** `modules/shared/finance-dashboard.js` — `mount()` accepteert `profile.role` (of `profile.roles[]`) mee. In de KPI-array (r377+) elke card een `visibleFor?: string[]`-veld:

```js
{ key: 'topDebtors', label: 'Actieve arrangements', target: {...},
  visibleFor: ['super_admin', 'manager', 'administratie'] },
```

`visibleFor === undefined` → altijd zichtbaar (default). Bij render: `cards.filter(c => !c.visibleFor || c.visibleFor.includes(currentRole))`.

**Endpoint-impact:** géén. Alle counts komen uit dezelfde `/api/finance-dashboard-stats`-endpoint. Het filter is puur client-side rendering — de counts worden nog steeds geladen voor iedereen die het endpoint mag callen. Als de RBAC op de endpoint zelf verscherpt moet worden (bv. sales mag geen `topDebtors`-count zien in de HTTP-response), is dat een aparte PR (backend-scope).

**Alternatief (server-side rol-filter in counts-endpoint):** duurder — vergt endpoint-refactor + RBAC-check per count. Voorlopig client-side filter voor Fase 4B, server-side hardening als aparte PR.

---

## Aan jou

- **Aftikken/aanpassen** per rij per rol (of accepteer voorstel).
- **Beslis specifiek:**
  1. Sales zichtbaarheid van "Bank-balans" (kaart 7): ❌ nu, of ✅?
  2. Sales zichtbaarheid van "Mentor-bonus pending" (kaart 11): ❌ nu, of ✅?
  3. Administratie-kolom: hypothetisch of moet ik ook `MOD_LOCK`/`app-shell.js` bijwerken om administratie-rol Finance-toegang te geven?
  4. Server-side vs client-side filter: mag counts-endpoint dezelfde data teruggeven aan iedereen (client verbergt cards), of moet endpoint zelf 403/nul-tellen voor niet-geautoriseerde cards?

Zodra afgetikt bouw ik B4 als kleine self-mergebare PR: `visibleFor`-veld + render-filter + smoke-test dat sales inderdaad kaarten 4/5/6/9/10 niet ziet.
