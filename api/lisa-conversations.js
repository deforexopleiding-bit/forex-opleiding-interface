// api/lisa-conversations.js
// Lisa conversaties — sandbox + live monitoring.
//
//   GET  ?is_sandbox=true&limit=20      → sandbox-lijst (+ eerste user-bericht als preview)
//   GET  ?action=list_live&...          → LIVE-lijst (is_sandbox=false) + filters/search + laatste bericht
//        filters: status=active|qualified|disqualified|cold|all · q=<zoek> · limit
//   GET  ?id=<uuid>                      → één conversatie + berichten + feedback + qualification
//   POST ?action=intervene&id=<uuid>     → mens neemt over: stuur bericht via GHL (human_override)
//   PATCH ?id=<uuid>                     → status bijwerken (phase/qualified/disqualified/pause/takeover)
//   DELETE ?id=<uuid>                    → verwijder (alleen sandbox)
//
// Auth (BP3 v4, 2026-09-01 — refactor voor Romy Instagram-inbox):
//   Reads (GET)                → lisa.conversation.view
//   POST ?action=intervene     → lisa.conversation.intervene
//   PATCH (takeover)           → lisa.conversation.takeover
//   PATCH (phase/qualified/... ) → lisa.conversation.status_update
//   DELETE (sandbox-only)      → lisa.sandbox.use (ongewijzigd)
// Vervangt de oude hard-verifyAdmin-gate zodat rollen met de fine-grained
// grants (Romy krijgt view+intervene+takeover+status_update) ook binnenkomen.
// Admin/manager hebben via seed dezelfde grants → geen regressie.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendToGhl } from './_lib/lisa-ghl-send.js';

