// api/_lib/events-complete-core.js
//
// Fase 2b-2 — geëxtraheerde motor van api/events-complete.js. Bevat alle
// mutation-logic (event.completed_at update, attendee attendance/outcome,
// event_followups upsert, event_mentors was_present, event_expenses insert,
// bonus + uitgave ledger-entries, notifications). Gebruikt door:
//   - api/events-complete.js               (reguliere afronding, JWT-user)
//   - api/admin/historical-event-commit.js (historisch event → bonus, super_admin)
//
// GEEN auth/permission-check hier — caller doet dat. Pure functie op
// supabaseAdmin + userId (voor completed_by / created_by / added_by).
//
// Signature: runEventsCompleteCore({ userId, body }) → { statusCode, response }
// waar response de bestaande shape van events-complete uit-behoudt.

import { supabaseAdmin } from '../supabase.js';
import { computeDealTotals } from './deal-total.js';
import { createNotification } from './notify.js';
import { BEZWAREN, isBezwaar } from './bezwaren.js';
import { schrijfLeadNotitie } from './followup-notitie.js';

const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATT_SET     = new Set(['aanwezig', 'no_show', 'afgemeld']);
const OUTCOME_SET = new Set([
  'opvolgen', 'geen_interesse', 'nog_onbekend',
  // Uitgebreid in Blok B: sale-koppeling + twijfel-vervolg. Beide leiden
  // NIET automatisch tot bonus-verandering; alleen 'opvolgen' + 'twijfelt_nog'
  // triggeren een follow-up (met verplichte notitie).
  'klant_geworden', 'twijfelt_nog',
]);
// Outcomes waarvoor een follow-up-record aangemaakt/bijgewerkt moet worden.
// no_show is een aparte status, niet een outcome; die trigger blijft in
// de aanvullende conditie hieronder staan.
const FOLLOWUP_OUTCOMES = new Set(['opvolgen', 'twijfelt_nog']);
// Outcomes waarbij server-side notitie (followup.reason) verplicht is.
const REASON_REQUIRED_OUTCOMES = new Set(['opvolgen', 'twijfelt_nog']);
// STAP 1 — no-shows en afgemelden krijgen dezelfde motor als de rest.
// Wie er niet was kon tot nu toe nergens heen: geen reden, geen notitie,
// geen belmoment, terwijl je op het moment van afronden juist wél weet wat
// er speelde. Nu lopen ze door exact dezelfde weg als 'opvolgen' — dezelfde
// event_followups-rij, dezelfde follow_up_leads-rij, dezelfde belcadans.
// Geen tweede pad.
// STAP 2 — elke uitkomst dwingt een vervolgstap af.
// 'geen_interesse' vraagt een reden uit de elf bezwaren (zie ./bezwaren.js);
// 'opvolgen'/'twijfelt_nog' vragen notitie én belmoment; 'klant_geworden'
// sluit af zonder belactie; 'nog_onbekend' vraagt bewust niets, want dat
// betekent letterlijk dat je het nog niet weet.
const REDEN_VERPLICHT_OUTCOMES = new Set(['geen_interesse']);
// Kolom uit docs/sql-migrations/2026-08-27-event-attendees-outcome-reason.sql.
// Nog niet gedraaid, dus de schrijfactie valt terug als hij ontbreekt.
const NIEUWE_ATTENDEE_KOLOMMEN = ['outcome_reason'];

const AFWEZIG_STATUSSEN = new Set(['no_show', 'afgemeld']);
// Aanklikbare redenen bij een afwezige. Bewust een vaste lijst: vrije tekst
// valt niet te tellen. De vrije notitie staat er los naast.
const AFWEZIG_REDENEN = new Set(['kon_niet', 'niet_gereageerd', 'afgemeld_bericht', 'onbekend']);
// Standaard-belmoment in dagen, als vangnet voor een blok dat alleen een
// notitie draagt. Een lead zonder terugbel_datum staat namelijk op geen
// enkele lijst — dan is de notitie wel bewaard maar ziet niemand hem, en dat
// is nog steeds stil verdwijnen. Spiegelt AFWEZIG_BELMOMENT_DAGEN in
// modules/klanten-v2/views/events-v2.js.
const AFWEZIG_BELMOMENT_DAGEN = { no_show: 1, afgemeld: 3 };
/** Statussen waarbij een lead als afgehandeld geldt en van de lijsten verdwijnt. */
const GESLOTEN_LEAD_STATUSSEN = new Set(['verlengd', 'verloren']);
const isGesloten = (status) => GESLOTEN_LEAD_STATUSSEN.has(String(status || ''));

/**
 * Eén regel in het notitielog als een dichte rij weer opengaat. Een lead die
 * van 'verloren' naar de bellijst springt zonder spoor is magie, en daar zit
 * niemand op te wachten — de beller moet kunnen zien waaróm hij er weer staat.
 * Fail-soft: schrijfLeadNotitie gooit niet.
 */
async function meldHeropening(leadId, eventId, vorigeStatus, userId) {
  await schrijfLeadNotitie(
    leadId,
    `Heropend door het afronden van een event. Stond op '${vorigeStatus}'; eerdere belpogingen blijven meetellen.`,
    { doorUserId: userId, entryKind: 'system', outcomeCode: 'heropend_door_event' },
  );
}

function datumOverDagen(dagen) {
  // Number('x') is NaN, en setDate(NaN) levert een Invalid Date die als
  // ongeldige datum de database in gaat. Alles wat geen echt getal is telt
  // hier als nul: liever vandaag dan niets.
  const n = Number(dagen);
  const d = new Date();
  d.setDate(d.getDate() + (Number.isFinite(n) ? n : 0));
  return d.toISOString().slice(0, 10);
}
// Kolommen uit docs/sql-migrations/2026-08-27-event-followups-reden-en-herkomst.sql.
// Die migratie is nog niet gedraaid, dus elke schrijfactie ermee kan falen op
// "kolom bestaat niet". Dan proberen we het opnieuw zonder — de follow-up is
// belangrijker dan het etiket erop. Zelfde patroon als follow-up-lead-outcome.js.
const NIEUWE_FOLLOWUP_KOLOMMEN = ['reason_code', 'bron_uitkomst'];

function isMissendeKolom(error) {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return /could not find the/i.test(msg) || /schema cache/i.test(msg);
}

function zonderNieuweKolommen(payload) {
  const kopie = { ...payload };
  for (const k of NIEUWE_FOLLOWUP_KOLOMMEN) delete kopie[k];
  return kopie;
}
const ACCEPTED    = new Set(['accepted', 'signed']);
const BONUS_PCT   = 3;
const DEFAULT_FOLLOWUP_OWNER_ID = process.env.DEFAULT_EVENT_FOLLOWUP_OWNER_ID || null;

