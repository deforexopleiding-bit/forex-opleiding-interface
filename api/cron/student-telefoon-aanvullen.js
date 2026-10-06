// api/cron/student-telefoon-aanvullen.js
//
// CRON-INGANG voor het aanvullen van telefoonnummers bij alle LMS-studenten.
// Dun: auth, parameters, doorgeven. De logica staat in
// `api/_lib/student-telefoon-aanvullen.js` en wordt gedeeld met de knop in de
// Onboarding-hub (`api/student-telefoon-aanvullen-run.js`).
//
// Draait elke ochtend NA de spiegel-hersync (07:20), zodat studenten met een
// onboarding eerst via de spiegel hun nummer krijgen en deze ronde de rest
// doet. Een nieuw nummer in het CRM (klantkaart, WhatsApp, lead) komt zo
// binnen een dag in het LMS. Bestaande nummers blijven staan.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
// DROOGLOOP: ?dry=1 — dezelfde logica, nul schrijfacties.

import { draaiStudentTelefoonAanvullen } from '../_lib/student-telefoon-aanvullen.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { status, result } = await draaiStudentTelefoonAanvullen({
    dry : String(req.query?.dry || '') === '1',
    door: 'cron',
  });
  return res.status(status).json(result);
}
