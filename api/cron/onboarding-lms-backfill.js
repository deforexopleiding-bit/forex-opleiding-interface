// api/cron/onboarding-lms-backfill.js
//
// CRON-INGANG voor de LMS-inhaalslag. Dun: auth, parameters, doorgeven.
//
// De logica staat in `api/_lib/onboarding-lms-backfill.js` en wordt gedeeld
// met de knop in het CRM (`api/onboarding-lms-backfill-run.js`). Eén
// implementatie, twee ingangen — er is geen tweede versie die kan afwijken.
//
// DIT PAD IS NIET WAT WIJ GEBRUIKEN. Het blijft bestaan voor later
// (geautomatiseerd draaien, of vanaf een machine zonder sessie), maar het
// dagelijkse werk gaat via de knop: een geheim dat iemand in een terminal
// moet typen is precies de plek waar het misgaat.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
// DROOGLOOP IS DE STANDAARD: zonder ?uitvoeren=ja gebeurt er niets.
// UITVOEREN: ?uitvoeren=ja&koppelen=<K>&aanmaken=<A> — beide getallen moeten
// exact overeenkomen met wat de droogloop gaf.

import { draaiLmsBackfill } from '../_lib/onboarding-lms-backfill.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { status, result } = await draaiLmsBackfill({
    uitvoeren:      String(req.query?.uitvoeren || '') === 'ja',
    bevestigKoppel: Number(req.query?.koppelen),
    bevestigMaak:   Number(req.query?.aanmaken),
    door:           'cron',
  });
  return res.status(status).json(result);
}
