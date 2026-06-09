// api/arrangements-propose.js
// POST -> nieuwe payment_arrangement aanmaken (status='VOORGESTELD') incl. bijbehorende
// pending_actions per type. Permission: finance.arrangements.propose.
//
// Body (JSON):
//   {
//     customer_id:     uuid,
//     invoice_ids:     uuid[],   // verplicht behalve bij ABONNEMENT_PAUZE / ABONNEMENT_STOP
//     type:            'UITSTEL' | 'SPLITSING' | 'ABONNEMENT_PAUZE' | 'ABONNEMENT_STOP' | 'KWIJTSCHELDING',
//     details:         object,   // type-specifiek (zie validatie hieronder)
//     rationale:       string,   // vrije tekst (opgeslagen in notes + in pending_actions.payload)
//     effective_from:  date,     // optioneel — meta in details.effective_from
//     effective_until: date      // optioneel — meta in details.effective_until
//   }
//
// Lowercase / legacy synoniemen worden geaccepteerd voor backward-compat
// (uitstel -> UITSTEL, gespreid -> SPLITSING, pauze -> ABONNEMENT_PAUZE,
//  overig  -> ABONNEMENT_STOP, kwijtschelding -> KWIJTSCHELDING).
//
// Details-validatie per type:
//   UITSTEL           : { new_due_date: 'YYYY-MM-DD' }                            -- per factuur 1 pending_action.
//   SPLITSING         : { parts: [ { amount: number, due_date: 'YYYY-MM-DD' } ] } -- per factuur 1 pending_action.
//                       parts.length >= 2 EN sum(parts.amount) == sum(invoice.amount_total) (1ct tolerantie).
//   ABONNEMENT_PAUZE  : { subscription_id: uuid, pause_from, pause_until, reason } -- 1 pending_action.
//   ABONNEMENT_STOP   : { subscription_id: uuid, stop_date, reason }              -- 1 pending_action.
//   KWIJTSCHELDING    : { write_off_amount: number > 0, reason: string }          -- per factuur 1 pending_action.
//
// Response 201: { arrangement, pending_actions: [...] }
// Bij INSERT-fout op pending_actions: best-effort rollback (DELETE arrangement) + 500.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Uppercase enum-keys zijn canoniek. Legacy lowercase / oude 'overig' worden
// gemapt zodat oude callers blijven werken.
const TYPE_ALIASES = {
  // Canonieke uppercase keys
  UITSTEL:          'UITSTEL',
  SPLITSING:        'SPLITSING',
  ABONNEMENT_PAUZE: 'ABONNEMENT_PAUZE',
  ABONNEMENT_STOP:  'ABONNEMENT_STOP',
  KWIJTSCHELDING:   'KWIJTSCHELDING',
  // Legacy lowercase (backward compat)
  uitstel:        'UITSTEL',
  gespreid:       'SPLITSING',
  pauze:          'ABONNEMENT_PAUZE',
  overig:         'ABONNEMENT_STOP',
  kwijtschelding: 'KWIJTSCHELDING',
};

