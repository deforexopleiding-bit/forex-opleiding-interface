// api/onboarding-counts.js
// GET → aggregate onboarding-tellingen voor dashboard-badge.
//
// active_count  = aangemeld + bezig (informatief — totaal lopend).
// action_count  = ACTIE-GERICHT: # actieve onboardings met ≥1 ongelezen
//                 WhatsApp-inbound in de onboarding-inbox. Spiegelt
//                 leadsonderhoud-open-count-semantiek — sidebar-badge
//                 gebruikt dit, niet active_count (2026-08-24).
//
// Response:
//   {
//     action_count: N,       // NIEUW — sidebar-badge leest deze
//     active_count: N,       // backward-compat (info-only)
//     by_status: { aangemeld: N, bezig: N, afgerond: N, gearchiveerd: N },
//     total: N,
//   }
//
// Permission: onboarding.view (fallback: leads.view).
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ACTIVE_STATUSES = ['aangemeld', 'bezig'];

// Berekent action_count: actieve onboardings met ≥1 unread WA-inbound in de
// onboarding-inbox. Fail-soft: bij elke fout returnen 0 (badge = geen ruis).
async function computeActionCount() {
  try {
    // 1) Phone-number van de onboarding-inbox.
    const { data: mcfg, error: mErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'onboarding')
      .eq('is_active', true)
      .maybeSingle();
    if (mErr) { console.warn('[onboarding-counts] whatsapp_module_config:', mErr.message); return 0; }
    if (!mcfg || !mcfg.phone_number_id) return 0;

    // 2) Conversaties met ongelezen inbound (niet gearchiveerd, gekoppeld
    //    aan een customer). Cap 2000 — inbox blijft klein.
    const { data: convs, error: cErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('customer_id')
      .eq('phone_number_id', mcfg.phone_number_id)
      .gt('unread_count', 0)
      .neq('status', 'archived')
      .not('customer_id', 'is', null)
      .limit(2000);
    if (cErr) { console.warn('[onboarding-counts] whatsapp_conversations:', cErr.message); return 0; }

    const cids = new Set();
    for (const c of (convs || [])) if (c && c.customer_id) cids.add(c.customer_id);
    if (!cids.size) return 0;

    // 3) Alleen customers met een ACTIEVE (niet-test) onboarding tellen mee.
    //    Chunked .in() voor de zeldzame case >200 customers.
    const list = Array.from(cids);
    const CHUNK = 200;
    const matched = new Set();
    for (let i = 0; i < list.length; i += CHUNK) {
      const slice = list.slice(i, i + CHUNK);
      const { data: onbs, error: oErr } = await supabaseAdmin
        .from('onboardings')
        .select('customer_id')
        .in('customer_id', slice)
        .in('status', ACTIVE_STATUSES)
        .eq('is_test', false);
      if (oErr) { console.warn('[onboarding-counts] onboardings-in:', oErr.message); continue; }
      for (const o of (onbs || [])) if (o && o.customer_id) matched.add(o.customer_id);
    }
    return matched.size;
  } catch (e) {
    console.warn('[onboarding-counts] computeActionCount exception:', e?.message || e);
    return 0;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = (await requirePermission(req, 'onboarding.view'))
    || (await requirePermission(req, 'leads.view'));
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    // Statussen + action_count parallel — beide onafhankelijk.
    const [statusesResp, actionCount] = await Promise.all([
      supabaseAdmin.from('onboardings').select('status').eq('is_test', false).limit(20000),
      computeActionCount(),
    ]);
    if (statusesResp.error) throw new Error('onboardings: ' + statusesResp.error.message);

    const by = Object.create(null);
    for (const row of (statusesResp.data || [])) {
      const s = row && row.status ? String(row.status) : 'onbekend';
      by[s] = (by[s] || 0) + 1;
    }
    const active = ACTIVE_STATUSES.reduce((s, k) => s + (by[k] || 0), 0);
    const total  = (statusesResp.data || []).length;

    return res.status(200).json({
      action_count: actionCount,
      active_count: active,
      by_status:    by,
      total,
    });
  } catch (e) {
    console.error('[onboarding-counts]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
