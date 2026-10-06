// api/student-telefoon-aanvullen-run.js
//
// DE KNOP — telefoonnummers aanvullen voor ALLE LMS-studenten, vanuit de
// Onboarding-hub (Maxim, 6 oktober 2026).
//
// Waarom een knop naast de nachtelijke ronde: na de hersync stonden er 259
// van de 304 actieve studenten zonder nummer. Met de droogloop zie je eerst
// hoeveel er te koppelen en te vinden zijn, en uit welke bron, vóór er iets
// in het LMS verandert.
//
// RECHTEN: `students.all.view` — dezelfde sleutel als de hersync ernaast.
// DROOGLOOP: { dry: true } telt en schrijft niets.
// Alleen lege nummers worden gevuld; er gaat niets naar de student.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { draaiStudentTelefoonAanvullen } from './_lib/student-telefoon-aanvullen.js';

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
  const { status, result } = await draaiStudentTelefoonAanvullen({
    dry : body.dry === true,
    door: String(user.email || user.id || 'onbekend'),
  });
  return res.status(status).json(result);
}
