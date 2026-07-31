// api/tasks-create-followup.js
// POST → maakt een MANUAL_FOLLOWUP pending_action voor een klant (bv. bel-taak
// vanuit de inbox). Klein wrapper-endpoint zodat de inbox een "→ Bel-taak"-knop
// heeft zonder de generieke tasks-create-* helpers te overladen.
//
// FASE 4 herontwerp — Blok 1 — deel van de "naar-acties" knoppen in de compose-rij.
//
// Request:
//   POST { customer_id: uuid, source?: string, reason?: string, invoice_id?: uuid|null,
//          title?: string, note?: string, kind?: string }
//
// title / note / kind zijn optionele payload-verrijking voor de "vrije taak"-
// variant vanuit de Gesprekken-tab popup (Blok 2). Ze belanden in payload jsonb
// zonder breaking-change voor bestaande callers.
//
// Response 200:
//   { ok: true, item: { id, action_type, customer_id, status, created_at } }
//
// Permission: finance.tasks.create (met fallback naar finance.arrangements.propose
// zodat medewerkers die al taken kunnen aanmaken via andere kanalen deze knop
// ook zien).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { buildFollowupPayload } from './_lib/gesprek-actie-helpers.js';

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
  const allowed = (await requirePermission(req, 'finance.tasks.create'))
    || (await requirePermission(req, 'finance.arrangements.propose'));
  if (!allowed) {
    return res.status(403).json({ error: 'Geen rechten (finance.tasks.create)' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const customerId = body.customer_id ? String(body.customer_id).trim() : '';
  if (!customerId || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id (uuid) vereist', code: 'MISSING_CUSTOMER_ID' });
  }
  const invoiceId = body.invoice_id && UUID_RE.test(String(body.invoice_id)) ? String(body.invoice_id) : null;

  // Klant moet bestaan.
  const { data: cust, error: custErr } = await supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, company_name, archived_at, anonymized_at')
    .eq('id', customerId)
    .maybeSingle();
  if (custErr) return res.status(500).json({ error: custErr.message });
  if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });
  if (cust.archived_at || cust.anonymized_at) {
    return res.status(409).json({ error: 'Klant is gearchiveerd/geanonimiseerd' });
  }

  const payload = buildFollowupPayload(body, user.id);

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('pending_actions')
    .insert({
      customer_id: customerId,
      invoice_id: invoiceId,
      arrangement_id: null,
      action_type: 'MANUAL_FOLLOWUP',
      status: 'PENDING',
      payload,
      proposed_by_user_id: user.id,
    })
    .select('id, action_type, customer_id, status, created_at')
    .maybeSingle();

  if (insErr) {
    console.error('[tasks-create-followup]', insErr.message);
    return res.status(500).json({ error: insErr.message, code: 'INSERT_FAILED' });
  }
  return res.status(200).json({ ok: true, item: inserted });
}
