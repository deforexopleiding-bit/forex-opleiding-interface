// api/admin/historical-event-save.js
// POST → maak met terugwerkende kracht een historisch event aan + koppel
// mentoren, kosten en aanwezigen (via deals). SUPER_ADMIN only.
//
// Body: {
//   title:      string,
//   starts_at:  ISO date/datetime,
//   location?:  string,
//   mentor_team_member_ids:  uuid[] (aanwezige mentoren; was_present=true),
//   expenses:   [{ amount, vendor?, spent_at?(YYYY-MM-DD), note?,
//                  mentor_team_member_ids?: uuid[] }],
//   deal_ids:   uuid[] (gekoppelde deals → één attendee per deal, status='aanwezig'),
// }
//
// Insert-volgorde (best-effort atomisch — we ruimen niets terug bij fout,
// omdat Postgres via supabase-js geen echte multi-table transactie geeft;
// wel loggen we zichtbaar wat gelukt is en wat niet):
//   1. events (status='afgerond', is_historical=true zo mogelijk)
//   2. event_mentors (was_present=true per team_member_id)
//   3. event_expenses
//   4. event_attendees (customer + deal + status='aanwezig' + attended_at)
//
// GEEN bonus/ledger-mutatie hier (dat komt in 2b-2 via events-complete).
//
// Response 200: { event_id, event, mentors, expenses, attendees, warnings }

