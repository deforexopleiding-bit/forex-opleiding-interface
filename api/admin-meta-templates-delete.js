// api/admin-meta-templates-delete.js
// DELETE → verwijder whatsapp_meta_templates rij via ?id=<uuid>.
// SUPER_ADMIN ONLY. Audit-log entry per delete.
//
// Status-flow:
//   - LOCAL   → alleen lokaal verwijderen.
//   - REJECTED / APPROVED / PAUSED / DISABLED / SUBMITTED → eerst DELETE bij Meta
//     via Graph API; daarna lokaal opruimen. Bij Meta error #100 ("Object does
//     not exist") OF HTTP 404 wordt het tolerant overgeslagen — template is daar
//     dan al weg en lokale cleanup mag.
//
// Query: ?id=<uuid> (required)
// Response 200: { success: true, id, meta_deleted: bool }

import { createUserClient, supabaseAdmin } from './supabase.js';

const META_API_VERSION = 'v20.0';
const META_BASE_URL    = `https://graph.facebook.com/${META_API_VERSION}`;

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
    if (error) console.error('[admin-meta-templates-delete] audit insert failed:', error.message);
  } catch (e) {
    console.error('[admin-meta-templates-delete] audit exception:', e.message);
  }
}

/**
 * DELETE een template bij Meta via DELETE /{WABA_ID}/message_templates?name=...
 * Tolereert "Object does not exist" (code 100) en HTTP 404 zodat lokale cleanup
 * door kan gaan als de template bij Meta al weg is.
 *
 * Returns: { ok: true } bij success / tolerant geval.
 * Throws : Error met .status + .meta_error voor harde fouten.
 */
async function deleteTemplateAtMeta({ wabaId, templateName }) {
  const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    const err = new Error('META_WHATSAPP_ACCESS_TOKEN ontbreekt in env');
    err.status = 500;
    throw err;
  }
  if (!wabaId || !templateName) {
    const err = new Error('wabaId en templateName vereist voor Meta-delete');
    err.status = 400;
    throw err;
  }
  const url = `${META_BASE_URL}/${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(templateName)}`;
  let resp;
  try {
    resp = await fetch(url, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
  } catch (fetchErr) {
    const err = new Error('Meta API fetch failed: ' + fetchErr.message);
    err.status = 502;
    throw err;
  }
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }

  // Tolerant: 404 of error code 100 (Object does not exist) → al weg bij Meta.
  if (resp.status === 404) return { ok: true, already_gone: true };
  const metaErr = parsed && parsed.error ? parsed.error : null;
  if (metaErr && Number(metaErr.code) === 100) {
    // 100 = generieke "Object does not exist". Subcode check zou verfijning kunnen
    // bieden maar code 100 alleen is voldoende voor tolerant gedrag.
    return { ok: true, already_gone: true };
  }

  if (!resp.ok) {
    const msg = metaErr?.message || (text ? text.slice(0, 200) : `HTTP ${resp.status}`);
    const code     = metaErr?.code ?? resp.status;
    const subcode  = metaErr?.error_subcode ?? '';
    const fbtrace  = metaErr?.fbtrace_id ?? '';
    console.error('[admin-meta-templates-delete] Meta API error', {
      http_status: resp.status, meta_error: metaErr, raw_body: parsed ? undefined : text?.slice(0, 500),
    });
    const err = new Error(`Meta API ${code}: ${msg} (subcode=${subcode}, fbtrace=${fbtrace})`);
    err.status = 502;
    err.meta_error = metaErr;
    throw err;
  }
  return { ok: true, already_gone: false };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'DELETE') return res.status(405).json({ error: 'DELETE only' });

  try {
    // Auth: Bearer → user → profile.role === 'super_admin'.
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

    const id = (req.query?.id || '').toString().trim();
    if (!id) return res.status(400).json({ error: 'id vereist (query ?id=<uuid>)' });

    const { data: existing, error: getErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('id, business_account_id, meta_template_id, name, language, status')
      .eq('id', id)
      .maybeSingle();
    if (getErr) {
      console.error('[admin-meta-templates-delete] select:', getErr.message);
      return res.status(500).json({ error: getErr.message });
    }
    if (!existing) return res.status(404).json({ error: 'Template niet gevonden' });

    // Voor non-LOCAL templates eerst Meta opruimen, dan lokaal.
    let metaDeleted = false;
    let metaAlreadyGone = false;
    if (existing.status !== 'LOCAL') {
      try {
        const result = await deleteTemplateAtMeta({
          wabaId:       existing.business_account_id,
          templateName: existing.name,
        });
        metaDeleted    = true;
        metaAlreadyGone = !!result.already_gone;
      } catch (e) {
        await logAudit({
          action: 'whatsapp_meta_template.delete',
          payload: { id, before: existing, stage: 'meta_delete' },
          status: 'error',
          error_message: e.message,
          userId: user.id,
        });
        const status = e.status || 500;
        return res.status(status).json({
          error: e.message,
          meta_error: e.meta_error || null,
        });
      }
    }

    const { error: delErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .delete()
      .eq('id', id);

    if (delErr) {
      console.error('[admin-meta-templates-delete] delete:', delErr.message);
      await logAudit({
        action: 'whatsapp_meta_template.delete',
        payload: { id, before: existing, stage: 'db_delete', meta_deleted: metaDeleted },
        status: 'error',
        error_message: delErr.message,
        userId: user.id,
      });
      return res.status(500).json({ error: delErr.message });
    }

    await logAudit({
      action: 'whatsapp_meta_template.delete',
      payload: { id, before: existing, meta_deleted: metaDeleted, meta_already_gone: metaAlreadyGone },
      userId: user.id,
    });
    return res.status(200).json({
      success:         true,
      id,
      meta_deleted:    metaDeleted,
      meta_already_gone: metaAlreadyGone,
    });
  } catch (e) {
    console.error('[admin-meta-templates-delete] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
