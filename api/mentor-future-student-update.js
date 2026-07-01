// api/mentor-future-student-update.js
//
// POST — mentor zet een handmatige intake-status of voegt een notitie toe op
// een onboarding die aan HEM/HAAR is toegewezen. Voor "Toekomstige studenten"
// in mentor-students.html (toekomst-tab).
//
// Body: { onboarding_id: uuid, status?: enum|null, note?: string, start_date?: 'YYYY-MM-DD' }
//
//   status (optioneel) ∈ { nog_te_benaderen, geen_gehoor, wil_later, wil_niet }
//     → update onboardings.mentor_intake_status + insert log-rij (kind:'status').
//   status === null      → expliciet wissen (terug naar auto-afleiding).
//     → mentor_intake_status = null + log-rij (kind:'status', status=null,
//       note='Handmatige status gewist').
//   note (optioneel zónder status, verplicht als er geen status is)
//     → insert log-rij (kind:'note').
//   start_date (optioneel, YYYY-MM-DD)
//     → update onboardings.start_date + log-rij + fail-soft manager_notification
//       (kind:'mentor_startdate'). Zelfde ownership-gate.
//
// Gate (mentor.module.access) + OWNERSHIP-check: onboarding.mentor_user_id
// MOET gelijk zijn aan de ingelogde user-id, anders 403. Auto-statussen
// "Gestart" en "Call ingepland" worden NIET hier gezet (afgeleid in UI uit
// 1-op-1 sessies).
//
// Response 200: { ok:true, update:{kind,status,note,created_at,created_by} }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createNotification } from './_lib/notify.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// YYYY-MM-DD (Postgres date kolom) — spiegel admin-onboarding-start-date.js.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function fmtDateNL(ymd) {
  if (!ymd) return '—';
  try {
    const d = new Date(ymd + 'T00:00:00Z');
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ymd; }
}

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

  // start_date — optioneel. YYYY-MM-DD; trim eventuele tijds-suffix.
  let startDateRaw = typeof body.start_date === 'string' ? body.start_date.trim() : '';
  if (startDateRaw.length > 10) startDateRaw = startDateRaw.slice(0, 10);
  const hasStartDate = startDateRaw.length > 0;
  if (hasStartDate) {
    if (!DATE_RE.test(startDateRaw)) {
      return res.status(400).json({ error: 'start_date (YYYY-MM-DD) ongeldig.' });
    }
    const parsed = new Date(startDateRaw + 'T00:00:00Z');
    if (Number.isNaN(parsed.getTime()) || parsed.getUTCFullYear() < 1900 || parsed.getUTCFullYear() > 2100) {
      return res.status(400).json({ error: 'start_date buiten verwacht bereik.' });
    }
  }

  if (!status && !isClear && !note && !hasStartDate) {
    return res.status(400).json({ error: 'Geef minstens status, status:null (clear), note óf start_date mee.' });
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

    // 2) Log-rij in onboarding_mentor_updates voor het status/note-pad.
    //    Alleen inserten als er daadwerkelijk status/isClear/note in deze
    //    call zit — een pure start_date-call valt door en krijgt zijn eigen
    //    log-rij in stap 4.
    //    - status meegegeven → kind:'status' (note optioneel meegestuurd).
    //    - status wissen     → kind:'status', status=null, note='Handmatige
    //                          status gewist' (tenzij caller eigen note gaf).
    //    - alleen note       → kind:'note'.
    let inserted = null;
    if (status || isClear || note) {
      const logNote = note || (isClear ? 'Handmatige status gewist' : null);
      const logRow = {
        onboarding_id: onboardingId,
        kind:          (status || isClear) ? 'status' : 'note',
        status:        status || null,
        note:          logNote,
        created_by:    user.id,
      };
      const { data: ins, error: logErr } = await supabaseAdmin
        .from('onboarding_mentor_updates')
        .insert(logRow)
        .select('kind, status, note, created_at, created_by')
        .single();
      if (logErr) throw new Error('mentor_update log insert: ' + logErr.message);
      inserted = ins;
    }

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
      // Notify management via unified notifications-systeem (fail-soft). Multi-rol
      // fan-out naar zowel 'manager' als 'super_admin' — helper dedupt user_ids
      // die beide rollen hebben zodat we niet dubbel schrijven.
      const custName = ob.customer_name || 'een student';
      createNotification({
        toRole:     ['manager', 'super_admin'],
        type:       'onboarding.mentor_update',
        title:      'Mentor-update · ' + custName,
        body:       (STATUS_LABEL[status] || status) + (note ? ' — ' + note : ''),
        linkUrl:    '/modules/onboarding-hub.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  user.id,
      }).catch(() => {});
    }

    // 4) Startdatum-pad — mentor wijzigt onboardings.start_date voor zijn
    //    eigen student. Ownership-gate is hierboven al geverifieerd
    //    (ob.mentor_user_id === user.id). FAIL-SOFT manager-melding via
    //    createNotification (fire-and-forget); mislukking mag de start_date-
    //    update niet teniet doen.
    let startDateUpdate = null;
    if (hasStartDate) {
      const { error: sdErr } = await supabaseAdmin
        .from('onboardings')
        .update({ start_date: startDateRaw })
        .eq('id', onboardingId);
      if (sdErr) throw new Error('start_date update: ' + sdErr.message);

      const nlDate = fmtDateNL(startDateRaw);
      const sdLogRow = {
        onboarding_id: onboardingId,
        kind:          'note',
        status:        null,
        note:          'Startdatum gewijzigd naar ' + nlDate,
        created_by:    user.id,
      };
      const { data: sdIns, error: sdLogErr } = await supabaseAdmin
        .from('onboarding_mentor_updates')
        .insert(sdLogRow)
        .select('kind, status, note, created_at, created_by')
        .single();
      if (sdLogErr) throw new Error('mentor_update start_date log insert: ' + sdLogErr.message);
      startDateUpdate = sdIns;

      // Notify management via unified notifications-systeem — startdatum-
      // wijziging door mentor. Fail-soft.
      const custNameSd = ob.customer_name || 'een student';
      createNotification({
        toRole:     ['manager', 'super_admin'],
        type:       'onboarding.mentor_update',
        title:      'Mentor-update · ' + custNameSd,
        body:       'Startdatum gewijzigd naar ' + nlDate,
        linkUrl:    '/modules/onboarding-hub.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  user.id,
      }).catch(() => {});
    }

    // Backwards-compat: response.update blijft het status/note-log-record
    // (of null bij pure start_date-call). Plus aparte start_date-velden.
    return res.status(200).json({
      ok: true,
      update: inserted,
      start_date: hasStartDate ? startDateRaw : null,
      start_date_update: startDateUpdate,
    });
  } catch (e) {
    console.error('[mentor-future-student-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
