// api/_lib/opvolging-agenda-doorsturen.js
//
// 'AGENDA DOORSTUREN' VERSTUURT ECHT — de beslissingen, puur en getest.
//
// Tot oktober 2026 was 'Agenda doorgestuurd' een vinkje: Dave stuurde de link
// zelf (of niet), en het systeem nam zijn woord aan. Nu verstuurt één klik een
// WhatsApp via de gekoppelde lijn (de brug, géén Meta-template) MÉT de
// agendalink. Pas als dat bericht echt vertrokken is gaat de kaart op
// wacht_inplanning en start de 48-uurklok.
//
// FAIL-CLOSED: zonder agendalink in app_settings 'opvolging_agenda_doorsturen'
// wordt er NIETS verstuurd en verandert er NIETS. Een bericht 'kies hier een
// moment' zonder link is erger dan geen bericht.

export const INSTELLING_KEY = 'opvolging_agenda_doorsturen';
/** Max één herinnering per zoveel uur per kaart. */
export const HERINNERING_MIN_UUR = 24;
/** Zo lang na het aanmaken van een kaart is NIET_TOEGESTAAN waarschijnlijk 'de brug kent het nummer nog niet'. */
export const BRUG_LEERT_MIN = 6;
export const BRUG_OPNIEUW_SEC = 20;
export const MAX_TEKST = 4000;

export const STANDAARD_BERICHT = 'Hey {voornaam}, zoals afgesproken: via deze link kies je zelf een moment voor ons gesprek dat jou past 👇\n\n{link}\n\nLukt het niet of vind je geen moment? Laat het me hier gewoon weten, dan zoeken we samen iets.\nGroetjes, Dave — De Forex Opleiding';
export const STANDAARD_HERINNERING = 'Hey {voornaam}, kleine reminder: je had nog geen moment gekozen voor ons gesprek. Hier is de link nog eens 👇\n\n{link}\n\nGroetjes, Dave';

/** De instelling in een vaste vorm. Een link telt alleen als hij met https:// begint. */
export function leesInstelling(value) {
  const v = value && typeof value === 'object' ? value : {};
  const link = typeof v.agenda_link === 'string' && /^https:\/\/\S+$/.test(v.agenda_link.trim())
    ? v.agenda_link.trim() : null;
  return {
    agenda_link: link,
    bericht    : typeof v.bericht === 'string' && v.bericht.trim() ? v.bericht : STANDAARD_BERICHT,
    herinnering: typeof v.herinnering === 'string' && v.herinnering.trim() ? v.herinnering : STANDAARD_HERINNERING,
    // Sinds PR 6: standaard via een goedgekeurde Meta-template op de lijn van
    // de afspraakberichten. 'brug' = de vrije tekst via whatsapp-web.js.
    kanaal     : v.kanaal === 'brug' ? 'brug' : 'meta',
    module     : typeof v.module === 'string' && v.module.trim() ? v.module.trim() : 'leadsonderhoud',
    phone_number_id: typeof v.phone_number_id === 'string' && /^\d{5,30}$/.test(v.phone_number_id.trim()) ? v.phone_number_id.trim() : null,
  };
}

/**
 * Valideer een nieuwe instelling (het beheerblok). Geeft een foutzin of null.
 * Regels: link begint met https://, en {link} staat in elke tekst.
 */
export function valideerInstelling({ agenda_link, bericht, herinnering, kanaal, module, phone_number_id }) {
  if (kanaal != null && kanaal !== 'meta' && kanaal !== 'brug') return 'Kanaal moet meta of brug zijn.';
  if (module != null && !/^[a-z0-9_-]{1,60}$/.test(String(module))) return 'Onbekende module.';
  if (phone_number_id && !/^\d{5,30}$/.test(String(phone_number_id).trim())) return 'phone_number_id bestaat alleen uit cijfers.';
  const link = String(agenda_link || '').trim();
  if (link && !/^https:\/\/\S+$/.test(link)) return 'De agendalink moet met https:// beginnen (en geen spaties bevatten).';
  for (const [naam, tekst] of [['Het bericht', bericht], ['De herinnering', herinnering]]) {
    const t = String(tekst || '');
    if (!t.trim()) return naam + ' is leeg.';
    if (!t.includes('{link}')) return naam + ' moet {link} bevatten — anders gaat er een bericht zonder link uit.';
    if (t.length > MAX_TEKST) return naam + ' is langer dan ' + MAX_TEKST + ' tekens.';
  }
  return null;
}

