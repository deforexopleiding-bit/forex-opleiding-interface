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

    // BP3 v4 (2026-09-01) — Sale?-indicator per rij.
    // Match-sleutel: exact lowercase email (submission.email ↔ customers.email).
    // NIET op telefoon-last9 (gedeelde testnummers → over-match / valse vinkjes).
    // Sale-definitie: bestaat er een deal voor de matched customer met
    // tl_quotation_status IN ('accepted','signed'). Attributie-onafhankelijk
    // (setter_user_id NIET vereist) — vraag "is deze lead client geworden?".
    // Twee extra queries, geen N+1: bulk-customers + bulk-deals.
    const saleByEmail = new Map(); // emailLower -> { customerName, saleBedrag }
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
        // PostgREST .or()-syntax; extreem zeldzaam in echte data).
        const emailArr = Array.from(emailSet).filter((e) => !/[(),]/.test(e));
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
          const { data: dls } = await supabaseAdmin
            .from('deals')
            .select('customer_id, tl_quotation_status, total_amount')
            .in('customer_id', custIds)
            .in('tl_quotation_status', ['accepted', 'signed']);
          const bedragByCust = new Map();
          for (const d of (dls || [])) {
            if (!d.customer_id) continue;
            bedragByCust.set(d.customer_id, (bedragByCust.get(d.customer_id) || 0) + (Number(d.total_amount) || 0));
          }
          for (const [emailLower, info] of custByEmail) {
            if (bedragByCust.has(info.id)) {
              saleByEmail.set(emailLower, {
                customerName: info.naam,
                saleBedrag:   Math.round(bedragByCust.get(info.id) * 100) / 100,
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
      const emailLower = String(r.email || '').trim().toLowerCase();
      const saleInfo   = emailLower ? saleByEmail.get(emailLower) : null;
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
        lead_id         : r.lead_id,
        // Sale-indicator + tooltip-content (customer + bedrag).
        is_sale            : !!saleInfo,
        sale_customer_name : saleInfo ? saleInfo.customerName : null,
        sale_amount        : saleInfo ? saleInfo.saleBedrag   : null,
      };
    });

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
