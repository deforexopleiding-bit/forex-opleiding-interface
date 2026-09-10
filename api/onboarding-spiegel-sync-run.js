// api/onboarding-spiegel-sync-run.js
//
// DE KNOP — volledige hersync van de onboarding-spiegel, vanuit het CRM.
//
// WAAROM DEZE ER IS. De hersync zat alleen achter CRON_SECRET en draaide één
// keer per etmaal om 07:20. Dat betekende: zet je iets recht, dan is het pas
// de volgende ochtend te zien, en gaat er iets mis dan blijft de spiegel leeg
// zonder dat iemand kan nakijken waarom. Een koppeling die bestaat en een
// spiegel die zwijgt zien er van buiten hetzelfde uit.
//
// RECHTEN: `students.all.view` — dezelfde sleutel als het
// admin-studentenoverzicht en als de LMS-inhaalslag ernaast. Eén regel om te
// wijzigen als het anders moet.
//
// DROOGLOOP: { dry: true } telt wat er zou gebeuren en schrijft niets.
//
// DE FOUTEN KOMEN MEE. `result.errors` draagt de letterlijke melding per
// onboarding. Dat is het verschil tussen "de spiegel is leeg" en "de spiegel
// is leeg omdat <reden>", en precies waarom deze knop bestaat.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { draaiSpiegelSync } from './_lib/onboarding-spiegel-sync.js';

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
  if (!(await requirePermission(req, 'students.all.view'))) {
    return res.status(403).json({ error: 'Geen rechten (students.all.view)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const { status, result } = await draaiSpiegelSync({
    dry : body.dry === true,
    door: String(user.email || user.id || 'onbekend'),
  });
  return res.status(status).json(result);
}
