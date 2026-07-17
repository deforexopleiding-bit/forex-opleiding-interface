// api/follow-up-ghl-status-backfill.js
//
// One-off backfill voor het GHL-appointmentStatus-bug: tot deze fix zetten
// gesprek_gehad / sale / wilt_niet_meer / niet_geschikt allemaal 'cancelled'
// in GHL, waardoor sales (bv. Ian Poplemon) en niet-geschikte klanten (bv.
// Philip Lucie) in de GHL-rapportage als GEANNULEERD staan. Dit endpoint
// zet ze terug naar 'showed'.
//
// TWEE-STAPS-FLOW (raakt live CRM-data):
//   1. POST { dry_run: true, mode: 'strict'|'heuristic' } → PREVIEW, wijzigt niets.
//      Response bevat de exacte lijst appointments (id, lead_name, scheduled_at,
//      outcome, ghl_appointment_id, source) die geraakt zouden worden.
//   2. POST { dry_run: false, mode: 'strict'|'heuristic', confirm: 'IK BEGRIJP HET' }
//      → EXECUTE, per rij updateGhlAppointmentStatus('showed'). Fail-soft per rij:
//      één GHL-error blokkeert de rest niet, warnings komen in response.results[].
//
// MODES:
//   - 'strict' (default): alleen rijen waarvan prev_state.outcome_before_undo IN
//     ('gesprek_gehad','sale','wilt_niet_meer','niet_geschikt'). Dit is HARD
//     BEWIJS dat WIJ de cancelled in GHL hebben gezet (cockpit-outcome-flow),
//     niet de klant. Veilig.
//   - 'heuristic': strict + rijen zonder prev_state maar met status='completed'
//     of 'cancelled' + snelle_notitie waarin één van de cockpit-outcome-teksten
//     voorkomt ('Sale geworden', 'Gesprek gehad', 'Niet geschikt', 'Geen
//     interesse — call was al gevoerd'). Dekt rijen van vóór de prev_state-
//     migratie. Minder zeker — Jeffrey moet de preview zorgvuldig nalopen.
//
// Klant-annuleringen (afspraak ging NIET door) komen binnen via het
// annuleer-endpoint (delegateAnnuleren in follow-up-appointment-outcome.js) en
// hebben geen outcome-registratie in de cockpit-flow — die worden dus NOOIT
// door dit script aangeraakt. Dat is de kern van waarom we prev_state (of
// snelle_notitie) als filter gebruiken: het scheidt "onze onterechte cancelled"
// van "echte klant-cancelled".
//
// Auth: alleen super_admin. Dit is een handmatige one-off; niet bereikbaar
// voor sales/manager om abuse te voorkomen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { updateGhlAppointmentStatus } from './_lib/ghl-appointment.js';

// Outcomes die onterecht op 'cancelled' zijn beland — deze zetten we op 'showed'.
const AFFECTED_OUTCOMES = new Set(['gesprek_gehad', 'sale', 'wilt_niet_meer', 'niet_geschikt']);

// Heuristische matcher: welke cockpit-outcome-notitie duidt op welke outcome?
// Volgt letterlijk de noteText-strings uit follow-up-appointment-outcome.js.
const NOTE_HEURISTICS = [
  { needle: 'Sale geworden via Zoom-call',                 outcome: 'sale' },
  { needle: 'Gesprek gehad via Zoom',                      outcome: 'gesprek_gehad' },
  { needle: 'Niet geschikt voor opleiding',                outcome: 'niet_geschikt' },
  { needle: 'Geen interesse — call was al gevoerd',        outcome: 'wilt_niet_meer' },
];

function isSuperAdmin(role) {
  return String(role || '').toLowerCase() === 'super_admin';
}

