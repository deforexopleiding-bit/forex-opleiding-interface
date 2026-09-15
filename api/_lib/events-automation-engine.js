// api/_lib/events-automation-engine.js
// De motor achter de events-automations: enrollment (trigger->scope->enroll_mode)
// en de stepper (wait plant door, condition vertakt, send_email/send_whatsapp
// via events-send). At-most-once per stap via event_automation_run_log.
// Pure helpers (computeNextRunAt/evaluateCondition/advanceRun) zijn geexporteerd
// en DB-/netwerk-vrij zodat de hele staploop offline getest kan worden.

import { supabaseAdmin } from '../supabase.js';
import { sendEventEmail, sendEventWhatsAppTemplate } from './events-send.js';
import { logComms, mapSendStatus } from './comms-log.js';
import { onConfirmedAttendeeMutation } from './event-attendee-mutations.js';
import { isPlekBezet } from './event-registration.js';
// plafondMs is de ENIGE plek waar 'nooit later dan X uur voor het event' wordt
// uitgerekend — dezelfde functie die de deadline in de mailtekst zet. Zie de
// kop van _lib/geen-gehoor-deadline.js.
import { plafondMs } from './geen-gehoor-deadline.js';

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const MAX_SEND_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60_000;

// Automation-tester: test-runs (run.is_test=true) versnellen wait-stappen
// naar deze duur ongeacht waitConfig.unit/amount. 15s = lang genoeg dat de
// engine z'n DB-write doet en weer wordt opgepikt door de eerstvolgende
// cron-tick, kort genoeg dat Jeffrey de hele flow in minuten doorloopt.
const TEST_WAIT_MS = 15 * 1000;

// ── Pure helpers ────────────────────────────────────────────────────────────

export function computeNextRunAt(waitConfig, fromMs) {
  const amount = Number(waitConfig && waitConfig.amount);
  const unit = waitConfig && waitConfig.unit;
  const ms = UNIT_MS[unit];
  if (!Number.isFinite(amount) || amount < 0 || !ms) return new Date(fromMs);
  return new Date(fromMs + amount * ms);
}

/**
 * DE BOVENGRENS OP EEN WACHTSTAP: nooit later dan X uur voor het event.
 *
 * Optioneel, via `waitConfig.uiterlijk_uren_voor_event`. Een deadline van 48
 * uur op een aanmelding van morgen valt anders ná het event, en dan gaat de
 * vervolgstap (plek vervalt, melding aan Maxim) over een middag die al geweest
 * is.
 *
 * LOS VAN computeNextRunAt, EN MET OPZET. Die functie is puur en kent alleen
 * zijn eigen config; de grens heeft `event.starts_at` nodig. Ze apart houden
 * betekent dat allebei zonder databank te testen zijn en dat de bestaande
 * wait-stappen letterlijk niets merken van deze uitbreiding.
 *
 *   · geen grens in de config, of onleesbaar → de wachttijd blijft ongemoeid;
 *   · geen leesbare starts_at → GEEN grens. Een grens verzinnen op een event
 *     zonder datum zou de run vooruitduwen op een schatting;
 *   · de grens ligt al in het verleden → wachttijd nul, de run gaat meteen
 *     door. De deadline is dan verstreken op het moment dat hij gesteld werd,
 *     en wachten zou de vervolgstap alleen maar verder ná het event zetten.
 *
 * @param {Date}    nextRunAt  uitkomst van computeNextRunAt
 * @param {object}  waitConfig
 * @param {?string} eventStartsAt
 * @param {number}  fromMs     het nu-moment in ms
 * @returns {Date}
 */
export function applyWaitCeiling(nextRunAt, waitConfig, eventStartsAt, fromMs) {
  // Geen grens in de config, onleesbare grens of onleesbare startdatum →
  // plafondMs geeft null en de wachttijd blijft ongemoeid.
  const grensMs = plafondMs(eventStartsAt, waitConfig && waitConfig.uiterlijk_uren_voor_event);
  if (grensMs == null) return nextRunAt;
  if (grensMs <= fromMs) return new Date(fromMs);

  const gepland = nextRunAt instanceof Date ? nextRunAt.getTime() : Number(nextRunAt);
  if (!Number.isFinite(gepland)) return new Date(grensMs);
  return new Date(Math.min(gepland, grensMs));
}

export function buildConditionState(attendee, event) {
  const status = attendee && attendee.status;
  // Fase 4A: event_niveau uit het gekoppelde event mee zodat
  // niveau_is_basis / niveau_is_gevorderd checks kunnen.
  const niveau = (event && typeof event.niveau === 'string') ? event.niveau.trim().toLowerCase() : '';
  return {
    assessment_completed: !!(attendee && attendee.assessment_response_id),
    // Sinds 15 sep 2026: de plek kan ook via de belstatus vaststaan. Dezelfde
    // regel als isPlekBezet in api/_lib/event-registration.js.
    plek_bevestigd:      isPlekBezet(attendee),
    status,
    still_registered: status !== 'switched_to_other_event' && status !== 'no_show',
    event_niveau:        niveau,
  };
}

