// api/mentor-payout-revert.js
//
// Terugdraaien — zet een uitbetaald rapport terug naar 'goedgekeurd' en
// ontboekt de ledger-entries. Alleen super_admin. De volledige mutatie zit
// in de Postgres-functie `revert_payout_payment`; deze handler doet alleen
// auth + RPC-call + foutmapping. Geen losse tabel-mutatie hier.
//
// Permission: mentor.payout.revert.
//
// Body: { payout_id: uuid }
//
// Foutmapping op raw PG-message:
//   'not_found'              → 404 'rapport niet gevonden'
//   begint met 'bad_status'  → 409 met huidige status (code BAD_STATUS)
//   anders                   → 500 met raw message
//
// Response 200: { ok:true, status:'goedgekeurd', ledger_unmarked:<int> }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
  if (!(await requirePermission(req, 'mentor.payout.revert'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.revert)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const payoutId = typeof body.payout_id === 'string' ? body.payout_id.trim() : '';
  if (!payoutId || !UUID_RE.test(payoutId)) {
    return res.status(400).json({ error: 'payout_id (uuid) vereist' });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('revert_payout_payment', {
      p_payout_id: payoutId,
      p_actor    : user.id,
    });
    if (error) {
      const raw = String(error.message || error.details || '').trim();
      if (raw === 'not_found') {
        return res.status(404).json({ error: 'rapport niet gevonden' });
      }
      if (raw.startsWith('bad_status')) {
        const m = raw.match(/^bad_status[:\s]*(.*)$/);
        const current = (m && m[1]) ? m[1].trim() : '';
        return res.status(409).json({
          error  : 'kan niet terugdraaien vanuit huidige status',
          code   : 'BAD_STATUS',
          status : current || null,
        });
      }
      return res.status(500).json({ error: raw || 'Interne fout' });
    }

    let ledgerUnmarked = 0;
    if (data && typeof data === 'object' && 'ledger_unmarked' in data) {
      ledgerUnmarked = Number(data.ledger_unmarked) || 0;
    } else if (Number.isFinite(Number(data))) {
      ledgerUnmarked = Number(data);
    }

    return res.status(200).json({
      ok              : true,
      status          : 'goedgekeurd',
      ledger_unmarked : ledgerUnmarked,
    });
  } catch (e) {
    console.error('[mentor-payout-revert]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
