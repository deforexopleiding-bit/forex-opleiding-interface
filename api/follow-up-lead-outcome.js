// api/follow-up-lead-outcome.js
//
// POST — cadans-motor voor Sales-cockpit Leads-tab (Fase 2).
//
// Body: {
//   lead_id: uuid,
//   outcome: 'geen_gehoor' | 'voicemail' | 'foutief_nummer' |
//            'terugbel' | 'zoom_ingepland' |
//            'sale' | 'geen_interesse' | 'snooze' |
//            'noshow' | 'gesprek_gehad',
//   terugbel_datum?: ISO,     // vereist bij terugbel / zoom_ingepland
//   is_hot?: boolean,          // alleen zinvol bij terugbel
//   snooze_months?: 6 | 12,    // vereist bij snooze
//   reason?: string,           // optioneel bij geen_interesse
// }
//
// Permissie + owner-gate: exact zoals api/follow-up-lead-update.js.
// Cadans-constante: [+2u, +1d, +3d] voor poging 1→2→3. MAX_ATTEMPTS = 4.
// Elke succesvolle mutatie logt automatisch een follow_up_lead_notes-rij
// met entry_kind='outcome' + Nederlands leesbare tekst. Bij 42703 op
// entry_kind fallback zonder die kolom (schema-vriendelijk).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createAppointmentForLead, mapGhlError } from './_lib/create-appointment-from-lead.js';

// Feature-flag: cockpit-uitkomst 'zoom_ingepland' maakt een ECHTE
// GHL-afspraak + Zoom-link i.p.v. alleen een kale lead te patchen.
// Default AAN (any waarde ≠ 'false'); zet op 'false' in Vercel-env om
// terug te vallen op oude gedrag.
const COCKPIT_ZOOM_AS_APPOINTMENT = String(process.env.COCKPIT_ZOOM_AS_APPOINTMENT || 'true') !== 'false';
const COCKPIT_ZOOM_DURATION_MIN = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOMES = new Set([
  'geen_gehoor', 'voicemail', 'foutief_nummer',
  'terugbel', 'zoom_ingepland',
  'sale', 'geen_interesse', 'snooze',
  'noshow', 'gesprek_gehad',
  // WhatsApp gestuurd: lead wordt NIET afgesloten — komt terug op de
  // Werklijst na WHATSAPP_FOLLOWUP_DAYS zodat sales/Dave hem opvolgt.
  'whatsapp_gestuurd',
  // Event-specifieke uitkomsten (alleen voor source='event').
  // 'bevestigd'  → lead 'verlengd' (afgehandeld, gastenlijst blijft).
  // 'komt_niet'  → lead 'verloren' (naar Afgeboekt-tab), attendee.status='geannuleerd'.
  'bevestigd', 'komt_niet',
  // Systeem-outcome: alleen loggen als entry_kind='system' + outcome_code='offerte'.
  // Wordt vanuit de UI aangeroepen wanneer de sales-user op "Offerte maken" klikt,
  // zodat het dashboard offerte-starts kan tellen zonder eerdere state te muteren.
  'offerte_gestart',
  // Corrigeer-flow: draai de vorige outcome terug naar prev_state.
  'undo',
]);

// Event-only outcomes: als source !== 'event' → 400. Bewuste beperking
// omdat de status-normalisatie op event_attendees alleen zin heeft bij
// een gekoppeld attendee-record.
const EVENT_ONLY_OUTCOMES = new Set(['bevestigd', 'komt_niet']);

const PREV_STATE_KEYS = ['lead_status', 'attempts', 'terugbel_datum', 'is_hot', 'snoozed_until', 'last_outcome'];

// Mapping van follow-up-outcome → event_attendees.call_status. Alleen
// outcomes waarbij er echt een belronde-status uit voortvloeit staan hier;
// andere outcomes laten call_status ongewijzigd. NULL blijft = 'nog niet
// gebeld'. Undo herstelt call_status uit attendee_before.
const OUTCOME_TO_CALL_STATUS = Object.freeze({
  bevestigd     : 'bevestigd',
  komt_niet     : 'komt_niet',
  geen_gehoor   : 'geen_gehoor',
  voicemail     : 'voicemail',
  terugbel      : 'terugbellen',
  foutief_nummer: 'foutief_nummer',
});

const CADENCE_HOURS = [2, 24, 72];
const MAX_ATTEMPTS  = 4;
// WhatsApp-opvolging: standaard 2 dagen terug in de Werklijst.
const WHATSAPP_FOLLOWUP_DAYS = 2;

