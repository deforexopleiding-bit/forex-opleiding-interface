// api/_lib/setter-calls.js
//
// ROMY'S CALLS — de pure kern achter api/setter-calls.js (geen databank).
//
// Een setter wil zien wat er van haar geboekte calls geworden is: welke komen
// nog, en hoe zijn de afgelopen afgelopen. Drie regels die hier vastliggen:
//
// 1. WELKE CALLS. Rijen met setter_user_id = de setter, plus opvolgers van
//    haar boekingen die (van vóór 1 oktober 2026) zelf geen setter dragen. Die
//    tweede groep lossen we op met setterUitKeten (api/_lib/setter-keten.js),
//    dezelfde regel die de backfill gebruikt: een rij is van haar als de
//    dichtstbijzijnde rij in de keten mét setter háár setter draagt. Een
//    opvolger die expliciet een ándere setter heeft is dus niet van haar.
//    Testrijen (is_test) tellen nergens mee.
//
// 2. WAT IS ERVAN GEWORDEN. Uitsluitend via categorieVoorAfspraak
//    (api/_lib/call-uitkomst-categorie.js). Geen eigen vertaaltabel, geen
//    eigen labels: wat hier 'Opvolgen / bedenktijd' heet, heet in het rapport
//    hetzelfde.
//
// 3. VANAF WANNEER TELT HET. call_rapportage_startdatum
//    (api/_lib/call-rapportage-start.js). Een afgelopen call van vóór die dag
//    zonder uitkomst is geen achterstand van de closer — die uitkomst-knoppen
//    bestonden toen nog niet. Zulke calls blijven zichtbaar (haar enige sale
//    kan daar staan), maar in een eigen lijst 'eerder', zonder categorie-
//    oordeel 'Nog niet vastgelegd' en buiten de tellingen.
//
// WAT DE SETTER NIET ZIET: snelle_notitie. Dat is de werkaantekening van de
// closer (financiële situatie, privé-omstandigheden van de lead, interne
// afspraken) en de uitkomstmotor schrijft er zijn eigen regels in. Voor de
// setter is de categorie het antwoord op "hoe ging mijn call"; de notitie zou
// meer over de lead prijsgeven dan zij nodig heeft. Het endpoint selecteert
// de kolom niet eens. Ook e-mail en telefoon van de lead gaan niet mee naar het
// scherm: ze zijn alleen nodig om een sale aan een deal te koppelen.

import {
  CATEGORIEEN,
  categorieVoorAfspraak,
  categorieInfo,
} from './call-uitkomst-categorie.js';
import { setterUitKeten } from './setter-keten.js';
import { isUitgeslotenDeal, quotationStatus } from './setter-sale-plan.js';

const NL_TZ = 'Europe/Amsterdam';
const SPELING_MIN = 15;
const STANDAARD_DUUR_MIN = 30;

export const TOELICHTING_NIET_VASTGELEGD = 'Uitkomst nog niet vastgelegd door de closer';
export const TOELICHTING_VOOR_START = 'Geen uitkomst vastgelegd (van vóór de start van de call-rapportage)';

const _fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: NL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Amsterdam-datum en -tijd van een tijdstip; null bij een ongeldig tijdstip. */
export function nlDatumTijd(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const p = {};
  for (const x of _fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { datum: `${p.year}-${p.month}-${p.day}`, tijd: `${p.hour}:${p.minute}` };
}

/** Laatste 9 cijfers van een telefoonnummer; null als er te weinig cijfers zijn. */
export function telefoon9(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-9) : null;
}

const mailNorm = (v) => String(v || '').trim().toLowerCase();

/**
 * Welke rijen zijn van deze setter? Gebruikt setterUitKeten op een kaart van
 * alle meegegeven rijen (haar eigen rijen + de opgehaalde opvolgers).
 * Testrijen vallen eruit.
 */
export function rijenVanSetter(rijen, setterId) {
  const lijst = Array.isArray(rijen) ? rijen : [];
  const perId = new Map(lijst.map((r) => [String(r.id), r]));
  const uit = [];
  const gezien = new Set();
  for (const r of lijst) {
    if (!r || r.is_test === true) continue;
    const id = String(r.id);
    if (gezien.has(id)) continue;
    const hit = setterUitKeten(r, perId);
    if (!hit || hit.setter_user_id !== setterId) continue;
    gezien.add(id);
    uit.push(r);
  }
  return uit;
}

/**
 * Koppel een sale-call aan een deal van de setter. Zelfde sleutel als de
 * setter-attributie in api/sales-deal-create.js: e-mail (hoofdletterongevoelig),
 * anders de laatste 9 cijfers van het telefoonnummer. Alleen deals die in het
 * setter-overzicht meetellen (niet gearchiveerd, niet afgewezen). Meerdere
 * treffers: de deal die het dichtst bij het call-moment is aangemaakt.
 *
 * @param {object} appt  rij met lead_email, lead_phone, scheduled_at
 * @param {Array<{deal:object, klant:?object}>} dealsMetKlant
 * @returns {?object} de deal, of null
 */