/**
 * Checks die een meting BUITEN de attendee-rij nodig hebben.
 *
 * buildConditionState leest alleen de rij zelf; deze checks kijken in
 * whatsapp_messages en email_messages. advanceRun haalt de meting op via
 * deps.measureCondition en zet 'm als `state.meting`, zodat
 * evaluateCondition puur blijft.
 */
export const GEMETEN_CONDITION_CHECKS = new Set(['geen_reactie_sinds_belstatus']);

export function evaluateCondition(check, state) {
  switch (check) {
    // ── GEEN REACTIE SINDS DE BELSTATUS ────────────────────────────────
    // Waar = er is sinds call_status_at niets binnengekomen: geen WhatsApp en
    // geen inkomende mail. Op deze uitkomst vervalt iemands plek, dus:
    //
    // NIET GEMETEN IS NIET WAAR. Geen meting (geen nummer en geen mailadres,
    // geen nulpunt, of een query die faalde) → false, en de vervolgstappen
    // draaien niet. We nemen nooit een plek af op een controle die niet kon
    // draaien. Ontbreekt de meting helemaal, dan is dat hetzelfde geval: geen
    // meting, dus niet waar.
    case 'geen_reactie_sinds_belstatus': {
      const m = state && state.meting;
      if (!m || m.niet_gemeten === true || m.meetbaar === false) return false;
      return m.waar === true;
    }
    case 'assessment_completed':     return state.assessment_completed === true;

    // ── "VRAGENLIJST NIET INGEVULD" IS EEN VRAAG OVER DE PLEK ─────────────
    // De enige automatisatie die hierop gate't ("Vragenlijst-herinnering",
    // on_signup) stuurt letterlijk: "je plek is nog NIET definitief bevestigd".
    // Sinds 15 sep 2026 kan die plek óók via belstatus 'bevestigd' vaststaan —
    // en dan is dat bericht gewoon onwaar. Wie zijn plek al heeft, laat deze
    // check dus falen (in die automatisatie: skip_to_end, dus geen bericht).
    //
    // De vraag "heeft hij de vragenlijst ingevuld?" blijft beantwoordbaar via
    // assessment_completed hierboven; die is met opzet NIET aangepast.
    //
    // plek_bevestigd ontbreekt bij een oudere caller die alleen
    // assessment_completed meegeeft; dan valt hij terug op het oude gedrag.
    case 'assessment_not_completed':
      if (state.plek_bevestigd === true) return false;
      return state.assessment_completed === false;
    case 'still_registered':         return state.still_registered === true;
    // Fase 4A: niveau-checks. ILIKE-gedrag via lowercase compare.
    case 'niveau_is_basis':          return state.event_niveau === 'basis';
    case 'niveau_is_gevorderd':      return state.event_niveau === 'gevorderd';
    // TODO fase 4b: 'date_chosen' vereist nieuw schema-veld of impliciete
    // detectie. Pragmatische versie geparkeerd tot een betrouwbare definitie
    // beschikbaar is.
    default:                         return true; // onbekende check blokkeert niet
  }
}

/**
 * Verwerkt zoveel mogelijk stappen voor EEN run in een begrensde loop.
 * deps = { isStepDone(idx)->bool, recordLog(idx,type,result), sendEmail(step,ctx), sendWhatsApp(step,ctx) }
 * Returnt de nieuwe run-velden (geen DB-write hier).
 */
