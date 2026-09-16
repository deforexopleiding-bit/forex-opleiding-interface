// api/factuurstand-spiegel-sync-run.js
//
// DE KNOP — de factuurstand-spiegel doorrekenen vanuit het CRM.
//
// TWEE STANDEN, EN DE DROOGLOOP IS DE BELANGRIJKSTE. `{ dry: true }` telt
// alles door en schrijft niets: hoeveel studenten er op 'gelezen',
// 'niet_gekoppeld' en 'onbereikbaar' komen, hoeveel er 1 en hoeveel er 2 of
// meer vervallen facturen hebben, via welke weg ze gekoppeld zijn, plus een
// lijstje voorbeelden. Dat is de uitkomst waar de eerste echte schrijfronde
// van afhangt — het LMS gaat op die getallen gedrag baseren, en dan kijkt er
// eerst een mens naar.
//
// RECHTEN: `students.all.view` — dezelfde sleutel als het
// admin-studentenoverzicht en als de twee LMS-knoppen ernaast. Eén regel om
// te wijzigen als het anders moet.
//
// ER GAAT HIER NIETS DE DEUR UIT. Geen bericht naar een klant, geen
// wijziging aan een factuur, geen wijziging aan de wanbetalersmotor. Deze
// knop leest het CRM en schrijft hooguit naar één LMS-tabel.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { draaiFactuurstandSync } from './_lib/factuurstand-sync.js';

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

  const { status, result } = await draaiFactuurstandSync({
    dry : body.dry === true,
    door: String(user.email || user.id || 'onbekend'),
  });
  return res.status(status).json(result);
}
