// api/cron/onboarding-spiegel-sync.js
//
// CRON-INGANG voor de verzoening van de onboarding-spiegel. Dun: auth,
// parameters, doorgeven.
//
// De logica staat in `api/_lib/onboarding-spiegel-sync.js` en wordt gedeeld
// met de knop in het CRM (`api/onboarding-spiegel-sync-run.js`).
//
// ── DIT IS DE WAARHEID, NIET HET VANGNET ─────────────────────────────────
// De aanroepen van `spiegelOnboarding()` vanuit endpoints zijn er zodat het
// scherm meteen klopt. Deze ronde bepaalt wat WAAR is. Die volgorde is met
// opzet zo: er zijn twintig schrijfpunten op `onboardings`, en bij twintig is
// het geen kwestie óf er ooit eentje de spiegel vergeet, maar wanneer.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
// DROOGLOOP: ?dry=1 — dezelfde logica, nul schrijfacties.

import { draaiSpiegelSync } from '../_lib/onboarding-spiegel-sync.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { status, result } = await draaiSpiegelSync({
    dry : String(req.query?.dry || '') === '1',
    door: 'cron',
  });
  return res.status(status).json(result);
}
