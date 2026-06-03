# Sales UI Inventaris

> Complete inventaris van álle bestaande UI-functies in de sales-omgeving, als checklist voor het herontwerp. **Geen code-wijzigingen** — alleen documentatie.
>
> **Geanalyseerd op:** branch `docs/sales-ui-inventaris` (gestapeld bovenop alle sales-PR's t/m `fix/rapporten-chart-height`). ⚠️ Let op: dit weerspiegelt de **laatste** stand van de feature-branches, niet `main` — `main` bevat de sales-stack (nog) niet.
>
> **Pagina's geanalyseerd:** 8 (sales.html, sales-dashboard.html, klanten.html, offerte-detail.html, sales-wizard.html, subscription-wizard.html, onboarding.html, admin.html-sales-rechten).
>
> **Badge-klassen (gedeeld):** `active` = groen · `cat` = neutraal grijs/cyaan · `archived` = faint grijs · `risk` = rood.

---

## sales.html

**Globale elementen**
- Titel "Sales", subtitel "Operationele klant-aanmaak + productcatalogus voor Dave's offertes."
- Globale header-knop (alle tabs): **`+ Nieuwe klant + offerte`** (`#newDealBtn`) → `/modules/sales-wizard.html`
- 8 tabs: Klanten · Offertes · Onboardings · Abonnementen · Retentie · Trajecten · Producten · Rapporten. **Rapporten** is `display:none` tenzij `sales.reports.view` (super_admin `*` telt mee).
- Deep-link `?tab=`: klanten/customers, offertes/quotations, onboardings, abonnementen/subscriptions, retentie, trajecten, producten/products, rapporten/reports.
- Offertes-tab polt elke 30s zolang open; stopt bij tab-switch.

### Tab: Klanten
- **Top acties:** geen tab-lokaal (globale `+ Nieuwe klant + offerte`).
- **Filters/zoek:** zoek `#custSearch` ("Zoek naam, email of telefoon...", debounce 250ms, server-side) · toggle **"Alleen mijn klanten"** (`owned_by_me=true`) · status-dropdown **"Actief"**(default)/**"Gearchiveerd"**.
- **Kolommen:** Naam · Email · Telefoon · Deals · Laatste deal · Einddatum abonnement · (acties).
- **Acties per rij:** naam-link → klant-detail · `👁` "Open detail" → `/modules/klanten.html?id=<id>` · `€` "Nieuwe offerte" → `/modules/sales-wizard.html?customer_id=<id>`.
- **Status/badges:** geen status-kolom; **`RISICO`** badge (rood) als `risk_tag_auto`.
- **Navigatie:** naam/`👁` → klanten.html?id ; `€` → sales-wizard?customer_id.

### Tab: Offertes
- **Top acties:** **`🔄 Vernieuwen`** (`#quotRefresh`).
- **Filters/zoek:** zoek `#quotSearch` ("Zoek klantnaam of email...") · status-dropdown: Alle/**Concept**(draft)/**Verzonden**(sent)/**Bevestigd**(accepted)/**Afgewezen**(declined)/**Verlopen**(expired) · toggle **"Alleen mijn offertes"**.
- **Kolommen:** Klant · Verkoper · Aangemaakt · Type traject · Bedrag incl. BTW · Status · (acties).
- **Acties per rij** (status-conditioneel via `quotationActions(q)`):
  - Altijd: `👁` "Offerte-detail" → `/modules/offerte-detail.html?id=<deal_id>`
  - Indien `tl_quotation_id`: `↗ TL` → `https://focus.teamleader.eu/quotations/<id>` (nieuwe tab)
  - **accepted/signed:** `👁` + **`Subscription invoeren`** (→ subscription-wizard?deal_id) + **`Bewerken`** (confirm: al getekend) + `↗ TL`
  - **sent:** `👁` + **`Opnieuw versturen`** (send-modal) + `↗ TL` + **`Verwijderen`**
  - **failed:** `👁` + **`Retry push`** (POST `/api/sales-deal-retry-push`) + **`Bewerken`** + **`Verwijderen`**
  - **draft + tl_quotation_id:** `👁` + **`Versturen`** (send-modal) + **`Bewerken`** + `↗ TL` + **`Verwijderen`**
  - **draft zonder tl_quotation_id:** `👁` + **`Push naar TL`** + **`Bewerken`** + **`Verwijderen`**
  - fallback: alleen `👁` + (TL).
  - `Bewerken` → `/modules/sales-wizard.html?edit_deal_id=<id>` · `Verwijderen` → dubbele confirm → POST `/api/teamleader-delete-quotation`.
- **Status/badges** (`QUOTATION_BADGE`): sent→"Verzonden"(cat) · signed→"Getekend"(active) · declined→"Afgewezen"(risk) · expired→"Verlopen"(archived) · draft→"Concept"(archived) · null/not_pushed→"—". ⚠️ Inconsistentie: filter gebruikt `accepted`, badge-map kent alleen `signed` → `accepted` rendert als rauwe "accepted".
- **Navigatie:** klant-link → klanten.html?id ; Versturen → send-modal.

### Tab: Onboardings
- **Top acties:** geen.
- **Filters:** toggle **"Alleen mijn klanten"**.
- **Kolommen:** Naam · Verkoper · Traject · Entiteit · Onboarding · Eerste call · Mentor · (acties).
- **Acties per rij:** **`Mentor toewijzen`** — **disabled** ("Binnenkort beschikbaar", placeholder); naam-link → klant-detail; mentor-kolom toont altijd **`Binnenkort`** badge; "Eerste call" = datum of faint "wachten".
- **Status/badges** (`ONB_STATUS`): not_sent→"Niet verzonden"(archived, default) · sent→"Verzonden"(cat) · completed→"Afgerond"(active).
- **Data:** `/api/sales-onboardings`. Leeg: "Geen klanten met getekende offerte."

### Tab: Abonnementen
- **Top acties:** **`+ Nieuw abonnement (zonder offerte)`** → `/modules/subscription-wizard.html?mode=standalone` · **`🔄 Vernieuwen`**.
- **Filters:** toggle **"Alleen mijn klanten"** · status-dropdown Alle(default)/**Actief**/**Geannuleerd**.
- **Kolommen:** Klant · Bedrijf · Type · Bedrag incl. BTW · Termijnen (`N×`) · Startdatum · Einddatum · Status · (acties).
- **Acties per rij:** **`Detail`** → `/modules/klanten.html?id=<id>&tab=abonnementen` · `✓ TL` badge indien `teamleader_subscription_id`.
- **Status/badges** (`SUB_STATUS`): active→"Actief"(active) · cancelled→"Geannuleerd"(archived) · paused→"Gepauzeerd"(cat).
- **Data:** `/api/sales-subscriptions-list`.

### Tab: Retentie
- **Top acties:** geen. Caption "Trajecten die binnen 30 dagen aflopen."
- **Filters:** toggle **"Alleen mijn klanten"**.
- **Kolommen:** Naam · Traject · Einddatum · Dagen tot einde · Laatste contact (altijd "—") · (acties).
- **Acties per rij:** **`Nieuwe offerte`** → `/modules/sales-wizard.html?customer_id=<id>` ; naam-link → klant-detail.
- **Status:** geen badge; "Dagen tot einde" kleurgecodeerd (rood <14, amber <30).
- **Data:** `/api/sales-retention`.

### Tab: Trajecten
Card-layout (geen tabel), één card per traject met geneste varianten.
- **Top acties:** caption + **`+ Nieuw traject`** → Traject-modal (create).
- **Per traject (card header):** **`+ Variant`** (variant-modal create) · `✎` "Bewerken" (traject-modal edit) · `🗄` "Archiveren" (confirm → DELETE `/api/trajecten?id=`).
- **Per variant-rij:** `✎` "Bewerken" (variant-modal edit) · `×` "Verwijderen" (confirm → DELETE `/api/traject-variants?id=`). **`standaard`** badge (active) op default-variant; toont "· N producten · N mnd".
- **Data:** `/api/trajecten`. Leeg: "Nog geen trajecten. Maak er een aan."

### Tab: Producten
- **Top acties:** **`+ Nieuw product`** → Product-modal (gated op `sales.product.manage`; anders toast "Geen rechten").
- **Filters:** zoek `#prodSearch` (client-side op naam+beschrijving) · categorie-dropdown (auto) · toggle **"Toon gearchiveerd"** (`?active=true` vs all).
- **Kolommen:** Naam · Beschrijving · BTW · Prijs (+incl/excl) · Looptijd · Categorie · TL-ID · Status · (acties, alleen met `sales.product.manage`).
- **Acties per rij** (met permission): `✎` "Bewerken" (product-modal) · `🗄` "Archiveren" (alleen indien `!archived_at`, confirm → DELETE `/api/sales-products?id=`).
- **Status/badges:** BTW `vat-0`(groen)/`vat-9`(cyaan)/`vat-21`(paars) · "Gearchiveerd"(archived) of "Actief"(active).
- **Data:** `/api/sales-products`.

### Tab: Rapporten
Zichtbaar met `sales.reports.view`. Init eenmalig; default "Maand".
- **Top acties/filters:** snelfilters **Vandaag/Week/Maand/Kwartaal/Jaar** (zetten from/to/group_by) · datum `#repFrom`/`#repTo` · group-by **Per dag/week/maand** · **`Toepassen`** · **`⬇ Export Excel`** (SheetJS, 7 sheets → `sales-rapport-<from>_<to>.xlsx`).
- **Content (`renderReports`):** 4 KPI-cards (Pipeline open · Omzet periode · Bonus pending · Retentie %) · 4 charts (Conversie funnel · Omzet trend · Omzet per entiteit donut · Top trajecten) · tabel "Per sales-medewerker" (Medewerker/Offertes/Conversie/Omzet/Bonus pending/Bonus paid) · Retentie-tabel · Onboarding-tabel.
- **Acties per rij/navigatie:** geen — read-only dashboard. Charts fallback-melding als CDN geblokkeerd.
- **Data:** `/api/sales-reports`.

### Modals (sales.html)
- **Traject-modal** (`#trajectModal`): Naam* + Beschrijving → POST/PUT `/api/trajecten`.
- **Variant-modal** (`#variantModal`): Naam* + Looptijd(mnd) + Standaard-checkbox + producten-lijst (+ "Product toevoegen…" picker, per product qty + `×`) → POST/PUT `/api/traject-variants`.
- **Offerte versturen-modal** (`#sendModal`): Ontvanger (readonly) + Email-template dropdown (`/api/teamleader-email-templates?type=quotation`) → **`Verstuur nu`** POST `/api/teamleader-send-quotation`.
- **Product-modal** (`#productModal`): Naam* + Beschrijving + BTW*(0/9/21) + Standaardprijs + Prijs is(excl/incl) + Looptijd + Categorie + Teamleader Product-ID → POST/PUT `/api/sales-products`.
- Alle modals sluiten via `×`, Annuleer, of backdrop-klik.

**Endpoints:** sales-customers, sales-quotations, sales-onboardings, sales-retention, sales-subscriptions-list, sales-products, trajecten, traject-variants, sales-reports, sales-deal-retry-push, teamleader-send-quotation, teamleader-delete-quotation, teamleader-email-templates.
**Permission-gates:** `sales.product.manage` (product CRUD-UI), `sales.reports.view` (Rapporten-tab).

---

## sales-dashboard.html

Toegang: login + rollen super_admin/admin/manager/sales + RBAC `dashboard.sales.view`. Header "Sales Dashboard", greeting, "Bijgewerkt om HH:MM".

**Widgets:**
- **Vandaag** (`/api/sales-dashboard-stats`): Nieuwe leads · Event-aanmeldingen · Afspraken.
- **Deze week** (zelfde): Nieuwe leads · Event-aanmeldingen · Afspraken.
- **Werkvoorraad:** Afspraken morgen · Open follow-ups.
- **Volgende afspraak**-paneel: lead-naam + live countdown + datum-tijd. Leeg: "Geen geplande afspraken."
- **Open acties**-paneel: bestaat in JS (`renderOpenActies`) maar HTML is uitgecommentarieerd → momenteel verborgen.
- **Metric-grid** (`/api/sales-dashboard-metrics`): **Mijn open offertes** · **Mijn bonus deze maand** (€) · **Klanten in onboarding** · **Retentie deze maand**.
- **Wachten op subscription**-paneel (`/api/sales-pending-subscriptions`): count + max 5 klanten, elk met "Subscription invoeren"-link.

**Top acties/filters:** geen datumkiezers/filters; alleen navigatie-links + per-rij "Subscription invoeren". Geen handmatige refresh-knop.
**Klik-navigatie:** Mijn open offertes → `?tab=offertes` · Klanten in onboarding → `?tab=onboardings` · Retentie deze maand → `?tab=retentie` · Subscription invoeren → `subscription-wizard.html?deal_id=`. (Bonus-card niet klikbaar.)

---

## klanten.html (klant-detail)

Twee views: lijst (geen `?id=`) en **detail** (`?id=<uuid>`). Hieronder de detail-view.

**Top acties (detail header):** **Bewerken** (`#btn-edit-customer`) · **Archiveren** (`#btn-archive-customer`, indien `active`) · **Heractiveren** (`#btn-unarchive-customer`, indien `archived`) · back-link → `/modules/sales.html?tab=klanten`.

**Tabs:** Profiel · Communicatie (count) · Offertes (count) · Abonnementen · Facturen · Audit (count).

### Tab: Profiel
Cards: Persoonlijk (Voornaam/Achternaam/Geboortedatum) · Contact (Email `mailto:`, Telefoon `tel:`) · Adres · Tags · Metadata (Klant sinds, Laatst bijgewerkt, TradersLeague ID, GoHighLevel ID, Privacy geaccepteerd, Risico-tag) · Onboarding.
- **Tags Bewerken** (`#prof-tags-edit-toggle`) — alleen indien `status==='active'`; edit-mode: per-tag **✕**, **+ tag** popover.
- **Onboarding-card** (status-gated): completed → "Afgerond ✓ · datum" · sent → "Verzonden ✓ · datum" · not_sent → knop **`Aanmelden onboarding`** (`sendOnboarding()` → confirm → POST `/api/sales-onboarding-send`) **alleen** indien accepted/signed offerte die **niet** Retentie is; anders "Wordt zichtbaar na offerte-ondertekening."

### Tab: Communicatie
Notities: nieuwe-notitie editor + **Opslaan** (`submitNewNote()`); per-notitie edit/delete + inline edit-form. WhatsApp: placeholder "Beschikbaar in Fase 2C". Email: placeholder "post-MVP".

### Tab: Offertes (`renderOffertesTab`)
`/api/sales-quotations?customer_id=`. Leeg: "Nog geen offertes voor deze klant".
- **Kolommen:** Datum · Bedrag incl. BTW · Status · Acties.
- **Acties per rij:** **Detail →** → `/modules/offerte-detail.html?id=<deal_id>` · **↗ TL** (indien `tl_quotation_id`) → TL-quotation.
- **Badges** (`QUOTATION_STATUS_LABEL`/`BADGE_COLOR`): draft→Concept(#64748b) · sent→Verzonden(#0891b2) · accepted→**Bevestigd**(#059669) · declined→Afgewezen(#b91c1c) · expired→Verlopen(#94a3b8).

### Tab: Abonnementen (`renderAbonnementenTab`)
`/api/sales-customer-subscriptions?customer_id=`.
- **Top van tab:** **`Subscription invoeren`** (indien `pending_deal_id`) → `subscription-wizard.html?deal_id=` · **`Stel alle abo's uit (N)`** (`#postpone-all-btn`, amber, alleen als >1 actief) → bulk-modal. Leeg: "Nog geen abonnementen voor deze klant."
- **Kolommen:** Omschrijving · Bedrag incl. BTW · Termijnen (`N×`) · Periode (`start – eind` + postpone-badge) · TL (`✓ TL`/`—`) · Status · Acties.
- **Caret-expand** (▸/▾, `data-sub-toggle`) bij `line_items` → detail sub-rij: Regel/Bedrag excl./BTW/Incl. ("(N regels)"-note bij >1).
- **Acties per rij** (verborgen bij `cancelled` → "—"): **Uitstellen** (amber, `data-sub-running`-flag → `openPostponeModal(id,running)`) · **Verwijderen** (rood → `deleteSubscription`).
- **Postpone-badge:** `+Nm` (amber); ` verlengd` indien lopend (start onveranderd).
- **Status:** rauw via `escapeHtml` — o.a. `active`, `cancelled`.

### Tab: Facturen
Placeholder: "Facturen worden zichtbaar na Finance Fase 2 (TL-spiegel)." Geen acties.

### Tab: Audit
Audit-historie. Action-badges: created/updated/archived/unarchived/anonymized. Per entry: header + meta + reden + diff (before strikethrough / after) + "raw"-toggle. Read-only.

### Modals (detail)
- **Klant create/edit** (`#customerFormModal`): Voornaam*/Achternaam*/Email/Telefoon/Geboortedatum/Straat/Huisnummer/Postcode/Plaats/TradersLeague ID/GoHighLevel ID → `submitCustomerForm()`.
- **Archiveren** (`#archiveModal`): bevestiging + optionele Reden → `submitArchive()`.
- **Postpone (per-sub, JS `#postpone-overlay`):** titel **"Looptijd verlengen"** (lopend) of **"Abonnement uitstellen"** (toekomstig); maanden 1–12; **Verlengen**/**Uitstellen** → POST `/api/sales-subscription-postpone`.
- **Bulk-postpone** (`openPostponeAllModal`): "Alle abonnementen uitstellen", maanden 1–12, **Alle uitstellen** → POST `/api/sales-customer-postpone-all`.
- **Verwijderen sub:** native `confirm()` "…ook in Teamleader uitgeschakeld." → POST `/api/sales-subscription-delete`.

**Navigatie:** back → sales.html?tab=klanten · offerte → offerte-detail.html?id · sub-wizard → subscription-wizard.html?deal_id · TL extern.

---

## offerte-detail.html

Single-offerte (`?id=<deal_id>`), data `/api/sales-deal-detail`. Cards Klant/Offerte/Bedragen + line-item tabel + totalen. `render()` bouwt `#detailActions` op `deal.tl_quotation_status`.

**Top acties (header):** **`🔄 Vernieuwen`** (`#refreshBtn`, "Ververs status" → `load()`) + status-afhankelijke `#detailActions`.

**Status-labels:** draft→Concept(#64748b) · sent→Verzonden(#0891b2) · accepted→Bevestigd(#059669) · declined→Afgewezen(#b91c1c) · expired→Verlopen(#94a3b8). In elke status-branch met `tl_quotation_id`: gedeelde **`↗ Open in TL`**.

**Status-afhankelijke acties:**
- **accepted / signed:** **`Omzetten naar abonnement`** → `subscription-wizard.html?deal_id=` · onboarding-knop (`onboardingButton()`, **onderdrukt als entiteit "retentie" bevat**): completed→disabled "Onboarding afgerond ✓" · sent→disabled "Onboarding verzonden ✓" · else→**`Aanmelden onboarding`** (`doOnboarding()` → confirm → POST `/api/sales-onboarding-send`) · **`Bewerken`** (`editConfirm()` waarschuwt: al getekend → `sales-wizard.html?edit_deal_id=`) · **`↗ Open in TL`**.
- **sent:** **`Opnieuw versturen`** (`doSend()` → POST `/api/teamleader-send-quotation`) · **`Markeer als getekend`** (amber, `doMarkAccepted()` → POST `/api/sales-quotation-mark-accepted`) · **`Verwijderen`** (`doDelete()`) · **`↗ Open in TL`**.
- **draft:** **`Versturen`** (indien `tl_quotation_id`, `doSend()`) **of** **`Push naar TL`** (`doPush()` → POST `/api/sales-deal-retry-push`) · **`Bewerken`** (plain link `edit_deal_id=`, **géén** confirm) · **`Verwijderen`** · **`↗ Open in TL`**.
- **declined / expired / overig:** alleen **`↗ Open in TL`** (indien `tl_quotation_id`), anders geen.

**Confirms (native, geen modals):** `doDelete()` 2× confirm → POST `/api/teamleader-delete-quotation` → redirect `?tab=offertes` · `doOnboarding()` · `doMarkAccepted()` · `editConfirm()`.
**Navigatie:** back → sales.html · Klant-detail → klanten.html?id · sub-wizard · edit → sales-wizard?edit_deal_id · TL extern.

> ⚠️ **Label-inconsistentie bevestigd:** offerte-tab (sales.html) gebruikt **"Subscription invoeren"**; offerte-detail gebruikt **"Omzetten naar abonnement"** — beide → `subscription-wizard.html?deal_id=`. Harmoniseren in redesign.

---

## sales-wizard.html

"Nieuwe klant + offerte" — **5 stappen**, auto-save (debounce 1500ms → `/api/sales-wizard-drafts`). Submit → `/api/sales-deal-create` (nieuw) of `/api/sales-deal-update` (edit). Progress: Bedrijf · Klantgegevens · Offerte & producten · Betalingsvoorwaarden · Bevestiging & versturen.
**Header/footer:** save-indicator · `Annuleer & verlaat` · `← Vorige` · `Sla op als concept en sluit` · `Volgende →` (verborgen stap 5).

### Stap 1 — Bedrijf
Bedrijfsentiteit-cards (`/api/company-entities`): label + description, ✓ bij selectie. **Next-gating:** `tl_department_id` gekozen.

### Stap 2 — Klantgegevens
- Bestaande-klant banner (`#existingCustBanner`) + `Wissel klant`.
- Velden (alle verplicht behalve geboortedatum): Voornaam* · Achternaam* · Email* · Telefoon* · Straat* · Huisnr* · Postcode* · Plaats* · Geboortedatum.
- **`🔍 Zoek in onze DB + Teamleader`** (`#dupCheckBtn`, full-width): parallel POST `/api/sales-customer-duplicate-check` + `/api/teamleader-search-contacts`. **Email-blur auto-trigger** indien email gevuld + niet-completed.
- Tags (PRE_TAGS: vip/risico/ambassadeur/pilot/oud-lead + eigen) · **AVG-checkbox*** (privacyverklaring).
- **Dup-modal** (`#dupModal`): DB-sectie (per match: naam/email/phone, "N deals", **`Gebruik deze klant`**/**`Negeer`**) + TL-sectie (per match: naam/email/phone/adres, **`Gebruik dit contact`** → autofill first/last/email/phone/adres/**geboortedatum** + `tl_imported_contact_id`/**`Negeer`**) + footer **`Geen van deze - doorgaan met nieuwe klant`**.
- **Next-gating:** 8 velden + AVG + (`duplicate_check_status==='completed'` óf `matched_customer_id`).

### Stap 3 — Offerte & producten
- Traject-select (optgroups "Traject > Variant") + `Reset` → `applyTrajectVariant()` vervangt producten · **Type verkoop** (domestic / intracommunautair, hint bij intra) · Offerte-referentie · Lead-bron (inactief: "Binnenkort beschikbaar") · **Datum offerte*** (default vandaag) · **Looptijd*** (1–60, chips 6/12/24/36).
- **Producten** (`+ Product toevoegen` → product-picker modal met zoek/categorie): per regel naam, `BTW% · [incl/excl ⇄]`-toggle, aantal, prijs/stuk, regelbedrag, `×`. Totalen-blok: subtotaal excl, korting (`+ Korting`/wijzigen via discount-modal), BTW per tarief, **Totaal incl. BTW**.
- **Next-gating:** start_date, looptijd ≥1, ≥1 product met qty≥1 & prijs>0.

### Stap 4 — Betalingsvoorwaarden
**Startdatum cursus*** · Aanbetaling (€) · Aanbetaling-datum · Aantal termijnen · Datum 1e termijn · **Termijnbedrag** (readonly, auto). Preview `#payPreview`.
**Next-gating:** startdatum verplicht; aanbetaling>0 → aanbetaling-datum verplicht; termijnen>0 → datum 1e termijn verplicht (`#payMissing`).

### Stap 5 — Bevestiging & versturen
Review (inklapbaar, `Bewerken`-links → terug naar stap): Klant (badge bestaand/TL-import) · Offerte (producten-tabel) · Betalingsvoorwaarden. **TL-banner** (verbonden/niet). Submit: verbonden → **`Push naar Teamleader (concept, zonder versturen)`** of link **`Alleen lokaal opslaan`**; niet verbonden → **`Sla op (lokaal)`**. → create/update → redirect `offerte-detail.html?id=`.

**Modi:** edit (`?edit_deal_id=`, PUT-update) · prefilled-customer (`?customer_id=`, locked velden) · concept-resume modal. **sale_type intracommunautair** forceert 0% BTW (label blijft).

---

## subscription-wizard.html

"Abonnement invoeren" — **3 stappen**. Submit → `/api/sales-subscription-create`. Back → `sales.html?tab=abonnementen`. Progress: Klant (& offerte) · Abonnementen · Bonus & bevestigen.

**Modes:** `deal` (default, `?deal_id`) vs `standalone` (`?mode=standalone`). Gedeelde data (beide): company-entities, sales-products?active, trajecten (→ `descPresets`).

### Stap 1
- **Deal-mode:** read-only review card (naam·email, totaal incl. BTW, getekend-op). Next altijd door.
- **Standalone-mode:** klant kiezen — zoek bestaande (`#custSearch`, `/api/sales-customers?search=`, max 8, klik → `matched_customer_id`) · toggle **`+ Nieuwe klant aanmaken`** / **`↩ Toch een bestaande klant zoeken`** · nieuwe-klant form: Voornaam*/Achternaam*/Email*/Telefoon + **`🔍 Zoek dit contact in Teamleader`** (`/api/teamleader-search-contacts`, per match **`Gebruik dit contact`** → autofill + `tl_imported_contact_id`, **email-blur auto-trigger**) + Straat/Huisnr/Postcode/Plaats/Geboortedatum + **AVG*** . Validatie on-Next (`validateCustomer`).

### Stap 2 — Abonnementen
- Bedrijfsentiteit (`#deptSelect`, deal-mode voorgeselecteerd) · **Eerste call*** (datetime-local, default +7d) · **Type verkoop** (`#saleTypeSel`, **alleen standalone**, domestic/intracommunautair) · `+ Abonnement toevoegen`.
- **0%-banner** bij `isZeroVat()`.
- **Per abonnement** (`.sub-card`, `×` indien >1): **Omschrijving** dropdown (presets Aanbetaling/Maandelijkse termijnen + "Traject > Variant" + **`Andere omschrijving…`** → vrij tekstveld; placeholder "— Kies omschrijving —") · Startdatum · Aantal termijnen · **Einddatum (auto, readonly)** · **regels** (kolommen Product/Omschrijving/Excl. BTW/Incl. BTW/BTW/×): Product-dropdown ("Vrije invoer" + producten → `onProduct()` autofill) · Omschrijving · Excl. · Incl. · BTW (21/9/0, **disabled bij zero-vat**) · `×` (indien >1 regel) · **`+ Regel toevoegen`** · per-sub "Totaal/termijn incl. BTW".
- Totaalkaart "Totale waarde abonnementen (incl. BTW)".
- **Validatie** (`validateSubs`): ≥1 sub, eerste call, per sub term_count≥1 + start + ≥1 regel met bedrag>0.
- **Deal-mode prefill** (`prefillSubs`/`splitFromOffer`): aanbetaling-sub + termijnen-sub, bedragen proportioneel over BTW-tarieven van offerte.

### Stap 3 — Bonus & bevestigen
Bonus-blok (aanbetaling ≥ €1000 → indicatief 3%) · preview-tekst (per sub + regels + zero-vat-notitie) · **`Activeer abonnementen + push naar Teamleader`** of **`Alleen lokaal opslaan`** → redirect `klanten.html?id=&tab=abonnementen`.

**Conditional logic:** excl/incl auto-conversie (`_lead` = laatst bewerkte veld) · product-autofill · zero-vat/intracommunautair (rate 0, BTW-dropdowns disabled, banner) · validatie on-click bij Next (`updateNext()` is no-op).

---

## onboarding.html

Pre-login, **token-based klant-facing** (`?token=`, geen auth/sidebar). Geen token → "Onboarding — Ongeldige link."

**Klant-facing flow** (single-card, geen formuliervelden — formulier "komt binnenkort beschikbaar"):
1. **Laden** → `GET /api/onboarding?token=`.
2. **Welkom/bevestig** (status ≠ completed): "Welkom{, voornaam}!" + tekst + knop **`Markeer als afgerond`** → `POST /api/onboarding {token}` (knop → "Bezig…").
3. **Al afgerond** (`status==='completed'`): "Bedankt! Je onboarding is al afgerond."
- **Succes:** "Bedankt! … We nemen snel contact op voor je eerste call."
- **Fout:** load-fout in card; submit-fout → re-enable + `alert("Mislukt: …")`.

---

## admin.html (sales-rechten)

Feature-keys onder `moduleKey:'sales'` ("Sales-module") in `FEATURE_REGISTRY`:

| feature_key | label |
|---|---|
| `sales.module.access` | Module zichtbaar |
| `sales.product.manage` | Productcatalogus beheren |
| `sales.product.view` | Productcatalogus bekijken |
| `sales.customer.create` | Klant aanmaken (sales-wizard) |
| `sales.customer.view` | Klant-overzicht bekijken |
| `sales.customer.tag_manage` | Klant-tags toevoegen |
| `sales.deal.create` | Offerte aanmaken |
| `sales.deal.edit` | Offerte bewerken |
| `sales.deal.view` | Offerte bekijken |
| `sales.bonus.view_own` | Eigen bonus bekijken |
| `sales.dashboard.view` | Sales dashboard bekijken |
| `sales.retention.view` | Retentie-pipeline bekijken |
| `sales.first_call.view` | 1e call ready widget |
| `sales.reports.view` | Rapporten + KPIs bekijken |

Matrix schrijft naar `role_permissions` (role, feature_key, allowed). super_admin = altijd true via `user_has_permission()`.

---

## Bevindingen voor het herontwerp (samenvatting van gaps/inconsistenties)

1. **Label-inconsistentie:** "Subscription invoeren" (offerte-tab + klant-detail) vs "Omzetten naar abonnement" (offerte-detail) — zelfde actie. Harmoniseren.
2. **Badge-mismatch offertes:** filter `accepted` vs badge-map `signed` → status "accepted" rendert rauw. Map gelijktrekken.
3. **Placeholders die als "af" ogen:** Onboardings-tab "Mentor toewijzen" (disabled), Facturen-tab, Communicatie WhatsApp/Email, Lead-bron in wizard, Open-acties-paneel (verborgen).
4. **`👁` / Bewerken / ↗ TL / Verwijderen** zijn al consequent aanwezig in de offerte-lijst (sales.html) maar **niet** in klant-detail → Offertes-tab (daar alleen Detail + ↗ TL). Overweeg gelijktrekken.
5. **offerte-detail "draft" Bewerken zonder confirm** vs **accepted Bewerken mét confirm** — bewust, maar documenteren.
6. **onboarding.html** is nog een bevestig-stub (geen echte vragenlijst) — kandidaat voor uitbouw.
7. **Geen sorteer-kolommen** in de tabellen (alleen server-filters) — overweeg sorteerbare headers in redesign.
