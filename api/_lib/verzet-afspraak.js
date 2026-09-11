// api/_lib/verzet-afspraak.js
//
// EEN CALL VERZETTEN — ÉÉN MOTOR, TWEE INGANGEN.
//
// ── WAT VERZETTEN IS, EN WAT HET NIET IS ────────────────────────────────
// Gemeten op 11 september stonden er twee verschillende vormen in de data:
//
//   sander De groot — dezelfde rij, `scheduled_at` overschreven. Geen spoor,
//     geen oude datum, en hij verdween stil uit de daglijst van de dag waarop
//     hij oorspronkelijk stond. Wie later vraagt 'wat stond er die dag?' krijgt
//     een antwoord dat niet klopt.
//   Yasmine — oude rij op `verplaatst`, nieuwe rij met `parent_appointment_id`.
//     Twee feiten, allebei bewaard: wat er die dag stond, en wat er nu staat.
//
// De tweede vorm is de goede, en dit bestand is de enige plek waar hij gemaakt
// wordt. api/follow-up-verplaats-call.js (de cockpit) en de POST op
// api/opvolging-agenda.js (het afrondvenster van Dave) roepen allebei
// `verzetAfspraak()` aan. Geen tweede administratie: dezelfde volgorde,
// dezelfde rollback, dezelfde audit-regel.
//
// ── DE VOLGORDE IS HET HELE PUNT ────────────────────────────────────────
// 1. GHL EERST, BLOKKEREND. De bestaande afspraak wordt daar VERZET, niet
//    geannuleerd-en-opnieuw-gemaakt: dan blijft er geen spookafspraak op het
//    oude uur in Daves agenda staan. Faalt GHL, dan gebeurt er hier niets —
//    validate-first, zoals de les van 20 mei voorschrijft.
// 2. Oude rij op 'verplaatst'. Dat moet VÓÓR de insert, want er ligt een
//    UNIQUE op ghl_appointment_id en de oude rij houdt die id als historisch
//    record.
// 3. Nieuwe rij met parent_appointment_id. Mislukt dat, dan gaat de oude rij
//    terug naar 'scheduled' — anders staat er een afspraak nergens meer.
// 4. Zoom en de bevestiging: best effort. Die mogen een geslaagde verzetting
//    niet ongedaan maken.
//
// ── WAT ER MET OPZET NIET GEBEURT ───────────────────────────────────────
// Geen `uitkomst` op de oude rij, geen no-show, geen werklijstkaart. Een
// verzette afspraak wordt NOOIT beoordeeld: hij is niet gemist, hij is
// verplaatst. Zet je er 'no_show' op, dan leest het dagrapport dat als
// nalatigheid van Dave terwijl de lead zelf belde om te verzetten.

import { updateZoomMeetingTime } from './zoom-meeting.js';
import { updateGhlAppointmentTime } from './ghl-appointment.js';
import { stuurVerzetBericht } from './afspraak-status-notify.js';

/** Standaardduur van een zoomcall, gelijk aan de rest van de module. */
export const VERZET_DUUR_MIN = 30;

/**
 * Een fout met een code die de aanroeper naar HTTP kan vertalen.
 * Codes: GHL_UPDATE (met ghlStatus/ghlBody) · PARENT_UPDATE · CHILD_INSERT.
 */
