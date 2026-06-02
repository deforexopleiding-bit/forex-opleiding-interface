# BTW-audit — Wizard 1 (offerte) + Wizard 2 (subscription)

Datum: 2026-06-01 · Branch: `analysis/btw-grondig-audit`
Scope: alle BTW-/tax_rate_id-paden richting Teamleader.

---

## Sectie 1 — Code-paden (`taxRateIdFor`)

De BTW→TL-mapping zit centraal in **één** functie:
`api/_lib/teamleader-quotation.js` → `export function taxRateIdFor(vatPercentage, departmentId, saleType)`.

Beide wizards gebruiken **dezelfde** functie:
- **Wizard 1** — `pushQuotationToTl()` (zelfde bestand). Per `deal_line_items`-regel:
  `tax_rate_id: taxRateIdFor(l.vat_percentage, departmentId, deal.sale_type)`.
- **Wizard 2** — `api/sales-subscription-create.js` importeert `taxRateIdFor` en roept per sub:
  `taxRateIdFor(row.vat_percentage, departmentId, deal.sale_type)`.

### Beslisboom in `taxRateIdFor`
1. `departmentId` (TL-UUID) → korte naam via `DEPT_NAME`:
   - `09d67371-…` → `ONLINE`
   - `0da396bf-…` → `FYSIEK`
   - `9adca043-…` → `RETENTIE`
   - **Onbekende/lege department → `dept = undefined`** (alleen generieke fallback mogelijk).
2. `saleType === 'intracommunautair'` → `TEAMLEADER_TAX_RATE_ID_INTRA_{DEPT}` → `TEAMLEADER_TAX_RATE_ID_INTRA` → **throw**.
3. `saleType === 'outside_eu'` → `TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU_{DEPT}` → `TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU` → **throw**.
4. `domestic` (default): `TEAMLEADER_TAX_RATE_ID_{vat}_{DEPT}` → `TEAMLEADER_TAX_RATE_ID_{vat}` → **throw**.

> Let op: bij intra/outside_eu wordt `vat_percentage` **genegeerd** voor de keuze (er is één verlegd/0%-tarief per type). De wizard-UI toont die regels ook als 0%.

### Verschil in fout-afhandeling tussen de wizards (belangrijk!)
- **Wizard 1**: `taxRateIdFor` wordt **niet** in een try/catch per regel aangeroepen → de throw borrelt op naar de `catch` van `pushQuotationToTl` → deal krijgt `tl_push_status='failed'` + `tl_push_error` = *"Geen TEAMLEADER_TAX_RATE_ID_9 geconfigureerd"*. **Dit is exact de zichtbare foutmelding van punt 2.**
- **Wizard 2** (`sales-subscription-create`): de aanroep zit **wél** in `try { … } catch { console.warn(...) }` → bij missing var blijft `taxRateId = null`, en de sub wordt alsnog naar TL gestuurd met `tax_rate_id: null` → TL geeft dan een **andere** 400 ("tax_rate_id … invalid/blank"), niet de duidelijke env-foutmelding. → Inconsistente diagnostiek tussen de twee flows.

### Edge cases
- **Regel zonder `vat_percentage`**: `deal_line_items.vat_percentage` heeft DB-default `21` (CHECK 0/9/21) en de wizard zet default 21 → in praktijk nooit `undefined`. Zou het wel `undefined` zijn, dan wordt env-key `TEAMLEADER_TAX_RATE_ID_undefined` gezocht → throw.
- **Onbekende department** (deal zonder `tl_department_id`, of een niet-gemapte UUID): valt terug op de **generieke** var. Dus zelfs met alle per-dept vars gezet kan een deal zonder department falen als de generieke var ontbreekt.

---

## Sectie 2 — Env-vars matrix (wat de code daadwerkelijk leest)

De code leest **dynamisch** `TEAMLEADER_TAX_RATE_ID_{vat}_{DEPT}` en de generieke `_{vat}`/`_INTRA`/`_OUTSIDE_EU`. Alle gelezen sleutels:

