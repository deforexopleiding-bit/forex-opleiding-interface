// api/finance-dunning-mark-disputed.js
// Acties-tab v1 — Markeer een klant als "geschil / betwist factuur" en STOP
// de dunning-flow zolang het dispuut loopt. Pipeline-stage → 'dispuut'
// (nieuwe stage sinds 2026-07-29-dunning-pipeline-add-dispute-bewind-stages.sql).
// Engine-guard (shouldSkipDueToTerminalStage in api/_lib/dunning-pipeline.js)
// slaat 'dispuut' over — analoog aan terminal-stages, maar OMKEERBAAR:
//   - Geschil opgelost, klant had ongelijk → resolve-dispute → 'nieuw'
//   - Geschil opgelost, klant had gelijk → close-customer (factuur crediteren
//     valt buiten deze endpoint's scope).
//
// Body:
//   {
//     customer_id: uuid (required),
//     reason:      string (min 5, max 500, required),
//   }
//
// Verschil met close-customer (FIX 4):
//   - close-customer  : stage='opgelost', flow DEFINITIEF af.
//   - mark-disputed   : stage='dispuut',  flow GEPARKEERD, kan terug.
//
// Doet 2 stappen fail-soft:
//   1) setStage → 'dispuut' via api/_lib/dunning-pipeline.js
//   2) pending_actions (PENDING|APPROVED) → REJECTED met reason
//   Runs blijven active — engine SKIPT ze via de stage-guard. Zo kan
//   'resolve-dispute' ze meteen laten oppikken zonder ze te hoeven herstarten.
//
// Permission: finance.dunning.execute (server-side hard gate).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { setStage } from './_lib/dunning-pipeline.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_STAGE = 'dispuut';

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
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
  if (reason.length < 5) return res.status(400).json({ error: 'reason (min 5 chars) verplicht — leg vast wat er betwist wordt' });
  if (reason.length > 500) return res.status(400).json({ error: 'reason max 500 chars' });

  const nowIso = new Date().toISOString();
  const userId = user?.id || null;

  try {
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, archived_at, anonymized_at')
      .eq('id', customerId)
      .maybeSingle();
    if (custErr) throw new Error('customer lookup: ' + custErr.message);
    if (!cust)   return res.status(404).json({ error: 'Klant niet gevonden' });
    if (cust.archived_at || cust.anonymized_at) {
      return res.status(409).json({ error: 'Klant is gearchiveerd/geanonimiseerd; dispuut-markering niet nodig' });
    }

    const warnings = [];

    // Stap 1 — stage='dispuut'
    let markedStage = false;
    try {
      const r = await setStage(customerId, TARGET_STAGE, reason, userId ? String(userId) : 'system');
      markedStage = !!(r && r.ok !== false);
      if (!markedStage) warnings.push('Stage-transitie naar dispuut faalde: ' + (r?.reason || 'onbekend'));
    } catch (e) {
      warnings.push('setStage-fout: ' + e.message);
      console.error('[mark-disputed] setStage:', e.message);
    }

    // Stap 2 — open pending_actions → REJECTED (analoog close-customer)
    let rejectedActions = 0;
    try {
      const { data: rej, error: rejErr } = await supabaseAdmin
        .from('pending_actions')
        .update({
          status:           'REJECTED',
          rejection_reason: 'Klant betwist factuur (dispuut) — user ' + (userId || 'system') + ': ' + reason,
          updated_at:       nowIso,
        })
        .eq('customer_id', customerId)
        .in('status', ['PENDING', 'APPROVED'])
        .select('id');
      if (rejErr) throw new Error(rejErr.message);
      rejectedActions = Array.isArray(rej) ? rej.length : 0;
    } catch (e) {
      warnings.push('pending_actions-reject faalde: ' + e.message);
      console.error('[mark-disputed] pa reject:', e.message);
    }

    // Audit-log (fail-soft)
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      'finance_dunning.customer_marked_disputed',
        entity_type: 'customer',
        entity_id:   customerId,
        after_json: {
          customer_id:       customerId,
          customer_display:  customerDisplayName(cust, '(zonder naam)'),
          reason,
          marked_stage:      markedStage,
          rejected_actions:  rejectedActions,
          warnings,
          marked_at:         nowIso,
        },
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      warnings.push('audit_log-insert faalde: ' + e.message);
      console.warn('[mark-disputed] audit:', e.message);
    }

    return res.status(200).json({
      ok: true,
      customer_id:      customerId,
      marked_stage:     markedStage,
      rejected_actions: rejectedActions,
      warnings,
    });
  } catch (e) {
    console.error('[finance-dunning-mark-disputed]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
