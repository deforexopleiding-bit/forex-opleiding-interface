// api/lab-sessie.js
//
// De strategiesessie boeken vanuit de trial-omgeving van het LMS, zonder dat
// de lead iets opnieuw typt. De lead is al ingelogd in het LMS; zijn sessie
// gaat als bearer mee en wordt bij het LMS-project zelf gecontroleerd
// (lmsGebruikerUitToken). Naam, e-mail en gsm komen uit zijn lab-lead-rij.
//
//   GET  /api/lab-sessie   → vrije momenten (14 dagen), echte telling voor deze
//                            week, en de boeking als die er al is (met de
//                            verzetlink `verzet_url` voor de sessiebalk).
//   POST /api/lab-sessie   { moment: ISO } → boekt in dezelfde agenda als de
//                            kennismakingsgesprekken, met bron 'the-lab'.
//
// De sessie is met de GASTHEER (_lib/lab-gastheer.js — Dave). Elk antwoord
// draagt `gastheer: { voornaam, naam, foto_url, initialen }` (of null) voor de
// boekingskaart; bij een boeking wordt hij eigenaar van de afspraak.
//
// TESTLEADS (is_test: de testleads én de "Lab-lead (test)"-accounts van de
// admins) boeken via exact dezelfde weg — zelfde momenten, zelfde controle —
// maar het CRM maakt er een TEST-afspraak van (is_test = true): GEEN afspraak
// in Daves GHL-agenda, geen Zoom, geen bevestigingen of herinneringen (die
// vragen een ghl_calendar_id), geen interne melding en geen Meta-event. Zo
// stoort een test Dave nooit. Zie boekTestAfspraak().
//
// BEDANKPAGINA (2026-10-20): de Lab-funnels op deforexopleiding.nl boeken hier
// ook, zonder LMS-sessie, met het boektoken uit /api/lab-aanmelding
// (`Authorization: LabBoek <token>`, zie _lib/lab-boektoken.js). Het token wijst
// naar één aanmelding; heeft die een lab-lead (gewoonlijk), dan is het verder
// exact dit pad. Zonder lab-lead (bestaande student, of het LMS was even weg)
// boeken we voor de persoon van de aanmelding, zonder LMS-vinkje.
//
// Schaarste wordt NOOIT verzonnen: `deze_week` is het werkelijke aantal vrije
// momenten tot en met zondag, uit dezelfde agenda waaruit geboekt wordt.

import { supabaseAdmin } from './supabase.js';
import { applyLabCors, labPreflight } from './_lib/lab-cors.js';
import { lmsGebruikerUitToken, leesLabLeadOpId, noteerBoeking, LabAccountFout } from './_lib/dfo-lms-lab-account.js';
import { leesBoektoken, boektokenUitHeader } from './_lib/lab-boektoken.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { LAB_WEEKQUOTUM, telPerWeek, pasQuotumToe, weekVan } from './_lib/lab-weekquotum.js';
import { fetchGhlSlots, normaliseer, amsMidnightMs, amsPartsOf } from './public-opstartsessie-free-slots.js';
import { createAppointmentForLead } from './_lib/create-appointment-from-lead.js';
import { LAB_SLUG } from './_lib/lab-config.js';
import { stuurLabEvent, labEventId, labUserData } from './_lib/lab-meta.js';
import { leesLabGastheer } from './_lib/lab-gastheer.js';
import { selfServiceUrl } from './_lib/afspraak-berichten.js';
import { normaliseerNlBe } from './_lib/phone-e164.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';

const VENSTER_DAGEN = 14;
const DUUR_MIN = 30;

/** Slots → lijst ISO-momenten in de toekomst (min. 2 uur vooruit). PURE. */
export function momentenUitSlots(slots, nu = Date.now()) {
  const uit = [];
  for (const dag of slots || []) {
    for (const t of dag.times || []) {
      const [h, m] = String(t).split(':').map(Number);
      const ms = amsMidnightMs(dag.date) + (h * 60 + m) * 60000;
      if (ms >= nu + 2 * 3600 * 1000) uit.push(new Date(ms).toISOString());
    }
  }
  return uit.sort();
}

