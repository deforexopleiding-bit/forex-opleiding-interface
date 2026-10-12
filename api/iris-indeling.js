// api/iris-indeling.js
//
// DE INDELING VAN EEN GESPREK MET DE HAND RECHTZETTEN.
//
//   POST { gesprek_id, categorie }
//
// Recht: iris.post.beantwoorden. Dit verandert waar een gesprek terechtkomt,
// dus meekijken (iris.view) is niet genoeg — maar het stuurt niets naar een
// klant, dus iris.versturen is te zwaar.
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────────
// Sinds P-2 houdt cron-iris-werk spam buiten de werkbak. Dat is een oordeel
// van een taalmodel, en een taalmodel heeft het soms mis. Een echte klant die
// per ongeluk als reclame wordt weggezet en dan nergens meer opduikt, is
// erger dan de reclame die we ermee kwijtraken.
//
// Dus: één klik terug. En dat is meteen de plek waar zichtbaar wordt dat Iris
// het mis had — de correctie gaat naar iris_log, zodat er iets na te tellen
// valt over hoe vaak dat gebeurt.
//
// ── WAT DIT NIET DOET ────────────────────────────────────────────────────────
// Het bericht opnieuw laten beoordelen. `verwerkt_op` blijft staan, dus de
// cron pakt het niet op. Een mens die zegt dat het geen spam is, heeft daarmee
// het laatste woord; er nog een model overheen laten gaan zou dat woord
// kunnen terugdraaien.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bepaalIndeling } from './_lib/iris/indeling.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wat er in categorie_reden komt te staan als een mens het overneemt. */
export const REDEN_MET_DE_HAND = 'met de hand ingedeeld door een medewerker';

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
  if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
  }

  const gesprekId = String(req.body?.gesprek_id || '').trim();
  const categorie = String(req.body?.categorie || '').trim();
  if (!UUID_RE.test(gesprekId)) {
    return res.status(400).json({ error: 'gesprek_id ontbreekt of is geen uuid' });
  }

  try {
    const { data: gesprek, error: leesFout } = await supabaseAdmin
      .from('iris_gesprekken')
      .select('id, contact_id, kanaal, categorie, status')
      .eq('id', gesprekId)
      .maybeSingle();
    if (leesFout) throw new Error('gesprek lezen: ' + leesFout.message);
    if (!gesprek) return res.status(404).json({ error: 'Gesprek niet gevonden' });

    const besluit = bepaalIndeling(
      { huidigeCategorie: gesprek.categorie, huidigeStatus: gesprek.status },
      categorie,
    );
    if (!besluit.ok) return res.status(400).json({ error: besluit.reden });

    const { error: schrijfFout } = await supabaseAdmin
      .from('iris_gesprekken')
      .update({ ...besluit.velden, bijgewerkt_op: new Date().toISOString() })
      .eq('id', gesprekId);
    if (schrijfFout) throw new Error('gesprek bijwerken: ' + schrijfFout.message);

    // Ook het laatste inkomende bericht, want daar staat het oordeel van Iris.
    // Blijft dat op 'spam' staan, dan zegt de draad nog steeds iets anders dan
    // de kop erboven — en dan gelooft niemand meer wat er staat.
    //
    // Niet blokkerend: het gesprek is het belangrijkste, en dit mislukt hooguit
    // als er nog geen enkel inkomend bericht is.
    const { data: laatste } = await supabaseAdmin
      .from('iris_berichten')
      .select('id')
      .eq('gesprek_id', gesprekId)
      .eq('richting', 'in')
      .order('ontvangen_op', { ascending: false })
      .limit(1);
    const berichtId = laatste?.[0]?.id || null;
    if (berichtId) {
      const { error: bFout } = await supabaseAdmin
        .from('iris_berichten')
        .update({ categorie, categorie_reden: REDEN_MET_DE_HAND })
        .eq('id', berichtId);
      if (bFout) console.warn('[iris-indeling] bericht bijwerken mislukte:', bFout.message);
    }

    // PRIVACY: id's en categorieën, geen berichttekst en geen telefoonnummer.
    const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
      wie: user.id,
      wat: 'indeling met de hand gewijzigd',
      contact_id: gesprek.contact_id || null,
      gesprek_id: gesprekId,
      kanaal: gesprek.kanaal || null,
      resultaat: 'ok',
      details: {
        van: gesprek.categorie || null,
        naar: categorie,
        status_van: gesprek.status,
        status_naar: besluit.velden.status || gesprek.status,
      },
    });
    if (logFout) console.warn('[iris-indeling] logregel mislukt:', logFout.message);

    return res.status(200).json({
      ok: true,
      gesprek_id: gesprekId,
      categorie,
      status: besluit.velden.status || gesprek.status,
      veranderd: besluit.verandert,
    });
  } catch (e) {
    console.error('[iris-indeling]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Indeling wijzigen mislukt' });
  }
}
