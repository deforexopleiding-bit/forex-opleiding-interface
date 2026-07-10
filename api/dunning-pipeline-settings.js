// api/dunning-pipeline-settings.js
// GET → auto-toggles ('dunning_pipeline_auto').
// POST { toggles: {on_overdue_to_nieuw?, on_bulk_sent_to_aangemaand?,
//                  on_inbound_to_in_gesprek?, on_paid_to_opgelost?} }
// Alleen bekende boolean-keys worden geaccepteerd.
//
// Permission: finance.dunning.execute.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const KEY = 'dunning_pipeline_auto';
const VALID_TOGGLES = [
  'on_overdue_to_nieuw',
  'on_bulk_sent_to_aangemaand',
  'on_inbound_to_in_gesprek',
  'on_paid_to_opgelost',
];
const DEFAULT_VALUE = VALID_TOGGLES.reduce((acc, k) => (acc[k] = true, acc), {});

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  if (req.method === 'GET') {
    try {
      const { data } = await supabaseAdmin
        .from('app_settings').select('value, updated_at').eq('key', KEY).maybeSingle();
      const v = (data?.value && typeof data.value === 'object') ? data.value : {};
      const out = { ...DEFAULT_VALUE };
      for (const k of VALID_TOGGLES) if (typeof v[k] === 'boolean') out[k] = v[k];
      return res.status(200).json({ toggles: out, is_default: !data, updated_at: data?.updated_at || null });
    } catch (e) {
      console.error('[dunning-pipeline-settings GET]', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    const toggles = body?.toggles && typeof body.toggles === 'object' ? body.toggles : null;
    if (!toggles) return res.status(400).json({ error: 'toggles-object vereist' });
    const clean = {};
    for (const k of VALID_TOGGLES) {
      if (typeof toggles[k] === 'boolean') clean[k] = toggles[k];
    }
    if (Object.keys(clean).length === 0) return res.status(400).json({ error: 'Geen geldige toggles' });

    try {
      // Merge met bestaande waarde zodat een partial-update de rest niet resetten.
      const { data: cur } = await supabaseAdmin
        .from('app_settings').select('value').eq('key', KEY).maybeSingle();
      const merged = { ...DEFAULT_VALUE, ...((cur?.value && typeof cur.value === 'object') ? cur.value : {}), ...clean };
      if (cur) {
        const { error: uErr } = await supabaseAdmin
          .from('app_settings').update({ value: merged, updated_at: new Date().toISOString() }).eq('key', KEY);
        if (uErr) throw new Error(uErr.message);
      } else {
        const { error: iErr } = await supabaseAdmin
          .from('app_settings').insert({ key: KEY, value: merged });
        if (iErr) throw new Error(iErr.message);
      }
      try {
        await supabaseAdmin.from('audit_log').insert({
          user_id: user.id, action: 'dunning_pipeline_settings.update',
          entity_type: 'app_settings', entity_id: null,
          after_json: { key: KEY, changes: clean, result: merged },
          reason_text: 'Pipeline auto-toggles gewijzigd', ip_address: getClientIp(req),
        });
      } catch (e) { console.warn('[dunning-pipeline-settings] audit soft-fail', e?.message || e); }
      return res.status(200).json({ ok: true, toggles: merged });
    } catch (e) {
      console.error('[dunning-pipeline-settings POST]', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  return res.status(405).json({ error: 'GET or POST' });
}
