// api/iris-opvolging.js
//
// DE LOPENDE OPVOLGINGEN ZIEN EN STOPPEN.
//
//   GET                              → wat staat er te wachten?
//   POST { actie: 'afbreken', id }   → stop deze opvolging
//
// Recht: iris.view om te kijken, iris.post.beantwoorden om af te breken.
//
// ── WAAROM ER EEN LIJST MOET ZIJN ────────────────────────────────────────────
// Een opvolging die je niet kunt zien, is niet te onderscheiden van een
// opvolging die niet bestaat — en dat is precies waar O-2 over ging. "Iris
// houdt het in de gaten" is alleen geloofwaardig als je kunt nakijken wát ze
// in de gaten houdt en tot wanneer.
//
// Afbreken kan altijd. Een wacht die niet meer nodig is en toch afgaat, leert
// je de volgende melding te negeren.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** De standen die nog iets te doen hebben. */
export const LOPEND = Object.freeze(['kijkt', 'verlopen']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'iris.view'))) {
        return res.status(403).json({ error: 'Geen rechten (iris.view)' });
      }
      return await geefLijst(req, res);
    }
    if (req.method === 'POST') {
      if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
        return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
      }
      return await afbreken(req, res, user);
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Alleen GET en POST' });
  } catch (e) {
    console.error('[iris-opvolging]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

async function geefLijst(req, res) {
  const alles = String(req.query?.alles || '') === '1';

  let vraag = supabaseAdmin
    .from('iris_opvolgingen')
    .select('id, opdracht_id, gesprek_id, contact_id, waarop, omschrijving, sinds, tot, status, verwittig_email, gemeld_op, meld_fout, meld_pogingen, aangemaakt_op')
    .order('tot', { ascending: true })
    .limit(100);
  if (!alles) vraag = vraag.in('status', [...LOPEND]);

  const { data, error } = await vraag;
  if (error) {
    // Migratie nog niet gedraaid. Een lege lijst met uitleg is bruikbaarder
    // dan een rode foutmelding in een module die verder prima werkt.
    const tekst = String(error.message || '');
    if (/relation .*iris_opvolgingen.* does not exist/i.test(tekst) || error.code === '42P01') {
      return res.status(200).json({ items: [], nog_niet_gemigreerd: true });
    }
    throw new Error('opvolgingen: ' + tekst);
  }
  return res.status(200).json({ items: data || [], nog_niet_gemigreerd: false });
}

async function afbreken(req, res, user) {
  const id = String(req.body?.id || '').trim();
  if (String(req.body?.actie || 'afbreken') !== 'afbreken') {
    return res.status(400).json({ error: 'onbekende actie' });
  }
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  // Alleen wat nog loopt. Een al gemelde of al gesloten opvolging afbreken zou
  // de geschiedenis veranderen in plaats van het wachten te stoppen.
  const { data, error } = await supabaseAdmin
    .from('iris_opvolgingen')
    .update({ status: 'afgebroken', bijgewerkt_op: new Date().toISOString() })
    .eq('id', id)
    .in('status', [...LOPEND])
    .select('id, gesprek_id, contact_id, omschrijving');
  if (error) throw new Error('afbreken: ' + error.message);
  if (!data?.length) {
    return res.status(409).json({ error: 'Deze opvolging liep niet meer', code: 'NIET_LOPEND' });
  }

  const rij = data[0];
  const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
    wie: user.id,
    wat: 'opvolging afgebroken',
    gesprek_id: rij.gesprek_id || null,
    contact_id: rij.contact_id || null,
    resultaat: 'ok',
    details: { opvolging_id: rij.id },
  });
  if (logFout) console.warn('[iris-opvolging] logregel mislukt:', logFout.message);

  return res.status(200).json({ ok: true, id: rij.id });
}
