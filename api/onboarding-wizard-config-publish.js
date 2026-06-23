// api/onboarding-wizard-config-publish.js
//
// ADMIN — publiceer een wizard-structuur voor één flow-type (gaat live
// voor publieke wizard van dat type). UPSERT op de rij waar
// flow_type = ?type.
//
// Permission: onboarding.wizard.edit.
//
// Query:
//   ?type=1op1|membership  (verplicht; whitelist)
//
// Body (optioneel):
//   { structure }   // — wanneer meegegeven: normaliseer + publiceer DEZE
//                   //   structuur. Wanneer afwezig: publiceer de huidige
//                   //   draft van dezelfde flow_type (of DEFAULT als draft
//                   //   + published leeg zijn).
//
// Effect (alleen op de rij van DEZE flow_type — andere rij ongemoeid):
//   - published_structure  := genormaliseerde structuur
//   - published_at         := now()
//   - published_by         := auth.uid()
//   - draft_structure      := dezelfde structuur (sync — draft mag niet
//                              achterlopen op de publicatie).
//   - draft_updated_at     := now()  / draft_updated_by := auth.uid()
//
// Response 200: { ok:true, type, structure }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  DEFAULT_WIZARD_STRUCTURE,
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
  const explicitStruct = body && body.structure ? body.structure : null;

  try {
    let candidate;
    if (explicitStruct) {
      candidate = explicitStruct;
    } else {
      // Fallback-chain: draft van DEZE flow → published van DEZE flow →
      // DEFAULT. Andere flow_type-rij wordt niet aangeraakt.
      const { data: row, error: rowErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('draft_structure, published_structure')
        .eq('flow_type', flowType)
        .maybeSingle();
      if (rowErr) throw new Error('wizard fetch: ' + rowErr.message);
      candidate = row?.draft_structure || row?.published_structure || DEFAULT_WIZARD_STRUCTURE;
    }

    let normalized;
    try {
      normalized = normalizeStructure(candidate);
    } catch (e) {
      const msg = e?.message || 'Ongeldige structuur';
      if (msg.startsWith('STRUCTURE_INVALID')) {
        return res.status(400).json({ error: msg });
      }
      return res.status(400).json({ error: 'Ongeldige structuur' });
    }

    const nowIso = new Date().toISOString();
    const { error: upErr } = await supabaseAdmin
      .from('onboarding_wizard')
      .upsert({
        flow_type           : flowType,
        draft_structure     : normalized,
        published_structure : normalized,
        draft_updated_at    : nowIso,
        draft_updated_by    : user.id,
        published_at        : nowIso,
        published_by        : user.id,
      }, { onConflict: 'flow_type' });
    if (upErr) throw new Error('wizard upsert: ' + upErr.message);

    return res.status(200).json({ ok: true, type: flowType, structure: normalized });
  } catch (e) {
    console.error('[onboarding-wizard-config-publish]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
