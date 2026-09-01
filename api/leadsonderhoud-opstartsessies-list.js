// api/leadsonderhoud-opstartsessies-list.js
//
// GET  ?periode=week|maand|alles   (default 'alles')
//      ?resultaat=alle|toegelaten|afgewezen  (default 'alle')
//      ?bron=<slug>                           (optional; matched op booking_source)
//      ?limit=25                              (max 200)
//
// Returnt een gepagineerde lijst van opstartsessie_submissions voor de
// Leadsonderhoud → Opstartsessies-tab. Nieuwste eerst. Elke rij verrijkt
// met bron-label uit booking_sources (fallback = rauwe slug).
//
// Response:
//   {
//     items: [{
//       id, created_at, booking_source, bron_label,
//       naam, email, telefoon,
//       gekozen_slot, gekozen_start_at,
//       score, drempel, resultaat, noshow_akkoord,
//       heeft_afspraak, appointment_id, lead_id
//     }],
//     periode, resultaat, bron, total, bronnen: [{slug,label}]
//   }
//
// Auth: leads.view (spiegelt Bronnen-tab read).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getSetterScope, filterBySetterScope } from './_lib/setter-scope.js';

const PERIODES  = new Set(['week', 'maand', 'alles']);
const RESULTATEN = new Set(['alle', 'toegelaten', 'afgewezen']);

function periodeGrens(periode) {
  const now = Date.now();
  if (periode === 'week')  return new Date(now - 7  * 86400000).toISOString();
  if (periode === 'maand') return new Date(now - 30 * 86400000).toISOString();
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const q = req.query || {};
  const periode   = PERIODES.has(String(q.periode || 'alles').toLowerCase())
    ? String(q.periode).toLowerCase() : 'alles';
  const resultaat = RESULTATEN.has(String(q.resultaat || 'alle').toLowerCase())
    ? String(q.resultaat).toLowerCase() : 'alle';
  const bron      = typeof q.bron === 'string' && q.bron.trim()
    ? String(q.bron).trim().toLowerCase() : null;
  const limit     = Math.min(200, Math.max(1, Number(q.limit) || 25));
  const grens     = periodeGrens(periode);

  try {
    // 1) Bronnen (voor label-mapping + filter-dropdown).
    const { data: bronnen } = await supabaseAdmin
      .from('booking_sources').select('slug, label').order('slug');
    const labelBySlug = new Map((bronnen || []).map((b) => [b.slug, b.label]));

    // 2) Submissions.
    let qry = supabaseAdmin
      .from('opstartsessie_submissions')
      .select('id, created_at, booking_source, naam, email, telefoon, gekozen_slot, gekozen_start_at, score, drempel, resultaat, noshow_akkoord, appointment_id, lead_id', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(limit);
    if (grens)     qry = qry.gte('created_at', grens);
    if (resultaat !== 'alle') qry = qry.eq('resultaat', resultaat);
    if (bron)      qry = qry.eq('booking_source', bron);
    const { data: rows, error, count } = await qry;
    if (error) throw error;

    // BP2 setter-scope: appointmentsetter ziet alleen submissions die
    // matchen op haar boekingen (email/telefoon). Manager/admin: pass.
    // Fail-closed: lege scope → 0 items.
    const scope = await getSetterScope(user.id, supabaseAdmin);
    let filteredRows = rows || [];
    if (scope.isScoped) {
      filteredRows = filterBySetterScope(filteredRows, scope, { email: 'email', phone: 'telefoon' });
    }

    const items = (filteredRows || []).map((r) => ({
      id              : r.id,
      created_at      : r.created_at,
      booking_source  : r.booking_source,
      bron_label      : labelBySlug.get(r.booking_source) || r.booking_source || '—',
      naam            : r.naam,
      email           : r.email,
      telefoon        : r.telefoon,
      gekozen_slot    : r.gekozen_slot,
      gekozen_start_at: r.gekozen_start_at,
      score           : r.score,
      drempel         : r.drempel,
      resultaat       : r.resultaat,
      noshow_akkoord  : !!r.noshow_akkoord,
      heeft_afspraak  : !!r.appointment_id,
      appointment_id  : r.appointment_id,
      lead_id         : r.lead_id,
    }));

    return res.status(200).json({
      items,
      periode, resultaat, bron,
      total  : count || items.length,
      bronnen: (bronnen || []).map((b) => ({ slug: b.slug, label: b.label })),
    });
  } catch (e) {
    console.error('[leadsonderhoud-opstartsessies-list]', e?.message || e);
    return res.status(500).json({ error: 'Opstartsessies laden mislukt' });
  }
}
