// api/wanbetalers-overzicht-list.js
// GET → compacte lijst voor het NIEUWE Overzicht (naast bestaande sub-views).
// FASE 1: puur ALLEEN-LEZEN. Geen mutaties, geen writes.
//
// Herbruikt bestaande waarheid — GEEN duplicatie van open-berekeningen die
// dunning-pipeline-list al doet. Extra velden die specifiek voor het nieuwe
// overzicht nodig zijn (dagen te laat, volgende actie, actief gesprek)
// worden hier bij-gejoined.
//
// Return-shape (per klant):
//   {
//     customer_id, customer_name, customer_email, customer_phone,
//     open_invoice_count, total_open_cents, days_overdue,
//     stage_slug, stage_changed_at,
//     next_action_at, next_action_step_type, next_action_step_title,
//     run_status,                     // active | paused | completed | cancelled | null
//     has_active_conversation,        // bool — whatsapp_conversations.status='open'
//     conversation_id,                // uuid of null
//     needs_attention,                // bool — engine-flag
//     last_activity_at,
//     last_wa_message_at,             // ISO — max(whatsapp_conversations.last_message_at)
//                                     // per customer; BEIDE richtingen (inbound+outbound).
//                                     // Test-conversations (is_test=true) uitgesloten.
//                                     // null = nog nooit contact via WA.
//     is_multi_invoice,               // helper voor 1/multi-tab-filter
//   }
//
// Aggregate-response bevat KPI-strip cijfers zodat de UI ze niet zelf hoeft
// te herberekenen. Vergelijkbaarheid met bestaande tabs = eis van FASE 1.
//
// Permission: finance.dunning.view (server-side hard).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const CLOSED_STAGES = new Set(['opgelost', 'afschrijven']);

function openAmount(inv) {
  const t = Number(inv?.amount_total)   || 0;
  const p = Number(inv?.amount_paid)    || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}

