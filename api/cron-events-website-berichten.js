// api/cron-events-website-berichten.js
//
// FUNNEL-EIGEN, GEÏSOLEERDE cron voor onze eigen event-aanmelders
// (created_via='website'). Volledig los van cron-events-automations /
// event_automations / de automation-engine / automation_enabled. Stuurt mail +
// WhatsApp met dezelfde cadence als het bestaande systeem, maar UITSLUITEND voor
// website-attendees en met dubbel-preventie via de logtabel
// event_website_berichten.
//
// Berichttypes (allemaal created_via='website' AND is_test=false):
//   vervolg_2u    — nog GEEN PLEK, 2–24u na aanmelding  → herinnering /vervolg
//   vervolg_24u   — nog GEEN PLEK, >=24u na aanmelding   → herinnering /vervolg
//   warmup        — HEEFT EEN PLEK, event over 24–120u   → warmup
//   reminder_24u  — HEEFT EEN PLEK, event over 1–24u     → reminder 24u
//   reminder_1u   — HEEFT EEN PLEK, event binnen 1u      → reminder laatste uren
//
// "HEEFT EEN PLEK" volgt sinds 15 sep 2026 de regel uit isPlekBezet: vragenlijst
// ingevuld OF belstatus bevestigd. Twee kanten op:
//   · De twee vervolg-herinneringen ("je plek is nog niet definitief") gaan NIET
//     meer naar wie telefonisch bevestigd is — die plek staat wél vast.
//   · De drie praktische berichten (warmup + de twee reminders) gaan nu ook naar
//     wie zijn plek via de bel heeft. Die komt immers gewoon; hem niet
//     herinneren aan tijd en locatie was het echte verlies.
//
// (De bevestiging bij Definitief wordt direct in event-vervolg-finalize
//  verstuurd, niet hier.)
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth). Schedule: */10 * * * *.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { applyPlekBezetFilter, PLEK_BEZET_CALL_STATUS } from './_lib/event-registration.js';
import {
  SOORTEN, reedsVerstuurd, markeerVerstuurd, stuurWaEnMail, kiesVervolgTemplate, vervolgLink,
} from './_lib/event-website-berichten.js';
import {
  vervolgHerinneringMail, warmupMail, reminder24uMail, reminder1uMail, datumNL, tijdNL,
} from './_lib/event-website-teksten.js';

const SELECT = `
  id, event_id, first_name, last_name, email, phone, choice_token, customer_id,
  registered_at, assessment_response_id, status, call_status,
  events!event_attendees_event_id_fkey!inner(id, title, starts_at, ends_at, location)
`;

// "Nog geen plek via de belstatus" als PostgREST-filter. NULL-veilig: een kaal
// `not.ilike` zou elke rij met een lege call_status wegfilteren (NOT NULL is
// NULL, dus niet waar) — en dat zijn juist de meeste rijen.
const GEEN_PLEK_VIA_BELSTATUS = `call_status.is.null,call_status.not.ilike.${PLEK_BEZET_CALL_STATUS}`;

function baseQuery() {
  // GEDEELDE harde eis: alleen onze eigen funnel-aanmelders, geen testrijen.
  return supabaseAdmin.from('event_attendees').select(SELECT).eq('created_via', 'website').eq('is_test', false).limit(200);
}

