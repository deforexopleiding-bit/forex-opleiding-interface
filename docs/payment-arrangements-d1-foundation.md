# Payment Arrangements — D1 Foundation

Datum: 2026-06-09
Sprint: D1 (DB-fundament + approval-queue + propose-wizard, geen TL-executor)
Branch: `fix/inbox-bubble-compact-and-template-modal-scroll` (mixed)
Migratie: `docs/sql-migrations/2026-06-09-payment-arrangements-d1.sql`

---

## 1. Wat D1 doet (en wat het bewust NIET doet)

D1 is het fundament voor de Betalingsregelingen-feature binnen Finance > Wanbetalers.
We bouwen:

1. **DB-schema** — drie tabellen (`payment_arrangements`, `pending_actions`,
   `arrangement_action_settings`) met RLS-policies, indices en `updated_at` triggers.
2. **Propose-API** — `POST /api/arrangements-propose` valideert + schrijft een
   `payment_arrangement` (status `voorgesteld`) plus N `pending_actions` (status
   `pending`) per arrangement-type.
3. **Approval-queue** — admin-tab in `/modules/admin.html#approval-queue` met
   filter-pills (pending/approved/rejected/executed/failed), bulk-acties,
   detail-modal en tab-badge.
4. **Hoofdnav-badge** — sidebar Admin-link krijgt een rood telleropje met de
   PENDING-count, alleen zichtbaar voor users met
   `finance.arrangements.approve`. Klik op badge → direct naar
   `#approval-queue`.

Wat D1 expliciet NIET doet:

- **Geen TL-sync executor** — `pending_actions.status='approved'` blijft staan.
  Geen TL-call, geen factuur-mutatie, geen abonnement-pauze. Dat is D2.
- **Geen split-parts generator** — `gespreid` accepteert handmatig opgegeven
  parts in de wizard. Auto-genereer (3x gelijke parts, etc.) komt in D3.
- **Geen auto-execute** — `arrangement_action_settings.auto_execute` bestaat als
  kolom maar wordt nergens gelezen. Toggle-UI komt in D4.
- **Geen dunning auto-pause** — workflow-run pauzeren bij goedgekeurde
  regeling is D5.
- **Geen inbox-wizard** — `Stel afspraak voor`-knop in inbox-conversatie is D6.

---

## 2. Tabellen + indices + RLS

### `payment_arrangements`

Eén rij per voorstel/regeling per klant. Status-flow:
`voorgesteld → goedgekeurd | afgewezen → actief → voltooid | geannuleerd`.

Kolommen (samenvatting; zie migratie voor types):

- `id uuid PK`
- `customer_id uuid NOT NULL → customers(id) ON DELETE RESTRICT`
- `invoice_ids uuid[]` — array van factuur-UUIDs (FK op API-niveau)
- `type text CHECK (uitstel | gespreid | pauze | kwijtschelding | overig)`
- `status text CHECK (...)` — zie flow boven
- `details jsonb` — type-specifieke payload (`new_due_date`, `parts[]`,
  `pause_from/until`, `write_off_amount`, etc.)
- `proposed_by / approved_by uuid → profiles(id) ON DELETE SET NULL`
- `approved_at / rejected_at timestamptz`
- `reject_reason text`, `notes text` (rationale)
- `created_at / updated_at timestamptz` (trigger zet `updated_at`)

Indices: `customer`, `status`, `created_at DESC`, `type`.

### `pending_actions`

Eén of meerdere rijen per arrangement (afhankelijk van type). Workflow-tabel
die door de approval-queue UI én latere executors (D2+) gelezen wordt.

Status-flow: `pending → approved | rejected → executed | failed | cancelled`.

Kolommen:

