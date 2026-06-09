# WhatsApp Templates — C4 Named Variables

Datum: 2026-06-09
Branch: `feat/whatsapp-templates-c4-named-variables`
Status: live (na merge)

## Introductie

Module C4 voegt **named placeholders** toe aan de WhatsApp Meta-templates editor.
Tot C3 werkten templates alleen met positionele variabelen (`{{1}}`, `{{2}}`, …) — de
afzender moest per Inbox-send handmatig de juiste waarde in volgorde aanleveren. Dat
is foutgevoelig en biedt geen herbruikbaarheid tussen templates.

Vanaf C4 schrijft de admin templates met semantische placeholders zoals
`{{klant.naam}}` of `{{factuur.bedrag_open}}`. De server vertaalt die intern naar het
formaat dat Meta verwacht (positioneel) en resolved bij verzending automatisch de
juiste waarden uit de database. Caller hoeft niets meer in te vullen.

**Backward compatible:** bestaande positionele templates blijven werken zonder
wijziging — alleen rijen zonder `meta_param_mapping` volgen de oude flow.

---

## Variabelen-overzicht

Alle ondersteunde keys staan in [`api/_lib/template-variables.js`](../api/_lib/template-variables.js)
(`AVAILABLE_VARIABLES`). Vijf categorieën:

### `customer` — klantgegevens

Resolved tegen de customer-rij die hoort bij de WhatsApp-conversation
(`whatsapp_conversations.customer_id`, met fallback op `phone`-match).

| Key | Voorbeeld | Betekenis |
|---|---|---|
| `klant.naam` | `Jeffrey Biemold` | Volledige naam (bedrijfsnaam bij B2B, anders voornaam + achternaam) |
| `klant.voornaam` | `Jeffrey` | Voornaam (B2C-veld) |
| `klant.email` | `klant@example.com` | E-mailadres uit customers.email |
| `klant.telefoon` | `+31612345678` | Telefoonnummer uit customers.phone |
| `klant.bedrijf` | `Voorbeeld B.V.` | Bedrijfsnaam uit customers.company_name |

### `invoice` — oudste open factuur

Resolved tegen één invoice-rij. Bron is `context_invoice_id` als die meegegeven
wordt, anders de oudste open factuur van de klant (status in `open`,
`partially_paid`, `overdue`, gesorteerd op `due_date asc`).

| Key | Voorbeeld | Betekenis |
|---|---|---|
| `factuur.nummer` | `2026-0001` | invoices.invoice_number |
| `factuur.bedrag` | `EUR 1.234,56` | invoices.amount_total (totaal) |
| `factuur.bedrag_open` | `EUR 80,00` | amount_total − amount_paid − credited_amount |
| `factuur.vervaldatum` | `15-06-2026` | invoices.due_date in NL-formaat (dd-mm-jjjj) |
| `factuur.factuur_datum` | `01-06-2026` | invoices.issue_date in NL-formaat |
| `factuur.dagen_overdue` | `12` | Dagen sinds due_date (clamped ≥ 0) |
| `factuur.betaal_link` | `https://focus.teamleader.eu/...` | TL public/payment URL (lazy fetch, zie sectie TL-factuurlink) |

### `klant` — aggregaties over alle open facturen

Resolved over **alle** open facturen van de klant (lijst van 25 max).

| Key | Voorbeeld | Betekenis |
|---|---|---|
| `klant.factuur_lijst` | `- 2026-0001 (EUR 80,00)\n- 2026-0002 (EUR 120,00)` | Bullet-lijst per factuur |
| `klant.totaal_open` | `EUR 200,00` | Som van alle open bedragen |
| `klant.aantal_open` | `2` | Aantal open facturen |

### `bedrijf` — bedrijfsgegevens De Forex Opleiding

Server-side resolved uit env-vars (zie sectie env vars hieronder). Geen DB-lookup
nodig — werkt altijd.

| Key | Voorbeeld | Env var | Fallback |
|---|---|---|---|
| `bedrijf.naam` | `De Forex Opleiding NL B.V.` | `COMPANY_NAME` | `De Forex Opleiding NL B.V.` |
| `bedrijf.adres` | `Voorbeeldstraat 1, 1234 AB Plaats` | `COMPANY_ADDRESS` | leeg |
| `bedrijf.kvk` | `12345678` | `COMPANY_KVK` | leeg |
| `bedrijf.btw` | `NL123456789B01` | `COMPANY_BTW` | leeg |
| `bedrijf.telefoon` | `+31201234567` | `COMPANY_PHONE` | leeg |
| `bedrijf.email` | `info@deforexopleiding.nl` | `COMPANY_EMAIL` | leeg |

