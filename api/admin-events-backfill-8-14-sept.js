// api/admin-events-backfill-8-14-sept.js
//
// ⚠ TIJDELIJK EENMALIG — verwijderen na gebruik. Backfill van gemiste
// event-aanmeldingen tussen 6 en 14 september 2026 (bron: GHL export-CSV).
// Nooit deploy'en zonder review; strikt admin-only.
//
// Draait voor elke ingesloten CSV-rij EXACT dezelfde processSignup()-flow
// als api/events-signup-inbound.js zodat:
//   1. de attendee-rij in event_attendees hetzelfde shape heeft;
//   2. de bestaande automations (cron-events-automations, elke minuut)
//      automatisch bevestiging + reminders vuren via event_automation_runs.
//
// AUTOMATION-GEDRAG BIJ BACKFILL MET VERLEDEN registered_at
// ─────────────────────────────────────────────────────────
// De 3 trigger-types in events-automation-engine.js gedragen zich als volgt
// voor een attendee die 6-8 dagen geleden geregistreerd zou zijn:
//
//   * on_signup                    → GEWENST. Welkom wordt bij eerstvolgende
//                                     cron-tick verstuurd. wait-steps rekenen
//                                     vanaf NU (niet vanaf registered_at) →
//                                     geen "overdue"-cascade.
//   * time_before_event            → GEWENST voor toekomstige triggers. De
//                                     motor enrollt PAS wanneer het event
//                                     binnen hours_before-window komt
//                                     (loadCandidatesForAutomation-window
//                                     check op events.starts_at). Voor
//                                     19/23/26 sept vandaag 14 sept →
//                                     window is nog niet open → motor doet
//                                     niks tot de juiste dag.
//   * on_assessment_not_completed_after  → RISICO. Selector doet
//                                     `registered_at <= now - hours` — een
//                                     backfill-attendee met registered_at
//                                     8 dagen terug matcht ONMIDDELLIJK op
//                                     een 24u/48u/72u-nudge → assessment-
//                                     verwijt gaat direct uit.
//                                     → We inserten PREEMPTIEF een
//                                     event_automation_runs-rij met
//                                     status='cancelled' zodat de motor 'em
//                                     overslaat. GEEN send.
//
// GET  /api/admin-events-backfill-8-14-sept?dry_run=1
// POST /api/admin-events-backfill-8-14-sept   { "dry_run": false }
//
// Auth: verifyAdmin (super_admin / admin sessie). Bearer JWT vereist.
// Idempotent: bestaande (event_id, lower(email)) rij → skip, geen dup-insert.
//
// 0 incasso-writes. Geen finance/dunning/arrangement/pending-action touches.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { resolveEventByLabel } from './_lib/event-label-matcher.js';
import { processSignup } from './_lib/event-signup-processor.js';

