// api/dunning-pipeline-actions.js
// GET → "Actie vandaag"-dashboard voor de Wanbetalers-pipeline.
//
// Puur read-only. Berekent 3 signaal-groepen op bestaande data
// (GEEN nieuwe tabellen, GEEN verzending):
//   1) appointments_due — open afspraken vandaag of eerder verlopen
//   2) awaiting_reply   — wij stuurden laatst iets, klant zweeg > AWAITING_REPLY_DAYS
//   3) stale            — pipeline-klant zonder pipeline-activiteit > STALE_DAYS
//
// Alleen niet-terminale pipeline-klanten tellen mee (opgelost/afschrijven eruit).
//
// GEBATCHT (geen N+1): 1 select op pipeline_customers + parallel batches op
// customers / invoices / appointments / conversations op de custIds-set.
//
// Permission: finance.dunning.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

// Drempels — bewust bovenaan zodat we ze eenvoudig kunnen tunen.
const AWAITING_REPLY_DAYS = 2;
const STALE_DAYS          = 14;

// Terminale fases niet meenemen — die zijn per definitie "af" en horen
// niet in een actie-dashboard.
const TERMINAL_SLUGS = ['opgelost', 'afschrijven'];

const OPEN_INVOICE_STATUSES = ['open', 'partially_paid', 'overdue'];

function openAmountEur(inv) {
  const t = Number(inv?.amount_total)     || 0;
  const p = Number(inv?.amount_paid)      || 0;
  const c = Number(inv?.credited_amount)  || 0;
  return Math.max(0, t - p - c);
}
const toCents = (eur) => Math.round((Number(eur) || 0) * 100);

