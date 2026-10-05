// api/admin-meta-templates-submit.js
// POST → submit een lokale whatsapp_meta_templates rij naar Meta voor approval.
//
// Body: { template_id: <uuid> }
//
// Flow:
//   1. Auth: Bearer → user → profile.role === 'super_admin'.
//   2. Lookup rij. Eis: status in (LOCAL, REJECTED). Anders 409.
//   3. Build components-array per Meta Graph API v25.0 spec:
//        HEADER (optioneel; format = TEXT|IMAGE|VIDEO|DOCUMENT)
//        BODY   (verplicht; met example.body_text bij {{N}}-variabelen)
//        FOOTER (optioneel)
//        BUTTONS (optioneel; type URL/PHONE_NUMBER/QUICK_REPLY)
//   4. POST naar https://graph.facebook.com/v25.0/<WABA_ID>/message_templates
//   5. Op success: status='SUBMITTED', submitted_at=now(), meta_template_id=<id>.
//   6. Audit-log entry per attempt (success of error).
//
// Response 200: { item: <updated row>, meta_response: { id, status } }
// Response 502: { error, meta_error }  (Meta API fail)
//
// SUPER_ADMIN ONLY.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  isNamedTemplate,
  buildPositionalMapping,
  getExampleForKey,
  parseNamedPlaceholders,
  VARIABLE_REGEX,
} from './_lib/template-variables.js';
// Componenten-bouw staat sinds 2026-10-05 in een gedeelde, pure lib (ook
// gebruikt door scripts/360-templates-upload.mjs).
import { buildComponents } from './_lib/wa-template-components.js';

const META_API_VERSION = 'v25.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

const SELECT_COLS = 'id, business_account_id, meta_template_id, name, language, category, header_type, header_content, body_text, body_examples, footer_text, buttons, status, rejection_reason, meta_param_mapping, submitted_at, approved_at, last_synced_at, created_at, updated_at';

async function logAudit({ action, payload, status = 'success', error_message = null, userId }) {
  try {
    const { error } = await supabaseAdmin.from('agent_audit_log').insert({
      agent_name:    'admin',
      action,
      payload,
      result:        {},
      status,
      error_message,
      triggered_by:  userId || 'system',
    });
    if (error) console.error('[admin-meta-templates-submit] audit insert failed:', error.message);
  } catch (e) {
    console.error('[admin-meta-templates-submit] audit exception:', e.message);
  }
}

/**
 * Map Meta's response-status naar onze interne status-enum.
 * Meta: PENDING / APPROVED / REJECTED / PAUSED / DISABLED.
 * Wij : LOCAL / SUBMITTED / APPROVED / REJECTED / PAUSED / DISABLED.
 */
