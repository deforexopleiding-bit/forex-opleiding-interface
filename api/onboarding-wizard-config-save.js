// api/onboarding-wizard-config-save.js
//
// ADMIN — sla een DRAFT-structuur op (geen impact op publieke wizard tot
// publish). Singleton op onboarding_wizard.id = 1; UPSERT.
//
// Permission: onboarding.wizard.edit.
//
// Body:
//   { structure }   // { pages:[...] } — wordt door normalizeStructure
//                   //                   gesaneerd vóór persist.
//
// Response 200: { ok:true, structure }.
// Response 400: bij STRUCTURE_INVALID-fout uit normalizeStructure.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { normalizeStructure } from './_lib/onboarding-wizard-default.js';

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
    const { error: upErr } = await supabaseAdmin
      .from('onboarding_wizard')
      .upsert({
        id               : 1,
        draft_structure  : normalized,
        draft_updated_at : nowIso,
        draft_updated_by : user.id,
      }, { onConflict: 'id' });
    if (upErr) throw new Error('wizard upsert: ' + upErr.message);
    return res.status(200).json({ ok: true, structure: normalized });
  } catch (e) {
    console.error('[onboarding-wizard-config-save]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
