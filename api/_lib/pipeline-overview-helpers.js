// api/_lib/pipeline-overview-helpers.js
//
// Pure functies voor api/finance-pipeline-overview.js. Geen DB, geen fetch —
// alleen input (reeds-opgehaalde rijen) → output (bucket / projectie /
// reden-tekst / incasso-conditie). Volledig testbaar zonder mocks.
//
// De endpoint doet één keer per request alle DB-calls parallel, geeft het
// resultaat aan deze helpers, en de UI krijgt de samengestelde response.

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Constanten ─────────────────────────────────────────────────────────────
//
// De actieve buckets zijn granulair op basis van NL-kalenderdag (niet op
// 7-daagse window — dat bleek in productie geen onderscheid te maken want
// alle ~79 actieve runs vielen binnen een week). Vandaag / morgen / later
// geven de eigenaar direct zicht op wat er over enkele uren gebeurt en
// wat morgen aan de beurt komt.

const BUCKET_VANDAAG                = 'vandaag';
const BUCKET_MORGEN                 = 'morgen';
const BUCKET_LATER                  = 'later';
const BUCKET_WACHT_KLANT            = 'wacht_klant';
const BUCKET_WACHT_REGELING         = 'wacht_regeling';
const BUCKET_WACHT_GESPREK          = 'wacht_gesprek';
const BUCKET_WACHT_HANDMATIG        = 'wacht_handmatig';
const BUCKET_WACHT_OPENSTAANDE_ACTIE = 'wacht_openstaande_actie';
const BUCKET_KLAAR                  = 'klaar';

// Menselijk-leesbare labels voor de UI (KPI-strip-labels).
const BUCKET_LABELS = Object.freeze({
  [BUCKET_VANDAAG]:                 'Vandaag',
  [BUCKET_MORGEN]:                  'Morgen',
  [BUCKET_LATER]:                   'Later',
  [BUCKET_WACHT_KLANT]:             'Wacht op klant',
  [BUCKET_WACHT_REGELING]:          'Wacht op regeling',
  [BUCKET_WACHT_GESPREK]:           'Wacht op gesprek',
  [BUCKET_WACHT_HANDMATIG]:         'Handmatig gepauzeerd',
  [BUCKET_WACHT_OPENSTAANDE_ACTIE]: 'Wacht op openstaande actie',
  [BUCKET_KLAAR]:                   'Klaar (laatste 30 dagen)',
});