export function voornaamUit(naam) {
  const s = String(naam || '').trim();
  return s ? s.split(/\s+/)[0] : '';
}

/**
 * De tekst die echt verstuurd wordt.
 *
 * Een eigen tekst (bewerkt in het venster) wint van het sjabloon. Staat de link
 * er niet in — {link} weggehaald of de URL gewist — dan komt hij onderaan. Er
 * gaat dus NOOIT een doorstuurbericht zonder link de deur uit.
 */
export function bouwAgendaBericht({ sjabloon, tekst, naam, link }) {
  const basis = typeof tekst === 'string' && tekst.trim() ? tekst : String(sjabloon || '');
  const voornaam = voornaamUit(naam);
  let uit = basis
    .replace(/\{voornaam\}/g, voornaam)
    .replace(/\{link\}/g, link);
  // 'Hey ,' als er geen voornaam is.
  uit = uit.replace(/^(Hey|Hoi|Hallo|Dag)\s+,/i, '$1,');
  if (!uit.includes(link)) uit = uit.trimEnd() + '\n\n' + link;
  return uit.trim();
}

/**
 * Mag dit doorsturen nu?
 *
 * @param {object} p
 * @param {object} p.taak
 * @param {'eerste'|'herinnering'} p.soort
 * @param {object} p.instelling   leesInstelling()-uitvoer
 * @param {string|null} p.laatsteHerinnering ISO van de laatste agenda_herinnering-poging
 * @param {number} p.nuMs
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
 */
export function beslisDoorsturen({ taak, soort, instelling, laatsteHerinnering, nuMs }) {
  if (!instelling || !instelling.agenda_link) {
    return { ok: false, status: 409, code: 'GEEN_AGENDALINK', error: 'Agendalink nog niet ingesteld. Er is niets verstuurd.' };
  }
  if (!taak) return { ok: false, status: 404, code: 'GEEN_TAAK', error: 'Deze taak bestaat niet (meer).' };
  if (!taak.telefoon) return { ok: false, status: 400, code: 'GEEN_NUMMER', error: 'Deze kaart heeft geen telefoonnummer.' };
  const st = String(taak.status || '');
  if (soort === 'herinnering') {
    if (st !== 'wacht_inplanning') {
      return { ok: false, status: 409, code: 'NIET_WACHTEND', error: 'Een herinnering kan alleen als de agenda al doorgestuurd is en hij nog wacht.' };
    }
    const vorige = Date.parse(laatsteHerinnering || '');
    if (Number.isFinite(vorige) && nuMs - vorige < HERINNERING_MIN_UUR * 3600000) {
      const nogUur = Math.ceil((vorige + HERINNERING_MIN_UUR * 3600000 - nuMs) / 3600000);
      return { ok: false, status: 429, code: 'HERINNERING_TE_VROEG', error: 'Vandaag ging er al een herinnering. Volgende kan over ' + nogUur + ' uur.' };
    }
    return { ok: true };
  }
  if (st !== 'open') {
    return {
      ok: false, status: 409, code: 'STATUS',
      error: st === 'wacht_inplanning'
        ? 'De agenda is al doorgestuurd en de 48 uur lopen nog. Stuur eventueel een herinnering.'
        : 'Deze kaart staat niet meer open (' + st + ').',
    };
  }
  return { ok: true };
}

