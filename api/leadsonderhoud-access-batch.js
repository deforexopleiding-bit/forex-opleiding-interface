// api/leadsonderhoud-access-batch.js  (v=2 · 2026-08-25)
// POST body: { lead_ids: uuid[] }
// Response: { access: { [lead_id]: { toegang_tot: 'YYYY-MM-DD'|null,
//                                     verlopen: boolean, dagen_over: number|null,
//                                     gebruiker_id: uuid|null } | null } }
//
// LEEST DE TRIAL-BRON: `trial_warmte`-view heeft per lead direct de velden
// `lead_id, gebruiker_id, toegang_tot, verlopen, dagen_over` — dat is de
// enige betrouwbare brug voor 7-daagse/minicursus-trials. De oude flow
// (lead_id → lms_gebruikers → lms_toegang) miste vaak omdat leads-ingest de
// lead_id op lms_gebruikers niet altijd zette en de email-fallback normalisatie
// dropte. Fallback: `lms_gebruikers` direct als trial_warmte geen match heeft
// (bv. lead die geen trial (meer) heeft maar wel een LMS-account).
//
// RBAC: leads.view. 0 writes.

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
    // 1. Primair: trial_warmte per lead_id.
    const { data: warm } = await supabaseAdmin
      .from('trial_warmte')
      .select('lead_id, gebruiker_id, toegang_tot, verlopen, dagen_over')
      .in('lead_id', leadIds);
    for (const w of (warm || [])) {
      if (!w || !w.lead_id) continue;
      const iso = w.toegang_tot ? String(w.toegang_tot).slice(0, 10) : null;
      access[w.lead_id] = {
        toegang_tot:  iso,
        verlopen:     !!w.verlopen,
        dagen_over:   (typeof w.dagen_over === 'number') ? w.dagen_over : null,
        gebruiker_id: w.gebruiker_id || null,
        source:       'trial_warmte',
      };
    }

    // 2. Fallback: lms_gebruikers direct (voor leads zonder trial maar wél
    //    een LMS-account — bv. Membership-conversies). Alleen voor lead_ids
    //    die nog geen trial_warmte-hit hebben.
    const missing = leadIds.filter(id => !access[id]);
    if (missing.length) {
      const { data: usersByLead } = await supabaseAdmin
        .from('lms_gebruikers')
        .select('id, lead_id, toegang_tot')
        .in('lead_id', missing);
      for (const u of (usersByLead || [])) {
        if (!u || !u.lead_id) continue;
        const iso = u.toegang_tot ? String(u.toegang_tot).slice(0, 10) : null;
        if (!iso) continue;
        const today = new Date().toISOString().slice(0, 10);
        access[u.lead_id] = {
          toegang_tot:  iso,
          verlopen:     iso < today,
          dagen_over:   Math.round((new Date(iso + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86400000),
          gebruiker_id: u.id,
          source:       'lms_gebruikers',
        };
      }
    }

    return res.status(200).json({ access });
  } catch (e) {
    console.error('[leadsonderhoud-access-batch]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
