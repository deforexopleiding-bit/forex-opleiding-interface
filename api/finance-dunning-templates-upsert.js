// api/finance-dunning-templates-upsert.js
// POST   → create een dunning_template
// PATCH  → update een dunning_template (vereist ?id=<uuid> of body.id)
// Permission: finance.dunning.config (beheer-rechten).
//
// Body (alle velden behalve marked optional):
//   name              text  required
//   kind              'email' | 'whatsapp'  required
//   subject           text  required als kind='email', anders genegeerd
//   body              text  required (template-tekst met {{VARIABELEN}})
//   meta_template_name text optional (alleen relevant voor whatsapp; exacte naam
//                                     van approved Meta template)
//   language          text  optional (default 'nl')
//   is_active         bool  optional (default true)
//
// Response: { item: { ...row } } bij success, of { error } bij validatie/server-fout.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const VALID_KINDS = ['email', 'whatsapp'];
const MAX_NAME = 200;
const MAX_SUBJECT = 500;
const MAX_BODY = 50000;          // royaal — templates kunnen lang zijn
const MAX_META_NAME = 200;

function validate(body, isUpdate) {
  const errors = [];
  const out = {};

  if (!isUpdate || body.name !== undefined) {
    const v = String(body.name || '').trim();
    if (!v) errors.push('name vereist');
    else if (v.length > MAX_NAME) errors.push(`name max ${MAX_NAME} chars`);
    else out.name = v;
  }

  if (!isUpdate || body.kind !== undefined) {
    const v = String(body.kind || '').toLowerCase();
    if (!VALID_KINDS.includes(v)) errors.push(`kind moet ${VALID_KINDS.join(' of ')} zijn`);
    else out.kind = v;
  }
  // Voor validatie van subject/body hebben we de uiteindelijke kind nodig.
  // Bij update: lees bestaande kind als niet meegestuurd. Caller-side: subject-check
  // wordt overgeslagen als kind niet bekend is — vervolgens valt 'ie alsnog door
  // de DB CHECK constraints.

  if (!isUpdate || body.body !== undefined) {
    const v = String(body.body || '').trim();
    if (!v) errors.push('body vereist');
    else if (v.length > MAX_BODY) errors.push(`body max ${MAX_BODY} chars`);
    else out.body = v;
  }

  if (body.subject !== undefined) {
    const v = String(body.subject || '').trim() || null;
    if (v && v.length > MAX_SUBJECT) errors.push(`subject max ${MAX_SUBJECT} chars`);
    out.subject = v;
  }

  if (body.meta_template_name !== undefined) {
    const v = String(body.meta_template_name || '').trim() || null;
    if (v && v.length > MAX_META_NAME) errors.push(`meta_template_name max ${MAX_META_NAME} chars`);
    out.meta_template_name = v;
  }

  if (body.language !== undefined) {
    const v = String(body.language || 'nl').trim().toLowerCase();
    if (v.length !== 2) errors.push('language moet 2-letter code zijn (bv. nl, en)');
    else out.language = v;
  }

  if (body.is_active !== undefined) {
    out.is_active = body.is_active === true || body.is_active === 'true';
  }

  return { errors, out };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'POST, PATCH');
    return res.status(405).json({ error: 'POST of PATCH' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.config'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.config)' });
  }

  const body = req.body || {};
  const isUpdate = req.method === 'PATCH';
  const id = isUpdate ? (req.query?.id || body.id || null) : null;

  if (isUpdate && !id) return res.status(400).json({ error: 'id vereist bij PATCH (?id=<uuid> of body.id)' });

  const { errors, out } = validate(body, isUpdate);
  if (errors.length) return res.status(400).json({ error: errors.join(', '), errors });

  try {
    // Voor subject-check hebben we kind nodig. Bij update lees existing als 't niet meegegeven is.
    let kindForCheck = out.kind || null;
    let existingRow = null;
    if (isUpdate) {
      const { data: row, error } = await supabaseAdmin
        .from('dunning_templates').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error('lookup: ' + error.message);
      if (!row) return res.status(404).json({ error: 'Template niet gevonden' });
      existingRow = row;
      if (!kindForCheck) kindForCheck = row.kind;
    }
    if (kindForCheck === 'email' && (!isUpdate || out.subject !== undefined)) {
      const finalSubject = out.subject !== undefined ? out.subject : existingRow?.subject;
      if (!finalSubject || !String(finalSubject).trim()) {
        return res.status(400).json({ error: 'subject vereist voor kind=email' });
      }
    }

    if (isUpdate) {
      const payload = { ...out, updated_at: new Date().toISOString() };
      const { data: updated, error } = await supabaseAdmin
        .from('dunning_templates').update(payload).eq('id', id)
        .select('id, name, kind, subject, body, meta_template_name, language, is_active, created_at, updated_at')
        .single();
      if (error) throw new Error('update: ' + error.message);
      await auditLog(user.id, 'finance_dunning_template.update', id, { fields: Object.keys(out) }, req).catch(() => {});
      return res.status(200).json({ item: updated });
    } else {
      // INSERT — bepaal defaults voor optionele velden.
      const insertRow = {
        name:               out.name,
        kind:               out.kind,
        subject:            out.subject ?? null,
        body:               out.body,
        meta_template_name: out.meta_template_name ?? null,
        language:           out.language ?? 'nl',
        is_active:          out.is_active !== undefined ? out.is_active : true,
      };
      const { data: created, error } = await supabaseAdmin
        .from('dunning_templates').insert(insertRow)
        .select('id, name, kind, subject, body, meta_template_name, language, is_active, created_at, updated_at')
        .single();
      if (error) throw new Error('insert: ' + error.message);
      await auditLog(user.id, 'finance_dunning_template.create', created.id, { name: created.name, kind: created.kind }, req).catch(() => {});
      return res.status(201).json({ item: created });
    }
  } catch (e) {
    console.error('[finance-dunning-templates-upsert]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function auditLog(userId, action, entityId, after, req) {
  try {
    await supabaseAdmin.from('audit_log').insert({
      user_id: userId, action, entity_type: 'dunning_template', entity_id: entityId,
      after_json: after, ip_address: getClientIp(req),
    });
  } catch (e) { console.error('[dunning-template audit]', e.message); }
}
