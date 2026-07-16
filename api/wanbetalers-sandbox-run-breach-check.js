// api/wanbetalers-sandbox-run-breach-check.js
// POST → draait dezelfde breach-check-evaluator als cron-arrangements-breach-
// check.js, maar GESCOPED op is_test=true (customer = sandbox-klant).
//
// SCOPE-GARANTIE (defense-in-depth, drie lagen):
//   1) Customer lookup via getSandboxCustomer() -> per definitie is_test=true.
//   2) SELECT-filter: .eq('customer_id', customer.id) -> alleen arrangements
//      van de sandbox-klant komen binnen.
//   3) Per-arrangement guard: als arr.customer_id !== customer.id -> abort
//      met SANDBOX_GUARD_FAILED (spiegelt de assertie in run-engine.js
//      "elke aangeraakte klant moet is_test=true zijn; anders abort direct").
//   4) UPDATE-filter: .eq('customer_id', customer.id) toegevoegd aan elke
//      status-flip zodat een concurrent-mutatie tussen SELECT en UPDATE
//      niet per ongeluk een echte klant kan raken.
//
// Zelfde patroon als wanbetalers-sandbox-run-engine.js. Super_admin only,
// geen CRON_SECRET.
//
// Response:
//   {
//     ok: true,
//     dry_run: boolean,
//     evaluated: N,
//     nagekomen: N,
//     verbroken: N,
//     arrangement_ids: [...],   // welke arrangements zijn geraakt (audit)
//     errors: []
//   }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';
import { isDryRunEnabled } from './_lib/dunning-dry-run.js';
import { evaluateArrangement } from './cron-arrangements-breach-check.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });
    // Extra vangnet: getSandboxCustomer belooft is_test=true, maar we assertem
    // hier expliciet zodat een toekomstige bug in die helper niet stilzwijgend
    // door kan zetten.
    if (customer.is_test !== true) {
      return res.status(500).json({ error: 'SANDBOX_GUARD_FAILED: sandbox-klant heeft is_test !== true.' });
    }

    const dry = await isDryRunEnabled();
    const summary = {
      ok: true,
      dry_run: dry,
      evaluated: 0,
      nagekomen: 0,
      verbroken: 0,
      arrangement_ids: [],
      errors: [],
    };

    // Alleen ACTIEF arrangements van de sandbox-klant. Zelfde IN-clause als
    // de cron zodat we case-varianten dekken.
    const { data: arrangements, error: arrErr } = await supabaseAdmin
      .from('payment_arrangements')
      .select('id, customer_id, type, status, invoice_ids, details, created_at, updated_at')
      .eq('customer_id', customer.id)
      .in('status', ['ACTIEF', 'actief']);
    if (arrErr) throw new Error('arrangements-select: ' + arrErr.message);

    for (const arr of arrangements || []) {
      // Defense-in-depth: elke aangeraakte klant MOET is_test-sandbox zijn.
      // Als de SELECT-filter faalt (bug in refactor, RLS-shift, etc), stopt
      // deze guard de wijziging voordat er data van een echte klant kapot gaat.
      if (arr.customer_id !== customer.id) {
        summary.errors.push({
          arrangement_id: arr.id,
          error: 'SANDBOX_GUARD_FAILED: arrangement hoort niet bij sandbox-klant',
        });
        continue;
      }
      summary.evaluated++;

      try {
        const decision = await evaluateArrangement(arr);
        if (!decision || !decision.newStatus) continue;

        const { newStatus, reason } = decision;
        const nowIso = new Date().toISOString();

        // UPDATE met dubbele scope-check: op arr.id EN customer_id. Als de
        // rij tussen SELECT en UPDATE zou zijn "verhuisd" naar een andere
        // klant (theoretisch onmogelijk maar defense-in-depth), matcht de
        // WHERE niet en gebeurt er niets.
        const { error: updErr } = await supabaseAdmin
          .from('payment_arrangements')
          .update({ status: newStatus, updated_at: nowIso })
          .eq('id', arr.id)
          .eq('customer_id', customer.id)
          .in('status', ['ACTIEF', 'actief']);
        if (updErr) throw new Error('update: ' + updErr.message);

        summary.arrangement_ids.push({ id: arr.id, type: arr.type, new_status: newStatus, reason });
        if (newStatus === 'NAGEKOMEN') summary.nagekomen++;
        if (newStatus === 'VERBROKEN') summary.verbroken++;

        // Zelfde Fase 2b hook als de cron: NAGEKOMEN -> completeer paused runs.
        if (newStatus === 'NAGEKOMEN') {
          try {
            const { completeRunsFromArrangement } = await import('./_lib/dunning-arrangement-hooks.js');
            await completeRunsFromArrangement(arr.id);
          } catch (e) {
            console.warn('[sandbox-breach-check hook complete]', e?.message || e);
          }
        }

        // Audit-log per state-change met sandbox-marker zodat je in de logs
        // ziet dat dit een sandbox-run was.
        try {
          await supabaseAdmin.from('audit_log').insert({
            user_id:     admin.user.id,
            action:      'finance.arrangement.breach_check_state_change',
            entity_type: 'payment_arrangement',
            entity_id:   arr.id,
            before_json: { status: arr.status, dry_run: dry, sandbox: true },
            after_json:  {
              arrangement_id: arr.id,
              type:           arr.type,
              old_status:     arr.status,
              new_status:     newStatus,
              reason,
              dry_run:        dry,
              sandbox:        true,
              triggered_by:   'sandbox-breach-check',
            },
            reason_text: `[SANDBOX] ${reason}`,
          });
        } catch (e) {
          console.error('[sandbox-breach-check audit]', e.message);
        }
      } catch (e) {
        summary.errors.push({
          arrangement_id: arr.id,
          type: arr.type,
          error: e?.message || String(e),
        });
        console.error('[sandbox-breach-check] eval failed', arr.id, e?.message);
      }
    }

    return res.status(200).json(summary);
  } catch (e) {
    console.error('[sandbox-breach-check]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
