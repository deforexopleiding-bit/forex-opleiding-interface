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
// Leesstand (3 nov 2026): koppelen aan een klant zet een ONGELEZEN mail die
// ouder is dan LATE_KOPPELING_GELEZEN_NA_DAGEN in dezelfde update op gelezen
// (koppelPatch in _lib/gesprek-leesstand.js), zodat een oude mail een gelezen
// gesprek niet terug ongelezen maakt. Ontkoppelen raakt is_read niet.
//
// Permission: finance.inbox.view (lichte actie, geen berichten sturen).
// Consistent met inbox-conversation-set-status.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { koppelPatch } from './_lib/gesprek-leesstand.js';

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
      .select('id, from_address, customer_id, is_read, date_received')
      .eq('id', messageId)
      .maybeSingle();
    if (msgErr) throw new Error('lookup: ' + msgErr.message);
    if (!msg) return res.status(404).json({ error: 'email_messages rij niet gevonden' });

    if (customerId) {
      const { data: cust, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id, archived_at, anonymized_at')
        .eq('id', customerId)
        .maybeSingle();
      if (custErr) throw new Error('klant: ' + custErr.message);
      if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });
      if (cust.archived_at || cust.anonymized_at) {
        return res.status(409).json({ error: 'Klant is gearchiveerd/geanonimiseerd' });
      }
    }

    const previous = msg.customer_id || null;

    const patch = koppelPatch(msg, customerId);
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('email_messages')
      .update(patch)
      .eq('id', messageId)
      .select('id, from_address, customer_id, is_read')
      .maybeSingle();
    if (updErr) throw new Error('update: ' + updErr.message);
    if (!updated) throw new Error('update: rij niet meer gevonden');

    return res.status(200).json({
      ok: true,
      item: {
        id: updated.id,
        from_address: updated.from_address,
        customer_id: updated.customer_id,
        previous_customer_id: previous,
        is_read: updated.is_read,
        gelezen_gezet: patch.is_read === true,
      },
    });
  } catch (e) {
    console.error('[email-message-link-customer]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