const ADMIN_ROLES = new Set(['super_admin', 'admin', 'manager']);

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function monthsFromNow(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

// Herkent alle Postgres/PostgREST-varianten die op "kolom ontbreekt" wijzen:
// 42703 = SQL-error "column does not exist"
// PGRST204 = PostgREST schema-cache miss (bv. na migratie zonder reload)
// "Could not find the '<col>' column" — PostgREST message-tekst
// "schema cache" — idem
function isMissingColumnError(error) {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  const msg = String(error.message || '') + ' ' + String(error.details || '') + ' ' + String(error.hint || '');
  return /could not find the/i.test(msg) || /schema cache/i.test(msg);
}

// Vind alle kolomnamen uit `candidates` die in de foutmelding worden
// genoemd. Werkt op zowel de expliciete 42703-message ("column X does
// not exist") als de PostgREST-variant ("Could not find the 'X' column").
function stripMissingColumns(error, obj, candidates) {
  const msg = (String(error?.message || '') + ' ' + String(error?.details || '') + ' ' + String(error?.hint || '')).toLowerCase();
  let didStrip = false;
  for (const k of candidates) {
    if (msg.includes(k) && k in obj) { delete obj[k]; didStrip = true; }
  }
  return didStrip;
}

async function insertOutcomeNote(leadId, userId, text, {
  entryKind    = 'outcome',
  outcomeCode  = null,
} = {}) {
  // Insert met entry_kind + outcome_code voor dashboard-aggregatie. Bij
  // 42703 op afzonderlijke kolommen strippen we die en retry-en, zodat het
  // endpoint werkt op oudere schema's zonder migratie.
  const trimmed = String(text || '').slice(0, 4000);
  const attempt = async (payload) => supabaseAdmin
    .from('follow_up_lead_notes')
    .insert(payload)
    .select('id, created_at')
    .maybeSingle();

  const buildPayload = (opts) => {
    const p = {
      lead_id: leadId,
      note: trimmed,
      created_by_user_id: userId,
    };
    if (opts.withEntryKind)  p.entry_kind   = entryKind;
    if (opts.withCode)       p.outcome_code = outcomeCode;
    return p;
  };
  const tries = [
    { withEntryKind: true,  withCode: true  },
    { withEntryKind: true,  withCode: false },
    { withEntryKind: false, withCode: false },
  ];
  let lastError = null;
  for (const opts of tries) {
    if (opts.withCode && !outcomeCode) continue;
    const { data, error } = await attempt(buildPayload(opts));
    if (!error) return data || null;
    lastError = error;
    if (!isMissingColumnError(error)) break;
  }
  if (lastError) {
    if (lastError.code === '42P01') {
      const err = new Error('follow_up_lead_notes ontbreekt');
      err.code = 'MIGRATION_REQUIRED';
      throw err;
    }
    console.warn('[follow-up-lead-outcome] note insert:', lastError.message);
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

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
  if (!leadId || !UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id (uuid) vereist' });

  const outcome = String(body.outcome || '').trim();
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: 'outcome ongeldig' });

  // 'undo' — corrigeer de vorige uitkomst: herstel lead naar prev_state
  // en clear prev_state. Vereist dat er iets in prev_state staat; anders
  // 400. Owner-gate identiek aan de andere outcomes.
  if (outcome === 'undo') {
    const { data: myp } = await supabaseAdmin
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    const uRole = String(myp?.role || '').toLowerCase();
    const uAdmin = ADMIN_ROLES.has(uRole);
    const uSales = uRole === 'sales';
    // Fetch met prev_state; 42703 → kolom ontbreekt (migratie nodig).
    let leadRow;
    {
      const { data, error } = await supabaseAdmin
        .from('follow_up_leads')
        .select('id, owner_id, lead_status, attempts, terugbel_datum, is_hot, snoozed_until, last_outcome, prev_state, source, source_ref')
        .eq('id', leadId)
        .maybeSingle();
      if (error) {
        if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
        // 42703 of PostgREST-schema-cache-miss ("Could not find the
        // 'prev_state' column") → fall back op minimale select zodat undo
        // niet blokkeert; verderop detecteren we alsnog een leeg prev.
        if (isMissingColumnError(error)) {
          const { data: d2, error: e2 } = await supabaseAdmin
            .from('follow_up_leads')
            .select('id, owner_id, lead_status, attempts, terugbel_datum, is_hot, snoozed_until, last_outcome, source, source_ref')
            .eq('id', leadId)
            .maybeSingle();
          if (e2) return res.status(500).json({ error: 'lead fetch: ' + e2.message });
          leadRow = d2 || null;
        } else {
          return res.status(500).json({ error: 'lead fetch: ' + error.message });
        }
      } else {
        leadRow = data;
      }
    }
    if (!leadRow) return res.status(404).json({ error: 'Lead niet gevonden' });
    if (!uAdmin) {
      if (!uSales) return res.status(403).json({ error: 'Geen rechten (rol vereist: sales/manager/admin)' });
      if (leadRow.owner_id && leadRow.owner_id !== user.id) {
        return res.status(403).json({ error: 'Deze lead is aan een andere sales toegewezen' });
      }
    }
    const prev = (leadRow.prev_state && typeof leadRow.prev_state === 'object') ? leadRow.prev_state : null;
    if (!prev) return res.status(400).json({ error: 'Niets te corrigeren (geen vorige staat opgeslagen)' });

    const nowIso = new Date().toISOString();
    const restorePatch = { updated_at: nowIso, prev_state: null };
    for (const k of PREV_STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(prev, k)) restorePatch[k] = prev[k];
    }
    // 42703 defensief strippen (rijke kolommen kunnen ontbreken).
    let attempt = { ...restorePatch };
    for (let i = 0; i < 3; i++) {
      const { data, error } = await supabaseAdmin
        .from('follow_up_leads').update(attempt).eq('id', leadId).select('id').maybeSingle();
      if (!error) break;
      if (isMissingColumnError(error)) {
        const didStrip = stripMissingColumns(error, attempt, ['attempts','is_hot','snoozed_until','last_outcome','prev_state']);
        if (!didStrip) return res.status(500).json({ error: 'undo update: ' + error.message });
        continue;
      }
      return res.status(500).json({ error: 'undo update: ' + error.message });
    }
    // Event-attendee restore: als de vorige uitkomst 'bevestigd'/'komt_niet'
    // was en we een attendee_before-snapshot hebben, zet die status +
    // called terug. Fail-soft: mislukking blokkeert de undo niet.
    if (prev.attendee_before && typeof prev.attendee_before === 'object') {
      // Zoek attendee_id via source_ref (dezelfde bron als de forward-write).
      const sourceRef = (leadRow.source_ref && typeof leadRow.source_ref === 'object') ? leadRow.source_ref : {};
      const attendeeId = sourceRef.attendee_id ? String(sourceRef.attendee_id) : null;
      if (attendeeId) {
        try {
          const restoreAttendee = {};
          if (prev.attendee_before.status !== undefined) restoreAttendee.status = prev.attendee_before.status;
          if (prev.attendee_before.called !== undefined) restoreAttendee.called = prev.attendee_before.called === true;
          // call_status + call_status_at ook mee-restoren zodat de badge
          // naar de vorige waarde springt bij undo.
          if (prev.attendee_before.call_status !== undefined) {
            restoreAttendee.call_status = prev.attendee_before.call_status;
          }
          if (prev.attendee_before.call_status_at !== undefined) {
            restoreAttendee.call_status_at = prev.attendee_before.call_status_at;
          }
          if (Object.keys(restoreAttendee).length) {
            const { error: aErr } = await supabaseAdmin
              .from('event_attendees').update(restoreAttendee).eq('id', attendeeId);
            if (aErr) {
              // 42703 → migratie 023 nog niet gedraaid. Retry zonder de
              // nieuwe kolommen zodat status/called wel terug worden gezet.
              if (aErr.code === '42703' || /column .* does not exist/i.test(aErr.message || '')) {
                const fb = {};
                if (restoreAttendee.status !== undefined) fb.status = restoreAttendee.status;
                if (restoreAttendee.called !== undefined) fb.called = restoreAttendee.called;
                if (Object.keys(fb).length) {
                  const { error: fErr } = await supabaseAdmin
                    .from('event_attendees').update(fb).eq('id', attendeeId);
                  if (fErr) console.warn('[follow-up-lead-outcome] attendee undo-restore (fallback):', fErr.message);
                }
              } else {
                console.warn('[follow-up-lead-outcome] attendee undo-restore:', aErr.message);
              }
            }
          }
        } catch (e) {
          console.warn('[follow-up-lead-outcome] attendee undo-restore exception:', e?.message || e);
        }
      }
    }
    try {
      await insertOutcomeNote(leadId, user.id, 'Uitkomst gecorrigeerd (teruggedraaid)', {
        entryKind: 'system', outcomeCode: 'undo',
      });
    } catch (_) { /* fail-soft */ }
    return res.status(200).json({ ok: true, undone: true, restored: attempt });
  }

  // 'offerte_gestart' is een fire-and-forget log-actie zonder state-mutatie:
  // dashboard telt hem, maar de lead-status blijft ongewijzigd zodat de
  // normale bel-flow doorloopt. Owner-gate wel toepassen zodat sales geen
  // andermans leads kan taggen.
  if (outcome === 'offerte_gestart') {
    // Rol + lead ophalen enkel voor owner-check.
    const { data: myp } = await supabaseAdmin
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    const rRole = String(myp?.role || '').toLowerCase();
    const rAdmin = ADMIN_ROLES.has(rRole);
    const rSales = rRole === 'sales';
    const { data: lRow, error: lErr } = await supabaseAdmin
      .from('follow_up_leads').select('id, owner_id').eq('id', leadId).maybeSingle();
    if (lErr) {
      if (lErr.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
      return res.status(500).json({ error: 'lead fetch: ' + lErr.message });
    }
    if (!lRow) return res.status(404).json({ error: 'Lead niet gevonden' });
    if (!rAdmin) {
      if (!rSales) return res.status(403).json({ error: 'Geen rechten (rol vereist: sales/manager/admin)' });
      if (lRow.owner_id && lRow.owner_id !== user.id) {
        return res.status(403).json({ error: 'Deze lead is aan een andere sales toegewezen' });
      }
    }
    try {
      await insertOutcomeNote(leadId, user.id, 'Offerte-flow gestart vanuit cockpit', {
        entryKind: 'system', outcomeCode: 'offerte',
      });
    } catch (_) { /* fail-soft */ }
    return res.status(200).json({ ok: true, logged: true });
  }

  // Rol resolven voor owner-gate (zelfde patroon als lead-update).
  const { data: myProfile, error: mpErr } = await supabaseAdmin
    .from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
  if (mpErr) return res.status(500).json({ error: 'profile lookup: ' + mpErr.message });
  const myRole      = String(myProfile?.role || '').toLowerCase();
  const isAdmin     = ADMIN_ROLES.has(myRole);
  const isSales     = myRole === 'sales';

  // Huidige lead ophalen — nodig voor attempts, lead_kind én owner-check.
  const CORE_COLS = 'id, customer_id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id, last_contact_at, source_ref, created_at, updated_at';
  const RICH_COLS = CORE_COLS + ', attempts, is_hot, snoozed_until, lead_kind, last_outcome';
  let leadRow = null;
  let hasRichCols = true;
  {
    const { data, error } = await supabaseAdmin
      .from('follow_up_leads').select(RICH_COLS).eq('id', leadId).maybeSingle();
    if (error) {
      if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
      if (isMissingColumnError(error)) {
        hasRichCols = false;
        const { data: d2, error: e2 } = await supabaseAdmin
          .from('follow_up_leads').select(CORE_COLS).eq('id', leadId).maybeSingle();
        if (e2) return res.status(500).json({ error: 'lead fetch: ' + e2.message });
        leadRow = d2;
      } else {
        return res.status(500).json({ error: 'lead fetch: ' + error.message });
      }
    } else {
      leadRow = data;
    }
  }
  if (!leadRow) return res.status(404).json({ error: 'Lead niet gevonden' });

  // Owner-gate: sales mag alleen eigen of ongeclaimde leads muteren.
  if (!isAdmin) {
    if (!isSales) return res.status(403).json({ error: 'Geen rechten (rol vereist: sales/manager/admin)' });
    if (leadRow.owner_id && leadRow.owner_id !== user.id) {
      return res.status(403).json({ error: 'Deze lead is aan een andere sales toegewezen' });
    }
  }

  const nowIso = new Date().toISOString();
  const currentAttempts = Number(leadRow.attempts || 0);
  const currentKind     = String(leadRow.lead_kind || 'call');
  const isEventLead     = String(leadRow.source || '') === 'event';
  const sourceRef       = (leadRow.source_ref && typeof leadRow.source_ref === 'object') ? leadRow.source_ref : {};
  // Voor event-leads: strakke 12→18→volgende-dag-12-cadans (event-datum
  // is de deadline). We berekenen in Europe/Amsterdam om DST correct
  // te handelen. Fallback op UTC als sourceRef.event_date ontbreekt.
  function amsPartsOf(refDate) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit',
    });
    const parts = dtf.formatToParts(refDate);
    const m = {}; for (const p of parts) m[p.type] = p.value;
    return { y:+m.year, mo:+m.month, d:+m.day, h:+m.hour, mi:+m.minute };
  }
  function amsterdamIsoAt(y, mo, d, h, mi) {
    // Construct UTC-timestamp met deze componenten, dan corrigeer met
    // Amsterdam-offset op die referentie.
    const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit',
    });
    const parts = dtf.formatToParts(utc);
    const m = {}; for (const p of parts) m[p.type] = p.value;
    const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
    const offMin = Math.round((asUTC - utc.getTime()) / 60000);
    return new Date(utc.getTime() - offMin * 60000).toISOString();
  }

  // Voor event-leads: fetch VOORAF de huidige attendee-snapshot
  // (status + called). Nodig voor (a) de status-normalisatie bij
  // 'bevestigd'/'komt_niet' verderop en (b) undo-restore. Fail-soft —
  // als de fetch faalt, blijft attendeeBeforeSnapshot null en gaat de
  // outcome gewoon door (write-back doet dan alleen called=true).
  let attendeeBeforeSnapshot = null;
  if (isEventLead && sourceRef.attendee_id) {
    try {
      const { data: ab } = await supabaseAdmin
        .from('event_attendees')
        .select('id, status, called, call_status, call_status_at')
        .eq('id', sourceRef.attendee_id)
        .maybeSingle();
      if (ab) {
        attendeeBeforeSnapshot = {
          status         : ab.status || null,
          called         : ab.called === true,
          call_status    : ab.call_status || null,
          call_status_at : ab.call_status_at || null,
        };
      }
    } catch (e) {
      // 42703 → kolom call_status/call_status_at ontbreekt (migratie 023
      // nog niet gedraaid). Herprobeer met minimale set zodat de outcome
      // door kan; call_status wordt dan niet meegeschreven.
      if (e?.code === '42703' || /column .* does not exist/i.test(e?.message || '')) {
        try {
          const { data: ab2 } = await supabaseAdmin
            .from('event_attendees')
            .select('id, status, called')
            .eq('id', sourceRef.attendee_id)
            .maybeSingle();
          if (ab2) attendeeBeforeSnapshot = { status: ab2.status || null, called: ab2.called === true };
        } catch (_) { /* fail-soft */ }
      } else {
        console.warn('[follow-up-lead-outcome] attendee-before fetch:', e?.message || e);
      }
    }
  }

  // Bewaar de HUIDIGE staat als prev_state (jsonb) — zodat de UI met
  // 'undo' 1 stap terug kan. Bij ontbreken van de kolom (42703) wordt
  // dit veld in de update gestript, dus geen crash.
  const currentSnapshot = {};
  for (const k of PREV_STATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(leadRow, k)) currentSnapshot[k] = leadRow[k];
  }
  // Attendee-snapshot mee-serialiseren zodat undo (verderop) 'm kan
  // restoren. Los veld — niet in PREV_STATE_KEYS want dat is voor
  // lead-kolommen; hier zit het als sub-object 'attendee_before'.
  if (attendeeBeforeSnapshot) {
    currentSnapshot.attendee_before = attendeeBeforeSnapshot;
  }

  // Bouw patch + noteText per outcome.
  const patch = {
    updated_at      : nowIso,
    last_contact_at : nowIso,
    last_outcome    : outcome,
    prev_state      : currentSnapshot,
  };
  let noteText  = '';
  let attemptsAfter = currentAttempts;

  if (outcome === 'geen_gehoor') {
    attemptsAfter = currentAttempts + 1;
    patch.attempts = attemptsAfter;
    if (isEventLead) {
      // Event-cadans: uur < 18 → vandaag 18:00; uur ≥ 18 → morgen 12:00.
      // Mits <= event-datum, anders lead_status='niet_bereikbaar'.
      const now = new Date();
      const cur = leadRow.terugbel_datum ? new Date(leadRow.terugbel_datum) : now;
      const curAms = amsPartsOf(cur);
      const eventDate = sourceRef.event_date ? new Date(sourceRef.event_date) : null;
      let nextIso;
      if (curAms.h < 18) {
        nextIso = amsterdamIsoAt(curAms.y, curAms.mo, curAms.d, 18, 0);
      } else {
        // volgende dag 12:00
        const d2 = new Date(Date.UTC(curAms.y, curAms.mo - 1, curAms.d + 1));
        nextIso = amsterdamIsoAt(d2.getUTCFullYear(), d2.getUTCMonth() + 1, d2.getUTCDate(), 12, 0);
      }
      if (eventDate && new Date(nextIso).getTime() > eventDate.getTime()) {
        // Slot komt voorbij de event-datum → onbereikbaar.
        patch.lead_status    = 'niet_bereikbaar';
        patch.terugbel_datum = null;
        noteText = `Geen gehoor (event-lead) — geen sloten meer vóór event; onbereikbaar`;
      } else {
        patch.lead_status    = 'terugbellen';
        patch.terugbel_datum = nextIso;
        const when = new Date(nextIso).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' });
        noteText = `Geen gehoor (event-lead, poging ${attemptsAfter}) — volgende poging ${when}`;
      }
    } else if (attemptsAfter >= MAX_ATTEMPTS) {
      patch.lead_status    = 'niet_bereikbaar';
      patch.terugbel_datum = null;
      noteText = `Geen gehoor — poging ${attemptsAfter}/${MAX_ATTEMPTS} · onbereikbaar, actie nodig`;
    } else {
      const cadIdx = Math.max(0, Math.min(CADENCE_HOURS.length - 1, attemptsAfter - 1));
      patch.lead_status    = 'terugbellen';
      patch.terugbel_datum = hoursFromNow(CADENCE_HOURS[cadIdx]);
      noteText = `Geen gehoor — poging ${attemptsAfter}/${MAX_ATTEMPTS}, terugbellen gepland`;
    }
  } else if (outcome === 'voicemail') {
    attemptsAfter = currentAttempts + 1;
    patch.attempts       = attemptsAfter;
    patch.lead_status    = 'terugbellen';
    patch.terugbel_datum = hoursFromNow(24);
    noteText = `Voicemail ingesproken — poging ${attemptsAfter}`;
  } else if (outcome === 'foutief_nummer') {
    patch.lead_status    = 'niet_bereikbaar';
    patch.terugbel_datum = null;
    noteText = 'Foutief nummer — nummer controleren';
  } else if (outcome === 'terugbel') {
    if (!body.terugbel_datum) return res.status(400).json({ error: 'terugbel_datum vereist' });
    const d = new Date(body.terugbel_datum);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'terugbel_datum ongeldig' });
    patch.lead_status    = 'terugbellen';
    patch.attempts       = 0;
    patch.terugbel_datum = d.toISOString();
    patch.is_hot         = (body.is_hot === true);
    attemptsAfter = 0;
    noteText = 'Terugbel-afspraak gepland' + (patch.is_hot ? ' · hotlead' : '');
  } else if (outcome === 'zoom_ingepland') {
    if (!body.terugbel_datum) return res.status(400).json({ error: 'terugbel_datum vereist' });
    const d = new Date(body.terugbel_datum);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'terugbel_datum ongeldig' });

    if (COCKPIT_ZOOM_AS_APPOINTMENT) {
      // Validate-first: maak eerst de GHL-afspraak. Bij fout: geen
      // DB-mutatie op de lead → geen kale zoom-lead achterlaten.
      let newAppt;
      try {
        newAppt = await createAppointmentForLead({
          lead           : leadRow,
          scheduledAt    : d.toISOString(),
          durationMinutes: COCKPIT_ZOOM_DURATION_MIN,
        });
      } catch (e) {
        if (e?.code === 'NO_GHL_CONTACT') {
          // Nu de upsert-fallback bestaat betekent NO_GHL_CONTACT alleen
          // nog "geen e-mail én geen telefoon" — er is niks om GHL op
          // te dedupliceren, dus we willen geen spook-contact aanmaken.
          return res.status(422).json({
            error: 'Geen e-mail of telefoon bekend — kan geen GHL-contact aanmaken. Vul klantgegevens aan.',
            code : 'NO_GHL_CONTACT',
          });
        }
        if (e?.code === 'GHL_CONFIG_MISSING') {
          return res.status(500).json({ error: 'GHL configuratie ontbreekt op de server (GHL_CALENDAR_ID / GHL_LOCATION_ID).' });
        }
        if (e?.code === 'GHL_API') {
          console.error('[lead-outcome zoom_ingepland] GHL:', e.ghlStatus, e.ghlBody);
          return res.status(422).json({
            error     : mapGhlError(e.ghlStatus, e.ghlBody),
            ghl_status: e.ghlStatus,
          });
        }
        if (e?.code === 'DB_INSERT') {
          // GHL-afspraak staat wél al — expliciet melden zodat sales
          // 'm handmatig kan controleren i.p.v. dubbel te maken.
          console.error('[lead-outcome zoom_ingepland] DB insert:', e?.message, 'ghl:', e?.ghl_appointment_id);
          return res.status(500).json({
            error             : 'GHL-afspraak gemaakt, maar DB-registratie mislukt — check GHL kalender handmatig. Neem contact op met beheerder.',
            ghl_appointment_id: e?.ghl_appointment_id || null,
          });
        }
        console.error('[lead-outcome zoom_ingepland] onbekend:', e?.message || e);
        return res.status(500).json({ error: e?.message || 'Zoom-afspraak aanmaken mislukt' });
      }

      // Success: lead is afgehandeld (afspraak leeft nu als aparte
      // follow_up_appointments-rij + GHL-afspraak). Zet lead op
      // 'verlengd' zodat 'ie uit de werklijst is; hang de nieuwe
      // appointment-id in source_ref voor traceability.
      patch.lead_status    = 'verlengd';
      patch.terugbel_datum = null;
      patch.is_hot         = false;
      patch.snoozed_until  = null;
      patch.source_ref     = {
        ...(sourceRef || {}),
        converted_to_appointment_id: newAppt.appointment_id,
        converted_ghl_appointment_id: newAppt.ghl_appointment_id,
        converted_at                : nowIso,
      };
      noteText = 'Zoom-call ingepland → echte GHL-afspraak aangemaakt'
        + (newAppt.ghl_appointment_id ? ` (GHL: ${newAppt.ghl_appointment_id})` : '')
        + (newAppt.zoom_join_url ? ` — Zoom: ${newAppt.zoom_join_url}` : '');
    } else {
      // Feature-flag UIT: oude gedrag (alleen lead-patch, geen echte
      // afspraak). Blijft beschikbaar voor snelle rollback via Vercel-
      // env-var COCKPIT_ZOOM_AS_APPOINTMENT='false'.
      patch.lead_kind      = 'zoom';
      patch.lead_status    = 'terugbellen';
      patch.terugbel_datum = d.toISOString();
      noteText = 'Zoom-call ingepland';
    }
  } else if (outcome === 'sale') {
    patch.lead_status = 'verlengd';
    noteText = 'Sale geworden 🎉';
  } else if (outcome === 'geen_interesse') {
    patch.lead_status = 'verloren';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    noteText = 'Geen interesse' + (reason ? ' — ' + reason.slice(0, 500) : '');
  } else if (outcome === 'snooze') {
    const months = Number(body.snooze_months);
    if (![6, 12].includes(months)) return res.status(400).json({ error: 'snooze_months moet 6 of 12 zijn' });
    patch.snoozed_until = monthsFromNow(months);
    patch.is_hot        = false;
    noteText = `Gesluimerd — opnieuw contact over ${months} maanden`;
  } else if (outcome === 'noshow') {
    if (currentKind !== 'zoom') return res.status(400).json({ error: "No-show alleen zinvol bij lead_kind='zoom'" });
    attemptsAfter = currentAttempts + 1;
    patch.attempts       = attemptsAfter;
    patch.lead_status    = 'terugbellen';
    patch.terugbel_datum = hoursFromNow(24);
    noteText = 'No-show bij Zoom-call';
  } else if (outcome === 'gesprek_gehad') {
    // Geen status/datum-mutatie — alleen note + last_contact_at.
    noteText = 'Zoom-gesprek gehad';
  } else if (outcome === 'whatsapp_gestuurd') {
    // WhatsApp verstuurd — lead moet TERUGKOMEN voor opvolging (WHATSAPP_
    // FOLLOWUP_DAYS dagen later). Attempts wordt NIET verhoogd (dit was
    // geen belpoging). Status blijft actief zodat de lead in de Werklijst
    // opduikt op de opvolg-dag; last_contact_at markeert wanneer we
    // laatst iets deden.
    const days = WHATSAPP_FOLLOWUP_DAYS;
    patch.lead_status    = 'terugbellen';
    patch.terugbel_datum = hoursFromNow(days * 24);
    noteText = 'WhatsApp gestuurd — opvolgen over ' + days + ' dagen';
  } else if (outcome === 'bevestigd') {
    // Event-only: klant bevestigt telefonisch dat hij komt. Lead wordt
    // afgehandeld (verlengd → uit werklijst), gastenlijst-status blijft
    // 'aangemeld' (of wordt teruggenormaliseerd vanaf 'geannuleerd').
    // De attendee-write-back gebeurt verderop in dezelfde flow als de
    // 'called'-schrijf.
    if (!isEventLead) return res.status(400).json({ error: "'bevestigd' geldt alleen voor event-leads", code: 'EVENT_ONLY' });
    patch.lead_status    = 'verlengd';
    patch.terugbel_datum = null;
    patch.is_hot         = false;
    patch.snoozed_until  = null;
    noteText = 'Bevestigd — komt naar het event';
  } else if (outcome === 'komt_niet') {
    // Event-only: klant meldt zich telefonisch af. Lead → 'verloren'
    // (verschijnt in Afgeboekt-tab), gastenlijst-status naar
    // 'geannuleerd' (tenzij definitief 'sale'/'aanwezig').
    if (!isEventLead) return res.status(400).json({ error: "'komt_niet' geldt alleen voor event-leads", code: 'EVENT_ONLY' });
    patch.lead_status    = 'verloren';
    patch.terugbel_datum = null;
    patch.is_hot         = false;
    patch.snoozed_until  = null;
    noteText = 'Komt toch niet — afgemeld';
  }

  // Als schema geen rijke kolommen heeft, strippen we ze uit de patch
  // zodat we niet op 42703 crashen.
  if (!hasRichCols) {
    delete patch.attempts;
    delete patch.is_hot;
    delete patch.snoozed_until;
    delete patch.lead_kind;
    delete patch.last_outcome;
  }

  try {
    // Update de lead. Bij 42703 (bv. entry_kind/attempts kolommen niet in
    // oude schema): stripp die keys en retry.
    let updated = null;
    let updateAttempt = { ...patch };
    for (let i = 0; i < 3; i++) {
      const { data, error } = await supabaseAdmin
        .from('follow_up_leads')
        .update(updateAttempt)
        .eq('id', leadId)
        .select(hasRichCols ? RICH_COLS : CORE_COLS)
        .maybeSingle();
      if (!error) { updated = data; break; }
      if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
      if (isMissingColumnError(error)) {
        // Detecteer welke kolom, en strip die. Werkt óók bij PostgREST-
        // schema-cache-miss (PGRST204 / "Could not find the '<col>'
        // column") die zonder deze harding een outcome zou blokkeren.
        const stripped = { ...updateAttempt };
        const didStrip = stripMissingColumns(error, stripped, ['attempts', 'is_hot', 'snoozed_until', 'lead_kind', 'last_outcome', 'prev_state']);
        if (!didStrip) return res.status(500).json({ error: 'update: ' + error.message });
        updateAttempt = stripped;
        continue;
      }
      return res.status(500).json({ error: 'update: ' + error.message });
    }
    if (!updated) return res.status(500).json({ error: 'update: geen resultaat' });

    // Event-lead write-back: zet event_attendees.called=true als de
    // outcome een ECHT-gesproken uitkomst is. Bij 'bevestigd' / 'komt_niet'
    // óók de status normaliseren op de gastenlijst. Fail-soft — mislukking
    // blokkeert de outcome niet.
    //   'bevestigd'  → normaliseer geannuleerd/switched → 'aangemeld',
    //                  anders status ongewijzigd (aangemeld/aanwezig=OK).
    //   'komt_niet'  → status='geannuleerd', tenzij definitief
    //                  ('sale'/'aanwezig'): dan alleen called=true.
    // De prev_state (verderop) heeft attendee_before al vastgelegd voor
    // undo-restore.
    // SPOKEN_OUTCOMES: outcomes waarbij we called=true zetten. Uitgebreid
    // met de outcomes die naar call_status mappen zodat álle mogelijke
    // belronde-uitkomsten ook de nieuwe belstatus-badge muteren.
    const SPOKEN_OUTCOMES = new Set([
      'terugbel', 'sale', 'geen_interesse', 'gesprek_gehad', 'zoom_ingepland',
      'bevestigd', 'komt_niet',
      // Voor call_status-write ook nodig — deze outcomes waren voorheen
      // "niet-gesproken" (called=false) maar zijn wél belronde-signalen
      // die de gebruiker in de badge wil zien.
      'geen_gehoor', 'voicemail', 'foutief_nummer',
    ]);
    if (isEventLead && SPOKEN_OUTCOMES.has(outcome) && sourceRef.attendee_id) {
      try {
        // Bepaal patch: called=true bij daadwerkelijk contact, status alleen
        // bij bevestigd/komt_niet, call_status uit OUTCOME_TO_CALL_STATUS.
        const patchAttendee = {};
        // called=true alleen bij de outcomes die impliceren dat de belronde
        // écht bereik had. geen_gehoor / voicemail / foutief_nummer zetten
        // wel call_status maar NIET called=true (backward-compat semantiek).
        const CALLED_TRUE_OUTCOMES = new Set([
          'terugbel', 'sale', 'geen_interesse', 'gesprek_gehad', 'zoom_ingepland',
          'bevestigd', 'komt_niet',
        ]);
        if (CALLED_TRUE_OUTCOMES.has(outcome)) patchAttendee.called = true;
        if (outcome === 'bevestigd' || outcome === 'komt_niet') {
          const beforeStatus = String(attendeeBeforeSnapshot?.status || '').toLowerCase();
          if (outcome === 'bevestigd') {
            if (beforeStatus === 'geannuleerd' || beforeStatus === 'switched_to_other_event') {
              patchAttendee.status = 'aangemeld';
            }
          } else { // komt_niet
            if (beforeStatus !== 'sale' && beforeStatus !== 'aanwezig') {
              patchAttendee.status = 'geannuleerd';
            }
          }
        }
        // call_status write — nieuw. Waarde uit mapping; als outcome er niet
        // in staat blijft call_status ongewijzigd (patch bevat 'em niet).
        const mappedCallStatus = OUTCOME_TO_CALL_STATUS[outcome];
        if (mappedCallStatus) {
          patchAttendee.call_status    = mappedCallStatus;
          patchAttendee.call_status_at = nowIso;
        }
        if (Object.keys(patchAttendee).length > 0) {
          const { error: aErr } = await supabaseAdmin
            .from('event_attendees')
            .update(patchAttendee)
            .eq('id', sourceRef.attendee_id);
          if (aErr) {
            // 42703 → migratie 023 nog niet gedraaid. Retry zonder de nieuwe
            // kolommen zodat de bestaande write-back (called/status) blijft
            // werken totdat de kolom bestaat.
            if (aErr.code === '42703' || /column .* does not exist/i.test(aErr.message || '')) {
              const fallback = {};
              if (Object.prototype.hasOwnProperty.call(patchAttendee, 'called')) fallback.called = patchAttendee.called;
              if (Object.prototype.hasOwnProperty.call(patchAttendee, 'status')) fallback.status = patchAttendee.status;
              if (Object.keys(fallback).length > 0) {
                const { error: fErr } = await supabaseAdmin
                  .from('event_attendees').update(fallback).eq('id', sourceRef.attendee_id);
                if (fErr) console.warn('[follow-up-lead-outcome] event_attendees write-back (fallback):', fErr.message);
              }
            } else {
              console.warn('[follow-up-lead-outcome] event_attendees write-back:', aErr.message);
            }
          }
        }
      } catch (e) {
        console.warn('[follow-up-lead-outcome] event_attendees write-back error:', e?.message || e);
      }
    }

    // Auto-note-insert. Failure blokkeert de state-transitie niet.
    try {
      await insertOutcomeNote(leadId, user.id, noteText, {
        entryKind: 'outcome', outcomeCode: outcome,
      });
    } catch (nErr) {
      if (nErr?.code === 'MIGRATION_REQUIRED') {
        // Note-tabel ontbreekt — waarschuwen maar succes teruggeven.
        console.warn('[follow-up-lead-outcome] notes-tabel ontbreekt, note niet opgeslagen');
      } else {
        console.warn('[follow-up-lead-outcome] note error:', nErr?.message || nErr);
      }
    }

    return res.status(200).json({ ok: true, lead: updated });
  } catch (e) {
    console.error('[follow-up-lead-outcome]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
