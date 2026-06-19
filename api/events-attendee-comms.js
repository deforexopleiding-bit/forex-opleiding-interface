// api/events-attendee-comms.js
// GET -> communicatie-historie + geplande communicatie voor één attendee.
//
// Permission: events.attendee.view.
//
// Query-param:
//   attendee_id  uuid (verplicht)
//
// Response:
//   {
//     items: [
//       { channel: 'email'|'whatsapp',
//         status : 'verzonden'|'gepland',
//         at     : <iso timestamp>,
//         label  : <step_type / automation-naam / template> }, ...
//     ],
//     note: <string|null>     // resterende voetnoot, of null als alles gedekt is
//   }
// Gesorteerd: verzonden eerst (recent boven), gepland onderaan op datum.
//
// READER-SWITCH (PR-Y):
//   Bron-of-truth voor VERZONDEN is sinds FIX 4 (migratie
//   2026-06-16-event-attendee-comms-log.sql) de tabel
//   event_attendee_comms_log. Daar landen nu ook handmatige invite-mails
//   (api/_lib/events-invite.js) — de oude blinde vlek.
//
//   LET OP: handmatige inbox-WhatsApp (compose-panel in events-inbox /
//   agents) schrijft NIET naar event_attendee_comms_log; alleen events-
//   invite.js + automation-engine doen dat. Voor die kanaal-mix combineren
//   we twee strategieën per bron:
//
//   1. Tijd-split via cutover voor bronnen ZONDER stabiele dedup-key:
//      cutover = MIN(created_at) van event_attendee_comms_log (globaal).
//      event_automation_run_log (5a) draait op < cutover; vanaf cutover
//      dekt de comms-log (4) diezelfde stappen.
//
//   2. wamid-dedup voor de WhatsApp-tweesporen:
//      whatsapp_messages (handmatig, sent_by_user_id IS NOT NULL) leest
//      ALL-TIME. Invite/automation-WA staat ook in whatsapp_messages MET
//      meta_wamid + parallel in de comms-log met dezelfde wamid. We
//      skippen WA-msg-rijen waarvan meta_wamid voorkomt in de Set wamids
//      die uit de comms-log gehaald zijn → handmatige inbox-WA (lege
//      wamid of niet in Set) blijft over.
//
//   Status mapping comms-log → tijdlijn: 'sent' + 'failed' + 'queued' →
//   'verzonden'; 'skipped' → niet tonen.
//
//   GEPLAND blijft ongewijzigd uit event_automation_runs.next_run_at.
//   Lege event_attendee_comms_log (pre-migration / rollback): cutover =
//   now → oude 3 bronnen serveren alles; geen wamid in de Set → WA-dedup
//   is no-op. Byte-identiek aan pre-PR-Y voor die scenario's.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// step_type → channel mapping. Onbekend type wordt overgeslagen
// (bv. 'wait' / 'condition' zijn geen communicatie-stappen).
const STEP_TYPE_TO_CHANNEL = {
  send_email   : 'email',
  send_whatsapp: 'whatsapp',
};

// comms-log status → tijdlijn-status. 'skipped' valt weg (geen verzending).
// 'sent'   → 'verzonden' (groene badge in UI).
// 'failed' → 'mislukt'   (rode badge + reason-tooltip met Meta-error).
// 'queued' → 'wacht'     (amber badge — Meta heeft 'm aangenomen maar nog niet sent).
function commsLogStatusToTimeline(s) {
  if (s === 'sent')   return 'verzonden';
  if (s === 'failed') return 'mislukt';
  if (s === 'queued') return 'wacht';
  return null; // skipped → niet tonen
}