// Dagen te laat vanaf due_date (YYYY-MM-DD). Negatief → 0. Vandaag → 0.
function daysOverdueFromIso(iso) {
  if (!iso) return 0;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return 0;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  try {
    // 1) Alle open invoices ophalen met klant-embed. Zelfde OPEN_STATUSES als
    // de dunning-engine, zodat "wanbetalers" hier = "wanbetalers daar".
    const { data: invRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, amount_total, amount_paid, credited_amount, due_date, status, invoice_number, is_test, customers!inner(id, first_name, last_name, company_name, is_company, email, phone, archived_at, anonymized_at, is_test)')
      .in('status', OPEN_STATUSES)
      .eq('is_test', false)
      .eq('customers.is_test', false);
    if (invErr) throw new Error('invoices lookup: ' + invErr.message);

    // 2) Aggregeren per customer_id — identiek recept als dunning-engine.
    const perCust = new Map();
    for (const inv of invRows || []) {
      const cust = inv.customers;
      if (!cust) continue;
      if (cust.archived_at || cust.anonymized_at) continue;
      const oa = openAmount(inv);
      if (oa <= 0) continue;
      const agg = perCust.get(inv.customer_id) || {
        customer: cust,
        openInvoices: [],
        total_open_cents: 0,
        oldest_due_iso: null,
      };
      agg.openInvoices.push(inv);
      agg.total_open_cents += Math.round(oa * 100);
      if (inv.due_date) {
        const iso = String(inv.due_date).slice(0, 10);
        if (!agg.oldest_due_iso || iso < agg.oldest_due_iso) agg.oldest_due_iso = iso;
      }
      perCust.set(inv.customer_id, agg);
    }

    const custIds = Array.from(perCust.keys());
    if (custIds.length === 0) {
      return res.status(200).json({
        items: [],
        totals: { open_cents: 0, customers: 0, avg_days_overdue: 0, active_conversations: 0 },
      });
    }

    // 3) Pipeline-info: stage + stage_changed_at + last_activity_at.
    const { data: pcRows } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('customer_id, stage_slug, stage_changed_at, last_activity_at')
      .in('customer_id', custIds);
    const pipelineByCust = new Map((pcRows || []).map((r) => [r.customer_id, r]));

    // 4) Actieve/paused workflow-runs — volgende actie-datum + step-info.
    // Filter needs_attention=false zodat we alleen "levende" runs pakken;
    // needs_attention-runs worden apart als vlag getoond.
    const { data: runRows } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, customer_id, status, current_step_id, next_action_at, needs_attention, last_failure_reason, paused_by_conversation_id, paused_by_arrangement_id, paused_by_manual_user_id, paused_manual_reason, paused_at')
      .in('customer_id', custIds)
      .in('status', ['active', 'paused'])
      .order('next_action_at', { ascending: true });
    const runByCust = new Map();
    for (const r of runRows || []) {
      if (!runByCust.has(r.customer_id)) runByCust.set(r.customer_id, r);
    }

    // Step-info per current_step_id.
    const stepIds = Array.from(new Set((runRows || []).map((r) => r.current_step_id).filter(Boolean)));
    const stepById = new Map();
    if (stepIds.length) {
      const { data: stepRows } = await supabaseAdmin
        .from('dunning_workflow_steps')
        .select('id, step_type, config')
        .in('id', stepIds);
      for (const s of stepRows || []) stepById.set(s.id, s);
    }

    // 5) Actieve conversaties — whatsapp_conversations.status='open' voor
    // deze klanten. Één conv per klant genoeg voor de UI-badge; als er meer
    // zijn nemen we de meest recente.
    const { data: convRows } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, status, updated_at')
      .in('customer_id', custIds)
      .eq('status', 'open')
      .order('updated_at', { ascending: false });
    const convByCust = new Map();
    for (const c of convRows || []) {
      if (!convByCust.has(c.customer_id)) convByCust.set(c.customer_id, c);
    }

    // 5b) Laatste WhatsApp-contact per customer — BEIDE richtingen (in+out).
    //     Bron: whatsapp_conversations.last_message_at (bij zowel inbound
    //     (inbox-webhook) als outbound (inbox-send / inbox-webhook outbound)
    //     bijgewerkt). Één query, geen N+1, geen top-N-truncatie: aggregeer
    //     per customer_id over ALLE non-test conversations van deze klanten.
    //     Test-conversations (is_test=true) uitgesloten zodat een test-thread
    //     nooit als "laatste contact" in het dossier verschijnt (consistent
    //     met is_test-filtering elders in de wanbetalers-flow).
    const lastWaMap = new Map();  // customer_id → ISO string
    if (custIds.length) {
      const { data: waRows, error: waErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('customer_id, last_message_at')
        .in('customer_id', custIds)
        .eq('is_test', false)
        .not('last_message_at', 'is', null);
      if (waErr) {
        console.warn('[wanbetalers-overzicht-list] last_wa lookup fail-soft:', waErr.message);
      } else {
        for (const c of (waRows || [])) {
          // Numerieke vergelijking via Date.parse — robuust tegen
          // formaat-varianten (tz-shift / microseconds) t.o.v. string-compare.
          const cur = lastWaMap.get(c.customer_id);
          const curMs = cur ? new Date(cur).getTime() : 0;
          const newMs = new Date(c.last_message_at).getTime();
          if (Number.isFinite(newMs) && newMs > curMs) {
            lastWaMap.set(c.customer_id, c.last_message_at);
          }
        }
      }
    }

    // 6) Bouw response-items.
    let sumDaysOverdue = 0;
    let activeConversations = 0;
    const items = [];
    for (const [cid, agg] of perCust) {
      const pc = pipelineByCust.get(cid) || null;
      const run = runByCust.get(cid) || null;
      const step = run?.current_step_id ? (stepById.get(run.current_step_id) || null) : null;
      const conv = convByCust.get(cid) || null;
      const daysOverdue = daysOverdueFromIso(agg.oldest_due_iso);
      sumDaysOverdue += daysOverdue;
      if (conv) activeConversations++;
      items.push({
        customer_id:              cid,
        customer_name:            customerDisplayName(agg.customer, '(zonder naam)'),
        customer_email:           agg.customer.email || null,
        customer_phone:           agg.customer.phone || null,
        open_invoice_count:       agg.openInvoices.length,
        total_open_cents:         agg.total_open_cents,
        days_overdue:             daysOverdue,
        oldest_due_iso:           agg.oldest_due_iso,
        stage_slug:               pc?.stage_slug || null,
        stage_changed_at:         pc?.stage_changed_at || null,
        last_activity_at:         pc?.last_activity_at || null,
        run_status:               run?.status || null,
        next_action_at:           run?.next_action_at || null,
        next_action_step_type:    step?.step_type || null,
        next_action_step_title:   step?.config?.title || null,
        needs_attention:          !!run?.needs_attention,
        last_failure_reason:      run?.last_failure_reason || null,
        // Pauze-reden-velden (voor UI-badge "Handmatig gepauzeerd" vs
        // "Gepauzeerd door inbox-reply" vs "Gepauzeerd door arrangement").
        // Bij status=='active' allemaal null (server-side eq('status',
        // ['active','paused']) — dus voor active-rijen is dit no-op).
        paused_by_conversation_id: run?.paused_by_conversation_id || null,
        paused_by_arrangement_id:  run?.paused_by_arrangement_id  || null,
        paused_by_manual_user_id:  run?.paused_by_manual_user_id  || null,
        paused_manual_reason:      run?.paused_manual_reason      || null,
        paused_at:                 run?.paused_at                 || null,
        has_active_conversation:  !!conv,
        conversation_id:          conv?.id || null,
        last_wa_message_at:       lastWaMap.get(cid) || null,
        is_multi_invoice:         agg.openInvoices.length > 1,
        // "afgerond" in de sub-tab-zin = klant zit in terminal-stage
        // (opgelost/afschrijven) OF geen actieve/paused run. Wanbetalers
        // met een lopende flow of nog te-doen actie = "actief".
        is_closed:                CLOSED_STAGES.has(pc?.stage_slug || '') || !run,
      });
    }

    const totals = {
      open_cents:           items.reduce((s, x) => s + x.total_open_cents, 0),
      customers:            items.length,
      avg_days_overdue:     items.length ? Math.round(sumDaysOverdue / items.length) : 0,
      active_conversations: activeConversations,
    };

    return res.status(200).json({ items, totals });
  } catch (e) {
    console.error('[wanbetalers-overzicht-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
