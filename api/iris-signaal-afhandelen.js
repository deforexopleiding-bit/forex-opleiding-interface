// api/iris-signaal-afhandelen.js
//
// Een mentorsignaal afvinken op de dossierkaart.
//
//   POST { signaal_id, afgehandeld?: boolean }   -> { signaal }
//
// Recht: iris.belrij.
//
// ── WAT DIT WEL EN NIET DOET ─────────────────────────────────────────────────
// Het zet `iris_signalen.verwerkt_op` in ONS systeem. Er gaat NIETS terug naar
// het LMS: `hlms_signaal` wordt niet aangeraakt, niet gelezen en niet
// geschreven. De mentor sluit zijn signaal in het LMS zelf af; dit is onze kant
// van het verhaal ("wij hebben ernaar gekeken"). Twee systemen die ieder hun
// eigen stand bijhouden is hier de bedoeling en geen gemis: het LMS is van de
// mentoren, dit is van ons.
//
// ── WAAROM HET TERUG KAN ─────────────────────────────────────────────────────
// Eén klik die een signaal van de kaart haalt en daarna niet meer terug kan, is
// een knop waar je bang voor wordt. Dus `afgehandeld: false` zet `verwerkt_op`
// weer op NULL. Dat is geen extra functie maar de voorwaarde om de knop
// zonder bevestigingsvraag te kunnen aanbieden.
//
// ── WAAROM GEEN NIEUW RECHT ──────────────────────────────────────────────────
// `iris.belrij` is "de belrij zien en afwerken", en een mentorsignaal afvinken
// is precies dat werk: taak 6 laat die signalen op de belrij belanden. Een
// zevende recht toevoegen zou een rechten-migratie plus een toekenning per rol
// kosten voor een knop die niemand anders hoeft te hebben. Moet het later toch
// apart: dan is dit de plek.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Alleen POST' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.belrij'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.belrij)' });
  }

  const id = String(req.body?.signaal_id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'signaal_id moet een geldige uuid zijn' });

  // Alles behalve een uitdrukkelijke `false` is afvinken. Een ontbrekend veld
  // betekent dus "afgehandeld", want dat is waar de knop voor is.
  const afgehandeld = req.body?.afgehandeld !== false;

  try {
    const { data, error } = await supabaseAdmin
      .from('iris_signalen')
      .update({ verwerkt_op: afgehandeld ? new Date().toISOString() : null })
      .eq('id', id)
      .select('id, contact_id, type, mentor_naam, toelichting, signaal_op, verwerkt_op')
      .maybeSingle();
    if (error) throw new Error('signaal bijwerken: ' + error.message);
    if (!data) return res.status(404).json({ error: 'Dit signaal bestaat niet' });

    // In het logboek: wie, wat en welk signaal. GEEN toelichting -- dat is
    // tekst van een mentor over een student, en het logboek bewaart geen
    // berichtteksten. Zie de kop van iris_log in de migratie.
    const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
      wie: user.id,
      wat: afgehandeld ? 'mentorsignaal afgehandeld' : 'mentorsignaal weer open gezet',
      contact_id: data.contact_id || null,
      resultaat: 'ok',
      details: { signaal_id: data.id, type: data.type || null },
    });
    if (logFout) console.warn('[iris-signaal-afhandelen] logregel mislukt:', logFout.message);

    return res.status(200).json({ signaal: data });
  } catch (e) {
    console.error('[iris-signaal-afhandelen]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
