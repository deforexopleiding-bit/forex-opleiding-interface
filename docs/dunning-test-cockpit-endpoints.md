# Dunning Test Cockpit — Endpoint-contractsheet

Voor externe test-harnesses (Chrome-extensie). Base URL:
`https://forex-opleiding-interface.vercel.app`. Alle endpoints hieronder
vereisen **super_admin** via `Authorization: Bearer <supabase-access-token>` —
zie [Auth](#auth-voor-de-test-harness) onderaan.

Grendel-invariant: verzending routeert **altijd** via
`dunning_sandbox_contact`. Alle cockpit-writes zijn is_test-only. Geen
enkel endpoint hier kan een echte klant of factuur raken.

## Inhoud

- [Read](#read)
- [Provisioning / edit](#provisioning--edit)
- [Cockpit-actions](#cockpit-actions)
- [Reset & trigger](#reset--trigger)
- [Sandbox-endpoints](#onderliggende-sandbox-endpoints-via-trigger-of-direct)
- [Dry-run toggle](#dry-run-toggle)
- [Auth](#auth-voor-de-test-harness)
- [Error-shape](#standaard-error-shape)

## Read

### `GET /api/dunning-test-status`

Cockpit-init. Retourneert config + tellingen + recente audit.

Response 200:
```
{
  ready: boolean,                     // true als sandbox_contact.phone én .email gezet
  blockers: string[],                 // menselijk leesbaar per lege config
  sandbox_contact: { phone: string|null, email: string|null },
  dry_run_enabled: boolean,           // uit app_settings.dunning_dry_run.enabled (default TRUE fail-safe)
  test_customer_count: number,
  test_invoice_count:  number,
  recent_audit: Array<{
    id: uuid, action: string, status: 'ok'|'error'|'blocked',
    admin_email: string, target: object,
    error_message: string|null, created_at: iso
  }>                                  // laatste 20
}
```

### `GET /api/dunning-test-customers-list`

Alle is_test-klanten met invoice_count.

Response 200:
```
{
  ok: true, total: number,
  customers: Array<{
    id: uuid, name: string,           // '🧪 TEST — ' prefix gestript
    phone: string|null, email: string|null,
    invoice_count: number, created_at: iso
  }>                                  // max 50, nieuwste eerst
}
```

### `GET /api/dunning-test-context?customer_id=<uuid>`

Aggregatie voor 1 is_test-klant.

Query: `customer_id` (uuid, verplicht).

Response 200:
```
{
  ok: true,
  customer:   { id, first_name, last_name, email, phone, is_test, created_at },
  invoices:   [{ id, invoice_number, amount_total, amount_paid, status, due_date, test_metadata }],
  active_run: { id, status, step_index, current_step_id, next_action_at,
                paused_by_conversation_id, paused_by_arrangement_id,
                needs_attention } | null,
  timeline:   [{ source: 'audit'|'dunning_log'|'wa_message', ts: iso, ... }],   // top-80
  conversations: [{ id, phone_number, last_inbound_at, last_message_at, is_test, message_count }],
  messages:      [{ id, conversation_id, direction, body, created_at, meta_wamid }],
  pending_actions: [{ id, action_type, status, created_at, due_at, meta }]
}
```

Errors: `400` als customer_id ontbreekt of `!customer.is_test`.

## Provisioning / edit

### `POST /api/dunning-test-customer-create`

Body:
```
{
  full_name: string,                  // verplicht — '🧪 TEST — ' krijgt automatisch prefix
  email?:    string,
  phone?:    string,
  address_street?:  string,           // optioneel — nodig voor WIK-brief
  address_number?:  string,
  address_postal?:  string,
  address_city?:    string,
  address_country?: 'NL' | 'BE'       // default 'NL' bij afleiding
}
```

Response 201:
```
{
  ok: true,
  customer: {
    id, first_name, last_name, email, phone,
    address_street, address_number, address_postal, address_city, address_country,
    is_test, created_at
  },
  message: string
}
```

Errors: `400` als `full_name` ontbreekt of `address_country` niet NL/BE.

### `POST /api/dunning-test-invoice-create`

Body:
```
{
  customer_id: uuid,                  // verplicht, moet is_test=true zijn
  invoices: Array<{
    amount:       number,             // > 0
    days_late:    number,             // >= 0
    scenario_tag?:     string,
    expected_outcome?: string
  }>                                  // >= 1 entry
}
```

Response 201:
```
{
  ok: true, count: number,
  invoices: [{ id, invoice_number: 'TEST-<hex8>', amount_total, due_date, is_test, test_metadata }],
  message: string
}
```

### `POST /api/dunning-test-edit-customer`

Body:
```
{
  customer_id: uuid,                  // verplicht, moet is_test=true zijn
  name?:  string,
  phone?: string | null,
  email?: string | null,
  address_street?:  string | '',      // '' = wissen naar NULL, undefined = laten staan
  address_number?:  string | '',
  address_postal?:  string | '',
  address_city?:    string | '',
  address_country?: 'NL' | 'BE' | '',
  invoices?: Array<{
    invoice_id?:   uuid,              // bestaand → UPDATE; ontbrekend → INSERT
    amount:        number,
    days_overdue:  number
  }>                                  // ontbrekend → contact-only edit
}
```

Response 200:
```
{
  ok: true,
  contact_changed: boolean,
  teardown_counts?: { pending_actions, dunning_workflow_runs, ..., email_messages: number },
  invoices?: { requested, deleted, updated, inserted: number },
  engine?:   { ok: boolean, summary_keys?: string[], error?: string }
}
```

Errors: `400` bij non-is_test klant, invoice_id niet bij deze klant, of
`address_country` niet NL/BE/leeg.

## Cockpit-actions

### `POST /api/dunning-test-simulate-promise`

Body:
```
{
  customer_id:      uuid,             // verplicht, is_test-guard
  days_ago?:        number,           // default 4; negatief = toekomst (nog-niet-rijp)
  conversation_id?: uuid | null
}
```

Response 201:
```
{ ok: true, task_id: uuid, promised_date_hint: 'YYYY-MM-DD',
  days_ago: number, will_ripen_immediately: boolean, message: string }
```

### `POST /api/dunning-test-create-task`

Body:
```
{
  customer_id: uuid,
  task_type:   'MANUAL_FOLLOWUP' | 'MANUAL_VERIFY_PAYMENT' | 'MANUAL_ESCALATION'
}
```

Response 201:
```
{ ok: true, task: { id, action_type, created_at } }
```

### `POST /api/dunning-test-complete-task`

Body:
```
{
  customer_id: uuid,
  task_id?:    uuid,                  // als gegeven: sluit specifiek
  task_type?:  string                 // anders: oudste open van type
}
```

Response 200:
```
{ ok: true, closed_task_id: uuid, action_type: string }
```

### `POST /api/dunning-test-simulate-backfill-orphan`

Seed een backfill-wees (D1/D2-scenario) op de is_test-klant, exact in de
toestand die `conv-less-resume` herkent (bevestigd door DB-scan 2026-08-25):

```
status                    = 'paused'
paused_manual_reason      = 'reply_backfilled_from_log'
paused_by_conversation_id = NULL
paused_by_arrangement_id  = NULL
paused_by_manual_user_id  = NULL
needs_attention           = false
paused_at                 = now
```

`next_action_at` en `current_step_id` worden bewust NIET aangeraakt.

Body:
```
{ customer_id: uuid }                 // verplicht, is_test-guard
```

Als de klant nog geen active/paused run heeft, draait het endpoint eerst
`runEngine({mode:'manual', scope:'test'})` om er één te enrollen. Werkt
alleen als de factuur `days_late >= workflow.min_days_overdue` haalt.

Response 201:
```
{
  ok: true, run_id: uuid, enrolled_fresh: boolean,
  state: {
    status, paused_manual_reason,
    paused_by_conversation_id, paused_by_arrangement_id, paused_by_manual_user_id,
    needs_attention, paused_at, current_step_id, workflow_id
  },
  message: string
}
```

Errors:
- `400` — geen customer_id, non-is_test klant, geen open is_test-factuur, of engine kon niet enrollen (waarschijnlijk days_overdue-drempel niet gehaald).
- `500` — DB-fout of engine-crash.

### `POST /api/dunning-test-resume-run`

Body: `{ customer_id: uuid }`

Response 200:
```
{
  ok: true, scanned_runs: number,
  per_run: [{ run_id, via: 'conversation'|'arrangement'|'conv-less-resume'|null|'error',
              outcome: object }]
}
```

### `POST /api/dunning-test-wik-brief`

Body:
```
{
  customer_id: uuid,
  run_id?:     uuid,                  // anders: nieuwste dunning_workflow_run
  country?:    'NL' | 'BE'            // anders: afleiden uit adres
}
```

Response 201:
```
{ ok: true, brief_id: uuid, pdf_path: string, template_code: string, country: string, message: string }
```

Errors: `400` met `code: 'ADDRESS_INCOMPLETE' | 'TEMPLATE_NOT_FOUND' | ...`.

### `POST /api/dunning-test-verify-grendel`

Geen body. Draait 6 scenario's tegen de grendel via DI (raakt geen live app_settings).

Response 200:
```
{ ok: true, passed: 6, total: 6,
  results: [{ name, expected: 'throw'|'ok', actual: 'throw'|'ok', ... }] }
```

## Reset & trigger

### `POST /api/dunning-test-reset`

Body:
```
{
  confirm: true,                      // verplicht — 400 anders
  dry_run_count_only?: boolean        // default TRUE
}
```

Response 200:
```
{ ok: true, dry_run: boolean,
  counts: { customers, invoices, dunning_workflow_runs, whatsapp_conversations: number },
  message: string }
```

Delegeert aan RPC `public.dunning_test_cockpit_reset(p_dry_run boolean)` —
FK-veilige transactie, invoices worden gewist vóór customers (zie
`docs/sql-migrations/2026-08-24-dunning-test-cockpit-reset-fn.sql`).

### `POST /api/dunning-test-trigger`

Multiplex — forwardt Authorization-header naar de gekozen sandbox-endpoint.

Body:
```
{
  action: 'engine' | 'conversation-reminders' | 'bulk-send' | 'breach-check'
        | 'fast-forward' | 'simulate-inbound' | 'mark-paid'
        | 'send-test-template'
        | 'promise-maturity' | 'conv-less-resume',
  params?: object                     // shape hangt af van downstream endpoint
}
```

Response 200/error passthrough:
```
{ ok: boolean, action: string, http_status: number, response: object }
```

## Onderliggende sandbox-endpoints (via trigger of direct)

### `POST /api/wanbetalers-sandbox-fast-forward`

Body:
```
{
  days?:   number,                    // 1..365; default 7 als geen to_day
  to_day?: 7 | 14 | 21 | 28 | 37      // absolute ladder-doelstelling; wint over days
}
```

- `to_day` gezet → `days = to_day - elapsed_since_run.started_at` (in dagen); al voorbij → skip.
- Werkt op de laatste is_test-klant (sandbox-customer).

Response 200:
```
{
  ok: true, mode: 'to_day'|'relative', days: number, to_day: number|null,
  invoices_updated, runs_updated, convs_updated,
  call_logs_updated, pending_actions_updated, arrangements_updated: number,
  skipped?: true, elapsed_days?: number, message?: string
}
```

### `POST /api/wanbetalers-sandbox-simulate-inbound`

Body:
```
{
  body?:     string,                  // default 'Ik zal deze week betalen.'
  channel?:  'whatsapp' | 'email'     // default 'whatsapp'
}
```

WhatsApp-tak (default) — response 201: `{ ok: true, conversation_id, message_id, wamid, ... }`.

Email-tak — response 201:
```
{
  ok: true, channel: 'email',
  email_message: { id, mailbox: 'administratie', imap_uid, from_address, subject, date_received },
  paused_run_ids: uuid[],
  message: string
}
```

`imap_uid` is een negatief numeric (bigint-safe, buiten reële IMAP-UID-range).

### `POST /api/wanbetalers-sandbox-mark-paid`

Body:
```
{ amount?: number, partial?: number }
```

Response 200: `{ customer_id, invoices_updated, amount_paid_total }`.

### `POST /api/wanbetalers-sandbox-run-engine`

Body: `{}` — draait `runEngine({mode:'manual', scope:'test'})`.

**Enrollt zelf** de eerste run voor is_test-klanten met een is_test-factuur
die aan de workflow-triggers voldoet (geen aparte enroll-endpoint nodig).
Voorwaarden en ladder-wachttijden: zie header-comment van
[api/wanbetalers-sandbox-run-engine.js](api/wanbetalers-sandbox-run-engine.js).

Response 200: `{ ok: true, dry_run: boolean, engine_result: { started, advanced, errors: [...] } }`.

### `POST /api/cron-dunning-conversation-reminders`

Body: `{ scope?: 'production' | 'test' }` — default `'production'`.

- Bij `scope='test'`: super_admin OF `CRON_SECRET`.
- Response 200: `{ scope, processed_count, r1_sent, r2_sent, resumed, skipped, errors, duration_ms }`.

### `POST /api/wanbetalers-sandbox-run-promise-maturity`

Body: `{}`. Wrapper voor `runPromiseMaturity({scope:'test'})`.

Response 200:
```
{ ok: true, summary: {
    enabled, dry_run, config_mode, scanned, matured,
    fulfilled, broken_auto_sent, broken_human, no_date_human,
    skipped: [...], errors: [...]
} }
```

### `POST /api/wanbetalers-sandbox-run-conv-less-resume`

Body: `{}`. Wrapper voor `runConvLessResume({scope:'test'})`.

Response 200:
```
{ ok: true, summary: {
    enabled, config_mode, scanned,
    paid_completed, recent_contact_human, resumed, stale_human,
    superseded, duplicate_skipped, needs_attention_skipped, test_skipped,
    skipped: [...], errors: [...]
} }
```

## Dry-run toggle

### `POST /api/wanbetalers-sandbox-set-dry-run`

Body: `{ enabled: boolean }`

Response 200: `{ ok: true, dunning_dry_run: { enabled: boolean } }`.

Effect: schrijft `app_settings.dunning_dry_run = {enabled: <bool>}`.
Default bij ontbrekende key = **TRUE** (fail-safe AAN). Wordt binnen ~10s
door de cache in `_lib/dunning-dry-run.js` opgepakt.

Alternatief via SQL:
```sql
INSERT INTO app_settings (key, value) VALUES ('dunning_dry_run', '{"enabled": false}'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

## Auth voor de test-harness

Elk endpoint valideert `Authorization: Bearer <access_token>` via
`verifyAdmin(req)` → JWT-decode → `profiles.role === 'super_admin' AND is_active`.

Geen super_admin = **403** met `{error: 'Alleen super_admin.'}` of
`{error: 'Toegang geweigerd. Admin-rol vereist.'}`.

**`window.AgentShared.apiFetch`** is de standaard client-wrapper — leest de
Supabase-session en injecteert Bearer. Werkt in een content-script dat op
`https://forex-opleiding-interface.vercel.app` draait en toegang heeft tot
de `window`-scope van de pagina (via `chrome.scripting.executeScript` met
`world: 'MAIN'`).

Voor een **background/service-worker** (buiten page-context): parse
`localStorage['sb-<projectRef>-auth-token']` → `.access_token` → gebruik
zelf als Bearer.

**Geen cookie-auth pad** — alles gaat via Bearer.

## Standaard error-shape

Alle endpoints retourneren fouten als `{error: string, code?: string, details?: any}`.

Statuscodes:
- **400** — validatie / non-is_test-guard / whitelist-fail.
- **401** — geen/verkeerd Bearer-token.
- **403** — geen super_admin of geen permission.
- **404** — resource niet gevonden.
- **405** — verkeerde HTTP-methode.
- **500** — DB-fout (Supabase error message doorgegeven).
- **502** — Anthropic-call faalde (alleen `dunning-test-ai-plan`).