function tsMs(v) {
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.view)' });
  }

  const attendeeId = req.query?.attendee_id ? String(req.query.attendee_id).trim() : '';
  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  }

  try {
    // 1) Attendee context (event_id + customer_id voor de pre-cutover WhatsApp-join).
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, customer_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee-lookup: ' + attErr.message);
    if (!attendee) return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    // 2) Cutover bepalen — globaal, één query. Failures → cutover=now
    //    zodat de oude bronnen alles serveren (geen verlies bij DB-issue).
    let cutoverMs = Date.now();
    try {
      const { data: minRow, error: minErr } = await supabaseAdmin
        .from('event_attendee_comms_log')
        .select('created_at')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (minErr) {
        console.error('[events-attendee-comms cutover]', minErr.message);
      } else if (minRow && minRow.created_at) {
        const ms = tsMs(minRow.created_at);
        if (ms > 0) cutoverMs = ms;
      }
    } catch (e) {
      console.error('[events-attendee-comms cutover-exception]', e?.message || e);
    }

    const items = [];

    // 3) Automation-runs voor deze attendee — basis voor GEPLAND + voor het
    //    pre-cutover VERZONDEN-pad (automation-runs koppeling).
    const { data: runs, error: runsErr } = await supabaseAdmin
      .from('event_automation_runs')
      .select('id, automation_id, status, current_step_index, next_run_at, steps_snapshot')
      .eq('attendee_id', attendeeId);
    if (runsErr) {
      console.error('[events-attendee-comms runs]', runsErr.message);
    }

    // 3a) Automation-namen ophalen (best-effort; label bevat 'm in de UI).
    const automationIds = Array.from(new Set((runs || []).map((r) => r.automation_id).filter(Boolean)));
    const autoNameById = new Map();
    if (automationIds.length > 0) {
      try {
        const { data: autos } = await supabaseAdmin
          .from('event_automations')
          .select('id, name')
          .in('id', automationIds);
        for (const a of autos || []) autoNameById.set(a.id, a.name);
      } catch (e) {
        console.error('[events-attendee-comms automations]', e?.message || e);
      }
    }

    // 3b) GEPLAND: actieve runs met next_run_at + huidige step-type.
    //     Ongewijzigd t.o.v. pre-PR-Y.
    for (const run of runs || []) {
      if (run.status !== 'active' || !run.next_run_at) continue;
      const steps = Array.isArray(run.steps_snapshot) ? run.steps_snapshot : [];
      const step  = steps[run.current_step_index] || null;
      const channel = step && STEP_TYPE_TO_CHANNEL[step.type] || null;
      if (!channel) continue; // alleen mail/WhatsApp tonen
      items.push({
        channel,
        status: 'gepland',
        at    : run.next_run_at,
        label : autoNameById.get(run.automation_id) || step.type || 'Automation',
      });
    }

    // 4) VERZONDEN vanaf cutover (>=) — uit event_attendee_comms_log.
    //    Dit dekt vanaf go-live: automation-runs (engine schrijft), invite-
    //    mails handmatig (events-invite.js schrijft), en alles wat later
    //    aan logComms() wordt gekoppeld.
    //
    //    NB: handmatige inbox-WhatsApp (compose-panel in events-inbox / agents)
    //    schrijft NIET naar event_attendee_comms_log. Die rijen halen we
    //    onder in 5b op uit whatsapp_messages — over ALLE tijden, niet
    //    alleen pre-cutover. Om dubbeltellingen te voorkomen met automation-
    //    /invite-WA (die wél in de log zitten met meta_wamid), bouwen we
    //    hier een Set van wamids uit de log; 5b skipt rijen waarvan de
    //    wamid daarin voorkomt.
    const wamidsInLog = new Set();
    try {
      const { data: logRows, error: logErr } = await supabaseAdmin
        .from('event_attendee_comms_log')
        .select('channel, status, sent_at, created_at, template_name, subject, automation_run_id, step_index, meta_wamid, failure_reason')
        .eq('attendee_id', attendeeId)
        .eq('direction', 'outbound')
        .gte('created_at', new Date(cutoverMs).toISOString());
      if (logErr) {
        console.error('[events-attendee-comms log]', logErr.message);
      }
      for (const r of logRows || []) {
        if (r.meta_wamid) wamidsInLog.add(r.meta_wamid);
        const timelineStatus = commsLogStatusToTimeline(r.status);
        if (!timelineStatus) continue; // 'skipped' → weglaten
        const channel = r.channel === 'email' || r.channel === 'whatsapp' ? r.channel : null;
        if (!channel) continue;
        // Label-prioriteit: subject (e-mail) → template_name → automation-naam
        // (via run-koppeling) → generieke channel-tekst.
        let label = null;
        if (r.subject)              label = r.subject;
        else if (r.template_name)   label = `Template: ${r.template_name}`;
        else if (r.automation_run_id) {
          // Run kan op een andere attendee-run zitten (theoretisch), maar
          // automation_run_id koppelt 1-op-1 met deze attendee in praktijk.
          const run = (runs || []).find((rn) => rn.id === r.automation_run_id);
          label = (run && autoNameById.get(run.automation_id)) || 'Automation';
        } else {
          label = channel === 'email' ? 'E-mail' : 'WhatsApp';
        }
        items.push({
          channel,
          status: timelineStatus,
          at    : r.sent_at || r.created_at,
          label,
          reason: r.failure_reason || null,
        });
      }
    } catch (e) {
      console.error('[events-attendee-comms log-exception]', e?.message || e);
    }

    // 5) PRE-CUTOVER historie (< cutover) — oude bronnen, gefilterd op tijd.
    //    Strikte tijd-split ⇒ geen overlap met stap 4 ⇒ geen dedup nodig.
    const cutoverIso = new Date(cutoverMs).toISOString();

    // 5a) VERZONDEN automation: event_automation_run_log met executed_at < cutover.
    const runIds = (runs || []).map((r) => r.id);
    const runById = new Map((runs || []).map((r) => [r.id, r]));
    if (runIds.length > 0) {
      const { data: logs, error: logErr } = await supabaseAdmin
        .from('event_automation_run_log')
        .select('run_id, step_index, step_type, executed_at, result')
        .in('run_id', runIds)
        .lt('executed_at', cutoverIso);
      if (logErr) {
        console.error('[events-attendee-comms run-log]', logErr.message);
      }
      for (const lg of logs || []) {
        const channel = STEP_TYPE_TO_CHANNEL[lg.step_type];
        if (!channel) continue;
        const run = runById.get(lg.run_id);
        const autoName = run ? autoNameById.get(run.automation_id) : null;
        items.push({
          channel,
          status: 'verzonden',
          at    : lg.executed_at,
          label : autoName || lg.step_type,
        });
      }
    }

    // 5b) Manuele uitgaande WhatsApp via customer-koppeling — ALL-TIME.
    //
    //     Handmatige inbox-WA (compose-panel) schrijft niet naar
    //     event_attendee_comms_log, dus we mogen 'm hier NIET op tijd
    //     afkappen — dat zou post-cutover handmatige WA onzichtbaar maken.
    //
    //     Dedup-veilig via meta_wamid: events-invite.js + automation-engine
    //     loggen hun WA-rij met meta_wamid in event_attendee_comms_log (zie 4).
    //     Dezelfde rij staat ook in whatsapp_messages met diezelfde wamid.
    //     We skippen hier rijen waarvan wamid in wamidsInLog zit — die
    //     worden al via de comms-log getoond. Rijen met lege wamid of
    //     wamid niet in de Set zijn handmatige inbox-WA → meenemen.
    //
    //     Filter sent_by_user_id IS NOT NULL: automation-engine schrijft
    //     met sentByUserId=null in whatsapp_messages, dus die rijen
    //     vallen sowieso buiten dit filter (en worden via comms-log /
    //     pre-cutover run_log gedekt).
    if (attendee.customer_id) {
      try {
        const { data: convs, error: convErr } = await supabaseAdmin
          .from('whatsapp_conversations')
          .select('id')
          .eq('customer_id', attendee.customer_id);
        if (convErr) {
          console.error('[events-attendee-comms convs]', convErr.message);
        }
        const convIds = (convs || []).map((c) => c.id);
        if (convIds.length > 0) {
          const { data: msgs, error: msgErr } = await supabaseAdmin
            .from('whatsapp_messages')
            .select('template_name, body, sent_at, created_at, sent_by_user_id, meta_wamid')
            .in('conversation_id', convIds)
            .eq('direction', 'out')
            .not('sent_by_user_id', 'is', null);
          if (msgErr) {
            console.error('[events-attendee-comms wa-msgs]', msgErr.message);
          }
          for (const m of msgs || []) {
            const at = m.sent_at || m.created_at;
            if (!at) continue;
            // Dedup: als deze wamid al via de comms-log getoond wordt,
            // sla 'm hier over (anders dubbel).
            if (m.meta_wamid && wamidsInLog.has(m.meta_wamid)) continue;
            const label = m.template_name
              ? `Template: ${m.template_name}`
              : (m.body ? m.body.slice(0, 60) : 'WhatsApp');
            items.push({
              channel: 'whatsapp',
              status : 'verzonden',
              at,
              label,
            });
          }
        }
      } catch (e) {
        console.error('[events-attendee-comms wa-exception]', e?.message || e);
      }
    }

    // 6) Sorteer: verzonden eerst (recent boven), gepland onderaan op datum.
    items.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'verzonden' ? -1 : 1;
      }
      const ta = tsMs(a.at);
      const tb = tsMs(b.at);
      return a.status === 'verzonden' ? (tb - ta) : (ta - tb);
    });

    // 7) Voetnoot. Vanaf go-live worden handmatige invite-mails wél gelogd
    //    (via api/_lib/events-invite.js). De oude waarschuwing was na FIX 4
    //    achterhaald — we sturen 'm op null zodat de UI 'm verbergt.
    return res.status(200).json({
      items,
      note: null,
    });
  } catch (e) {
    console.error('[events-attendee-comms]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
