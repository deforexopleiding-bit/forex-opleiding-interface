// api/finance-dunning-mark-bewind.js
// Acties-tab v1 — Markeer een klant als "in schuldbewind / faillissement /
// curator" en STOP de aanmaning naar de klant zelf. Vervolg-contact loopt
// via de bewindvoerder/curator (curator_contact-jsonb op
// dunning_pipeline_customers, zie migratie 2026-07-29-dunning-pipeline-
// add-curator-contact.sql).
//
// Body:
//   {
//     customer_id: uuid (required),
//     reason:      string (min 5, max 500, required),
//     curator_contact: {
//       name:       string (min 2, max 200, required),
//       email?:     string (max 200, optioneel),
//       phone?:     string (max 60, optioneel),
//       reference?: string (max 200, optioneel — dossiernummer),
//       note?:      string (max 500, optioneel),
//     }
//   }
//
// Engine-guard: 'bewind' zit in PIPELINE_SKIP_STAGES → engine slaat over
// zolang er geen nieuwe factuur bij komt met issue_date NA stage_changed_at
// (dan komt de klant weer in de flow, wat correct is — nieuwe factuur =
// nieuwe case die de bewindvoerder ook moet weten).
//
// Terug-route: setStage naar 'nieuw' (bewind opgeheven, aanmanen hervat)
// via api/dunning-pipeline-set-stage.js — geen dedicated resolve-bewind
// endpoint nodig want de UI-knop staat al in de detail-modal.
//
// Permission: finance.dunning.execute (server-side hard gate).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { setStage } from './_lib/dunning-pipeline.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_STAGE = 'bewind';

function cleanStr(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

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
  const cc = (body.curator_contact && typeof body.curator_contact === 'object') ? body.curator_contact : null;

  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
  if (reason.length < 5) return res.status(400).json({ error: 'reason (min 5 chars) verplicht — leg vast waarom (bewind/faillissement/…)' });
  if (reason.length > 500) return res.status(400).json({ error: 'reason max 500 chars' });
  if (!cc) return res.status(400).json({ error: 'curator_contact (object) verplicht' });

  const curatorName = cleanStr(cc.name, 200);
  if (curatorName.length < 2) return res.status(400).json({ error: 'curator_contact.name (min 2 chars) verplicht' });

  const curatorContact = {
    name:        curatorName,
    email:       cleanStr(cc.email, 200) || null,
    phone:       cleanStr(cc.phone, 60)  || null,
    reference:   cleanStr(cc.reference, 200) || null,
    note:        cleanStr(cc.note, 500)  || null,
    recorded_at: new Date().toISOString(),
  };

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
      return res.status(409).json({ error: 'Klant is gearchiveerd/geanonimiseerd' });
    }

    const warnings = [];

    // Stap 1 — stage='bewind' via setStage (die schrijft ook de log-entry).
    let markedStage = false;
    try {
      const r = await setStage(customerId, TARGET_STAGE, reason, userId ? String(userId) : 'system');
      markedStage = !!(r && r.ok !== false);
      if (!markedStage) warnings.push('Stage-transitie naar bewind faalde: ' + (r?.reason || 'onbekend'));
    } catch (e) {
      warnings.push('setStage-fout: ' + e.message);
      console.error('[mark-bewind] setStage:', e.message);
    }

    // Stap 2 — curator_contact-jsonb op dunning_pipeline_customers.
    try {
      const { error: ccErr } = await supabaseAdmin
        .from('dunning_pipeline_customers')
        .update({ curator_contact: curatorContact, updated_at: nowIso })
        .eq('customer_id', customerId);
      if (ccErr) throw new Error(ccErr.message);
    } catch (e) {
      warnings.push('curator_contact-update faalde: ' + e.message);
      console.error('[mark-bewind] curator_contact:', e.message);
    }

    // Stap 3 — pending_actions → REJECTED
    let rejectedActions = 0;
    try {
      const { data: rej, error: rejErr } = await supabaseAdmin
        .from('pending_actions')
        .update({
          status:           'REJECTED',
          rejection_reason: 'Klant in bewind — user ' + (userId || 'system') + ': ' + reason,
          updated_at:       nowIso,
        })
        .eq('customer_id', customerId)
        .in('status', ['PENDING', 'APPROVED'])
        .select('id');
      if (rejErr) throw new Error(rejErr.message);
      rejectedActions = Array.isArray(rej) ? rej.length : 0;
    } catch (e) {
      warnings.push('pending_actions-reject faalde: ' + e.message);
      console.error('[mark-bewind] pa reject:', e.message);
    }

    // Audit-log
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      'finance_dunning.customer_marked_bewind',
        entity_type: 'customer',
        entity_id:   customerId,
        after_json: {
          customer_id:      customerId,
          customer_display: customerDisplayName(cust, '(zonder naam)'),
          reason,
          curator_contact:  curatorContact,
          marked_stage:     markedStage,
          rejected_actions: rejectedActions,
          warnings,
          marked_at:        nowIso,
        },
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      warnings.push('audit_log-insert faalde: ' + e.message);
      console.warn('[mark-bewind] audit:', e.message);
    }

    return res.status(200).json({
      ok: true,
      customer_id:      customerId,
      marked_stage:     markedStage,
      rejected_actions: rejectedActions,
      curator_contact:  curatorContact,
      warnings,
    });
  } catch (e) {
    console.error('[finance-dunning-mark-bewind]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
