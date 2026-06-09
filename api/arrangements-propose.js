// api/arrangements-propose.js
// POST -> nieuwe payment_arrangement aanmaken (status='voorgesteld') incl. bijbehorende
// pending_actions per type. Permission: finance.arrangements.propose.
//
// Body (JSON):
//   {
//     customer_id:     uuid,
//     invoice_ids:     uuid[],   // verplicht behalve bij pauze / abonnement-stop
//     type:            'uitstel' | 'gespreid' | 'pauze' | 'kwijtschelding' | 'overig',
//     details:         object,   // type-specifiek (zie validatie hieronder)
//     rationale:       string,   // vrije tekst (opgeslagen in notes + in pending_actions.payload)
//     effective_from:  date,     // optioneel — meta in details.effective_from
//     effective_until: date      // optioneel — meta in details.effective_until
//   }
//
// Type-aliassen (acceptatie van oude/uppercase synoniemen voor forward-compat):
//   'UITSTEL'           -> 'uitstel'
//   'SPLITSING'         -> 'gespreid'
//   'ABONNEMENT_PAUZE'  -> 'pauze'
//   'ABONNEMENT_STOP'   -> 'overig'   (geen aparte stop-enum; gemarkeerd via details.kind='abonnement_stop')
//   'KWIJTSCHELDING'    -> 'kwijtschelding'
//
// Details-validatie per (genormaliseerd) type:
//   uitstel        : { new_due_date: 'YYYY-MM-DD' }                            -- per factuur 1 pending_action.
//   gespreid       : { parts: [ { amount: number, due_date: 'YYYY-MM-DD' } ] } -- per factuur 1 pending_action.
//                    parts.length >= 2 EN sum(parts.amount) == invoice.amount_total per factuur
//                    (wanneer 1 factuur). Bij meerdere facturen geldt de eis tegen sum(amount_total).
//   pauze          : { subscription_id: uuid, pause_from, pause_until, reason } -- 1 pending_action.
//   overig (stop)  : { subscription_id: uuid, stop_date, reason }              -- 1 pending_action.
//   kwijtschelding : { write_off_amount: number > 0, reason: string }          -- per factuur 1 pending_action.
//
// Response 201: { arrangement, pending_actions: [...] }
// Bij INSERT-fout op pending_actions: best-effort rollback (DELETE arrangement) + 500.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TYPE_ALIASES = {
  UITSTEL:          'uitstel',
  SPLITSING:        'gespreid',
  ABONNEMENT_PAUZE: 'pauze',
  ABONNEMENT_STOP:  'overig',
  KWIJTSCHELDING:   'kwijtschelding',
  uitstel: 'uitstel', gespreid: 'gespreid', pauze: 'pauze',
  kwijtschelding: 'kwijtschelding', overig: 'overig',
};

// Mapping naar pending_actions.action_type (consistent met migratie-comment).
const ACTION_TYPE_FOR = {
  uitstel:           'arrangement.uitstel',
  gespreid:          'arrangement.gespreid',
  pauze:             'arrangement.pauze',
  overig_stop:       'arrangement.abonnement_stop',
  kwijtschelding:    'arrangement.kwijtschelding',
};

