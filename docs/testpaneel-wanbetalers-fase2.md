# Testpaneel Wanbetalers — Fase 2 (individuele + gecombineerde template-tests)

**Voortbouwend op fase 1** ([`docs/testpaneel-wanbetalers-fase1.md`](testpaneel-wanbetalers-fase1.md)).

## Doel

Individuele en gecombineerde tests per dunning-template naar de sandbox-
ontvanger, met gebruik van **exact dezelfde verzendcode als de echte
klant-flow** (zodat een geslaagde test bewijst dat productie ook werkt).

## Wat fase 2 toevoegt

### 1. Nieuw endpoint — [`api/wanbetalers-sandbox-send-test-template.js`](../api/wanbetalers-sandbox-send-test-template.js)

- POST `{ template_id, channel? }` — verstuur 1 template naar de sandbox-klant
- Importeert **direct** de productie-executor:
  - [`executeEmailStep`](../api/_lib/dunning-step-executors.js) voor `kind='email'`
  - [`executeWhatsappStep`](../api/_lib/dunning-step-executors.js) voor `kind='whatsapp'`
- Bouwt een "step-shape" (`{ config: { template_id } }`) zoals de engine 'em
  aan de executor zou geven, gets sandbox customer + test-invoices, en delegeert
- **Gebruikt niet de eigen sandbox-run-bulk send-code** — die was al gefixt
  (representative flow met `buildMetaTemplateVariables`), maar door de
  echte executor te gebruiken is er nul risico op divergentie
- Response bevat: `status`, `dry_run`, `log_event`, `log_payload`, plus
  convenience-velden `message_id` (mail), `wamid` (WA), `to`, `subject`,
  `error`, `hint`

### 2. Sectie 4 — Individuele template-tests (frontend)

- Auto-laadt actieve templates via bestaand `/api/finance-dunning-templates-list?active=true`
- 2 blokken (WhatsApp / Email); per template één "Test versturen" knop
- Bij DRY-RUN=UIT: dezelfde 2-staps confirm-modal als bestaande send-acties
- Resultaat wordt bovenaan in een cumulatieve resultaat-lijst getoond met
  groene ✓ / rode ✗ badge + status + wamid/mail-id + hint

### 3. Sectie 5 — Gecombineerde test "1 dag te laat: mail + WhatsApp"

- Twee dropdowns (WA-template + Mail-template)
- **Auto-preselect**: WA waar `meta_template_name = 'aanmaning_dag7'`,
  mail waar `name` matcht met `/dag[_\\s-]*7/i` of anders `/aanmaning/i`
- "Verstuur beide"-knop → roept endpoint 2× aan
- Toont beide resultaten side-by-side + logt ze ook naar de individuele
  resultaat-lijst

### 4. Sectie-hernummering

- Fase 1 had: 1 Contact, 2 Seed, 3 Acties, 4 Live status
- Fase 2 wordt: 1 Contact, 2 Seed, 3 Acties, **4 Individuele tests**,
  **5 Combi**, 6 Live status

## Waarom dit "de echte executor" is (geen 0-param-bug)

`executeWhatsappStep` in [api/_lib/dunning-step-executors.js:336-908](../api/_lib/dunning-step-executors.js) doet:

- `loadTemplate` uit dunning_templates
- Pre-fetch betaal-link via `ensureInvoicePaymentLink`
- `renderTemplate` (gedeeld met inbox-send-template)
- `buildMetaTemplateVariables(body, values)` — de body-scan die positional
  params vult in Meta-approved volgorde
- Empty-param guard (voorkomt Meta #131008)
- Diagnose-warn bij body-drift (voorkomt Meta #132000)
- `assertRecipientMatchesSandbox` als klant `is_test=true` is
- `isDryRunEnabled` short-circuit → geen echte Meta-call, wel `email_sent` /
  `whatsapp_sent` log-event met `dry_run:true`
- Echte `sendTemplate` (Meta) of `sendMail` (Strato SMTP) bij live-modus

Fase 2 gebruikt **exact deze code** — geen duplicaat, geen wrapper met eigen
render-logica. Nul risico op divergence tussen "test slaagt" en "productie
werkt".

## Veiligheid — inheritance van fase 1

Alle 5 lagen van fase 1 blijven actief:

1. **Auth** — `requireSuperAdmin` op nieuwe endpoint, `AuthShared.requireAuth()` + `profile.role==='super_admin'` in UI
2. **SQL-scope** — `is_test=true` op invoices/customers SELECTs
3. **Recipient-guard** — `assertRecipientMatchesSandbox` in de executor zelf (dus GARANTEERD onaangeraakt)
4. **DRY-RUN default AAN** — forceer op page-load blijft actief (fase 1 code)
5. **UI context-pin** — mismatch-badge blijft actief

Toevoegingen fase 2:

- Nieuwe endpoint doet expliciete `customer.is_test !== true` assertie
  bovenop `getSandboxCustomer()`
- Template `is_active`-check voorkomt tests op inactieve templates
- `channel` param validatie (auto|email|whatsapp) voorkomt cross-kind sends

## Verificatie-checklist fase 2

- [ ] Sectie 4 laadt alle actieve WA + email templates
- [ ] "Test versturen" bij DRY-RUN=AAN → groene DRY-RUN badge + hint zichtbaar,
      geen echte send
- [ ] "Test versturen" bij DRY-RUN=UIT → confirm-modal met contact-preview
      moet klikken vóór het draait
- [ ] LIVE test WA → wamid in resultaat + echte WhatsApp op je telefoon
- [ ] LIVE test mail → mail-id in resultaat + echte mail in je inbox
- [ ] Sectie 5 combi met dag7-preset → beide templates verstuurd,
      beide resultaten side-by-side, beide zichtbaar in log
- [ ] Executor + engine + guards ongewijzigd
      (`git diff main -- api/_lib/dunning-*.js api/_lib/wanbetalers-sandbox.js` = leeg)
