// api/email-message-link-customer.js
// POST → koppel handmatig een email_messages-rij aan een klant (of ontkoppel).
//
// FASE 4 blok 2 — corrigeerbaarheid voor de unified-inbox koppeling. Wordt
// gebruikt wanneer:
//   • sync-emails niet automatisch een match vond (0 hits of >1 hits),
//   • of een medewerker een verkeerde koppeling wil corrigeren.
//
// Request:
//   POST { message_id: uuid, customer_id: uuid | null }
//   (customer_id=null → ontkoppelen — zet customer_id op NULL)
//
// Response 200:
//   { ok: true, item: { id, from_address, customer_id, previous_customer_id } }
//
// Permission: finance.inbox.view (lichte actie, geen berichten sturen).
// Consistent met inbox-conversation-set-status.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.inbox.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view)' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const messageId = body.message_id ? String(body.message_id).trim() : '';
  if (!messageId || !UUID_RE.test(messageId)) {
    return res.status(400).json({ error: 'message_id (uuid) vereist' });
  }
  // customer_id mag null zijn (ontkoppel).
  let customerId = null;
  if (body.customer_id !== null && body.customer_id !== undefined && body.customer_id !== '') {
    const cid = String(body.customer_id).trim();
    if (!UUID_RE.test(cid)) {
      return res.status(400).json({ error: 'customer_id moet uuid of null zijn' });
    }
    customerId = cid;
  }

  try {
    // Verifieer rows bestaan.
    const { data: msg, error: msgErr } = await supabaseAdmin
      .from('email_messages')
      .select('id, from_address, customer_id')
      .eq('id', messageId)
      .maybeSingle();
    if (msgErr) throw new Error('lookup: ' + msgErr.message);
    if (!msg) return res.status(404).json({ error: 'email_messages rij niet gevonden' });

    if (customerId) {
      const { data: cust } = await supabaseAdmin
        .from('customers')
        .select('id, archived_at, anonymized_at')
        .eq('id', customerId)
        .maybeSingle();
      if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });
      if (cust.archived_at || cust.anonymized_at) {
        return res.status(409).json({ error: 'Klant is gearchiveerd/geanonimiseerd' });
      }
    }

    const previous = msg.customer_id || null;

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('email_messages')
      .update({ customer_id: customerId })
      .eq('id', messageId)
      .select('id, from_address, customer_id')
      .maybeSingle();
    if (updErr) throw new Error('update: ' + updErr.message);

    return res.status(200).json({
      ok: true,
      item: {
        id: updated.id,
        from_address: updated.from_address,
        customer_id: updated.customer_id,
        previous_customer_id: previous,
      },
    });
  } catch (e) {
    console.error('[email-message-link-customer]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
