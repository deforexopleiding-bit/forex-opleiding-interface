// api/agenda-beschikbaarheid-telling-get.js
//
// Read-only: aantal geboekte calls per NL-dag op de gezamenlijke opstartsessie-
// agenda, voor een maand of een venster. Gebruikt EXACT de bestaande tel-
// definitie uit api/_lib/agenda-beschikbaarheid.js (telPerDag): follow_up_
// appointments, ghl_calendar_id = GHL_CALENDAR_ID, status NOT IN
// ('cancelled','verplaatst','verwijderd'), scheduled_at per NL-dag.
//
// De agenda-pagina (kalender) gebruikt dit voor "geboekt/max" + de 'vol'-kleur.
//
//   GET ?maand=YYYY-MM                         (hele kalendermaand)
//   GET ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (venster, max 62 dagen)
//   → 200 { ok:boolean, per_dag:{ 'YYYY-MM-DD': n }, window:{ van, tot } }
//
// ok=false signaleert dat de telling niet betrouwbaar is (bv. GHL_CALENDAR_ID
// ontbreekt) → de kalender toont dan geen tellers i.p.v. misleidende nullen.
// Fail-soft: nooit 500 op een leesprobleem; dan { ok:false, per_dag:{} }.
//
// Permission: leads.view.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { telPerDag } from './_lib/agenda-beschikbaarheid.js';
import { nlDayStart, nlDayEndExclusive } from './_lib/nl-period.js';

const MAAND_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAGEN = 62;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  // Venster bepalen: maand (voorkeur) of start/eind.
  const q = req.query || {};
  let first = null, last = null;
  if (typeof q.maand === 'string' && MAAND_RE.test(q.maand)) {
    const y = Number(q.maand.slice(0, 4));
    const m = Number(q.maand.slice(5, 7));
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); // laatste dag van maand m
    first = `${q.maand}-01`;
    last = `${q.maand}-${String(dim).padStart(2, '0')}`;
  } else if (typeof q.startDate === 'string' && DATE_RE.test(q.startDate)
          && typeof q.endDate === 'string' && DATE_RE.test(q.endDate)) {
    first = q.startDate; last = q.endDate;
    if (last < first) return res.status(400).json({ error: 'endDate vóór startDate' });
    // Venster afkappen op MAX_DAGEN (anti-spoof + querybegrenzing).
    const d0 = Date.UTC(+first.slice(0, 4), +first.slice(5, 7) - 1, +first.slice(8, 10));
    const d1 = Date.UTC(+last.slice(0, 4), +last.slice(5, 7) - 1, +last.slice(8, 10));
    if ((d1 - d0) / 86400000 > MAX_DAGEN) {
      const capped = new Date(d0 + MAX_DAGEN * 86400000);
      last = `${capped.getUTCFullYear()}-${String(capped.getUTCMonth() + 1).padStart(2, '0')}-${String(capped.getUTCDate()).padStart(2, '0')}`;
    }
  } else {
    return res.status(400).json({ error: 'maand (YYYY-MM) of startDate+endDate (YYYY-MM-DD) vereist' });
  }

  // NL-dag-grenzen (noon-UTC-ref → eenduidige NL-dag, respecteert DST).
  const startIso = nlDayStart(new Date(`${first}T12:00:00Z`)).toISOString();
  const endIso = nlDayEndExclusive(new Date(`${last}T12:00:00Z`)).toISOString();
  const calendarId = process.env.GHL_CALENDAR_ID || null;

  try {
    const map = await telPerDag({ startIso, endIso });
    const per_dag = {};
    for (const [d, n] of map) per_dag[d] = n;
    // ok=false als de agenda-id ontbreekt: dan is de telling leeg maar niet
    // betrouwbaar → de kalender hoort geen tellers te tonen.
    return res.status(200).json({ ok: !!calendarId, per_dag, window: { van: first, tot: last } });
  } catch (e) {
    console.warn('[agenda-beschikbaarheid-telling-get] (fail-soft):', e?.message || e);
    return res.status(200).json({ ok: false, per_dag: {}, window: { van: first, tot: last } });
  }
}
