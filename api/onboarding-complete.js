// api/onboarding-complete.js
//
// PUBLIEK POST. Finaliseer een onboarding. Input: ?t=<token (uuid)>.
// Geen body verplicht (server gebruikt huidige answers in DB).
//
// Geen createUserClient — token = auth.
// Onbekend/ongeldig token → 404 met generieke shape (geen enumeratie-leak).
//
// Gedrag:
//   - status='gearchiveerd' → 409 (gesloten).
//   - status='afgerond'     → idempotent 200 (al afgerond, geen wijziging).
//   - Server-side validatie: alle required veld-blokken in DEFAULT_WIZARD_
//     STRUCTURE moeten een niet-lege waarde in onboardings.answers hebben;
//     consent (required) → true; file_download met requires_consent →
//     answers[consent_key] === true.
//   - Bij ontbrekende velden → 400 { error, missing:[keys] }.
//   - Set status='afgerond', completed_at=now(), updated_at=now().
//
// (GEEN Bubble-call — provisioning komt in Fase 2.)

import { supabaseAdmin } from './supabase.js';
import {
  DEFAULT_WIZARD_STRUCTURE,
  validateRequired,
  resolveFlowType,
} from './_lib/onboarding-wizard-default.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const token = req.query?.t ? String(req.query.t).trim() : null;
  if (!token || !UUID_RE.test(token)) {
    return res.status(400).json({ error: 'Link niet geldig.' });
  }

  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, traject_id, status, answers, completed_at')
      .eq('token', token)
      .maybeSingle();
    if (obErr) {
      console.error('[onboarding-complete] lookup:', obErr.message);
      return res.status(500).json({ error: 'Kon link niet ophalen.' });
    }
    if (!ob) return res.status(404).json({ error: 'Link niet geldig.' });

    if (ob.status === 'gearchiveerd') {
      return res.status(409).json({ error: 'Onboarding is gesloten.' });
    }
    if (ob.status === 'afgerond') {
      // Idempotent — al afgerond, geen verandering nodig.
      return res.status(200).json({ ok: true, already_completed: true });
    }

    const answers = (ob.answers && typeof ob.answers === 'object') ? ob.answers : {};

    // Flow-type bepalen (identiek aan onboarding-wizard-get).
    let flowType = '1op1';
    if (ob.traject_id) {
      try {
        const { data: traj, error: trajErr } = await supabaseAdmin
          .from('onboarding_trajecten')
          .select('type')
          .eq('id', ob.traject_id)
          .maybeSingle();
        if (trajErr) {
          console.warn('[onboarding-complete] traject lookup:', trajErr.message);
        } else {
          flowType = resolveFlowType(traj?.type);
        }
      } catch (e) {
        console.warn('[onboarding-complete] traject exception:', e?.message || e);
      }
    }

    // Valideer tegen de gepubliceerde structuur van DEZE flow_type
    // (fail-soft → DEFAULT). Zelfde structuur die de student ziet in de
    // wizard, zodat een wijziging op '1op1' geen 'membership' breekt.
    let publishedStructure = null;
    try {
      const { data: wiz, error: wizErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('published_structure')
        .eq('flow_type', flowType)
        .maybeSingle();
      if (wizErr) {
        console.warn('[onboarding-complete] wizard config fetch:', wizErr.message);
      } else if (wiz?.published_structure?.pages) {
        publishedStructure = wiz.published_structure;
      }
    } catch (e) {
      console.warn('[onboarding-complete] wizard config exception:', e?.message || e);
    }
    const struct = publishedStructure || DEFAULT_WIZARD_STRUCTURE;

    const { ok: valid, missing } = validateRequired(answers, struct);
    if (!valid) {
      return res.status(400).json({
        error   : 'Niet alle verplichte velden zijn ingevuld.',
        missing,
      });
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update({
        status       : 'afgerond',
        completed_at : nowIso,
        updated_at   : nowIso,
      })
      .eq('id', ob.id);
    if (updErr) {
      console.error('[onboarding-complete] update:', updErr.message);
      return res.status(500).json({ error: 'Afronden mislukt.' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[onboarding-complete] fatal:', e?.message || e);
    return res.status(500).json({ error: 'Afronden mislukt.' });
  }
}
