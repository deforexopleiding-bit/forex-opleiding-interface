// api/follow-up-leads-list.js
//
// GET → follow_up_leads met filters + counts per view. Alleen deze tabel;
// bestaande follow-up/GHL-endpoints ongemoeid.
//
// Query:
//   ?source=retention|event|all         (default 'all')
//   ?status=<csv van de 6>              (optioneel; anders alles)
//   ?view=alle|vandaag|te_laat|open|snoozed   (default 'open' — sluit
//                                        snoozed uit; 'snoozed' toont
//                                        ALLEEN snoozed; 'alle' toont alles)
//   ?owner=me|<uuid>|none|all           (Fase D)
//   ?kind=call|zoom|all                 (Sales-cockpit Fase 1)
//   ?limit=<n>                          (default 500, max 1000)
//
// Response 200: { leads: [...], counts: { alle, open, vandaag, te_laat, snoozed },
//                 allowed_statuses }
// Response 501 bij ontbrekende tabel (42P01) — migratie nodig.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const LEAD_STATUSES = ['nieuw', 'benaderd', 'niet_bereikbaar', 'terugbellen', 'verlengd', 'verloren'];
const OPEN_STATUSES = LEAD_STATUSES.filter((s) => s !== 'verlengd' && s !== 'verloren');

// Sales-cockpit bucket-volgorde: te_laat < vandaag < binnenkort. Hotleads
// (is_hot=true) worden client-side apart getoond ongeacht bucket.
const BUCKET_PRIORITY = { te_laat: 0, vandaag: 1, binnenkort: 2, snoozed: 3 };

