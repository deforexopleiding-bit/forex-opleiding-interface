// api/cron/brieven-lms-spiegel.js
//
// DE VERZOENING VAN DE BRIEVEN MET HET BORD IN HET LMS (16 nov 2026), elk uur.
// Dun: auth en doorgeven. De logica staat in api/_lib/brieven-lms.js.
//
// Spiegelt elke gekoppelde brief opnieuw (idempotent: dezelfde stand = niets)
// en koppelt nieuwe brieven (vanaf 16 nov) van klanten met precies één open
// betalingsdossier. Vangt zo ook een sent_at die buiten de knoppen om terug
// leeg gezet werd.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. DROOGLOOP: ?dry=1.

import { verzoenBrieven } from '../_lib/brieven-lms.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const secret = process.env.CRON_SECRET || null;
  const auth = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const uit = await verzoenBrieven({ dry: String(req.query?.dry || '') === '1' });
    return res.status(uit.ok ? 200 : 503).json(uit);
  } catch (e) {
    console.error('[cron brieven-lms-spiegel]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout' });
  }
}
