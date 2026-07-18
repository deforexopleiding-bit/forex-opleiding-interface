// api/follow-up-search.js
//
// GET ?q=<zoekterm>&limit=<int, default 20, max 50>
//
// Globale zoekbalk boven de follow-up-tabs. Zoekt in VIER bronnen op
// lead_name / lead_email / lead_phone (met digit-normalisatie zodat "06..."
// ook "+3161..." matcht):
//   1. follow_up_leads          — bestaande leads (source lead)
//   2. follow_up_appointments   — Zoom-afspraken (source appointment)
//   3. event_attendees          — event-aanmeldingen (source event)
//   4. customers                — retentie-kandidaten / algemene klanten
//                                 (source retention)
//
// Elk resultaat krijgt een `source` + een `open_target` object dat de UI
// vertelt hoe de persoon in de werklijst-cockpit te openen:
//   - open_target.lead_id     — bestaande follow_up_lead (direct handshake)
//   - open_target.customer_id — retentie/event zonder lead (lazy-create
//                               via /api/sales-retention-to-followup of
//                               /api/event-followup-to-lead op klik)
//   - open_target.attendee_id — event_attendee zonder lead (idem)
//
// Dedupe over alle bronnen op (email OR phone-last9). Voorrang: lead >
// appointment > event > retention (lead is canonical bron voor cockpit).
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
    // Parallel over vier bronnen. Voor event_attendees en customers gebruiken
    // we een aparte OR-clause omdat de kolomnamen anders zijn (first_name/
    // last_name/email/phone i.p.v. lead_*). Phone-varianten gaan mee.
    const evOrParts = [
      `first_name.ilike.${namePat}`,
      `last_name.ilike.${namePat}`,
      `email.ilike.${emailPat}`,
    ];
    if (qDigits.length >= 4) {
      evOrParts.push(`phone.ilike.%${qDigits}%`);
      if (qLast9) evOrParts.push(`phone.ilike.%${qLast9}%`);
    }
    const evOrClause = evOrParts.join(',');

    // Customers-query: identieke OR + filter op niet-gearchiveerd zodat we
    // geen ballast in de zoek krijgen.
    const custOrParts = [
      `first_name.ilike.${namePat}`,
      `last_name.ilike.${namePat}`,
      `company_name.ilike.${namePat}`,
      `email.ilike.${emailPat}`,
    ];
    if (qDigits.length >= 4) {
      custOrParts.push(`phone.ilike.%${qDigits}%`);
      if (qLast9) custOrParts.push(`phone.ilike.%${qLast9}%`);
    }
    const custOrClause = custOrParts.join(',');

    const leadsSel = 'id, customer_id, lead_name, lead_email, lead_phone, lead_status, source, updated_at';
    const apptSel  = 'id, lead_name, lead_email, lead_phone, status, scheduled_at, updated_at';
    const evSel    = 'id, event_id, customer_id, first_name, last_name, email, phone';
    const custSel  = 'id, is_company, company_name, first_name, last_name, email, phone, updated_at';

    const [leadsRes, apptRes, evRes, custRes] = await Promise.all([
      supabaseAdmin.from('follow_up_leads').select(leadsSel).or(orClause).limit(limit),
      supabaseAdmin.from('follow_up_appointments').select(apptSel).or(orClause).limit(limit),
      supabaseAdmin.from('event_attendees').select(evSel).or(evOrClause).limit(limit),
      supabaseAdmin.from('customers').select(custSel)
        .or(custOrClause).is('archived_at', null).is('anonymized_at', null).limit(limit),
    ]);

    const leads = leadsRes.error ? [] : (leadsRes.data || []);
    const appts = apptRes.error  ? [] : (apptRes.data  || []);
    const evs   = evRes.error    ? [] : (evRes.data    || []);
    const custs = custRes.error  ? [] : (custRes.data  || []);
    if (leadsRes.error) console.warn('[follow-up-search] leads:', leadsRes.error.message);
    if (apptRes.error)  console.warn('[follow-up-search] appts:', apptRes.error.message);
    if (evRes.error)    console.warn('[follow-up-search] events:', evRes.error.message);
    if (custRes.error)  console.warn('[follow-up-search] custs:', custRes.error.message);

    // Helper: bouw display-naam uit first/last (event_attendees + customers).
    const _fullName = (a) => {
      const first = String(a.first_name || '').trim();
      const last  = String(a.last_name  || '').trim();
      const full = (first + ' ' + last).trim();
      return full || null;
    };

    // Normaliseer naar één shape voor de UI. open_target vertelt de client
    // hoe de persoon in de werklijst te openen:
    //   { lead_id } → directe handshake (lead bestaat al)
    //   { customer_id, kind:'retention'|'event' } → lazy-create-endpoint aanroepen
    //   { attendee_id, kind:'event' } → lazy-create-endpoint aanroepen
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
      open_target:  { lead_id: l.id, customer_id: l.customer_id || null },
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
      // Appointments hebben geen lead_id kolom; UI re-injecteert 'em als
      // synthetisch lead-object (bestaand #822-pattern).
      open_target:  { appointment_id: a.id, kind: 'appointment' },
    });
    const normEvent = (a) => ({
      source:       'event',
      id:           a.id,
      lead_name:    _fullName(a) || '(zonder naam)',
      lead_email:   a.email || null,
      lead_phone:   a.phone || null,
      lead_status:  null,
      lead_source:  null,
      status:       null,
      scheduled_at: null,
      updated_at:   null,
      // On-click: /api/event-followup-to-lead met attendee_id → lead_id
      // → handshake. Idempotent (already-check server-side).
      open_target:  { attendee_id: a.id, customer_id: a.customer_id || null, kind: 'event' },
    });
    const normCust = (c) => ({
      source:       'retention',
      id:           c.id,
      lead_name:    (c.is_company ? (c.company_name || '') : _fullName(c) || '').trim() || '(zonder naam)',
      lead_email:   c.email || null,
      lead_phone:   c.phone || null,
      lead_status:  null,
      lead_source:  null,
      status:       null,
      scheduled_at: null,
      updated_at:   c.updated_at || null,
      // On-click: /api/sales-retention-to-followup met customer_id → lead_id
      // → handshake. Idempotent (already-check server-side).
      open_target:  { customer_id: c.id, kind: 'retention' },
    });

    const combined = [
      ...leads.map(normLead),
      ...appts.map(normAppt),
      ...evs.map(normEvent),
      ...custs.map(normCust),
    ];

    // Dedupe op (email OR phone-last9): dezelfde persoon in meerdere bronnen
    // levert 1 rij op. Prioriteit: lead (2) > appointment (1) > event (0) >
    // retention (-1). Reden: lead is canonical bron voor de cockpit — die
    // hoef je niet meer lazy te creëren. Fallback-orde matcht ook wat de
    // user "moderner" verwacht (bel-event > algemene klant).
    const sourceRank = { lead: 3, appointment: 2, event: 1, retention: 0 };
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
        continue;
      }
      const prevRank = sourceRank[prev.source] ?? -2;
      const curRank  = sourceRank[it.source]   ?? -2;
      if (curRank > prevRank) {
        // Deze source is canonieker → vervang. Bewaar wel de customer_id
        // van de retention/event-hit in open_target voor traceability.
        seen.set(k, it);
      }
      // Anders: eerste (hogere-rank) hit blijft.
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
