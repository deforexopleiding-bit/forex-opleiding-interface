// api/wanbetalers-todo-list.js
// GET → dagelijkse "Te doen"-worklist + campagne-teller voor de achterstand.
// Permission: finance.dunning.view.
//
// Worklist  = klanten met PRECIES 1 open factuur die te laat is (due_date <
//             today). Per regel de volgende afgeleide actie op basis van
//             pipeline_fase. Terminale fases (opgelost / afschrijven /
//             incasso) worden uitgesloten.
// Campaign  = klanten met ≥2 open facturen (de massa-opruiming / crediteer-
//             ronde), alleen count + totaal_open_cents.
//
// Hergebruikt de aggregatie- + is_test-filter uit crediteer-overzicht.js.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const TERMINAL_STAGES = new Set(['opgelost', 'afschrijven', 'incasso']);

function todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dueDateMs(isoDate) {
  if (!isoDate) return null;
  const ymd = String(isoDate).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function openAmt(inv) {
  const t = Number(inv?.amount_total) || 0;
  const p = Number(inv?.amount_paid)  || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}
const toCents = (eur) => Math.round((Number(eur) || 0) * 100);

// Suggested action op basis van pipeline-fase — user-visible strings.
function suggestedActionFor(stageSlug) {
  const s = String(stageSlug || 'nieuw').toLowerCase();
  switch (s) {
    case 'nieuw':           return 'Start aanmaning';
    case 'aangemaand':      return 'Vraag Joost';
    case 'in_gesprek':      return 'Bekijk gesprek';
    case 'regeling':        return 'Keur regeling goed';
    case 'brief_verstuurd': return 'Naar incasso';
    default:                return 'Bekijk';
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  try {
    // 1) Open facturen + joined customer — zelfde patroon als crediteer-overzicht.
    const { data: invRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select(`
        id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, due_date, status, is_test,
        customers:customer_id ( id, first_name, last_name, company_name, is_company, archived_at, anonymized_at, is_test )
      `)
      .in('status', OPEN_STATUSES)
      .eq('is_test', false);
    if (invErr) throw new Error('invoices lookup: ' + invErr.message);

    // 2) Groepeer per klant (skip archived/anonymized/test-klanten).
    const perCustomer = new Map();
    for (const inv of invRows || []) {
      const cust = inv.customers;
      if (!cust) continue;
      if (cust.archived_at || cust.anonymized_at) continue;
      if (cust.is_test) continue;
      const open = openAmt(inv);
      if (open <= 0) continue;
      const agg = perCustomer.get(inv.customer_id) || { customer: cust, invoices: [], total_eur: 0 };
      agg.invoices.push({ ...inv, open_eur: open });
      agg.total_eur += open;
      perCustomer.set(inv.customer_id, agg);
    }

    if (perCustomer.size === 0) {
      return res.status(200).json({
        worklist    : [],
        campaign    : { count: 0, total_open_cents: 0 },
        generated_at: new Date().toISOString(),
      });
    }

    // 3) Pipeline-fase per klant.
    const cids = Array.from(perCustomer.keys());
    const stageByCust = new Map();
    const { data: pipeRows, error: pipeErr } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('customer_id, stage_slug')
      .in('customer_id', cids);
    if (pipeErr) throw new Error('pipeline lookup: ' + pipeErr.message);
    for (const r of pipeRows || []) {
      if (r?.customer_id) stageByCust.set(r.customer_id, r.stage_slug || 'nieuw');
    }

    // 4) Bouw worklist + campaign.
    const todayMs = todayMidnightMs();
    const worklist = [];
    let campaignCount     = 0;
    let campaignTotalEur  = 0;

    for (const [cid, agg] of perCustomer) {
      const nOpen = agg.invoices.length;

      // Campaign: ≥2 open facturen, ongeacht of terminaal in pipeline.
      if (nOpen >= 2) {
        campaignCount++;
        campaignTotalEur += agg.total_eur;
        continue;
      }

      // Worklist: precies 1 open factuur die te laat is.
      const inv = agg.invoices[0];
      const dueMs = dueDateMs(inv.due_date);
      if (dueMs == null || dueMs >= todayMs) continue; // nog niet te laat
      const stageSlug = stageByCust.get(cid) || 'nieuw';
      if (TERMINAL_STAGES.has(stageSlug)) continue;    // opgelost/afschrijven/incasso overslaan

      const daysOverdue = Math.floor((todayMs - dueMs) / 86400000);

      worklist.push({
        customer_id      : cid,
        customer_name    : customerDisplayName(agg.customer, '(zonder naam)'),
        invoice_id       : inv.id,
        invoice_number   : inv.invoice_number,
        open_amount_cents: toCents(inv.open_eur),
        days_overdue     : daysOverdue,
        due_date         : inv.due_date,
        stage_slug       : stageSlug,
        suggested_action : suggestedActionFor(stageSlug),
      });
    }

    // Sort: dagen te laat DESC (langst-te-laat bovenaan).
    worklist.sort((a, b) => (b.days_overdue - a.days_overdue));

    return res.status(200).json({
      worklist,
      campaign: {
        count            : campaignCount,
        total_open_cents : toCents(campaignTotalEur),
      },
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[wanbetalers-todo-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