/** Hoeveel momenten vallen er nog in deze week (t/m zondag, Amsterdam). PURE. */
export function aantalDezeWeek(momenten, nu = Date.now()) {
  const vandaag = amsPartsOf(nu).date;
  const dow = new Date(vandaag + 'T12:00:00Z').getUTCDay(); // 0 = zondag
  const totZondag = dow === 0 ? 0 : 7 - dow;
  const einde = amsMidnightMs(vandaag) + (totZondag + 1) * 86400000;
  return momenten.filter((iso) => Date.parse(iso) < einde).length;
}

async function vrijeMomenten() {
  const calendarId = process.env.GHL_CALENDAR_ID;
  const token = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!calendarId || !token) return { ok: false, momenten: [] };
  const vandaag = amsPartsOf(Date.now()).date;
  const startMs = amsMidnightMs(vandaag);
  const endMs = startMs + VENSTER_DAGEN * 86400000 - 1;
  const raw = await fetchGhlSlots({ calendarId, token, startMs, endMs });
  return { ok: true, momenten: momentenUitSlots(normaliseer(raw)) };
}

const GEANNULEERD = new Set(['cancelled', 'canceled', 'geannuleerd']);

/**
 * De geboekte afspraak in het CRM: de verzetlink (selfservice) en het actuele
 * moment — verzette de lead via die link, dan klopt het moment in het LMS niet
 * meer. Fail-soft: zonder afspraak-id of bij een leesfout blijft het zoals het was.
 */
export async function geboektMetVerzet(geboekt, afspraakId) {
  if (!geboekt || !afspraakId) return geboekt;
  try {
    const { data, error } = await supabaseAdmin.from('follow_up_appointments')
      .select('id, scheduled_at, status, afspraak_token').eq('id', afspraakId).maybeSingle();
    if (error) { console.warn('[lab-sessie] afspraak lezen (soft):', error.message); return geboekt; }
    if (!data || GEANNULEERD.has(String(data.status || '').toLowerCase())) return geboekt;
    return {
      ...geboekt,
      moment: data.scheduled_at ? new Date(data.scheduled_at).toISOString() : geboekt.moment,
      verzet_url: data.afspraak_token ? selfServiceUrl(data.afspraak_token) : null,
    };
  } catch (e) {
    console.warn('[lab-sessie] afspraak lezen (soft):', e?.message || e);
    return geboekt;
  }
}

/**
 * De TEST-afspraak van een testlead: alleen een rij in follow_up_appointments
 * met is_test = true (uit Daves agenda- en opvolgweergaven gefilterd). Geen
 * CRM-lead, geen GHL, geen Zoom.
 *
 * `lead_ghl_contact_id` is in de databank VERPLICHT (NOT NULL, geen default) —
 * zonder die kolom gaf elke test-boeking een 500 (19 okt). Een testlead heeft
 * geen GHL-contact, dus staat er een herkenbare plaatshouder
 * `test-lab:<lab-lead-id>`: hij lijkt op geen enkel GHL-id (20 tekens,
 * alfanumeriek) en matcht dus nooit een echt contact.
 */
export function testContactId(labLeadId) {
  return `test-lab:${labLeadId}`;
}

export async function boekTestAfspraak({ lab, iso, eigenaarId }) {
  const { data, error } = await supabaseAdmin.from('follow_up_appointments').insert({
    lead_name: `TEST · ${lab.voornaam || 'lab-lead'}`,
    lead_email: lab.email,
    lead_phone: null,
    lead_ghl_contact_id: testContactId(lab.id),
    scheduled_at: iso,
    duration_minutes: DUUR_MIN,
    status: 'scheduled',
    voicememo_status: 'skipped',
    owner_id: eigenaarId || null,
    booking_source: LAB_SLUG,
    is_test: true,
  }).select('id').single();
  if (error) throw new Error('test-afspraak: ' + error.message);
  return { appointment_id: data.id, zoom_join_url: null };
}

function bearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

