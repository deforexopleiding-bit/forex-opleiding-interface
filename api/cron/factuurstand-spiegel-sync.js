// api/cron/factuurstand-spiegel-sync.js
//
// CRON-INGANG voor de verzoening van de factuurstand-spiegel. Dun: auth,
// parameters, doorgeven.
//
// De logica staat in `api/_lib/factuurstand-sync.js` en wordt gedeeld met de
// knop in het CRM (`api/factuurstand-spiegel-sync-run.js`).
//
// ── HET UUR, EN WAAROM DIT UUR ───────────────────────────────────────────
// 02:10 UTC. De opvolgmotor aan LMS-kant draait 's nachts en moet een verse
// factuurstand voor zich vinden; die volgorde is de hele reden dat dit een
// nachtelijke ronde is en geen ochtendronde zoals de onboarding-spiegel
// (07:20). Vroeg genoeg om ruim vóór elke plausibele LMS-ronde klaar te
// zijn, en het botst niet met de andere nachtcrons van het CRM
// (01:05 events-cms-cleanup, 02:30 cancellation-cleanup, 03:00/03:30 de
// archiveerrondes).
//
// LET OP — dit uur is afgestemd op een AANNAME over de LMS-motor, niet op een
// gemeten feit: het exacte uur daarvan is aan de andere kant van de brug
// bepaald. Draait die motor vóór 02:10, dan hoort dit uur naar voren. Eén
// regel in vercel.json, en verder niets.
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