function computeBucket(lead, nowMs, todayStart, todayEnd, sevenDaysEnd) {
  const snoozeMs = lead.snoozed_until ? Date.parse(lead.snoozed_until) : NaN;
  if (Number.isFinite(snoozeMs) && snoozeMs > nowMs) return 'snoozed';
  const dueMs = lead.terugbel_datum ? Date.parse(lead.terugbel_datum) : NaN;
  if (Number.isFinite(dueMs)) {
    if (dueMs < todayStart) return 'te_laat';
    if (dueMs <= todayEnd)  return 'vandaag';
    if (sevenDaysEnd && dueMs <= sevenDaysEnd) return 'komende_7';
    return 'binnenkort';
  }
  // Geen terugbel_datum: 'nieuw' zonder plan behandelen we als te_laat
  // (moet actie); anders binnenkort (backlog).
  if (String(lead.lead_status || '') === 'nieuw') return 'te_laat';
  return 'binnenkort';
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
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (sales.tab.retentie of sales.customer.view)' });

  const q = req.query || {};
  const source = ['retention', 'event', 'all'].includes(q.source) ? q.source : 'all';
  const view   = ['alle', 'vandaag', 'te_laat', 'open', 'snoozed'].includes(q.view) ? q.view : 'open';
  const kind   = ['call', 'zoom', 'all'].includes(q.kind) ? q.kind : 'all';
  const statusCsv = typeof q.status === 'string' ? q.status.trim() : '';
  const statusFilter = statusCsv
    ? statusCsv.split(',').map((s) => s.trim()).filter((s) => LEAD_STATUSES.includes(s))
    : null;
  let limit = Number(q.limit) || 500;
  limit = Math.max(1, Math.min(1000, Math.floor(limit)));

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ownerQ = typeof q.owner === 'string' ? q.owner.trim() : '';
  let ownerFilter = null;
  if (ownerQ === 'me') ownerFilter = { kind: 'eq', value: user.id };
  else if (ownerQ === 'none') ownerFilter = { kind: 'is_null' };
  else if (UUID_RE.test(ownerQ)) ownerFilter = { kind: 'eq', value: ownerQ };

  const worklist = String(q.worklist || '') === '1';

  try {
    const nowISO   = new Date().toISOString();
    const todayISO = nowISO.slice(0, 10);
    const nowMs      = Date.now();
    const todayStart = new Date(todayISO + 'T00:00:00Z').getTime();
    const todayEnd   = new Date(todayISO + 'T23:59:59.999Z').getTime();
    // Worklist-horizon: einde van vandaag + 7 dagen (dus t/m dag 7 om
    // 23:59). Alleen relevant bij ?worklist=1 — andere aanroepen zien
    // het bestaande 'binnenkort'-gedrag zonder cap.
    const sevenDaysEnd = worklist ? (todayEnd + 7 * 86400000) : null;
    const sevenDaysEndIso = sevenDaysEnd ? new Date(sevenDaysEnd).toISOString() : null;

    // Snoozed-scope. Standaard verbergen we snoozed. Bij view=snoozed tonen
    // we juist ALLEEN snoozed. Bij view=alle tonen we beide (geen filter).
    const snoozeClause = (qq) => {
      if (view === 'snoozed') {
        return qq.gt('snoozed_until', nowISO);
      }
      if (view === 'alle') return qq;
      // Overige views: exclude snoozed.
      return qq.or('snoozed_until.is.null,snoozed_until.lte.' + nowISO);
    };

    const applyFilters = (qq) => {
      if (source !== 'all') qq = qq.eq('source', source);
      if (kind === 'call') qq = qq.or('lead_kind.is.null,lead_kind.eq.call');
      else if (kind === 'zoom') qq = qq.eq('lead_kind', 'zoom');
      if (statusFilter && statusFilter.length) qq = qq.in('lead_status', statusFilter);
      if (view === 'vandaag') {
        qq = qq.gte('terugbel_datum', todayISO + 'T00:00:00Z').lte('terugbel_datum', todayISO + 'T23:59:59Z');
      } else if (view === 'te_laat') {
        qq = qq.lt('terugbel_datum', nowISO).not('lead_status', 'in', '(verlengd,verloren)');
      } else if (view === 'open') {
        qq = qq.not('lead_status', 'in', '(verlengd,verloren)');
      }
      // Worklist-cap: bij ?worklist=1 verbergen we leads die > +7d in
      // de toekomst plannen (die horen niet in de 7-daagse werklijst).
      // Leads zonder terugbel_datum blijven meelopen (nieuw-zonder-plan
      // wordt door computeBucket op 'te_laat' gezet).
      if (worklist && sevenDaysEndIso) {
        qq = qq.or('terugbel_datum.is.null,terugbel_datum.lte.' + sevenDaysEndIso);
      }
      qq = snoozeClause(qq);
      if (ownerFilter?.kind === 'eq')          qq = qq.eq('owner_id', ownerFilter.value);
      else if (ownerFilter?.kind === 'is_null') qq = qq.is('owner_id', null);
      return qq;
    };

    // Bestaande kolommen + Fase 1 nieuwe kolommen. Sales-cockpit leest
    // attempts / is_hot / snoozed_until / lead_kind / last_outcome
    // (schrijven pas in Fase 2). Kolommen kunnen ontbreken in oude
    // schema's — daarom vangen we 42703 op met een fallback-select.
    const RICH_COLS = 'id, customer_id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id, last_contact_at, source_ref, created_at, updated_at, attempts, is_hot, snoozed_until, lead_kind, last_outcome, voicememo_sent_on';
    const CORE_COLS = 'id, customer_id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id, last_contact_at, source_ref, created_at, updated_at';

    async function runSelect(cols) {
      let q1 = supabaseAdmin.from('follow_up_leads')
        .select(cols)
        .order('terugbel_datum', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(limit);
      q1 = applyFilters(q1);
      return q1;
    }

    let leads = [];
    let leadErr = null;
    let cockpitColsAvailable = true;
    {
      const { data, error } = await runSelect(RICH_COLS);
      if (error && error.code === '42703') {
        cockpitColsAvailable = false;
        const { data: data2, error: err2 } = await runSelect(CORE_COLS);
        if (err2) { leadErr = err2; }
        else { leads = data2 || []; }
      } else if (error) { leadErr = error; }
      else { leads = data || []; }
    }
    if (leadErr) {
      if (leadErr.code === '42P01') {
        return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt — migratie vereist', code: 'MIGRATION_REQUIRED' });
      }
      throw new Error('leads fetch: ' + leadErr.message);
    }

    // Owner-name lookup.
    const ownerIds = [...new Set(leads.map((l) => l.owner_id).filter(Boolean))];
    const ownerNameById = {};
    if (ownerIds.length) {
      const { data: profs, error: pErr } = await supabaseAdmin
        .from('profiles').select('id, full_name').in('id', ownerIds);
      if (pErr) console.warn('[follow-up-leads-list] owners:', pErr.message);
      for (const p of (profs || [])) ownerNameById[p.id] = p.full_name || null;
    }

    // Verrijk: bucket + days_since_contact + owner_name.
    const enrichedLeads = leads.map((l) => {
      const bucket = computeBucket(l, nowMs, todayStart, todayEnd, sevenDaysEnd);
      let days_since_contact = null;
      if (l.last_contact_at) {
        const t = Date.parse(l.last_contact_at);
        if (Number.isFinite(t)) days_since_contact = Math.floor((nowMs - t) / 86400000);
      }
      return {
        ...l,
        owner_name: l.owner_id ? (ownerNameById[l.owner_id] || null) : null,
        bucket,
        days_since_contact,
        is_hot: l.is_hot === true,
        attempts: Number.isFinite(Number(l.attempts)) ? Number(l.attempts) : 0,
        lead_kind: l.lead_kind || 'call',
      };
    });

    // Sortering: is_hot DESC, bucket-priority ASC, terugbel_datum ASC,
    // fallback op created_at DESC (nieuwste eerst).
    enrichedLeads.sort((a, b) => {
      if ((b.is_hot ? 1 : 0) !== (a.is_hot ? 1 : 0)) return (b.is_hot ? 1 : 0) - (a.is_hot ? 1 : 0);
      const bA = BUCKET_PRIORITY[a.bucket] ?? 9;
      const bB = BUCKET_PRIORITY[b.bucket] ?? 9;
      if (bA !== bB) return bA - bB;
      const tA = a.terugbel_datum ? Date.parse(a.terugbel_datum) : Infinity;
      const tB = b.terugbel_datum ? Date.parse(b.terugbel_datum) : Infinity;
      if (tA !== tB) return tA - tB;
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });

    // Counts: hoofd-buckets. Snoozed count via aparte head-query. Ook count
    // van de FULL open-set (zonder view-filter), zodat de badge stabiel is.
    const countBase = () => supabaseAdmin.from('follow_up_leads').select('id', { count: 'exact', head: true });
    const orNotSnoozed = 'snoozed_until.is.null,snoozed_until.lte.' + nowISO;
    // Komende_7 count: morgen (todayEnd+1ms) t/m einde-dag 7. Bij ontbrekende
    // worklist-modus valt sevenDaysEndIso op null → skip die count.
    const morgenIso = new Date(todayEnd + 1).toISOString();
    const [
      { count: cAlle },
      { count: cOpen },
      { count: cVandaag },
      { count: cTeLaat },
      { count: cSnoozed },
      { count: cKomende7 },
    ] = await Promise.all([
      countBase(),
      countBase().not('lead_status', 'in', '(verlengd,verloren)').or(orNotSnoozed),
      countBase()
        .gte('terugbel_datum', todayISO + 'T00:00:00Z')
        .lte('terugbel_datum', todayISO + 'T23:59:59Z')
        .or(orNotSnoozed),
      countBase()
        .lt('terugbel_datum', nowISO)
        .not('lead_status', 'in', '(verlengd,verloren)')
        .or(orNotSnoozed),
      countBase().gt('snoozed_until', nowISO),
      sevenDaysEndIso
        ? countBase()
            .gte('terugbel_datum', morgenIso)
            .lte('terugbel_datum', sevenDaysEndIso)
            .not('lead_status', 'in', '(verlengd,verloren)')
            .or(orNotSnoozed)
        : Promise.resolve({ count: null }),
    ]);

    // ── Worklist-modus (?worklist=1) ────────────────────────────────
    // Voegt de GHL-Zoom-calls (follow_up_appointments status
    // scheduled|gepland) en wacht-op-reschedule-items toe aan de items,
    // met horizon vandaag + 7 dagen. Andere callers krijgen NIETS extra
    // (backwards-compatible). Fail-soft: appointment-bron mislukt →
    // leads worden alsnog geleverd.
    let apptItems  = [];
    let reschedule = [];
    if (worklist) {
      const horizonEndIso = sevenDaysEndIso || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
      const APPT_COLS_RICH = 'id, lead_name, lead_phone, scheduled_at, status, voicememo_status, zoom_meeting_id, zoom_join_url, owner_id';
      const APPT_COLS_MID  = 'id, lead_name, lead_phone, scheduled_at, status, voicememo_status, zoom_join_url, owner_id';
      const APPT_COLS_MIN  = 'id, lead_name, lead_phone, scheduled_at, status, voicememo_status, owner_id';

      const buildAppt = (cols, statusList, opts = {}) => {
        let qq = supabaseAdmin.from('follow_up_appointments')
          .select(cols)
          .in('status', statusList)
          .order('scheduled_at', { ascending: true })
          .limit(500);
        if (opts.requireScheduled) qq = qq.not('scheduled_at', 'is', null);
        if (opts.withinHorizon)    qq = qq.lte('scheduled_at', horizonEndIso);
        if (ownerFilter?.kind === 'eq') qq = qq.eq('owner_id', ownerFilter.value);
        return qq;
      };

      const tryAppt = async (statusList, opts) => {
        for (const cols of [APPT_COLS_RICH, APPT_COLS_MID, APPT_COLS_MIN]) {
          const { data, error } = await buildAppt(cols, statusList, opts);
          if (!error) return data || [];
          if (error.code === '42P01') return [];
          if (error.code !== '42703') { console.warn('[worklist appts]', error.message); return []; }
        }
        return [];
      };

      // Scheduled Zoom-calls binnen horizon + wacht_op_reschedule.
      const [scheduled, waiting] = await Promise.all([
        tryAppt(['scheduled', 'gepland'], { requireScheduled: true, withinHorizon: true }),
        tryAppt(['wacht_op_reschedule'], {}),
      ]);

      apptItems = (scheduled || []).map((a) => ({
        source          : 'appointment',
        kind            : 'zoom',
        id              : a.id,
        lead_name       : a.lead_name,
        lead_phone      : a.lead_phone,
        scheduled_at    : a.scheduled_at,
        status          : a.status,
        voicememo_status: a.voicememo_status || null,
        zoom_join_url   : a.zoom_join_url || null,
        owner_id        : a.owner_id || null,
      }));
      reschedule = (waiting || []).map((a) => ({
        source      : 'appointment',
        kind        : 'reschedule',
        id          : a.id,
        lead_name   : a.lead_name,
        lead_phone  : a.lead_phone,
        scheduled_at: a.scheduled_at,
        status      : 'wacht_op_reschedule',
        owner_id    : a.owner_id || null,
      }));
    }

    return res.status(200).json({
      leads: enrichedLeads,
      appointments: apptItems,
      reschedule,
      counts: {
        alle          : cAlle || 0,
        open          : cOpen || 0,
        vandaag       : cVandaag || 0,
        te_laat       : cTeLaat || 0,
        snoozed       : cSnoozed || 0,
        komende_7     : cKomende7 || 0,
        appointments  : apptItems.length,
        reschedule    : reschedule.length,
      },
      allowed_statuses      : LEAD_STATUSES,
      cockpit_cols_available: cockpitColsAvailable,
    });
  } catch (e) {
    console.error('[follow-up-leads-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
