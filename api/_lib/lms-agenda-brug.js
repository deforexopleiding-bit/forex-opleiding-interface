// api/_lib/lms-agenda-brug.js
//
// Agendabrug CRM ↔ LMS (dfo-lms). Het LMS toont in de mentoragenda de
// GEPUBLICEERDE events uit het CRM en laat de hoofdmentor/admin mentoren aan
// een event koppelen. `event_mentors` blijft de ENE waarheid (was_present en
// de eventbonus hangen eraan) — het LMS houdt geen eigen kopie bij.
//
// Alle logica zit hier met een geïnjecteerde db-client, zodat het los te
// testen is. De route (api/lms-agenda-events.js) doet alleen auth + HTTP.
//
// Regel die overal geldt: een mislukte bevraging GOOIT. Een lege lijst
// betekent altijd "er is niets", nooit "het lukte niet".
//
// Contract voor de LMS-kant: docs/lms-agenda-brug.md.

import crypto from 'node:crypto';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MAX_VENSTER_DAGEN = 200;
const DAG_MS = 24 * 60 * 60 * 1000;

/** Fout met een contract-code + HTTP-status; de route vertaalt 'm 1-op-1. */
export class BrugFout extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Normaliseert een e-mailadres (trim + lowercase); ongeldig → null. */
export function normaliseerEmail(v) {
  const mail = String(v ?? '').trim().toLowerCase();
  return EMAIL_RE.test(mail) ? mail : null;
}

/**
 * Vergelijkt het aangeboden geheim met het verwachte in constante tijd.
 * Via sha256 eerst, zodat beide buffers even lang zijn (timingSafeEqual gooit
 * anders) en de lengte van het geheim niet uitlekt. Leeg verwacht = dicht.
 */
