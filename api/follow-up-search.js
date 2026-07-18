// api/follow-up-search.js
//
// GET ?q=<zoekterm>&limit=<int, default 20, max 50>
//
// Globale zoekbalk boven de follow-up-tabs. Zoekt in follow_up_leads EN
// follow_up_appointments op lead_name / lead_email / lead_phone (met digit-
// normalisatie zodat "06..." ook "+3161..." matcht). Retourneert gededupli-
// ceerde personen; klik-flow in de UI opent 'em in de werklijst-cockpit via
// het bestaande _pendingLeadOpen-handshake.
//
// RBAC: sales.tab.retentie OR sales.customer.view — identiek aan de andere
// follow-up-endpoints (leads-list, cockpit-agenda, afgeboekt, etc.).
//
// Read-only. Geen writes, geen TL-calls.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { stripToDigits, last9Digits } from './_lib/phone-normalize.js';

const MIN_Q_LEN = 2;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// PostgREST-veilige escape voor OR-string: `,` en `()` zijn special chars.
// Wildcards `%` en `_` blijven werken voor ILIKE.
function escapeForOr(s) {
  return String(s || '').replace(/[,()]/g, ' ');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const q = String(req.query.q || '').trim();
  if (q.length < MIN_Q_LEN) {
    return res.status(200).json({ q, results: [] });
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1,
    parseInt(req.query.limit, 10) || DEFAULT_LIMIT));

  // Bouw ILIKE-patroon voor naam/email + de digit-varianten voor telefoon.
  // Voor phone: als q genoeg digits heeft, matchen we op DE DIGITS zonder
  // opmaak-tekens. PostgREST heeft geen native "strip-then-ilike", dus we
  // gebruiken 2 varianten: exact digit-match (voor volledige nummers) en
  // last9-suffix-match (voor lokale varianten).
  const escLike = escapeForOr(q).replace(/'/g, '');
  const namePat = `%${escLike}%`;
  const emailPat = `%${escLike.toLowerCase()}%`;
  const qDigits = stripToDigits(q);
  const qLast9  = last9Digits(q);

  // OR-clause voor beide tabellen. Phone-varianten: %digits% zodat we ook
  // opmaak-tekens tolereren (bv. "0612 34 56 78" in DB matcht "0612345678"
  // in q). Als q té kort qua digits (<4), skippen we de phone-clause om
  // false positives te vermijden.
  const orParts = [
    `lead_name.ilike.${namePat}`,
    `lead_email.ilike.${emailPat}`,
  ];
  if (qDigits.length >= 4) {
    orParts.push(`lead_phone.ilike.%${qDigits}%`);
    if (qLast9) orParts.push(`lead_phone.ilike.%${qLast9}%`);
  }
  const orClause = orParts.join(',');

  try {
    // Parallel over leads + appointments.
    const leadsSel = 'id, lead_name, lead_email, lead_phone, lead_status, source, updated_at';
    const apptSel  = 'id, lead_name, lead_email, lead_phone, status, scheduled_at, updated_at';
    const [leadsRes, apptRes] = await Promise.all([
      supabaseAdmin.from('follow_up_leads').select(leadsSel).or(orClause).limit(limit),
      supabaseAdmin.from('follow_up_appointments').select(apptSel).or(orClause).limit(limit),
    ]);

    const leads = leadsRes.error ? [] : (leadsRes.data || []);
    const appts = apptRes.error  ? [] : (apptRes.data  || []);
    if (leadsRes.error) console.warn('[follow-up-search] leads:', leadsRes.error.message);
    if (apptRes.error)  console.warn('[follow-up-search] appts:', apptRes.error.message);

    // Normaliseer naar één shape voor de UI.
    const normLead = (l) => ({
      source:       'lead',
      id:           l.id,
      lead_name:    l.lead_name || '(zonder naam)',
      lead_email:   l.lead_email || null,
      lead_phone:   l.lead_phone || null,
      lead_status:  l.lead_status || null,
      lead_source:  l.source || null,
      status:       null,
      scheduled_at: null,
      updated_at:   l.updated_at || null,
    });
    const normAppt = (a) => ({
      source:       'appointment',
      id:           a.id,
      lead_name:    a.lead_name || '(zonder naam)',
      lead_email:   a.lead_email || null,
      lead_phone:   a.lead_phone || null,
      lead_status:  null,
      lead_source:  null,
      status:       a.status || null,
      scheduled_at: a.scheduled_at || null,
      updated_at:   a.updated_at || null,
    });

    const combined = [...leads.map(normLead), ...appts.map(normAppt)];

    // Dedupe op (email OR phone-last9): dezelfde persoon in beide tabellen
    // levert 1 rij op — LEAD wint (die is de bron-van-waarheid voor de
    // werklijst-cockpit; appointments zijn afgeleid). Als er alleen een
    // appointment is (zonder lead) → die blijft staan; UI opent 'em ook
    // via de handshake (leadObj re-injectie).
    const seen = new Map(); // key -> item
    const keyFor = (it) => {
      const em = String(it.lead_email || '').toLowerCase().trim();
      const l9 = last9Digits(it.lead_phone);
      if (em) return 'e:' + em;
      if (l9) return 'p:' + l9;
      return 't:' + it.source + ':' + it.id; // val terug op eigen id (geen dedupe)
    };
    for (const it of combined) {
      const k = keyFor(it);
      const prev = seen.get(k);
      if (!prev) {
        seen.set(k, it);
      } else if (prev.source === 'appointment' && it.source === 'lead') {
        // Vervang appointment-hit door lead-hit (lead is canonical bron).
        seen.set(k, it);
      }
      // Anders: eerste hit blijft.
    }
    let results = Array.from(seen.values());

    // Sorteer: exacte naam-match eerst, dan recentste updated_at desc.
    const qLower = q.toLowerCase();
    results.sort((a, b) => {
      const aExact = String(a.lead_name || '').toLowerCase() === qLower;
      const bExact = String(b.lead_name || '').toLowerCase() === qLower;
      if (aExact !== bExact) return aExact ? -1 : 1;
      const au = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bu = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return bu - au;
    });

    if (results.length > limit) results = results.slice(0, limit);

    return res.status(200).json({ q, results });
  } catch (e) {
    console.error('[follow-up-search]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
