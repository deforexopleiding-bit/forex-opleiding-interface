// api/dunning-call-log-create.js
// POST { customer_id, invoice_id?, sip_line?, outcome, note?, callback_at? }
// → insert een belpoging in dunning_call_log. Wordt aangeroepen na de
// "Bel nu"-flow in het case-paneel (finance.html #caseSheet Bellen-kaart).
//
// Uitkomsten (must match CHECK-constraint in migratie):
//   no_answer / voicemail / callback / payment_promise / payment_plan /
//   refused / wrong_number / paid_during_call
//
// callback_at (nieuw, sinds "belmomenten-een-bron"):
//   - Alleen toegestaan+VERPLICHT bij outcome='callback' (bewuste keuze:
//     een terugbelafspraak zonder datum is een notitie, geen afspraak;
//     dan hoort de gebruiker outcome=no_answer/voicemail te kiezen +
//     note toe te voegen). Bij andere outcomes → 400 als callback_at is
//     meegegeven (geen stille drop).
//   - Moet in de TOEKOMST liggen (nu + 1 min tolerance) — anders 400.
//   - Bij succes wordt automatisch een pending_action aangemaakt met
//     scheduled_for=callback_at zodat de taak op de juiste dag in
//     Open Acties + sidebar-badge verschijnt. Fail-soft: bij pending-
//     action-insert-fout wordt de call-log wél opgeslagen; de gebruiker
//     krijgt een warning terug in de response.
//
// Permissie: finance.dunning.execute (zelfde als de andere dunning-writes).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_OUTCOMES = new Set([
  'no_answer','voicemail','callback','payment_promise','payment_plan',
  'refused','wrong_number','paid_during_call',
]);
const VALID_LINES = new Set(['nl','be']);

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
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  const invoiceId  = typeof body.invoice_id  === 'string' && UUID_RE.test(body.invoice_id)  ? body.invoice_id  : null;
  const sipLine    = typeof body.sip_line    === 'string' && VALID_LINES.has(body.sip_line) ? body.sip_line    : null;
  const outcome    = typeof body.outcome     === 'string' && VALID_OUTCOMES.has(body.outcome) ? body.outcome    : null;
  const note       = typeof body.note        === 'string' ? body.note.trim().slice(0, 2000) : null;
  const callbackAtRaw = typeof body.callback_at === 'string' ? body.callback_at.trim() : null;

  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
  if (!outcome)    return res.status(400).json({ error: `outcome verplicht; verwacht ${Array.from(VALID_OUTCOMES).join('|')}` });

  // ─── callback_at validatie ────────────────────────────────────────────
  // Alleen toegestaan (en verplicht) bij outcome=callback. Andere outcomes
  // met callback_at → 400 (geen stille drop; klant zou anders denken dat
  // er een taak is aangemaakt terwijl 't niet zo is).
  let callbackAtIso = null;
  if (callbackAtRaw) {
    if (outcome !== 'callback') {
      return res.status(400).json({
        error: 'callback_at alleen toegestaan bij outcome=callback',
      });
    }
    const t = new Date(callbackAtRaw);
    if (!(t instanceof Date) || Number.isNaN(t.getTime())) {
      return res.status(400).json({ error: 'callback_at moet een geldige ISO-timestamp zijn' });
    }
    // Moet in de toekomst liggen (1 min tolerance voor client/server-clock-skew).
    if (t.getTime() < Date.now() - 60_000) {
      return res.status(400).json({ error: 'callback_at moet in de toekomst liggen' });
    }
    callbackAtIso = t.toISOString();
  } else if (outcome === 'callback') {
    return res.status(400).json({
      error: 'callback_at is verplicht bij outcome=callback (klant vroeg om terugbellen op datum X)',
    });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('dunning_call_log')
      .insert({
        customer_id: customerId,
        invoice_id : invoiceId,
        sip_line   : sipLine,
        outcome,
        note       : note || null,
        callback_at: callbackAtIso,
        created_by : user.id,
      })
      .select('id, customer_id, invoice_id, attempted_at, sip_line, outcome, note, callback_at, created_by, created_at')
      .single();
    if (error) throw new Error(error.message);

    // ─── pending_action voor terugbelafspraak (fail-soft) ──────────────
    // Bij outcome=callback + callback_at → maak MANUAL_FOLLOWUP-taak met
    // scheduled_for=callback_at. De pending-actions-list + tasks-list
    // filteren op scheduled_for <= now(), dus deze taak verschijnt
    // automatisch pas op de juiste datum. Geen cron nodig.
    let scheduledTaskId = null;
    let warning = null;
    if (outcome === 'callback' && callbackAtIso) {
      try {
        const insertPayload = {
          customer_id:         customerId,
          arrangement_id:      null,
          invoice_id:          invoiceId,
          action_type:         'MANUAL_FOLLOWUP',
          status:              'PENDING',
          proposed_by_user_id: user.id,
          scheduled_for:       callbackAtIso,
          payload: {
            title:         'Terugbellen — klant vroeg erom',
            description:   note
              ? `Klant vroeg om teruggebeld te worden. Notitie bij de belpoging: ${note}`
              : 'Klant vroeg om teruggebeld te worden.',
            assignee_role: 'manager',
            source:        'callback_appointment',
            kind:          'call',
            call_log_id:   data.id,
          },
        };
        const { data: taskRow, error: taskErr } = await supabaseAdmin
          .from('pending_actions')
          .insert(insertPayload)
          .select('id')
          .single();
        if (taskErr) throw new Error(taskErr.message);
        scheduledTaskId = taskRow?.id || null;
      } catch (e) {
        console.warn('[dunning-call-log-create] callback pending_action insert fail:', e?.message);
        warning = 'Belpoging opgeslagen, maar de terugbel-taak kon niet worden aangemaakt. Maak m handmatig aan in Open Acties.';
      }
    }

    return res.status(200).json({
      ok: true,
      entry: data,
      scheduled_task_id: scheduledTaskId,
      warning,
    });
  } catch (e) {
    console.error('[dunning-call-log-create]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