// Formatteer een timestamp (ms of ISO-string) naar yyyy-mm-dd in NL-tijd
// (Europe/Amsterdam). Consistent met api/_lib/onboarding-start-date.js.
// Retourneert null bij invalid input.
function nlDateOf(input) {
  const d = (typeof input === 'number') ? new Date(input)
          : (input instanceof Date) ? input
          : (typeof input === 'string') ? new Date(input)
          : null;
  if (!d || isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(d);   // "yyyy-mm-dd"
}

// yyyy-mm-dd + N kalenderdagen. UTC-anker om DST-drift te vermijden.
function shiftNlDate(ymd, deltaDays) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d));
  anchor.setUTCDate(anchor.getUTCDate() + (Number(deltaDays) || 0));
  const yy = anchor.getUTCFullYear();
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(anchor.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ── classifyRunBucket ──────────────────────────────────────────────────────
//
// Beslist welke bucket een run in valt. INPUT:
//   - run: dunning_workflow_runs-rij
//   - latestLog: laatste dunning_log-rij voor deze run (of null)
//   - nowMs: Date.now() equivalent (injecteerbaar voor tests)
//
// OUTPUT: één van BUCKET_* strings, of null bij onbekende status.
//
// Regels (in deze volgorde — first match wins):
//   status='completed'|'cancelled' → 'klaar' (endpoint filtert al op ≤30d
//                                             completed_at zodat we dit hier
//                                             niet nog eens hoeven te doen)
//   status='paused' → sub-tak op basis van reden (kolom + log-fallback)
//   status='active' + latestLog.event_type='skipped_open_action' → 'wacht_openstaande_actie'
//   status='active' → vandaag / morgen / later op basis van NL-datum van
//                     next_action_at. Grens ligt op middernacht Europe/
//                     Amsterdam (niet op nu+24u); 22:59 UTC = 00:59 NL
//                     valt in "morgen" ook al is dat maar 3 uur weg.
//                     Vandaag/morgen/later i.p.v. deze-week/loopt omdat
//                     die eerste indeling in productie geen onderscheid
//                     maakte (~79 actieve runs allemaal binnen een week).
export function classifyRunBucket(run, latestLog, nowMs) {
  if (!run) return null;
  const status = String(run.status || '').toLowerCase();
  const now    = Number.isFinite(nowMs) ? nowMs : Date.now();

  if (status === 'completed' || status === 'cancelled') return BUCKET_KLAAR;

  if (status === 'paused') {
    // KOLOM-first: arrangement en conversation zijn expliciet vastgelegd.
    if (run.paused_by_arrangement_id)  return BUCKET_WACHT_REGELING;
    if (run.paused_by_conversation_id) return BUCKET_WACHT_GESPREK;
    // FALLBACK via meest recente log: reply-guard vs handmatige pauze
    // hebben geen kolom-reden (zie recon punt 4).
    const evt = String(latestLog?.event_type || '').toLowerCase();
    if (evt === 'paused_customer_replied') return BUCKET_WACHT_KLANT;
    if (evt === 'run_control_pause')       return BUCKET_WACHT_HANDMATIG;
    // Onbekende paused-oorzaak — behandel als handmatig (safer default:
    // vraagt aandacht van een mens i.p.v. genegeerd worden).
    return BUCKET_WACHT_HANDMATIG;
  }

  if (status === 'active') {
    // "Openstaande actie skipt de tick" is technisch active + geen advance.
    // Detectie: recentste log = skipped_open_action.
    const evt = String(latestLog?.event_type || '').toLowerCase();
    if (evt === 'skipped_open_action') return BUCKET_WACHT_OPENSTAANDE_ACTIE;

    // Vandaag / morgen / later op basis van NL-kalenderdag.
    // Runs zonder next_action_at vallen in 'later' (kunnen niet ingeschat).
    if (!run.next_action_at) return BUCKET_LATER;
    const naNlDate  = nlDateOf(run.next_action_at);
    const todayNl   = nlDateOf(now);
    if (!naNlDate || !todayNl) return BUCKET_LATER;
    if (naNlDate <= todayNl)        return BUCKET_VANDAAG;   // ook verleden = "vandaag actie"
    if (naNlDate === shiftNlDate(todayNl, 1)) return BUCKET_MORGEN;
    return BUCKET_LATER;
  }

  return null;
}

// ── reconstructPauseReason ────────────────────────────────────────────────
//
// Zet de bucket-code + rauwe data om in een menselijke reden-string + meta.
// Werkt voor paused-runs (WACHT_*) én voor de active-maar-stilstaande
// WACHT_OPENSTAANDE_ACTIE.
//
// OUTPUT: { code, message, channel?, user_id?, at? }
//   code    = interne key (arrangement / conversation / customer_replied /
//             manual / open_action)
//   message = NL-tekst voor de UI
//   at      = timestamp van de pauze/skip als bekend
//   channel = alleen bij customer_replied (whatsapp / email / …)
//   user_id = alleen bij handmatige pauze
export function reconstructPauseReason(run, latestLog) {
  if (!run) return null;
  const status = String(run.status || '').toLowerCase();

  if (status === 'paused') {
    if (run.paused_by_arrangement_id) {
      return {
        code:    'arrangement',
        message: 'Betalings-regeling is actief — aanmaan-flow wacht tot regeling nagekomen of verbroken is.',
        at:      run.updated_at || null,
      };
    }
    if (run.paused_by_conversation_id) {
      return {
        code:    'conversation',
        message: 'Er loopt een gesprek met de klant — aanmaan-flow wacht tot dat is afgehandeld.',
        at:      run.updated_at || null,
      };
    }
    // Log-fallback.
    const evt     = String(latestLog?.event_type || '').toLowerCase();
    const payload = latestLog?.payload || {};
    if (evt === 'paused_customer_replied') {
      const channel = payload.channel || null;
      const chanTxt = channel ? ` via ${channel}` : '';
      return {
        code:    'customer_replied',
        message: `Klant reageerde${chanTxt} — aanmaan-flow gepauzeerd tot dat is afgehandeld.`,
        at:      latestLog?.created_at || run.updated_at || null,
        channel,
      };
    }
    if (evt === 'run_control_pause') {
      const uid = payload.user_id || null;
      return {
        code:    'manual',
        message: 'Handmatig gepauzeerd door een medewerker.',
        at:      latestLog?.created_at || run.updated_at || null,
        user_id: uid,
      };
    }
    // Onbekende paused-oorzaak.
    return {
      code:    'manual',
      message: 'Gepauzeerd (reden onbekend — mogelijk vóór de reden-registratie werd toegevoegd).',
      at:      run.updated_at || null,
    };
  }

  if (status === 'active') {
    const evt = String(latestLog?.event_type || '').toLowerCase();
    if (evt === 'skipped_open_action') {
      const payload = latestLog?.payload || {};
      const count   = Number(payload.count) || 0;
      const types   = Array.isArray(payload.action_types) ? payload.action_types : [];
      const typeTxt = types.length ? ` (${types.join(', ')})` : '';
      return {
        code:    'open_action',
        message: `Workflow slaat de tick over omdat er ${count > 0 ? count + ' ' : ''}openstaande actie(s)${typeTxt} liggen die eerst afgehandeld moeten worden.`,
        at:      latestLog?.created_at || null,
      };
    }
  }

  return null;
}

// ── projectRunTimeline ────────────────────────────────────────────────────
//
// Voor een ACTIEVE run: reken vooruit vanaf next_action_at door de resterende
// stappen. Wacht-stappen tellen als kalenderdagen; niet-wacht-stappen tellen
// als "onmiddellijk daarna" (0 dagen). Voor paused/completed/cancelled runs:
// return null (geen vooruit-berekening).
//
// INPUT:
//   - run
//   - stepsForWorkflow: alle steps voor dit run.workflow_id, gesorteerd op step_order
//
// OUTPUT: {
//   current_step: { order, type, description }   — huidige stap-context
//   next_action:  { type, at, is_estimate: false }  — bekend uit run.next_action_at
//   next_letter:  { at, is_estimate: true } | null  — eerstvolgende brief-stap
//   is_estimate:  true                              — alle datums na next_action_at
//   total_steps:  int                               — voor voortgangsindicator
// }
//
// De caller kan zelf de "als niks tussenkomt"-disclaimer aan de UI meegeven.
export function projectRunTimeline(run, stepsForWorkflow, nowMs) {
  if (!run) return null;
  const status = String(run.status || '').toLowerCase();
  if (status !== 'active') return null;   // paused/completed/cancelled → geen projectie
  const steps = Array.isArray(stepsForWorkflow) ? stepsForWorkflow : [];
  if (!steps.length) return null;

  const current = steps.find((s) => s.id === run.current_step_id);
  if (!current) return null;   // step_missing edge-case — engine handelt af

  const naIso = run.next_action_at || null;
  const naTs  = naIso ? Date.parse(naIso) : null;

  // Resterende stappen NA de huidige (step_order > current.step_order).
  const remaining = steps.filter((s) => s.step_order > current.step_order);

  // Vooruit-loop: cumulatieve datum-offset vanaf next_action_at. Elke
  // wait-stap voegt config.days toe. Andere stap-types tellen als 0d
  // (voer direct uit na de vorige).
  let cursor = Number.isFinite(naTs) ? naTs : null;
  let firstLetterAt = null;
  const isLetterType = (t) => String(t || '').toLowerCase() === 'brief'
    || String(t || '').toLowerCase() === 'letter';

  // NB: het huidige workflow-model heeft géén 'brief' als step_type.
  // "Brief uitgaan" gebeurt in praktijk via een aparte incasso-brief-flow
  // (cron-incasso-auto). Voor de vooruit-blik geven we daarom de eerst-
  // volgende EMAIL/WHATSAPP-stap als "eerstvolgend contact"-indicator.
  // Kan later vervangen worden zodra er een dedicated brief-step-type is.
  const isContactType = (t) => {
    const s = String(t || '').toLowerCase();
    return s === 'email' || s === 'whatsapp';
  };

  for (const step of remaining) {
    if (String(step.step_type || '').toLowerCase() === 'wait') {
      const days = Number(step?.config?.days) || 0;
      if (cursor != null) cursor += days * DAY_MS;
    } else if (isContactType(step.step_type) || isLetterType(step.step_type)) {
      if (firstLetterAt == null && cursor != null) firstLetterAt = cursor;
    }
  }

  return {
    current_step: {
      order:       current.step_order,
      type:        current.step_type,
      description: current.config?.description || null,
    },
    total_steps: steps.length,
    next_action: {
      type:        current.step_type,   // huidige stap = eerstvolgende actie
      at:          naIso,
      is_estimate: false,               // next_action_at is exact uit engine
    },
    next_contact: firstLetterAt != null
      ? { at: new Date(firstLetterAt).toISOString(), is_estimate: true }
      : null,
    is_estimate: true,                  // alle datums na next_action zijn schattingen
  };
}

// ── incassoCondition ──────────────────────────────────────────────────────
//
// Bepaalt de incasso-status van een klant. Geeft GEEN datum, wel een
// voorwaarde in gewone taal. Voor kandidaten (VERBROKEN arrangement,
// refusal-flag) is de conditie duidelijker ("kandidaat vanaf morgen");
// voor de rest een generieke drempel-tekst.
//
// INPUT:
//   - arrangements: payment_arrangements voor deze klant
//   - refusalFlagged: bool — laatste refusal-flag-status in dunning_log
//   - settings: { min_days_overdue, min_amount_open_eur, require_broken_arrangement, ... }
//
// OUTPUT: { is_candidate: bool, message: string }
export function incassoCondition(arrangements, refusalFlagged, settings) {
  const arrs = Array.isArray(arrangements) ? arrangements : [];
  const hasBroken = arrs.some((a) => String(a.status || '').toUpperCase() === 'VERBROKEN');
  const minDays   = Number(settings?.min_days_overdue) || 14;

  if (hasBroken) {
    return {
      is_candidate: true,
      message: 'Kandidaat voor incasso — er is een verbroken betaal-regeling.',
    };
  }
  if (refusalFlagged) {
    return {
      is_candidate: true,
      message: 'Kandidaat voor incasso — betaal-weigering vastgelegd.',
    };
  }
  return {
    is_candidate: false,
    message: `Gaat naar incasso vanaf ${minDays} dagen te laat + geen reactie op laatste aanmaning.`,
  };
}

// ── buildBucketCounts ─────────────────────────────────────────────────────
//
// Aggregeert een lijst van runs naar de KPI-tellers voor de strip bovenaan.
// Verwacht dat classifyRunBucket al per run gedraaid is en de bucket op
// run._bucket staat (mutatie door caller).
export function buildBucketCounts(runsWithBucket) {
  const counts = {
    [BUCKET_VANDAAG]:                 0,
    [BUCKET_MORGEN]:                  0,
    [BUCKET_LATER]:                   0,
    [BUCKET_WACHT_KLANT]:             0,
    [BUCKET_WACHT_REGELING]:          0,
    [BUCKET_WACHT_GESPREK]:           0,
    [BUCKET_WACHT_HANDMATIG]:         0,
    [BUCKET_WACHT_OPENSTAANDE_ACTIE]: 0,
    [BUCKET_KLAAR]:                   0,
  };
  const klaarByReason = {};   // completion_reason → count

  for (const r of (runsWithBucket || [])) {
    if (r?._bucket && counts[r._bucket] != null) counts[r._bucket]++;
    if (r?._bucket === BUCKET_KLAAR) {
      const reason = r.completion_reason || 'onbekend';
      klaarByReason[reason] = (klaarByReason[reason] || 0) + 1;
    }
  }
  return { counts, klaar_by_reason: klaarByReason };
}

export {
  BUCKET_VANDAAG,
  BUCKET_MORGEN,
  BUCKET_LATER,
  BUCKET_WACHT_KLANT,
  BUCKET_WACHT_REGELING,
  BUCKET_WACHT_GESPREK,
  BUCKET_WACHT_HANDMATIG,
  BUCKET_WACHT_OPENSTAANDE_ACTIE,
  BUCKET_KLAAR,
  BUCKET_LABELS,
  nlDateOf,
  shiftNlDate,
};