- `id uuid PK`
- `customer_id uuid → customers(id) ON DELETE CASCADE`
- `arrangement_id uuid → payment_arrangements(id) ON DELETE CASCADE`
- `action_type text NOT NULL` — vrij-tekst discriminator (zie §4)
- `payload jsonb NOT NULL` — uitvoer-payload (type-specifiek)
- `status text CHECK (...)`
- `proposed_by / approved_by uuid → profiles(id) ON DELETE SET NULL`
- `approved_at / executed_at timestamptz`
- `execution_result jsonb` — vrij vat voor TL-IDs, error-text bij failed
- `reject_reason text`
- `scheduled_for timestamptz` — optioneel (auto-execute D4)
- `expires_at timestamptz` — optioneel (auto-cancel cron later)
- `created_at / updated_at timestamptz`

Indices: `customer`, `arrangement`, `(status, created_at DESC)`,
`action_type`, partial op `scheduled_for IS NOT NULL`.

### `arrangement_action_settings`

Per `action_type` een rij met auto-execute toggles + grenzen. Wordt door D1
NIET gelezen — leef nog leeg of vul'm seed-only via SQL. Pas in D4 wordt dit
admin-UI-instelbaar en door de executor gerespecteerd.

### RLS

Identiek aan `finance-fase-1-fundament.sql` (mei 2026):

- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- `SELECT USING (auth.uid() IS NOT NULL)` — alle authenticated users
- `INSERT/UPDATE/DELETE WITH CHECK (false)` — alleen service-role via
  `supabaseAdmin` in API-endpoints kan schrijven

UI-laag-RBAC (zie §5) bepaalt wie *welke* arrangement-rij in de UI mag zien
of muteren. RLS is hier de tweede laag (defense-in-depth).

---

## 3. Endpoints overzicht

| Endpoint | Methode | Doel | Permission |
|---|---|---|---|
| `/api/arrangements-propose`     | POST   | Maak arrangement + pending_actions | `finance.arrangements.propose` |
| `/api/arrangements-list`        | GET    | Lijst arrangements (filter status/type/customer) | `finance.arrangements.view` |
| `/api/arrangements-detail`      | GET    | Detail incl. pending_actions | `finance.arrangements.view` |
| `/api/arrangements-cancel`      | POST   | Annuleer arrangement + bijbehorende pending_actions | `finance.arrangements.propose` |
| `/api/pending-actions-list`     | GET    | Approval-queue lijst + counts per status | `finance.arrangements.view` |
| `/api/pending-actions-detail`   | GET    | Detail (1 action) | `finance.arrangements.view` |
| `/api/pending-actions-approve`  | POST   | Zet status → approved (D2 voegt executor toe) | `finance.arrangements.approve` |
| `/api/pending-actions-reject`   | POST   | Zet status → rejected + reden | `finance.arrangements.approve` |

Alle endpoints gebruiken `createUserClient(req)` voor auth, `requirePermission()`
voor RBAC, en `supabaseAdmin` voor de writes (vanwege RLS `WITH CHECK (false)`).

---

## 4. Vijf arrangement-types + per type pending_actions

Bij `arrangements-propose` wordt het arrangement-type omgezet in 1 of meer
`pending_actions`-rijen. Dual-table pattern: 1 arrangement → N pending_actions.

| Arrangement-type | action_type (per pending_action) | Aantal rows | Payload-keys |
|---|---|---|---|
| `uitstel`        | `arrangement.uitstel`         | per factuur 1 | `invoice_id`, `new_due_date`, `rationale` |
| `gespreid`       | `arrangement.gespreid`        | per factuur 1 | `invoice_id`, `parts:[{amount,due_date}]`, `rationale` |
| `pauze`          | `arrangement.pauze`           | 1             | `subscription_id`, `pause_from`, `pause_until`, `reason` |
| `overig` (stop)  | `arrangement.abonnement_stop` | 1             | `subscription_id`, `stop_date`, `reason` |
| `kwijtschelding` | `arrangement.kwijtschelding`  | per factuur 1 | `invoice_id`, `write_off_amount`, `reason` |

