// api/joost-mark-outcome.js
// POST -> markeer outcome op een joost_suggestions rij (PROPOSED -> USED_*/IGNORED/DISMISSED).
//
// Permission: finance.joost.use (strict — geen fallback).
//
// Body:
//   {
//     suggestion_id:          uuid (required),
//     status:                 'USED_AS_IS' | 'USED_EDITED' | 'IGNORED' | 'DISMISSED'
//                              | 'USED_TASK_CREATED' | 'USED_ARRANGEMENT_OPENED' (required),
//     final_sent_text:        string (optional — verplicht bij USED_AS_IS + USED_EDITED),
//     outcome_notes:          string (optional),
//     linked_task_id:         uuid   (optional — verplicht bij USED_TASK_CREATED),
//     linked_arrangement_id:  uuid   (optional — verplicht bij USED_ARRANGEMENT_OPENED)
//   }
//
// Validatie:
//   - suggestion_id moet bestaan + huidige status='PROPOSED' (anders 409).
//   - USED_AS_IS:               final_sent_text vereist (= suggested_reply normaal).
//   - USED_EDITED:              final_sent_text vereist (= aangepaste tekst).
//   - USED_TASK_CREATED:        linked_task_id vereist.
//   - USED_ARRANGEMENT_OPENED:  linked_arrangement_id vereist.
//   - IGNORED / DISMISSED:      final_sent_text optioneel.
//
// Audit (audit_log, fail-soft):
//   action      = 'joost.outcome_marked'
//   entity_type = 'joost_suggestion'
//   entity_id   = suggestion_id
//   after_json  = { suggestion_id, status, linked_task_id?, linked_arrangement_id? }
//
// Response 200: { suggestion: updated_row }
// Error responses:
//   400  body/validatie-fout
//   401  geen sessie
//   403  geen finance.joost.use rechten
//   404  suggestion niet gevonden
//   409  suggestion niet in PROPOSED state
//   500  database-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { checkOnboardingConvAccess } from './_lib/onboardingScope.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = [
  'USED_AS_IS',
  'USED_EDITED',
  'IGNORED',
  'DISMISSED',
  'USED_TASK_CREATED',
  'USED_ARRANGEMENT_OPENED',
];
const STATUSES_REQUIRING_TEXT = ['USED_AS_IS', 'USED_EDITED'];
const MAX_TEXT_LEN = 10000;
const MAX_NOTES_LEN = 2000;

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // ---- Permission (module-conditioned, gecheckt na suggestion-load) ----
  // Default = finance.joost.use; voor module='events' valt 'm op events.simone.use.
  // De suggestion-row is autoritatief voor de module-discriminator, niet de body
  // (anti-spoofing). Body bevat geen module-veld om dezelfde reden.

  // ---- Body parsen ----
  const body = req.body || {};

  const suggestionId = typeof body.suggestion_id === 'string' ? body.suggestion_id.trim() : '';
  if (!suggestionId) return res.status(400).json({ error: 'suggestion_id vereist' });
  if (!isUuid(suggestionId)) {
    return res.status(400).json({ error: 'suggestion_id moet geldige uuid zijn' });
  }

  const statusRaw = typeof body.status === 'string' ? body.status.trim() : '';
  if (!statusRaw) return res.status(400).json({ error: 'status vereist' });
  if (!VALID_STATUSES.includes(statusRaw)) {
    return res.status(400).json({
      error: `status moet één van [${VALID_STATUSES.join(', ')}] zijn`,
    });
  }
  const newStatus = statusRaw;

  let finalSentText = null;
  if (body.final_sent_text !== undefined && body.final_sent_text !== null) {
    if (typeof body.final_sent_text !== 'string') {
      return res.status(400).json({ error: 'final_sent_text: string vereist' });
    }
    const s = body.final_sent_text.trim();
    if (s.length > MAX_TEXT_LEN) {
      return res.status(400).json({ error: `final_sent_text: max ${MAX_TEXT_LEN} chars` });
    }
    finalSentText = s.length > 0 ? s : null;
  }

  if (STATUSES_REQUIRING_TEXT.includes(newStatus) && !finalSentText) {
    return res.status(400).json({
      error: `final_sent_text vereist bij status=${newStatus}`,
    });
  }

  let outcomeNotes = null;
  if (body.outcome_notes !== undefined && body.outcome_notes !== null) {
    if (typeof body.outcome_notes !== 'string') {
      return res.status(400).json({ error: 'outcome_notes: string vereist' });
    }
    const s = body.outcome_notes.trim();
    if (s.length > MAX_NOTES_LEN) {
      return res.status(400).json({ error: `outcome_notes: max ${MAX_NOTES_LEN} chars` });
    }
    outcomeNotes = s.length > 0 ? s : null;
  }

  // linked_task_id (optioneel, verplicht bij USED_TASK_CREATED)
  let linkedTaskId = null;
  if (body.linked_task_id !== undefined && body.linked_task_id !== null && body.linked_task_id !== '') {
    if (typeof body.linked_task_id !== 'string' || !isUuid(body.linked_task_id.trim())) {
      return res.status(400).json({ error: 'linked_task_id moet geldige uuid zijn' });
    }
    linkedTaskId = body.linked_task_id.trim();
  }
  if (newStatus === 'USED_TASK_CREATED' && !linkedTaskId) {
    return res.status(400).json({ error: 'linked_task_id vereist bij status=USED_TASK_CREATED' });
  }

  // linked_arrangement_id (optioneel, verplicht bij USED_ARRANGEMENT_OPENED)
  let linkedArrangementId = null;
  if (
    body.linked_arrangement_id !== undefined &&
    body.linked_arrangement_id !== null &&
    body.linked_arrangement_id !== ''
  ) {
    if (typeof body.linked_arrangement_id !== 'string' || !isUuid(body.linked_arrangement_id.trim())) {
      return res.status(400).json({ error: 'linked_arrangement_id moet geldige uuid zijn' });
    }
    linkedArrangementId = body.linked_arrangement_id.trim();
  }
  if (newStatus === 'USED_ARRANGEMENT_OPENED' && !linkedArrangementId) {
    return res.status(400).json({
      error: 'linked_arrangement_id vereist bij status=USED_ARRANGEMENT_OPENED',
    });
  }

  try {
    // ========================================================================
    // STAP 1: huidige suggestion ophalen + valideren
    // ========================================================================
    const { data: current, error: selErr } = await supabaseAdmin
      .from('joost_suggestions')
      .select('id, status, suggested_reply, conversation_id, module')
      .eq('id', suggestionId)
      .maybeSingle();
    if (selErr) {
      console.error('[joost-mark-outcome] select error:', selErr.message);
      return res.status(500).json({ error: selErr.message });
    }
    if (!current) {
      return res.status(404).json({ error: 'Suggestion niet gevonden' });
    }
    // Toegestaan om een outcome te zetten op elke suggestie waar de LLM een
    // bruikbare draft aanleverde — PROPOSED of één van de 5 BLOCKED_*-
    // statussen die de autonomy-gate blokkeerde (mens ziet 'em als draft
    // via joost-suggestions-recent en kan 'm alsnog USED_AS_IS/USED_EDITED-
    // versturen of IGNORED/DISMISSED zetten). Statussen zonder bruikbare
    // draft (bv. SENT_AUTONOMOUSLY, USED_*) blijven ongewijzigd geweigerd.
    const OUTCOMEABLE_CURRENT_STATUSES = new Set([
      'PROPOSED',
      'BLOCKED_LOW_CONFIDENCE',
      'BLOCKED_INTENT_DISABLED',
      'BLOCKED_COMMUNICATION_LIMIT',
      'BLOCKED_MANDATE_EXCEEDED',
      'BLOCKED_AUTONOMY_PAUSED',
    ]);
    if (!OUTCOMEABLE_CURRENT_STATUSES.has(current.status)) {
      return res.status(409).json({
        error: 'Suggestion is niet in een outcome-bare state (PROPOSED of BLOCKED_*)',
        current_status: current.status,
      });
    }

    // Module-conditioned permission check — row is autoritatief.
    // Map identiek aan PERM_BY_MODULE in api/joost-suggestions-recent.js
    // zodat onboarding-Mila-suggesties op 'onboarding.mila.use' gate'n
    // (eerder viel 'm terug op finance.joost.use, wat 403'de bij
    // Negeren/Gebruiken vanuit de onboarding-inbox).
    const PERM_BY_MODULE = {
      finance:    'finance.joost.use',
      events:     'events.simone.use',
      onboarding: 'onboarding.mila.use',
    };
    const permKey = PERM_BY_MODULE[current.module] || 'finance.joost.use';
    if (!(await requirePermission(req, permKey))) {
      return res.status(403).json({ error: 'Geen rechten (' + permKey + ')' });
    }

    // Fase 2b: voor onboarding-suggesties → mentor mag alleen z'n eigen.
    // Conv-fetch voor de ACL hook. Hook skipt voor seesAll en voor
    // finance/events-convs. Bij module=onboarding zonder geldige conv-link:
    // fail-closed (return 403 — strikter is veiliger).
    if (current.module === 'onboarding' && current.conversation_id) {
      try {
        const { data: convAcl } = await supabaseAdmin
          .from('whatsapp_conversations')
          .select('phone_number_id, customer_id')
          .eq('id', current.conversation_id)
          .maybeSingle();
        if (convAcl) {
          const acl = await checkOnboardingConvAccess(req, {
            phoneNumberId: convAcl.phone_number_id,
            customerId:    convAcl.customer_id,
          });
          if (!acl.ok) return res.status(acl.status).json({ error: acl.error });
        }
      } catch (e) {
        console.error('[joost-mark-outcome] ACL lookup:', e?.message || e);
        return res.status(500).json({ error: 'Toegangscontrole faalde' });
      }
    }

    // ========================================================================
    // STAP 2: update uitvoeren
    // ========================================================================
    const nowIso = new Date().toISOString();
    const updates = {
      status:                newStatus,
      final_sent_text:       finalSentText,
      outcome_notes:         outcomeNotes,
      used_by_user_id:       user.id,
      used_at:               nowIso,
      linked_task_id:        linkedTaskId,
      linked_arrangement_id: linkedArrangementId,
    };

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('joost_suggestions')
      .update(updates)
      .eq('id', suggestionId)
      .select(
        'id, conversation_id, module, suggested_reply, detected_intent, ' +
        'confidence, reasoning, status, final_sent_text, outcome_notes, ' +
        'requested_by_user_id, used_by_user_id, created_at, used_at, ' +
        'linked_task_id, linked_arrangement_id'
      )
      .single();
    if (updErr) {
      console.error('[joost-mark-outcome] update error:', updErr.message);
      return res.status(500).json({ error: updErr.message });
    }

    // ========================================================================
    // STAP 3: audit-log (fail-soft)
    // ========================================================================
    try {
      const afterJson = {
        suggestion_id: suggestionId,
        status:        newStatus,
      };
      if (linkedTaskId)        afterJson.linked_task_id        = linkedTaskId;
      if (linkedArrangementId) afterJson.linked_arrangement_id = linkedArrangementId;

      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'joost.outcome_marked',
        entity_type: 'joost_suggestion',
        entity_id:   suggestionId,
        after_json:  afterJson,
        reason_text: outcomeNotes ? outcomeNotes.slice(0, 500) : null,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[joost-mark-outcome audit]', e.message);
    }

    // ========================================================================
    // STAP 4: response
    // ========================================================================
    return res.status(200).json({ suggestion: updated });
  } catch (e) {
    console.error('[joost-mark-outcome]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