| Env var | Pad | Status (o.b.v. sessie-historie) |
|---|---|---|
| `TEAMLEADER_TAX_RATE_ID_21_ONLINE` | domestic 21 Online | ❓ niet bevestigd gezet |
| `TEAMLEADER_TAX_RATE_ID_21_FYSIEK` | domestic 21 Fysiek | ❓ |
| `TEAMLEADER_TAX_RATE_ID_21_RETENTIE` | domestic 21 Retentie | ❓ |
| `TEAMLEADER_TAX_RATE_ID_9_ONLINE` | domestic 9 Online | ❌ nooit aangeleverd |
| `TEAMLEADER_TAX_RATE_ID_9_FYSIEK` | domestic 9 Fysiek | ❌ |
| `TEAMLEADER_TAX_RATE_ID_9_RETENTIE` | domestic 9 Retentie | ❌ |
| `TEAMLEADER_TAX_RATE_ID_0_ONLINE` | domestic 0 Online | ❌ |
| `TEAMLEADER_TAX_RATE_ID_0_FYSIEK` | domestic 0 Fysiek | ❌ |
| `TEAMLEADER_TAX_RATE_ID_0_RETENTIE` | domestic 0 Retentie | ❌ |
| `TEAMLEADER_TAX_RATE_ID_INTRA_ONLINE` | intra Online | ✅ `af01bc54-0957-0d60-835f-9d8683d10605` |
| `TEAMLEADER_TAX_RATE_ID_INTRA_FYSIEK` | intra Fysiek | ✅ `c88937a5-d3c6-0c6b-b45d-1ed77dc10605` |
| `TEAMLEADER_TAX_RATE_ID_INTRA_RETENTIE` | intra Retentie | ✅ `493d20e6-0b6c-00d1-b152-ce900f010605` |
| `TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU_ONLINE` | buiten-EU Online | ✅ `de875f3b-3c04-0243-9b58-9b1dd6610de0` |
| `TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU_FYSIEK` | buiten-EU Fysiek | ✅ `75bb1e87-075f-0db7-9350-567aabf10de0` |
| `TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU_RETENTIE` | buiten-EU Retentie | ❌ bestaat niet in TL (gedocumenteerde gap) |
| `TEAMLEADER_TAX_RATE_ID_21` | generieke fallback 21 | ❓ |
| `TEAMLEADER_TAX_RATE_ID_9` | generieke fallback 9 | ❌ (= oorzaak punt 2) |
| `TEAMLEADER_TAX_RATE_ID_0` | generieke fallback 0 | ❌ |
| `TEAMLEADER_TAX_RATE_ID_INTRA` | generieke fallback intra | ❓ |
| `TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU` | generieke fallback buiten-EU | ❓ |

> ❓ = nooit expliciet in deze sessie aangeleverd; kan op Vercel staan, **te verifiëren door Chrome/Jeffrey** (env vars zijn server-side niet door mij leesbaar). ❌ = met grote zekerheid niet gezet (nooit aangeleverd én verklaart de waargenomen fout).

---

## Sectie 3 — Verwachte faal-scenario's

| Combinatie | Wizard 1 gedrag | Wizard 2 gedrag |
|---|---|---|
| 9% domestic, geen `_9_{DEPT}` én geen `_9` | **throw** → `tl_push_status='failed'`, error "Geen TEAMLEADER_TAX_RATE_ID_9 geconfigureerd" | `taxRateId=null` → TL 400 op de sub (andere foutmelding) |
| 0% domestic, geen `_0*` | idem met `_0` | idem |
| 21% domestic, `_21_{DEPT}` ontbreekt maar `_21` gezet | werkt (generieke fallback) | werkt |
| Buiten-EU Retentie | throw (geen tarief in TL) | sub 400 |
| Deal zonder `tl_department_id` | alleen generieke vars werken | idem |

---

