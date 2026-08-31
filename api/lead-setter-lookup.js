// api/lead-setter-lookup.js
//
// GET ?lead_id=<uuid> → { setter_user_id: <uuid>|null, source: 'email'|'phone'|null }
//
// Auto-lookup voor de wizard-picker: gegeven een lead, zoek de setter
// die deze lead via een boeking heeft aangedragen. Match-volgorde:
//   1. leads.email → follow_up_appointments.lead_email (case-insensitive)
//      → oudste boeking met setter_user_id NOT NULL.
//   2. Fallback: telefoon-last9-digits match.
//
// Gate: leads.view — verkoper mag lookup doen tijdens deal-creatie.
// Fail-soft: elke fout returnt { setter_user_id: null }, geen 500.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const leadId = String(req.query?.lead_id || '').trim();
  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id (uuid) vereist' });

  try {
    const { data: lead } = await supabaseAdmin
      .from('leads').select('email, telefoon').eq('id', leadId).maybeSingle();
    if (!lead) return res.status(200).json({ setter_user_id: null, source: null });

    // 1) Email-match.
    if (lead.email) {
      const { data: fa } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('setter_user_id')
        .ilike('lead_email', lead.email)
        .not('setter_user_id', 'is', null)
        .order('scheduled_at', { ascending: true })
        .limit(1).maybeSingle();
      if (fa?.setter_user_id) {
        return res.status(200).json({ setter_user_id: fa.setter_user_id, source: 'email' });
      }
    }

    // 2) Telefoon-last9-fallback.
    if (lead.telefoon) {
      const tel9 = String(lead.telefoon).replace(/\D/g, '').slice(-9);
      if (tel9 && tel9.length >= 8) {
        const { data: all } = await supabaseAdmin
          .from('follow_up_appointments')
          .select('setter_user_id, lead_phone, scheduled_at')
          .not('setter_user_id', 'is', null)
          .order('scheduled_at', { ascending: true })
          .limit(200);
        const hit = (all || []).find((r) => {
          const rd = String(r.lead_phone || '').replace(/\D/g, '');
          return rd && rd.slice(-9) === tel9;
        });
        if (hit?.setter_user_id) {
          return res.status(200).json({ setter_user_id: hit.setter_user_id, source: 'phone' });
        }
      }
    }

    return res.status(200).json({ setter_user_id: null, source: null });
  } catch (e) {
    console.warn('[lead-setter-lookup]', e?.message || e);
    return res.status(200).json({ setter_user_id: null, source: null });
  }
}