export async function advanceRun({ run, attendee, event, now = new Date(), deps, maxIterations = 25 }) {
  const steps = Array.isArray(run.steps_snapshot) ? run.steps_snapshot : [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let idx = run.current_step_index || 0;
  let status = 'active';
  let nextRunAt = null;
  let attempts = run.attempts || 0;
  let lastError = run.last_error || null;

  for (let i = 0; i < maxIterations; i++) {
    if (idx >= steps.length) { status = 'completed'; nextRunAt = null; break; }
    const step = steps[idx] || {};
    const type = step.type;

    if (type === 'wait') {
      nextRunAt = computeNextRunAt(step.config, nowMs);
      // De bovengrens LOS erbovenop, met event.starts_at als argument — zie
      // applyWaitCeiling. Zonder config-sleutel verandert er niets.
      nextRunAt = applyWaitCeiling(nextRunAt, step.config, event && event.starts_at, nowMs);
      // Automation-tester: test-runs versnellen elke wait naar TEST_WAIT_MS.
      // Override gebeurt NA computeNextRunAt zodat de pure helper unit-
      // testbaar blijft zonder is_test-context.
      if (run.is_test === true) {
        nextRunAt = new Date(nowMs + TEST_WAIT_MS);
      }
      idx += 1; attempts = 0; status = 'active';
      break; // wait persisteren; engine hervat bij volgende due-tick
    }

    if (type === 'condition') {
      const check = step.config && step.config.check;
      let state = buildConditionState(attendee, event);

      // Checks die buiten de rij moeten kijken krijgen hun meting hier, via
      // deps — zo blijft evaluateCondition puur en offline testbaar. Geen
      // meter beschikbaar (een oudere caller, of een test die deze dep niet
      // meegeeft) is 'niet gemeten', niet 'geen reactie'.
      let meting = null;
      if (GEMETEN_CONDITION_CHECKS.has(check)) {
        if (typeof deps.measureCondition === 'function') {
          try {
            meting = await deps.measureCondition(check, { attendee, event, stepIndex: idx });
          } catch (e) {
            meting = { niet_gemeten: true, waar: false, reden: 'meting gooide: ' + ((e && e.message) || e) };
          }
        } else {
          meting = { niet_gemeten: true, waar: false, reden: 'geen meter beschikbaar voor ' + check };
        }
        state = { ...state, meting };
      }

      const pass = evaluateCondition(check, state);
      // NOOIT STIL SLAGEN: een meting die niet kon draaien staat als
      // niet_gemeten in het log, met de reden erbij. Anders is 'pass: false'
      // niet te onderscheiden van 'gemeten en er kwam een antwoord'.
      await deps.recordLog(idx, 'condition', {
        ok: true, pass, check,
        ...(meting ? {
          niet_gemeten: meting.niet_gemeten === true,
          meting_reden: meting.reden || null,
          meting_kanalen: meting.kanalen || null,
          meting_treffers: typeof meting.aantal_treffers === 'number' ? meting.aantal_treffers : null,
        } : {}),
      });
      if (pass) { idx += 1; attempts = 0; continue; }
      const onFail = (step.config && step.config.on_fail) || 'exit';
      if (onFail === 'skip_to_end') { idx = steps.length; continue; }
      status = 'exited'; nextRunAt = null;
      break;
    }

    if (type === 'send_email' || type === 'send_whatsapp') {
      if (await deps.isStepDone(idx)) { idx += 1; attempts = 0; continue; }
      let result;
      try {
        // FIX 4: stepIndex meegeven via ctx zodat de deps-wrappers naar de
        // event_attendee_comms_log kunnen schrijven met juiste step_index.
        result = type === 'send_email'
          ? await deps.sendEmail(step, { attendee, event, stepIndex: idx })
          : await deps.sendWhatsApp(step, { attendee, event, stepIndex: idx });
      } catch (e) {
        result = { ok: false, error: (e && e.message) || 'send threw' };
      }
      if (result && result.ok) {
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; lastError = null; continue;
      }
      if (result && (result.skipped || result.permanent)) {
        // skipped: no-phone / template niet APPROVED — niets om te retry-en.
        // permanent: Meta 4xx / bekende validatie-code (zie events-send.js).
        // Retry zou exact dezelfde payload sturen → exact dezelfde error.
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; continue;
      }
      attempts += 1;
      lastError = (result && result.error) || 'send failed';
      if (attempts >= MAX_SEND_ATTEMPTS) {
        await deps.recordLog(idx, type, { ok: false, error: lastError, gave_up: true });
        idx += 1; attempts = 0; continue;
      }
      nextRunAt = new Date(nowMs + RETRY_BACKOFF_MS); // retry zelfde stap
      break;
    }

    // Fase 4A: set_tag / update_attendee_status / send_internal_notification.
    // Idempotency-pattern als bij send_email: isStepDone-check vóór action.
    if (type === 'set_tag' || type === 'update_attendee_status' || type === 'send_internal_notification') {
      if (await deps.isStepDone(idx)) { idx += 1; attempts = 0; continue; }
      let result;
      try {
        if (type === 'set_tag') {
          result = await deps.setTag(step, { attendee, event, stepIndex: idx });
        } else if (type === 'update_attendee_status') {
          result = await deps.updateAttendeeStatus(step, { attendee, event, stepIndex: idx });
        } else {
          result = await deps.sendInternalNotification(step, { attendee, event, stepIndex: idx });
        }
      } catch (e) {
        result = { ok: false, error: (e && e.message) || 'step threw' };
      }
      if (result && result.ok) {
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; lastError = null; continue;
      }
      if (result && result.skipped) {
        await deps.recordLog(idx, type, result);
        idx += 1; attempts = 0; continue;
      }
      // Niet retry-en op deze types — geen externe API met flaky-risico,
      // gewoon doorgaan en fail-soft loggen.
      await deps.recordLog(idx, type, { ok: false, error: (result && result.error) || 'step failed' });
      idx += 1; attempts = 0; continue;
    }

    // onbekend staptype → log skip + door
    await deps.recordLog(idx, type || 'unknown', { ok: true, skipped: true, reason: 'unknown-step-type' });
    idx += 1; attempts = 0;
  }

  return {
    current_step_index: idx,
    status,
    next_run_at: nextRunAt,
    attempts,
    last_error: lastError,
    completed_at: status === 'completed' ? new Date(nowMs) : (run.completed_at || null),
  };
}

// ── Enrollment ──────────────────────────────────────────────────────────────

async function loadCandidatesForAutomation(auto, now) {
  const nowIso = now.toISOString();

  // Bepaal toegestane event_ids o.b.v. scope (+ time_before_event-window).
  // null = geen event-id-restrictie (scope 'all').
  let allowedEventIds = null;
  if (auto.scope_type === 'niveau' && auto.scope_config && auto.scope_config.niveau) {
    const { data: evs, error } = await supabaseAdmin
      .from('events').select('id').eq('niveau', auto.scope_config.niveau);
    if (error) throw new Error('candidates niveau-events: ' + error.message);
    allowedEventIds = (evs || []).map((e) => e.id);
  } else if (auto.scope_type === 'events' && Array.isArray(auto.scope_config && auto.scope_config.event_ids)) {
    allowedEventIds = auto.scope_config.event_ids;
  }

  if (auto.trigger_type === 'time_before_event') {
    const hours = Number(auto.trigger_config && auto.trigger_config.hours_before) || 0;
    const upper = new Date(now.getTime() + hours * 3_600_000).toISOString();
    const { data: evs, error } = await supabaseAdmin
      .from('events').select('id').gt('starts_at', nowIso).lte('starts_at', upper);
    if (error) throw new Error('candidates window-events: ' + error.message);
    const windowIds = (evs || []).map((e) => e.id);
    allowedEventIds = (allowedEventIds == null)
      ? windowIds
      : allowedEventIds.filter((id) => windowIds.includes(id));
  }

  // Lege scope/window → geen kandidaten.
  if (allowedEventIds != null && allowedEventIds.length === 0) return [];

  let q = supabaseAdmin
    .from('event_attendees')
    // events!inner embed: nodig om in de on_assessment_completed-tak op
    // events.starts_at te filteren (guard b). De inner-join is verder
    // onschadelijk — elke attendee heeft een geldige event_id-FK, dus er
    // vallen geen rijen weg voor de overige trigger-types.
    // FK-gekwalificeerd (event_attendees_event_id_fkey): event_attendees heeft
    // TWEE FK's naar events (event_id + switched_from_event_id), dus een kaal
    // 'events!inner' is ambigu → PGRST201. Alias blijft 'events'.
    // call_status + call_status_at meelezen voor de trigger 'on_call_status':
    // de eerste is het filter, de tweede is zowel de new_only-grens als het
    // nulpunt van de deadline in de mail.
    .select('id, event_id, registered_at, assessment_response_id, assessment_linked_at, status, call_status, call_status_at, events!event_attendees_event_id_fkey!inner(starts_at)')
    // Opt-in herontwerp: attendees met automation_enabled=false zijn stil
    // toegevoegd door admin en mogen geen automation-flow krijgen. Filter
    // hier zodat ALLE trigger-types (on_signup / time_before_event /
    // on_assessment_completed / on_assessment_not_completed_after) consistent
    // overslaan.
    .eq('automation_enabled', true)
    .limit(500);
  if (allowedEventIds != null) q = q.in('event_id', allowedEventIds);

  const newOnly = auto.enroll_mode === 'new_only' && auto.enabled_at;
  if (auto.trigger_type === 'on_signup') {
    // Alleen wie de vragenlijst NOG NIET afrondde krijgt de welkom/uitnodiging.
    // Sluit switch-created rijen uit (die hebben assessment_response_id al
    // gekopieerd bij de switch) en is semantisch correct: een "vul de
    // vragenlijst in"-welkom heeft geen zin voor wie 'm al invulde. Voorkomt
    // een tweede welkom met een nieuw choice_token na een datum-switch.
    q = q.is('assessment_response_id', null);
    if (newOnly) q = q.gte('registered_at', auto.enabled_at);
  } else if (auto.trigger_type === 'on_assessment_completed') {
    q = q.not('assessment_response_id', 'is', null);
    // Capaciteits-gate: alleen bevestigen wie een bevestigde plek heeft. Overflow-
    // rijen staan op 'wachtlijst' en vallen hier weg → géén deelnemer-bevestiging.
    // Raakt UITSLUITEND on_assessment_completed (o.a. "Bevestiging aanmelding");
    // on_signup/time_before_event (welkom/reminders) blijven ongemoeid. Sluit ook
    // 'sale'/'no_show'/'geannuleerd' uit; wie eerder als 'aangemeld' al bevestigd
    // is, krijgt door de isStepDone-idempotency geen dubbele.
    q = q.in('status', ['aangemeld', 'aanwezig']);
    // Guard (b) — vangnet: de motor mag NOOIT een verstreken event bevestigen.
    // Ook als een verstreken rij ondanks guard (a) toch een assessment_response_id
    // heeft gekregen, valt hij hier weg (events.starts_at > nu).
    q = q.gt('events.starts_at', nowIso);
    if (newOnly) q = q.gte('assessment_linked_at', auto.enabled_at);
  } else if (auto.trigger_type === 'time_before_event') {
    if (newOnly) q = q.gte('registered_at', auto.enabled_at);
  } else if (auto.trigger_type === 'on_assessment_not_completed_after') {
    // Fase 4A: attendees X uur na aanmelding zonder voltooid assessment.
    const hours = Number(auto.trigger_config && auto.trigger_config.hours_after_signup) || 0;
    if (!(hours > 0)) return [];
    const cutoff = new Date(now.getTime() - hours * 3_600_000).toISOString();
    q = q.is('assessment_response_id', null).lte('registered_at', cutoff);
    if (newOnly) q = q.gte('registered_at', auto.enabled_at);
  } else if (auto.trigger_type === 'on_call_status') {
    // ── DE BELSTATUS ALS TRIGGER ──────────────────────────────────────────
    // Tot nu toe keek geen enkele trigger naar het belwerk. Gemeten op 14
    // september op event_attendees.call_status: 85 leeg, 65 bevestigd, 16
    // komt_niet, 15 geen_gehoor, 6 voicemail, 3 terugbellen, 1 foutief_nummer.
    // Die 15 geen_gehoor-rijen kregen nooit iets te horen en hun plek bleef
    // bezet tot iemand het met de hand opruimde.
    //
    // Bewust op trigger_config.call_status en niet hardgecodeerd op
    // 'geen_gehoor': dezelfde trigger dekt later 'voicemail' en
    // 'foutief_nummer' zonder een tweede trigger_type.
    const wanted = auto.trigger_config && auto.trigger_config.call_status;
    if (!wanted || typeof wanted !== 'string') return [];
    q = q.eq('call_status', wanted);

    // ALLEEN WIE NOG INGESCHREVEN STAAT. Iemand die inmiddels zelf afzegde
    // (geannuleerd) of aanwezig was hoeft geen 'je plek vervalt'-mail; die
    // plek is al geregeld. Bewust alleen 'aangemeld' — 'wachtlijst' heeft geen
    // plek om te verliezen, en 'sale'/'aanwezig' zijn eindstanden.
    q = q.eq('status', 'aangemeld');

    // HET EVENT MOET NOG KOMEN. Een deadline van 48 uur op een middag die al
    // geweest is, is een mail over een plek die niet meer bestaat.
    // FK-gekwalificeerd om dezelfde reden als bij on_assessment_completed:
    // event_attendees heeft TWEE FK's naar events (event_id +
    // switched_from_event_id), dus een kaal 'events!inner' is ambigu →
    // PGRST201.
    q = q.gt('events.starts_at', nowIso);

    // ── NEW_ONLY TOETST OP call_status_at, NIET OP registered_at ──────────
    // Dit is de regel die de 15 bestaande geen_gehoor-rijen buiten de flow
    // houdt. Zonder hem worden die bij het aanzetten van de automatisatie
    // allemaal in één keer ingeschreven en krijgen mensen die weken geleden
    // gebeld zijn vandaag een deadline van 48 uur.
    //
    // Geen call_status_at betekent NIET nieuw: een rij die met de hand gezet
    // is heeft die kolom vaak leeg, en dan is er geen nulpunt voor de deadline.
    // Een NOT NULL-filter erbij zodat die rijen niet stil op de enabled_at-
    // vergelijking meeliften.
    if (newOnly) {
      q = q.not('call_status_at', 'is', null).gte('call_status_at', auto.enabled_at);
    }
  } else {
    return [];
  }

  const { data, error } = await q;
  if (error) throw new Error('candidates: ' + error.message);
  return data || [];
}

export async function enrollDueAttendees({ now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const summary = { automations: 0, enrolled: 0, perAutomation: [] };

  const { data: autos, error } = await supabaseAdmin
    .from('event_automations')
    .select('id, trigger_type, trigger_config, scope_type, scope_config, enroll_mode, enabled_at, steps')
    .eq('enabled', true);
  if (error) throw new Error('enroll: load automations: ' + error.message);
  summary.automations = (autos || []).length;

  for (const auto of (autos || [])) {
    try {
      const candidates = await loadCandidatesForAutomation(auto, now);
      // reeds-ingeschreven attendee_ids voor deze automation
      const { data: existingRows } = await supabaseAdmin
        .from('event_automation_runs')
        .select('attendee_id')
        .eq('automation_id', auto.id);
      const existing = new Set((existingRows || []).map((r) => r.attendee_id));
      const toEnroll = candidates.filter((c) => !existing.has(c.id)).slice(0, 200);

      let enrolled = 0;
      for (const att of toEnroll) {
        const { data, error: insErr } = await supabaseAdmin
          .from('event_automation_runs')
          .insert({
            automation_id: auto.id,
            attendee_id: att.id,
            event_id: att.event_id,
            status: 'active',
            current_step_index: 0,
            next_run_at: nowIso,
            steps_snapshot: auto.steps || [],
            context: {},
          })
          .select('id')
          .maybeSingle();
        if (insErr) {
          if (insErr.code !== '23505') console.error('[events-automation enroll] insert:', insErr.message);
          continue;
        }
        if (data) enrolled += 1;
      }
      summary.enrolled += enrolled;
      summary.perAutomation.push({ id: auto.id, trigger: auto.trigger_type, candidates: candidates.length, enrolled });
    } catch (e) {
      console.error('[events-automation enroll] automation', auto.id, e.message);
      summary.perAutomation.push({ id: auto.id, error: e.message });
    }
  }
  return summary;
}

// ── Stepper ───────────────────────────────────────────────────────────────

export async function stepDueRuns({ now = new Date(), limit = 100, abortMs = 50_000 } = {}) {
  const startMs = Date.now();
  const nowIso = now.toISOString();
  const summary = { processed: 0, completed: 0, exited: 0, cancelled: 0 };

  const { data: runs, error } = await supabaseAdmin
    .from('event_automation_runs')
    .select('*')
    .eq('status', 'active')
    .or(`next_run_at.is.null,next_run_at.lte.${nowIso}`)
    .order('next_run_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error('step: load runs: ' + error.message);

  for (const run of (runs || [])) {
    if (Date.now() - startMs > abortMs) break;
    try {
      const { data: attendee } = await supabaseAdmin
        .from('event_attendees')
        // call_status + call_status_at: nodig voor de condition-check
        // 'geen_reactie_sinds_belstatus' (call_status_at is het nulpunt) en
        // voor de idempotency van update_attendee_status.call_status.
            // is_test hoort erbij voor isPlekBezet (buildConditionState.plek_bevestigd).
        .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id, status, assessment_response_id, is_test, call_status, call_status_at')
        .eq('id', run.attendee_id)
        .maybeSingle();
      if (!attendee) {
        await supabaseAdmin.from('event_automation_runs')
          .update({ status: 'cancelled', next_run_at: null, last_error: 'attendee gone', updated_at: nowIso })
          .eq('id', run.id);
        summary.cancelled += 1;
        continue;
      }
      // Switch-guard: is de attendee inmiddels naar een ander event geswitcht,
      // dan mag deze (oude) run geen bevestigingen meer sturen — sluit 'm af
      // i.p.v. door te steppen. Vangt ALLE switch-paden (interactief endpoint,
      // admin-move, follow-up), niet alleen event-choice-submit. Wordt op het
      // step-moment geëvalueerd, dus vóór enige send-stap draait. Alleen
      // 'switched_to_other_event' (bewust niet 'no_show'/'geannuleerd').
      if (attendee.status === 'switched_to_other_event') {
        await supabaseAdmin.from('event_automation_runs')
          .update({ status: 'cancelled', next_run_at: null, last_error: 'attendee switched event', updated_at: nowIso })
          .eq('id', run.id);
        summary.cancelled += 1;
        continue;
      }
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id, title, starts_at, ends_at, location, niveau, capacity, status')
        .eq('id', attendee.event_id)
        .maybeSingle();

      const deps = {
        // ── DE METING VOOR 'geen_reactie_sinds_belstatus' ────────────────
        // In een eigen lib zodat de antwoord-melding-cron
        // (cron-events-geen-gehoor-reacties) dezelfde meting doet en niet zijn
        // eigen definitie van 'heeft geantwoord' krijgt.
        //
        // Nooit throwen: elke tak van de lib komt terug met niet_gemeten +
        // reden, en die gaan als zodanig in het run-log. Een plek vervalt
        // nooit op een meting die niet kon draaien.
        measureCondition: async (check) => {
          if (check !== 'geen_reactie_sinds_belstatus') {
            return { niet_gemeten: true, waar: false, reden: 'geen meter voor ' + check };
          }
          const { geenReactieSindsBelstatus } = await import('./events-geen-gehoor-reactie.js');
          // De client gaat EXPLICIET mee — zie de toelichting bij dezelfde
          // aanroep in api/cron-events-geen-gehoor-reacties.js.
          return await geenReactieSindsBelstatus({
            phone   : attendee.phone,
            email   : attendee.email,
            sinceIso: attendee.call_status_at,
            db      : supabaseAdmin,
          });
        },
        isStepDone: async (idx) => {
          const { data } = await supabaseAdmin
            .from('event_automation_run_log')
            .select('id').eq('run_id', run.id).eq('step_index', idx).maybeSingle();
          return !!data;
        },
        recordLog: async (idx, stepType, result) => {
          const { error: e } = await supabaseAdmin
            .from('event_automation_run_log')
            .insert({ run_id: run.id, step_index: idx, step_type: stepType, result });
          if (e && e.code !== '23505') console.error('[events-automation log]', e.message);
        },
        sendEmail: async (step, ctx) => {
          // Bijlagen-bibliotheek: step.config.attachment_ids (array van uuids)
          // → fetch corresponding rows en mappen naar nodemailer-shape
          //   { filename, path }. Niet-gevonden ids stil overslaan; de e-mail
          //   mag nooit falen op een ontbrekende bijlage.
          let attachments;
          const attIds = Array.isArray(step?.config?.attachment_ids)
            ? step.config.attachment_ids.filter((x) => typeof x === 'string' && x.length > 0)
            : [];
          if (attIds.length > 0) {
            try {
              const { data: rows, error: attErr } = await supabaseAdmin
                .from('event_mail_attachments')
                .select('id, filename, url')
                .in('id', attIds);
              if (attErr) {
                console.error('[events-automation send_email attachments]', attErr.message);
              } else if (Array.isArray(rows) && rows.length > 0) {
                attachments = rows
                  .filter((r) => r && r.url)
                  .map((r) => ({ filename: r.filename || 'bijlage', path: r.url }));
              }
            } catch (e) {
              console.error('[events-automation send_email attachments exception]', e?.message || e);
            }
          }
          const result = await sendEventEmail({
            attendee: ctx.attendee,
            event   : ctx.event,
            subject : step.config && step.config.subject,
            body    : step.config && step.config.body,
            attachments: (attachments && attachments.length > 0) ? attachments : undefined,
          });
          // FIX 4 — log naar event_attendee_comms_log. Awaited binnen
          // try/catch (fail-soft) zodat een log-fout de send-flow niet
          // breekt en de INSERT op Vercel daadwerkelijk afrondt.
          try {
            const map = mapSendStatus(result);
            await logComms({
              attendeeId:      ctx.attendee?.id,
              eventId:         ctx.event?.id,
              channel:         'email',
              status:          map.status,
              subject:         step.config && step.config.subject,
              sentByUserId:    null,
              automationRunId: run.id,
              stepIndex:       typeof ctx.stepIndex === 'number' ? ctx.stepIndex : null,
              failureReason:   map.reason,
            });
          } catch (e) {
            console.error('[automation-engine comms-log mail]', e?.message || e);
          }
          return result;
        },
        sendWhatsApp: async (step, ctx) => {
          const result = await sendEventWhatsAppTemplate({
            attendee:    ctx.attendee,
            event:       ctx.event,
            templateName: step.config && step.config.template_name,
            sentByUserId: null,
          });
          // FIX 4 — log idem als bij sendEmail.
          try {
            const map = mapSendStatus(result);
            await logComms({
              attendeeId:      ctx.attendee?.id,
              eventId:         ctx.event?.id,
              channel:         'whatsapp',
              status:          map.status,
              templateName:    step.config && step.config.template_name,
              sentByUserId:    null,
              automationRunId: run.id,
              stepIndex:       typeof ctx.stepIndex === 'number' ? ctx.stepIndex : null,
              metaWamid:       result?.meta_wamid || null,
              failureReason:   map.reason,
            });
          } catch (e) {
            console.error('[automation-engine comms-log wa]', e?.message || e);
          }
          return result;
        },
        // Fase 4A: set_tag — INSERT in event_attendee_tags. ON CONFLICT DO NOTHING.
        setTag: async (step) => {
          const slug = step?.config?.tag_slug;
          if (!slug || typeof slug !== 'string') {
            return { ok: false, error: 'tag_slug ontbreekt' };
          }
          try {
            const { error } = await supabaseAdmin
              .from('event_attendee_tags')
              .insert({
                attendee_id: attendee.id,
                tag_slug:    slug,
                source:      'automation',
                source_ref:  run.automation_id,
              });
            if (error) {
              if (error.code === '23505') {
                // Already-tagged → idempotent succes.
                return { ok: true, idempotent: true, tag_slug: slug };
              }
              return { ok: false, error: error.message };
            }
            return { ok: true, tag_slug: slug };
          } catch (e) {
            return { ok: false, error: e?.message || 'set_tag failed' };
          }
        },
        // Fase 4A: update_attendee_status — UPDATE event_attendees.status.
        // Idempotent: skip wanneer status al gelijk.
        updateAttendeeStatus: async (step) => {
          const newStatus = step?.config?.new_status;
          if (!newStatus) return { ok: false, error: 'new_status ontbreekt' };

          // ── EEN TESTRUN RAAKT NOOIT EEN ECHTE DEELNEMER ─────────────────
          // Dit is de enige stap in de motor die iets ONHERROEPELIJKS doet aan
          // een inschrijving: 'geannuleerd' zetten neemt iemands plek af, en
          // de automatisatie 'Geen gehoor - laatste kans' doet precies dat.
          //
          // De tester maakt zijn eigen synthetische deelnemer (is_test=true) en
          // hangt de run daaraan, dus in de praktijk kan hij niet bij een echte
          // rij komen. Maar 'in de praktijk' is geen garantie: een POST met een
          // eigen attendee_id, een hergebruik van dit endpoint, of een
          // toekomstige codepad dat een testrun aan een bestaande rij koppelt,
          // zou zonder deze regel een echte inschrijving annuleren.
          //
          // Daarom hard, en NIET stil: de weigering gaat als fout in het
          // run-log, dus je ziet 'm terug in de run-historie op het scherm.
          if (run.is_test === true && attendee.is_test !== true) {
            console.error('[events-automation] testrun', run.id,
              'wilde de status van een ECHTE deelnemer wijzigen:', attendee.id, '→', newStatus);
            return {
              ok: false,
              error: 'geweigerd: een testrun mag de status van een echte deelnemer niet wijzigen'
                + ' (attendee ' + attendee.id + ' heeft is_test=false)',
            };
          }

          // OPTIONELE BELSTATUS. Zonder deze sleutel doet de stap exact wat hij
          // altijd deed. Mét: dezelfde stap zet status 'geannuleerd' én
          // belstatus 'komt_niet', zodat de aanwezigenlijst niet achterblijft
          // met 'geen gehoor' bij iemand wiens plek net vervallen is.
          const newCallStatus = step?.config?.call_status || null;
          const statusAlGoed     = attendee.status === newStatus;
          const belstatusAlGoed  = !newCallStatus || attendee.call_status === newCallStatus;
          if (statusAlGoed && belstatusAlGoed) {
            return { ok: true, skipped: true, reason: 'already-status' };
          }
          try {
            const patch = { updated_at: nowIso };
            if (!statusAlGoed) patch.status = newStatus;
            if (!belstatusAlGoed) {
              patch.call_status    = newCallStatus;
              patch.call_status_at = nowIso;
            }
            const { error } = await supabaseAdmin
              .from('event_attendees')
              .update(patch)
              .eq('id', attendee.id);
            if (error) return { ok: false, error: error.message };
            // Fill: status kan aangepast worden naar 'aangemeld'/'aanwezig' op
            // een rij met assessment_response_id → confirmed rise → event kan
            // vol raken. DB-trigger flipt signups_closed; helper doet Webflow/
            // GHL outbound + reopen-check.
            // DE CASCADE BLIJFT DRAAIEN ZOALS HIJ DRAAIDE. Een vervallen plek
            // komt vrij, en een vol event hoort dan weer open te gaan.
            await onConfirmedAttendeeMutation(event.id, {
              reason: 'automation-updateAttendeeStatus',
            });
            return {
              ok: true,
              new_status: newStatus, previous_status: attendee.status,
              ...(newCallStatus ? {
                new_call_status: newCallStatus, previous_call_status: attendee.call_status || null,
              } : {}),
            };
          } catch (e) {
            return { ok: false, error: e?.message || 'status-update failed' };
          }
        },
        // Fase 4A: send_internal_notification — interne mail naar team.
        // Bypasst events-mailer (geen attendee-templating); raw sendEventMail
        // via mailer.js. Onderwerp + body krijgen [INTERNAL] prefix zodat
        // ze in de inbox visueel apart staan van klantmail.
        sendInternalNotification: async (step) => {
          const subject = step?.config?.subject;
          const body    = step?.config?.body;
          if (!subject || !body) return { ok: false, error: 'subject + body verplicht' };
          const to = step?.config?.to_email
            || process.env.INTERNAL_NOTIFICATION_EMAIL
            || 'jeffrey@deforexopleiding.nl';
          try {
            const { sendEventMail } = await import('../mailer.js');
            const ctxLine = `[Attendee ${attendee?.email || attendee?.phone || attendee?.id} · Event ${event?.title || event?.id}]`;
            const result = await sendEventMail({
              to,
              subject: '[INTERNAL] ' + subject,
              text:    body + '\n\n' + ctxLine,
              html:    `<p>${String(body).replace(/\n/g, '<br>')}</p><hr><p style="color:#888;font-size:12px">${ctxLine}</p>`,
            });
            if (result && result.ok === false) {
              return { ok: false, error: result.error || 'mail failed' };
            }
            return { ok: true, to };
          } catch (e) {
            return { ok: false, error: e?.message || 'internal-notification failed' };
          }
        },
      };

      const u = await advanceRun({ run, attendee, event, now, deps });
      await supabaseAdmin.from('event_automation_runs').update({
        current_step_index: u.current_step_index,
        status: u.status,
        next_run_at: u.next_run_at ? new Date(u.next_run_at).toISOString() : null,
        attempts: u.attempts,
        last_error: u.last_error,
        completed_at: u.completed_at ? new Date(u.completed_at).toISOString() : null,
        updated_at: nowIso,
      }).eq('id', run.id);

      summary.processed += 1;
      if (u.status === 'completed') summary.completed += 1;
      if (u.status === 'exited') summary.exited += 1;
    } catch (e) {
      console.error('[events-automation step] run', run.id, e.message);
      try {
        await supabaseAdmin.from('event_automation_runs')
          .update({ last_error: e.message, updated_at: nowIso }).eq('id', run.id);
      } catch {}
    }
  }
  return summary;
}