import { verifyAdmin, supabaseAdmin } from '../supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDate  = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function isValidIso(s) {
  if (typeof s !== 'string' || !s) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const title      = typeof body.title === 'string' ? body.title.trim() : '';
  const startsAt   = typeof body.starts_at === 'string' ? body.starts_at.trim() : '';
  const location   = typeof body.location === 'string' ? body.location.trim() : null;
  const mentorIds  = Array.isArray(body.mentor_team_member_ids) ? body.mentor_team_member_ids : [];
  const expenses   = Array.isArray(body.expenses) ? body.expenses : [];
  const dealIds    = Array.isArray(body.deal_ids) ? body.deal_ids : [];

  if (!title)              return res.status(400).json({ error: 'title vereist' });
  if (!isValidIso(startsAt)) return res.status(400).json({ error: 'starts_at moet een geldige ISO-datum zijn' });
  for (const m of mentorIds) if (!UUID_RE.test(String(m || ''))) return res.status(400).json({ error: 'mentor_team_member_ids: uuid verwacht' });
  for (const d of dealIds)   if (!UUID_RE.test(String(d || ''))) return res.status(400).json({ error: 'deal_ids: uuid verwacht' });
  for (const e of expenses) {
    const amt = Number(e?.amount);
    if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'expense.amount moet >= 0 zijn' });
    if (e.spent_at && !isDate(e.spent_at)) return res.status(400).json({ error: 'expense.spent_at moet YYYY-MM-DD zijn' });
    if (e.mentor_team_member_ids != null && !Array.isArray(e.mentor_team_member_ids)) {
      return res.status(400).json({ error: 'expense.mentor_team_member_ids moet array zijn' });
    }
    for (const tm of (e.mentor_team_member_ids || [])) {
      if (!UUID_RE.test(String(tm || ''))) return res.status(400).json({ error: 'expense.mentor_team_member_ids: uuid verwacht' });
    }
  }

  const warnings = [];

  try {
    // ── 1. events-rij ────────────────────────────────────────────────────
    // Vul de NOT-NULL-kolommen die de reguliere events-flow óók zet:
    //   - capacity: DB is NOT NULL. Historisch event heeft geen inschrijf-
    //     capaciteit maar 1 is >0 safe voor eventuele CHECK-constraint.
    //   - signups_closed: historisch = dicht (fail-soft; retry zonder als de
    //     kolom niet bestaat).
    //   - is_historical: markeer indien de kolom bestaat (fail-soft).
    //   - status='afgerond' + created_by_user_id blijven zoals eerder.
    const baseEventRow = {
      title,
      starts_at:          startsAt,
      ends_at:            null,
      location:           location || null,
      capacity:           1,
      status:             'afgerond',
      created_by_user_id: admin.user.id,
    };
    // Kandidaat-vlaggen: proberen eerst mét, bij column-error retry zonder.
    const optionalFlags = { is_historical: true, signups_closed: true };
    let eventId = null;
    let eventRow = null;
    {
      // Poging 1: alle optionele vlaggen erbij.
      let attempt = { ...baseEventRow, ...optionalFlags };
      // Retry-loop: bij kolom-not-found strippen we die kolom en proberen opnieuw.
      const maxRetries = Object.keys(optionalFlags).length + 1;
      let lastErr = null;
      for (let i = 0; i < maxRetries; i++) {
        const { data, error } = await supabaseAdmin.from('events')
          .insert(attempt)
          .select('id, title, starts_at, location, status, capacity, created_at')
          .single();
        if (!error) { eventRow = data; eventId = data.id; break; }
        lastErr = error;
        // Match "column ... of relation events" / 42703 undefined_column.
        const em = String(error.message || '');
        const colMatch = em.match(/column "?([a-zA-Z_]+)"?/);
        if (error.code === '42703' && colMatch && attempt[colMatch[1]] !== undefined && baseEventRow[colMatch[1]] === undefined) {
          const drop = colMatch[1];
          warnings.push(`events.${drop} kolom ontbreekt — event opgeslagen zonder die markering`);
          delete attempt[drop];
          continue;
        }
        break; // andere fout → gooi hieronder.
      }
      if (!eventId) throw new Error('event insert: ' + (lastErr?.message || 'onbekend'));
    }

    // ── 2. event_mentors (was_present=true per team_member_id) ────────────
    let mentorsInserted = [];
    if (mentorIds.length) {
      // Filter op unieke ID's (idempotent) en check dat ze bestaan/is_active.
      const uniq = [...new Set(mentorIds)];
      const { data: tms } = await supabaseAdmin.from('team_members')
        .select('id, name, is_active').in('id', uniq);
      const validIds = (tms || []).filter((t) => t.is_active !== false).map((t) => t.id);
      const skipped  = uniq.filter((id) => !validIds.includes(id));
      if (skipped.length) warnings.push(`Overgeslagen mentor-ids (niet gevonden/inactief): ${skipped.join(', ')}`);
      if (validIds.length) {
        const rows = validIds.map((tm) => ({
          event_id:       eventId,
          team_member_id: tm,
          was_present:    true,
        }));
        const { data: mData, error: mErr } = await supabaseAdmin.from('event_mentors')
          .insert(rows).select('id, team_member_id, was_present');
        if (mErr) warnings.push('event_mentors insert: ' + mErr.message);
        else      mentorsInserted = mData || [];
      }
    }

    // ── 3. event_expenses ────────────────────────────────────────────────
    let expensesInserted = [];
    if (expenses.length) {
      const rows = expenses
        .filter((e) => Number(e.amount) > 0)
        .map((e) => ({
          event_id:               eventId,
          amount:                 Math.round(Number(e.amount) * 100) / 100,
          vendor:                 e.vendor ? String(e.vendor).slice(0, 255) : null,
          spent_at:               e.spent_at || null,
          note:                   e.note ? String(e.note).slice(0, 1000) : null,
          mentor_team_member_ids: Array.isArray(e.mentor_team_member_ids) && e.mentor_team_member_ids.length > 0
                                    ? e.mentor_team_member_ids : null,
          created_by:             admin.user.id,
        }));
      if (rows.length) {
        const { data: exData, error: exErr } = await supabaseAdmin.from('event_expenses')
          .insert(rows).select('id, amount, vendor, spent_at');
        if (exErr) warnings.push('event_expenses insert: ' + exErr.message);
        else       expensesInserted = exData || [];
      }
    }

    // ── 4. event_attendees per gekoppelde deal ───────────────────────────
    let attendeesInserted = [];
    if (dealIds.length) {
      const uniqDeals = [...new Set(dealIds)];
      // Fetch deal → customer om naam/email in te vullen.
      const { data: deals } = await supabaseAdmin.from('deals')
        .select('id, customer_id').in('id', uniqDeals);
      const custIds = [...new Set((deals || []).map((d) => d.customer_id).filter(Boolean))];
      const custMap = new Map();
      if (custIds.length) {
        const { data: cs } = await supabaseAdmin.from('customers')
          .select('id, first_name, last_name, email, phone, is_company, company_name')
          .in('id', custIds);
        for (const c of (cs || [])) custMap.set(c.id, c);
      }
      const attRows = [];
      for (const deal of (deals || [])) {
        const c = deal.customer_id ? custMap.get(deal.customer_id) : null;
        const fn = c?.first_name || (c?.is_company ? (c.company_name || '(bedrijf)') : '');
        const ln = c?.last_name || '';
        attRows.push({
          event_id:           eventId,
          first_name:         fn || '',
          last_name:          ln || '',
          email:              c?.email || null,
          phone:              c?.phone || null,
          status:             'aanwezig',
          attended_at:        startsAt,
          customer_id:        deal.customer_id || null,
          deal_id:            deal.id,
          created_by_user_id: admin.user.id,
          automation_enabled: false,
        });
      }
      if (attRows.length) {
        const { data: attData, error: attErr } = await supabaseAdmin.from('event_attendees')
          .insert(attRows).select('id, event_id, deal_id, customer_id, status, attended_at');
        if (attErr) warnings.push('event_attendees insert: ' + attErr.message);
        else        attendeesInserted = attData || [];
      }
      // Deals waarvoor we niks konden inserten (bv. deal niet gevonden).
      const gotIds = new Set(attendeesInserted.map((a) => a.deal_id));
      const missed = uniqDeals.filter((id) => !gotIds.has(id));
      if (missed.length) warnings.push(`Deals zonder attendee (niet gevonden of insert-fout): ${missed.length}`);
    }

    return res.status(200).json({
      ok:        true,
      event_id:  eventId,
      event:     eventRow,
      mentors:   mentorsInserted,
      expenses:  expensesInserted,
      attendees: attendeesInserted,
      warnings,
    });
  } catch (e) {
    console.error('[admin/historical-event-save]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout', warnings });
  }
}
