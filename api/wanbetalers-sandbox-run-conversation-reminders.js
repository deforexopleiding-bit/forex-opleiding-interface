// api/wanbetalers-sandbox-run-conversation-reminders.js
//
// POST → draait dezelfde no-reply reminder-cirkel als
// cron-dunning-conversation-reminders.js (Joost fase 2 / #766), maar
// GESCOPED op is_test=true (customer = sandbox-klant).
//
// SCOPE-GARANTIE (defense-in-depth, vijf lagen — spiegelt #774):
//   1) Customer lookup via getSandboxCustomer() → per definitie is_test=true.
//   2) Assertie op de gevonden klant: customer.is_test !== true → 500 met
//      SANDBOX_GUARD_FAILED (vangnet als een toekomstige bug in de helper
//      per ongeluk een non-test-klant returnt).
//   3) SELECT-filter op runs: .eq('customer_id', customer.id) → alleen
//      runs van de sandbox-klant komen binnen.
//   4) Per-run guard: run.customer_id !== customer.id → skip met reden
//      SANDBOX_GUARD_FAILED (defense als de SELECT-filter door een refactor
//      of RLS-shift plots iets anders zou doen).
//   5) De cron-processor (processReminderRun) doet zelf óók nog een
//      sandbox-guard op de recipient (assertRecipientMatchesSandbox voor
//      is_test-klanten). Zo kan een send NOOIT naar een echte klant gaan
//      ook al zou een bug de SELECT overslaan.
//
// Office-hours: RESPECTEREN (spiegel van live-gedrag). Buiten kantooruren
// vult processReminderRun `summary.skipped` met reden 'OFFICE_HOURS_CLOSED';
// de frontend toont de skip-reden in de toast zodat Jeffrey ziet waarom er
// niets gebeurde in plaats van te denken dat de knop stuk is. Alternatief
// (overslaan in sandbox) is bewust NIET gekozen — dan zou de sandbox een
// scenario testen dat in productie niet bestaat, en zou een echte
// office-hours-bug pas op live gebruikers opduiken.
//
// Caps + cooldown + dry-run: identiek aan live. In dry-run wordt
// joost_conversation_state BEWUST niet bijgewerkt (zie cron r459-461).
// Fast-forward (#770) verschuift last_inbound_at + paused_conversation_
// last_reminder_at, dus 3 opeenvolgende klikken (r1 → r2 → rz) zijn testbaar.
//
// Super_admin only, geen CRON_SECRET.
//
// Response: {
//   ok, dry_run, evaluated, reminder_1_sent, reminder_2_sent, resumed,
//   skipped:[{run_id, reason}], errors:[…]
// }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';
import {
  loadConversationReminderConfig,
  loadConversationReminderDeps,
  processReminderRun,
} from './cron-dunning-conversation-reminders.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const summary = {
    ok:               true,
    dry_run:          false,
    evaluated:        0,
    reminder_1_sent:  0,
    reminder_2_sent:  0,
    resumed:          0,
    skipped:          [],
    errors:           [],
    // Intern (later gemapt naar de canonical velden):
    processed_count:  0,
    r1_sent:          0,
    r2_sent:          0,
  };

  try {
    // 1) Sandbox-klant ophalen (laag 1 + 2 van de guard).
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });
    if (customer.is_test !== true) {
      return res.status(500).json({ error: 'SANDBOX_GUARD_FAILED: sandbox-klant heeft is_test !== true.' });
    }

    // 2) Config + deps laden (dezelfde helpers als de cron).
    const cfgRes = await loadConversationReminderConfig();
    if (!cfgRes.ok) {
      return res.status(cfgRes.reason === 'CONFIG_LOOKUP_FAIL' ? 500 : 200).json({
        ...summary,
        skipped_reason: cfgRes.reason,
        error:          cfgRes.error || undefined,
      });
    }
    const { autonomyCfg, noReplyCfg } = cfgRes;
    const deps      = await loadConversationReminderDeps();
    const dryRunOn  = deps.isDryRunEnabled ? await deps.isDryRunEnabled() : true; // fail-safe: dry-run AAN
    summary.dry_run = dryRunOn;

    // 3) SELECT runs SCOPED op de sandbox-klant (laag 3). We halen dezelfde
    //    velden op als de cron zodat processReminderRun 1-op-1 werkt.
    const { data: runs, error: runsErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, customer_id, paused_by_conversation_id, paused_conversation_reminder_count, paused_conversation_last_reminder_at, updated_at')
      .eq('customer_id', customer.id)
      .eq('status', 'paused')
      .not('paused_by_conversation_id', 'is', null)
      .order('updated_at', { ascending: true });
    if (runsErr) throw new Error('runs query: ' + runsErr.message);
    const runList = Array.isArray(runs) ? runs : [];
    if (runList.length === 0) {
      // Niets te doen — netjes teruggeven.
      summary.evaluated = 0;
      return res.status(200).json(publicSummary(summary));
    }

    // 4) Per-run verwerken, met per-run guard (laag 4).
    const nowMs = Date.now();
    for (const run of runList) {
      // Defense-in-depth: elke geraakte run MOET van de sandbox-klant zijn.
      if (run.customer_id !== customer.id) {
        summary.errors.push({
          run_id: run.id,
          error:  'SANDBOX_GUARD_FAILED: run hoort niet bij sandbox-klant',
        });
        continue;
      }
      summary.evaluated++;
      await processReminderRun({
        run,
        autonomyCfg,
        noReplyCfg,
        deps,
        dryRunOn,
        nowMs,
        summary,
        logPrefix: 'sandbox-conv-reminders',
      });
    }

    // Audit-log (spiegel van cron, met sandbox-marker).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: admin.user.id,
        action:  'joost.conv_reminder_sandbox_run',
        entity_type: null,
        entity_id:   null,
        after_json: {
          customer_id:     customer.id,
          evaluated:       summary.evaluated,
          r1_sent:         summary.r1_sent,
          r2_sent:         summary.r2_sent,
          resumed:         summary.resumed,
          skipped_count:   summary.skipped.length,
          errors_count:    summary.errors.length,
          first_skips:     summary.skipped.slice(0, 5),
          first_errors:    summary.errors.slice(0, 3),
          dry_run:         dryRunOn,
          sandbox:         true,
        },
        reason_text: `[SANDBOX] conv_reminders: r1=${summary.r1_sent} r2=${summary.r2_sent} resumed=${summary.resumed} skipped=${summary.skipped.length}`,
        ip_address: null,
      });
    } catch (_) { /* fail-soft */ }

    return res.status(200).json(publicSummary(summary));
  } catch (e) {
    console.error('[sandbox-conv-reminders]', e?.message || e);
    return res.status(500).json({ ...publicSummary(summary), error: e?.message || 'Interne fout' });
  }
}

// Mapt de interne cron-summary (r1_sent/r2_sent) naar canonieke velden
// (reminder_1_sent/reminder_2_sent) die de UI toont — zonder de
// processReminderRun signature te veranderen (die schrijft naar r1_sent/r2_sent
// zodat de cron zelf ongewijzigd blijft).
function publicSummary(s) {
  return {
    ok:              s.ok,
    dry_run:         s.dry_run,
    evaluated:       s.evaluated,
    reminder_1_sent: s.r1_sent,
    reminder_2_sent: s.r2_sent,
    resumed:         s.resumed,
    skipped:         s.skipped,
    errors:          s.errors,
  };
}