export { BONUS_PCT };
// Klein en testbaar gehouden: deze twee dragen allebei een besluit dat stil
// fout kan gaan. Zie tests/events-afronden-helpers.test.js.
export { isGesloten, datumOverDagen, AFWEZIG_BELMOMENT_DAGEN, AFWEZIG_REDENEN };

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function isDateString(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

/**
 * @param {object} args
 * @param {string} args.userId  auth-user-id voor completed_by / created_by
 * @param {object} args.body    dezelfde body-shape als api/events-complete.js
 * @returns {Promise<{ statusCode: number, response: object }>}
 */
export async function runEventsCompleteCore({ userId, body }) {
  if (!userId) return { statusCode: 400, response: { error: 'userId vereist' } };
  if (!body || typeof body !== 'object') return { statusCode: 400, response: { error: 'Body ontbreekt' } };

  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : '';
  if (!eventId || !UUID_RE.test(eventId)) {
    return { statusCode: 400, response: { error: 'event_id (uuid) vereist' } };
  }
  const attendeesIn      = Array.isArray(body.attendees) ? body.attendees : [];
  const presentMentorIds = Array.isArray(body.present_team_member_ids) ? body.present_team_member_ids : [];
  const expensesIn       = Array.isArray(body.expenses) ? body.expenses : [];
  const basisInclBtw     = body.basis_incl_btw === false ? false : true;
  const completionSummary = typeof body.completion_summary === 'string'
    ? body.completion_summary.slice(0, 5000)
    : null;

  for (const a of attendeesIn) {
    if (!a || typeof a !== 'object') return { statusCode: 400, response: { error: 'attendees-item ongeldig' } };
    if (!UUID_RE.test(String(a.attendee_id || ''))) return { statusCode: 400, response: { error: 'attendee_id ongeldig' } };
    if (!ATT_SET.has(String(a.attendance_status || ''))) {
      return { statusCode: 400, response: { error: `attendance_status ongeldig voor ${a.attendee_id}` } };
    }
    if (a.outcome != null) {
      if (!OUTCOME_SET.has(String(a.outcome))) {
        return { statusCode: 400, response: { error: `outcome ongeldig voor ${a.attendee_id}` } };
      }
      if (a.attendance_status !== 'aanwezig') {
        return { statusCode: 400, response: { error: `outcome alleen toegestaan bij attendance_status='aanwezig' (${a.attendee_id})` } };
      }
    }
    // Reden bij 'geen interesse'.
    //
    // WAAROM DIT HIER NIET VERPLICHT IS, EN OP HET SCHERM WEL.
    // Deze core wordt door drie kanten aangeroepen: het afrondscherm in
    // events-v2.js (waar de reden vanaf stap 2 verplicht is), het OUDERE
    // afrondscherm in modules/events-detail.html, en de terugwerkende import
    // in api/admin/historical-event-commit.js.
    //   · De import stuurt helemaal geen outcome mee — die raakt dit nooit.
    //   · Het oude scherm biedt 'geen_interesse' wél aan (regel 2317) maar
    //     kent geen reden, en dat scherm mag ik niet aanpassen.
    // Zou de reden hier verplicht zijn, dan kan niemand op dat oude scherm
    // een event nog afronden. Daarom: wat binnenkomt wordt streng
    // gecontroleerd, maar het mág ontbreken. De harde eis staat in het scherm
    // dat mensen echt gebruiken.
    //
    // Verdwijnt dat oude scherm ooit, dan is dit één regel strenger maken —
    // vervang de check hieronder door `if (!isBezwaar(a.outcome_reason))`.
    if (a.outcome_reason != null && String(a.outcome_reason).trim() !== '') {
      if (!REDEN_VERPLICHT_OUTCOMES.has(String(a.outcome || ''))) {
        return { statusCode: 400, response: {
          error: `outcome_reason hoort alleen bij outcome 'geen_interesse' (${a.attendee_id})`,
        } };
      }
      if (!isBezwaar(a.outcome_reason)) {
        return { statusCode: 400, response: {
          error: `outcome_reason ongeldig (${a.attendee_id}) — kies er één uit de vaste lijst`,
          code: 'REDEN_ONGELDIG',
          toegestaan: BEZWAREN,
        } };
      }
    }
    if (a.followup != null) {
      if (typeof a.followup !== 'object' || Array.isArray(a.followup)) {
        return { statusCode: 400, response: { error: `followup moet object zijn voor ${a.attendee_id}` } };
      }
      if (a.followup.follow_up_date && !isDateString(a.followup.follow_up_date)) {
        return { statusCode: 400, response: { error: `followup.follow_up_date moet YYYY-MM-DD zijn (${a.attendee_id})` } };
      }
      if (a.followup.owner_id != null && !UUID_RE.test(String(a.followup.owner_id))) {
        return { statusCode: 400, response: { error: `followup.owner_id ongeldig (${a.attendee_id})` } };
      }
    }
    // Afwezig-blok (stap 1). Het scherm stuurt dit pas mee als reden én
    // belmoment allebei ingevuld zijn, dus wat hier binnenkomt hoort
    // compleet te zijn. Onvolledig of onbekend is daarom een fout en geen
    // stilte — anders verdwijnt een ingevulde opvolging zonder melding.
    if (a.afwezig != null) {
      if (typeof a.afwezig !== 'object' || Array.isArray(a.afwezig)) {
        return { statusCode: 400, response: { error: `afwezig moet object zijn voor ${a.attendee_id}` } };
      }
      if (!AFWEZIG_STATUSSEN.has(String(a.attendance_status || ''))) {
        return { statusCode: 400, response: { error: `afwezig alleen toegestaan bij attendance_status 'no_show' of 'afgemeld' (${a.attendee_id})` } };
      }
      // De reden MAG ontbreken — dan wordt het 'onbekend'. Een reden die niet
      // in de lijst staat is wél een fout: dat komt niet van een mens die
      // niets aanklikte, maar van een client die iets verzint.
      const opgegevenReden = String(a.afwezig.reason_code || '').trim();
      if (opgegevenReden && !AFWEZIG_REDENEN.has(opgegevenReden)) {
        return { statusCode: 400, response: { error: `afwezig.reason_code ongeldig (${a.attendee_id})` } };
      }
      if (a.afwezig.follow_up_date != null && !isDateString(a.afwezig.follow_up_date)) {
        return { statusCode: 400, response: { error: `afwezig.follow_up_date moet YYYY-MM-DD zijn (${a.attendee_id})` } };
      }
      // Bewust GEEN eis dat er iets in staat. Een leeg blok is prima: de
      // deelnemer komt hoe dan ook in de pot, met 'onbekend' en een
      // standaard-belmoment. Wie er niet was mag nooit kwijtraken.
      if (a.afwezig.owner_id != null && !UUID_RE.test(String(a.afwezig.owner_id))) {
        return { statusCode: 400, response: { error: `afwezig.owner_id ongeldig (${a.attendee_id})` } };
      }
    }
  }
  for (const m of presentMentorIds) {
    if (!UUID_RE.test(String(m || ''))) return { statusCode: 400, response: { error: 'present_team_member_ids: uuid verwacht' } };
  }
  for (const e of expensesIn) {
    if (!e || typeof e !== 'object') return { statusCode: 400, response: { error: 'expenses-item ongeldig' } };
    const amt = Number(e.amount);
    if (!Number.isFinite(amt) || amt < 0) return { statusCode: 400, response: { error: 'expense.amount moet >= 0 zijn' } };
    if (e.spent_at && !isDateString(e.spent_at)) return { statusCode: 400, response: { error: 'expense.spent_at moet YYYY-MM-DD zijn' } };
    if (e.mentor_team_member_ids != null && !Array.isArray(e.mentor_team_member_ids)) {
      return { statusCode: 400, response: { error: 'expense.mentor_team_member_ids moet array zijn' } };
    }
    for (const tm of (e.mentor_team_member_ids || [])) {
      if (!UUID_RE.test(String(tm || ''))) return { statusCode: 400, response: { error: 'expense.mentor_team_member_ids: uuid verwacht' } };
    }
  }

  const summary = {
    attendees_updated      : 0,
    mentors_marked_present : 0,
    expenses_inserted      : 0,
    bonus_entries_created  : 0,
    expense_entries_created: 0,
    followups_created      : 0,
    followups_updated      : 0,
    skipped                : {},
    total_bonus_amount     : 0,
    total_expense_amount   : 0,
    warnings               : [],
  };
  const bump = (k) => { summary.skipped[k] = (summary.skipped[k] || 0) + 1; };

  try {
    // ── 1) Event laden ──────────────────────────────────────────────────────
    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, status, completed_at, completed_by')
      .eq('id', eventId)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return { statusCode: 404, response: { error: 'Event niet gevonden' } };

    // ── 2) events.completed_at/by + completion_summary ──────────────────────
    let completedAt = event.completed_at;
    const evUpdate = {};
    if (!completedAt) {
      const nowIso = new Date().toISOString();
      evUpdate.completed_at = nowIso;
      evUpdate.completed_by = userId;
      completedAt = nowIso;
    }
    if (completionSummary != null) {
      evUpdate.completion_summary = completionSummary || null;
    }
    if (Object.keys(evUpdate).length > 0) {
      const { error: cErr } = await supabaseAdmin.from('events').update(evUpdate).eq('id', eventId);
      if (cErr) throw new Error('event complete update: ' + cErr.message);
    }

    // ── 3) Per attendee: attendance_status + outcome + status-lifecycle ─
    // De lifecycle-kolom `status` beweegt nu MEE met attendance_status:
    //   aanwezig  → 'aanwezig'    (deal-koppeling maakt 'em een 'sale' via
    //                              de bestaande has_signed_deal-afleiding
    //                              in events-attendees-list; status='sale'
    //                              hier zetten zou de detectie dubbelen).
    //   no_show   → 'no_show'     (Opvolglijst-tab filtert op deze kolom).
    //   afgemeld  → 'geannuleerd' (VALID_STATUS kent alleen deze; 'afgemeld'
    //                              is geen lifecycle-status).
    // Bijbehorende timestamps (attended_at / no_show_marked_at) worden gezet
    // als de kolom bestaat en de attendee die nog niet had. Fail-soft 42703:
    // bij ontbrekende kolom → retry zonder timestamps.
    const STATUS_MAP = {
      aanwezig : 'aanwezig',
      no_show  : 'no_show',
      afgemeld : 'geannuleerd',
    };
    const nowIsoAtt = new Date().toISOString();
    for (const a of attendeesIn) {
      const upd = { attendance_status: a.attendance_status };
      upd.outcome = (a.attendance_status === 'aanwezig' && a.outcome) ? a.outcome : null;
      const mappedStatus = STATUS_MAP[a.attendance_status];
      if (mappedStatus) upd.status = mappedStatus;
      // Timestamp-kolommen (fail-soft in de retry hieronder).
      const rich = { ...upd };
      if (a.attendance_status === 'aanwezig') rich.attended_at       = nowIsoAtt;
      if (a.attendance_status === 'no_show')  rich.no_show_marked_at = nowIsoAtt;
      // De reden bij "geen interesse". Eigen trede in de ladder hieronder:
      // ontbreekt alleen deze kolom, dan willen we de tijdstempels NIET ook
      // kwijtraken.
      const metReden = { ...rich };
      if (a.attendance_status === 'aanwezig'
          && REDEN_VERPLICHT_OUTCOMES.has(String(a.outcome || ''))
          && isBezwaar(a.outcome_reason)) {
        metReden.outcome_reason = a.outcome_reason;
      } else {
        // Wisselt iemand van 'geen interesse' naar iets anders bij een
        // her-afronding, dan moet de oude reden weg.
        metReden.outcome_reason = null;
      }

      const schrijf = (payload) => supabaseAdmin
        .from('event_attendees')
        .update(payload)
        .eq('id', a.attendee_id)
        .eq('event_id', eventId)
        // Beveiliging: sla verplaatste attendees over (mocht die per ongeluk
        // toch in de payload zitten). Hun status='switched_to_other_event'
        // is een aparte lifecycle-toestand.
        .neq('status', 'switched_to_other_event');

      // Van rijk naar kaal: eerst mét reden, dan zonder reden maar mét
      // tijdstempels, dan alleen het strikt noodzakelijke. Elke trede lager
      // kost informatie, dus we zakken pas als de database het afdwingt.
      const treden = [metReden, rich, upd];
      let aErr = null;
      let gelukt = false;
      for (const payload of treden) {
        const { error } = await schrijf(payload);
        if (!error) { gelukt = true; break; }
        aErr = error;
        if (error.code !== '42703' && error.code !== 'PGRST204') break;
      }
      if (gelukt) {
        summary.attendees_updated += 1;
      } else {
        console.error('[events-complete-core] attendee update', a.attendee_id, aErr?.message);
        summary.warnings.push(`attendee ${a.attendee_id}: ${aErr?.message || 'onbekende fout'}`);
      }
    }

    // ── 3b) Event follow-ups upsert ─────────────────────────────────────────
    // Twee takken, één weg.
    //   · Aanwezig met outcome 'opvolgen' of 'twijfelt_nog' — bestaand
    //     gedrag, notitie verplicht (server-side check hier + UI-check).
    //   · No-show of afgemeld met een aangeklikte reden én een belmoment —
    //     nieuw sinds stap 1. Notitie optioneel; de reden is hier het
    //     gestructureerde deel.
    // Allebei leveren dezelfde event_followups-rij en dezelfde
    // follow_up_leads-rij op, met `bron_uitkomst` als onderscheid.
    //
    // De bestaande no-showkolommen op event_attendees blijven met rust:
    // no_show_followup_status betekent "we hebben contact gehad" en een
    // belmoment plannen is geen contact. NULL betekent daar nog steeds
    // "no-show, nog niet opgevolgd", en dat klopt. De Opvolglijst-tab
    // (api/follow-up-opvolglijst.js) verandert daardoor niet.
    for (const a of attendeesIn) {
      // Tak 1 — was aanwezig en moet opgevolgd worden. Bestaand gedrag.
      const aanwezigTrigger = (a.attendance_status === 'aanwezig' && FOLLOWUP_OUTCOMES.has(a.outcome))
        && !!a.followup && typeof a.followup === 'object';

      // Tak 2 — was er niet. Alleen als de gebruiker daadwerkelijk een reden
      // én een belmoment heeft ingevuld. Doet hij dat niet, dan gebeurt er
      // niets extra's: de aanwezigheidsstatus wordt gewoon opgeslagen zoals
      // altijd. Een half ingevuld blok mag geen halve follow-up opleveren.
      // Tak 2 gaat ALTIJD open bij een no-show of een afmelding. Zonder
      // voorwaarde, ook als het blok leeg is.
      //
      // Dit was eerst afhankelijk van wat er was ingevuld, en dat kostte op
      // 26 augustus twee mensen: notitie getypt, geen reden aangeklikt, alles
      // weg. Elke voorwaarde is een pad waarlangs iemand stil verdwijnt.
      // Reden en notitie reizen mee als ze er zijn; ze bepalen niet óf de rij
      // ontstaat. Ontbreekt de reden, dan wordt het 'onbekend'; ontbreekt het
      // belmoment, dan vult datumOverDagen hieronder het standaardmoment in.
      const afw = (a.afwezig && typeof a.afwezig === 'object') ? a.afwezig : {};
      const afwezigTrigger = AFWEZIG_STATUSSEN.has(a.attendance_status);

      if (!aanwezigTrigger && !afwezigTrigger) continue;

      // Vanaf hier is het één weg. De twee takken verschillen alleen in
      // waar de velden vandaan komen.
      const bronNotitie = aanwezigTrigger ? a.followup.reason : afw.note;
      const reasonText  = bronNotitie != null ? String(bronNotitie).slice(0, 500) : null;
      // Reason (notitie) verplicht bij 'opvolgen' en 'twijfelt_nog'.
      // Bij een afwezige is de notitie optioneel — de aangeklikte reden is
      // daar de gestructureerde informatie, en die is al gecontroleerd.
      if (aanwezigTrigger && REASON_REQUIRED_OUTCOMES.has(a.outcome)) {
        if (!reasonText || !reasonText.trim()) {
          const err = new Error(`attendee ${a.attendee_id}: notitie verplicht bij outcome '${a.outcome}'`);
          err.status = 400;
          err.code = 'REASON_REQUIRED';
          throw err;
        }
      }
      const bronUitkomst = aanwezigTrigger ? a.outcome : a.attendance_status;
      const opgegeven    = aanwezigTrigger ? '' : String(afw.reason_code || '').trim();
      const reasonCode   = aanwezigTrigger ? null : (AFWEZIG_REDENEN.has(opgegeven) ? opgegeven : 'onbekend');
      const followDate   = aanwezigTrigger
        ? (a.followup.follow_up_date || null)
        : (afw.follow_up_date || datumOverDagen(AFWEZIG_BELMOMENT_DAGEN[a.attendance_status] ?? 1));
      const ownerId      = (aanwezigTrigger ? a.followup.owner_id : afw.owner_id) || DEFAULT_FOLLOWUP_OWNER_ID || null;

      // Eén payload voor alle drie de schrijfmomenten hieronder (update,
      // insert, en de update na een race). reason_code en bron_uitkomst
      // komen uit de migratie van 27-08-2026; zolang die niet gedraaid is
      // valt de schrijfactie terug op de payload zonder die twee. De
      // follow-up zelf is belangrijker dan het etiket erop.
      const fuVelden = {
        event_id      : eventId,
        reason        : reasonText,
        follow_up_date: followDate,
        owner_id      : ownerId,
        reason_code   : reasonCode,
        bron_uitkomst : bronUitkomst,
      };
      const fuUpdate = async (rijId) => {
        let { error } = await supabaseAdmin
          .from('event_followups').update(fuVelden).eq('id', rijId);
        if (error && isMissendeKolom(error)) {
          ({ error } = await supabaseAdmin
            .from('event_followups').update(zonderNieuweKolommen(fuVelden)).eq('id', rijId));
        }
        return error;
      };
      const fuInsert = async () => {
        const rij = { ...fuVelden, attendee_id: a.attendee_id, status: 'open', created_by: userId };
        let { data, error } = await supabaseAdmin
          .from('event_followups').insert(rij).select('id').maybeSingle();
        if (error && isMissendeKolom(error)) {
          ({ data, error } = await supabaseAdmin
            .from('event_followups').insert(zonderNieuweKolommen(rij)).select('id').maybeSingle());
        }
        return { data, error };
      };

      let followupIdForLead = null;
      try {
        const { data: existing, error: selErr } = await supabaseAdmin
          .from('event_followups')
          .select('id')
          .eq('attendee_id', a.attendee_id)
          .eq('status', 'open')
          .maybeSingle();
        if (selErr) { summary.warnings.push(`followup-lookup ${a.attendee_id}: ${selErr.message}`); continue; }
        if (existing) {
          const upErr = await fuUpdate(existing.id);
          if (upErr) summary.warnings.push(`followup-update ${a.attendee_id}: ${upErr.message}`);
          else { summary.followups_updated += 1; followupIdForLead = existing.id; }
        } else {
          const { data: insData, error: insErr } = await fuInsert();
          if (insErr) {
            if (insErr.code === '23505') {
              const { data: again } = await supabaseAdmin
                .from('event_followups').select('id')
                .eq('attendee_id', a.attendee_id).eq('status', 'open').maybeSingle();
              if (again) {
                const upErr2 = await fuUpdate(again.id);
                if (upErr2) summary.warnings.push(`followup-race-update ${a.attendee_id}: ${upErr2.message}`);
                else { summary.followups_updated += 1; followupIdForLead = again.id; }
              }
            } else {
              summary.warnings.push(`followup-insert ${a.attendee_id}: ${insErr.message}`);
            }
          } else {
            summary.followups_created += 1;
            followupIdForLead = insData?.id || null;
          }
        }
      } catch (e) {
        console.error('[events-complete-core followup]', a.attendee_id, e?.message || e);
        summary.warnings.push(`followup ${a.attendee_id}: ${e?.message || 'unknown'}`);
      }

      // Punt A: ook meteen een follow_up_leads-lead (source='event')
      // borgen zodat de opvolging automatisch in de Werklijst-cockpit
      // verschijnt (met 'Follow-up event'-badge via source_ref.is_event_followup).
      // Idempotent: match op source_ref.attendee_id (naam-basis) of
      // (customer_id, source='event') met open lead_status. Bij bestaande
      // open lead → update terugbel_datum + reason. Fail-soft bij 42P01.
      try {
        // Attendee-basis nodig voor naam/email/phone/customer_id.
        const { data: att, error: attErr } = await supabaseAdmin
          .from('event_attendees')
          .select('id, customer_id, first_name, last_name, email, phone')
          .eq('id', a.attendee_id)
          .maybeSingle();
        if (attErr) throw new Error('att fetch: ' + attErr.message);
        if (!att) throw new Error('attendee not found');

        const nameParts = [att.first_name, att.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
        const leadName = nameParts.join(' ').trim() || att.email || '(onbekend)';
        const leadRow = {
          customer_id       : att.customer_id || null,
          source            : 'event',
          lead_name         : leadName,
          lead_email        : att.email || null,
          lead_phone        : att.phone || null,
          lead_status       : 'nieuw',
          terugbel_datum    : followDate,
          source_ref        : {
            event_id       : eventId,
            attendee_id    : att.id,
            is_event_followup: true,
            // De herkomst van de rij, zodat no-shows, afgemelden en
            // twijfelaars apart te filteren en te tellen zijn:
            //   select source_ref->>'event_uitkomst', count(*)
            //     from follow_up_leads where source = 'event' group by 1;
            //
            // Bewust hier en niet als nieuwe `source`-waarde. Van
            // follow_up_leads bestaat geen migratie in deze repo — de tabel
            // is met de hand aangemaakt — dus of er een CHECK op `source`
            // staat is van buitenaf niet te zien. Een geweigerde insert
            // betekent hier een opvolging die stil verdwijnt, op een live
            // systeem. source_ref is jsonb en kent dat risico niet, en de
            // code filtert er al op (source_ref->>attendee_id).
            event_uitkomst : bronUitkomst,
            ...(reasonCode ? { reason_code: reasonCode } : {}),
            ...(followupIdForLead ? { followup_id: followupIdForLead } : {}),
            ...(reasonText ? { reason: reasonText } : {}),
          },
          created_by_user_id: userId,
        };

        /**
         * Wat we in een BESTAANDE rij zetten. Stond hij dicht, dan gaat hij
         * weer open op het gekozen belmoment.
         *
         * `attempts` blijft bewust ONGEMOEID. Die teller is de historiek van
         * eerdere pogingen, en die is juist waardevol: de beller ziet dat er
         * al drie keer gebeld is. Op nul zetten zou het lijken alsof er nooit
         * iets gebeurd is, en zou de cadans opnieuw laten beginnen.
         */
        const leadPatchVoorBestaande = (vorigeStatus) => {
          const patch = {
            terugbel_datum: followDate,
            source_ref    : leadRow.source_ref,
            lead_email    : att.email || null,
            lead_phone    : att.phone || null,
          };
          if (isGesloten(vorigeStatus)) {
            patch.lead_status  = 'terugbellen';
            // Een sluimerende rij zou anders alsnog onzichtbaar blijven.
            patch.snoozed_until = null;
          }
          return patch;
        };

        /**
         * De update uitvoeren, met één terugval. `snoozed_until` hoort bij de
         * kolommen waarvan follow-up-lead-outcome.js zelf ook niet zeker weet
         * of ze bestaan (er is geen migratie van deze tabel in de repo).
         * Ontbreekt hij, dan proberen we het opnieuw zonder — het heropenen
         * zelf is belangrijker dan het opheffen van een sluimering.
         */
        const schrijfLeadPatch = async (leadId, vorigeStatus) => {
          const patch = leadPatchVoorBestaande(vorigeStatus);
          let { error } = await supabaseAdmin.from('follow_up_leads').update(patch).eq('id', leadId);
          if (error && isMissendeKolom(error) && 'snoozed_until' in patch) {
            const { snoozed_until: _weg, ...zonder } = patch;
            ({ error } = await supabaseAdmin.from('follow_up_leads').update(zonder).eq('id', leadId));
          }
          return error;
        };

        // 1) Zoek eerst een bestaande open event-lead voor deze attendee
        //    (via source_ref.attendee_id → dekt zowel customer_id- als
        //    naam-basis-varianten). Zo voorkomen we duplicates die het
        //    unique-index-pad niet zou vangen bij customer_id=NULL.
        //    GESLOTEN RIJEN TELLEN MEE. Dat deden ze niet, en dat kostte
        //    mensen: wie ooit eerder gebeld en afgesloten was, had een rij met
        //    lead_status 'verloren' en geen terugbel_datum. Die werd hier
        //    overgeslagen, de insert liep vervolgens op de unieke index, en de
        //    terugval sloot gesloten rijen óók uit — netto gebeurde er niets.
        //    Geen nieuwe rij, oude rij onaangeroerd, en de deelnemer stond in
        //    geen enkele lijst terwijl het afronden zelf goed was gegaan.
        //    Een event is een nieuw contactmoment; dat heropent een oude rij.
        let existingLeadId = null;
        let existingLeadStatus = null;
        try {
          const { data: byAtt } = await supabaseAdmin
            .from('follow_up_leads')
            .select('id, lead_status, source_ref')
            .eq('source', 'event')
            .filter('source_ref->>attendee_id', 'eq', att.id)
            .order('created_at', { ascending: false })
            .limit(1);
          if (byAtt && byAtt[0]) {
            existingLeadId = byAtt[0].id;
            existingLeadStatus = byAtt[0].lead_status || null;
          }
        } catch (_) {}

        if (existingLeadId) {
          const leadUpErr = await schrijfLeadPatch(existingLeadId, existingLeadStatus);
          if (leadUpErr) summary.warnings.push(`event-lead update ${a.attendee_id}: ${leadUpErr.message}`);
          else {
            summary.event_leads_updated = (summary.event_leads_updated || 0) + 1;
            if (isGesloten(existingLeadStatus)) {
              summary.event_leads_heropend = (summary.event_leads_heropend || 0) + 1;
              await meldHeropening(existingLeadId, eventId, existingLeadStatus, userId);
            }
          }
        } else {
          const { error: leadInsErr } = await supabaseAdmin
            .from('follow_up_leads')
            .insert(leadRow);
          if (leadInsErr) {
            if (leadInsErr.code === '42P01') {
              summary.warnings.push(`event-lead ${a.attendee_id}: follow_up_leads ontbreekt (MIGRATION_REQUIRED)`);
            } else if (leadInsErr.code === '23505') {
              // Unique-index (customer_id, source) WHERE lead_status NOT IN
              // (verlengd,verloren). Zoek de bestaande en update.
              try {
                // Ook hier tellen gesloten rijen mee — zie de toelichting bij
                // de zoekactie hierboven. Deze terugval sloot ze uit, en dat
                // was precies de tweede plek waar het stilviel.
                const { data: existLead } = await supabaseAdmin
                  .from('follow_up_leads')
                  .select('id, lead_status')
                  .eq('source', 'event')
                  .eq('customer_id', att.customer_id)
                  .order('created_at', { ascending: false })
                  .limit(1);
                if (existLead && existLead[0]) {
                  const vorigeStatus = existLead[0].lead_status || null;
                  await schrijfLeadPatch(existLead[0].id, vorigeStatus);
                  summary.event_leads_updated = (summary.event_leads_updated || 0) + 1;
                  if (isGesloten(vorigeStatus)) {
                    summary.event_leads_heropend = (summary.event_leads_heropend || 0) + 1;
                    await meldHeropening(existLead[0].id, eventId, vorigeStatus, userId);
                  }
                }
              } catch (_) {}
            } else {
              summary.warnings.push(`event-lead insert ${a.attendee_id}: ${leadInsErr.message}`);
            }
          } else {
            summary.event_leads_created = (summary.event_leads_created || 0) + 1;
          }
        }
      } catch (e) {
        console.error('[events-complete-core event-lead]', a.attendee_id, e?.message || e);
        summary.warnings.push(`event-lead ${a.attendee_id}: ${e?.message || 'unknown'}`);
      }
    }

    // ── Punt B: dezelfde deelnemers, maar dan in de nieuwe takenpot ─────────
    // Naast de follow_up_leads-rij van Punt A krijgt elke deelnemer nu ook een
    // rij in public.opvolging_taken — het dagsysteem uit
    // docs/sql-migrations/2026-09-03-opvolging-fase1.sql. Dat is een tweede,
    // losse pot; Punt A, event_followups en follow_up_leads blijven exact
    // zoals ze waren en worden hier niet aangeraakt.
    //
    // WAAROM EEN EIGEN LUS EN NIET ONDERIN DE VORIGE
    // De lus hierboven begint met `if (!aanwezigTrigger && !afwezigTrigger)
    // continue;`. Daar komt 'geen_interesse' nooit voorbij: die outcome zit
    // niet in FOLLOWUP_OUTCOMES en de deelnemer was aanwezig, dus beide
    // triggers zijn vals. Een blok dat achter Punt A hangt zou dat geval dus
    // stil overslaan, terwijl het juist een rij hoort op te leveren (meteen
    // gearchiveerd, met het bezwaar erbij). Die `continue` aanpassen mag niet
    // en hoeft ook niet — een eigen lus over dezelfde attendeesIn ziet ze
    // allemaal en laat de bestaande weg volledig met rust.
    //
    // FAIL-SOFT, NET ALS PUNT A
    // Eén try/catch per deelnemer. Wat hier misgaat mag het afronden van het
    // event nooit laten mislukken: het event is dan al afgerond, de bonussen
    // zijn berekend en de leads staan er. Een kapotte takenpot is een
    // waarschuwing in de summary, geen 500.
    // Het etiket op de kaart: 'Masterclass Gent · 27 aug'. Eén keer ophalen voor
    // alle deelnemers — het is per definitie hetzelfde event. Eigen query, want
    // de events-select bovenin haalt alleen de afrond-kolommen op en die regel
    // blijft ongemoeid. Mislukt hij, dan blijft het label leeg: een badge is
    // versiering, geen reden om de taken niet aan te maken.
    let opvolgingBadge = null;
    try {
      const { data: evMeta } = await supabaseAdmin
        .from('events')
        .select('title, starts_at')
        .eq('id', eventId)
        .maybeSingle();
      opvolgingBadge = opvolgingBadgeLabel(evMeta?.title, evMeta?.starts_at);
    } catch (_) { /* badge is optioneel */ }

    for (const a of attendeesIn) {
      try {
        // Naam/mail/telefoon uit dezelfde kolommen die Punt A ophaalt.
        const { data: att, error: attErr } = await supabaseAdmin
          .from('event_attendees')
          .select('id, customer_id, first_name, last_name, email, phone')
          .eq('id', a.attendee_id)
          .maybeSingle();
        if (attErr) throw new Error('att fetch: ' + attErr.message);
        if (!att) throw new Error('attendee not found');

        // De event_followups-rij van hierboven, als die er is. Bij
        // 'geen_interesse' bestaat hij niet — dan blijft followup_id null.
        let followupId = null;
        try {
          const { data: fu } = await supabaseAdmin
            .from('event_followups')
            .select('id')
            .eq('attendee_id', att.id)
            .eq('status', 'open')
            .maybeSingle();
          followupId = fu?.id || null;
        } catch (_) { /* referentie is optioneel */ }

        const taak = bouwOpvolgingTaak({
          attendanceStatus: a.attendance_status,
          outcome         : a.outcome,
          outcomeReason   : a.outcome_reason,
          followup        : a.followup,
          afwezig         : a.afwezig,
          eventId,
          att,
          followupId,
          badgeLabel: opvolgingBadge,
        });
        // Klant geworden of nog onbekend: er valt niets op te volgen.
        if (!taak) continue;

        // Idempotent: één open kaart per deelnemer. Match op
        // bron_ref->>'attendee_id' en alleen op een rij die niet gearchiveerd
        // is — een afgesloten kaart is geschiedenis en blijft staan.
        let bestaandeId = null;
        const { data: bestaand, error: zoekErr } = await supabaseAdmin
          .from('opvolging_taken')
          .select('id')
          .neq('status', 'gearchiveerd')
          .filter('bron_ref->>attendee_id', 'eq', att.id)
          .order('created_at', { ascending: false })
          .limit(1);
        if (zoekErr) {
          // Zolang de migratie niet gedraaid is bestaat de tabel niet. Dat is
          // een setup-melding, geen fout in het afronden — zelfde signaal als
          // Punt A geeft bij een ontbrekende follow_up_leads.
          if (zoekErr.code === '42P01') {
            summary.warnings.push(`opvolging-taak ${a.attendee_id}: opvolging_taken ontbreekt (MIGRATION_REQUIRED)`);
            continue;
          }
          throw new Error('zoek: ' + zoekErr.message);
        }
        if (bestaand && bestaand[0]) bestaandeId = bestaand[0].id;

        if (bestaandeId) {
          // Staat er al een kaart, dan wordt die niet overschreven. Alleen een
          // nieuw belmoment en een nieuwe notitie gaan mee; status, reden,
          // pogingen en eigenaar blijven van de kaart zelf.
          const patch = {};
          if (taak.due != null)     patch.due     = taak.due;
          if (taak.notitie != null) patch.notitie = taak.notitie;
          if (Object.keys(patch).length === 0) continue;
          const { error: upErr } = await supabaseAdmin
            .from('opvolging_taken').update(patch).eq('id', bestaandeId);
          if (upErr) throw new Error('update: ' + upErr.message);
          summary.opvolging_taken_updated = (summary.opvolging_taken_updated || 0) + 1;
        } else {
          const { error: insErr } = await supabaseAdmin
            .from('opvolging_taken').insert(taak);
          if (insErr) {
            if (insErr.code === '42P01') {
              summary.warnings.push(`opvolging-taak ${a.attendee_id}: opvolging_taken ontbreekt (MIGRATION_REQUIRED)`);
            } else {
              throw new Error('insert: ' + insErr.message);
            }
          } else {
            summary.opvolging_taken_created = (summary.opvolging_taken_created || 0) + 1;
          }
        }
      } catch (e) {
        console.error('[events-complete-core opvolging-taak]', a.attendee_id, e?.message || e);
        summary.warnings.push(`opvolging-taak ${a.attendee_id}: ${e?.message || 'unknown'}`);
      }
    }

    // ── 4) event_mentors.was_present ────────────────────────────────────────
    // Bug: de oude UPDATE .in('team_member_id', presentMentorIds) raakte
    // alleen mentoren die AL een event_mentors-rij hadden. Aangevinkte
    // mentoren zonder bestaande koppeling werden stil genegeerd → count=0
    // → 'geen mentoren aanwezig' → geen bonus, ondanks correcte sale.
    // Fix: eerst reset, dan UPSERT op (event_id, team_member_id) zodat
    // ontbrekende koppelingen als was_present=true worden aangemaakt en
    // bestaande rijen naar was_present=true worden bijgewerkt.
    {
      const { error: resetErr } = await supabaseAdmin
        .from('event_mentors').update({ was_present: false }).eq('event_id', eventId);
      if (resetErr) summary.warnings.push('mentors reset: ' + resetErr.message);
      if (presentMentorIds.length > 0) {
        const rows = presentMentorIds.map((tmId) => ({
          event_id         : eventId,
          team_member_id   : tmId,
          was_present      : true,
          added_by_user_id : userId,
        }));
        const { error: upsertErr } = await supabaseAdmin
          .from('event_mentors')
          .upsert(rows, { onConflict: 'event_id,team_member_id' });
        if (upsertErr) summary.warnings.push('mentors upsert: ' + upsertErr.message);
        else summary.mentors_marked_present = presentMentorIds.length;
      }
    }

    // ── 5) Uitgaven inserten ────────────────────────────────────────────────
    const expenseRows = expensesIn
      .filter((e) => Number(e.amount) > 0)
      .map((e) => ({
        event_id              : eventId,
        amount                : round2(e.amount),
        vendor                : e.vendor ? String(e.vendor).slice(0, 255) : null,
        spent_at              : e.spent_at || null,
        note                  : e.note ? String(e.note).slice(0, 1000) : null,
        mentor_team_member_ids: Array.isArray(e.mentor_team_member_ids) && e.mentor_team_member_ids.length > 0
                                  ? e.mentor_team_member_ids : null,
        created_by            : userId,
      }));
    let insertedExpenses = [];
    if (expenseRows.length > 0) {
      const { error: exErr, data: exData } = await supabaseAdmin
        .from('event_expenses').insert(expenseRows)
        .select('id, amount, mentor_team_member_ids');
      if (exErr) summary.warnings.push('expenses insert: ' + exErr.message);
      else { insertedExpenses = exData || []; summary.expenses_inserted = insertedExpenses.length; }
    }

    // ── 6) Aanwezige mentoren met user_id ───────────────────────────────────
    const { data: mentorsAll, error: mErr } = await supabaseAdmin
      .from('event_mentors')
      .select(`
        team_member_id, was_present,
        team_members:team_member_id ( id, user_id )
      `)
      .eq('event_id', eventId);
    if (mErr) summary.warnings.push('mentors fetch (ledger): ' + mErr.message);
    const presentMentors = (mentorsAll || [])
      .filter((m) => m.was_present === true)
      .map((m) => ({ team_member_id: m.team_member_id, user_id: m.team_members?.user_id || null }));
    const eligibleMentors = presentMentors.filter((m) => !!m.user_id);
    if (presentMentors.length > eligibleMentors.length) {
      const missing = presentMentors.length - eligibleMentors.length;
      summary.warnings.push(`${missing} aanwezige mentor(en) zonder user_id — geen ledger-entries`);
      summary.skipped.mentor_zonder_user_id = missing;
    }
    const N = eligibleMentors.length;

    // ── 7) Ledger: bonus per aanwezige verkochte attendee ───────────────────
    if (N > 0) {
      const presentSold = attendeesIn.filter((a) => a.attendance_status === 'aanwezig');
      const presentIds = presentSold.map((a) => a.attendee_id);
      let attendeeRows = [];
      if (presentIds.length > 0) {
        // v=2026-08-27: bonus_excluded meelezen (migratie 049). Fail-soft
        // bij ontbrekende kolom: retry zonder de kolom en behandel elke
        // attendee als bonus_excluded=false. Dat behoudt legacy-gedrag
        // op omgevingen waar 049 nog niet is gedraaid.
        const { data, error } = await supabaseAdmin
          .from('event_attendees')
          .select('id, customer_id, deal_id, bonus_excluded')
          .in('id', presentIds);
        if (error) {
          if (error.code === '42703' || /column .*bonus_excluded/i.test(error.message || '')) {
            const retry = await supabaseAdmin
              .from('event_attendees')
              .select('id, customer_id, deal_id')
              .in('id', presentIds);
            if (retry.error) summary.warnings.push('attendees fetch (bonus, retry): ' + retry.error.message);
            else attendeeRows = (retry.data || []).map((r) => ({ ...r, bonus_excluded: false }));
          } else {
            summary.warnings.push('attendees fetch (bonus): ' + error.message);
          }
        } else {
          attendeeRows = data || [];
        }
      }

      for (const att of attendeeRows) {
        // v=2026-08-27: expliciete bonus-uitsluiting (v2 "Ontkoppel deal"-
        // actie zet bonus_excluded=true). Skipt ALLE deal-lookups zodat
        // ook de customer_id-fallback niet triggert. Behoudt customer_id
        // intact voor rapportages.
        if (att.bonus_excluded === true) {
          bump('bonus_expliciet_uitgesloten');
          continue;
        }
        let deal = null;
        if (att.deal_id) {
          const { data: d } = await supabaseAdmin
            .from('deals')
            .select('id, customer_id, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at')
            .eq('id', att.deal_id).maybeSingle();
          if (d && (ACCEPTED.has(String(d.tl_quotation_status || '').toLowerCase()) || d.tl_quotation_accepted_at)) {
            deal = d;
          }
        }
        if (!deal && att.customer_id) {
          const { data: ds } = await supabaseAdmin
            .from('deals')
            .select('id, customer_id, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at')
            .eq('customer_id', att.customer_id)
            .in('tl_quotation_status', ['accepted', 'signed'])
            .order('tl_quotation_accepted_at', { ascending: false, nullsFirst: false })
            .limit(1);
          if (ds && ds[0]) deal = ds[0];
        }
        if (!deal) { bump('attendee_zonder_getekende_offerte'); continue; }

        const { data: lines } = await supabaseAdmin
          .from('deal_line_items')
          .select('quantity, unit_price, vat_percentage, price_includes_vat')
          .eq('deal_id', deal.id);
        const totals = computeDealTotals(deal, lines || []);
        const basis = basisInclBtw ? totals.incl : totals.excl;
        if (!Number.isFinite(basis) || basis <= 0) { bump('deal_zonder_waarde'); continue; }

        const perMentor = round2((BONUS_PCT * basis / 100) / N);
        if (perMentor <= 0) { bump('bonus_afgerond_naar_nul'); continue; }
        for (const m of eligibleMentors) {
          const idem = `${eventId}:bonus:${att.id}:${m.user_id}`;
          const { error: insErr } = await supabaseAdmin
            .from('mentor_ledger_entries')
            .insert({
              mentor_user_id : m.user_id,
              team_member_id : m.team_member_id,
              event_id       : eventId,
              entry_type     : 'bonus',
              attendee_id    : att.id,
              customer_id    : deal.customer_id || att.customer_id || null,
              basis          : basis,
              basis_incl_btw : basisInclBtw,
              pct            : BONUS_PCT,
              amount         : perMentor,
              status         : 'pending',
              source_quote_id: deal.id,
              idempotency_key: idem,
              note           : `Bonus ${BONUS_PCT}% van EUR ${basis.toFixed(2)} ${basisInclBtw ? 'incl' : 'excl'} BTW / ${N} mentor(en)`,
            });
          if (insErr) {
            if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
              bump('bonus_al_aangemaakt');
            } else {
              console.error('[events-complete-core] bonus insert', insErr.message);
              summary.warnings.push('bonus insert: ' + insErr.message);
            }
          } else {
            summary.bonus_entries_created += 1;
            summary.total_bonus_amount = round2(summary.total_bonus_amount + perMentor);
          }
        }
      }

      // ── 8) Ledger: uitgaven splitsen ──────────────────────────────────────
      const releasedAt = new Date().toISOString();
      for (const exp of insertedExpenses) {
        const explicitIds = Array.isArray(exp.mentor_team_member_ids) ? exp.mentor_team_member_ids : null;
        const targetMentors = (explicitIds && explicitIds.length > 0)
          ? eligibleMentors.filter((m) => explicitIds.includes(m.team_member_id))
          : eligibleMentors;
        if (targetMentors.length === 0) { bump('uitgave_zonder_mentor'); continue; }
        const amountAbs = Number(exp.amount) || 0;
        const perMentor = -round2(amountAbs / targetMentors.length);
        if (perMentor === 0) { bump('uitgave_afgerond_naar_nul'); continue; }
        for (const m of targetMentors) {
          const idem = `${eventId}:uitgave:${exp.id}:${m.user_id}`;
          const { error: insErr } = await supabaseAdmin
            .from('mentor_ledger_entries')
            .insert({
              mentor_user_id : m.user_id,
              team_member_id : m.team_member_id,
              event_id       : eventId,
              entry_type     : 'uitgave',
              basis          : amountAbs,
              pct            : null,
              amount         : perMentor,
              status         : 'vrijgegeven',
              idempotency_key: idem,
              note           : `Aandeel uitgave EUR ${amountAbs.toFixed(2)} / ${targetMentors.length} mentor(en)`,
              released_at    : releasedAt,
            });
          if (insErr) {
            if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
              bump('uitgave_al_aangemaakt');
            } else {
              console.error('[events-complete-core] uitgave insert', insErr.message);
              summary.warnings.push('uitgave insert: ' + insErr.message);
            }
          } else {
            summary.expense_entries_created += 1;
            summary.total_expense_amount = round2(summary.total_expense_amount + Math.abs(perMentor));
          }
        }
      }
    } else if (presentMentorIds.length > 0) {
      summary.warnings.push('Geen mentoren met user_id — ledger overgeslagen');
    }

    // ── Notify aanwezige mentoren (fail-soft) ───────────────────────────────
    try {
      let eventTitle = null;
      try {
        const { data: evTitle } = await supabaseAdmin
          .from('events').select('title').eq('id', eventId).maybeSingle();
        eventTitle = evTitle?.title || null;
      } catch (_) { /* fail-soft */ }
      const recipients = new Set();
      for (const m of eligibleMentors) { if (m.user_id) recipients.add(m.user_id); }
      recipients.delete(userId);
      for (const uid of recipients) {
        createNotification({
          toUserId:   uid,
          type:       'event.completed',
          title:      'Event afgerond · ' + (eventTitle || 'zonder titel'),
          body:       'Bonussen berekend',
          linkUrl:    '/modules/events-detail.html?id=' + eventId,
          entityType: 'event',
          entityId:   eventId,
          createdBy:  userId,
        }).catch(() => {});
      }
    } catch (_) { /* fail-soft */ }

    return { statusCode: 200, response: { ok: true, event_id: eventId, completed_at: completedAt, summary } };
  } catch (e) {
    console.error('[events-complete-core] fatal:', e?.message || e);
    return { statusCode: 500, response: { error: e?.message || 'Interne fout', summary } };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Punt B — de vertaling van een afgerond event naar een kaart in
 * public.opvolging_taken. Apart en puur gehouden, want dit is precies het
 * soort besluit dat stil fout gaat: een verkeerde reden of een gemiste rij
 * merk je pas als er iemand niet gebeld is. Zie
 * tests/events-opvolging-taak.test.js voor de zes gevallen.
 * ═══════════════════════════════════════════════════════════════════════════ */

const NL_MAAND_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/**
 * 'Masterclass Gent · 27 aug' — de eventnaam plus de dag waarop het was.
 *
 * starts_at is een timestamptz. Een event van 20:00 in Amsterdam staat in de
 * database op 18:00Z, en in de winter op 19:00Z; wie de UTC-dag pakt zit er bij
 * een avondevent regelmatig een dag naast. Daarom expliciet in Europe/Amsterdam.
 * Zonder titel of zonder datum levert dit gewoon het halve label, en zonder
 * allebei null — een badge is versiering.
 */
function opvolgingBadgeLabel(titel, startsAt) {
  const naam = titel != null ? String(titel).trim() : '';
  let datum = '';
  if (startsAt) {
    const d = new Date(startsAt);
    if (!Number.isNaN(d.getTime())) {
      try {
        datum = new Intl.DateTimeFormat('nl-NL', {
          timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short',
        }).format(d);
      } catch (_) {
        // Zonder volledige ICU valt Intl terug op Engels; dan zelf maar.
        datum = `${d.getUTCDate()} ${NL_MAAND_KORT[d.getUTCMonth()]}`;
      }
    }
  }
  const label = [naam, datum].filter(Boolean).join(' · ');
  return label ? label.slice(0, 200) : null;
}

/**
 * De vertaaltabel van 'wat is er op het event gebeurd' naar 'welke kaart komt
 * er in de pot'. Geeft null terug als er niets op te volgen valt.
 *
 *   aanwezig + opvolgen        → reden 'wil_nog_beslissen', due = het gekozen
 *                                belmoment, notitie = de ingevulde notitie
 *   aanwezig + klant_geworden  → GEEN kaart (die is binnen)
 *   aanwezig + geen_interesse  → kaart, meteen 'gearchiveerd', met het bezwaar
 *                                in archief_reden en gearchiveerd_at op nu
 *   aanwezig + nog_onbekend    → GEEN kaart (je weet het nog niet)
 *   no_show                    → reden 'no_show_event', reden_code = de
 *                                aangeklikte AFWEZIG_REDENEN-code
 *   afgemeld                   → reden 'afgemeld', idem
 *
 * Twee dingen die opvallen als je de tabel naast de kolommen legt:
 *
 *  · `reden` is NOT NULL met een CHECK op vijf waarden, dus ook de kaart die
 *    meteen dichtgaat moet er één dragen. Bij 'geen_interesse' is dat
 *    'wil_nog_beslissen': het is de waarde voor 'was aanwezig, nog geen klant'.
 *    De echte informatie zit in archief_reden — dat is het bezwaar.
 *  · Bij een afwezige valt de reden terug op 'onbekend' en het belmoment op
 *    datumOverDagen(AFWEZIG_BELMOMENT_DAGEN[...]), precies zoals de bestaande
 *    weg hierboven dat doet. Wie er niet was mag nooit kwijtraken, ook niet als
 *    de invuller niets aanklikte.
 *
 * `eigenaar_id` blijft bewust null. De RLS op opvolging_taken is
 * is_crm_staff() — een rolcheck, geen eigenaarscheck — dus een kaart zonder
 * eigenaar is voor het hele CRM-team zichtbaar en niet voor niemand.
 */
function bouwOpvolgingTaak({
  attendanceStatus, outcome, outcomeReason, followup, afwezig,
  eventId, att, followupId = null, badgeLabel = null,
}) {
  const status = String(attendanceStatus || '');
  const uitkomst = String(outcome || '');

  const delen = [att?.first_name, att?.last_name]
    .filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  const naam = delen.join(' ').trim() || att?.email || '(onbekend)';

  const basis = {
    naam,
    email      : att?.email || null,
    telefoon   : att?.phone || null,
    bron       : 'event',
    bron_ref   : {
      event_id   : eventId,
      attendee_id: att?.id || null,
      followup_id: followupId || null,
    },
    badge_label: badgeLabel || null,
    eigenaar_id: null,
  };

  if (status === 'aanwezig') {
    if (uitkomst === 'opvolgen') {
      const fu = (followup && typeof followup === 'object') ? followup : {};
      const notitie = fu.reason != null ? String(fu.reason).slice(0, 500) : null;
      return {
        ...basis,
        reden  : 'wil_nog_beslissen',
        status : 'open',
        ...(fu.follow_up_date ? { due: fu.follow_up_date } : {}),
        ...(notitie ? { notitie } : {}),
      };
    }
    if (uitkomst === 'geen_interesse') {
      const bezwaar = outcomeReason != null ? String(outcomeReason).trim() : '';
      return {
        ...basis,
        reden          : 'wil_nog_beslissen',
        status         : 'gearchiveerd',
        archief_reden  : bezwaar || null,
        gearchiveerd_at: new Date().toISOString(),
      };
    }
    // klant_geworden, nog_onbekend en alles wat de tabel niet noemt.
    return null;
  }

  if (AFWEZIG_STATUSSEN.has(status)) {
    const afw = (afwezig && typeof afwezig === 'object') ? afwezig : {};
    const opgegeven = String(afw.reason_code || '').trim();
    const notitie = afw.note != null ? String(afw.note).slice(0, 500) : null;
    return {
      ...basis,
      reden     : status === 'no_show' ? 'no_show_event' : 'afgemeld',
      reden_code: AFWEZIG_REDENEN.has(opgegeven) ? opgegeven : 'onbekend',
      status    : 'open',
      due       : afw.follow_up_date || datumOverDagen(AFWEZIG_BELMOMENT_DAGEN[status] ?? 1),
      ...(notitie ? { notitie } : {}),
    };
  }

  return null;
}

export { opvolgingBadgeLabel, bouwOpvolgingTaak };