Validatie-rules in `arrangements-propose.js`:

- `uitstel` — `details.new_due_date` (YYYY-MM-DD) verplicht
- `gespreid` — `details.parts.length >= 2` én `sum(parts.amount) == sum(invoice.amount_total)` met 1ct tolerantie
- `pauze` — `subscription_id`, `pause_from`, `pause_until`, `reason` allemaal verplicht
- `abonnement_stop` — alias voor `overig` met `details.stop_date` + `reason`
- `kwijtschelding` — `write_off_amount > 0` en `reason` verplicht

UPPERCASE-aliassen (`UITSTEL`, `SPLITSING`, `ABONNEMENT_PAUZE`,
`ABONNEMENT_STOP`, `KWIJTSCHELDING`) worden geaccepteerd voor forward-compat
met legacy callers en testfixtures.

---

## 5. Flow: voorstel → queue → approve → APPROVED

```
                  ┌──────────────────────────┐
 user / agent ──▶ │ Wanbetalers > Voorstel   │
                  │ (wizard in finance.html) │
                  └────────────┬─────────────┘
                               │ POST /api/arrangements-propose
                               ▼
              ┌──────────────────────────────────┐
              │ payment_arrangements             │
              │   status = 'voorgesteld'         │
              │ pending_actions (N rows)         │
              │   status = 'pending'             │
              └────────────────┬─────────────────┘
                               │ poll elke 60s
                               ▼
                   ┌─────────────────────────┐
                   │ sidebar Admin badge "N" │
                   └───────────┬─────────────┘
                               │ click → /modules/admin.html#approval-queue
                               ▼
              ┌──────────────────────────────────┐
              │ Approval-queue tab               │
              │  filter pending, bulk approve    │
              │  per row: rationale + payload    │
              └────────────────┬─────────────────┘
                               │ POST /api/pending-actions-approve
                               ▼
                  ┌──────────────────────────┐
                  │ pending_actions.status   │
                  │   = 'approved'           │
                  │ approved_by/approved_at  │
                  │ ─── STOPS HIER (D1) ──── │
                  └──────────────────────────┘

  D2 introduceert executor (TL-call + factuur-mutatie + status → executed/failed)
```

In D1 blijft een `pending_actions`-rij dus eeuwig op `approved` staan na klik
op Approve. Dit is correct gedrag — de UI toont 'm in de "Approved"-pill en
laat zien dat hij wacht op executor. Geen tijdslimiet (`expires_at` is leeg).

---

## 6. RBAC keys + matrix

Vier nieuwe `feature_key`'s in `FEATURE_REGISTRY` (admin.html):

| Feature key                       | Default-rollen die mogen | Doel |
|---|---|---|
| `finance.arrangements.view`       | super_admin, admin, manager, administratie | Lezen lijst + detail |
| `finance.arrangements.propose`    | super_admin, admin, manager, administratie | Voorstel maken + annuleren |
| `finance.arrangements.approve`    | super_admin, admin, manager | Approve/reject pending_actions (én badge zichtbaar) |
| `finance.arrangements.config`     | super_admin                | Auto-execute toggles (D4) |

Admin-tab `Approval-queue` is zichtbaar zodra de user `finance.arrangements.view`
heeft. Approve/reject knoppen rendered alleen bij `finance.arrangements.approve`
(de endpoints valideren dit nogmaals server-side).

Hoofdnav-badge `navApprovalsBadge` is alleen zichtbaar voor users met
`finance.arrangements.approve` — een viewer-only krijgt de admin-tab wel,
maar geen rode badge in de sidebar.

super_admin heeft via `user_has_permission()`-RPC altijd alle keys
(impliciet — geen rij in `role_permissions` nodig).

---

## 7. Sidebar approval-badge (hoofdnav)

Geïmplementeerd in `modules/shared/sidebar.js`:

- Bij elke mount: `updateApprovalsBadge()` polt 1x.
- `setInterval(updateApprovalsBadge, 60_000)` herhaalt elke minuut.
- `clearInterval` op `beforeunload` (defense in depth — browsers kunnen
  achtergrond-tabs throttlen, maar expliciet stoppen voorkomt double-polling
  bij snelle navigatie).
- RBAC-cache: 1x `RBAC.ensurePermissionsLoaded()`, daarna cached `true|false`.
- Endpoint: `GET /api/pending-actions-list?status=pending&limit=1` — server
  retourneert `counts.PENDING` (en `total`) zonder de items uit te lezen
  (limit=1 om netwerk-payload klein te houden).
- Klik op badge: `e.stopPropagation()` + `e.preventDefault()` op de outer
  `<a>` (anders zou de Admin-link zonder hash winnen) en directe nav naar
  `/modules/admin.html#approval-queue`.
- Exposed als `window.AgentShared.refreshApprovalsBadge` zodat de admin-tab
  zelf de badge meteen kan laten zakken na een approve/reject zonder op de
  60s-cyclus te wachten.

---

## 8. Roadmap

| Sprint | Scope | Status |
|---|---|---|
| **D1** | DB-fundament + propose-API + approval-queue UI + hoofdnav-badge | ✅ live |
| **D2** | TL-sync executor — leest `pending_actions.status='approved'`, voert TL-call uit (invoice due-date update, credit-note bij kwijtschelding, subscription.deactivate bij stop), zet status → `executed` of `failed` met error-text in `execution_result` | TODO |
| **D3** | Split-parts generator — wizard biedt presets (3x gelijke parts, 2x 50%, custom) voor `gespreid`-type met datum-spread (maandelijks/wekelijks); validatie blijft sum-check | TODO |
| **D4** | Auto-execute toggles — UI in admin voor `arrangement_action_settings`: per `action_type` auto-execute on/off + `max_amount` / `max_days` grenzen + `notify_roles[]`. Executor (D2) checkt deze settings; binnen grenzen = skip approval-stap | TODO |
| **D5** | Dunning workflow auto-pause — bij APPROVED arrangement met `has_active_run`-klant: pauzeer de bijbehorende `dunning_workflow_runs`-rij automatisch met source='arrangement_<id>'. Resume bij `voltooid`-arrangement | TODO |
| **D6** | Inbox-wizard — `Stel afspraak voor`-knop in WhatsApp/email inbox naast bestaande quick-replies. Pre-fillt customer_id + open facturen, opent dezelfde propose-wizard als finance.html | TODO |

---

## 9. Bekende beperkingen + open items

- **Arrangement-cancel race**: bij `POST /api/arrangements-cancel` worden
  bijbehorende `pending_actions` op `cancelled` gezet. Als executor (D2)
  net tegelijk uitvoert kan er een race ontstaan. Mitigatie in D2: SELECT FOR UPDATE
  binnen executor + skip non-`approved` rows.
- **Geen FK op `invoice_ids[]`**: Postgres ondersteunt geen array-FK. Validatie
  zit in `arrangements-propose.js` (`invoices.length !== invoice_ids.length` →
  404). Geen check bij DELETE/archive van een factuur — D2 executor moet hier
  defensief omgaan (skip + log).
- **Geen audit-log op pending_actions-zelf**: arrangement-create + approve/reject
  worden in `audit_log` geschreven, maar individuele pending_action-mutaties
  (status-overgang) niet. Voor v1 acceptabel — D2 executor logt z'n eigen
  resultaat in `execution_result` jsonb.
- **Badge-polling op alle pagina's**: de sidebar wordt op élke ingelogde pagina
  gemount, dus de badge polt overal elke 60s. Voor 5-10 actieve users tegelijk
  = ~600 req/uur over alle tabs. Ruim binnen Supabase Free-tier budget; geen
  optimalisatie nodig in D1.
