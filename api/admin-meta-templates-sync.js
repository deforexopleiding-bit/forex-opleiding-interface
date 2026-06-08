// api/admin-meta-templates-sync.js
// POST → bulk-sync van Meta naar onze DB voor 1 business_account_id.
//
// Body: { business_account_id: <text> }
//
// Flow:
//   1. Auth: Bearer → user → profile.role === 'super_admin'.
//   2. GET https://graph.facebook.com/v25.0/<business_account_id>/message_templates
//        ?fields=name,language,status,category,id,rejected_reason&limit=100
//      Headers: Authorization: Bearer <META_WHATSAPP_ACCESS_TOKEN>.
//      Bij Meta-fout (!res.ok): console.error + 502 met meta_error.
//   3. Lookup local templates voor deze WABA (id, name, language, status, meta_template_id).
//   4. Build map name+":"+language → local_row.
//   5. Voor elke meta-row:
//        - Match local_row op (name, language). Geen match → skip
//          (C2 maakt geen rows aan voor non-local templates).
//        - patch = { last_synced_at: now, meta_template_id: meta_row.id }.
//        - Nieuwe status = meta_row.status.toUpperCase() gemapped naar onze enum.
//        - Als status verandert: patch.status + push naar status_changes.
//        - Als nieuwe status === REJECTED en meta_row.rejected_reason aanwezig:
//            patch.rejection_reason = meta_row.rejected_reason.
//        - Als nieuwe status === APPROVED en local_row.status !== APPROVED:
//            patch.approved_at = now, patch.rejection_reason = null.
//        - UPDATE whatsapp_meta_templates SET patch WHERE id = local_row.id.
//        - synced_count++.
//   6. Audit-log entry: whatsapp_meta_template.sync met after_json
//      { business_account_id, synced_count, status_changes_count }.
//   7. Response 200:
//        { synced_count, status_changes, total_meta_templates, total_local_matched }
//
// SUPER_ADMIN ONLY.

import { createUserClient, supabaseAdmin } from './supabase.js';

const META_API_VERSION = 'v25.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

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
    if (error) console.error('[admin-meta-templates-sync] audit insert failed:', error.message);
  } catch (e) {
    console.error('[admin-meta-templates-sync] audit exception:', e.message);
  }
}

/**
 * Map Meta's response-status naar onze interne status-enum.
 * Meta: PENDING / APPROVED / REJECTED / PAUSED / DISABLED / IN_APPEAL / PENDING_REVIEW.
 * Wij : LOCAL / SUBMITTED / APPROVED / REJECTED / PAUSED / DISABLED.
 */
function mapMetaStatusToInternal(metaStatus) {
  if (!metaStatus) return null;
  const s = String(metaStatus).toUpperCase();
  if (s === 'PENDING' || s === 'PENDING_REVIEW' || s === 'IN_APPEAL') return 'SUBMITTED';
  if (s === 'APPROVED') return 'APPROVED';
  if (s === 'REJECTED') return 'REJECTED';
  if (s === 'PAUSED') return 'PAUSED';
  if (s === 'DISABLED') return 'DISABLED';
  return 'SUBMITTED';
}