function isUuid(s)  { return typeof s === 'string' && UUID_RE.test(s); }
function isDate(s)  { return typeof s === 'string' && DATE_RE.test(s); }
function isPosNum(n){ return typeof n === 'number' && Number.isFinite(n) && n > 0; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.arrangements.propose'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.arrangements.propose)' });
  }

  const body = req.body || {};
  const customerId    = body.customer_id ? String(body.customer_id) : null;
  const invoiceIdsRaw = Array.isArray(body.invoice_ids) ? body.invoice_ids : [];
  const typeRaw       = body.type ? String(body.type) : null;
  const details       = (body.details && typeof body.details === 'object') ? body.details : {};
  const rationale     = body.rationale ? String(body.rationale) : null;
  const effFrom       = body.effective_from  ? String(body.effective_from)  : null;
  const effUntil      = body.effective_until ? String(body.effective_until) : null;

  // ---- Basis-validatie ----
  if (!isUuid(customerId))  return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  if (!typeRaw || !(typeRaw in TYPE_ALIASES)) {
    return res.status(400).json({ error: 'type vereist (uitstel | gespreid | pauze | kwijtschelding | overig — UPPERCASE-aliassen geaccepteerd)' });
  }
  const type        = TYPE_ALIASES[typeRaw];
  const isStop      = String(typeRaw).toUpperCase() === 'ABONNEMENT_STOP';
  const invoiceIds  = invoiceIdsRaw.map(String).filter(isUuid);
  const needsInvoices = !(type === 'pauze' || isStop);
  if (needsInvoices && invoiceIds.length === 0) {
    return res.status(400).json({ error: 'invoice_ids vereist (>=1 uuid) voor type ' + type });
  }
  if (effFrom  && !isDate(effFrom))  return res.status(400).json({ error: 'effective_from moet YYYY-MM-DD zijn' });
  if (effUntil && !isDate(effUntil)) return res.status(400).json({ error: 'effective_until moet YYYY-MM-DD zijn' });

  // ---- Type-specifieke details-validatie ----
  try {
    if (type === 'uitstel') {
      if (!isDate(details.new_due_date)) throw new Error('details.new_due_date (YYYY-MM-DD) vereist voor uitstel');
    } else if (type === 'gespreid') {
      if (!Array.isArray(details.parts) || details.parts.length < 2) {
        throw new Error('details.parts (min 2 elementen) vereist voor gespreid');
      }
      for (const p of details.parts) {
        if (!p || typeof p !== 'object') throw new Error('details.parts: elk part is een object {amount, due_date}');
        if (!isPosNum(Number(p.amount))) throw new Error('details.parts[].amount moet > 0 zijn');
        if (!isDate(p.due_date))         throw new Error('details.parts[].due_date moet YYYY-MM-DD zijn');
      }
    } else if (type === 'pauze') {
      if (!isUuid(details.subscription_id)) throw new Error('details.subscription_id (uuid) vereist voor pauze');
      if (!isDate(details.pause_from))      throw new Error('details.pause_from (YYYY-MM-DD) vereist voor pauze');
      if (!isDate(details.pause_until))     throw new Error('details.pause_until (YYYY-MM-DD) vereist voor pauze');
      if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor pauze');
    } else if (isStop) {
      if (!isUuid(details.subscription_id)) throw new Error('details.subscription_id (uuid) vereist voor abonnement-stop');
      if (!isDate(details.stop_date))       throw new Error('details.stop_date (YYYY-MM-DD) vereist voor abonnement-stop');
      if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor abonnement-stop');
    } else if (type === 'kwijtschelding') {
      if (!isPosNum(Number(details.write_off_amount))) throw new Error('details.write_off_amount (>0) vereist voor kwijtschelding');
      if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor kwijtschelding');
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    // ---- Verifieer customer bestaat ----
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id')
      .eq('id', customerId)
      .maybeSingle();
    if (custErr) throw new Error('customer-lookup: ' + custErr.message);
    if (!cust)   return res.status(404).json({ error: 'Klant niet gevonden' });

    // ---- Verifieer facturen bestaan (indien van toepassing) ----
    let invoices = [];
    if (invoiceIds.length > 0) {
      const { data: invRows, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('id, customer_id, amount_total, amount_paid, credited_amount, status, invoice_number')
        .in('id', invoiceIds);
      if (invErr) throw new Error('invoice-lookup: ' + invErr.message);
      invoices = invRows || [];
      if (invoices.length !== invoiceIds.length) {
        const found = new Set(invoices.map(r => r.id));
        const missing = invoiceIds.filter(id => !found.has(id));
        return res.status(404).json({ error: 'Factuur niet gevonden', missing });
      }
      // Optionele controle: alle facturen moeten van dezelfde klant zijn.
      const wrong = invoices.find(i => i.customer_id !== customerId);
      if (wrong) return res.status(400).json({ error: `Factuur ${wrong.invoice_number || wrong.id} hoort niet bij klant` });
    }

    // ---- Gespreid: sum(parts) == sum(amount_total) ----
    if (type === 'gespreid') {
      const sumParts = details.parts.reduce((a, p) => a + Number(p.amount || 0), 0);
      const sumInv   = invoices.reduce((a, i) => a + (Number(i.amount_total) || 0), 0);
      // 1-cent tolerantie tegen FP-afronding.
      if (Math.abs(sumParts - sumInv) > 0.01) {
        return res.status(400).json({
          error: `Som van parts (${sumParts.toFixed(2)}) komt niet overeen met som factuurbedrag (${sumInv.toFixed(2)})`,
        });
      }
    }

    // ---- Bouw details met effective_from/until + rationale-meta ----
    const detailsToStore = { ...details };
    if (effFrom)   detailsToStore.effective_from  = effFrom;
    if (effUntil)  detailsToStore.effective_until = effUntil;

    // ---- INSERT payment_arrangement ----
    const insertRow = {
      customer_id:   customerId,
      invoice_ids:   invoiceIds,
      type,
      status:        'voorgesteld',
      details:       detailsToStore,
      proposed_by:   user.id,
      notes:         rationale,
    };
    const { data: arr, error: arrErr } = await supabaseAdmin
      .from('payment_arrangements')
      .insert(insertRow)
      .select('id, customer_id, invoice_ids, type, status, details, proposed_by, notes, created_at, updated_at')
      .single();
    if (arrErr) throw new Error('arrangement-insert: ' + arrErr.message);

    // ---- Bouw pending_actions per type ----
    const actionType = isStop ? ACTION_TYPE_FOR.overig_stop : ACTION_TYPE_FOR[type];
    const baseRow = {
      customer_id:    customerId,
      arrangement_id: arr.id,
      action_type:    actionType,
      status:         'pending',
      proposed_by:    user.id,
    };

    const rows = [];
    if (type === 'uitstel') {
      for (const invId of invoiceIds) {
        rows.push({
          ...baseRow,
          payload: { invoice_id: invId, new_due_date: details.new_due_date, source: 'manual', rationale },
        });
      }
    } else if (type === 'gespreid') {
      for (const invId of invoiceIds) {
        rows.push({
          ...baseRow,
          payload: { invoice_id: invId, parts: details.parts, source: 'manual', rationale },
        });
      }
    } else if (type === 'pauze') {
      rows.push({
        ...baseRow,
        payload: {
          subscription_id: details.subscription_id,
          pause_from:      details.pause_from,
          pause_until:     details.pause_until,
          reason:          details.reason,
          source:          'manual',
          rationale,
        },
      });
    } else if (isStop) {
      rows.push({
        ...baseRow,
        payload: {
          subscription_id: details.subscription_id,
          stop_date:       details.stop_date,
          reason:          details.reason,
          source:          'manual',
          rationale,
        },
      });
    } else if (type === 'kwijtschelding') {
      for (const invId of invoiceIds) {
        rows.push({
          ...baseRow,
          payload: {
            invoice_id:       invId,
            write_off_amount: Number(details.write_off_amount),
            reason:           details.reason,
            source:           'manual',
            rationale,
          },
        });
      }
    }

    let pendingActions = [];
    if (rows.length > 0) {
      const { data: paRows, error: paErr } = await supabaseAdmin
        .from('pending_actions')
        .insert(rows)
        .select('id, customer_id, arrangement_id, action_type, status, payload, proposed_by, created_at, updated_at');
      if (paErr) {
        // Best-effort rollback: verwijder arrangement zodat we geen weeshuis-rij achterlaten.
        try {
          await supabaseAdmin.from('payment_arrangements').delete().eq('id', arr.id);
        } catch (rbErr) {
          console.error('[arrangements-propose rollback] kon arrangement niet verwijderen:', rbErr.message);
        }
        throw new Error('pending-actions-insert: ' + paErr.message);
      }
      pendingActions = paRows || [];
    }

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'finance.arrangement.proposed',
        entity_type: 'payment_arrangement',
        entity_id:   arr.id,
        after_json:  {
          arrangement_id: arr.id,
          type,
          action_count:   pendingActions.length,
        },
        reason_text: rationale,
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[arrangements-propose audit]', e.message); }

    return res.status(201).json({ arrangement: arr, pending_actions: pendingActions });
  } catch (e) {
    console.error('[arrangements-propose]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
