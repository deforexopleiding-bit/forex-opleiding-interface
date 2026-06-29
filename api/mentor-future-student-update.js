// api/mentor-future-student-update.js
//
// POST — mentor zet een handmatige intake-status of voegt een notitie toe op
// een onboarding die aan HEM/HAAR is toegewezen. Voor "Toekomstige studenten"
// in mentor-students.html (toekomst-tab).
//
// Body: { onboarding_id: uuid, status?: enum, note?: string }
//
//   status (optioneel) ∈ { nog_te_benaderen, geen_gehoor, wil_later, wil_niet }
//     → update onboardings.mentor_intake_status + insert log-rij (kind:'status').
//   note (optioneel zónder status, verplicht als er geen status is)
//     → insert log-rij (kind:'note').
//
// Gate (mentor.module.access) + OWNERSHIP-check: onboarding.mentor_user_id
// MOET gelijk zijn aan de ingelogde user-id, anders 403. Auto-statussen
// "Gestart" en "Call ingepland" worden NIET hier gezet (afgeleid in UI uit
// 1-op-1 sessies).
//
// Response 200: { ok:true, update:{kind,status,note,created_at,created_by} }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Handmatige intake-statussen — exact deze whitelist. Auto-status-keys
// ("call_ingepland", "gestart") worden bewust geweigerd: die zijn afgeleid.
const ALLOWED_STATUS = new Set([
  'nog_te_benaderen',
  'geen_gehoor',
  'wil_later',
  'wil_niet',
]);

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!onboardingId || !UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) is verplicht.' });
  }

  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status') && body.status != null;
  const status    = hasStatus ? String(body.status).trim() : null;
  if (hasStatus && !ALLOWED_STATUS.has(status)) {
    return res.status(400).json({ error: 'Ongeldige status. Toegestaan: ' + Array.from(ALLOWED_STATUS).join(', ') });
  }

  const noteRaw = (body.note == null) ? '' : String(body.note).trim();
  const note    = noteRaw.length > 0 ? noteRaw.slice(0, 2000) : null;

  if (!status && !note) {
    return res.status(400).json({ error: 'Geef minstens status óf note mee.' });
  }

  try {
    // Ownership-gate: alleen de toegewezen mentor mag deze rij bewerken.
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, mentor_user_id')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding fetch: ' + obErr.message);
    if (!ob) return res.status(404).json({ error: 'Onboarding niet gevonden.' });
    if (!ob.mentor_user_id || ob.mentor_user_id !== user.id) {
      return res.status(403).json({ error: 'Deze onboarding is niet aan jou toegewezen.' });
    }

    // 1) Status zetten (indien meegegeven) → onboardings.mentor_intake_status.
    if (status) {
      const { error: updErr } = await supabaseAdmin
        .from('onboardings')
        .update({ mentor_intake_status: status })
        .eq('id', onboardingId);
      if (updErr) throw new Error('intake-status update: ' + updErr.message);
    }

    // 2) Log-rij in onboarding_mentor_updates.
    //    - status meegegeven → kind:'status' (note optioneel meegestuurd).
    //    - alleen note       → kind:'note'.
    const logRow = {
      onboarding_id: onboardingId,
      kind:          status ? 'status' : 'note',
      status:        status || null,
      note:          note   || null,
      created_by:    user.id,
    };
    const { data: inserted, error: logErr } = await supabaseAdmin
      .from('onboarding_mentor_updates')
      .insert(logRow)
      .select('kind, status, note, created_at, created_by')
      .single();
    if (logErr) throw new Error('mentor_update log insert: ' + logErr.message);

    return res.status(200).json({ ok: true, update: inserted });
  } catch (e) {
    console.error('[mentor-future-student-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
