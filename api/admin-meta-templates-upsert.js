// api/admin-meta-templates-upsert.js
// POST  → create nieuwe whatsapp_meta_templates rij (status default = LOCAL).
// PATCH → update bestaande rij (id via ?id=<uuid> of body.id).
//         Edit alleen toegestaan als bestaande status = LOCAL of REJECTED.
// SUPER_ADMIN ONLY. Audit-log entry per mutatie.
//
// Body:
//   { business_account_id, name, language, category, header_type, header_content,
//     body_text, body_examples, footer_text, buttons }
//
// Validatie:
//   business_account_id : required text
//   name                : required, /^[a-z0-9_]+$/, max 50
//   language            : required, default 'nl', in [nl, en_US, en, de, fr]
//   category            : in [UTILITY, MARKETING, AUTHENTICATION] (default UTILITY)
//   header_type         : in [NONE, TEXT, IMAGE, VIDEO, DOCUMENT] (default NONE)
//   header_content      : jsonb — bij TEXT { text } max 60; bij IMAGE/VIDEO/DOCUMENT { example_url }
//   body_text           : required, max 1024
//   body_examples       : jsonb { "1": "...", "2": "..." }
//   footer_text         : optional, max 60
//   buttons             : jsonb array max 3, per element { type in URL/PHONE_NUMBER/QUICK_REPLY,
//                         text max 25, url? max 2000, phone_number? E.164 }
//
// INSERT: ON CONFLICT (business_account_id, name, language) → 409.
// UPDATE: alleen LOCAL of REJECTED mag muteren — anders 409.
//
// Response 200: { item: row }

import { createUserClient, supabaseAdmin } from './supabase.js';

const NAME_RX     = /^[a-z0-9_]+$/;
const E164_RX     = /^\+[1-9]\d{1,14}$/;
const LANGUAGES   = new Set(['nl', 'en_US', 'en', 'de', 'fr']);
const CATEGORIES  = new Set(['UTILITY', 'MARKETING', 'AUTHENTICATION']);
const HEADERS     = new Set(['NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);
const BUTTON_TYPES = new Set(['URL', 'PHONE_NUMBER', 'QUICK_REPLY']);

function validateBusinessAccountId(v) {
  if (typeof v !== 'string') return 'business_account_id: string vereist';
  const s = v.trim();
  if (!s) return 'business_account_id: leeg niet toegestaan';
  if (s.length > 64) return 'business_account_id: max 64 chars';
  return null;
}
function validateName(v) {
  if (typeof v !== 'string') return 'name: string vereist';
  const s = v.trim();
  if (!s) return 'name: leeg niet toegestaan';
  if (s.length > 50) return 'name: max 50 chars';
  if (!NAME_RX.test(s)) return 'name: alleen lowercase a-z, 0-9 en _';
  return null;
}
function validateLanguage(v) {
  if (typeof v !== 'string') return 'language: string vereist';
  const s = v.trim();
  if (!s) return 'language: leeg niet toegestaan';
  if (!LANGUAGES.has(s)) return `language: moet één van ${[...LANGUAGES].join(', ')} zijn`;
  return null;
}
function validateCategory(v) {
  if (typeof v !== 'string') return 'category: string vereist';
  if (!CATEGORIES.has(v)) return `category: moet één van ${[...CATEGORIES].join(', ')} zijn`;
  return null;
}
function validateHeaderType(v) {
  if (typeof v !== 'string') return 'header_type: string vereist';
  if (!HEADERS.has(v)) return `header_type: moet één van ${[...HEADERS].join(', ')} zijn`;
  return null;
}
function validateHeaderContent(headerType, v) {
  if (headerType === 'NONE') return null;
  if (v === null || v === undefined) return null; // optional bij andere types
  if (typeof v !== 'object' || Array.isArray(v)) return 'header_content: object vereist';
  if (headerType === 'TEXT') {
    if (typeof v.text !== 'string') return 'header_content.text: string vereist bij TEXT';
    if (v.text.length > 60) return 'header_content.text: max 60 chars';
  } else {
    // IMAGE / VIDEO / DOCUMENT
    if (v.example_url !== undefined && typeof v.example_url !== 'string') {
      return 'header_content.example_url: string vereist';
    }
    if (typeof v.example_url === 'string' && v.example_url.length > 2000) {
      return 'header_content.example_url: max 2000 chars';
    }
  }
  return null;
}
function validateBodyText(v) {
  if (typeof v !== 'string') return 'body_text: string vereist';
  const s = v.trim();
  if (!s) return 'body_text: leeg niet toegestaan';
  if (s.length > 1024) return 'body_text: max 1024 chars';
  return null;
}
function validateBodyExamples(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'body_examples: object vereist';
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== 'string') return `body_examples.${k}: string vereist`;
    if (val.length > 1024) return `body_examples.${k}: max 1024 chars`;
  }
  return null;
}
function validateFooterText(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return 'footer_text: string vereist';
  if (v.length > 60) return 'footer_text: max 60 chars';
  return null;
}
function validateButtons(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return 'buttons: array vereist';
  if (v.length > 3) return 'buttons: max 3 elementen';
  for (let i = 0; i < v.length; i++) {
    const b = v[i];
    if (typeof b !== 'object' || b === null || Array.isArray(b)) {
      return `buttons[${i}]: object vereist`;
    }
    if (!BUTTON_TYPES.has(b.type)) {
      return `buttons[${i}].type: moet één van ${[...BUTTON_TYPES].join(', ')} zijn`;
    }
    if (typeof b.text !== 'string' || !b.text.trim()) {
      return `buttons[${i}].text: string vereist`;
    }
    if (b.text.length > 25) return `buttons[${i}].text: max 25 chars`;
    if (b.type === 'URL') {
      if (typeof b.url !== 'string' || !b.url.trim()) {
        return `buttons[${i}].url: string vereist bij type URL`;
      }
      if (b.url.length > 2000) return `buttons[${i}].url: max 2000 chars`;
    }
    if (b.type === 'PHONE_NUMBER') {
      if (typeof b.phone_number !== 'string' || !b.phone_number.trim()) {
        return `buttons[${i}].phone_number: string vereist bij type PHONE_NUMBER`;
      }
      if (!E164_RX.test(b.phone_number.trim())) {
        return `buttons[${i}].phone_number: E.164 formaat vereist (bv. +31612345678)`;
      }
    }
  }
  return null;
}

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
    if (error) console.error('[admin-meta-templates-upsert] audit insert failed:', error.message);
  } catch (e) {
    console.error('[admin-meta-templates-upsert] audit exception:', e.message);
  }
}

