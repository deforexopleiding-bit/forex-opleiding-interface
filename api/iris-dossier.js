// api/iris-dossier.js
//
// De dossierkaart voor één persoon.
//
//   GET ?contact_id=<uuid>
//   GET ?gesprek_id=<uuid>    (zoekt het contact erbij)
//
// Recht: iris.view.
//
// De kaart komt altijd met een 200 terug, ook als er half niets gelezen kon
// worden. Per bron staat erbij of hij gelezen is. Zie de toelichting in
// _lib/iris/dossier.js: "geen open facturen" en "we konden de facturen niet
// zien" mogen er nooit hetzelfde uitzien.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { bouwDossier } from './_lib/iris/dossier.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Alleen GET' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.view'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.view)' });
  }

  const q = req.query || {};
  let contactId = String(q.contact_id || '').trim();
  const gesprekId = String(q.gesprek_id || '').trim();

  if (!contactId && !gesprekId) {
    return res.status(400).json({ error: 'contact_id of gesprek_id vereist' });
  }

  try {
    if (!contactId) {
      if (!UUID_RE.test(gesprekId)) return res.status(400).json({ error: 'gesprek_id moet een geldige uuid zijn' });
      const { data, error } = await supabaseAdmin
        .from('iris_gesprekken')
        .select('contact_id')
        .eq('id', gesprekId)
        .maybeSingle();
      if (error) throw new Error('gesprek: ' + error.message);
      if (!data) return res.status(404).json({ error: 'Gesprek niet gevonden' });
      if (!data.contact_id) {
        // Een gesprek zonder contact is geen fout — dat is precies het geval
        // waar iemand handmatig moet koppelen. De kaart komt leeg terug met
        // die boodschap erin, zodat het scherm iets te tonen heeft.
        return res.status(200).json({
          dossier: { contact: null, reden: 'dit gesprek hangt nog niet aan een persoon' },
        });
      }
      contactId = data.contact_id;
    }

    if (!UUID_RE.test(contactId)) return res.status(400).json({ error: 'contact_id moet een geldige uuid zijn' });

    const { data: contact, error: cFout } = await supabaseAdmin
      .from('iris_contacten')
      .select('id, customer_id, onboarding_id, hlms_student_id, emails, telefoons, koppelstatus, koppel_reden, weergavenaam')
      .eq('id', contactId)
      .maybeSingle();
    if (cFout) throw new Error('contact: ' + cFout.message);
    if (!contact) return res.status(404).json({ error: 'Contact niet gevonden' });

    const dossier = await bouwDossier(supabaseAdmin, contact, {
      lmsClient: getDfoLmsClient(),
    });

    return res.status(200).json({ dossier });
  } catch (e) {
    console.error('[iris-dossier]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
