// api/lisa-conversations.js
// Lisa conversaties — lijst, detail en verwijderen (sandbox).
//
//   GET  ?is_sandbox=true&limit=20  → lijst conversaties (+ eerste user-bericht als preview)
//   GET  ?id=<uuid>                 → één conversatie + alle berichten + feedback-ratings
//   DELETE ?id=<uuid>               → verwijder conversatie (alleen sandbox) — cascade berichten/feedback
//
// Auth: verifyAdmin + requirePermissionFailOpen('lisa.sandbox.use'). Schrijven via supabaseAdmin.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  if (!(await requirePermissionFailOpen(req, 'lisa.sandbox.use'))) {
    return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.sandbox.use' });
  }

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // Detail
    if (req.query.id) {
      const { data: conv, error } = await supabaseAdmin.from('lisa_conversations')
        .select('*').eq('id', req.query.id).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!conv) return res.status(404).json({ error: 'Conversatie niet gevonden.' });

      const { data: messages } = await supabaseAdmin.from('lisa_messages')
        .select('id, direction, content, sent_at, ai_generated, detected_phase, tokens_used, model_used')
        .eq('conversation_id', conv.id).order('sent_at', { ascending: true });

      const { data: feedback } = await supabaseAdmin.from('lisa_feedback')
        .select('message_id, rating').eq('conversation_id', conv.id);

      return res.status(200).json({ conversation: conv, messages: messages || [], feedback: feedback || [] });
    }

    // Lijst
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

    // Eerste inkomende bericht per conversatie als preview (1 extra query i.p.v. N+1).
    const ids = (convs || []).map((c) => c.id);
    const previews = {};
    if (ids.length) {
      const { data: msgs } = await supabaseAdmin.from('lisa_messages')
        .select('conversation_id, content, direction, sent_at')
        .in('conversation_id', ids).eq('direction', 'in')
        .order('sent_at', { ascending: true });
      for (const m of msgs || []) {
        if (!previews[m.conversation_id]) previews[m.conversation_id] = m.content;
      }
    }
    const list = (convs || []).map((c) => ({ ...c, preview: (previews[c.id] || '').slice(0, 60) }));
    return res.status(200).json({ conversations: list });
  }

  // ── DELETE (alleen sandbox) ──────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id vereist.' });
    const { data: conv } = await supabaseAdmin.from('lisa_conversations').select('id, is_sandbox').eq('id', id).maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversatie niet gevonden.' });
    if (!conv.is_sandbox) return res.status(403).json({ error: 'Alleen sandbox-conversaties kunnen verwijderd worden.' });
    const { error } = await supabaseAdmin.from('lisa_conversations').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
