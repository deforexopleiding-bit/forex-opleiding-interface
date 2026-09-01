// api/lead-setter-lookup.js
//
// GET
//   ?lead_id=<uuid>              → resolve via leads.email/telefoon
//   ?email=<addr>                → direct email-match
//   ?telefoon=<E164 of raw>      → direct telefoon-last9-match
//   ?customer_id=<uuid>          → resolve via customers.email/telefoon
// (Combineerbaar; email/telefoon uit query wint over lead_id/customer_id
//  lookup — dit is de "vers-invoer"-flow uit de wizard.)
//
// Response: { setter_user_id: <uuid>|null, source: 'email'|'phone'|null }
//
// Match-volgorde (per query-key):
//   1. Email:    ilike(lead_email = <email>) op follow_up_appointments,
//                setter_user_id NOT NULL, oudste (scheduled_at ASC).
//   2. Telefoon: last-9-digits match (client-side filter na SELECT).
//
// Gate: leads.view.
// Fail-soft: elke DB-fout returnt { setter_user_id: null }, geen 500.
//
// v2 (2026-09-01) BP2-hardening: klant-catch-all zodat vers-in-de-wizard
// gemaakte deals ook worden geattribueerd zonder source_lead_id.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function tel9(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-9) : '';
}

async function resolveByEmail(email) {
  if (!email || !EMAIL_RE.test(email)) return null;
  const { data } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('setter_user_id, scheduled_at')
    .ilike('lead_email', email)
    .not('setter_user_id', 'is', null)
    .order('scheduled_at', { ascending: true })
    .limit(1).maybeSingle();
  return data?.setter_user_id ? { setter_user_id: data.setter_user_id, source: 'email' } : null;
}

async function resolveByPhone(telefoon) {
  const last9 = tel9(telefoon);
  if (!last9) return null;
  // Client-side filter op last-9: PostgREST kan geen computed expressions
  // in .eq. Bounded op 500 (defensief); oudste boeking wint via order.
  const { data } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('setter_user_id, lead_phone, scheduled_at')
    .not('setter_user_id', 'is', null)
    .order('scheduled_at', { ascending: true })
    .limit(500);
  const hit = (data || []).find((r) => {
    const rd = String(r.lead_phone || '').replace(/\D/g, '');
    return rd && rd.slice(-9) === last9;
  });
  return hit?.setter_user_id ? { setter_user_id: hit.setter_user_id, source: 'phone' } : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const q          = req.query || {};
  const leadId     = String(q.lead_id     || '').trim();
  const customerId = String(q.customer_id || '').trim();
  let email        = String(q.email       || '').trim().toLowerCase();
  let telefoon     = String(q.telefoon    || '').trim();

  try {
    // 1) Als email/telefoon direct meegestuurd → skip lead/customer-lookup.
    // 2) Anders: probeer lead_id, dan customer_id om email/telefoon te vinden.
    if (!email && !telefoon) {
      if (leadId && UUID_RE.test(leadId)) {
        const { data: lead } = await supabaseAdmin
          .from('leads').select('email, telefoon').eq('id', leadId).maybeSingle();
        email    = String(lead?.email    || '').trim().toLowerCase();
        telefoon = String(lead?.telefoon || '').trim();
      } else if (customerId && UUID_RE.test(customerId)) {
        const { data: cust } = await supabaseAdmin
          .from('customers').select('email, phone').eq('id', customerId).maybeSingle();
        email    = String(cust?.email || '').trim().toLowerCase();
        telefoon = String(cust?.phone || '').trim();
      }
    }

    if (!email && !telefoon) {
      return res.status(200).json({ setter_user_id: null, source: null });
    }

    // Email eerst, telefoon fallback.
    let hit = await resolveByEmail(email);
    if (!hit) hit = await resolveByPhone(telefoon);
    return res.status(200).json(hit || { setter_user_id: null, source: null });
  } catch (e) {
    console.warn('[lead-setter-lookup]', e?.message || e);
    return res.status(200).json({ setter_user_id: null, source: null });
  }
}
