// api/public-opstartsessie-submit.js
//
// Publieke SUBMIT-endpoint voor de Opstartsessie-pagina op deforexopleiding.nl.
// Vastleggen — nog geen boeking. Server-to-server via x-internal-token ==
// OPSTARTSESSIE_SECRET (least privilege; dfo-website's proxy roept aan).
//
// Wanneer aanroepen:
//   Direct nadat de lead de vragenlijst heeft ingevuld en het resultaat
//   ('toegelaten' of 'afgewezen') vaststaat. ÓÓK bij afgewezen leads —
//   die zien alleen de neutrale afsluiting, maar de submission wordt hier
//   wél geregistreerd zodat Jeffrey ze in de Opstartsessies-tab ziet.
//
// Doet:
//   INSERT één rij in public.opstartsessie_submissions. Puur vastleggen —
//   geen upsert_lead, geen GHL-call, geen appointment. Als de lead daarna
//   akkoord gaat + boekt, wordt de submission-rij door
//   /api/public-opstartsessie-book gemuteerd (noshow_akkoord=true +
//   appointment_id + lead_id).
//
// Auth:
//   x-internal-token == OPSTARTSESSIE_SECRET (verplicht)
//
// Body:
//   booking_source   string  optional — slug uit /opstartsessie/<slug>;
//                                        default 'direct'; onbekende slugs OK
//   naam             string  optional (1..200) — leesbaar voor Jeffrey
//   email            string  optional — mag leeg zijn bij afgewezen leads
//                                        die geen gegevens invulden
//   telefoon         string  optional
//   gekozen_slot     string  optional — leesbaar ('ma 31 aug om 14:00')
//   gekozen_start_at ISO8601 optional — ISO-timestamp als de proxy 'em heeft
//   antwoorden       array   required — [{ vraag, gekozen_label, punten, afwijzer }]
//   score            int     required — som(punten) op moment van submit
//   drempel          int     required — website_quizzes.drempel snapshot
//   resultaat        enum    required — 'toegelaten' | 'afgewezen'
//
// Response:
//   200 { ok:true, submission_id }
//   400 { error }
//   401 { error }
//   503 { error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' }
//
// 0 incasso-writes. Alleen INSERT op opstartsessie_submissions.

import { supabaseAdmin } from './supabase.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESULTAAT_OK = new Set(['toegelaten', 'afgewezen']);

function schoon(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth
  const tokenHeader = req.headers['x-internal-token'] || null;
  const verwacht    = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if (!tokenHeader || tokenHeader !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  // Verplichte velden.
  const resultaat = String(body.resultaat || '').trim().toLowerCase();
  if (!RESULTAAT_OK.has(resultaat)) {
    return res.status(400).json({ error: "resultaat moet 'toegelaten' of 'afgewezen' zijn" });
  }
  const antwoorden = Array.isArray(body.antwoorden) ? body.antwoorden : null;
  if (!antwoorden) return res.status(400).json({ error: 'antwoorden vereist (array)' });

  // Normaliseer antwoorden: houd alleen bekende velden, cap strings.
  const cleanAntwoorden = antwoorden.slice(0, 100).map((a) => ({
    vraag         : schoon(a?.vraag, 500),
    gekozen_label : schoon(a?.gekozen_label, 500),
    punten        : Number.isFinite(Number(a?.punten))  ? Number(a.punten)  : 0,
    afwijzer      : a?.afwijzer === true,
  }));

  const score   = Number.isFinite(Number(body.score))   ? Math.max(0, Math.min(999, Number(body.score)))   : null;
  const drempel = Number.isFinite(Number(body.drempel)) ? Math.max(0, Math.min(999, Number(body.drempel))) : null;

  // Bron-slug (default 'direct').
  let bookingSource = schoon(body.booking_source, 64);
  if (bookingSource) bookingSource = bookingSource.toLowerCase();
  if (!bookingSource || !SLUG_RE.test(bookingSource)) bookingSource = 'direct';

  // Optionele contact-velden.
  const naam       = schoon(body.naam, 200);
  const email      = schoon(body.email, 200);
  const telefoon   = schoon(body.telefoon, 40);
  const gekozen    = schoon(body.gekozen_slot, 120);
  const startAtRaw = schoon(body.gekozen_start_at, 40);
  let startAt = null;
  if (startAtRaw) {
    const t = Date.parse(startAtRaw);
    if (Number.isFinite(t)) startAt = new Date(t).toISOString();
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('opstartsessie_submissions')
      .insert({
        booking_source   : bookingSource,
        naam, email, telefoon,
        gekozen_slot     : gekozen,
        gekozen_start_at : startAt,
        antwoorden       : cleanAntwoorden,
        score, drempel,
        resultaat,
        noshow_akkoord   : false,
      })
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data?.id) return res.status(500).json({ error: 'Insert gaf geen id' });
    return res.status(200).json({ ok: true, submission_id: data.id });
  } catch (e) {
    console.error('[public-opstartsessie-submit]', e?.message || e);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
