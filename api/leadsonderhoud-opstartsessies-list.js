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
import { getSetterScope } from './_lib/setter-scope.js';

const PERIODES  = new Set(['week', 'maand', 'alles']);
const RESULTATEN = new Set(['alle', 'toegelaten', 'afgewezen']);
// BP3 v24 (2026-09-03) — tijd-filter voor Aankomend/Verleden/Alles.
// Default 'aankomend' zodat het huidige gedrag (upcoming eerst) behouden blijft.
const TIJDEN = new Set(['aankomend', 'verleden', 'alles']);

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
  // BP3 v12 (2026-09-03) — default verberg cancelled/no_show/verwijderd/
  // wacht_op_reschedule. Frontend kan dat via ?include_cancelled=true forceren
  // (toggle-chip "Toon geannuleerd"). Rijen zonder appointment_id (nog geen
  // boeking) blijven altijd zichtbaar.
  const includeCancelled = String(q.include_cancelled || '') === 'true';
  // BP3 v24 (2026-09-03) — tijd-filter. Bepaalt server-side WHERE + ORDER
  // + LIMIT-default zodat de limit op de juiste set slaat.
  const tijd = TIJDEN.has(String(q.tijd || 'aankomend').toLowerCase())
    ? String(q.tijd).toLowerCase() : 'aankomend';
  // BP3 v11 (2026-09-02) — from/to (YYYY-MM-DD) voor agenda-maand-view.
  // Als aanwezig: filter op gekozen_start_at binnen [from, to) en de
  // limit-cap gaat naar 1000 (volle maand dekken). from/to overrulen
  // periode (die filtert op created_at) — beide tegelijk zou verwarrend zijn.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const rawFrom = typeof q.from === 'string' && DATE_RE.test(q.from.trim()) ? q.from.trim() : null;
  const rawTo   = typeof q.to   === 'string' && DATE_RE.test(q.to.trim())   ? q.to.trim()   : null;
  const useRange = !!(rawFrom && rawTo);
  // BP3 v24 (2026-09-03) — limit-default per tijd-filter zodat de 25-limit
  // niet oude/afgeronde calls wegdrukt. Range-modus (agenda) blijft 1000.
  const defaultLimitByTijd = { aankomend: 100, verleden: 200, alles: 300 };
  const limit   = useRange
    ? Math.min(1000, Math.max(1, Number(q.limit) || 1000))
    : Math.min(500,  Math.max(1, Number(q.limit) || defaultLimitByTijd[tijd] || 100));
  const grens   = useRange ? null : periodeGrens(periode);

  try {
    // 1) Bronnen (voor label-mapping + filter-dropdown).
    const { data: bronnen } = await supabaseAdmin
      .from('booking_sources').select('slug, label').order('slug');
    const labelBySlug = new Map((bronnen || []).map((b) => [b.slug, b.label]));

    // 2) Submissions.
    // BP3 v11: bij range-modus sorteren op gekozen_start_at ascending zodat
    // de agenda niet client-side hoeft te sorteren voor de eerste render.
    // BP3 v24 (2026-09-03) — tijd-filter (aankomend/verleden/alles) heeft
    // eigen WHERE + ORDER. Range-modus (agenda) overrulet tijd zoals 'ie
    // periode al overruled. Nowtimestamp per request → OK bij korte
    // response-tijden (~ms schaal).
    const nowIso = new Date().toISOString();
    let qry = supabaseAdmin
      .from('opstartsessie_submissions')
      .select('id, created_at, booking_source, naam, email, telefoon, gekozen_slot, gekozen_start_at, score, drempel, resultaat, noshow_akkoord, appointment_id, lead_id', { count: 'exact' })
      .limit(limit);

    if (useRange) {
      qry = qry.order('gekozen_start_at', { ascending: true })
              .gte('gekozen_start_at', rawFrom).lt('gekozen_start_at', rawTo);
    } else if (tijd === 'aankomend') {
      // Aankomend: gekozen_start_at >= nu, oplopend. Rijen zonder
      // gekozen_start_at (nog geen moment gekozen / afgewezen) blijven
      // ook zichtbaar zodat Romy niet-geplande submissions kan opvolgen.
      qry = qry.or(`gekozen_start_at.gte.${nowIso},gekozen_start_at.is.null`)
              .order('gekozen_start_at', { ascending: true, nullsFirst: false });
    } else if (tijd === 'verleden') {
      // Verleden: gekozen_start_at < nu, meest recent bovenaan.
      qry = qry.lt('gekozen_start_at', nowIso)
              .order('gekozen_start_at', { ascending: false });
    } else {
      // Alles: geen tijd-filter; nieuwste created_at eerst — client-side
      // 3-way sort brengt aankomend/verleden/ongeboekt in de juiste volgorde.
      qry = qry.order('created_at', { ascending: false });
    }
    if (!useRange && grens) qry = qry.gte('created_at', grens);
    if (resultaat !== 'alle') qry = qry.eq('resultaat', resultaat);
    if (bron)      qry = qry.eq('booking_source', bron);
    const { data: rows, error, count } = await qry;
    if (error) throw error;

    // BP3 v4 (2026-09-01) — setter-scope EXACT op appointment_id, NIET op
    // email/telefoon-last9. Reden: testdata (en soms echte data) deelt één
    // nummer over meerdere bronnen (7-daagse-v1/v2, nieuwsbrief, romy…) →
    // last9-match over-matcht. Sinds BP2 heeft follow_up_appointments een
    // setter_user_id-kolom en opstartsessie_submissions een appointment_id-
    // FK — de exacte, ambiguïteit-vrije koppeling. Rows zonder
    // appointment_id kunnen niet aan een setter gekoppeld worden → droppen.
    // Manager/admin: geen scoping (isScoped=false → pass).
    const scope = await getSetterScope(user.id, supabaseAdmin);
    let filteredRows = rows || [];
    if (scope.isScoped) {
      const apptSet = new Set(scope.appointmentIds || []);
      if (apptSet.size === 0) {
        filteredRows = []; // fail-closed
      } else {
        filteredRows = filteredRows.filter((r) => r.appointment_id && apptSet.has(r.appointment_id));
      }
    }

    // BP3 v12 (2026-09-03) — bulk-fetch appointment-status voor de submissions
    // die een appointment_id hebben. Default: verberg cancelled/no_show/
    // verwijderd/wacht_op_reschedule uit lijst + agenda. Toggle via
    // ?include_cancelled=true. Rijen zonder appointment_id (nog geen boeking)
    // blijven altijd zichtbaar.
    const HIDDEN_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'verwijderd', 'wacht_op_reschedule']);
    const apptIds = [...new Set((filteredRows || []).map((r) => r.appointment_id).filter(Boolean))];
    const apptStatusById = new Map();
    const apptById = new Map();
    if (apptIds.length > 0) {
      const { data: appts } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('id, status, bevestigd_at, bevestiging_sent_at, reminder_24u_at, reminder_2u_at, reminder_30m_at, zoom_5min_at')
        .in('id', apptIds);
      for (const a of (appts || [])) { apptStatusById.set(a.id, a.status); apptById.set(a.id, a); }
    }
    if (!includeCancelled) {
      filteredRows = filteredRows.filter((r) => {
        if (!r.appointment_id) return true; // nog geen boeking → tonen
        const st = apptStatusById.get(r.appointment_id);
        return !st || !HIDDEN_STATUSES.has(String(st).toLowerCase());
      });
    }

    // BP3 v4 (2026-09-01) — Sale?-indicator per rij.
    // Match-sleutel: exact lowercase email (submission.email ↔ customers.email).
    // NIET op telefoon-last9 (gedeelde testnummers → over-match / valse vinkjes).
    // Sale-definitie: bestaat er een deal voor de matched customer met
    // tl_quotation_status IN ('accepted','signed'). Attributie-onafhankelijk
    // (setter_user_id NIET vereist) — vraag "is deze lead client geworden?".
    // Twee extra queries, geen N+1: bulk-customers + bulk-deals.
    // BP3 v4 vervolg (2026-09-01) — 3-way sale-status:
    //   is_sale = true  → deal met accepted/signed gevonden (groen ✓)
    //   is_sale = false + sale_checked=true → wél gecheckt, geen sale (rood ✗)
    //   sale_checked = false → email leeg of niet valid voor OR-clause → – (grijs)
    // matchableEmails = de subset waarop we daadwerkelijk konden checken.
    const saleByEmail = new Map(); // emailLower -> { customerName, saleBedrag }
    const matchableEmails = new Set();
    try {
      const emailSet = new Set();
      for (const r of (filteredRows || [])) {
        const e = String(r.email || '').trim().toLowerCase();
        if (e) emailSet.add(e);
      }
      if (emailSet.size > 0) {
        // Case-insensitive match: customers.email kan met verschillende casing
        // opgeslagen zijn (as-is uit de bron). We bouwen een OR-clause van
        // ilike-per-email zodat 'foo@bar.com' óók 'Foo@Bar.com' matcht.
        // Emails met '(', ')' of ',' worden geskipt (invalide karakters voor
        // PostgREST .or()-syntax; extreem zeldzaam in echte data) — die
        // rows worden dan als "niet checkbaar" gemarkeerd (streepje in UI).
        const emailArr = Array.from(emailSet).filter((e) => !/[(),]/.test(e));
        for (const e of emailArr) matchableEmails.add(e);
        const orClause = emailArr.map((e) => 'email.ilike.' + e).join(',');
        const { data: custs } = await supabaseAdmin
          .from('customers')
          .select('id, email, first_name, last_name, company_name, is_company')
          .or(orClause);
        const custByEmail = new Map();
        const custIds = [];
        for (const c of (custs || [])) {
          const key = String(c.email || '').trim().toLowerCase();
          if (!key) continue;
          const naam = c.is_company
            ? (c.company_name || '—')
            : [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
          custByEmail.set(key, { id: c.id, naam });
          custIds.push(c.id);
        }
        if (custIds.length > 0) {
          // BP3 v4 vervolg (2026-09-01) — tooltip toont MEEST RECENTE
          // accepted deal-bedrag, niet de som. Som over-telde bij klanten
          // met meerdere sales (en explodeerde op testdata). ORDER BY
          // created_at DESC → eerste hit per customer_id = de laatste.
          const { data: dls } = await supabaseAdmin
            .from('deals')
            .select('customer_id, tl_quotation_status, total_amount, created_at')
            .in('customer_id', custIds)
            .in('tl_quotation_status', ['accepted', 'signed'])
            .order('created_at', { ascending: false });
          const latestByCust = new Map(); // customer_id -> { bedrag, extra }
          for (const d of (dls || [])) {
            if (!d.customer_id) continue;
            const cur = latestByCust.get(d.customer_id);
            if (!cur) {
              latestByCust.set(d.customer_id, {
                bedrag: Number(d.total_amount) || 0,
                extra:  0,
              });
            } else {
              cur.extra += 1;
            }
          }
          for (const [emailLower, info] of custByEmail) {
            const hit = latestByCust.get(info.id);
            if (hit) {
              saleByEmail.set(emailLower, {
                customerName: info.naam,
                saleBedrag:   Math.round(hit.bedrag * 100) / 100,
                extraCount:   hit.extra,   // # eerdere accepted deals (0 = enige)
              });
            }
          }
        }
      }
    } catch (saleErr) {
      // Fail-soft: als de sale-lookup crasht, tonen we geen indicator (is_sale
      // blijft false op elke rij). De opstartsessie-lijst zelf blijft werken.
      console.warn('[leadsonderhoud-opstartsessies-list] sale-lookup:', saleErr?.message || saleErr);
    }

    const items = (filteredRows || []).map((r) => {
      const emailLower  = String(r.email || '').trim().toLowerCase();
      const saleChecked = !!emailLower && matchableEmails.has(emailLower);
      const saleInfo    = saleChecked ? (saleByEmail.get(emailLower) || null) : null;
      return {
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
        // BP3 v12 (2026-09-03) — appointment_status voor UI-badges + acties.
        // Null als submission nog geen boeking heeft.
        appointment_status: r.appointment_id ? (apptStatusById.get(r.appointment_id) || null) : null,
        // Afspraak-reminders (Fase B): bevestig-/reminder-status voor de UI-badge.
        ...(function () {
          const a = r.appointment_id ? apptById.get(r.appointment_id) : null;
          if (!a) return { bevestigd: false, bevestiging_sent: false, reminders_verstuurd: 0 };
          const remind = ['reminder_24u_at', 'reminder_2u_at', 'reminder_30m_at', 'zoom_5min_at']
            .reduce((n, k) => n + (a[k] ? 1 : 0), 0);
          return { bevestigd: !!a.bevestigd_at, bevestiging_sent: !!a.bevestiging_sent_at, reminders_verstuurd: remind };
        })(),
        lead_id         : r.lead_id,
        // 3-way sale-indicator: sale_checked=false → niet-checkbare rij (–);
        // sale_checked=true + is_sale=true → sale gevonden (✓); is_sale=false
        // met sale_checked=true → gecheckt maar geen accepted deal (✗).
        // sale_amount = bedrag van de MEEST RECENTE accepted deal (geen som).
        // sale_extra_count = # eerdere accepted deals (0 = enige sale).
        sale_checked        : saleChecked,
        is_sale             : !!saleInfo,
        sale_customer_name  : saleInfo ? saleInfo.customerName : null,
        sale_amount         : saleInfo ? saleInfo.saleBedrag   : null,
        sale_extra_count    : saleInfo ? (saleInfo.extraCount || 0) : 0,
      };
    });

    return res.status(200).json({
      items,
      periode, resultaat, bron, tijd,
      total  : count || items.length,
      bronnen: (bronnen || []).map((b) => ({ slug: b.slug, label: b.label })),
    });
  } catch (e) {
    console.error('[leadsonderhoud-opstartsessies-list]', e?.message || e);
    return res.status(500).json({ error: 'Opstartsessies laden mislukt' });
  }
}
