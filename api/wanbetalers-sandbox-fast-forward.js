// api/wanbetalers-sandbox-fast-forward.js
// POST { days } → backdate ALLE relevante tijdlijn-velden voor de is_test-
// customer, zodat engine/bulk/reminder-condities meteen triggeren zonder
// wachten. Super_admin only.
//
// SCOPE-GARANTIE: alle updates zijn gescoped op customer_id=sandbox-klant
// (die per definitie is_test=true). Whatsapp_conversations en payment_
// arrangements worden ook via customer_id gefilterd. Runs van echte klanten
// worden NOOIT geraakt: er is geen enkele UPDATE zonder eq('customer_id',
// customer.id) of eq id-uit-een-scoped-lookup.
//
// Verschoven velden (zie PR-body voor tabel met argumentatie per veld):
//   invoices                     due_date, issue_date
//   dunning_pipeline_customers   stage_changed_at, last_activity_at
//   dunning_log                  (cooldown-log rows worden GEWIST voor deze klant)
//   dunning_workflow_runs        next_action_at, started_at, completed_at,
//                                paused_conversation_last_reminder_at
//   whatsapp_conversations       last_inbound_at, last_message_at
//   dunning_call_log             attempted_at, callback_at
//   pending_actions              scheduled_for (voor callback-taken)
//   payment_arrangements         details.parts[].due_date, details.ends_on,
//                                details.pause_until (allemaal jsonb-nested)
//
// NIET verschoven (bewust):
//   updated_at             — last-touch marker; verschuiven zou triggers
//                            en last-write-wins-guards breken.
//   created_at             — bestaans-tijdstip is nooit relevant voor
//                            fast-forward-scenario.
//   joost_conversation_state.messages_sent_today_date — dag-teller met
//                            eigen ISO-datum; niet nodig voor de standaard
//                            aanmaningsflow-test (cap-taak-test dekt 'em al
//                            via total-count, niet tijd).

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const days = Math.max(1, Math.min(365, Number(body.days) || 7));

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });

    // 1) Backdate factuur-vervaldatums met N dagen extra (openstaand →
    //    ouder worden). We doen SELECT + per-rij UPDATE want PostgREST
    //    ondersteunt geen "SET col = col - interval" expressie.
    const { data: invs } = await supabaseAdmin
      .from('invoices').select('id, due_date, issue_date')
      .eq('customer_id', customer.id).eq('is_test', true);
    let invUpdated = 0;
    for (const inv of invs || []) {
      const patch = {};
      if (inv.due_date)   patch.due_date   = _shiftIso(inv.due_date, -days);
      if (inv.issue_date) patch.issue_date = _shiftIso(inv.issue_date, -days);
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabaseAdmin.from('invoices').update(patch).eq('id', inv.id);
      if (!error) invUpdated++;
    }

    // 2) Pipeline: backdate stage_changed_at + last_activity_at.
    const shiftMs = days * 24 * 3600 * 1000;
    const { data: pipe } = await supabaseAdmin
      .from('dunning_pipeline_customers').select('id, stage_changed_at, last_activity_at')
      .eq('customer_id', customer.id).maybeSingle();
    if (pipe) {
      const patch = {};
      if (pipe.stage_changed_at) patch.stage_changed_at = new Date(new Date(pipe.stage_changed_at).getTime() - shiftMs).toISOString();
      if (pipe.last_activity_at) patch.last_activity_at = new Date(new Date(pipe.last_activity_at).getTime() - shiftMs).toISOString();
      if (Object.keys(patch).length > 0) {
        await supabaseAdmin.from('dunning_pipeline_customers').update(patch).eq('id', pipe.id);
      }
    }

    // 3) Cooldown-reset: verwijder recente 'bulk_reminder_sent'-logs voor
    //    deze klant zodat de engine niet meer denkt dat 'ie recent is
    //    aangemaand (cooldown-check kijkt naar dunning_log.payload.customer_id).
    try {
      await supabaseAdmin.from('dunning_log').delete()
        .eq('event_type', 'bulk_reminder_sent')
        .filter('payload->>customer_id', 'eq', customer.id);
    } catch (e) {
      console.warn('[sandbox-fast-forward] cooldown-log wipe soft-fail', e?.message);
    }

    // 4) Dunning workflow runs — KERN-FIX. Zonder deze verschuiving blijft
    //    een wait-stap (next_action_at = seed_moment + N dagen) wachten op
    //    ECHTE tijd, dus de engine advanced niet. Ook started_at + completed_at
    //    + paused_conversation_last_reminder_at meenemen zodat de tijdlijn
    //    consistent blijft (elapsed-time-berekeningen in de UI/cron kloppen).
    //    updated_at BEWUST NIET verschoven — dat is de last-touch marker.
    const { data: runs } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, next_action_at, started_at, completed_at, paused_conversation_last_reminder_at')
      .eq('customer_id', customer.id);
    let runsUpdated = 0;
    for (const run of runs || []) {
      const patch = {};
      if (run.next_action_at)                        patch.next_action_at = new Date(new Date(run.next_action_at).getTime() - shiftMs).toISOString();
      if (run.started_at)                            patch.started_at     = new Date(new Date(run.started_at).getTime() - shiftMs).toISOString();
      if (run.completed_at)                          patch.completed_at   = new Date(new Date(run.completed_at).getTime() - shiftMs).toISOString();
      if (run.paused_conversation_last_reminder_at)  patch.paused_conversation_last_reminder_at = new Date(new Date(run.paused_conversation_last_reminder_at).getTime() - shiftMs).toISOString();
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabaseAdmin.from('dunning_workflow_runs').update(patch).eq('id', run.id);
      if (!error) runsUpdated++;
    }

    // 5) WhatsApp-conversations — last_inbound_at bepaalt het 24u-venster
    //    én de reminder-cirkel-timing van Joost fase 2 (cron-dunning-conversation-
    //    reminders leest last_inbound_at). last_message_at meenemen voor
    //    UI-consistentie (Inbox toont "gisteren" vs "vandaag" correct).
    const { data: convs } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, last_inbound_at, last_message_at')
      .eq('customer_id', customer.id);
    let convsUpdated = 0;
    for (const conv of convs || []) {
      const patch = {};
      if (conv.last_inbound_at) patch.last_inbound_at = new Date(new Date(conv.last_inbound_at).getTime() - shiftMs).toISOString();
      if (conv.last_message_at) patch.last_message_at = new Date(new Date(conv.last_message_at).getTime() - shiftMs).toISOString();
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabaseAdmin.from('whatsapp_conversations').update(patch).eq('id', conv.id);
      if (!error) convsUpdated++;
    }

    // 6) Dunning call log — attempted_at zodat de tracker "pogingen op tijdlijn"
    //    correct rendert; callback_at zodat een terugbelafspraak op fast-
    //    forward-datum valt en de bijbehorende pending_action zichtbaar wordt.
    const { data: calls } = await supabaseAdmin
      .from('dunning_call_log')
      .select('id, attempted_at, callback_at')
      .eq('customer_id', customer.id);
    let callsUpdated = 0;
    for (const c of calls || []) {
      const patch = {};
      if (c.attempted_at) patch.attempted_at = new Date(new Date(c.attempted_at).getTime() - shiftMs).toISOString();
      if (c.callback_at)  patch.callback_at  = new Date(new Date(c.callback_at).getTime()  - shiftMs).toISOString();
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabaseAdmin.from('dunning_call_log').update(patch).eq('id', c.id);
      if (!error) callsUpdated++;
    }

    // 7) Pending actions — scheduled_for verschuiven zodat een terugbelafspraak
    //    of andere geplande taak in Acties zichtbaar wordt na fast-forward.
    //    De defer-filter in pending-actions-list/tasks-list gebruikt scheduled_for
    //    <= now(), dus zonder verschuiving blijft de taak verborgen.
    const { data: acts } = await supabaseAdmin
      .from('pending_actions')
      .select('id, scheduled_for')
      .eq('customer_id', customer.id)
      .not('scheduled_for', 'is', null);
    let actsUpdated = 0;
    for (const a of acts || []) {
      const patch = { scheduled_for: new Date(new Date(a.scheduled_for).getTime() - shiftMs).toISOString() };
      const { error } = await supabaseAdmin.from('pending_actions').update(patch).eq('id', a.id);
      if (!error) actsUpdated++;
    }

    // 8) Payment arrangements — jsonb-nested velden voor breach-check.
    //    details.parts[].due_date (SPLITSING), details.ends_on (UITSTEL),
    //    details.pause_until (ABONNEMENT_PAUZE). Elk per arrangement inline
    //    muteren en full-details terugschrijven (jsonb_set-per-path zou
    //    N round-trips per veld kosten; details-mutatie in JS is korter).
    const { data: arrs } = await supabaseAdmin
      .from('payment_arrangements')
      .select('id, details')
      .eq('customer_id', customer.id);
    let arrsUpdated = 0;
    for (const arr of arrs || []) {
      const details = (arr.details && typeof arr.details === 'object') ? { ...arr.details } : null;
      if (!details) continue;
      let touched = false;
      if (Array.isArray(details.parts)) {
        details.parts = details.parts.map((p) => {
          if (p && typeof p === 'object' && typeof p.due_date === 'string' && p.due_date) {
            touched = true;
            return { ...p, due_date: _shiftIso(p.due_date, -days) };
          }
          return p;
        });
      }
      if (typeof details.ends_on === 'string' && details.ends_on) {
        details.ends_on = _shiftIso(details.ends_on, -days);
        touched = true;
      }
      if (typeof details.pause_until === 'string' && details.pause_until) {
        details.pause_until = _shiftIso(details.pause_until, -days);
        touched = true;
      }
      if (!touched) continue;
      const { error } = await supabaseAdmin.from('payment_arrangements').update({ details }).eq('id', arr.id);
      if (!error) arrsUpdated++;
    }

    return res.status(200).json({
      ok: true,
      days,
      invoices_updated:     invUpdated,
      runs_updated:         runsUpdated,
      convs_updated:        convsUpdated,
      call_logs_updated:    callsUpdated,
      pending_actions_updated: actsUpdated,
      arrangements_updated: arrsUpdated,
    });
  } catch (e) {
    console.error('[sandbox-fast-forward]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

function _shiftIso(dateStr, deltaDays) {
  try {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  } catch (_) { return dateStr; }
}
