// api/leadsonderhoud-access-batch.js
// POST body: { lead_ids: uuid[] } → { access: { [lead_id]: 'YYYY-MM-DD' | null } }
//
// Read-only batch-lookup: max toegang_tot per lead (over alle grants van de
// gekoppelde lms_gebruiker). Voor de "Toegang tot"-kolom in Leadsonderhoud →
// Contacten. Fail-soft: onbekende lead / geen lms-account / geen grants →
// key blijft null (UI toont "Geen toegang").
//
// RBAC: leads.view (spiegel van leadsonderhoud-gesprekken).
// 0 writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LEADS = 500;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const body = req.body || {};
  const rawIds = Array.isArray(body.lead_ids) ? body.lead_ids : [];
  const leadIds = rawIds.map(String).filter(id => UUID_RE.test(id)).slice(0, MAX_LEADS);
  if (!leadIds.length) return res.status(200).json({ access: {} });

  const access = Object.create(null);
  for (const id of leadIds) access[id] = null;

  try {
    // 1. Voor deze lead-ids: haal lms_gebruikers op via lead_id-koppeling.
    const { data: usersByLead } = await supabaseAdmin
      .from('lms_gebruikers')
      .select('id, lead_id, email')
      .in('lead_id', leadIds);

    const uidByLead = new Map();
    const lmsUserIds = new Set();
    for (const u of (usersByLead || [])) {
      if (u.id && u.lead_id) {
        uidByLead.set(u.lead_id, u.id);
        lmsUserIds.add(u.id);
      }
    }

    // 2. Voor leads die geen directe lead_id-koppeling hebben: fallback via email.
    const missingLeadIds = leadIds.filter(id => !uidByLead.has(id));
    if (missingLeadIds.length) {
      const { data: leadsRow } = await supabaseAdmin
        .from('leads')
        .select('id, email')
        .in('id', missingLeadIds)
        .not('email', 'is', null);
      const emailByLead = new Map();
      const emails = [];
      for (const l of (leadsRow || [])) {
        if (l.email) {
          const em = String(l.email).trim().toLowerCase();
          emailByLead.set(l.id, em);
          emails.push(em);
        }
      }
      if (emails.length) {
        const { data: emailMatches } = await supabaseAdmin
          .from('lms_gebruikers')
          .select('id, email')
          .in('email', emails);
        const uidByEmail = new Map();
        for (const u of (emailMatches || [])) {
          if (u.email) uidByEmail.set(String(u.email).toLowerCase(), u.id);
        }
        for (const [leadId, email] of emailByLead.entries()) {
          const uid = uidByEmail.get(email);
          if (uid) { uidByLead.set(leadId, uid); lmsUserIds.add(uid); }
        }
      }
    }

    if (!lmsUserIds.size) return res.status(200).json({ access });

    // 3. Grants ophalen voor alle betrokken lms_gebruikers; max toegang_tot per user.
    const { data: grants } = await supabaseAdmin
      .from('lms_toegang')
      .select('gebruiker_id, toegang_tot')
      .in('gebruiker_id', Array.from(lmsUserIds));

    const maxByUid = new Map();
    for (const g of (grants || [])) {
      if (!g.toegang_tot) continue;
      const iso = String(g.toegang_tot).slice(0, 10);
      const cur = maxByUid.get(g.gebruiker_id);
      if (!cur || iso > cur) maxByUid.set(g.gebruiker_id, iso);
    }

    // 4. Map terug naar lead_id.
    for (const [leadId, uid] of uidByLead.entries()) {
      const tot = maxByUid.get(uid);
      if (tot) access[leadId] = tot;
    }

    return res.status(200).json({ access });
  } catch (e) {
    console.error('[leadsonderhoud-access-batch]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