## Sectie 4 — Test-matrix (12 scenario's voor Chrome)

UUID's: ✅ = bekend uit deze sessie; "ENV" = uit Vercel, **te bevestigen**.

| # | Department | BTW | Sale_type | Verwacht tax_rate_id |
|---|---|---|---|---|
| 1 | Online   | 21% | domestic | ENV `_21_ONLINE` of `_21` |
| 2 | Online   | 9%  | domestic | ENV `_9_ONLINE` of `_9` ⚠️ vermoedelijk MISSING |
| 3 | Online   | 0%  | domestic | ENV `_0_ONLINE` of `_0` ⚠️ |
| 4 | Online   | n.v.t. | intracommunautair | ✅ `af01bc54-…` |
| 5 | Online   | n.v.t. | outside_eu | ✅ `de875f3b-…` |
| 6 | Fysiek   | 21% | domestic | ENV `_21_FYSIEK` of `_21` |
| 7 | Fysiek   | 9%  | domestic | ENV `_9_FYSIEK` of `_9` ⚠️ |
| 8 | Fysiek   | n.v.t. | intracommunautair | ✅ `c88937a5-…` |
| 9 | Fysiek   | n.v.t. | outside_eu | ✅ `75bb1e87-…` |
| 10 | Retentie | 21% | domestic | ENV `_21_RETENTIE` of `_21` |
| 11 | Retentie | n.v.t. | intracommunautair | ✅ `493d20e6-…` |
| 12 | Retentie | n.v.t. | outside_eu | ❌ verwacht **throw** (geen tarief) |

Uitvoeren: maak per rij een mini-offerte (Wizard 1) met dat department + 1 product met die BTW + dat sale_type, push naar TL, noteer of het slaagt of welke fout. Herhaal de relevante voor Wizard 2 (subscription).

---

## Sectie 5 — Fix-voorstel

**Primair (geen code nodig):** zet de ontbrekende env-vars in Vercel.
Minimaal de generieke fallbacks zodat elke BTW-combinatie werkt:
```
TEAMLEADER_TAX_RATE_ID_9    = <9%-tarief-UUID uit TL>
TEAMLEADER_TAX_RATE_ID_0    = <0%-tarief-UUID uit TL>
TEAMLEADER_TAX_RATE_ID_21   = <21%-tarief-UUID uit TL>   (indien nog niet gezet)
```
Optioneel per-department `_9_{DEPT}` / `_0_{DEPT}` als de tarieven per entiteit verschillen.

**Secundair (code, optioneel) — betere diagnostiek/robuustheid:**
1. **Wizard 2 gelijktrekken met Wizard 1**: in `sales-subscription-create.js` de `taxRateIdFor`-fout niet wegslikken maar de sub als mislukt markeren met dezelfde duidelijke env-foutmelding (i.p.v. een vage TL-400 met `tax_rate_id:null`).
2. **Pre-flight validatie**: vóór de TL-push controleren of alle benodigde tax-rate-vars aanwezig zijn voor de gebruikte (vat × dept × sale_type)-combinaties, en anders een nette 422 met exact welke env-var ontbreekt (i.p.v. een mislukte push achteraf).
3. **Retentie buiten-EU**: expliciet afvangen in de UI (sale_type 'outside_eu' niet toestaan voor Retentie) of een config-tarief verplichten.

---

## Top-3 verdachte plaatsen voor de 9%-bug
1. **Ontbrekende `TEAMLEADER_TAX_RATE_ID_9` (+ geen `_9_{DEPT}`)** — meest waarschijnlijk; verklaart de letterlijke foutmelding 1-op-1. Nooit aangeleverd in deze sessie.
2. **`vat_percentage` van het product = 9** terwijl alleen 21%-vars gezet zijn — elke 9%-offerte faalt dan ongeacht department.
3. **Deal zonder/onbekend `tl_department_id`** waardoor de per-dept-var wordt overgeslagen en de (ontbrekende) generieke `_9` bepalend is.