### `datum` — datum-helpers

Resolved op server-clock (Europe/Amsterdam, lokale time).

| Key | Voorbeeld | Betekenis |
|---|---|---|
| `datum.vandaag` | `09-06-2026` | Vandaag in dd-mm-jjjj |
| `datum.deze_maand` | `juni 2026` | Maand-naam (NL) + jaar |
| `datum.dit_jaar` | `2026` | Lopend kalenderjaar |

---

## Meta submit-conversie

Meta's Cloud API accepteert **alleen positionele placeholders** in de body-text
van een approved template. Daarom converteert
[`api/admin-meta-templates-submit.js`](../api/admin-meta-templates-submit.js)
named placeholders naar positioneel **vlak voor** de POST-call naar
`graph.facebook.com/v25.0/<WABA_ID>/message_templates`:

1. **Parse** named keys uit body/header/buttons in volgorde van eerste verschijning.
2. **Vertaal** naar `{{1}}`, `{{2}}`, … via `buildPositionalMapping()`.
3. **Bouw mapping** `{ body: { "1": "klant.naam", "2": "factuur.bedrag_open" } }`
   en bewaar als `whatsapp_meta_templates.meta_param_mapping` (jsonb).
4. **Genereer example-array** uit registry-examples — Meta vereist een sample.
5. **POST** payload met positionele body + example-array.

Voor templates zonder named placeholders (legacy positioneel) blijft de oude flow
ongewijzigd: `meta_param_mapping` blijft `NULL`.

Mixed templates (zowel named als positioneel in dezelfde body) worden geweigerd in
de admin-editor (`isMixedTemplateBody()` check) — voorkomt mapping-ambiguïteit.

---

## Send-resolutie

Bij outbound verzending via [`api/inbox-send-template.js`](../api/inbox-send-template.js):

1. **Lookup** de lokale `whatsapp_meta_templates` rij op `name + language`.
2. **Status-gate:** alleen `APPROVED` templates mogen verzonden — anders 409.
3. **Mapping check:** als `meta_param_mapping.body` aanwezig is → server-resolve.
   Zonder mapping = caller-supplied `variables` (legacy positional).
4. **Context lookup** op basis van welke keys de mapping gebruikt:
   - `klant.*` → customer-rij ophalen via `conversation.customer_id` of `phone`-match
   - `factuur.*` → invoice-rij (context_invoice_id of oudste open)
   - `klant.factuur_lijst` / `klant.totaal_open` / `klant.aantal_open` → lijst van alle open invoices
   - `factuur.betaal_link` → extra lazy TL fetch (zie volgende sectie)
5. **Resolve** elke positie via `buildMetaVariablesFromMapping(mapping, ctx)` →
   `{ "1": "Jeffrey", "2": "EUR 80,00" }`.
6. **Build Meta components** array (`{ type: 'body', parameters: [...] }`) en POST.
7. **Persist** de resolved values in `whatsapp_messages.template_variables` voor
   audit + chat-preview body.

Onbekende keys in mapping → warning in audit-log, value wordt lege string (Meta
accepteert leeg, body krijgt gat — zichtbaar voor admin).

---

## TL-factuurlink (`factuur.betaal_link`)

Implementatie: [`api/_lib/teamleader-invoice-link.js`](../api/_lib/teamleader-invoice-link.js).

**Route:** Route A uit `docs/finance-4-recon.md` — real-time fetch met lazy cache
in `invoices.payment_url` + `invoices.payment_url_fetched_at` (TTL 24u).

**Endpoint flow:**

1. Cache-hit (`payment_url != NULL` én `fetched_at < 24u` oud) → return cached.
2. Anders `POST /invoices.info` met `tl_invoice_id`, probe velden in volgorde:
   `data.payment_url` → `data.public_url` → `data.web_url` → `data.online_payment.url`.
3. Persist eerste niet-lege URL in DB + `fetched_at = now()`.
4. Fallback bij TL 429/5xx: stale cache mag terug.
5. Fallback bij niets gevonden: `POST /invoices.download` (PDF signed URL, ~10
   min geldig, NIET gecached).