async function crmLead(labLead) {
  if (labLead.crm_lead_id) {
    const { data, error } = await supabaseAdmin.from('leads')
      .select('id, voornaam, achternaam, email, telefoon, telefoon_e164, customer_id, source_ref')
      .eq('id', labLead.crm_lead_id).maybeSingle();
    if (error) console.warn('[lab-sessie] lead lezen (soft):', error.message);
    if (data) return data;
  }
  // Geen (of verdwenen) CRM-lead: alsnog aanmaken uit de lab-lead-rij.
  const { data, error } = await supabaseAdmin.rpc('upsert_lead', { p: {
    voornaam: labLead.voornaam, achternaam: labLead.achternaam, email: labLead.email,
    telefoon: labLead.telefoon, telefoon_e164: labLead.telefoon,
    bron: LAB_SLUG, soort: LAB_SLUG, traject: LAB_SLUG,
  } });
  if (error) throw new Error('upsert_lead: ' + error.message);
  const rij = Array.isArray(data) ? data[0] : data;
  return { id: rij?.id, voornaam: labLead.voornaam, achternaam: labLead.achternaam, email: labLead.email, telefoon: labLead.telefoon, customer_id: null, source_ref: null };
}

/**
 * De "lab" achter een boektoken van de bedankpagina. Met lab-lead: die rij
 * (zelfde vorm als via de LMS-sessie). Zonder: een rij uit de aanmelding zelf
 * (id null → geen LMS-vinkje). Null = token wijst nergens naar.
 */
export async function labUitBoektoken(aanmeldingId) {
  const { data: a, error } = await supabaseAdmin.from('lab_aanmeldingen')
    .select('id, lead_id, email, voornaam, achternaam, telefoon_e164, lms_lead_id, is_test')
    .eq('id', aanmeldingId).maybeSingle();
  if (error) throw new Error('aanmelding lezen: ' + error.message);
  if (!a) return null;
  const labLead = a.lms_lead_id ? await leesLabLeadOpId(a.lms_lead_id) : null;
  if (labLead) return { ...labLead, is_test: labLead.is_test === true || a.is_test === true };
  return {
    id: null, aanmelding_id: a.id, email: a.email, voornaam: a.voornaam, achternaam: a.achternaam,
    telefoon: a.telefoon_e164, crm_lead_id: a.lead_id, is_test: a.is_test === true,
    sessie_moment: null, sessie_afspraak_id: null,
  };
}

/**
 * Echte Lab-sessies per week rond deze momenten (voor het weekquotum van de
 * bedankpagina, _lib/lab-weekquotum.js). Bij een leesfout: null → de aanroeper
 * weigert liever dan het quotum te negeren.
 */
async function labSessiesPerWeek(vanMs, totMs) {
  const { data, error } = await supabaseAdmin.from('follow_up_appointments')
    .select('scheduled_at, status, is_test, booking_source').eq('booking_source', LAB_SLUG)
    .gte('scheduled_at', new Date(vanMs).toISOString()).lt('scheduled_at', new Date(totMs).toISOString()).limit(1000);
  if (error) { console.error('[lab-sessie] weekquotum lezen:', error.message); return null; }
  return telPerWeek(data || []);
}

/** Een al geboekte Lab-sessie in het CRM (komende, niet geannuleerd) voor dit adres. */
async function geboektInCrm(email) {
  if (!email) return null;
  const { data, error } = await supabaseAdmin.from('follow_up_appointments')
    .select('id, scheduled_at, status').eq('booking_source', LAB_SLUG).ilike('lead_email', email)
    .gte('scheduled_at', new Date(Date.now() - 3600 * 1000).toISOString()).order('scheduled_at', { ascending: true }).limit(5);
  if (error) { console.warn('[lab-sessie] eigen boeking zoeken (soft):', error.message); return null; }
  const a = (data || []).find((x) => !GEANNULEERD.has(String(x.status || '').toLowerCase()));
  return a ? { moment: new Date(a.scheduled_at).toISOString(), afspraak_id: a.id } : null;
}

/**
 * Met welke gegevens we boeken — wat de lead al gaf bij zijn aanmelding. Het
 * boekscherm toont dit als "Boeken als …" zodat hij niets opnieuw typt. PURE.
 */
export function contactVan(lab) {
  return {
    voornaam: (lab?.voornaam || '').trim() || null,
    email: (lab?.email || '').trim() || null,
    telefoon: (lab?.telefoon || '').trim() || null,
  };
}

