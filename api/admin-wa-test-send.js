// api/admin-wa-test-send.js
//
// Super_admin-gated diagnostisch endpoint: stuurt EEN test-WhatsApp via
// sendTemplate en retourneert de rauwe Meta API-response (status + body)
// zonder de fout op te slokken. Voor debug van welkom-lijn (leadsonderhoud)
// vs finance-lijn.
//
// POST { to: '+31<...>', template?: 'reminder_toegang_2u',
//        language?: 'nl', var1?: 'Jeffrey', include_finance?: true }
//
// Doet 2 sends parallel als include_finance=true:
//   1) welkom  — phone_number_id uit whatsapp_module_config module='leadsonderhoud'
//   2) finance — phone_number_id uit whatsapp_module_config module='finance'
//        (voor vergelijking; skip als include_finance !== true)
//
// Retourneert per send:
//   { line: 'welkom'|'finance', module_key, phone_number_id, ok, wamid?,
//     error?, meta_code?, meta_subcode?, meta_details?, meta_fbtrace?, http_status? }
//
// GEEN writes. Puur test-send. Auth: super_admin JWT Bearer.
// 0 incasso-writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';

const PHONE_RE = /^\+?[0-9][0-9\s()-]{6,}$/;

async function resolvePhoneId(module) {
  const { data } = await supabaseAdmin
    .from('whatsapp_module_config')
    .select('phone_number_id, display_label, is_active')
    .eq('module', module)
    .eq('is_active', true)
    .maybeSingle();
  return data || null;
}

async function testSend({ line, moduleKey, to, templateName, languageCode, var1 }) {
  const cfgRow = await resolvePhoneId(moduleKey);
  const result = {
    line,
    module_key      : moduleKey,
    module_label    : cfgRow?.display_label || null,
    phone_number_id : cfgRow?.phone_number_id || null,
    to,
    template        : templateName,
    language        : languageCode,
    var1,
    ok              : false,
  };
  if (!cfgRow?.phone_number_id) {
    result.error = `Geen actieve whatsapp_module_config-rij voor module='${moduleKey}'`;
    return result;
  }
  try {
    const { wamid } = await sendTemplate({
      to,
      templateName,
      languageCode,
      variables: [var1],
      phoneNumberId: cfgRow.phone_number_id,
    });
    result.ok    = true;
    result.wamid = wamid;
    return result;
  } catch (e) {
    if (e instanceof MetaNotConfiguredError) {
      result.error = 'Meta niet geconfigureerd: ' + (e.missing || []).join(', ');
      return result;
    }
    // De metaPostMessage-error draagt alle rauwe Meta-velden mee.
    result.error       = e?.message || String(e);
    result.http_status = e?.httpStatus ?? null;
    result.meta_code    = e?.metaCode ?? null;
    result.meta_subcode = e?.metaSubcode ?? null;
    result.meta_message = e?.metaMessage ?? null;
    result.meta_details = e?.metaDetails ?? null;
    result.meta_fbtrace = e?.metaFbtrace ?? null;
    result.meta_error_data = e?.metaErrorData ?? null;
    return result;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth: super_admin JWT Bearer.
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile } = await supabaseAdmin
    .from('profiles').select('id, role, is_active').eq('id', user.id).single();
  if (!profile)              return res.status(403).json({ error: 'Geen profiel gevonden' });
  if (!profile.is_active)    return res.status(403).json({ error: 'Account inactief' });
  if (profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const to             = String(body.to || '').trim();
  const templateName   = String(body.template || 'reminder_toegang_2u').trim();
  const languageCode   = String(body.language || 'nl').trim();
  const var1           = String(body.var1 || 'Jeffrey').trim();
  const includeFinance = body.include_finance === true;

  if (!to || !PHONE_RE.test(to)) {
    return res.status(400).json({ error: 'to (E.164) vereist, bv. "+31612345678"' });
  }

  const welkomResult = await testSend({
    line: 'welkom',
    moduleKey: 'leadsonderhoud',
    to, templateName, languageCode, var1,
  });

  let financeResult = null;
  if (includeFinance) {
    financeResult = await testSend({
      line: 'finance',
      moduleKey: 'finance',
      to, templateName, languageCode, var1,
    });
  }

  return res.status(200).json({
    ok: true,
    to, template: templateName, language: languageCode, var1,
    welkom : welkomResult,
    finance: financeResult,
  });
}