function mapMetaStatusToInternal(metaStatus) {
  if (!metaStatus) return 'SUBMITTED';
  const s = String(metaStatus).toUpperCase();
  if (s === 'PENDING' || s === 'PENDING_REVIEW' || s === 'IN_APPEAL') return 'SUBMITTED';
  if (s === 'APPROVED') return 'APPROVED';
  if (s === 'REJECTED') return 'REJECTED';
  if (s === 'PAUSED') return 'PAUSED';
  if (s === 'DISABLED') return 'DISABLED';
  return 'SUBMITTED';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    // BP1 2026-08-31: refactored van hardcoded super_admin naar RBAC-feature-
    // key admin.meta_templates.manage.
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });
    if (!(await requirePermission(req, 'admin.meta_templates.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage)' });
    }

    const body = req.body || {};
    const templateId = (body.template_id || req.query?.template_id || '').toString().trim();
    if (!templateId) {
      return res.status(400).json({ error: 'template_id vereist (uuid)' });
    }

    // ---- Lookup ----
    const { data: tpl, error: getErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select(SELECT_COLS)
      .eq('id', templateId)
      .maybeSingle();
    if (getErr) {
      console.error('[admin-meta-templates-submit] select error:', getErr.message);
      return res.status(500).json({ error: getErr.message });
    }
    if (!tpl) return res.status(404).json({ error: 'Template niet gevonden' });

    // ---- Status-gate ----
    if (tpl.status !== 'LOCAL' && tpl.status !== 'REJECTED') {
      return res.status(409).json({
        error: `Alleen LOCAL of REJECTED templates kunnen ingestuurd worden (huidige status: ${tpl.status})`,
      });
    }

    // ---- Build Meta payload + named→positional conversion ----
    const { components, meta_param_mapping } = buildComponents(tpl);
    const metaPayload = {
      name:                  tpl.name,
      language:              tpl.language,
      category:              tpl.category,
      components,
      allow_category_change: true,
    };

    // ---- Config check ----
    const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) {
      const msg = 'META_WHATSAPP_ACCESS_TOKEN ontbreekt in env';
      console.error('[admin-meta-templates-submit] config error:', msg);
      await logAudit({
        action: 'whatsapp_meta_template.submit',
        payload: { id: tpl.id, name: tpl.name, language: tpl.language, business_account_id: tpl.business_account_id },
        status: 'error',
        error_message: msg,
        userId: user.id,
      });
      return res.status(500).json({ error: msg });
    }

    const wabaId = tpl.business_account_id;
    if (!wabaId) {
      const msg = 'business_account_id ontbreekt op template';
      await logAudit({
        action: 'whatsapp_meta_template.submit',
        payload: { id: tpl.id, name: tpl.name, language: tpl.language },
        status: 'error',
        error_message: msg,
        userId: user.id,
      });
      return res.status(400).json({ error: msg });
    }

    // ---- POST naar Meta ----
    const url = `${META_BASE_URL}/${encodeURIComponent(wabaId)}/message_templates`;
    let metaRes;
    let metaText;
    let metaParsed = null;
    try {
      metaRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(metaPayload),
      });
      metaText = await metaRes.text();
      try { metaParsed = metaText ? JSON.parse(metaText) : null; } catch { /* keep null */ }
    } catch (fetchErr) {
      console.error('[admin-meta-templates-submit] fetch failed:', fetchErr.message);
      await logAudit({
        action: 'whatsapp_meta_template.submit',
        payload: { id: tpl.id, name: tpl.name, language: tpl.language, business_account_id: wabaId },
        status: 'error',
        error_message: `fetch failed: ${fetchErr.message}`,
        userId: user.id,
      });
      return res.status(502).json({ error: `Meta API fetch failed: ${fetchErr.message}` });
    }

    if (!metaRes.ok) {
      const metaErr = (metaParsed && metaParsed.error) ? metaParsed.error : null;
      const code     = metaErr?.code ?? metaRes.status;
      const subcode  = metaErr?.error_subcode ?? '';
      const msg      = metaErr?.message ?? (metaText ? metaText.slice(0, 200) : 'Onbekende Meta-fout');
      const fbtrace  = metaErr?.fbtrace_id ?? '';
      console.error('[admin-meta-templates-submit] Meta API error', {
        http_status: metaRes.status,
        meta_error:  metaErr,
        raw_body:    metaParsed ? undefined : (metaText ? metaText.slice(0, 500) : null),
      });
      await logAudit({
        action: 'whatsapp_meta_template.submit',
        payload: {
          id: tpl.id, name: tpl.name, language: tpl.language, business_account_id: wabaId,
          http_status: metaRes.status, meta_code: code, meta_subcode: subcode, fbtrace,
        },
        status: 'error',
        error_message: `Meta API ${code}: ${msg}`,
        userId: user.id,
      });
      return res.status(502).json({
        error:      `Meta API ${code}: ${msg} (subcode=${subcode}, fbtrace=${fbtrace})`,
        meta_error: metaErr,
      });
    }

    // ---- Success: parse + update DB ----
    const metaId       = metaParsed?.id ? String(metaParsed.id) : null;
    const metaStatus   = metaParsed?.status || null;
    const internalStat = mapMetaStatusToInternal(metaStatus);
    const nowIso       = new Date().toISOString();

    const updates = {
      status:             internalStat,
      submitted_at:       nowIso,
      last_synced_at:     nowIso,
      updated_at:         nowIso,
      meta_param_mapping: meta_param_mapping, // null voor legacy positional, object bij named
    };
    if (metaId) updates.meta_template_id = metaId;
    // Bij directe APPROVED-response: zet approved_at meteen.
    if (internalStat === 'APPROVED') updates.approved_at = nowIso;
    // Reset rejection_reason indien deze was gezet (resubmit-flow vanuit REJECTED).
    if (tpl.rejection_reason) updates.rejection_reason = null;

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .update(updates)
      .eq('id', tpl.id)
      .select(SELECT_COLS)
      .single();

    if (updErr) {
      console.error('[admin-meta-templates-submit] update error:', updErr.message);
      await logAudit({
        action: 'whatsapp_meta_template.submit',
        payload: {
          id: tpl.id, name: tpl.name, language: tpl.language, business_account_id: wabaId,
          meta_template_id: metaId, meta_status: metaStatus,
        },
        status: 'error',
        error_message: `DB update na Meta-submit faalde: ${updErr.message}`,
        userId: user.id,
      });
      return res.status(500).json({ error: updErr.message });
    }

    await logAudit({
      action: 'whatsapp_meta_template.submit',
      payload: {
        id: updated.id, name: updated.name, language: updated.language,
        business_account_id: updated.business_account_id,
        meta_template_id: updated.meta_template_id,
        meta_status: metaStatus, internal_status: updated.status,
      },
      userId: user.id,
    });

    return res.status(200).json({
      item:          updated,
      meta_response: { id: metaId, status: metaStatus },
    });
  } catch (e) {
    console.error('[admin-meta-templates-submit] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
