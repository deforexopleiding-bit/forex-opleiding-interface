// api/follow-up-cockpit-agenda.js
//
// GET — chronologische samengevoegde agenda voor de cockpit-Afspraken-tab.
// Bron: follow_up_leads (bel-terugbelafspraken) + follow_up_appointments
// (GHL-Zoom-calls, alleen LEZEN — GHL blijft de bron). GHL-poll/webhook
// blijven ongemoeid. De klassieke Kalender-tab blijft naast deze view
// bestaan (additief).
//
// Query:
//   ?owner=me|all                 (default 'all')
//   ?kind=zoom|bel|all            (default 'all')
//   ?view=agenda|reschedule|afgehandeld  (default 'agenda')
//   ?limit=<n>                    (default 500, max 1000)
//
// Response ?view=agenda:
//   { items: [
//       // lead-terugbelitem:
//       { source:'lead', id, lead_name, lead_phone, lead_email, terugbel_datum,
//         lead_kind ('zoom'|'bel'), lead_status, owner_id, owner_name, is_hot },
//       // appointment (Zoom):
//       { source:'appointment', id, lead_name, lead_phone, lead_email,
//         terugbel_datum (=scheduled_at), kind:'zoom', status, owner_id,
//         owner_name, voicememo_status, zoom_join_url } ]
//   }
//
// Response ?view=reschedule:
//   { items: [ { source:'appointment', id, lead_name, lead_phone,
//       scheduled_at, terugbel_datum (=scheduled_at), status:'wacht_op_reschedule',
//       owner_id, owner_name } ] }
//
// 42P01/42703 → fail-soft (lege lijst; blokkeer de andere bron niet).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

async function fetchLeadRows({ owner, kind, limit, userId, nowIso }) {
  // ── follow_up_leads: bel-terugbelafspraken ─────────────────────────
  const RICH_COLS = 'id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id, is_hot, snoozed_until, lead_kind';
  const CORE_COLS = 'id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id';

  const build = (cols) => {
    let qq = supabaseAdmin.from('follow_up_leads')
      .select(cols)
      .not('terugbel_datum', 'is', null)
      .not('lead_status', 'in', '(verlengd,verloren)')
      .order('terugbel_datum', { ascending: true })
      .limit(limit);
    if (owner === 'me') qq = qq.eq('owner_id', userId);
    return qq;
  };

  let hasRich = true;
  let leadRows = [];
  {
    let qq = build(RICH_COLS)
      .or('snoozed_until.is.null,snoozed_until.lte.' + nowIso);
    if (kind === 'zoom') qq = qq.eq('lead_kind', 'zoom');
    else if (kind === 'bel') qq = qq.or('lead_kind.is.null,lead_kind.eq.call');
    const { data, error } = await qq;
    if (error && error.code === '42703') {
      hasRich = false;
      const { data: d2, error: e2 } = await build(CORE_COLS);
      if (e2) {
        if (e2.code === '42P01') return { leadRows: [], hasRich: false };
        throw new Error(e2.message);
      }
      leadRows = d2 || [];
    } else if (error) {
      if (error.code === '42P01') return { leadRows: [], hasRich: false };
      throw new Error(error.message);
    } else {
      leadRows = data || [];
    }
  }
  return { leadRows, hasRich };
}

async function fetchAppointmentRows({ owner, kind, statusList, limit, userId }) {
  // ── follow_up_appointments: GHL Zoom-calls ────────────────────────
  // We willen zoom_meeting_id + zoom_join_url meenemen — als 42703 op
  // die kolommen, val terug op basis-set. Kind-filter: 'bel' →
  // appointments zijn per definitie geen bel-lead, dus lege set.
  if (kind === 'bel') return [];

  const RICH_COLS = 'id, lead_name, lead_email, lead_phone, scheduled_at, status, voicememo_status, zoom_meeting_id, zoom_join_url, owner_id';
  const MID_COLS  = 'id, lead_name, lead_email, lead_phone, scheduled_at, status, voicememo_status, zoom_join_url, owner_id';
  const MIN_COLS  = 'id, lead_name, lead_email, lead_phone, scheduled_at, status, voicememo_status, owner_id';

  const build = (cols) => {
    let qq = supabaseAdmin.from('follow_up_appointments')
      .select(cols)
      .in('status', statusList)
      .not('scheduled_at', 'is', null)
      .order('scheduled_at', { ascending: true })
      .limit(limit);
    if (owner === 'me') qq = qq.eq('owner_id', userId);
    return qq;
  };

  const tryCols = async (cols) => {
    const { data, error } = await build(cols);
    if (error) {
      if (error.code === '42P01') return { rows: null, err: 'MISSING_TABLE' };
      if (error.code === '42703') return { rows: null, err: '42703' };
      throw new Error(error.message);
    }
    return { rows: data || [], err: null };
  };

  let r = await tryCols(RICH_COLS);
  if (r.err === '42703') r = await tryCols(MID_COLS);
  if (r.err === '42703') r = await tryCols(MIN_COLS);
  if (r.err === 'MISSING_TABLE' || r.err === '42703') return [];
  return r.rows || [];
}