/** Een wa.me-link met de ingevulde tekst: de terugval als de brug niet kan. */
export function waMeLink(telefoon, tekst) {
  const c = String(telefoon || '').replace(/\D/g, '').replace(/^00/, '');
  if (!c) return null;
  return 'https://wa.me/' + c + '?text=' + encodeURIComponent(String(tekst || ''));
}

/**
 * Een brugfout naar een antwoord voor het scherm.
 *
 * NIET_TOEGESTAAN vlak na het aanmaken van een kaart is bijna altijd 'de brug
 * kent dit nummer nog niet' (hij ververst zijn leadlijst elke 5 minuten). Dat
 * wordt een 202 met BRUG_KENT_NUMMER_NOG_NIET: het scherm probeert zelf
 * opnieuw. Na 6 minuten is het een echte weigering.
 */
export function vertaalBrugFout(e, { taakAangemaaktMs, nuMs }) {
  if (e?.code === 'BRUG_FOUT' && e.status === 403) {
    const jong = Number.isFinite(taakAangemaaktMs) && nuMs - taakAangemaaktMs < BRUG_LEERT_MIN * 60000;
    if (jong) {
      return { status: 202, body: {
        code: 'BRUG_KENT_NUMMER_NOG_NIET', opnieuw_over_sec: BRUG_OPNIEUW_SEC,
        error: 'De WhatsApp-lijn leert dit nummer kennen…',
      } };
    }
    return { status: 403, body: { code: 'NIET_TOEGESTAAN', error: 'De WhatsApp-lijn weigert dit nummer (staat niet op de lijst van lopende kaarten).' } };
  }
  if (e?.code === 'BRUG_FOUT' && e.status === 503) {
    return { status: 503, body: { code: 'NIET_VERBONDEN', error: 'De WhatsApp-lijn is niet verbonden. Koppel hem opnieuw via het lampje rechtsboven in Vandaag.' } };
  }
  if (e?.code === 'BRUG_FOUT' && e.status === 400) {
    return { status: 400, body: { code: e.data?.code || 'NUMMER_ONGELDIG', error: e.message } };
  }
  if (e?.code === 'GEEN_CONFIG' || e?.code === 'ONBEREIKBAAR') {
    return { status: 503, body: { code: e.code, error: e.message } };
  }
  return { status: 502, body: { code: 'BRUG_FOUT', error: 'Versturen via de WhatsApp-lijn mislukte.' } };
}

// ═══════════════════════════════════════════════════════════════════════════
// LIVE WACHTEN — EEN AFSPRAAK BIJ GHL HERKENNEN
// ═══════════════════════════════════════════════════════════════════════════

const DOOD = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'invalid', 'deleted']);

/**
 * Een GHL-afspraak van dit contact die ná het doorsturen geboekt werd.
 * Alleen afspraken met een aanmaakmoment tellen: zonder dat weten we niet of
 * het een oude is, en een oude afspraak is geen bewijs dat hij nú koos.
 */
export function kiesGhlAfspraak(events, gestuurdIso) {
  const gestuurd = Date.parse(gestuurdIso || '');
  if (!Number.isFinite(gestuurd)) return null;
  const kandidaten = (Array.isArray(events) ? events : []).filter((e) => {
    if (!e || e.deleted === true) return false;
    const st = String(e.appointmentStatus || e.status || '').toLowerCase();
    if (DOOD.has(st)) return false;
    const gemaakt = Date.parse(e.dateAdded || e.createdAt || e.date_added || '');
    return Number.isFinite(gemaakt) && gemaakt >= gestuurd - 60000;
  });
  kandidaten.sort((a, b) => Date.parse(a.dateAdded || a.createdAt || '') - Date.parse(b.dateAdded || b.createdAt || ''));
  const e = kandidaten[0];
  if (!e) return null;
  return {
    ghl_appointment_id: e.id || null,
    scheduled_at: e.startTime ? new Date(e.startTime).toISOString() : null,
  };
}