function daysBetween(nowMs, iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((nowMs - t) / (24 * 3600 * 1000));
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
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const now       = new Date();
  const nowMs     = now.getTime();
  const eod       = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const eodIso    = eod.toISOString();
  const staleCut  = new Date(nowMs - STALE_DAYS          * 24 * 3600 * 1000).toISOString();
  const awaitCut  = new Date(nowMs - AWAITING_REPLY_DAYS * 24 * 3600 * 1000).toISOString();

  try {
    // 1) Alle niet-terminale pipeline-rijen. PostgREST 'in'-syntax: ophalen
    // en client-side filteren op is_terminal via slug-lijst; simpel en zonder
    // 2e join. (Terminale slugs staan hard bovenaan.)
    const { data: pipelineRows, error: pErr } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('id, customer_id, stage_slug, stage_changed_at, last_activity_at')
      .not('stage_slug', 'in', `(${TERMINAL_SLUGS.map((s) => `"${s}"`).join(',')})`)
      .order('last_activity_at', { ascending: false })
      .limit(2000);
    if (pErr) throw new Error(pErr.message);

    const nonTerminalRows = pipelineRows || [];
    if (nonTerminalRows.length === 0) {
      return res.status(200).json({
        kpis: { appointments_today: 0, awaiting_reply: 0, stale_count: 0 },
        appointments_due: [],
        awaiting_reply  : [],
        stale           : [],
        thresholds      : { AWAITING_REPLY_DAYS, STALE_DAYS },
      });
    }

    const custIds       = nonTerminalRows.map((r) => r.customer_id).filter(Boolean);
    const pipelineByCid = new Map(nonTerminalRows.map((r) => [r.customer_id, r]));

    // 2) Finance-WABA phone_number_id. Bij ontbreken → conversations-signaal
    // simpelweg leeg; rest werkt gewoon.
    const { data: modCfg } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'finance')
      .eq('is_active', true)
      .maybeSingle();
    const financePnId = modCfg?.phone_number_id || null;

    // 3) Parallel batches — customers / invoices / appointments / conversations.
    const [
      { data: custRows, error: cErr },
      { data: invRows,  error: iErr },
      { data: apptRows, error: aErr },
      convResult,
    ] = await Promise.all([
      supabaseAdmin
        .from('customers')
        .select('id, first_name, last_name, company_name, is_company, email, phone')
        .in('id', custIds),
      supabaseAdmin
        .from('invoices')
        .select('customer_id, amount_total, amount_paid, credited_amount, status')
        .in('customer_id', custIds)
        .in('status', OPEN_INVOICE_STATUSES),
      supabaseAdmin
        .from('dunning_pipeline_appointments')
        .select('id, customer_id, title, due_at, status')
        .in('customer_id', custIds)
        .eq('status', 'open')
        .lte('due_at', eodIso)
        .order('due_at', { ascending: true })
        .limit(2000),
      financePnId
        ? supabaseAdmin
            .from('whatsapp_conversations')
            .select('id, customer_id, last_message_at, last_inbound_at, status')
            .eq('phone_number_id', financePnId)
            .in('customer_id', custIds)
            .not('status', 'eq', 'archived')
            .limit(5000)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (cErr) console.error('[dunning-pipeline-actions] customers:',   cErr.message);
    if (iErr) console.error('[dunning-pipeline-actions] invoices:',    iErr.message);
    if (aErr) console.error('[dunning-pipeline-actions] appointments:', aErr.message);
    if (convResult?.error) console.error('[dunning-pipeline-actions] conversations:', convResult.error.message);

    // 4) Aggregeer open-invoices per klant (cents).
    const openByCust = new Map();
    for (const inv of invRows || []) {
      const openEur = openAmountEur(inv);
      if (openEur <= 0) continue;
      const agg = openByCust.get(inv.customer_id) || { count: 0, cents: 0 };
      agg.count += 1;
      agg.cents += toCents(openEur);
      openByCust.set(inv.customer_id, agg);
    }
    const custById = new Map((custRows || []).map((c) => [c.id, c]));

    const nameFor    = (cid) => {
      const c = custById.get(cid);
      return c ? customerDisplayName(c, '(zonder naam)') : null;
    };
    const openFor    = (cid) => openByCust.get(cid) || { count: 0, cents: 0 };

    // ─────────────── GROEP 1: appointments_due ───────────────
    // due_at <= eod én status=open, oplopend op due_at. is_overdue = due_at < nu.
    const appointments_due = (apptRows || []).map((a) => {
      const agg = openFor(a.customer_id);
      return {
        customer_id     : a.customer_id,
        customer_name   : nameFor(a.customer_id),
        total_open_cents: agg.cents,
        open_invoice_count: agg.count,
        appointment_id  : a.id,
        title           : a.title,
        due_at          : a.due_at,
        is_overdue      : (new Date(a.due_at).getTime() < nowMs),
      };
    });

    // ─────────────── GROEP 2: awaiting_reply ────────────────
    // conversations van pipeline-klanten waar last_message_at > last_inbound_at
    // (of last_inbound_at null) en sinds > AWAITING_REPLY_DAYS. Dedup per klant
    // (meest recente conv telt).
    const awaitingRaw = (convResult?.data || []).filter((c) => {
      if (!c.customer_id || !c.last_message_at) return false;
      if (new Date(c.last_message_at).toISOString() > awaitCut) return false;
      if (c.last_inbound_at && new Date(c.last_inbound_at).getTime() >= new Date(c.last_message_at).getTime()) return false;
      return true;
    });
    // Sorteer stabiel op last_message_at desc → eerste per klant is de meest recente.
    awaitingRaw.sort((x, y) => {
      const tx = new Date(x.last_message_at).getTime();
      const ty = new Date(y.last_message_at).getTime();
      return ty - tx;
    });
    const seenAwaiting = new Set();
    const awaiting_reply = [];
    for (const c of awaitingRaw) {
      if (seenAwaiting.has(c.customer_id)) continue;
      seenAwaiting.add(c.customer_id);
      const agg   = openFor(c.customer_id);
      const days  = daysBetween(nowMs, c.last_message_at);
      awaiting_reply.push({
        customer_id       : c.customer_id,
        customer_name     : nameFor(c.customer_id),
        total_open_cents  : agg.cents,
        open_invoice_count: agg.count,
        conversation_id   : c.id,
        last_message_at   : c.last_message_at,
        days_waiting      : days,
      });
    }
    // Meest urgent (langst wachtend) eerst.
    awaiting_reply.sort((x, y) => (y.days_waiting || 0) - (x.days_waiting || 0));

    // ─────────────── GROEP 3: stale ──────────────────────────
    // Pipeline-rijen met last_activity_at < now - STALE_DAYS.
    const stale = nonTerminalRows
      .filter((r) => r.last_activity_at && new Date(r.last_activity_at).toISOString() < staleCut)
      .map((r) => {
        const agg  = openFor(r.customer_id);
        const days = daysBetween(nowMs, r.last_activity_at);
        return {
          customer_id       : r.customer_id,
          customer_name     : nameFor(r.customer_id),
          total_open_cents  : agg.cents,
          open_invoice_count: agg.count,
          stage_slug        : r.stage_slug,
          last_activity_at  : r.last_activity_at,
          days_since_activity: days,
        };
      })
      .sort((x, y) => (y.days_since_activity || 0) - (x.days_since_activity || 0));

    // KPIs — één zichtbaar getal per groep.
    const kpis = {
      appointments_today: appointments_due.length,
      awaiting_reply    : awaiting_reply.length,
      stale_count       : stale.length,
    };

    return res.status(200).json({
      kpis,
      appointments_due,
      awaiting_reply,
      stale,
      thresholds: { AWAITING_REPLY_DAYS, STALE_DAYS },
    });
  } catch (e) {
    console.error('[dunning-pipeline-actions]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