const VALID_PHASES = ['intro', 'doel', 'situatie', 'band', 'call', 'qualified', 'disqualified', 'done', 'cold'];
const ACTIVE_PHASES = ['intro', 'doel', 'situatie', 'band', 'call'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const action = req.query.action || '';

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (!(await requirePermission(req, 'lisa.conversation.view'))) {
      return res.status(403).json({ error: 'Geen rechten (lisa.conversation.view)' });
    }
    // Detail
    if (req.query.id) {
      const { data: conv, error } = await supabaseAdmin.from('lisa_conversations')
        .select('*').eq('id', req.query.id).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!conv) return res.status(404).json({ error: 'Conversatie niet gevonden.' });

      const { data: messages } = await supabaseAdmin.from('lisa_messages')
        // BP3 v5 (2026-09-02) — message_type + attachment_url meesturen zodat
        // de Gesprekken-view media (foto/video/audio/file) kan renderen. Zonder
        // deze twee kolommen zag de frontend alleen de placeholder-tekst.
        .select('id, direction, content, sent_at, ai_generated, human_override, is_system, detected_phase, tokens_used, model_used, ghl_message_id, is_followup, message_type, attachment_url')
        // (conversation row hieronder via select('*') bevat de booking-velden uit migratie 010)
        .eq('conversation_id', conv.id).order('sent_at', { ascending: true });
      const { data: feedback } = await supabaseAdmin.from('lisa_feedback')
        .select('message_id, rating').eq('conversation_id', conv.id);
      const { data: qualification } = await supabaseAdmin.from('lisa_qualification')
        .select('*').eq('conversation_id', conv.id).maybeSingle();

      return res.status(200).json({ conversation: conv, messages: messages || [], feedback: feedback || [], qualification: qualification || null });
    }

    // LIVE-lijst
    if (action === 'list_live') {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      let q = supabaseAdmin.from('lisa_conversations')
        .select('id, contact_name, instagram_handle, ghl_contact_id, phase, qualified, call_booked, human_takeover, followup_paused, source, created_at, last_message_at')
        .eq('is_sandbox', false)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(limit);

      const status = req.query.status || 'all';
      if (status === 'qualified') q = q.eq('qualified', true);
      else if (status === 'disqualified') q = q.eq('phase', 'disqualified');
      else if (status === 'cold') q = q.eq('phase', 'cold');
      else if (status === 'active') q = q.in('phase', ACTIVE_PHASES);

      const search = (req.query.q || '').trim();
      if (search) {
        const s = search.replace(/[%,]/g, ' ');
        q = q.or(`contact_name.ilike.%${s}%,instagram_handle.ilike.%${s}%,ghl_contact_id.ilike.%${s}%`);
      }

      const { data: convs, error } = await q;
      if (error) return res.status(500).json({ error: error.message });

      // Laatste bericht per conversatie (1 extra query, geen N+1).
      const ids = (convs || []).map((c) => c.id);
      const lastMsg = {};
      if (ids.length) {
        const { data: msgs } = await supabaseAdmin.from('lisa_messages')
          .select('conversation_id, content, direction, sent_at')
          .in('conversation_id', ids).order('sent_at', { ascending: false });
        for (const m of msgs || []) {
          if (!lastMsg[m.conversation_id]) lastMsg[m.conversation_id] = { content: m.content, direction: m.direction };
        }
      }
      const list = (convs || []).map((c) => ({
        ...c,
        preview: (lastMsg[c.id]?.content || '').slice(0, 60),
        last_direction: lastMsg[c.id]?.direction || null,
      }));
      return res.status(200).json({ conversations: list });
    }

    // Sandbox-lijst (bestaand gedrag)
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    let q = supabaseAdmin.from('lisa_conversations')
      .select('id, contact_name, phase, qualified, call_booked, is_sandbox, created_at, last_message_at')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (req.query.is_sandbox === 'true') q = q.eq('is_sandbox', true);
    else if (req.query.is_sandbox === 'false') q = q.eq('is_sandbox', false);

    const { data: convs, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const ids = (convs || []).map((c) => c.id);
    const previews = {};
    if (ids.length) {
      const { data: msgs } = await supabaseAdmin.from('lisa_messages')
        .select('conversation_id, content, direction, sent_at')
        .in('conversation_id', ids).eq('direction', 'in').order('sent_at', { ascending: true });
      for (const m of msgs || []) if (!previews[m.conversation_id]) previews[m.conversation_id] = m.content;
    }
    const list = (convs || []).map((c) => ({ ...c, preview: (previews[c.id] || '').slice(0, 60) }));
    return res.status(200).json({ conversations: list });
  }

  // ── POST intervene (mens neemt over) ──────────────────────────────────────────
  if (req.method === 'POST' && action === 'intervene') {
    if (!(await requirePermission(req, 'lisa.conversation.intervene'))) {
      return res.status(403).json({ error: 'Geen rechten (lisa.conversation.intervene)' });
    }
    const id = req.query.id;
    const content = (req.body?.content || '').trim();
    if (!id || !content) return res.status(400).json({ error: 'id + content vereist.' });

    const { data: conv } = await supabaseAdmin.from('lisa_conversations').select('*').eq('id', id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversatie niet gevonden.' });
    if (conv.is_sandbox) return res.status(400).json({ error: 'Interventie alleen voor live-conversaties.' });

    const sendResult = await sendToGhl(conv.ghl_contact_id, content, {
      conversationId: conv.ghl_conversation_id, locationId: conv.ghl_location_id,
    });

    const { data: outMsg, error: msgErr } = await supabaseAdmin.from('lisa_messages').insert({
      conversation_id: conv.id, direction: 'out', content, ai_generated: false, human_override: true,
      ghl_message_id: sendResult.message_id || null,
    }).select('id').single();
    if (msgErr) return res.status(500).json({ error: msgErr.message });

    await supabaseAdmin.from('lisa_conversations')
      .update({ human_takeover: true, assigned_human: user.id }).eq('id', conv.id);

    return res.status(200).json({ ok: true, message_id: outMsg.id, ghl_send_ok: sendResult.ok, ghl_error: sendResult.ok ? undefined : sendResult.error });
  }

  // ── PATCH status ──────────────────────────────────────────────────────────────
  // Split gate: takeover-flip (assigned_human) valt onder lisa.conversation.takeover;
  // alle andere velden (phase/qualified/call_booked/followup_paused/disqualified_reason)
  // vallen onder lisa.conversation.status_update. Wie beide velden in één PATCH stuurt
  // moet beide permissies hebben.
  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id vereist.' });
    const body = req.body || {};
    const updates = {};

    if (body.phase !== undefined) {
      if (!VALID_PHASES.includes(body.phase)) return res.status(400).json({ error: 'Ongeldige fase.' });
      updates.phase = body.phase;
    }
    if (body.qualified !== undefined) {
      updates.qualified = !!body.qualified;
      updates.qualified_at = body.qualified ? new Date().toISOString() : null;
    }
    if (body.call_booked !== undefined) {
      updates.call_booked = !!body.call_booked;
      updates.call_booked_at = body.call_booked ? new Date().toISOString() : null;
    }
    if (body.disqualified_reason !== undefined) updates.disqualified_reason = body.disqualified_reason || null;
    if (body.followup_paused !== undefined) updates.followup_paused = !!body.followup_paused;

    const wantTakeover = body.human_takeover !== undefined;
    if (wantTakeover) {
      updates.human_takeover = !!body.human_takeover;
      if (!body.human_takeover) updates.assigned_human = null;
    }

    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Geen velden om bij te werken.' });

    // Permission-check: takeover-flip vereist .takeover, statusvelden .status_update.
    const wantStatus = ['phase','qualified','call_booked','disqualified_reason','followup_paused']
      .some((k) => body[k] !== undefined);
    if (wantTakeover && !(await requirePermission(req, 'lisa.conversation.takeover'))) {
      return res.status(403).json({ error: 'Geen rechten (lisa.conversation.takeover)' });
    }
    if (wantStatus && !(await requirePermission(req, 'lisa.conversation.status_update'))) {
      return res.status(403).json({ error: 'Geen rechten (lisa.conversation.status_update)' });
    }

    const { data, error } = await supabaseAdmin.from('lisa_conversations').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ conversation: data });
  }

  // ── DELETE (alleen sandbox) ──────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!(await requirePermission(req, 'lisa.sandbox.use'))) {
      return res.status(403).json({ error: 'Geen rechten (lisa.sandbox.use)' });
    }
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id vereist.' });
    const { data: conv } = await supabaseAdmin.from('lisa_conversations').select('id, is_sandbox').eq('id', id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversatie niet gevonden.' });
    if (!conv.is_sandbox) return res.status(403).json({ error: 'Alleen sandbox-conversaties kunnen verwijderd worden.' });
    const { error } = await supabaseAdmin.from('lisa_conversations').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
