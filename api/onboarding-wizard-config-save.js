// api/onboarding-wizard-config-save.js
//
// ADMIN — sla een DRAFT-structuur op voor één flow-type (geen impact op
// publieke wizard tot publish). UPSERT op de rij waar flow_type = ?type.
//
// Permission: onboarding.wizard.edit.
//
// Query:
//   ?type=1op1|membership  (verplicht; whitelist)
//
// Body:
//   { structure }   // { pages:[...] } — wordt door normalizeStructure
//                   //                   gesaneerd vóór persist.
//
// Response 200: { ok:true, type, structure }.
// Response 400: bij STRUCTURE_INVALID-fout uit normalizeStructure of
//               ongeldig/ontbrekend type.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  normalizeStructure,
  WIZARD_FLOW_TYPES,
} from './_lib/onboarding-wizard-default.js';

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
  if (!(await requirePermission(req, 'onboarding.wizard.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.wizard.edit)' });
  }

  const typeRaw = typeof req.query?.type === 'string' ? req.query.type.trim() : '';
  if (!typeRaw || !WIZARD_FLOW_TYPES.includes(typeRaw)) {
    return res.status(400).json({
      error: 'type is verplicht (' + WIZARD_FLOW_TYPES.join('|') + ')',
    });
  }
  const flowType = typeRaw;

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  let normalized;
  try {
    normalized = normalizeStructure(body.structure);
  } catch (e) {
    const msg = e?.message || 'Ongeldige structuur';
    if (msg.startsWith('STRUCTURE_INVALID')) {
      return res.status(400).json({ error: msg });
    }
    return res.status(400).json({ error: 'Ongeldige structuur' });
  }

  try {
    const nowIso = new Date().toISOString();
    // Scoped upsert: ALLEEN de rij van DEZE flow_type wordt geraakt.
    // onConflict: 'flow_type' gebruikt de unique constraint op die kolom.
    const { error: upErr } = await supabaseAdmin
      .from('onboarding_wizard')
      .upsert({
        flow_type        : flowType,
        draft_structure  : normalized,
        draft_updated_at : nowIso,
        draft_updated_by : user.id,
      }, { onConflict: 'flow_type' });
    if (upErr) throw new Error('wizard upsert: ' + upErr.message);
    return res.status(200).json({ ok: true, type: flowType, structure: normalized });
  } catch (e) {
    console.error('[onboarding-wizard-config-save]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
