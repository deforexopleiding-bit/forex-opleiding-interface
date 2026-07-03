// api/follow-up-leads-badge.js
// GET → { te_laat, vandaag, open } tellingen op follow_up_leads voor
// de sidebar-badge. Lichtgewicht: 3 head-count queries, geen rijen.
// Zelfde permissie-gate als follow-up-leads-list.
//
// Response 200: { te_laat, vandaag, open }
// Response 200 + counts=0 bij ontbrekende tabel (42P01) — fail-soft
//   zodat de sidebar geen error toont maar simpelweg geen badge zet.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const zero = { te_laat: 0, vandaag: 0, open: 0 };
  try {
    const todayISO = new Date().toISOString().slice(0, 10);
    const nowISO   = new Date().toISOString();
    const base = () => supabaseAdmin.from('follow_up_leads').select('id', { count: 'exact', head: true });
    const [
      { count: cOpen,    error: eOpen    },
      { count: cVandaag, error: eVandaag },
      { count: cTeLaat,  error: eTeLaat  },
    ] = await Promise.all([
      base().not('lead_status', 'in', '(verlengd,verloren)'),
      base()
        .gte('terugbel_datum', todayISO + 'T00:00:00Z')
        .lte('terugbel_datum', todayISO + 'T23:59:59Z'),
      base().lt('terugbel_datum', nowISO).not('lead_status', 'in', '(verlengd,verloren)'),
    ]);
    // Fail-soft bij 42P01 (tabel ontbreekt).
    if ([eOpen, eVandaag, eTeLaat].some((e) => e && e.code === '42P01')) {
      return res.status(200).json(zero);
    }
    if (eOpen || eVandaag || eTeLaat) {
      console.error('[follow-up-leads-badge]', (eOpen || eVandaag || eTeLaat)?.message);
      return res.status(500).json({ error: 'counts fetch mislukt' });
    }
    return res.status(200).json({
      te_laat: cTeLaat  || 0,
      vandaag: cVandaag || 0,
      open   : cOpen    || 0,
    });
  } catch (e) {
    console.error('[follow-up-leads-badge]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
