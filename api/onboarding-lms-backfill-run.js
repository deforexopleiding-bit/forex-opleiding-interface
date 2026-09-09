// api/onboarding-lms-backfill-run.js
//
// DE KNOP. De LMS-inhaalslag vanuit het CRM, voor een ingelogde admin.
//
// ── WAAROM DIT NAAST HET CRON-PAD BESTAAT ────────────────────────────────
// De inhaalslag zat alleen achter `CRON_SECRET`. Dat betekent dat iemand met
// een sleutel een commando moet typen, en zo werkt het hier niet: Maxim werkt
// met knoppen. Een geheim in een terminal is precies de plek waar het
// misgaat. Het cron-pad blijft bestaan voor later; dit is wat we gebruiken.
//
// De logica staat in `api/_lib/onboarding-lms-backfill.js` en is dezelfde
// die het cron-pad draait. Er is geen tweede implementatie.
//
// ── RECHTEN ──────────────────────────────────────────────────────────────
// `students.all.view` — dezelfde sleutel als het admin-studentenoverzicht en
// het afhandelen van signalen. Per migratie 016 is dat manager + super_admin;
// sales, mentor, marketing en administratie krijgen 'm uitdrukkelijk NIET.
// Dat is de bedoeling: deze knop maakt studentrijen aan voor twintig echte
// klanten. `onboarding.admin` zou ruimer zijn geweest (ook sales), en dat is
// voor een knop met dit bereik te ruim.
//
// ── DROOGLOOP EERST, ALTIJD ──────────────────────────────────────────────
// POST zonder `uitvoeren` = droogloop: hij rekent uit wie er gekoppeld en wie
// er aangemaakt zou worden, schrijft niets, en geeft de volledige lijst terug.
// Uitvoeren vereist `uitvoeren: true` PLUS de twee getallen uit die droogloop.
// Kloppen die niet exact, dan 409 en er gebeurt niets. Er is dus geen weg
// waarlangs uitgevoerd wordt zonder dat de droogloop eerst is uitgerekend —
// ook niet met een handmatig samengesteld verzoek.
//
// ── IDEMPOTENT ───────────────────────────────────────────────────────────
// Twee keer drukken verandert niets extra: na de eerste ronde heeft elke
// verwerkte onboarding een `dfo_lms_student_id` en valt hij uit de
// kandidaten-selectie. De tweede droogloop toont 0 en 0, en uitvoeren met 0
// en 0 doet niets.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { draaiLmsBackfill } from './_lib/onboarding-lms-backfill.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // 1. Auth + gate — zelfde patroon als de andere adminschermen.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'students.all.view'))) {
    return res.status(403).json({ error: 'Geen rechten (students.all.view)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  // Wie drukte er? Belandt in elke logregel, zodat achteraf terug te lezen is
  // wie deze twintig klanten heeft aangeraakt.
  let door = user.id;
  try {
    const { data: prof } = await supabaseAdmin
      .from('profiles').select('email').eq('id', user.id).maybeSingle();
    if (prof?.email) door = prof.email;
  } catch (e) { /* de naam is sier; de uitvoering hangt er niet van af */ }

  const { status, result } = await draaiLmsBackfill({
    uitvoeren:      body.uitvoeren === true,
    bevestigKoppel: Number(body.koppelen),
    bevestigMaak:   Number(body.aanmaken),
    door,
  });
  return res.status(status).json(result);
}
