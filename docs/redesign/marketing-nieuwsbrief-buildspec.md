# Marketing-rolpagina + Nieuwsbrief-view — build-spec (DEEL C.2)

**Status:** SPEC voor go/no-go — deze features **bestaan niet** in de repo. `ls modules/*.html | grep -iE "nieuw|newsletter|rol"` = leeg. Dit doc beschrijft wat bouwen kost, geen implementatie.

---

## 1. Marketing-rolpagina

### Doel (aanname)
Een centrale hub voor de "marketing"-rol (per RBAC) die alle marketing-tooling bundelt: Meta-Ads-dashboard + Meta-Ads-studio + Lisa (Instagram) + Nieuwsbrief. Nu leven die als losse pagina's zonder gedeelde landing.

### UI-scope
- Header met periode-picker (7d/30d/kwartaal/YTD)
- 4 KPI-tiles: leads (uit `leads.source='meta_ads'`), campagnes-actief, Lisa-gesprekken (uit `lisa_conversations`), nieuwsbrief-open-rate (nieuw!)
- Link-tiles naar bestaande modules (Meta-Ads / Studio / Lisa / Nieuwsbrief) met per-tile klein-signaal ("3 nieuwe leads", "2 campagnes below CPL-target")
- Activity-feed (laatste 20 marketing-events: nieuwe leads, ad-alerts, Lisa-handoffs, nieuwsbrief-send)

### Endpoints (nieuw + hergebruik)
| Endpoint | Nieuw? | Notes |
|---|---|---|
| `api/marketing-dashboard-stats.js` | **NIEUW** | Aggregeer KPI's per periode. Query 4 bronnen (leads/meta_campaigns/lisa_conversations/newsletter_sends). ~150r. |
| `api/marketing-activity-feed.js` | **NIEUW** | Union van 4 event-bronnen, order by created_at DESC, limit 20. ~100r. |
| `api/meta-ads-*` | bestaand | link-tiles gebruiken bestaande counts |
| `api/lisa-*` | bestaand | idem |

### RBAC
Nieuwe permission-key: `marketing.dashboard.view` — grant aan rol `marketing` (bestaat als profiel-rol al?) en admin-rollen. Toevoegen aan `admin.html` PERMISSION_CATALOG + `has_any_role`-check op endpoints.

### Bestanden
- `modules/marketing.html` (~600r, DS-tokens, dashboard-shell + KPI-strip + tiles + feed)
- `api/marketing-dashboard-stats.js` + `api/marketing-activity-feed.js`
- SQL: geen nieuwe tabellen (aggregate over bestaande)
- Sidebar-entry in `modules/shared/sidebar.js` conditioneel op `marketing.dashboard.view`

### Effort
| | Uren |
|---|---|
| Backend (2 endpoints + RBAC-plumbing + tests) | 4–6 |
| Frontend (marketing.html + wiring + auth-gate) | 4–6 |
| Design-pass (DS-tokens, mobile) | 2 |
| Review/deploy/monitor | 1 |
| **Totaal** | **~12–15 uur** |

### Risico's / open vragen
- **Marketing-rol bestaat**? Grep `role.*marketing` returns geen match in profiles-migraties. Zonder rol → geen echte gebruiker. Beslissing nodig: voegen we de rol toe (migratie: profiles.role CHECK uitbreiden), of grant je `marketing.dashboard.view` aan bestaande rollen (bv. manager+admin)?
- **Newsletter open-rate**: KPI vereist een newsletter-send-log met per-recipient `opened_at`. Zie §2 hieronder — beide moeten gelijktijdig opgeleverd worden, anders is de tile leeg.

---

## 2. Nieuwsbrief-view

### Doel (aanname uit briefing: "cosmetisch; geen verzend-actie bouwen")
Alleen-lezen dashboard van nieuwsbrief-campagnes. Wat er is versturen (via extern platform: Mailchimp / GHL / Beehiiv?) hoeft NIET aan te sluiten — puur inzicht in wat gestuurd is + open/click-KPI's.

### UI-scope
- Lijst van campagnes (kolommen: naam / verstuurd op / verstuurd naar / open-rate / click-rate / status)
- Filter-strip (status: draft / sent / scheduled; periode)
- Detail-modal per campagne: subject-line + body-preview (iframe of rendered HTML) + per-recipient log (verstuurd/geopend/geklikt)
- **Geen** compose/send/schedule-flow — dat blijft in extern platform

### Endpoints (nieuw)
| Endpoint | Notes |
|---|---|
| `api/newsletter-campaigns-list.js` | GET, RBAC-gate, order by sent_at DESC |
| `api/newsletter-campaign-detail.js?id=<uuid>` | GET met per-recipient join |

### Data-bron (KRITIEK — nog te beslissen)

**Optie A: Extern platform sync**
Bron = Mailchimp/GHL/Beehiiv API. Endpoint pulls periodiek naar lokale tabellen. Toevoegen: `newsletter_sync` cron + `newsletter_platform_config` app_setting. Complexer maar geeft complete audit-log.

**Optie B: In-house minimaal**
Bron = alleen wat we intern versturen. Nieuwe tabellen `newsletters` + `newsletter_recipients` + `newsletter_events`. Vereist een verzend-mechanisme (dus toch build) OF een handmatige "log-vorige-campagne"-flow. Minder waardevol als je nooit intern verstuurt.

**Optie C: Read-only iframe embed**
Als het externe platform een dashboard-URL heeft: iframe die. 0 endpoints nodig. Alleen `modules/newsletter.html` met een `<iframe>` + auth-check. **Kost: 1u**. Enige nadeel: geen unified filter/search met rest platform.

### Bestanden (Optie A/B)
- `modules/newsletter.html` (~500r)
- 2 endpoints (A: sync-cron + list/detail = 3 endpoints; B: 2 endpoints)
- SQL-migratie (nieuwe tabellen)
- Sidebar-entry

### Effort
| Optie | Uren |
|---|---|
| A (extern sync) | 20–30 (afhankelijk van platform-API-complexiteit) |
| B (in-house minimaal) | 10–15 |
| C (iframe embed) | 1–2 |

### Vraag voor go/no-go
1. **Verstuur je nu al nieuwsbrieven?** Zo ja, welk platform?
2. **Wat is de primaire vraag** die de view moet beantwoorden? "Wat heb ik verstuurd" (log-view) vs "Hoe goed presteren mijn nieuwsbrieven" (analytics-view) vs "Ik wil planning zien" (kalender)?
3. **Marketing-rol** komt er sowieso als je dashboard-tile met "open-rate" wilt — zonder rol/RBAC is die tile voor iedereen (geen probleem?)

---

## Aanbeveling

**Fase 1 (klein, 1 sprint):**
- Marketing-rolpagina zonder nieuwsbrief-tile (of met tile die "niet geconfigureerd" toont)
- Nieuwsbrief = Optie C (iframe) als je een extern dashboard hebt, anders skip

**Fase 2 (afhankelijk van antwoorden op vragen):**
- Nieuwsbrief-view Optie A of B na go-beslissing op platform-strategie

Bij twijfel: bouw eerst een minimale marketing-hub (zonder nieuwsbrief-tile) — dat is een concreet-nuttige delta van ~12u. Nieuwsbrief-scope leek al vermeld als "cosmetisch geen verzend" — dat gaat waarschijnlijk richting Optie C.
