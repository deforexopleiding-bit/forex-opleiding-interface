// api/mentor-future-student-update.js
//
// POST — mentor zet een handmatige intake-status of voegt een notitie toe op
// een onboarding die aan HEM/HAAR is toegewezen. Voor "Toekomstige studenten"
// in mentor-students.html (toekomst-tab).
//
// Body: { onboarding_id: uuid, status?: enum|null, note?: string }
//
//   status (optioneel) ∈ { nog_te_benaderen, geen_gehoor, wil_later, wil_niet }
//     → update onboardings.mentor_intake_status + insert log-rij (kind:'status').
//   status === null      → expliciet wissen (terug naar auto-afleiding).
//     → mentor_intake_status = null + log-rij (kind:'status', status=null,
//       note='Handmatige status gewist').
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

  // status kan 3 vormen aannemen:
  //   - niet aanwezig (key ontbreekt) → notitie-only pad
  //   - whitelist-string             → set status
  //   - expliciet null               → CLEAR (terug naar auto-afleiding)
  const statusKeyGiven = Object.prototype.hasOwnProperty.call(body, 'status');
  const isClear        = statusKeyGiven && body.status === null;
  const hasStatusValue = statusKeyGiven && body.status != null;
  const status         = hasStatusValue ? String(body.status).trim() : null;
  if (hasStatusValue && !ALLOWED_STATUS.has(status)) {
    return res.status(400).json({ error: 'Ongeldige status. Toegestaan: ' + Array.from(ALLOWED_STATUS).join(', ') + ', null' });
  }

  const noteRaw = (body.note == null) ? '' : String(body.note).trim();
  const note    = noteRaw.length > 0 ? noteRaw.slice(0, 2000) : null;

  if (!status && !isClear && !note) {
    return res.status(400).json({ error: 'Geef minstens status, status:null (clear) óf note mee.' });
  }

  try {
    // Ownership-gate: alleen de toegewezen mentor mag deze rij bewerken.
    // customer_name wordt mee-opgehaald voor de manager-melding bij
    // probleem-statussen (zie blok onderaan na de log-insert).
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, mentor_user_id, customer_name')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding fetch: ' + obErr.message);
    if (!ob) return res.status(404).json({ error: 'Onboarding niet gevonden.' });
    if (!ob.mentor_user_id || ob.mentor_user_id !== user.id) {
      return res.status(403).json({ error: 'Deze onboarding is niet aan jou toegewezen.' });
    }

    // 1) Status zetten of WISSEN → onboardings.mentor_intake_status.
    //    Bij isClear schrijven we expliciet null zodat de intake-afleiding
    //    terugvalt op de auto-status (gestart / no_show / call_ingepland)
    //    of nog_te_benaderen.
    if (status || isClear) {
      const { error: updErr } = await supabaseAdmin
        .from('onboardings')
        .update({ mentor_intake_status: status || null })
        .eq('id', onboardingId);
      if (updErr) throw new Error('intake-status update: ' + updErr.message);
    }

    // 2) Log-rij in onboarding_mentor_updates.
    //    - status meegegeven → kind:'status' (note optioneel meegestuurd).
    //    - status wissen     → kind:'status', status=null, note='Handmatige
    //                          status gewist' (tenzij caller eigen note gaf).
    //    - alleen note       → kind:'note'.
    const logNote = note || (isClear ? 'Handmatige status gewist' : null);
    const logRow = {
      onboarding_id: onboardingId,
      kind:          (status || isClear) ? 'status' : 'note',
      status:        status || null,
      note:          logNote,
      created_by:    user.id,
    };
    const { data: inserted, error: logErr } = await supabaseAdmin
      .from('onboarding_mentor_updates')
      .insert(logRow)
      .select('kind, status, note, created_at, created_by')
      .single();
    if (logErr) throw new Error('mentor_update log insert: ' + logErr.message);

    // 3) Manager-melding bij PROBLEEM-statussen (geen_gehoor / wil_niet /
    //    wil_later). NIET bij nog_te_benaderen of status-clear (null).
    //    FAIL-SOFT: een falende insert mag de mentor-update niet breken.
    const PROBLEM_STATUSES = new Set(['geen_gehoor', 'wil_niet', 'wil_later']);
    const STATUS_LABEL = {
      geen_gehoor: 'Geen gehoor',
      wil_niet:    'Wil niet starten',
      wil_later:   'Wil later starten',
    };
    if (status && PROBLEM_STATUSES.has(status)) {
      try {
        const { error: mnErr } = await supabaseAdmin
          .from('manager_notifications')
          .insert({
            onboarding_id:  onboardingId,
            kind:           'mentor_status',
            status,
            customer_name:  ob.customer_name || null,
            mentor_user_id: user.id,
            title:          'Mentor-update: ' + (STATUS_LABEL[status] || status),
            body:           note || null,
            created_by:     user.id,
          });
        if (mnErr) {
          console.warn('[mentor-future-student-update] manager_notifications insert (soft):', mnErr.message);
        }
      } catch (e) {
        console.warn('[mentor-future-student-update] manager_notifications exception (soft):', e?.message || e);
      }
    }

    return res.status(200).json({ ok: true, update: inserted });
  } catch (e) {
    console.error('[mentor-future-student-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