export function matchSaleDeal(appt, dealsMetKlant) {
  if (!appt) return null;
  const mail = mailNorm(appt.lead_email);
  const tel = telefoon9(appt.lead_phone);
  if (!mail && !tel) return null;
  const callMs = Date.parse(appt.scheduled_at);
  let beste = null;
  let besteAfstand = Infinity;
  for (const x of (Array.isArray(dealsMetKlant) ? dealsMetKlant : [])) {
    const deal = x && x.deal;
    if (!deal || isUitgeslotenDeal(deal)) continue;
    const k = x.klant || {};
    const viaMail = mail && mailNorm(k.email) === mail;
    const viaTel = tel && telefoon9(k.phone) === tel;
    if (!viaMail && !viaTel) continue;
    const dealMs = Date.parse(deal.created_at);
    const afstand = Number.isFinite(callMs) && Number.isFinite(dealMs) ? Math.abs(dealMs - callMs) : Infinity;
    if (!beste || afstand < besteAfstand) { beste = deal; besteAfstand = afstand; }
  }
  return beste;
}

/** Is de call nog niet voorbij (zelfde klok als afspraakStaat: start + duur + 15 min)? */
export function isKomend(appt, nuMs) {
  const start = Date.parse(appt && appt.scheduled_at);
  if (!Number.isFinite(start)) return false;
  const duur = Number.isFinite(appt.duration_minutes) && appt.duration_minutes > 0
    ? appt.duration_minutes : STANDAARD_DUUR_MIN;
  return nuMs < start + (duur + SPELING_MIN) * 60000;
}

/**
 * Eén regel voor het scherm.
 *
 * @param {object} appt
 * @param {{nuMs:number, heeftOpvolger:boolean, startdatum:string,
 *          dealsMetKlant:Array<{deal:object, klant:?object}>}} o
 */
export function bouwCallRegel(appt, o) {
  const nuMs = o.nuMs;
  const nl = nlDatumTijd(appt.scheduled_at);
  const komend = isKomend(appt, nuMs);
  // Een call zonder geldig tijdstip kan niet aan een dag gekoppeld worden; die
  // telt mee (liever zichtbaar als 'Onbekend' dan stil weg).
  const meetellen = !nl || nl.datum >= o.startdatum;

  let key = categorieVoorAfspraak(appt, { nuMs, heeftOpvolger: o.heeftOpvolger === true });
  let toelichting = null;
  if (key === 'nog_niet_vastgelegd') {
    if (meetellen) {
      toelichting = TOELICHTING_NIET_VASTGELEGD;
    } else {
      // Geen oordeel over calls van vóór de startdatum.
      key = null;
      toelichting = TOELICHTING_VOOR_START;
    }
  }
  const info = key ? categorieInfo(key) : null;

  let sale = null;
  if (key === 'sale') {
    const d = matchSaleDeal(appt, o.dealsMetKlant);
    if (d) {
      const q = quotationStatus(d);
      sale = {
        gekoppeld: true,
        deal_id: d.id,
        bedrag: Math.round((Number(d.total_amount) || 0) * 100) / 100,
        offerte_status: q.key,
        offerte_status_label: q.label,
        in_afwachting: q.pending,
      };
    } else {
      sale = { gekoppeld: false };
    }
  }

  return {
    id: appt.id,
    lead_name: appt.lead_name || null,
    scheduled_at: appt.scheduled_at || null,
    datum_nl: nl ? nl.datum : null,
    tijd_nl: nl ? nl.tijd : null,
    status: appt.status || null,
    uitkomst: appt.uitkomst || null,
    categorie: info ? { key: info.key, label: info.label, kleur: info.kleur } : null,
    toelichting,
    heeft_opvolger: o.heeftOpvolger === true,
    via_keten: !appt.setter_user_id,
    komend,
    meetellen,
    sale,
  };
}

/**
 * Het hele overzicht.
 *
 * @param {object} p
 * @param {object[]} p.rijen         haar rijen + opgehaalde opvolgers (+ is_test-rijen mogen erin)
 * @param {string}   p.setterId
 * @param {Array<{deal:object, klant:?object}>} p.dealsMetKlant
 * @param {number}   p.nuMs
 * @param {string}   p.startdatum    'YYYY-MM-DD' (Amsterdam)
 */
export function bouwCallsOverzicht({ rijen, setterId, dealsMetKlant, nuMs, startdatum }) {
  const eigen = rijenVanSetter(rijen, setterId);
  // Een rij heeft een opvolger als een andere rij hem als ouder noemt. De
  // handler haalt alle opvolgers van haar rijen op, dus dit is volledig.
  const metOpvolger = new Set();
  for (const r of (Array.isArray(rijen) ? rijen : [])) {
    if (r && r.parent_appointment_id) metOpvolger.add(String(r.parent_appointment_id));
  }

  const komend = [];
  const gedaan = [];
  const eerder = [];
  const aantal = {};
  for (const c of CATEGORIEEN) aantal[c.key] = 0;

  for (const r of eigen) {
    const regel = bouwCallRegel(r, {
      nuMs,
      heeftOpvolger: metOpvolger.has(String(r.id)),
      startdatum,
      dealsMetKlant,
    });
    if (regel.komend) komend.push(regel);
    else if (regel.meetellen) gedaan.push(regel);
    else eerder.push(regel);
    if (regel.meetellen && regel.categorie) aantal[regel.categorie.key] += 1;
  }

  const opTijd = (a, b) => String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || ''));
  komend.sort(opTijd);                       // eerstvolgende bovenaan
  gedaan.sort((a, b) => opTijd(b, a));       // meest recente bovenaan
  eerder.sort((a, b) => opTijd(b, a));

  const per_categorie = CATEGORIEEN.map((c) => ({
    key: c.key, label: c.label, kleur: c.kleur, aantal: aantal[c.key],
  }));
  const totaal = per_categorie.reduce((s, c) => s + c.aantal, 0);

  return {
    startdatum,
    telling: { totaal, per_categorie },
    komend,
    gedaan,
    eerder,
  };
}