// Mapping naar pending_actions.action_type. TL_ prefix markeert acties die
// in D2 door de TeamLeader-executor opgepakt worden.
const ACTION_TYPE_FOR = {
  UITSTEL:          'TL_INVOICE_UPDATE_DUE',
  SPLITSING:        'TL_INVOICE_SPLIT',
  ABONNEMENT_PAUZE: 'TL_SUBSCRIPTION_PAUSE',
  ABONNEMENT_STOP:  'TL_SUBSCRIPTION_STOP',
  KWIJTSCHELDING:   'TL_INVOICE_WRITEOFF',
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
    return res.status(400).json({
      error: 'type vereist (UITSTEL | SPLITSING | ABONNEMENT_PAUZE | ABONNEMENT_STOP | KWIJTSCHELDING)',
    });
  }
  const type         = TYPE_ALIASES[typeRaw];
  const invoiceIds   = invoiceIdsRaw.map(String).filter(isUuid);
  const isSubAction  = (type === 'ABONNEMENT_PAUZE' || type === 'ABONNEMENT_STOP');
  const needsInvoices = !isSubAction;
  if (needsInvoices && invoiceIds.length === 0) {
    return res.status(400).json({ error: 'invoice_ids vereist (>=1 uuid) voor type ' + type });
  }
  if (effFrom  && !isDate(effFrom))  return res.status(400).json({ error: 'effective_from moet YYYY-MM-DD zijn' });
  if (effUntil && !isDate(effUntil)) return res.status(400).json({ error: 'effective_until moet YYYY-MM-DD zijn' });

  // ---- Type-specifieke details-validatie ----
  try {
    switch (type) {
      case 'UITSTEL': {
        if (!isDate(details.new_due_date)) throw new Error('details.new_due_date (YYYY-MM-DD) vereist voor UITSTEL');
        break;
      }
      case 'SPLITSING': {
        if (!Array.isArray(details.parts) || details.parts.length < 2) {
          throw new Error('details.parts (min 2 elementen) vereist voor SPLITSING');
        }
        for (const p of details.parts) {
          if (!p || typeof p !== 'object') throw new Error('details.parts: elk part is een object {amount, due_date}');
          if (!isPosNum(Number(p.amount))) throw new Error('details.parts[].amount moet > 0 zijn');
          if (!isDate(p.due_date))         throw new Error('details.parts[].due_date moet YYYY-MM-DD zijn');
        }
        break;
      }
      case 'ABONNEMENT_PAUZE': {
        if (!isUuid(details.subscription_id)) throw new Error('details.subscription_id (uuid) vereist voor ABONNEMENT_PAUZE');
        if (!isDate(details.pause_from))      throw new Error('details.pause_from (YYYY-MM-DD) vereist voor ABONNEMENT_PAUZE');
        if (!isDate(details.pause_until))     throw new Error('details.pause_until (YYYY-MM-DD) vereist voor ABONNEMENT_PAUZE');
        if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor ABONNEMENT_PAUZE');
        break;
      }
      case 'ABONNEMENT_STOP': {
        if (!isUuid(details.subscription_id)) throw new Error('details.subscription_id (uuid) vereist voor ABONNEMENT_STOP');
        if (!isDate(details.stop_date))       throw new Error('details.stop_date (YYYY-MM-DD) vereist voor ABONNEMENT_STOP');
        if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor ABONNEMENT_STOP');
        break;
      }
      case 'KWIJTSCHELDING': {
        if (!isPosNum(Number(details.write_off_amount))) throw new Error('details.write_off_amount (>0) vereist voor KWIJTSCHELDING');
        if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor KWIJTSCHELDING');
        break;
      }
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

    // ---- SPLITSING: sum(parts) == sum(amount_total) ----
    if (type === 'SPLITSING') {
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
      status:        'VOORGESTELD',
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
    // NB: pending_actions-kolom heet proposed_by_user_id (verschilt van de
    // payment_arrangements-laag, waar de kortere alias proposed_by wel bestaat).
    const actionType = ACTION_TYPE_FOR[type];
    const baseRow = {
      customer_id:         customerId,
      arrangement_id:      arr.id,
      action_type:         actionType,
      // pending_actions.status CHECK eist UPPERCASE in deployed DB
      // (PENDING/APPROVED/REJECTED/EXECUTED/FAILED/CANCELLED/ROLLED_BACK).
      status:              'PENDING',
      proposed_by_user_id: user.id,
    };

    const rows = [];
    switch (type) {
      case 'UITSTEL': {
        for (const invId of invoiceIds) {
          rows.push({
            ...baseRow,
            payload: { invoice_id: invId, new_due_date: details.new_due_date, source: 'manual', rationale },
          });
        }
        break;
      }
      case 'SPLITSING': {
        for (const invId of invoiceIds) {
          rows.push({
            ...baseRow,
            payload: { invoice_id: invId, parts: details.parts, source: 'manual', rationale },
          });
        }
        break;
      }
      case 'ABONNEMENT_PAUZE': {
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
        break;
      }
      case 'ABONNEMENT_STOP': {
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
        break;
      }
      case 'KWIJTSCHELDING': {
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
        break;
      }
    }

    let pendingActions = [];
    if (rows.length > 0) {
      const { data: paRows, error: paErr } = await supabaseAdmin
        .from('pending_actions')
        .insert(rows)
        .select('id, customer_id, arrangement_id, action_type, status, payload, proposed_by_user_id, created_at, updated_at');
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
