// api/iris-log.js
//
// Het logboek: wie deed wat, en wanneer.
//
//   GET ?limiet=100&alleen_fouten=1&contact_id=…&sinds=…
//
// Recht: iris.view.
//
// ── WAT ER NIET IN STAAT ─────────────────────────────────────────────────────
// Geen volledige telefoonnummers en geen berichtteksten. Alleen id's,
// tellingen en korte omschrijvingen. Dat is een regel die de opvolgbrug al
// hanteert, en de reden is dat een logboek ergens anders bewaard en
// doorgezocht wordt dan de berichten zelf — dus is elke tekst die er stiekem
// in kruipt, een tweede plek waar hij kan lekken.
//
// Het endpoint dwingt dat hier nog een keer af, bij het uitlezen. Niet omdat
// de schrijvers het fout doen, maar omdat er in de toekomst een schrijver
// bijkomt die het niet weet.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Een telefoonnummer van zeven cijfers of langer, in welke opmaak dan ook. */
const NUMMER_RE = /(\+?\d[\d\s().-]{6,}\d)/g;

/**
 * Maak een tekst veilig om in het logboek te tonen.
 *
 * Laat de laatste vier cijfers staan. Die zijn genoeg om te herkennen welk
 * nummer het was als je het al weet, en te weinig om het te achterhalen als je
 * het niet weet.
 */
export function maskeer(tekst) {
  const s = String(tekst ?? '');
  if (!s) return s;
  return s.replace(NUMMER_RE, (m) => {
    const cijfers = m.replace(/\D/g, '');
    if (cijfers.length < 7) return m;
    return '…' + cijfers.slice(-4);
  });
}

/** Kort een omschrijving in. Een logregel is een regel, geen alinea. */
export function kortRegel(tekst, max = 200) {
  const s = maskeer(tekst);
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

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
  const limiet = Math.min(Math.max(parseInt(q.limiet, 10) || 100, 1), 500);
  const alleenFouten = String(q.alleen_fouten || '') === '1';
  const contactId = String(q.contact_id || '').trim();

  try {
    let vraag = supabaseAdmin
      .from('iris_log')
      .select('id, wanneer, wie, wat, contact_id, gesprek_id, kanaal, resultaat, fout, details')
      .order('wanneer', { ascending: false })
      .limit(limiet);

    if (alleenFouten) vraag = vraag.not('fout', 'is', null);
    if (contactId && UUID_RE.test(contactId)) vraag = vraag.eq('contact_id', contactId);
    if (q.sinds) vraag = vraag.gte('wanneer', String(q.sinds));

    const { data, error } = await vraag;
    if (error) throw new Error('logboek: ' + error.message);

    const items = (data || []).map((r) => ({
      id: r.id,
      wanneer: r.wanneer,
      wie: r.wie,              // uuid of null (= Iris zelf)
      wat: kortRegel(r.wat),
      contact_id: r.contact_id,
      gesprek_id: r.gesprek_id,
      kanaal: r.kanaal,
      resultaat: r.resultaat,
      fout: r.fout ? kortRegel(r.fout, 300) : null,
      // De details gaan mee als TELLINGEN, niet als inhoud. Een jsonb-blob
      // die ooit een berichttekst bevat, komt zo het scherm niet op.
      details: veiligeDetails(r.details),
    }));

    return res.status(200).json({ items, limiet, alleen_fouten: alleenFouten });
  } catch (e) {
    console.error('[iris-log]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

/**
 * Laat alleen getallen, booleans en korte codes door uit de details.
 *
 * Alles wat langer is dan honderd tekens is geen telling maar inhoud, en die
 * hoort hier niet. Dat is strenger dan nodig voor wat er vandaag geschreven
 * wordt, en dat is met opzet: de schrijvers van morgen lezen deze regel niet.
 */
export function veiligeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const uit = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === 'number' || typeof v === 'boolean') { uit[k] = v; continue; }
    if (typeof v === 'string' && v.length <= 100) { uit[k] = maskeer(v); continue; }
    if (Array.isArray(v)) { uit[k] = `${v.length} item(s)`; continue; }
    if (v && typeof v === 'object') { uit[k] = '{…}'; continue; }
    // Alles wat overblijft (lange teksten) wordt vervangen door zijn lengte.
    if (typeof v === 'string') uit[k] = `${v.length} tekens`;
  }
  return Object.keys(uit).length ? uit : null;
}