/**
 * Een gewijzigde voornaam of gsm uit het boekscherm ("wijzig", of een veld dat
 * ontbrak). Alleen deze twee: het e-mailadres is de login en verandert hier niet.
 * Het nummer volgt dezelfde regel als de aanmelding (NL/BE → E.164). PURE.
 */
export function leesContactWijziging(body) {
  const c = body && typeof body.contact === 'object' && body.contact ? body.contact : null;
  if (!c) return { ok: true, contact: {} };
  const uit = {};
  if (c.voornaam != null) {
    const v = String(c.voornaam).trim().slice(0, 60);
    if (!v) return { ok: false, code: 'voornaam_leeg', veld: 'voornaam' };
    uit.voornaam = v;
  }
  if (c.telefoon != null) {
    const tel = normaliseerNlBe(String(c.telefoon).slice(0, 40));
    if (!tel.e164) return { ok: false, code: 'telefoon_ongeldig', veld: 'telefoon' };
    uit.telefoon = tel.e164;
  }
  return { ok: true, contact: uit };
}

/** De gewijzigde gegevens ook bewaren, zodat ze de volgende keer kloppen. Fail-soft. */
async function bewaarContact(lab, lead, wijz) {
  if (!wijz.voornaam && !wijz.telefoon) return;
  if (lab?.id) {
    try {
      const lms = getDfoLmsClient();
      const patch = {};
      if (wijz.voornaam && wijz.voornaam !== lab.voornaam) patch.voornaam = wijz.voornaam;
      if (wijz.telefoon && wijz.telefoon !== lab.telefoon) patch.telefoon = wijz.telefoon;
      if (lms && Object.keys(patch).length) {
        const { error } = await lms.from('hlms_lab_lead').update(patch).eq('id', lab.id);
        if (error) console.warn('[lab-sessie] contact in LMS bewaren (soft):', error.message);
      }
    } catch (e) {
      console.warn('[lab-sessie] contact in LMS bewaren (soft):', e?.message || e);
    }
  }
  if (lead?.id) {
    const patch = {};
    if (wijz.voornaam && wijz.voornaam !== lead.voornaam) patch.voornaam = wijz.voornaam;
    if (wijz.telefoon && wijz.telefoon !== (lead.telefoon_e164 || lead.telefoon)) { patch.telefoon = wijz.telefoon; patch.telefoon_e164 = wijz.telefoon; }
    if (Object.keys(patch).length) {
      const { error } = await supabaseAdmin.from('leads').update(patch).eq('id', lead.id);
      if (error) console.warn('[lab-sessie] contact op de lead bewaren (soft):', error.message);
    }
  }
}