function validateBusinessAccountId(v) {
  if (typeof v !== 'string') return 'business_account_id: string vereist';
  const s = v.trim();
  if (!s) return 'business_account_id: leeg niet toegestaan';
  if (s.length > 64) return 'business_account_id: max 64 chars';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    // ---- Auth: Bearer → user → profile.role === 'super_admin' ----
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin' });
    }

    const body = req.body || {};
    const businessAccountId = (body.business_account_id || req.query?.business_account_id || '').toString().trim();
    const errBaid = validateBusinessAccountId(businessAccountId);
    if (errBaid) return res.status(400).json({ error: errBaid });

    // ---- Config check ----
    const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    if (!accessToken) {
      const msg = 'META_WHATSAPP_ACCESS_TOKEN ontbreekt in env';
      console.error('[admin-meta-templates-sync] config error:', msg);
      await logAudit({
        action: 'whatsapp_meta_template.sync',
        payload: { business_account_id: businessAccountId },
        status: 'error',
        error_message: msg,
        userId: user.id,
      });
      return res.status(500).json({ error: msg });
    }

    // ---- GET Meta templates ----
    const fields = 'name,language,status,category,id,rejected_reason';
    const url = `${META_BASE_URL}/${encodeURIComponent(businessAccountId)}/message_templates?fields=${encodeURIComponent(fields)}&limit=100`;
    let metaRes;
    let metaText;
    let metaParsed = null;
    try {
      metaRes = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      metaText = await metaRes.text();
      try { metaParsed = metaText ? JSON.parse(metaText) : null; } catch { /* keep null */ }
    } catch (fetchErr) {
      console.error('[admin-meta-templates-sync] fetch failed:', fetchErr.message);
      await logAudit({
        action: 'whatsapp_meta_template.sync',
        payload: { business_account_id: businessAccountId },
        status: 'error',
        error_message: `fetch failed: ${fetchErr.message}`,
        userId: user.id,
      });
      return res.status(502).json({ error: `Meta API fetch failed: ${fetchErr.message}` });
    }

    if (!metaRes.ok) {
      const metaErr = (metaParsed && metaParsed.error) ? metaParsed.error : null;
      const code    = metaErr?.code ?? metaRes.status;
      const subcode = metaErr?.error_subcode ?? '';
      const msg     = metaErr?.message ?? (metaText ? metaText.slice(0, 200) : 'Onbekende Meta-fout');
      const fbtrace = metaErr?.fbtrace_id ?? '';
      console.error('[admin-meta-templates-sync] Meta API error', {
        http_status: metaRes.status,
        meta_error:  metaErr,
        raw_body:    metaParsed ? undefined : (metaText ? metaText.slice(0, 500) : null),
      });
      await logAudit({
        action: 'whatsapp_meta_template.sync',
        payload: {
          business_account_id: businessAccountId,
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

    const data = Array.isArray(metaParsed?.data) ? metaParsed.data : [];

    if (data.length === 0) {
      await logAudit({
        action: 'whatsapp_meta_template.sync',
        payload: { business_account_id: businessAccountId, synced_count: 0, status_changes_count: 0 },
        userId: user.id,
      });
      return res.status(200).json({
        synced_count:         0,
        status_changes:       [],
        total_meta_templates: 0,
        total_local_matched:  0,
      });
    }

    // ---- Lookup local templates voor deze WABA ----
    const { data: localRows, error: selErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, name, language, status, meta_template_id')
      .eq('business_account_id', businessAccountId);
    if (selErr) {
      console.error('[admin-meta-templates-sync] select local error:', selErr.message);
      await logAudit({
        action: 'whatsapp_meta_template.sync',
        payload: { business_account_id: businessAccountId },
        status: 'error',
        error_message: `DB select failed: ${selErr.message}`,
        userId: user.id,
      });
      return res.status(500).json({ error: selErr.message });
    }

    const localByKey = new Map();
    for (const r of (localRows || [])) {
      const key = `${r.name}:${r.language}`;
      localByKey.set(key, r);
    }

    // ---- Walk Meta-rows + UPDATE matching local rows ----
    const statusChanges = [];
    let syncedCount = 0;

    for (const meta of data) {
      const mName = meta?.name ? String(meta.name) : null;
      const mLang = meta?.language ? String(meta.language) : null;
      const mId   = meta?.id ? String(meta.id) : null;
      if (!mName || !mLang) continue;

      const key = `${mName}:${mLang}`;
      const local = localByKey.get(key);
      if (!local) continue; // skip non-local templates

      const newStatus = mapMetaStatusToInternal(meta?.status);
      if (!newStatus) continue;

      const nowIso = new Date().toISOString();
      const patch = {
        last_synced_at: nowIso,
        updated_at:     nowIso,
      };
      if (mId && mId !== local.meta_template_id) {
        patch.meta_template_id = mId;
      }

      if (newStatus !== local.status) {
        patch.status = newStatus;
        statusChanges.push({
          name:     local.name,
          language: local.language,
          from:     local.status,
          to:       newStatus,
        });
      }

      if (newStatus === 'REJECTED' && meta?.rejected_reason) {
        patch.rejection_reason = String(meta.rejected_reason);
      }
      if (newStatus === 'APPROVED' && local.status !== 'APPROVED') {
        patch.approved_at      = nowIso;
        patch.rejection_reason = null;
      }

      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_meta_templates')
        .update(patch)
        .eq('id', local.id);
      if (updErr) {
        console.error('[admin-meta-templates-sync] update error for', local.id, updErr.message);
        continue; // skip dit item, ga door met de rest
      }
      syncedCount++;
    }

    await logAudit({
      action: 'whatsapp_meta_template.sync',
      payload: {
        business_account_id:  businessAccountId,
        synced_count:         syncedCount,
        status_changes_count: statusChanges.length,
        total_meta_templates: data.length,
      },
      userId: user.id,
    });

    return res.status(200).json({
      synced_count:         syncedCount,
      status_changes:       statusChanges,
      total_meta_templates: data.length,
      total_local_matched:  syncedCount,
    });
  } catch (e) {
    console.error('[admin-meta-templates-sync] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
