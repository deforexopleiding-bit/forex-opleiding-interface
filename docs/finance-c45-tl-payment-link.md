# Finance C4.5 — TL invoice payment_url resolve + cache

Datum: 9 juni 2026
Branch: `feat/whatsapp-templates-c3-inbox-picker` (deze docs-commit)
Status: live in productie, primaire route is TL `invoices.download` (signed PDF).

---

## Doel

Eén centrale helper die voor een interne `invoices.id` een betaal-link uit Teamleader
ophaalt, het resultaat opslaat in `invoices.payment_url` + `invoices.payment_url_fetched_at`,
en op vervolgaanvragen een cache-hit teruggeeft zolang die nog vers is. Wordt gebruikt
door drie callers: het HTTP-endpoint (UI-knop), inbox-template-send (lazy resolve van
`{{factuur.betaal_link}}`), en op termijn de dunning-engine (pre-warm vóór WA-send).

---

## TL-route gekozen (uit recon-rapport juni 2026)

De TL apiary documenteert vandaag GEEN `payment_url`/`public_url`/`web_url`/
`online_payment.url` op `/invoices.info`. We doen wel een defensieve field-probe op die
keys voor het geval TL ze later toevoegt, en vallen daarna terug op `/invoices.download`
met `format=pdf`. Dat endpoint retourneert een signed S3-URL met `expires` (~10 minuten
geldig) — dat is de **de-facto primary route vandaag**.

Volgorde in `ensureInvoicePaymentLink()`:

1. Edge-case guards (geen TL-call, alle 422 in endpoint — zie onder).
2. Cache-check tegen `invoices.payment_url` + `invoices.payment_url_fetched_at` (skip
   bij `force=true`).
3. `POST /invoices.info` → probe `payment_url` / `public_url` / `web_url` /
   `online_payment.url`. Hit → bron `tl_payment_url|tl_public_url|tl_web_url|tl_online_payment`,
   persist naar DB.
4. Fallback `POST /invoices.download` met `{ id, format: 'pdf' }` → `data.location`
   + `data.expires`. Bron `tl_download_pdf`. **Niet persisten** (TTL te kort).
5. Alles miss → `InvoicePaymentLinkError('TL_NULL')`.

429-handling: één retry na 2 s sleep per probe-laag. Daarna 429 → `TL_RATE_LIMITED`.
5xx → `TL_SERVER_ERROR`.

---

## Cache-strategie

- Kolommen op `invoices`: `payment_url text NULL`, `payment_url_fetched_at timestamptz NULL`.
- TTL via env: `FINANCE_PAYMENT_LINK_CACHE_TTL_DAYS` (default `7`).
- Cache geldig wanneer: `payment_url IS NOT NULL` EN
  `now() - payment_url_fetched_at < ttl`.
- Persist alleen bij bron `!= tl_download_pdf` (signed-URL met ~10 min TTL is geen
  zinnige cache).
- Force-bypass via query-param `?force=true` op het endpoint, of `{ force: true }` als
  helper-optie.

---

## Auto-trigger paden

### 1. Inbox template send — `api/inbox-send-template.js`

Wanneer de gekozen WhatsApp-template een mapping met `factuur.betaal_link` bevat (zie
`api/_lib/template-variables.js` voor het variabelen-register), wordt vóór de Meta-send
`ensureInvoicePaymentLink(invoice.id, { userId: user.id })` aangeroepen. Resultaat zet
`invoice.payment_url` op de in-memory context, waarna de resolver de waarde in het Meta
component-payload prikt.

Fail-soft pad: bij elke `InvoicePaymentLinkError` (of generieke fout) → `console.warn`
+ `resolveWarnings`-collect; de resolver vult een lege string in. Send breekt niet hard.

### 2. Dunning engine — `api/_lib/dunning-step-executors.js`

TODO-comment op dit moment (zie regels 180-192). Zodra Meta credentials live zijn (PR A2)
moet pre-warm langs deze drie stappen:

1. Detecteer of de gekozen WhatsApp-template een mapping op `factuur.betaal_link` heeft
   (`meta_param_mapping.body` bevat de key).
2. Kies `openInvoices[0]` (of een toekomstige `step.config.invoice_id`-selector) en
   roep `await ensureInvoicePaymentLink(invoice.id)` aan **vóór** de POST naar
   `/api/inbox-send-template`. Cache wordt dan warm — bespaart een latency-spike op
   het send-moment.
3. Fail-soft: errors loggen en doorgaan; de send-endpoint zelf doet alsnog lazy-fetch
   als pre-warm faalt.

### 3. UI: `Ververs betaal-link`-knop in invoice-detail modal

`modules/finance.html` — knop `#invoicePaymentLinkRefreshBtn` in de invoice-detail
modal. Klik → `apiFetch('/api/finance-invoice-payment-link?invoice_id=…')`. Shift+klik
→ stuurt `&force=true` mee. Resultaat vult `#invPayLinkInput` (readonly) + activeert
de open/copy-knoppen naast het veld.

---

## Edge-cases (alle 422 vanuit het HTTP-endpoint)

Errors uit de helper hebben een `.code` zodat het endpoint ze naar het juiste HTTP
status mapt en de UI een nette melding kan tonen.

| Code               | Trigger                                              | HTTP |
|--------------------|------------------------------------------------------|------|
| `INVALID_INPUT`    | ontbrekende of niet-uuid `invoice_id`                | 400  |
| `INVOICE_NOT_FOUND`| `invoices`-row niet gevonden                         | 404  |
| `NO_TL_LINK`       | `tl_invoice_id IS NULL` (lokale-only invoice)        | 422  |
| `DRAFT_INVOICE`    | status `concept`/`draft` — TL heeft nog geen link    | 422  |
| `STATUS_NO_LINK`   | status `paid`/`credited`/`writeoff`                  | 422  |
| `CREDIT_OR_ZERO`   | `amount_total <= 0` (credit note of nul-factuur)     | 422  |
| `TL_RATE_LIMITED`  | TL 429 na één retry                                  | 429  |
| `TL_SERVER_ERROR`  | TL 5xx                                               | 502  |
| `TL_NULL`          | info-probe miss + download miss                      | 502  |
| `LOOKUP_FAILED`    | Supabase lookup faalde                               | 500  |

Geen permission-checks in de helper zelf; callers moeten `requireAuth` /
`requirePermission` doen.

---

## Rate-limit advies (TL)

Recon (juni 2026) heeft géén harde TL-limit gedocumenteerd voor `/invoices.info` of
`/invoices.download`. Onze defensieve aannames:

- **Per-call**: 2 s sleep + retry bij eerste 429; daarna error.
- **Bursts**: bij dunning-runs of bulk-reminders, hou een 200 ms throttle aan
  (zelfde patroon als `cron-finance-sync.js` `TL_THROTTLE_MS`).
- **Tegelijkertijd**: de cache zorgt dat een tweede caller binnen TTL nul TL-calls doet.
  Dit is de belangrijkste reden dat lazy-fetch + cache combineren: één popup-actie
  kan binnen luttele seconden zowel UI-refresh als WA-send triggeren — beide moeten
  hetzelfde resultaat zien zonder dubbel verbruik.
- **Monitoring**: bij eerste productie-incident met 429: log doorhalen in Vercel logs;
  zo nodig de retry uitbreiden naar exp-backoff (1 s → 2 s → 4 s).

---

## Verwante bestanden

- Helper: `api/_lib/invoice-payment-link.js`
- HTTP-endpoint: `api/finance-invoice-payment-link.js`
- Inbox send: `api/inbox-send-template.js` (zoek `ensureInvoicePaymentLink`)
- Dunning TODO: `api/_lib/dunning-step-executors.js` (zoek `C4.5 TODO`)
- UI: `modules/finance.html` (zoek `invoicePaymentLinkRefreshBtn`)
- TL-token: `api/_lib/teamleader-token.js` (`tlFetch` wrapper)
