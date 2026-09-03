// api/wanbetalers-customer-country-detect.js
//
// GET ?customer_id=<uuid>
//
// BP3 v20 (2026-09-03) — READ-ONLY helper: detecteer klant-land voor de
// UI-flow "Stuur een brief" (Wanbetalers/Gesprekken-kebab). Vervangt de
// hardcoded 'NL' in het kebab-menu (wanbetalers-v2.js:4447).
//
// Response 200:
//   { country: 'NL' | 'BE' | 'unknown', source: 'address_country' | 'postal_code' | 'unknown' }
//
// Detectie-regels (spiegel van bepaalLand() in api/_lib/wik-brief-layout.js):
//   1) customers.address_country ∈ {'NL','BE'} (case-insensitive)     → source='address_country'
//   2) customers.address_postal matcht NL-regex (4 cijfers + 2 letters) → 'NL'  (source='postal_code')
//   3) customers.address_postal matcht BE-regex (4 cijfers, geen letters) → 'BE' (source='postal_code')
//   4) anders                                                          → 'unknown' (frontend toont NL/BE-keuze-dialog)
//
// BELANGRIJK: dit endpoint retourneert 'unknown' i.p.v. de bestaande NL-fallback
// uit bepaalLand(). Zo kan de UI onderscheid maken tussen "we weten het zeker"
// en "we gokken NL". De brief-generator (incasso-pre-brief) hanteert nog altijd
// de eigen NL-fallback voor server-side triggers (engine/workflow) — dit
// endpoint verandert daar niets aan.
//
// Gate: finance.incasso.manage (zelfde permissie als "Stuur een brief"-actie).
// Fallback finance.dunning.view voor read-only rollen. Sluit aan bij bestaande
// wanbetalers-read endpoints.
//
// INCASSO-VEILIG: puur SELECT op customers-adres-velden. Geen dunning-state
// gelezen, geen writes. Wijzigt geen brief-logica, geen template-selectie
// server-side. Alleen input voor UI-beslissing.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Primary gate: finance.incasso.manage (WIK-brief-mutatie). Fallback voor
  // read-only rollen zodat we een dossier-preview kunnen leveren zonder
  // manage-rechten geforceerd te vereisen.
  const canManage = await requirePermission(req, 'finance.incasso.manage');
  const canView   = canManage || await requirePermission(req, 'finance.dunning.view');
  if (!canView) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage of finance.dunning.view)' });
  }

  const cid = String(req.query.customer_id || '').trim();
  if (!UUID_RE.test(cid)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });

  try {
    const { data: cust, error } = await supabaseAdmin
      .from('customers')
      .select('id, address_country, address_postal')
      .eq('id', cid)
      .maybeSingle();
    if (error) throw error;
    if (!cust) return res.status(404).json({ error: 'Klant niet gevonden' });

    const cc = String(cust.address_country || '').trim().toUpperCase();
    if (cc === 'NL' || cc === 'BE') {
      return res.status(200).json({ country: cc, source: 'address_country' });
    }
    const pc = String(cust.address_postal || '').trim();
    if (/^\d{4}\s*[a-zA-Z]{2}$/.test(pc)) return res.status(200).json({ country: 'NL', source: 'postal_code' });
    if (/^\d{4}$/.test(pc))               return res.status(200).json({ country: 'BE', source: 'postal_code' });
    return res.status(200).json({ country: 'unknown', source: 'unknown' });
  } catch (e) {
    console.error('[wanbetalers-customer-country-detect] exception:', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