const SELECT_COLS = 'id, business_account_id, meta_template_id, name, language, category, header_type, header_content, body_text, body_examples, footer_text, buttons, status, rejection_reason, submitted_at, approved_at, last_synced_at, created_at, updated_at';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const method = req.method;
  if (method !== 'POST' && method !== 'PATCH') {
    return res.status(405).json({ error: 'POST of PATCH only' });
  }

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

    const body = req.body || {};

    if (method === 'POST') {
      // -- INSERT --
      const errBaid = validateBusinessAccountId(body.business_account_id);
      if (errBaid) return res.status(400).json({ error: errBaid });
      const errName = validateName(body.name);
      if (errName) return res.status(400).json({ error: errName });

      const language = (body.language && String(body.language).trim()) || 'nl';
      const errLang = validateLanguage(language);
      if (errLang) return res.status(400).json({ error: errLang });

      const category = (body.category && String(body.category).trim()) || 'UTILITY';
      const errCat = validateCategory(category);
      if (errCat) return res.status(400).json({ error: errCat });

      const headerType = (body.header_type && String(body.header_type).trim()) || 'NONE';
      const errHt = validateHeaderType(headerType);
      if (errHt) return res.status(400).json({ error: errHt });

      const headerContent = body.header_content === undefined ? null : body.header_content;
      const errHc = validateHeaderContent(headerType, headerContent);
      if (errHc) return res.status(400).json({ error: errHc });

      const errBt = validateBodyText(body.body_text);
      if (errBt) return res.status(400).json({ error: errBt });

      const bodyExamples = body.body_examples === undefined ? null : body.body_examples;
      const errBe = validateBodyExamples(bodyExamples);
      if (errBe) return res.status(400).json({ error: errBe });

      const footerText = body.footer_text === undefined || body.footer_text === '' ? null : body.footer_text;
      const errFt = validateFooterText(footerText);
      if (errFt) return res.status(400).json({ error: errFt });

      const buttons = body.buttons === undefined ? null : body.buttons;
      const errBtn = validateButtons(buttons);
      if (errBtn) return res.status(400).json({ error: errBtn });

      const payload = {
        business_account_id: String(body.business_account_id).trim(),
        name:                String(body.name).trim(),
        language,
        category,
        header_type:         headerType,
        header_content:      headerContent,
        body_text:           String(body.body_text).trim(),
        body_examples:       bodyExamples,
        footer_text:         footerText,
        buttons,
        status:              'LOCAL',
      };

      // ON CONFLICT (business_account_id, name, language) DO NOTHING → check return.
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('whatsapp_meta_templates')
        .upsert(payload, { onConflict: 'business_account_id,name,language', ignoreDuplicates: true })
        .select(SELECT_COLS);

      if (insErr) {
        console.error('[admin-meta-templates-upsert] insert error:', insErr.message);
        await logAudit({ action: 'whatsapp_meta_template.create', payload, status: 'error', error_message: insErr.message, userId: user.id });
        return res.status(500).json({ error: insErr.message });
      }

      if (!inserted || inserted.length === 0) {
        return res.status(409).json({ error: `Template '${payload.name}' (${payload.language}) bestaat al voor deze WABA` });
      }

      const row = inserted[0];
      await logAudit({
        action: 'whatsapp_meta_template.create',
        payload: { id: row.id, business_account_id: row.business_account_id, name: row.name, language: row.language, status: row.status },
        userId: user.id,
      });
      return res.status(200).json({ item: row });
    }

    // -- PATCH --
    const id = (req.query?.id || body.id || '').toString().trim();
    if (!id) return res.status(400).json({ error: 'id vereist (query ?id=<uuid> of body.id)' });

    const { data: existing, error: getErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle();
    if (getErr) {
      console.error('[admin-meta-templates-upsert] select error:', getErr.message);
      return res.status(500).json({ error: getErr.message });
    }
    if (!existing) return res.status(404).json({ error: 'Template niet gevonden' });

    // Status-gate: alleen LOCAL of REJECTED muteerbaar.
    if (existing.status !== 'LOCAL' && existing.status !== 'REJECTED') {
      return res.status(409).json({ error: `Template met status '${existing.status}' is niet bewerkbaar (alleen LOCAL of REJECTED)` });
    }

    const updates = {};
    if (body.business_account_id !== undefined) {
      const errBaid = validateBusinessAccountId(body.business_account_id);
      if (errBaid) return res.status(400).json({ error: errBaid });
      updates.business_account_id = String(body.business_account_id).trim();
    }
    if (body.name !== undefined) {
      const errName = validateName(body.name);
      if (errName) return res.status(400).json({ error: errName });
      updates.name = String(body.name).trim();
    }
    if (body.language !== undefined) {
      const errLang = validateLanguage(body.language);
      if (errLang) return res.status(400).json({ error: errLang });
      updates.language = String(body.language).trim();
    }
    if (body.category !== undefined) {
      const errCat = validateCategory(body.category);
      if (errCat) return res.status(400).json({ error: errCat });
      updates.category = body.category;
    }
    if (body.header_type !== undefined) {
      const errHt = validateHeaderType(body.header_type);
      if (errHt) return res.status(400).json({ error: errHt });
      updates.header_type = body.header_type;
    }
    if (body.header_content !== undefined) {
      const effectiveHeaderType = updates.header_type || existing.header_type;
      const errHc = validateHeaderContent(effectiveHeaderType, body.header_content);
      if (errHc) return res.status(400).json({ error: errHc });
      updates.header_content = body.header_content;
    }
    if (body.body_text !== undefined) {
      const errBt = validateBodyText(body.body_text);
      if (errBt) return res.status(400).json({ error: errBt });
      updates.body_text = String(body.body_text).trim();
    }
    if (body.body_examples !== undefined) {
      const errBe = validateBodyExamples(body.body_examples);
      if (errBe) return res.status(400).json({ error: errBe });
      updates.body_examples = body.body_examples;
    }
    if (body.footer_text !== undefined) {
      const ft = body.footer_text === '' ? null : body.footer_text;
      const errFt = validateFooterText(ft);
      if (errFt) return res.status(400).json({ error: errFt });
      updates.footer_text = ft;
    }
    if (body.buttons !== undefined) {
      const errBtn = validateButtons(body.buttons);
      if (errBtn) return res.status(400).json({ error: errBtn });
      updates.buttons = body.buttons;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Geen velden om te updaten' });
    }
    updates.updated_at = new Date().toISOString();

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .update(updates)
      .eq('id', id)
      .select(SELECT_COLS)
      .single();

    if (updErr) {
      console.error('[admin-meta-templates-upsert] update error:', updErr.message);
      if ((updErr.code === '23505') || /duplicate key/i.test(updErr.message || '')) {
        await logAudit({ action: 'whatsapp_meta_template.update', payload: { id, updates }, status: 'error', error_message: updErr.message, userId: user.id });
        return res.status(409).json({ error: 'Combinatie business_account_id + name + language bestaat al' });
      }
      await logAudit({ action: 'whatsapp_meta_template.update', payload: { id, updates }, status: 'error', error_message: updErr.message, userId: user.id });
      return res.status(500).json({ error: updErr.message });
    }

    await logAudit({
      action: 'whatsapp_meta_template.update',
      payload: { id, before: { name: existing.name, language: existing.language, status: existing.status }, after: { name: updated.name, language: updated.language, status: updated.status } },
      userId: user.id,
    });
    return res.status(200).json({ item: updated });
  } catch (e) {
    console.error('[admin-meta-templates-upsert] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