async function lookupOwnerNames(ownerIds) {
  const map = {};
  if (!ownerIds.length) return map;
  const { data: profs } = await supabaseAdmin
    .from('profiles').select('id, full_name').in('id', ownerIds);
  for (const p of (profs || [])) map[p.id] = p.full_name;
  return map;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const q     = req.query || {};
  const owner = ['me', 'all'].includes(q.owner) ? q.owner : 'all';
  const kind  = ['zoom', 'bel', 'all'].includes(q.kind) ? q.kind : 'all';
  const view  = ['agenda', 'reschedule', 'afgehandeld'].includes(q.view) ? q.view : 'agenda';
  let limit   = Number(q.limit) || 500;
  limit = Math.max(1, Math.min(1000, Math.floor(limit)));

  try {
    const nowIso = new Date().toISOString();

    // ── ?view=reschedule ─────────────────────────────────────────────
    if (view === 'reschedule') {
      const rows = await fetchAppointmentRows({
        owner, kind: 'zoom', statusList: ['wacht_op_reschedule'], limit, userId: user.id,
      });
      const ownerIds = [...new Set(rows.map((r) => r.owner_id).filter(Boolean))];
      const nameById = await lookupOwnerNames(ownerIds);
      const items = rows.map((r) => ({
        source        : 'appointment',
        id            : r.id,
        lead_name     : r.lead_name,
        lead_phone    : r.lead_phone,
        lead_email    : r.lead_email,
        scheduled_at  : r.scheduled_at,
        terugbel_datum: r.scheduled_at,     // alias voor UI-consistentie
        kind          : 'zoom',
        lead_kind     : 'zoom',
        status        : r.status,
        owner_id      : r.owner_id,
        owner_name    : r.owner_id ? (nameById[r.owner_id] || null) : null,
      }));
      return res.status(200).json({ items });
    }

    // ── ?view=afgehandeld: recent afgehandelde appointments ─────────
    // (completed / cancelled / no_show, updated_at binnen de laatste 3
    // dagen) zodat de sales-user via de UI naar de detail kan om de
    // "↩ Uitkomst corrigeren"-strip te gebruiken. Alleen SELECT; GHL/
    // andere views ongemoeid. 42P01 → lege lijst (fail-soft).
    if (view === 'afgehandeld') {
      const threeDaysAgoIso = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
      const RICH_COLS = 'id, lead_name, lead_phone, lead_email, scheduled_at, status, updated_at, prev_state, ghl_appointment_id, zoom_join_url, owner_id';
      const MID_COLS  = 'id, lead_name, lead_phone, lead_email, scheduled_at, status, updated_at, ghl_appointment_id, zoom_join_url, owner_id';
      const MIN_COLS  = 'id, lead_name, lead_phone, lead_email, scheduled_at, status, updated_at, owner_id';

      const buildDone = (cols) => {
        let qq = supabaseAdmin.from('follow_up_appointments')
          .select(cols)
          .in('status', ['completed', 'cancelled', 'no_show'])
          .gte('updated_at', threeDaysAgoIso)
          .order('updated_at', { ascending: false })
          .limit(limit);
        if (owner === 'me') qq = qq.eq('owner_id', user.id);
        return qq;
      };
      const tryDone = async (cols) => {
        const { data, error } = await buildDone(cols);
        if (error) {
          if (error.code === '42P01') return { rows: null, err: 'MISSING_TABLE' };
          if (error.code === '42703') return { rows: null, err: '42703' };
          throw new Error(error.message);
        }
        return { rows: data || [], err: null };
      };

      let rr = await tryDone(RICH_COLS);
      if (rr.err === '42703') rr = await tryDone(MID_COLS);
      if (rr.err === '42703') rr = await tryDone(MIN_COLS);
      if (rr.err === 'MISSING_TABLE' || rr.err === '42703') {
        return res.status(200).json({ items: [] });
      }
      const rowsDone = rr.rows || [];

      const ownerIds = [...new Set(rowsDone.map((r) => r.owner_id).filter(Boolean))];
      const nameById = await lookupOwnerNames(ownerIds);

      // Outcome-verrijking: koppel per appointment de outcome-waarde
      // uit follow_up_outcomes. Zonder outcome → null. Fail-soft: als
      // de tabel ontbreekt of de query faalt, blijft outcome overal
      // null en toont de UI 'Outcome ontbreekt' voor completed/no_show
      // (wat correct is als context: er is geen outcome geregistreerd).
      const apptIds = rowsDone.map((r) => r.id);
      const outcomeById = new Map();
      if (apptIds.length > 0) {
        try {
          const { data: outRows, error: outErr } = await supabaseAdmin
            .from('follow_up_outcomes')
            .select('appointment_id, outcome')
            .in('appointment_id', apptIds);
          if (outErr) {
            console.warn('[cockpit-agenda afgehandeld outcomes]', outErr.message);
          } else {
            for (const o of outRows || []) {
              if (o.appointment_id) outcomeById.set(o.appointment_id, o.outcome || null);
            }
          }
        } catch (e) {
          console.warn('[cockpit-agenda afgehandeld outcomes-fetch]', e?.message || e);
        }
      }

      const items = rowsDone.map((r) => {
        const outcome = outcomeById.has(r.id) ? outcomeById.get(r.id) : null;
        return {
          source              : 'appointment',
          id                  : r.id,
          lead_name           : r.lead_name,
          lead_phone          : r.lead_phone,
          lead_email          : r.lead_email,
          scheduled_at        : r.scheduled_at,
          terugbel_datum      : r.scheduled_at,     // alias voor UI
          kind                : 'zoom',
          lead_kind           : 'zoom',
          status              : r.status,
          updated_at          : r.updated_at || null,
          // prev_state kan een jsonb of ontbreken zijn — client heeft
          // alleen de boolean nodig voor het corrigeer-teken.
          prev_state_present  : !!(r.prev_state && typeof r.prev_state === 'object' && Object.keys(r.prev_state).length),
          ghl_appointment_id  : r.ghl_appointment_id || null,
          zoom_join_url       : r.zoom_join_url || null,
          owner_id            : r.owner_id,
          owner_name          : r.owner_id ? (nameById[r.owner_id] || null) : null,
          // Sale-badge / "outcome ontbreekt"-signaal in de UI.
          outcome             : outcome,
          has_outcome         : outcomeById.has(r.id),
        };
      });
      return res.status(200).json({ items });
    }

    // ── ?view=agenda: samengevoegde chronologische lijst ─────────────
    const [leadFetch, apptRows] = await Promise.all([
      fetchLeadRows({ owner, kind, limit, userId: user.id, nowIso })
        .catch((e) => { console.warn('[agenda] leads:', e?.message); return { leadRows: [], hasRich: false }; }),
      fetchAppointmentRows({
        owner, kind, statusList: ['scheduled', 'gepland'], limit, userId: user.id,
      }).catch((e) => { console.warn('[agenda] appts:', e?.message); return []; }),
    ]);
    const leadRows = leadFetch.leadRows || [];
    const hasRich  = leadFetch.hasRich;

    // Owner-namen — één keer voor beide bronnen.
    const ownerIds = [...new Set([
      ...leadRows.map((r) => r.owner_id),
      ...apptRows.map((r) => r.owner_id),
    ].filter(Boolean))];
    const nameById = await lookupOwnerNames(ownerIds);

    const leadItems = leadRows.map((r) => {
      const isZoom = hasRich ? (String(r.lead_kind || 'call') === 'zoom') : false;
      return {
        source        : 'lead',
        id            : r.id,
        lead_name     : r.lead_name,
        lead_phone    : r.lead_phone,
        lead_email    : r.lead_email,
        terugbel_datum: r.terugbel_datum,
        lead_kind     : isZoom ? 'zoom' : 'bel',
        kind          : isZoom ? 'zoom' : 'bel',
        lead_status   : r.lead_status,
        owner_id      : r.owner_id,
        owner_name    : r.owner_id ? (nameById[r.owner_id] || null) : null,
        is_hot        : hasRich ? (r.is_hot === true) : false,
      };
    });

    const apptItems = apptRows.map((r) => ({
      source          : 'appointment',
      id              : r.id,
      lead_name       : r.lead_name,
      lead_phone      : r.lead_phone,
      lead_email      : r.lead_email,
      scheduled_at    : r.scheduled_at,
      terugbel_datum  : r.scheduled_at,     // alias voor UI
      kind            : 'zoom',
      lead_kind       : 'zoom',
      status          : r.status,
      owner_id        : r.owner_id,
      owner_name      : r.owner_id ? (nameById[r.owner_id] || null) : null,
      voicememo_status: r.voicememo_status || null,
      zoom_join_url   : r.zoom_join_url || null,
    }));

    // Merge + chronologisch sorteren op terugbel_datum (scheduled_at).
    const items = [...leadItems, ...apptItems].sort((a, b) => {
      const ta = a.terugbel_datum ? Date.parse(a.terugbel_datum) : Infinity;
      const tb = b.terugbel_datum ? Date.parse(b.terugbel_datum) : Infinity;
      return ta - tb;
    });

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[follow-up-cockpit-agenda]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
