// api/cron/factuurstand-spiegel-sync.js
//
// CRON-INGANG voor de verzoening van de factuurstand-spiegel. Dun: auth,
// parameters, doorgeven.
//
// De logica staat in `api/_lib/factuurstand-sync.js` en wordt gedeeld met de
// knop in het CRM (`api/factuurstand-spiegel-sync-run.js`).
//
// ── ELK UUR, OP :10 (sinds 14 okt 2026 — P3) ─────────────────────────────
// Was één keer per nacht (02:10 UTC). Een student die betaalde bleef dan tot
// de volgende nacht geblokkeerd, terwijl de CRM-facturen al elk uur uit
// Teamleader komen (`cron-finance-sync`, op :00). Daarom nu elk uur, tien
// minuten na die sync, zodat de spiegel de verse facturen ziet. De ronde van
// 02:10 blijft er gewoon tussen zitten: de opvolgmotor aan LMS-kant (02:40)
// vindt dus nog altijd een verse stand. Het LMS heft de automatische
// betaalpauze elk uur op :25 op (`/api/opvolging/factuur-uur/`).
//
// Belasting: één ronde leest de actieve studenten (~300) en de open facturen
// in bulk en schrijft alleen de spiegelrijen; geen Teamleader-calls.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
// DROOGLOOP: ?dry=1 — dezelfde logica, nul schrijfacties.

import { draaiFactuurstandSync } from '../_lib/factuurstand-sync.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { status, result } = await draaiFactuurstandSync({
    dry : String(req.query?.dry || '') === '1',
    door: 'cron',
  });
  return res.status(status).json(result);
}