// Detecteer een cockpit-outcome via snelle_notitie. Returnt eerste match of null.
function detectOutcomeFromNote(note) {
  if (typeof note !== 'string' || !note) return null;
  for (const h of NOTE_HEURISTICS) {
    if (note.includes(h.needle)) return h.outcome;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const { data: myProfile } = await supabaseAdmin
    .from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (!isSuperAdmin(myProfile?.role)) {
    return res.status(403).json({ error: 'Alleen super_admin mag deze one-off draaien' });
  }

  const body    = (req.body && typeof req.body === 'object') ? req.body : {};
  const dryRun  = body.dry_run !== false;
  const mode    = body.mode === 'heuristic' ? 'heuristic' : 'strict';
  const limit   = Number.isInteger(body.limit) && body.limit > 0 && body.limit <= 500 ? body.limit : 200;
  const confirm = String(body.confirm || '');

  if (!dryRun && confirm !== 'IK BEGRIJP HET') {
    return res.status(400).json({
      error: 'Voor execute (dry_run: false) is confirm: "IK BEGRIJP HET" verplicht.',
      hint : 'Draai eerst met dry_run:true; controleer de preview; herhaal met dry_run:false + confirm.',
    });
  }

  // ── STAP 1: kandidaten ophalen ─────────────────────────────────────────────
  // Alle appointments met een GHL-koppeling. We filteren daarna in-memory op
  // prev_state / snelle_notitie zodat de query simpel blijft.
  const { data: rows, error: fetchErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, scheduled_at, status, ghl_appointment_id, prev_state, snelle_notitie, updated_at')
    .not('ghl_appointment_id', 'is', null)
    .order('scheduled_at', { ascending: false })
    .limit(1000);

  if (fetchErr) {
    console.error('[ghl-status-backfill] fetch error:', fetchErr.message);
    return res.status(500).json({ error: 'appt fetch: ' + fetchErr.message });
  }

  // ── STAP 2: filteren op affected outcomes ──────────────────────────────────
  const candidates = [];
  for (const r of rows || []) {
    // Strict-bewijs: prev_state.outcome_before_undo in affected set.
    const prevOutcome = r.prev_state && typeof r.prev_state === 'object'
      ? String(r.prev_state.outcome_before_undo || '')
      : '';
    if (prevOutcome && AFFECTED_OUTCOMES.has(prevOutcome)) {
      candidates.push({
        id                 : r.id,
        lead_name          : r.lead_name,
        lead_email         : r.lead_email,
        scheduled_at       : r.scheduled_at,
        db_status          : r.status,
        ghl_appointment_id : r.ghl_appointment_id,
        outcome            : prevOutcome,
        source             : 'prev_state',
        confidence         : 'high',
        snelle_notitie     : r.snelle_notitie ? String(r.snelle_notitie).slice(0, 200) : null,
      });
      continue;
    }
    // Heuristic-fallback: alleen als mode='heuristic' en géén prev_state.
    if (mode === 'heuristic' && !prevOutcome) {
      const noteOutcome = detectOutcomeFromNote(r.snelle_notitie);
      if (noteOutcome) {
        candidates.push({
          id                 : r.id,
          lead_name          : r.lead_name,
          lead_email         : r.lead_email,
          scheduled_at       : r.scheduled_at,
          db_status          : r.status,
          ghl_appointment_id : r.ghl_appointment_id,
          outcome            : noteOutcome,
          source             : 'snelle_notitie',
          confidence         : 'medium',
          snelle_notitie     : r.snelle_notitie ? String(r.snelle_notitie).slice(0, 200) : null,
        });
      }
    }
  }

  // Cap op limit voor safety.
  const capped  = candidates.slice(0, limit);
  const skipped = candidates.length - capped.length;

  // ── DRY-RUN: alleen preview ────────────────────────────────────────────────
  if (dryRun) {
    return res.status(200).json({
      dry_run              : true,
      mode                 : mode,
      total_candidates     : candidates.length,
      returned             : capped.length,
      skipped_over_limit   : skipped,
      limit                : limit,
      preview              : capped,
      note                 : `Draai opnieuw met dry_run:false + confirm:"IK BEGRIJP HET" om '${capped.length}' appointments in GHL op 'showed' te zetten.`,
    });
  }

  // ── EXECUTE: per rij updateGhlAppointmentStatus, fail-soft ─────────────────
  const results = [];
  let succeeded = 0;
  let failed    = 0;
  for (const c of capped) {
    try {
      await updateGhlAppointmentStatus(c.ghl_appointment_id, 'showed');
      results.push({
        appointment_id     : c.id,
        ghl_appointment_id : c.ghl_appointment_id,
        lead_name          : c.lead_name,
        outcome            : c.outcome,
        source             : c.source,
        result             : 'ok',
      });
      succeeded++;
    } catch (e) {
      const ghlStatus = e?.ghlStatus || 'unknown';
      const ghlBody   = (e?.ghlBody || String(e?.message || '')).slice(0, 200);
      console.warn('[ghl-status-backfill] failed', {
        appointment_id: c.id, ghl_appointment_id: c.ghl_appointment_id, ghlStatus, ghlBody,
      });
      results.push({
        appointment_id     : c.id,
        ghl_appointment_id : c.ghl_appointment_id,
        lead_name          : c.lead_name,
        outcome            : c.outcome,
        source             : c.source,
        result             : 'failed',
        ghl_status         : ghlStatus,
        error              : ghlBody,
      });
      failed++;
    }
  }

  return res.status(200).json({
    dry_run          : false,
    mode             : mode,
    processed        : capped.length,
    succeeded        : succeeded,
    failed           : failed,
    skipped_over_limit: skipped,
    limit            : limit,
    results          : results,
  });
}