function fout(code, bericht, extra) {
  const e = new Error(bericht);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/**
 * VERZET EEN AFSPRAAK NAAR EEN NIEUW MOMENT.
 *
 * @param {object}  o
 * @param {object}  o.supabaseAdmin   service-role client
 * @param {object}  o.afspraak        de volledige oude rij uit follow_up_appointments
 * @param {string}  o.nieuwStartIso   het nieuwe moment, als UTC-ISO
 * @param {number} [o.duurMinuten]    duur van de nieuwe afspraak
 * @param {?string}[o.doorUserId]     wie het deed, voor de audit-regel
 * @param {string} [o.bron]           'manual' (cockpit) of 'opvolging-afronden'
 * @returns {Promise<{nieuweAfspraak:object, ghlBijgewerkt:boolean, zoomBijgewerkt:boolean}>}
 */
export async function verzetAfspraak({
  supabaseAdmin,
  afspraak,
  nieuwStartIso,
  duurMinuten = VERZET_DUUR_MIN,
  doorUserId = null,
  bron = 'manual',
}) {
  if (!supabaseAdmin) throw fout('ARG', 'supabaseAdmin ontbreekt');
  if (!afspraak || !afspraak.id) throw fout('ARG', 'afspraak ontbreekt');
  const startMs = Date.parse(nieuwStartIso);
  if (!Number.isFinite(startMs)) throw fout('ARG', 'nieuwStartIso is geen geldig moment');

  const startIso = new Date(startMs).toISOString();
  const eindIso  = new Date(startMs + duurMinuten * 60 * 1000).toISOString();

  // ── 1 · GHL, BLOKKEREND ────────────────────────────────────────────────
  // De BESTAANDE afspraak verzetten. Niet annuleren + opnieuw boeken: dan
  // blijft er een doorgehaalde of — erger — een gewone afspraak op het oude
  // uur staan, en die belt Dave straks aan.
  let ghlBijgewerkt = false;
  if (afspraak.ghl_appointment_id) {
    try {
      await updateGhlAppointmentTime(afspraak.ghl_appointment_id, startIso, eindIso);
      ghlBijgewerkt = true;
    } catch (e) {
      console.error('[verzet-afspraak] GHL update faalde:', e?.message, e);
      throw fout('GHL_UPDATE', e?.message || 'GHL-fout', {
        ghlStatus: e?.ghlStatus || 500,
        ghlBody  : e?.ghlBody || '',
      });
    }
  }

  // ── 2 · OUDE RIJ OP 'verplaatst' ───────────────────────────────────────
  // Eerst, zodat ghl_appointment_id vrijkomt vóór de child-insert (UNIQUE).
  {
    const { error } = await supabaseAdmin
      .from('follow_up_appointments')
      .update({ status: 'verplaatst' })
      .eq('id', afspraak.id);
    if (error) {
      console.error('[verzet-afspraak] parent-update faalde:', error.message);
      throw fout('PARENT_UPDATE', error.message);
    }
  }

  // ── 3 · NIEUWE RIJ ─────────────────────────────────────────────────────
  // ghl_appointment_id blijft NULL: de parent houdt 'm als historisch record
  // en de UNIQUE staat er maar één toe.
  const { data: nieuweAfspraak, error: insertErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .insert({
      ghl_appointment_id : null,
      zoom_meeting_id    : afspraak.zoom_meeting_id,
      zoom_join_url      : afspraak.zoom_join_url,
      lead_name          : afspraak.lead_name,
      lead_email         : afspraak.lead_email,
      lead_phone         : afspraak.lead_phone,
      lead_ghl_contact_id: afspraak.lead_ghl_contact_id,
      scheduled_at       : startIso,
      duration_minutes   : duurMinuten,
      status             : 'scheduled',
      voicememo_status   : 'pending',
      owner_id           : afspraak.owner_id,
      parent_appointment_id: afspraak.id,
      // Agenda-herkomst overnemen: reminders en de verzet-bevestiging zijn
      // gescoped op ghl_calendar_id NOT NULL.
      ghl_calendar_id    : afspraak.ghl_calendar_id || null,
      // De proefvlag reist mee. Een testafspraak die na het verzetten als
      // echte afspraak terugkomt staat morgen in Daves lijst en in het
      // rapport — precies de rommel die een test moet vermijden.
      ...(afspraak.is_test === true ? { is_test: true } : {}),
    })
    .select()
    .single();

  if (insertErr) {
    // De oude rij terug, anders staat de afspraak nergens meer.
    console.error('[verzet-afspraak] child-insert faalde:', insertErr.message);
    await supabaseAdmin
      .from('follow_up_appointments')
      .update({ status: 'scheduled' })
      .eq('id', afspraak.id);
    throw fout('CHILD_INSERT', insertErr.message);
  }

  // ── 4 · ZOOM — BEST EFFORT ─────────────────────────────────────────────
  let zoomBijgewerkt = false;
  if (afspraak.zoom_meeting_id) {
    try {
      await updateZoomMeetingTime(afspraak.zoom_meeting_id, startIso, duurMinuten);
      zoomBijgewerkt = true;
    } catch (e) {
      // Niet terugdraaien: de DB-mutaties zijn geslaagd en de afspraak staat.
      console.error('[verzet-afspraak] Zoom update faalde:', e?.message, e);
    }
  }

  // ── AUDIT — fail-soft, maar nooit stil ─────────────────────────────────
  try {
    const { error } = await supabaseAdmin.from('follow_up_events_log').insert({
      appointment_id: nieuweAfspraak.id,
      event_type    : 'call_verplaatst',
      source        : bron,
      payload       : {
        from_appointment_id: afspraak.id,
        from_datetime      : afspraak.scheduled_at,
        to_datetime        : startIso,
        zoom_updated       : zoomBijgewerkt,
        ghl_updated        : ghlBijgewerkt,
        changed_by         : doorUserId,
      },
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[verzet-afspraak] audit (soft):', e?.message || e);
  }

  // Bevestiging naar de lead — achter de live-vlag, gescoped op
  // ghl_calendar_id. Nooit blokkerend.
  try { await stuurVerzetBericht(nieuweAfspraak.id); } catch (_) { /* nooit blokkerend */ }

  return { nieuweAfspraak, ghlBijgewerkt, zoomBijgewerkt };
}

/** GHL-fouten in taal waar de persoon achter het scherm iets aan heeft. */
export function mapGhlError(status, body) {
  const t = String(body || '');
  if (status === 400) {
    if (t.includes('slot') || t.includes('available')) {
      return 'Slot niet beschikbaar in Dave\'s GHL-kalender (mogelijk weekend, buiten werktijd, of conflict)';
    }
    return `Ongeldige aanvraag bij GHL: ${t.slice(0, 120)}`;
  }
  if (status === 401) return 'Geen GHL-toegang (token-issue) — neem contact op met beheerder';
  if (status === 404) return 'Afspraak bestaat niet meer in GHL';
  if (status >= 500) return 'GHL is tijdelijk niet beschikbaar — probeer het over enkele minuten opnieuw';
  return `GHL-fout ${status}: ${t.slice(0, 120)}`;
}

/**
 * DE STATUSSEN WAARIN VERZETTEN NOG ZIN HEEFT.
 *
 * Een rij die al 'verplaatst' is heeft elders een opvolger; hem nóg eens
 * verzetten maakt een tweede keten en laat de eerste zwevend achter. Een
 * geannuleerde rij hoort opnieuw ingepland te worden via de werklijst, niet
 * hier — daar hangt de kaart aan.
 */
export const VERZETBARE_STATUSSEN = new Set(['scheduled', 'in_progress', 'no_show', 'noshow', 'completed']);

/**
 * Mag deze afspraak verzet worden?
 *
 * @returns {?string} de reden waarom niet, of null als het mag.
 */
export function verzetBlokkade(afspraak) {
  if (!afspraak) return 'Deze afspraak bestaat niet (meer).';
  const s = String(afspraak.status || '').toLowerCase();
  if (s === 'verplaatst') {
    return 'Deze afspraak is al verzet. De nieuwe afspraak staat op zijn eigen dag; verzet die.';
  }
  if (s === 'cancelled' || s === 'verwijderd') {
    return 'Deze afspraak is geannuleerd. Plan hem opnieuw in vanuit je werklijst, dan blijft de kaart kloppen.';
  }
  if (!VERZETBARE_STATUSSEN.has(s)) {
    return `Deze afspraak staat op '${s}' en is van hieruit niet te verzetten.`;
  }
  return null;
}
