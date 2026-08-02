# Handmatige-pauze reden-flag — root-cause fix voor wees-runs

## Achtergrond

Twee endpoints zetten `dunning_workflow_runs.status='paused'`:

- [api/finance-dunning-pause-by-customer.js](../api/finance-dunning-pause-by-customer.js)
  — "Pauzeer aanmaan-flow"-knop in de inbox-thread-header (fase 4 blok 1).
- [api/finance-dunning-run-control.js](../api/finance-dunning-run-control.js)
  `action='pause'` — de generieke pauze-knop op run-detail.

Vóór deze PR schreven beide **alleen** `status='paused'` — geen enkel
reden-veld. Result: 12 "wees-runs" die niet te onderscheiden waren van
engine-pauzes (`paused_by_conversation_id` / `paused_by_arrangement_id`
bleven NULL, dus dossier-view kon geen reden tonen; overzicht toonde ze
als generiek `paused`).

Zie diagnose in [de PR-body van #NNNN](.) voor de reconstructie via
dunning_log per run.

## Fix — semantiek

Nieuwe kolommen op `dunning_workflow_runs`:

| Kolom | Type | Doel |
|---|---|---|
| `paused_by_manual_user_id` | `UUID` FK naar `auth.users` (ON DELETE SET NULL) | Wie klikte de knop |
| `paused_manual_reason`     | `TEXT`      | Vrije-tekst reden (max 300 chars, endpoint-side afgekapt) |
| `paused_at`                | `TIMESTAMPTZ` | Timestamp van de pauze |

**Invariante state:** bij `status='paused'` is precies **één** van
`paused_by_conversation_id` / `paused_by_arrangement_id` /
`paused_by_manual_user_id` NOT NULL. Rijen waar alle 3 NULL zijn = historische
wees-runs uit vóór deze PR (moeten apart hersteld worden).

## Wijzigingen per file

### `api/finance-dunning-pause-by-customer.js`
UPDATE-block bij `active → paused`:
```js
.update({
  status:                   'paused',
  paused_by_manual_user_id: user.id,     // ← nieuw
  paused_manual_reason:     reason,      // ← nieuw (default 'manual_pause_from_inbox')
  paused_at:                nowIso,      // ← nieuw
  updated_at:               nowIso,
})
```
(vervangt de plain `.update({ status: 'paused' })`)

### `api/finance-dunning-run-control.js`
`action='pause'`-branch:
```js
update.status                    = 'paused';
update.paused_by_manual_user_id  = user.id;                       // ← nieuw
update.paused_manual_reason      = body.reason?.slice(0, 300)
                                   || 'manual_pause_via_run_control'; // ← nieuw
update.paused_at                 = nowIso;                        // ← nieuw
```

`action='resume'`-branch — 3 regels toegevoegd aan de bestaande wipe-block:
```js
update.paused_by_conversation_id            = null;    // bestaand
update.paused_conversation_reminder_count   = 0;       // bestaand
update.paused_conversation_last_reminder_at = null;    // bestaand
update.paused_by_arrangement_id             = null;    // bestaand
update.paused_by_manual_user_id             = null;    // ← nieuw
update.paused_manual_reason                 = null;    // ← nieuw
update.paused_at                            = null;    // ← nieuw
```

Reden voor resume-clear: identiek aan de motivatie van #931 voor de
conversation/arrangement-velden: "de reden geldt niet meer". Zonder deze
cleanup blijft `paused_by_manual_user_id` hangen als een run later door
inbox-reply opnieuw gepauzeerd wordt, en zou de UI de verkeerde reden tonen.

### `api/wanbetalers-overzicht-list.js`
SELECT breidt uit met de 3 nieuwe kolommen + de 2 bestaande paused_by_*
(die er nog niet in stonden). Item-response krijgt vijf nieuwe velden:
`paused_by_conversation_id`, `paused_by_arrangement_id`,
`paused_by_manual_user_id`, `paused_manual_reason`, `paused_at`.

## NIET aangeraakt

- ❌ [api/_lib/dunning-engine.js](../api/_lib/dunning-engine.js) — engine
- ❌ [api/_lib/dunning-step-executors.js](../api/_lib/dunning-step-executors.js)
- ❌ [api/_lib/dunning-dry-run.js](../api/_lib/dunning-dry-run.js)
- ❌ [api/_lib/wanbetalers-sandbox.js](../api/_lib/wanbetalers-sandbox.js)
- ❌ [api/_lib/dunning-arrangement-hooks.js](../api/_lib/dunning-arrangement-hooks.js) (pauseRunsForConversation / pauseRunsForArrangement blijven ongewijzigd)
- ❌ [vercel.json](../vercel.json)
- ❌ Verzending / cron / templates

Verzendlogica wordt niet aangeraakt. Pauzeren pauzeert nog steeds
op exact hetzelfde moment; de enige verandering is dat er 3 velden méér
gevuld worden bij die UPDATE.

## UI-badge — apart

De front-end helper `_awnStatusBadge` in [modules/finance.html](../modules/finance.html)
moet nog uitgebreid worden zodat de nieuwe velden een eigen label krijgen
(bijv. "👤 Handmatig gepauzeerd door X op datum" i.p.v. generieke "⏸️ Gepauzeerd").
**Die aanpassing zit BEWUST NIET in deze PR** — de helper is toegevoegd in
PR #1050 (nog OPEN op moment van schrijven) en zit dus niet in main.
Vervolg-PR na merge van #1050 doet die UI-update.

## Vereist na merge

1. **Migratie draaien** in Supabase:
   `docs/sql-migrations/2026-08-02-dunning-run-manual-pause-reden.sql`.
   Additief, IF NOT EXISTS, idempotent — veilig herhaalbaar.
2. **Vercel auto-deploy** (~90s) van de 3 endpoint-changes.
3. **Vanaf dat moment** worden alle NIEUWE handmatige pauzes correct
   gemarkeerd. Bestaande 12 wees-runs blijven pas na apart herstel-script
   (zie eerder overleg — 3 opties per rij).