// De CSV-rijen (bron: 262c65f5-…-csv). Test-rij jeffreybiemold@gmail.com bewust
// weggelaten. Said Hachemi = 2 events = 2 aanmeldingen.
const ROWS = [
  { first: 'Jimco',     last: 'Schepens',          phone: '+32494796317', email: 'jimboycoast@hotmail.com',       label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-14T04:54:00Z' },
  { first: 'Tony',      last: 'Cherrette',         phone: '+32475567803', email: 'info@tslprojects.be',           label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-13T22:54:00Z' },
  { first: 'Micah',     last: 'Van Meckeren',      phone: '+32472771752', email: 'xennazed666@gmail.com',         label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-12T10:42:00Z' },
  { first: 'Gabryel',   last: 'Moura Da Silva',    phone: '+32472335111', email: 'gabryel.mds2005@gmail.com',     label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-12T09:23:00Z' },
  { first: 'Omar',      last: 'Adamu',             phone: '+32472028222', email: 'adamuomar6688@gmail.com',       label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-12T09:04:00Z' },
  { first: 'Ahmed',     last: 'Albattniji',        phone: '+32487795566', email: 'albattnijiahmed@gmail.col',     label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-10T14:24:00Z' },
  { first: 'Zakaria',   last: 'Bazar',             phone: '+32456992183', email: 'zakariajolie3@gmail.com',       label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-09T18:38:00Z' },
  { first: 'Anne',      last: 'Janssens',          phone: '+32474885993', email: 'diabolo1_8@hotmail.com',        label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-09T02:26:00Z' },
  { first: 'Stefaan',   last: 'De Prest',          phone: '+32495994224', email: 'stefaan.deprest@executus.be',   label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-08T18:12:00Z' },
  { first: 'Mariya',    last: 'Koteva',            phone: '+32471050364', email: 'mariya.koteva@gmail.com',       label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-08T17:39:00Z' },
  { first: 'Elias',     last: 'Vieren',            phone: '+32470085329', email: 'elias.vieren@icloud.com',       label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-08T13:02:00Z' },
  { first: 'Pres',      last: 'Uwadiae',           phone: '+32465682643', email: 'presley.uwadiae05@gmail.com',   label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-07T23:52:00Z' },
  { first: 'Florjan',   last: 'Xani',              phone: '+32456219984', email: 'florian.xaniibe@icloud.com',    label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-07T13:08:00Z' },
  { first: 'Ilian',     last: 'Letaief',           phone: '+32493446583', email: 'ilianletaief@outlook.com',      label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-07T11:15:00Z' },
  { first: 'Ella',      last: 'Depp',              phone: '+32474346799', email: 'ellalouise.dep.eng@gmail.com',  label: 'Zaterdag 19 september 2026 | 12:00 - 15:00 | Masterclass', submitted: '2026-09-07T10:30:00Z' },
  { first: 'Jens',      last: 'Van Lysebettens',   phone: '+32479791884', email: 'info@studio-j.be',              label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-07T08:00:00Z' },
  { first: 'Elias',     last: 'Mesolaras',         phone: '+32489256898', email: 'eliasmesolaras@outlook.com',    label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-07T06:21:00Z' },
  { first: 'Makbule',   last: 'Aydemir',           phone: '+32472558241', email: 'mvkbuleaydemir@gmail.com',      label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-07T05:08:00Z' },
  { first: 'Shannon',   last: 'Bardoel',           phone: '+32472258503', email: 'shannon.bardoel@icloud.com',    label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-07T00:10:00Z' },
  { first: 'MARTIN',    last: 'ELOCOBE',           phone: '+32470273548', email: 'elocobemart@gmail.com',         label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-06T19:53:00Z' },
  { first: 'Alain',     last: 'Nzisabira',         phone: '+32497786606', email: 'alainnzisabira234@gmail.com',   label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-06T14:39:00Z' },
  { first: 'Said',      last: 'Hachemi',           phone: '+32487105728', email: 'hachemim389@gmail.com',         label: 'Woensdag 23 september 2026 | 18:00 - 21:00 | Masterclass', submitted: '2026-09-06T09:52:00Z' },
  { first: 'Said',      last: 'Hachemi',           phone: '+32487105728', email: 'hachemim389@gmail.com',         label: 'Zaterdag 26 september 2026 | 10:00 - 13:00 | Masterclass', submitted: '2026-09-06T04:59:00Z' },
];

const CREATED_VIA = 'ghl_inbound_backfill';

// ── Automation-analyse (dry-run + preemptive-cancel op overdue) ────────────

// Laadt alle enabled automations één keer. Scope-match wordt per attendee/
// event beoordeeld door scopeMatches().
async function loadAllAutomations() {
  const { data, error } = await supabaseAdmin
    .from('event_automations')
    .select('id, name, trigger_type, trigger_config, scope_type, scope_config, enroll_mode, enabled_at, steps')
    .eq('enabled', true);
  if (error) throw new Error('load automations: ' + error.message);
  return data || [];
}

async function scopeMatches(auto, event) {
  if (!auto.scope_type || auto.scope_type === 'all') return true;
  if (auto.scope_type === 'niveau') {
    const target = auto.scope_config && auto.scope_config.niveau;
    return !!target && String(event.niveau || '') === String(target);
  }
  if (auto.scope_type === 'events') {
    const ids = (auto.scope_config && Array.isArray(auto.scope_config.event_ids))
      ? auto.scope_config.event_ids : [];
    return ids.includes(event.id);
  }
  return false;
}

/**
 * Per (attendee, event, registeredAt) bepalen wat elke automation ZOU doen.
 * Return: [{ automation_id, name, trigger, verdict, when?, reason?, first_step? }]
 *   verdict = 'enroll_now'          → motor picks up, first send op eerstvolgende tick
 *           = 'enroll_future_window' → time_before_event, motor pikt pas op wanneer
 *                                       event binnen hours_before-window komt
 *           = 'skip_overdue'         → on_assessment_not_completed_after met
 *                                       registered_at al voorbij de cutoff — wij
 *                                       cancelen preemptief
 *           = 'no_match_scope'       → scope wijst dit event af
 *           = 'no_match_trigger'     → trigger sluit deze attendee-status uit
 *                                       (bv. on_assessment_completed zonder
 *                                       assessment_response_id)
 */
async function analyseAutomations({ automations, event, registeredAt, hasAssessment, now }) {
  const nowMs = now.getTime();
  const regMs = new Date(registeredAt).getTime();
  const eventMs = new Date(event.starts_at).getTime();
  const results = [];

  for (const auto of automations) {
    const base = {
      automation_id: auto.id,
      name: auto.name,
      trigger: auto.trigger_type,
    };
    // enabled_at + enroll_mode='new_only' ⇒ oude registered_at valt buiten;
    // let's compute the newOnly-cutoff.
    const newOnly = auto.enroll_mode === 'new_only' && auto.enabled_at;
    const enabledAtMs = newOnly ? new Date(auto.enabled_at).getTime() : null;

    if (!(await scopeMatches(auto, event))) {
      results.push({ ...base, verdict: 'no_match_scope' });
      continue;
    }

    if (auto.trigger_type === 'on_signup') {
      if (hasAssessment) { results.push({ ...base, verdict: 'no_match_trigger', reason: 'assessment_response_id IS NOT NULL — deze attendee heeft geen welkom meer nodig' }); continue; }
      if (newOnly && regMs < enabledAtMs) { results.push({ ...base, verdict: 'no_match_trigger', reason: 'enroll_mode=new_only en registered_at < enabled_at' }); continue; }
      results.push({ ...base, verdict: 'enroll_now', when: 'binnen ~1 min (welkom)', first_step: firstSendStep(auto.steps) });
      continue;
    }

    if (auto.trigger_type === 'on_assessment_completed') {
      if (!hasAssessment) { results.push({ ...base, verdict: 'no_match_trigger', reason: 'nog geen assessment ingevuld' }); continue; }
      results.push({ ...base, verdict: 'enroll_now', when: 'binnen ~1 min', first_step: firstSendStep(auto.steps) });
      continue;
    }

    if (auto.trigger_type === 'time_before_event') {
      const hours = Number(auto.trigger_config && auto.trigger_config.hours_before) || 0;
      const windowOpensMs = eventMs - hours * 3_600_000;
      if (eventMs <= nowMs) {
        results.push({ ...base, verdict: 'no_match_trigger', reason: 'event al voorbij' });
        continue;
      }
      if (windowOpensMs <= nowMs) {
        results.push({ ...base, verdict: 'enroll_now', when: `binnen ~1 min (${hours}u vóór event nu al open)`, first_step: firstSendStep(auto.steps) });
      } else {
        results.push({ ...base, verdict: 'enroll_future_window', when: `motor pikt op vanaf ${new Date(windowOpensMs).toISOString()}`, first_step: firstSendStep(auto.steps) });
      }
      continue;
    }

    if (auto.trigger_type === 'on_assessment_not_completed_after') {
      if (hasAssessment) { results.push({ ...base, verdict: 'no_match_trigger', reason: 'assessment al ingevuld' }); continue; }
      const hours = Number(auto.trigger_config && auto.trigger_config.hours_after_signup) || 0;
      if (!(hours > 0)) { results.push({ ...base, verdict: 'no_match_trigger', reason: 'hours_after_signup ontbreekt' }); continue; }
      const cutoffMs = regMs + hours * 3_600_000;
      const overdue = nowMs >= cutoffMs;
      if (overdue) {
        results.push({
          ...base, verdict: 'skip_overdue',
          reason: `registered_at ${new Date(regMs).toISOString()} + ${hours}u = cutoff ${new Date(cutoffMs).toISOString()} ligt al in het verleden`,
          first_step: firstSendStep(auto.steps),
        });
      } else if (newOnly && regMs < enabledAtMs) {
        results.push({ ...base, verdict: 'no_match_trigger', reason: 'enroll_mode=new_only en registered_at < enabled_at' });
      } else {
        results.push({ ...base, verdict: 'enroll_future_window', when: `nudge om ${new Date(cutoffMs).toISOString()}`, first_step: firstSendStep(auto.steps) });
      }
      continue;
    }

    results.push({ ...base, verdict: 'no_match_trigger', reason: 'onbekend trigger_type' });
  }

  return results;
}

// Kies de eerste send-stap uit steps voor de dry-run rapportage.
function firstSendStep(steps) {
  const arr = Array.isArray(steps) ? steps : [];
  for (const s of arr) {
    if (s && (s.type === 'send_email' || s.type === 'send_whatsapp')) {
      const cfg = s.config || {};
      return {
        type: s.type,
        template: cfg.template_name || cfg.template || cfg.subject || null,
      };
    }
  }
  return null;
}

// Preemptief een cancelled run-rij inzetten zodat de motor deze
// automation overslaat voor deze attendee. UNIQUE (automation_id, attendee_id)
// zorgt dat de reguliere enroll niet nogmaals insert.
async function preemptCancelRun({ automation, attendeeId, eventId, reason }) {
  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('event_automation_runs')
    .insert({
      automation_id     : automation.id,
      attendee_id       : attendeeId,
      event_id          : eventId,
      status            : 'cancelled',
      current_step_index: 0,
      next_run_at       : null,
      steps_snapshot    : automation.steps || [],
      context           : { reason: 'backfill_skip_overdue', detail: reason },
      last_error        : `skipped by backfill: ${reason}`,
      created_at        : nowIso,
      updated_at        : nowIso,
      completed_at      : nowIso,
    });
  if (error && error.code !== '23505') {
    console.warn('[backfill] preempt-cancel insert (soft):', error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET (dry-run) of POST (uitvoeren)' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  const dryRun = req.method === 'GET'
    ? String(req.query?.dry_run || '1') !== '0'
    : !!(req.body && req.body.dry_run === true);

  const now = new Date();
  const automations = await loadAllAutomations();

  const summary = {
    dry_run        : dryRun,
    now            : now.toISOString(),
    total          : ROWS.length,
    per_event      : {},
    aangemaakt     : 0,
    overgeslagen   : 0,   // duplicate email+event_id
    no_match       : 0,
    error          : 0,
    preempt_cancels: 0,
    automations_total: automations.length,
    resultaten     : [],
  };

  for (const row of ROWS) {
    const rowResult = {
      naam: `${row.first} ${row.last}`.trim(),
      email: row.email,
      label: row.label,
      submitted: row.submitted,
    };

    let lookup;
    try {
      lookup = await resolveEventByLabel(row.label);
    } catch (e) {
      rowResult.status = 'error';
      rowResult.error = 'label-resolve: ' + (e?.message || String(e));
      summary.error += 1;
      summary.resultaten.push(rowResult);
      continue;
    }

    if (!lookup.matches || lookup.matches.length === 0) {
      rowResult.status = 'no_match';
      rowResult.resolve_reason = lookup.reason;
      summary.no_match += 1;
      summary.resultaten.push(rowResult);
      continue;
    }

    const chosenEvent = lookup.matches[0];
    rowResult.event_id = chosenEvent.id;
    rowResult.event_title = chosenEvent.title;

    // Automation-analyse (dry-run TOONT, uitvoer GEBRUIKT).
    const analysis = await analyseAutomations({
      automations,
      event: chosenEvent,
      registeredAt: row.submitted,
      hasAssessment: false,
      now,
    });
    rowResult.automations = analysis;

    if (dryRun) {
      // Alleen tellen wat er ZOU gebeuren — geen writes.
      rowResult.status = 'dry_run';
      const overdue = analysis.filter(a => a.verdict === 'skip_overdue');
      if (overdue.length) summary.preempt_cancels += overdue.length;
      summary.resultaten.push(rowResult);
      continue;
    }

    let attendeeId = null;
    try {
      const processed = await processSignup({
        event: chosenEvent,
        isAmbiguous: lookup.matches.length > 1,
        matches: lookup.matches,
        payload: {
          first_name    : row.first,
          last_name     : row.last,
          email         : row.email.trim().toLowerCase(),
          phone         : row.phone,
          registered_at : row.submitted,
        },
        ghlContactId       : null,
        ghlFormSubmissionId: null,
        createdVia         : CREATED_VIA,
        source             : 'ghl',
      });

      rowResult.status       = processed.deduplicated ? 'overgeslagen' : 'aangemaakt';
      rowResult.attendee_id  = processed.attendee_id;
      rowResult.dedup_note   = processed.dedup_note;
      rowResult.confirmed    = processed.confirmed_count;
      rowResult.gastenlijst  = processed.gastenlijst_label;
      attendeeId             = processed.attendee_id;

      if (processed.deduplicated) summary.overgeslagen += 1;
      else                        summary.aangemaakt   += 1;

      const bucket = summary.per_event[chosenEvent.id] || {
        title: chosenEvent.title, aangemaakt: 0, overgeslagen: 0,
      };
      if (processed.deduplicated) bucket.overgeslagen += 1;
      else                        bucket.aangemaakt   += 1;
      summary.per_event[chosenEvent.id] = bucket;
    } catch (e) {
      rowResult.status = 'error';
      rowResult.error = e?.message || String(e);
      summary.error += 1;
      summary.resultaten.push(rowResult);
      continue;
    }

    // Preemptive-cancel voor overdue-triggers zodat de motor die overslaat.
    // Alleen wanneer een nieuwe attendee is aangemaakt — bij deduplicated bestaat
    // 'ie al en heeft de motor 'em (waarschijnlijk) al eens verwerkt/overgeslagen;
    // niet nogmaals insertsen (UNIQUE zou 'em anders soft-catchen, maar semantisch
    // klopt 't niet om een oud dedup-geval te 'skipen').
    if (rowResult.status === 'aangemaakt' && attendeeId) {
      const cancelled = [];
      for (const a of analysis.filter(a => a.verdict === 'skip_overdue')) {
        const auto = automations.find(x => x.id === a.automation_id);
        if (!auto) continue;
        const r = await preemptCancelRun({
          automation: auto,
          attendeeId,
          eventId   : chosenEvent.id,
          reason    : a.reason || 'overdue trigger',
        });
        if (r.ok) { cancelled.push(auto.id); summary.preempt_cancels += 1; }
      }
      rowResult.preempt_cancelled_automations = cancelled;
    }

    summary.resultaten.push(rowResult);
  }

  summary.note_bevestiging = dryRun
    ? 'DRY-RUN — geen writes. Onder resultaten[i].automations zie je per attendee ' +
      'welke automations zouden vuren (enroll_now / enroll_future_window / ' +
      'skip_overdue / no_match_*). skip_overdue-triggers krijgen in de POST-run ' +
      'een preemptieve cancelled-run zodat de motor ze overslaat.'
    : `${summary.aangemaakt} aangemaakt, ${summary.overgeslagen} overgeslagen, ` +
      `${summary.preempt_cancels} preemptieve cancels voor overdue-triggers. ` +
      'De reguliere automations (on_signup welkom + toekomstige time_before_event ' +
      'reminders) pikt cron-events-automations binnen ~1 min automatisch op.';

  return res.status(200).json(summary);
}