**Env-vars:** gebruikt de bestaande TL OAuth-tokens (`TEAMLEADER_*`) via
`tlFetch()` uit `teamleader-token.js` — geen nieuwe env-vars nodig.

**Caller verplichting:** `context_invoice_id` MOET meegegeven worden in
`inbox-send-template` als `factuur.betaal_link` voorkomt en er geen open
invoice is voor de klant — anders 400 met duidelijke error.

---

## Env-vars voor `bedrijf.*`

Voeg toe aan Vercel project env (alle environments: Production / Preview /
Development) — NIET sensitive, want ze worden naar Meta gestuurd:

```
COMPANY_NAME=De Forex Opleiding NL B.V.
COMPANY_ADDRESS=<straatadres + postcode + plaats>
COMPANY_KVK=<8-cijferig KvK-nummer>
COMPANY_BTW=NL<9 cijfers>B01
COMPANY_PHONE=+31<area+nummer>
COMPANY_EMAIL=info@deforexopleiding.nl
```

`COMPANY_NAME` heeft een fallback (`De Forex Opleiding NL B.V.`) — als die env-var
ontbreekt, werkt `bedrijf.naam` nog steeds. Overige `bedrijf.*` keys resolven naar
lege string als env-var ontbreekt; check post-deploy of alles is ingevuld.

---

## Migratiepad voor bestaande positionele templates

Bestaande approved templates met `{{1}}` / `{{2}}` blijven **werken zonder
wijziging**. `meta_param_mapping` is `NULL` voor die rijen en de send-flow valt
terug op caller-supplied `variables`.

**Optioneel hand-converten** (niet verplicht, alleen als je server-side resolution
wilt):

1. Open template in admin → WhatsApp Templates → Edit.
2. Vervang `{{1}}` door bv. `{{klant.naam}}` in body-text.
3. Save → status blijft `APPROVED` (lokale rij heeft mapping nu, Meta-zijde
   ongewijzigd want body-tekst op Meta blijft positioneel).
4. Volgende send-call gebruikt automatisch server-resolution.

**LET OP:** template-resubmit (`status=REJECTED` → opnieuw insturen) bouwt
automatisch een nieuwe mapping uit de actuele body-text — geen handmatige actie
nodig.

---

## Smoke checklist

Na deploy / merge:

- [ ] Open `/modules/admin.html` → tab WhatsApp Templates → **Nieuwe template**.
- [ ] Klik een `klant.*` chip in het variabelen-paneel → placeholder verschijnt
      in body.
- [ ] Hover over een chip → tooltip toont voorbeeldwaarde.
- [ ] Body bevat alleen named keys → variabelen-paneel toont read-only registry
      rows (geen handmatige inputs).
- [ ] Type `{{onbekend.key}}` in body → preview toont rode-stip indicator naast
      placeholder, save toont duidelijke "Onbekende variabele(n)" error.
- [ ] Save template als LOCAL → Submit naar Meta → check
      `whatsapp_meta_templates.meta_param_mapping` is gevuld in DB.
- [ ] Wacht op APPROVED status (kan minuten duren) → sync via "Sync met Meta".
- [ ] Open Inbox conversation met gekoppelde klant → klik Template Picker →
      kies named template → send.
- [ ] Check WhatsApp op telefoon → bericht bevat resolved waarden (geen `{{...}}`
      meer zichtbaar).
- [ ] Check `whatsapp_messages.template_variables` jsonb → bevat de resolved key-
      value paren.
- [ ] Audit-log: `whatsapp.send_template` rij heeft `resolve_mode = 'server_resolved'`
      en `resolve_warnings = null`.
- [ ] Send template met `factuur.betaal_link` → `invoices.payment_url` is gevuld
      na eerste send.
- [ ] Env-vars `COMPANY_*` ingevuld in Vercel → `bedrijf.*` keys leveren geen lege
      strings op.

---

## Referenties

- Variable registry + parsers + resolvers: `api/_lib/template-variables.js`
- Meta submit + named→positional conversion: `api/admin-meta-templates-submit.js`
- Send-time resolution: `api/inbox-send-template.js`
- TL invoice-link helper: `api/_lib/teamleader-invoice-link.js`
- Admin editor UI: `modules/admin.html` (sectie WhatsApp Templates)
- Finance Fase 4 recon-rapport: `docs/finance-4-recon.md`
