// api/admin/historical-event-delete.js
//
// POST — Verwijder een HISTORISCH event volledig (SUPER_ADMIN). Óók ná
// boeken: bonus/kosten ledger-entries voor dat event worden teruggedraaid.
//
// GUARD: alleen events met is_historical=true mogen via dit endpoint weg.
// Reguliere events blijven via hun eigen (soft-)delete lopen — dit
// endpoint mag ze nooit raken.
//
// Body: { event_id: uuid, confirm: true }
// Response 200: { deleted:true, event_id, ledger_entries_removed,
//                 warnings, summary: {
//                   attendees, mentors, expenses, followups,
//                   ledger_children, ledger_parents, ledger_uitbetaald } }
// Response 400: is_historical=false, confirm ontbreekt, ongeldige input
// Response 403: geen super_admin
// Response 404: event niet gevonden
// Response 500: DB-fout (gedeeltelijke rollback niet mogelijk via
//               supabase-js; wat weg is, is weg. Endpoint doet children
//               vóór parents zodat FK's niet knappen.)
//
// Beveiliging: verifyAdmin + super_admin gate.

import { verifyAdmin, supabaseAdmin } from '../supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : '';
  if (!eventId || !UUID_RE.test(eventId)) return res.status(400).json({ error: 'event_id (uuid) vereist' });
  if (body.confirm !== true) return res.status(400).json({ error: 'confirm=true vereist' });

  const warnings = [];
  const summary = {
    attendees        : 0,
    mentors          : 0,
    expenses         : 0,
    followups        : 0,
    ledger_children  : 0,
    ledger_parents   : 0,
    ledger_uitbetaald: 0,
    extras           : {},
  };

  try {
    // ── 1. Guard: laad event + eis is_historical=true ────────────────────
    const { data: ev, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, is_historical, title, status')
      .eq('id', eventId)
      .maybeSingle();
    if (evErr) {
      // 42703 = kolom bestaat niet — dan is de tool sowieso niet aan de orde.
      if (evErr.code === '42703') {
        return res.status(400).json({ error: 'is_historical-kolom ontbreekt — endpoint niet bruikbaar in dit schema' });
      }
      throw new Error('event fetch: ' + evErr.message);
    }
    if (!ev) return res.status(404).json({ error: 'Event niet gevonden' });
    if (ev.is_historical !== true) {
      return res.status(400).json({
        error: 'Weigering — dit endpoint mag alleen historische events verwijderen (is_historical=true).',
      });
    }

    // ── 2. Ledger-reversal: mentor_ledger_entries voor dit event ─────────
    //    Volgorde: eerst rijen met parent_entry_id IS NOT NULL (release-
    //    childs / settle-childs), dan de parents. Anders knapt de zelf-FK
    //    parent_entry_id → id.
    //
    //    Warning bij reeds-afgerekende entries (status='uitbetaald').
    {
      const { count: paidCount, error: paidErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .eq('status', 'uitbetaald');
      if (paidErr) {
        warnings.push('ledger paid-count: ' + paidErr.message);
      } else {
        summary.ledger_uitbetaald = paidCount || 0;
        if (paidCount && paidCount > 0) {
          warnings.push(`${paidCount} reeds afgerekende bonus-entries verwijderd (status='uitbetaald')`);
        }
      }
    }
    // 2a) Children eerst.
    {
      const { data: kids, error: kErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .delete()
        .eq('event_id', eventId)
        .not('parent_entry_id', 'is', null)
        .select('id');
      if (kErr) throw new Error('ledger children delete: ' + kErr.message);
      summary.ledger_children = (kids || []).length;
    }
    // 2b) Parents (en overige rijen zonder parent_entry_id) daarna.
    {
      const { data: parents, error: pErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .delete()
        .eq('event_id', eventId)
        .select('id');
      if (pErr) throw new Error('ledger parents delete: ' + pErr.message);
      summary.ledger_parents = (parents || []).length;
    }

    // ── 3. Attendee-afhankelijke tabellen (best-effort per tabel) ───────
    //    Verzamel eerst attendee_ids zodat we per-attendee-log-tabellen
    //    kunnen opruimen zonder ON DELETE CASCADE aan te nemen.
    let attendeeIds = [];
    {
      const { data: atts, error: aErr } = await supabaseAdmin
        .from('event_attendees')
        .select('id')
        .eq('event_id', eventId);
      if (aErr) throw new Error('attendees fetch: ' + aErr.message);
      attendeeIds = (atts || []).map((r) => r.id);
    }
    if (attendeeIds.length) {
      const attendeeChildTables = [
        'event_attendee_audit_log',
        'event_attendee_comms_log',
        'event_attendee_tags',
      ];
      for (const tbl of attendeeChildTables) {
        try {
          const { error: dErr } = await supabaseAdmin
            .from(tbl).delete().in('attendee_id', attendeeIds);
          if (dErr && dErr.code !== '42P01') {
            warnings.push(`${tbl} cleanup: ${dErr.message}`);
          }
        } catch (e) {
          warnings.push(`${tbl} cleanup: ${e?.message || 'unknown'}`);
        }
      }
    }

    // ── 4. Best-effort cleanup van event-scope tabellen ──────────────────
    //    42P01 (tabel bestaat niet in dit schema) wordt genegeerd — de tool
    //    ondersteunt meerdere schema-versies.
    const eventScopeTables = [
      'event_followups',
      'event_expenses',
      'event_mentors',
      'event_attendees',
      // Automations + logs (kunnen leeg zijn voor historisch event).
      'event_automation_run_log',
      'event_automation_runs',
      'event_automations',
      'event_choice_lookup_log',
      'event_mail_attachments',
      'event_niveau_options',
      'event_signup_inbox',
      'event_sync_log',
    ];
    for (const tbl of eventScopeTables) {
      try {
        const { data: rows, error: dErr } = await supabaseAdmin
          .from(tbl).delete().eq('event_id', eventId).select('event_id');
        if (dErr) {
          if (dErr.code === '42P01') continue; // tabel bestaat niet
          if (dErr.code === '42703') continue; // event_id-kolom ontbreekt (onwaarschijnlijk)
          warnings.push(`${tbl} delete: ${dErr.message}`);
          continue;
        }
        const n = (rows || []).length;
        if (tbl === 'event_attendees') summary.attendees = n;
        else if (tbl === 'event_mentors')  summary.mentors   = n;
        else if (tbl === 'event_expenses') summary.expenses  = n;
        else if (tbl === 'event_followups') summary.followups = n;
        else if (n > 0) summary.extras[tbl] = n;
      } catch (e) {
        warnings.push(`${tbl} delete: ${e?.message || 'unknown'}`);
      }
    }

    // ── 5. Events-rij zelf ───────────────────────────────────────────────
    {
      const { error: eDelErr } = await supabaseAdmin
        .from('events').delete().eq('id', eventId).eq('is_historical', true);
      if (eDelErr) throw new Error('events delete: ' + eDelErr.message);
    }

    return res.status(200).json({
      deleted               : true,
      event_id              : eventId,
      event_title           : ev.title || null,
      ledger_entries_removed: summary.ledger_children + summary.ledger_parents,
      warnings,
      summary,
    });
  } catch (e) {
    console.error('[admin/historical-event-delete]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout', warnings, summary });
  }
}
