// api/wanbetalers-sandbox-oefengesprek-reset.js
//
// POST → wist ALLE whatsapp_messages van het gesprek met de sandbox-test-
// persoon, zodat Jeffrey een schoon oefengesprek kan starten zonder een
// volledige sandbox-reset te draaien (die zou ook facturen/pipeline/klant
// wissen).
//
// SCOPE-GARANTIE (defense-in-depth, drie lagen):
//   1) Customer lookup via getSandboxCustomer() → per definitie is_test=true.
//   2) Assert customer.is_test !== true → 500 SANDBOX_GUARD_FAILED (vangnet
//      als een toekomstige bug in de helper per ongeluk een non-test klant
//      teruggeeft).
//   3) SELECT/DELETE-filter: whatsapp_conversations.customer_id = sandbox.id
//      → we vinden ALLEEN de sandbox-conv-ids. Per gevonden conv doen we
//      DELETE FROM whatsapp_messages .eq('conversation_id', conv.id) — dus
//      een echt gesprek kan onmogelijk worden geraakt.
//
// De conversation-rijen zelf blijven staan (met customer_id + phone_number),
// zodat de volgende simulate-inbound in hetzelfde gesprek doorloopt. Ook
// joost_conversation_state en joost_suggestions blijven staan — die willen
// we tijdens een oefengesprek meestal niet mee-wissen (state = cross-turn
// context voor de LLM; suggestions = audit-trail). Wie een echte volledige
// reset wil, gebruikt wanbetalers-sandbox-reset (bestaande gevaren-knop).
//
// Super_admin only, geen CRON_SECRET.
//
// Response: { ok, conversations_touched, messages_deleted, conversation_ids }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  try {
    // Laag 1 + 2: sandbox-klant + expliciete is_test-assertie.
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });
    if (customer.is_test !== true) {
      return res.status(500).json({ error: 'SANDBOX_GUARD_FAILED: sandbox-klant heeft is_test !== true.' });
    }

    // Laag 3: conv-ids ophalen SCOPED op sandbox-klant.
    const { data: convs, error: cErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id')
      .eq('customer_id', customer.id);
    if (cErr) throw new Error('conversations lookup: ' + cErr.message);
    const convList = Array.isArray(convs) ? convs : [];
    if (convList.length === 0) {
      return res.status(200).json({ ok: true, conversations_touched: 0, messages_deleted: 0, conversation_ids: [] });
    }

    // Per-conv defense: extra check dat customer_id klopt. Alleen dan DELETE
    // de messages van die conv.
    let totalDeleted = 0;
    const touched = [];
    for (const conv of convList) {
      if (conv.customer_id !== customer.id) {
        console.warn('[oefengesprek-reset] SANDBOX_GUARD_FAILED skip conv', conv.id);
        continue;
      }
      const { count, error: dErr } = await supabaseAdmin
        .from('whatsapp_messages')
        .delete({ count: 'exact' })
        .eq('conversation_id', conv.id);
      if (dErr) {
        console.warn('[oefengesprek-reset] delete fail conv', conv.id, dErr.message);
        continue;
      }
      totalDeleted += (count || 0);
      touched.push(conv.id);

      // Preview en last_message_at leegmaken zodat de UI direct schoon oogt.
      // Meta van de conversation zelf blijft intact (phone, customer_id, …).
      await supabaseAdmin
        .from('whatsapp_conversations')
        .update({ last_message_preview: null, last_message_at: null, last_inbound_at: null, unread_count: 0 })
        .eq('id', conv.id);
    }

    return res.status(200).json({
      ok:                    true,
      conversations_touched: touched.length,
      messages_deleted:      totalDeleted,
      conversation_ids:      touched,
    });
  } catch (e) {
    console.error('[oefengesprek-reset]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
