// api/leads-promote.js
// POST { id } → zet lead door naar customers.
//
// Gedrag (per plan-2):
//   1) Lead ophalen. Niet gevonden → 404.
//   2) Als lead al 'gewonnen' + customer_id → 200 idempotent (no-op).
//   3) Als email leeg/ongeldig → 422 email-required (geen halve customer).
//   4) Bestaande customer met deze email? → LINK (customer_id ophalen, geen
//      nieuwe aanmaken). Anders: nieuwe customer aanmaken.
//   5) Update leads: status='gewonnen' + customer_id (indien kolom bestaat).
//
// Permission: leads.promote.
//
// Response bij success:
//   { ok:true, action: 'linked'|'created', customer_id, was_no_op?: true }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { normalizeEmail, validateLeadForPromote, decidePromoteAction } from './_lib/leads-promote.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.promote'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.promote)' });
  }

  const body = req.body || {};
  const id = body.id ? String(body.id).trim() : null;
  if (!id) return res.status(400).json({ error: 'id vereist' });

  try {
    // 1) Lead ophalen.
    const { data: lead, error: lErr } = await supabaseAdmin.from('leads')
      .select('id, naam, email, telefoon, status, customer_id')
      .eq('id', id).maybeSingle();
    if (lErr) throw new Error('leads fetch: ' + lErr.message);

    // 2/3) Valideer via pure helper (dekt: not-found, already-promoted, email-required).
    const v = validateLeadForPromote(lead);
    if (!v.ok) {
      if (v.code === 'already-promoted') {
        // Idempotent no-op — geen 4xx.
        return res.status(200).json({ ok: true, action: 'linked', customer_id: v.existing_customer_id, was_no_op: true });
      }
      const status = v.code === 'lead-not-found' ? 404 : 422;
      return res.status(status).json({ error: v.message, code: v.code });
    }

    // 4) Bestaande customer? case-insensitive lookup via ILIKE (email-index vriendelijk).
    const emailNorm = v.email;
    const { data: existingList, error: cErr } = await supabaseAdmin.from('customers')
      .select('id, email')
      .ilike('email', emailNorm)
      .limit(2);
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    const existing = (existingList || []).find(c => normalizeEmail(c.email) === emailNorm) || null;

    const decision = decidePromoteAction(lead, existing);
    let customerId, action;
    if (decision.action === 'link') {
      customerId = decision.customer_id;
      action = 'linked';
    } else {
      // Nieuwe customer aanmaken.
      const { data: cust, error: iErr } = await supabaseAdmin.from('customers')
        .insert({ ...decision.payload, created_by_user_id: user.id })
        .select('id').single();
      if (iErr) {
        // Race-condition: iemand anders maakte 'em tussen lookup en insert.
        // Herhaal lookup, link alsnog.
        if (iErr.code === '23505') {
          const { data: retryList } = await supabaseAdmin.from('customers')
            .select('id').ilike('email', emailNorm).limit(1);
          const retry = (retryList || [])[0];
          if (retry) {
            customerId = retry.id;
            action = 'linked';
          } else {
            throw new Error('customers insert (23505 zonder retry-hit): ' + iErr.message);
          }
        } else {
          throw new Error('customers insert: ' + iErr.message);
        }
      } else {
        customerId = cust.id;
        action = 'created';
      }
    }

    // 5) Update leads: status='gewonnen' + customer_id (defensive: try eerst met
    //    customer_id, val terug op alleen status als kolom niet bestaat).
    const patch = { status: 'gewonnen', customer_id: customerId };
    let { error: uErr } = await supabaseAdmin.from('leads').update(patch).eq('id', id);
    if (uErr) {
      const msg = uErr.message || '';
      if (/customer_id/i.test(msg) && /column/i.test(msg)) {
        // Kolom bestaat niet in dit schema — val terug op alleen status.
        const { error: u2 } = await supabaseAdmin.from('leads').update({ status: 'gewonnen' }).eq('id', id);
        if (u2) throw new Error('leads update (fallback): ' + u2.message);
        console.warn('[leads-promote] customer_id kolom ontbreekt op leads — alleen status geüpdatet.');
      } else {
        throw new Error('leads update: ' + msg);
      }
    }

    return res.status(200).json({ ok: true, action, customer_id: customerId });
  } catch (e) {
    console.error('[leads-promote]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