export default async function handler(req, res) {
  applyLabCors(req, res, 'GET, POST, OPTIONS');
  if (labPreflight(req, res, ['GET', 'POST'])) return;

  let lab;
  let funnel = null;
  const boektoken = boektokenUitHeader(req);
  if (boektoken) {
    // Bedankpagina van de Lab-funnels.
    const { limited } = await checkRateLimit({ req, bucket: 'lab-sessie-boektoken', maxHits: 30, withinSeconds: 600 });
    if (limited) return res.status(429).json({ ok: false, code: 'te_veel' });
    const t = leesBoektoken(boektoken);
    if (!t.ok) return res.status(401).json({ ok: false, code: 'token_ongeldig' });
    funnel = t.funnel;
    try {
      lab = await labUitBoektoken(t.aanmeldingId);
    } catch (e) {
      console.error('[lab-sessie] boektoken → aanmelding:', e?.message || e);
      return res.status(503).json({ ok: false, code: 'lms_onbereikbaar' });
    }
    if (!lab) return res.status(401).json({ ok: false, code: 'token_ongeldig' });
  } else {
    let wie;
    try {
      wie = await lmsGebruikerUitToken(bearer(req));
    } catch (e) {
      console.error('[lab-sessie] LMS-sessie controleren:', e?.message || e);
      return res.status(503).json({ ok: false, code: 'lms_onbereikbaar' });
    }
    if (!wie) return res.status(401).json({ ok: false, code: 'geen_sessie' });
    if (!wie.labLead) return res.status(403).json({ ok: false, code: 'geen_lab_lead' });
    lab = wie.labLead;
  }

  let geboekt = lab.sessie_moment && Date.parse(lab.sessie_moment) > Date.now() - 3600 * 1000
    ? { moment: lab.sessie_moment } : null;
  // Via de bedankpagina: ook een boeking die (nog) niet in het LMS staat telt.
  if (!geboekt && boektoken && lab.is_test !== true) {
    const crm = await geboektInCrm(lab.email);
    if (crm) geboekt = { moment: crm.moment };
  }

  const gastheer = await leesLabGastheer();
  const zichtbaar = gastheer
    ? { voornaam: gastheer.voornaam, naam: gastheer.naam, foto_url: gastheer.foto_url, initialen: gastheer.initialen }
    : null;

  if (req.method === 'GET') {
    if (geboekt) {
      // Een TEST-afspraak heeft geen GHL-afspraak achter zich: de verzetpagina
      // zou die proberen te verzetten. Daarom geen verzetlink voor testleads.
      const g = lab.is_test === true ? geboekt : await geboektMetVerzet(geboekt, lab.sessie_afspraak_id);
      return res.status(200).json({ ok: true, geboekt: g, verzet_url: g.verzet_url || null, momenten: [], deze_week: null, gastheer: zichtbaar, ik: contactVan(lab) });
    }
    try {
      const v = await vrijeMomenten();
      if (!v.ok) return res.status(200).json({ ok: true, geboekt: null, momenten: [], deze_week: null, onbeschikbaar: true, gastheer: zichtbaar, ik: contactVan(lab) });
      if (boektoken) {
        // Bedankpagina: weekquotum (max. LAB_WEEKQUOTUM per kalenderweek).
        const nu = Date.now();
        const perWeek = await labSessiesPerWeek(nu - 8 * 86400000, nu + 22 * 86400000);
        if (!perWeek) return res.status(200).json({ ok: true, geboekt: null, momenten: [], deze_week: null, onbeschikbaar: true, gastheer: zichtbaar, ik: contactVan(lab) });
        const q = pasQuotumToe(v.momenten, perWeek, nu);
        return res.status(200).json({ ok: true, geboekt: null, momenten: q.momenten, deze_week: aantalDezeWeek(q.momenten), quotum: q.quotum, gastheer: zichtbaar, ik: contactVan(lab) });
      }
      return res.status(200).json({ ok: true, geboekt: null, momenten: v.momenten, deze_week: aantalDezeWeek(v.momenten), gastheer: zichtbaar, ik: contactVan(lab) });
    } catch (e) {
      console.error('[lab-sessie] slots ophalen:', e?.message || e);
      return res.status(200).json({ ok: true, geboekt: null, momenten: [], deze_week: null, onbeschikbaar: true, gastheer: zichtbaar, ik: contactVan(lab) });
    }
  }

  // POST — boeken
  if (geboekt) return res.status(409).json({ ok: false, code: 'al_geboekt', geboekt });
  const moment = String(req.body?.moment || '');
  const ms = Date.parse(moment);
  if (!Number.isFinite(ms)) return res.status(400).json({ ok: false, code: 'ongeldig_moment' });
  const wijz = leesContactWijziging(req.body);
  if (!wijz.ok) return res.status(400).json({ ok: false, code: wijz.code, veld: wijz.veld });
  // Met de gewijzigde gegevens boeken (voornaam/gsm), de rest zoals bekend.
  const labOud = lab;
  lab = { ...lab, ...wijz.contact };

  // Het moment moet NU nog vrij zijn, in dezelfde agenda.
  let vrij;
  try { vrij = await vrijeMomenten(); } catch (e) {
    console.error('[lab-sessie] slots (boeken):', e?.message || e);
    return res.status(503).json({ ok: false, code: 'agenda_onbereikbaar' });
  }
  if (!vrij.ok) return res.status(503).json({ ok: false, code: 'agenda_onbereikbaar' });
  const iso = new Date(ms).toISOString();
  if (!vrij.momenten.includes(iso)) return res.status(409).json({ ok: false, code: 'moment_weg' });

  // Bedankpagina: de week van dit moment mag niet vol zijn.
  if (boektoken) {
    const w = weekVan(ms);
    const perWeek = await labSessiesPerWeek(ms - 8 * 86400000, ms + 8 * 86400000);
    if (!perWeek) return res.status(503).json({ ok: false, code: 'agenda_onbereikbaar' });
    if ((perWeek.get(w) || 0) >= LAB_WEEKQUOTUM) return res.status(409).json({ ok: false, code: 'week_vol' });
  }

  if (lab.is_test === true) {
    let test;
    try { test = await boekTestAfspraak({ lab: { ...lab, id: lab.id || `a-${lab.aanmelding_id}` }, iso, eigenaarId: gastheer?.id || null }); } catch (e) {
      console.error('[lab-sessie] test-afspraak:', e?.message || e);
      return res.status(500).json({ ok: false, code: 'boeken_mislukt' });
    }
    if (lab.id) {
      try {
        await noteerBoeking(lab.id, { moment: iso, afspraakId: test.appointment_id });
      } catch (e) {
        console.error('[lab-sessie] test-boeking noteren in LMS:', e instanceof LabAccountFout ? e.message : e);
      }
    }
    await bewaarContact(labOud, null, wijz.contact);
    return res.status(200).json({ ok: true, geboekt: { moment: iso }, afspraak_id: test.appointment_id, zoom_join_url: null, gastheer: zichtbaar, test: true });
  }

  let lead;
  try { lead = await crmLead(lab); } catch (e) {
    console.error('[lab-sessie] lead:', e?.message || e);
    return res.status(500).json({ ok: false, code: 'lead_fout' });
  }
  if (!lead?.id) return res.status(500).json({ ok: false, code: 'lead_fout' });
  const leadOud = lead;
  if (wijz.contact.voornaam) lead = { ...lead, voornaam: wijz.contact.voornaam };
  if (wijz.contact.telefoon) lead = { ...lead, telefoon: wijz.contact.telefoon, telefoon_e164: wijz.contact.telefoon };

  let afspraak;
  try {
    afspraak = await createAppointmentForLead({
      lead: {
        ...lead,
        lead_name: [lead.voornaam, lead.achternaam].filter(Boolean).join(' ') || lead.voornaam,
        lead_email: lead.email,
        lead_phone: lead.telefoon_e164 || lead.telefoon,
        // De gastheer is de eigenaar van het gesprek (niet de setter).
        owner_id: gastheer?.id || null,
      },
      scheduledAt: iso, durationMinutes: DUUR_MIN, source: LAB_SLUG,
      // In Daves agenda (GHL/Google) meteen herkenbaar.
      ghlTitel: `The Lab · strategiesessie · ${[lead.voornaam, lead.achternaam].filter(Boolean).join(' ') || lab.voornaam || 'lead'}`,
    });
  } catch (e) {
    console.error('[lab-sessie] boeken mislukt', { code: e?.code, fout: e?.message });
    return res.status(502).json({ ok: false, code: 'boeken_mislukt' });
  }

  if (lab.id) {
    try {
      await noteerBoeking(lab.id, { moment: iso, afspraakId: afspraak.appointment_id });
    } catch (e) {
      // De afspraak staat in de agenda; enkel het vinkje in het LMS ontbreekt.
      console.error('[lab-sessie] boeking noteren in LMS:', e instanceof LabAccountFout ? e.message : e);
    }
  }

  await bewaarContact(labOud, leadOud, wijz.contact);

  await stuurLabEvent({
    eventName: 'Schedule', eventId: labEventId('Schedule', afspraak.appointment_id),
    userData: labUserData({ email: lab.email, telefoonE164: lab.telefoon, voornaam: lab.voornaam, achternaam: lab.achternaam, externalId: lead.id }),
    ...(funnel ? { customData: { content_name: 'Lab-strategiesessie', content_category: LAB_SLUG, funnel } } : {}),
  });

  return res.status(200).json({ ok: true, geboekt: { moment: iso }, afspraak_id: afspraak.appointment_id, zoom_join_url: afspraak.zoom_join_url || null, gastheer: zichtbaar });
}
