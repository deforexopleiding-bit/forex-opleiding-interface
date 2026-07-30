// api/pending-action-snooze.js
// POST -> zet scheduled_for op een bestaande PENDING pending_action ("Later").
//
// Deel van FASE 3 wanbetalers-herontwerp — Acties-werkcentrum. Ondersteunt de
// nieuwe "Later"-knop: taak verdwijnt uit "Te doen" en komt terug wanneer de
// gekozen datum bereikt is (pending-actions-list filtert al op
// scheduled_for IS NULL OR scheduled_for <= now).
//
// ⚠ SCHRIJF-ACTIE — bewust minimaal:
//   Muteert ALLEEN de kolom `scheduled_for` op ÉÉN rij. Raakt geen andere
//   kolommen aan (status/payload/execution_result/etc), triggert geen
//   arrangement-cascade, doet geen TL/Meta/Anthropic-calls. Dat maakt snooze
//   fully reversible via een nieuwe snooze naar een andere datum, of via een
//   snooze naar de "nu" (past terug in Te doen).
//
// Permission: finance.arrangements.approve (identiek aan approve/reject/restore).
// Rate-limit: geen — snooze is idempotent en side-effect-vrij op andere data.
//
// Request:  POST { id: uuid, scheduled_for: iso-string }
// Response 200: { ok: true, item: { id, status, scheduled_for, previous_scheduled_for } }
//
// Errors:
//   400  MISSING_ID             — id ontbreekt of geen UUID
//   400  MISSING_SCHEDULED_FOR  — scheduled_for ontbreekt of onparseerbaar
//   400  SCHEDULED_FOR_PAST     — datum is niet minimaal 1 minuut in de toekomst
//                                  (bewuste veiligheids-buffer: voorkomt dat een
//                                   snooze naar "nu-min-30s" per ongeluk de
//                                   Te-doen-filter niet triggert door clock-drift)
//   404  NOT_FOUND              — pending_action bestaat niet
//   409  NOT_PENDING            — status is niet PENDING
//                                  (snoozen van EXECUTED/REJECTED/etc. is nooit
//                                   zinvol want die staan al niet in Te doen;
//                                   fail-loud in plaats van stille no-op)
//   500  DB_ERROR               — supabase update mislukt (details in body)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { validateSnoozeInput, checkCanSnooze } from './_lib/pending-action-snooze-validate.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth: JWT + RBAC. Identiek aan pending-actions-approve/reject.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.arrangements.approve'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.arrangements.approve)' });
  }

  // Body-validatie via pure helper (unit-testbaar zonder DB).
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const v = validateSnoozeInput({ id: body.id, scheduled_for: body.scheduled_for });
  if (!v.ok) {
    return res.status(400).json({ error: v.error, code: v.code, min_future_ms: v.min_future_ms });
  }
  const id = String(body.id).trim();
  const scheduledForIso = v.scheduledForIso;

  // Rij ophalen om status + oude scheduled_for te controleren/loggen.
  const { data: row, error: loadErr } = await supabaseAdmin
    .from('pending_actions')
    .select('id, status, scheduled_for')
    .eq('id', id)
    .maybeSingle();

  if (loadErr) {
    console.error('[pending-action-snooze load]', loadErr.message);
    return res.status(500).json({ error: 'DB load fout', code: 'DB_ERROR', details: loadErr.message });
  }

  // Row-check via pure helper (unit-testbaar zonder DB).
  const canSnooze = checkCanSnooze(row);
  if (!canSnooze.ok) {
    const httpStatus = canSnooze.code === 'NOT_FOUND' ? 404 : 409;
    return res.status(httpStatus).json({
      error: canSnooze.error,
      code: canSnooze.code,
      current_status: canSnooze.current_status,
    });
  }

  const previousScheduledFor = row.scheduled_for || null;

  // Atomic write: alleen scheduled_for. Update geeft de rij terug zodat de
  // caller kan bevestigen dat er niets anders veranderd is.
  //
  // ⚠ We selecteren bewust de FULL row terug (alle kolommen) zodat de tests
  // 100% kunnen bewijzen dat status/payload/execution_result/etc onveranderd
  // zijn t.o.v. de load van 3 regels hierboven.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('pending_actions')
    .update({ scheduled_for: scheduledForIso })
    .eq('id', id)
    .eq('status', 'PENDING') // extra defense: verhindert race waarbij row net van PENDING af ging
    .select('id, status, action_type, customer_id, arrangement_id, invoice_id, payload, scheduled_for, execution_result, rejection_reason, created_at, updated_at, approved_at, executed_at')
    .maybeSingle();

  if (updErr) {
    console.error('[pending-action-snooze update]', updErr.message);
    return res.status(500).json({ error: 'DB update fout', code: 'DB_ERROR', details: updErr.message });
  }
  if (!updated) {
    // Race: rij was PENDING bij load maar niet meer bij update.
    return res.status(409).json({
      error: 'Actie is niet meer PENDING (race met andere sessie)',
      code: 'NOT_PENDING',
    });
  }

  return res.status(200).json({
    ok: true,
    item: {
      id: updated.id,
      status: updated.status,
      scheduled_for: updated.scheduled_for,
      previous_scheduled_for: previousScheduledFor,
    },
    // Full row voor debugging/tests — bewijst dat alleen scheduled_for gewijzigd is.
    row: updated,
  });
}
