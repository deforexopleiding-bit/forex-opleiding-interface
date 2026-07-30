// api/inbox-noreply-context.js
// GET → berekent no-reply-cyclus context voor een conversatie (fase 4 blok 1).
// Puur read-only. Voor de banner in de thread-header die zegt:
//   "r1 verstuurd op X, r2 volgt op Y, hervat op Z"
//
// Query:  ?conversation_id=<uuid>
//
// Response 200:
//   {
//     is_paused: bool,                      // dunning run status='paused' + paused_by_conversation_id=X
//     paused_since: iso|null,
//     reminder_count: int,                  // 0 / 1 / 2
//     last_reminder_at: iso|null,
//     next_reminder_at: iso|null,           // berekend uit config + last_reminder_at
//     next_reminder_kind: 'r1'|'r2'|null,
//     resume_at: iso|null,                  // r2_sent + resume_hours
//     config: { r1_hours, r2_hours, resume_hours },
//     conversation: { id, customer_id }
//   }
//
//   Als de conv niet gekoppeld is / geen paused-run: {is_paused: false, ...} met
//   nulls. Fail-soft (nooit 500 uit config-fout).
//
// Permission: finance.dunning.view (identiek aan finance-dunning-paused-list).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Default no-reply-config (uit cron-dunning-conversation-reminders.js:132-136).
// Endpoint leest bij voorkeur joost_config.autonomy_config.no_reply, valt terug
// op deze defaults wanneer keys ontbreken.
const DEFAULTS = { reminder_1_hours: 20, reminder_2_hours: 24, resume_after_hours: 24 };

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
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const q = req.query || {};
  const convId = q.conversation_id ? String(q.conversation_id).trim() : '';
  if (!convId || !UUID_RE.test(convId)) {
    return res.status(400).json({ error: 'conversation_id (uuid) vereist' });
  }

  try {
    // 1) Conv-details (customer_id).
    const { data: conv } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, status')
      .eq('id', convId)
      .maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // 2) Actieve paused run met paused_by_conversation_id = deze conv.
    const { data: run } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, status, updated_at, paused_by_conversation_id, paused_conversation_reminder_count, paused_conversation_last_reminder_at')
      .eq('status', 'paused')
      .eq('paused_by_conversation_id', convId)
      .maybeSingle();

    // 3) Config laden.
    const { data: cfg } = await supabaseAdmin
      .from('joost_config')
      .select('autonomy_config')
      .eq('module', 'finance')
      .maybeSingle();
    const noReply = cfg?.autonomy_config?.no_reply || {};
    const r1h = Number(noReply.reminder_1_hours ?? DEFAULTS.reminder_1_hours);
    const r2h = Number(noReply.reminder_2_hours ?? DEFAULTS.reminder_2_hours);
    const rh  = Number(noReply.resume_after_hours ?? DEFAULTS.resume_after_hours);

    // Basis-response.
    const base = {
      is_paused: false,
      paused_since: null,
      reminder_count: 0,
      last_reminder_at: null,
      next_reminder_at: null,
      next_reminder_kind: null,
      resume_at: null,
      config: { r1_hours: r1h, r2_hours: r2h, resume_hours: rh },
      conversation: { id: conv.id, customer_id: conv.customer_id },
    };
    if (!run) return res.status(200).json(base);

    const remCount = Number(run.paused_conversation_reminder_count || 0);
    const lastRemAt = run.paused_conversation_last_reminder_at || null;
    const pausedSince = run.updated_at || null;

    // Bereken next_reminder_at + kind.
    //   remCount=0 → next=r1 op pausedSince + r1h
    //   remCount=1 → next=r2 op lastRemAt + r2h
    //   remCount=2 → next=null (geen 3de reminder; hervat na r2 + resume_hours)
    let nextAt = null, nextKind = null;
    if (remCount === 0 && pausedSince) {
      nextAt = new Date(new Date(pausedSince).getTime() + r1h * 3600_000).toISOString();
      nextKind = 'r1';
    } else if (remCount === 1 && lastRemAt) {
      nextAt = new Date(new Date(lastRemAt).getTime() + r2h * 3600_000).toISOString();
      nextKind = 'r2';
    }
    // resume_at: alleen zinvol wanneer r2 al is verstuurd.
    let resumeAt = null;
    if (remCount === 2 && lastRemAt) {
      resumeAt = new Date(new Date(lastRemAt).getTime() + rh * 3600_000).toISOString();
    }

    return res.status(200).json({
      ...base,
      is_paused: true,
      paused_since: pausedSince,
      reminder_count: remCount,
      last_reminder_at: lastRemAt,
      next_reminder_at: nextAt,
      next_reminder_kind: nextKind,
      resume_at: resumeAt,
    });
  } catch (e) {
    console.error('[inbox-noreply-context]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