// Verwerk één batch: per rij dubbel-check → verstuur → markeer. Per-rij
// try/catch zodat één fout de rest niet blokkeert.
async function verwerk(soort, rows, bouwBericht) {
  let verstuurd = 0, overgeslagen = 0, mislukt = 0;
  for (const row of rows || []) {
    const event = row.events || null;
    if (!event) { overgeslagen++; continue; }
    const attendee = row; // heeft id/event_id/first_name/email/phone/choice_token/...
    try {
      if (await reedsVerstuurd(attendee.id, soort)) { overgeslagen++; continue; }
      const b = bouwBericht(attendee, event);
      const r = await stuurWaEnMail({ attendee, event, waTemplate: b.waTemplate, waMappingOverride: b.waMapping, mail: b.mail, soort });
      if (r.ok) { await markeerVerstuurd(attendee.id, attendee.event_id, soort, 'mail+whatsapp'); verstuurd++; }
      else { mislukt++; }
    } catch (e) {
      mislukt++;
      console.error(`[cron-events-website-berichten] ${soort} rij ${attendee.id}:`, e?.message || e);
    }
  }
  return { verstuurd, overgeslagen, mislukt, kandidaten: (rows || []).length };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const now = new Date();
  const ms = now.getTime();
  const nowIso = now.toISOString();
  const cutoff2h = new Date(ms - 2 * 3_600_000).toISOString();
  const cutoff24h = new Date(ms - 24 * 3_600_000).toISOString();
  const plus1h = new Date(ms + 1 * 3_600_000).toISOString();
  const plus24h = new Date(ms + 24 * 3_600_000).toISOString();
  const plus120h = new Date(ms + 120 * 3_600_000).toISOString();

  const summary = { ok: true, at: nowIso, per_soort: {} };

  try {
    // Vervolg-template (dynamisch: event_vervolg_herinnering zodra APPROVED,
    // anders event_vragenlijst_definitief).
    const vervolg = await kiesVervolgTemplate();
    const bouwVervolg = (a, e) => ({
      waTemplate: vervolg.template,
      waMapping: vervolg.mapping,
      mail: vervolgHerinneringMail({ voornaam: a.first_name, titel: e.title, vervolgLink: vervolgLink(a.choice_token) }),
    });

    // 1) vervolg_2u — nog geen plek, 2–24u na aanmelding, event nog komend.
    {
      const { data, error } = await baseQuery()
        .is('assessment_response_id', null).eq('status', 'aangemeld')
        .or(GEEN_PLEK_VIA_BELSTATUS)
        .lte('registered_at', cutoff2h).gt('registered_at', cutoff24h)
        .gt('events.starts_at', nowIso);
      if (error) throw new Error('vervolg_2u select: ' + error.message);
      summary.per_soort.vervolg_2u = await verwerk(SOORTEN.VERVOLG_2U, data, bouwVervolg);
    }

    // 2) vervolg_24u — nog geen plek, >=24u na aanmelding, event nog komend.
    {
      const { data, error } = await baseQuery()
        .is('assessment_response_id', null).eq('status', 'aangemeld')
        .or(GEEN_PLEK_VIA_BELSTATUS)
        .lte('registered_at', cutoff24h)
        .gt('events.starts_at', nowIso);
      if (error) throw new Error('vervolg_24u select: ' + error.message);
      summary.per_soort.vervolg_24u = await verwerk(SOORTEN.VERVOLG_24U, data, bouwVervolg);
    }

    // 3) warmup — heeft een plek, event over 24–120u.
    {
      const { data, error } = await applyPlekBezetFilter(baseQuery())
        .gt('events.starts_at', plus24h).lte('events.starts_at', plus120h);
      if (error) throw new Error('warmup select: ' + error.message);
      summary.per_soort.warmup = await verwerk(SOORTEN.WARMUP, data, (a, e) => ({
        waTemplate: 'warmup', waMapping: { body: { 1: 'attendee.voornaam', 2: 'event.titel' } },
        mail: warmupMail({ voornaam: a.first_name, titel: e.title }),
      }));
    }

    // 4) reminder_24u — heeft een plek, event over 1–24u.
    {
      const { data, error } = await applyPlekBezetFilter(baseQuery())
        .gt('events.starts_at', plus1h).lte('events.starts_at', plus24h);
      if (error) throw new Error('reminder_24u select: ' + error.message);
      summary.per_soort.reminder_24u = await verwerk(SOORTEN.REMINDER_24U, data, (a, e) => ({
        waTemplate: 'reminder_24u_pdf', waMapping: { body: { 1: 'attendee.voornaam', 2: 'event.titel', 3: 'event.starttijd' } },
        mail: reminder24uMail({ voornaam: a.first_name, titel: e.title, datum: datumNL(e.starts_at), starttijd: tijdNL(e.starts_at), locatie: e.location || '' }),
      }));
    }

    // 5) reminder_1u — heeft een plek, event binnen 1u.
    {
      const { data, error } = await applyPlekBezetFilter(baseQuery())
        .gt('events.starts_at', nowIso).lte('events.starts_at', plus1h);
      if (error) throw new Error('reminder_1u select: ' + error.message);
      summary.per_soort.reminder_1u = await verwerk(SOORTEN.REMINDER_1U, data, (a, e) => ({
        waTemplate: 'reminder_2u_correct', waMapping: { body: { 1: 'attendee.voornaam', 2: 'event.titel', 3: 'event.starttijd' } },
        mail: reminder1uMail({ voornaam: a.first_name, titel: e.title, starttijd: tijdNL(e.starts_at), locatie: e.location || '' }),
      }));
    }

    return res.status(200).json(summary);
  } catch (e) {
    console.error('[cron-events-website-berichten]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'cron failed', per_soort: summary.per_soort });
  }
}
