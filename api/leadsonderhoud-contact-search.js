// api/leadsonderhoud-contact-search.js
//
// GET ?q=<term>&limit=<int, default 15, max 30>
//
// BP3 v22 (2026-09-03) — lichtgewicht contact-picker voor de "+ Nieuwe call"-
// modal. Zoekt alléén in leads + customers (geen event_attendees / follow-up-
// leads / retention-view zoals /api/follow-up-search), zodat we de bestaande
// follow-up-search-gate (sales.tab.retentie) NIET hoeven te verbreden. Deze
// endpoint gate't op `leads.update` — Romy, Dave en management hebben die.
//
// Response 200:
//   { items: [{
//       source: 'lead' | 'customer',
//       lead_id?: uuid,     // aanwezig bij source='lead'
//       customer_id?: uuid, // aanwezig bij source='customer'
//       name: string,
//       email: string | null,
//       phone: string | null,
//       hint: string | null // korte context ("customer 12345", "lead #a1b2")
//   }] }
//
// Dedupe: als een klant én lead dezelfde email hebben, wordt de LEAD getoond
// (canonical bron voor deze modal — Path A is de goedkoopste create-flow).
//
// Read-only. Geen writes, geen GHL/TL-calls.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const MIN_Q_LEN = 2;
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;

function escOr(s) { return String(s || '').replace(/[,()%_]/g, ' ').trim(); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const q = escOr(req.query.q);
  if (q.length < MIN_Q_LEN) return res.status(200).json({ items: [] });
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
  const like = `%${q}%`;

  try {
    // 1) Leads
    const { data: leads, error: lErr } = await supabaseAdmin
      .from('leads')
      .select('id, naam, voornaam, achternaam, email, telefoon, customer_id, source_ref')
      .or(`naam.ilike.${like},email.ilike.${like},telefoon.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (lErr) throw new Error('leads-search: ' + lErr.message);

    // 2) Customers
    const { data: customers, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, email, phone')
      .or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (cErr) throw new Error('customers-search: ' + cErr.message);

    const seenEmail = new Set();
    const items = [];

    for (const l of (leads || [])) {
      const email = String(l.email || '').trim().toLowerCase();
      if (email) seenEmail.add(email);
      const name = l.naam
        || [l.voornaam, l.achternaam].filter(Boolean).join(' ').trim()
        || l.email
        || 'Onbekende lead';
      const hasContact = !!(l?.source_ref?.ghl_contact_id || l.customer_id);
      items.push({
        source: 'lead',
        lead_id: l.id,
        name,
        email: l.email || null,
        phone: l.telefoon || null,
        hint : hasContact ? 'bestaande lead · gekoppeld GHL-contact' : 'bestaande lead · geen GHL-contact',
      });
    }

    for (const c of (customers || [])) {
      const email = String(c.email || '').trim().toLowerCase();
      if (email && seenEmail.has(email)) continue; // lead heeft voorrang
      const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
        || c.email || 'Onbekende klant';
      items.push({
        source: 'customer',
        customer_id: c.id,
        name,
        email: c.email || null,
        phone: c.phone || null,
        hint : 'bestaande klant (nog geen lead)',
      });
    }

    return res.status(200).json({ items: items.slice(0, limit) });
  } catch (e) {
    console.error('[leadsonderhoud-contact-search] exception:', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