export function geheimKlopt(aangeboden, verwacht) {
  if (typeof verwacht !== 'string' || verwacht.length === 0) return false;
  if (typeof aangeboden !== 'string' || aangeboden.length === 0) return false;
  const a = crypto.createHash('sha256').update(aangeboden, 'utf8').digest();
  const b = crypto.createHash('sha256').update(verwacht, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Leest ?van=&tot= uit de query. Gooit BrugFout bij ongeldig/omgekeerd
 * (ongeldig_venster) of een venster > MAX_VENSTER_DAGEN (venster_te_groot).
 */
export function leesVenster(q = {}) {
  const vanMs = Date.parse(String(q.van ?? ''));
  const totMs = Date.parse(String(q.tot ?? ''));
  if (!Number.isFinite(vanMs) || !Number.isFinite(totMs) || totMs <= vanMs) {
    throw new BrugFout(400, 'ongeldig_venster',
      'Geef een geldig venster op: van en tot als ISO-datum, met tot na van.');
  }
  if (totMs - vanMs > MAX_VENSTER_DAGEN * DAG_MS) {
    throw new BrugFout(400, 'venster_te_groot',
      `Het venster mag maximaal ${MAX_VENSTER_DAGEN} dagen beslaan.`);
  }
  return { van: new Date(vanMs).toISOString(), tot: new Date(totMs).toISOString() };
}

/** Actieve mentoren (team_members type 'mentor'); gooit bij een fout. */
async function haalActieveMentoren(db) {
  const { data, error } = await db
    .from('team_members')
    .select('id, name, email, user_id, type, is_active')
    .eq('type', 'mentor')
    .eq('is_active', true);
  if (error) throw new Error('team_members: ' + error.message);
  return (data || []).filter((r) => r?.type === 'mentor' && r?.is_active === true);
}

/**
 * Gepubliceerde events in [van, tot) met hun bezetting, plus de mentoren die
 * het LMS in de kiezer mag tonen.
 */
export async function haalAgendaEvents(db, { van, tot }) {
  const { data: events, error: evErr } = await db
    .from('events')
    .select('id, title, starts_at, ends_at, location, capacity, niveau, signups_closed, status')
    .eq('status', 'published')
    .gte('starts_at', van)
    .lt('starts_at', tot)
    .order('starts_at', { ascending: true });
  if (evErr) throw new Error('events: ' + evErr.message);

  const lijst = events || [];
  const bezettingPerEvent = new Map();

  if (lijst.length > 0) {
    const { data: rijen, error: emErr } = await db
      .from('event_mentors')
      .select('event_id, team_member_id, was_present, team_members:team_member_id ( id, name, email )')
      .in('event_id', lijst.map((e) => e.id));
    if (emErr) throw new Error('event_mentors: ' + emErr.message);

    for (const r of rijen || []) {
      const tm = r.team_members || {};
      const rij = {
        team_member_id: r.team_member_id,
        naam:           tm.name ?? null,
        email:          tm.email ? String(tm.email).trim().toLowerCase() : null,
        was_aanwezig:   r.was_present === true,
      };
      if (!bezettingPerEvent.has(r.event_id)) bezettingPerEvent.set(r.event_id, []);
      bezettingPerEvent.get(r.event_id).push(rij);
    }
  }

  const mentoren = (await haalActieveMentoren(db))
    .map((m) => ({ team_member_id: m.id, naam: m.name ?? null, email: normaliseerEmail(m.email) }))
    .filter((m) => m.email !== null);

  return {
    events: lijst.map((e) => ({
      id:                 e.id,
      titel:              e.title,
      start:              e.starts_at,
      eind:               e.ends_at ?? null,
      locatie:            e.location ?? null,
      capaciteit:         e.capacity ?? null,
      niveau:             e.niveau ?? null,
      aanmeldingen_dicht: e.signups_closed === true,
      crm_pad:            '/modules/events-detail.html?id=' + e.id,
      bezetting:          bezettingPerEvent.get(e.id) || [],
    })),
    mentoren,
  };
}

/**
 * Voegt een mentor toe aan of verwijdert 'm van een gepubliceerd event.
 * Returnt { status, code, message, data }; gooit BrugFout bij een
 * contractfout en Error bij een mislukte bevraging.
 *
 * `notify` = createNotification (api/_lib/notify.js), geïnjecteerd.
 */
export async function wijzigBezetting(db, body, { notify } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const actie = b.actie;
  const eventId = typeof b.event_id === 'string' ? b.event_id.trim() : '';
  const mentorEmail = normaliseerEmail(b.mentor_email);

  if (actie !== 'toevoegen' && actie !== 'verwijderen') {
    throw new BrugFout(400, 'ongeldig_verzoek', "actie moet 'toevoegen' of 'verwijderen' zijn.");
  }
  if (!UUID_RE.test(eventId)) {
    throw new BrugFout(400, 'ongeldig_verzoek', 'event_id moet een geldige uuid zijn.');
  }
  if (!mentorEmail) {
    throw new BrugFout(400, 'ongeldig_verzoek', 'mentor_email moet een geldig e-mailadres zijn.');
  }
  const doorNaam = b.door && typeof b.door.naam === 'string' && b.door.naam.trim()
    ? b.door.naam.trim().slice(0, 200)
    : null;

  // 1) Event: bestaat en is gepubliceerd.
  const { data: ev, error: evErr } = await db
    .from('events')
    .select('id, title, status')
    .eq('id', eventId)
    .maybeSingle();
  if (evErr) throw new Error('events: ' + evErr.message);
  if (!ev) throw new BrugFout(404, 'event_onbekend', 'Dit event bestaat niet in het CRM.');
  if (ev.status !== 'published') {
    throw new BrugFout(409, 'event_niet_gepubliceerd',
      'Dit event is niet gepubliceerd; de bezetting is alleen via de LMS-agenda te wijzigen bij gepubliceerde events.');
  }

  // 2) Mentor: exacte vergelijking in JS, bewust GEEN .ilike() — `_` is een
  //    LIKE-joker én een geldig e-mailteken (zie vindDfoLmsMentorId).
  const treffers = (await haalActieveMentoren(db))
    .filter((m) => String(m?.email || '').trim().toLowerCase() === mentorEmail);
  if (treffers.length === 0) {
    throw new BrugFout(404, 'mentor_onbekend', 'Er is geen actieve mentor met dit e-mailadres in het CRM.');
  }
  if (treffers.length > 1) {
    throw new BrugFout(409, 'mentor_dubbel',
      'Meerdere actieve mentoren hebben dit e-mailadres; los dit eerst op in het CRM.');
  }
  const mentor = treffers[0];
  const data = { event_id: eventId, team_member_id: mentor.id };

  if (actie === 'toevoegen') {
    const { error } = await db
      .from('event_mentors')
      .insert({ event_id: eventId, team_member_id: mentor.id, added_by_user_id: null });
    if (error) {
      if (error.code === '23505') {
        return { status: 200, code: 'stond_er_al', message: 'Deze mentor stond al op dit event.', data };
      }
      throw new Error('event_mentors insert: ' + error.message);
    }

    // Fail-soft: een mislukte melding breekt de koppeling nooit.
    if (typeof notify === 'function' && mentor.user_id) {
      try {
        const via = 'via de LMS-agenda' + (doorNaam ? ' door ' + doorNaam : '');
        await notify({
          toUserId:   mentor.user_id,
          type:       'event.mentor_assigned',
          title:      'Je bent gekoppeld aan een event',
          body:       (ev.title ? ev.title + ' — ' : '') + via,
          linkUrl:    '/modules/events-detail.html?id=' + eventId,
          entityType: 'event',
          entityId:   eventId,
          createdBy:  null,
        });
      } catch (e) {
        console.warn('[lms-agenda-brug] melding mislukt:', e?.message);
      }
    }
    return { status: 201, code: 'toegevoegd', message: 'Mentor is aan het event gekoppeld.', data };
  }

  // verwijderen
  const { data: koppeling, error: kErr } = await db
    .from('event_mentors')
    .select('event_id, team_member_id, was_present')
    .eq('event_id', eventId)
    .eq('team_member_id', mentor.id)
    .maybeSingle();
  if (kErr) throw new Error('event_mentors: ' + kErr.message);
  if (!koppeling) {
    return { status: 200, code: 'stond_er_niet', message: 'Deze mentor stond niet op dit event.', data };
  }
  if (koppeling.was_present === true) {
    throw new BrugFout(409, 'was_aanwezig_blijft',
      'Deze mentor is als aanwezig geregistreerd en kan alleen in het CRM van het event gehaald worden.');
  }

  const { error: delErr } = await db
    .from('event_mentors')
    .delete()
    .eq('event_id', eventId)
    .eq('team_member_id', mentor.id);
  if (delErr) throw new Error('event_mentors delete: ' + delErr.message);

  return { status: 200, code: 'verwijderd', message: 'Mentor is van het event gehaald.', data };
}
