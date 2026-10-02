// api/_lib/opvolging-leads-pot.js
//
// 'LEADS BELLEN' — DE POT, DE WARMTESCORE EN DE POTTEN VAN DE KAARTEN.
//
// Dave (sales) heeft trage momenten. Daarin belt hij proefleads van de
// minicursus en de 7-daagse — twee verschillende producten — met één doel: een
// Zoom-call laten inplannen. Alles wat hier staat is PUUR (geen databank), zodat
// elke beslissing in een test staat: wie komt in de pot, wie niet en waarom, hoe
// warm iemand is, en in welke pot een kaart hoort.
//
// ── DE POT IS GEEN TABEL ────────────────────────────────────────────────────
// De lijst nieuwe leads wordt BEREKEND uit leads (+ trial_warmte, lms_gebruikers,
// follow_up_appointments en opvolging_taken). Een kaart in opvolging_taken
// ontstaat pas zodra Dave iets met een lead doet. Zo blijft de privacylijst van
// de WhatsApp-brug klein: die kent alleen nummers met een kaart.
//
// ── NOOIT STIL FILTEREN ─────────────────────────────────────────────────────
// Elke lead die niet getoond wordt, wordt geteld met de reden erbij. Het scherm
// zegt dan 'x niet getoond omdat …' in plaats van een kortere lijst die er
// volledig uitziet.

import { normaliseerNummer } from './whatsapp-brug-nummers.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTEN
// ═══════════════════════════════════════════════════════════════════════════

/** Hoe oud een aanmelding mag zijn om nog in de pot te komen. */
export const POT_MAX_DAGEN = 60;
/** Een afspraak telt nog als 'komend' tot zo lang na de start. */
export const KOMEND_SPELING_UUR = 2;
/** Ingepland: zo ver terug tonen. */
export const INGEPLAND_DAGEN = 30;
/** Afgerond: zo ver terug tonen. */
export const AFGEROND_DAGEN = 60;

export const TRAJECTEN = ['minicursus', '7-daagse'];
export const BRON_RE = /^(kennismakingscursus|7-daagse)/i;

/** De volgorde van de potten op het scherm — ook de volgorde voor 'eerste pot met inhoud'. */
export const POTTEN = ['terugbellen', 'verlopen', 'bezig', 'nieuw', 'wacht', 'later', 'ingepland', 'afgerond'];

export const REDEN_CODE_TERUGBELLEN = 'terugbellen';
export const REDEN_CODE_VERLOPEN = 'inplantermijn_verlopen';

/** Waarom een lead niet in de pot 'nieuw' staat. Volgorde = volgorde van toetsen. */
export const UITSLUITREDENEN = Object.freeze({
  geen_telefoon: 'geen telefoonnummer',
  al_klant     : 'is al klant',
  weggegooid   : 'eerder afgerond (komt niet terug)',
  eigen_kaart  : 'staat al in een andere pot',
  komende_call : 'heeft een geplande call',
  call_uitkomst: 'had al een call met uitkomst (zit in je gewone flow)',
  op_daglijst  : 'staat al op je daglijst',
});

// Warmtegrenzen.
export const LABEL_HEET = 60;
export const LABEL_WARM = 35;
export const LABEL_LAUW = 15;

const DAG_MS = 86400000;
const ZONE = 'Europe/Amsterdam';

// ═══════════════════════════════════════════════════════════════════════════
// KLEINE HULPEN
// ═══════════════════════════════════════════════════════════════════════════

/** De Amsterdamse kalenderdag van een moment, als YYYY-MM-DD. */
export function dagInZone(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** Hele kalenderdagen tussen twee YYYY-MM-DD's (b − a). */
export function dagenTussen(a, b) {
  const x = Date.parse(String(a).slice(0, 10) + 'T12:00:00Z');
  const y = Date.parse(String(b).slice(0, 10) + 'T12:00:00Z');
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return Math.round((y - x) / DAG_MS);
}

/** De laatste negen cijfers van een nummer, of null. */
export function staart9(raw) {
  const c = normaliseerNummer(raw);
  return c && c.length >= 9 ? c.slice(-9) : null;
}

const laag = (s) => String(s == null ? '' : s).trim().toLowerCase();

const getal = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ═══════════════════════════════════════════════════════════════════════════
// PRODUCT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Welk product, en welke variant.
 *
 * Minicursus (bron kennismakingscursus-v1..v4) en 7-daagse (bron 7-daagse-v1/v2/
 * website) zijn twee verschillende producten — Dave moet dat aan de lijn weten.
 */
export function productVan(lead) {
  const traject = laag(lead && lead.traject);
  const bron = laag(lead && lead.bron);
  let product = null;
  if (traject === 'minicursus' || bron.startsWith('kennismakingscursus')) product = 'Minicursus';
  else if (traject === '7-daagse' || bron.startsWith('7-daagse')) product = '7-daagse';
  const m = bron.match(/^(?:kennismakingscursus|7-daagse)-(.+)$/);
  const variant = m ? m[1] : null;
  return { product, variant, label: product ? product + (variant ? ' · ' + variant : '') : null };
}

/** Hoort deze lead (op traject of bron) bij de proefleads van Leads bellen? */
export function isProefLead(lead) {
  if (!lead) return false;
  if (TRAJECTEN.includes(laag(lead.traject))) return true;
  return BRON_RE.test(String(lead.bron || ''));
}

// GEEN TESTFILTER OP LEADS. De tabel heeft geen is_test-kolom (gemeten door
// Cowork, 2 okt), en raden op naam of e-mail gooit echte mensen weg. Testrijen
// bestaan wél op follow_up_appointments (is_test) — die tellen hieronder niet
// mee als eerdere call.

export function naamVan(lead) {
  // leads heeft geen kolom naam: voornaam + achternaam. `naam` blijft als
  // terugval voor rijen van elders (een kaart, een opgeladen lijst).
  const vol = [lead && lead.voornaam, lead && lead.achternaam].filter(Boolean).join(' ').trim();
  return vol || String(lead && lead.naam || '').trim() || '(zonder naam)';
}

export function voornaamVan(naam) {
  const s = String(naam || '').trim();
  return s ? s.split(/\s+/)[0] : '';
}

export function telefoonVan(lead) {
  return String((lead && (lead.telefoon_e164 || lead.telefoon)) || '').trim() || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TRIAL (LMS-gedrag)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Een trial_warmte-rij in een vaste vorm.
 *
 * Kolommen van de view (gemeten door Cowork, 2 okt): gebruiker_id, lead_id,
 * email, toegang_van, toegang_tot, dag, dagen_over, verlopen, lessen_gezien,
 * sessies_gezien, trades, ooit_ingelogd, laatst_actief, score (0–~45), …
 * `dagen_totaal` staat er niet in; dat is de looptijd van het product
 * (minicursus 30 dagen, 7-daagse 7) en wordt in proefDuur() bepaald.
 */
export function normaliseerTrial(r) {
  if (!r) return null;
  const van = r.toegang_van ? String(r.toegang_van).slice(0, 10) : null;
  const tot = r.toegang_tot ? String(r.toegang_tot).slice(0, 10) : null;
  const totaal = van && tot ? dagenTussen(van, tot) : null;
  return {
    score         : getal(r.score),
    toegang_tot   : tot,
    toegang_van   : van,
    verlopen      : r.verlopen === true,
    dagen_over    : getal(r.dagen_over),
    dag           : getal(r.dag),
    dagen_totaal  : totaal != null && totaal > 0 ? totaal : null,
    lessen        : getal(r.lessen_gezien),
    sessies       : getal(r.sessies_gezien),
    trades        : getal(r.trades),
    laatst_actief : r.laatst_actief || null,
    ooit_ingelogd : typeof r.ooit_ingelogd === 'boolean' ? r.ooit_ingelogd : null,
  };
}

/** De looptijd van een proef: uit de trial zelf, anders uit het product. */
export function proefDuur(trial, product) {
  if (trial && trial.dagen_totaal) return trial.dagen_totaal;
  if (product === 'Minicursus') return 30;
  if (product === '7-daagse') return 7;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// EERDERE CALLS
// ═══════════════════════════════════════════════════════════════════════════

const KOMEND_STATUSSEN = new Set(['scheduled', 'in_progress']);
const GEANNULEERD = new Set(['cancelled', 'canceled', 'geannuleerd']);
const NO_SHOW = new Set(['no_show', 'noshow']);

/** Hoort deze afspraak bij deze lead? Laatste 9 cijfers of exact e-mail. */
export function afspraakHoortBij({ staart, email }, a) {
  if (!a) return false;
  const aStaart = staart9(a.lead_phone);
  if (staart && aStaart && staart === aStaart) return true;
  const m = laag(email);
  return !!m && m === laag(a.lead_email);
}

/**
 * Wat de eerdere calls van een lead zeggen.
 *
 *   komend      — een geplande call die nog moet komen (of < 2u geleden begon)
 *   met_uitkomst — een call met een vastgelegde uitkomst of status completed
 *   annuleerde / no_show — tags; zulke leads blijven WEL in de pot
 */
export function beoordeelCalls(afspraken, nuMs) {
  const rijen = (Array.isArray(afspraken) ? afspraken : []).filter((a) => a && a.is_test !== true);
  const grens = nuMs - KOMEND_SPELING_UUR * 3600000;
  let komend = false, metUitkomst = false, annuleerde = false, noShow = false;
  for (const a of rijen) {
    const st = laag(a.status);
    const start = Date.parse(a.scheduled_at || '');
    if (KOMEND_STATUSSEN.has(st) && Number.isFinite(start) && start > grens) komend = true;
    if ((a.uitkomst != null && String(a.uitkomst).trim() !== '') || st === 'completed') metUitkomst = true;
    if (GEANNULEERD.has(st)) annuleerde = true;
    if (NO_SHOW.has(st)) noShow = true;
  }
  const gesorteerd = [...rijen].sort((x, y) => (Date.parse(y.scheduled_at || '') || 0) - (Date.parse(x.scheduled_at || '') || 0));
  const laatste = gesorteerd[0] || null;
  return {
    aantal: rijen.length,
    laatste_status: laatste ? laatste.status || null : null,
    laatste_op: laatste ? laatste.scheduled_at || null : null,
    komend, met_uitkomst: metUitkomst, annuleerde, no_show: noShow,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// WARMTE
// ═══════════════════════════════════════════════════════════════════════════

export function warmteLabel(score) {
  if (score >= LABEL_HEET) return { code: 'heet', tekst: '🔥 Heet' };
  if (score >= LABEL_WARM) return { code: 'warm', tekst: 'Warm' };
  if (score >= LABEL_LAUW) return { code: 'lauw', tekst: 'Lauw' };
  return { code: 'koud', tekst: 'Koud' };
}

function geledenTekst(dagen) {
  if (dagen == null) return '';
  if (dagen <= 0) return 'vandaag';
  if (dagen === 1) return 'gisteren';
  return dagen + ' dagen geleden';
}

/**
 * De warmtescore 0–100, transparant: elke punt komt met een reden.
 *
 *   recentheid aanmelding : ≤2d +30 · 3–7d +20 · 8–14d +10 · 15–30d +5
 *   LMS (trial_warmte)    : score × 1,5, max 40
 *   laatst actief ≤ 3d    : +10
 *   kwalificatie          : 'toegang' +10 · 'geen toegang' −10
 *   eerdere annulering / no-show : +10 (had intentie)
 *   toegang loopt binnen 2 dagen af, of verliep ≤ 7 dagen geleden : +5
 *
 * @returns {{ score, label, redenen:[{tekst,punten}], chips:[{tekst,soort}] }}
 */
export function berekenWarmte({ lead, trial, calls, vandaag }) {
  const redenen = [];
  const chips = [];
  const plus = (punten, tekst) => { if (punten) redenen.push({ tekst, punten }); };

  const aangemeldDag = lead && lead.aangemaakt ? dagInZone(Date.parse(lead.aangemaakt)) : null;
  const oud = aangemeldDag ? dagenTussen(aangemeldDag, vandaag) : null;
  if (oud != null) {
    if (oud <= 2) plus(30, 'aangemeld ' + geledenTekst(oud));
    else if (oud <= 7) plus(20, 'aangemeld ' + oud + ' dagen geleden');
    else if (oud <= 14) plus(10, 'aangemeld ' + oud + ' dagen geleden');
    else if (oud <= 30) plus(5, 'aangemeld ' + oud + ' dagen geleden');
  }

  const t = trial || null;
  if (t) {
    if (t.score != null && t.score > 0) {
      plus(Math.min(40, Math.round(t.score * 1.5)), 'LMS-activiteit (score ' + t.score + ')');
    }
    if (t.ooit_ingelogd === true) chips.push({ tekst: 'ingelogd', soort: 'goed' });
    if (t.ooit_ingelogd === false) chips.push({ tekst: 'nog niet ingelogd', soort: 'let' });
    if (t.lessen != null && t.lessen > 0) chips.push({ tekst: t.lessen + ' les' + (t.lessen === 1 ? '' : 'sen') + ' bekeken', soort: 'goed' });
    if (t.trades != null && t.trades > 0) chips.push({ tekst: t.trades + ' trade' + (t.trades === 1 ? '' : 's') + ' gelogd', soort: 'goed' });
    if (t.laatst_actief) {
      const d = dagenTussen(dagInZone(Date.parse(t.laatst_actief)), vandaag);
      if (d != null && d >= 0) {
        chips.push({ tekst: 'laatst actief ' + geledenTekst(d), soort: d <= 3 ? 'goed' : 'neutraal' });
        if (d <= 3) plus(10, 'laatst actief ' + geledenTekst(d));
      }
    }
    if (t.dagen_over != null) {
      if (t.dagen_over >= 0 && t.dagen_over <= 2) {
        plus(5, 'toegang loopt af');
        chips.push({ tekst: 'toegang loopt af', soort: 'let' });
      } else if (t.dagen_over < 0 && t.dagen_over >= -7) {
        plus(5, 'toegang verlopen');
        chips.push({ tekst: 'toegang verlopen', soort: 'let' });
      }
    }
  }

  const kw = laag(lead && lead.kwalificatie);
  if (kw === 'toegang') plus(10, 'kwalificatie: toegang');
  else if (kw === 'geen toegang') plus(-10, 'kwalificatie: geen toegang');

  const c = calls || {};
  if (c.annuleerde || c.no_show) {
    plus(10, c.annuleerde ? 'annuleerde eerder een call' : 'kwam eerder niet opdagen');
  }
  if (c.annuleerde) chips.push({ tekst: 'annuleerde eerder een call', soort: 'let' });
  if (c.no_show) chips.push({ tekst: 'kwam niet opdagen', soort: 'let' });

  const som = redenen.reduce((n, r) => n + r.punten, 0);
  const score = Math.max(0, Math.min(100, som));
  return { score, label: warmteLabel(score), redenen, chips };
}

/**
 * De gespreksopener: één zin, afgeleid uit de data (geen AI). De volgorde is
 * de prioriteit — het sterkste haakje wint.
 */
export function gespreksopener({ trial, calls, vandaag }) {
  const t = trial || {};
  const c = calls || {};
  if (c.annuleerde) return 'Annuleerde eerder een call — vraag of het nu wel past.';
  if (c.no_show) return 'Kwam eerder niet opdagen — vraag of het nu wel past.';
  if (t.dagen_over != null && t.dagen_over >= 0 && t.dagen_over <= 2) {
    const wanneer = t.dagen_over === 0 ? 'vandaag' : t.dagen_over === 1 ? 'morgen' : 'overmorgen';
    return 'Toegang verloopt ' + wanneer + ' — goed moment voor een call.';
  }
  if (t.ooit_ingelogd === false) return 'Nog niet ingelogd — vraag of de toegang goed aankwam.';
  if (t.lessen != null && t.lessen > 0) {
    const d = t.laatst_actief ? dagenTussen(dagInZone(Date.parse(t.laatst_actief)), vandaag) : null;
    return 'Bekeek ' + t.lessen + ' les' + (t.lessen === 1 ? '' : 'sen') +
      (d != null && d >= 0 ? ', laatst ' + geledenTekst(d) : '') + ' — vraag wat hij ervan vond.';
  }
  if (t.dagen_over != null && t.dagen_over < 0) return 'Toegang is verlopen — vraag hoe de cursus beviel.';
  return 'Vraag hoe de cursus loopt.';
}

// ═══════════════════════════════════════════════════════════════════════════
// DE POT 'NIEUW'
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wat er met één kandidaat-lead gebeurt: in de pot, of eruit met een reden.
 *
 * @param {object} p
 * @param {object} p.lead
 * @param {object} p.calls      uitkomst van beoordeelCalls()
 * @param {object|null} p.kaart de leadkaart (elke status) van deze lead
 * @param {Set<string>} p.daglijstStaarten laatste 9 cijfers van open/wacht-kaarten op de daglijst
 * @returns {{ in: true } | { in: false, reden: string }}
 */
export function beslisKandidaat({ lead, calls, kaart, daglijstStaarten }) {
  const tel = telefoonVan(lead);
  if (!tel) return { in: false, reden: 'geen_telefoon' };
  if (lead.customer_id) return { in: false, reden: 'al_klant' };
  if (kaart && kaart.status === 'gearchiveerd') return { in: false, reden: 'weggegooid' };
  if (kaart) return { in: false, reden: 'eigen_kaart' };
  const c = calls || {};
  if (c.komend) return { in: false, reden: 'komende_call' };
  if (c.met_uitkomst) return { in: false, reden: 'call_uitkomst' };
  const s = staart9(tel);
  if (s && daglijstStaarten && daglijstStaarten.has(s)) return { in: false, reden: 'op_daglijst' };
  return { in: true };
}

/** De telling van wat er niet getoond wordt, als zinnen voor het scherm. */
export function uitsluitRegels(telling) {
  return Object.keys(UITSLUITREDENEN)
    .filter((k) => (telling[k] || 0) > 0)
    .map((k) => ({ code: k, aantal: telling[k], tekst: UITSLUITREDENEN[k] }));
}

/** Sortering van de pot: score aflopend, dan de recentste aanmelding. */
export function sorteerPot(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return String(b.aangemaakt || '').localeCompare(String(a.aangemaakt || ''));
}

// ═══════════════════════════════════════════════════════════════════════════
// DE POTTEN VAN DE KAARTEN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * In welke pot hoort een leadkaart? null = in geen enkele (te oud).
 *
 * @param {object} kaart rij uit opvolging_taken (lijst 'leads')
 * @param {string} vandaag YYYY-MM-DD (Amsterdam)
 * @param {number} nuMs
 */
export function potVoorKaart(kaart, vandaag, nuMs = Date.now()) {
  if (!kaart) return null;
  const st = String(kaart.status || '');
  const due = String(kaart.due || '');
  if (st === 'open') {
    if (due > vandaag) return 'later';
    if (kaart.reden_code === REDEN_CODE_TERUGBELLEN) return 'terugbellen';
    if (kaart.reden_code === REDEN_CODE_VERLOPEN) return 'verlopen';
    return 'bezig';
  }
  if (st === 'wacht_inplanning') return 'wacht';
  if (st === 'ingepland') {
    const op = Date.parse(kaart.afspraak_gevonden_at || kaart.updated_at || '');
    return Number.isFinite(op) && nuMs - op <= INGEPLAND_DAGEN * DAG_MS ? 'ingepland' : null;
  }
  if (st === 'gearchiveerd') {
    const op = Date.parse(kaart.gearchiveerd_at || '');
    return Number.isFinite(op) && nuMs - op <= AFGEROND_DAGEN * DAG_MS ? 'afgerond' : null;
  }
  return null;
}

/** Resterende uren van de 48 voor een kaart op wacht_inplanning. */
export function resterendeUren(kaart, nuMs, wachtUren = 48) {
  const s = Date.parse(kaart && kaart.agenda_doorgestuurd_at || '');
  if (!Number.isFinite(s)) return null;
  return Math.max(0, Math.ceil((s + wachtUren * 3600000 - nuMs) / 3600000));
}

// ═══════════════════════════════════════════════════════════════════════════
// AFRONDEN (= WEGGOOIEN) — DE DREMPEL EN HET OORDEEL
// ═══════════════════════════════════════════════════════════════════════════

export const AFROND_CATEGORIEEN = Object.freeze({
  geen_interesse   : 'Geen interesse',
  niet_bereikbaar  : 'Niet bereikbaar',
  foutief_nummer   : 'Foutief nummer',
  al_klant         : 'Al klant / al geholpen',
  geen_budget      : 'Geen budget',
  anders           : 'Anders',
});
export const AFROND_MIN_NOTITIE = 15;
/** Drempel: ≥ 2 belpogingen op ≥ 2 verschillende dagen én ≥ 1 WhatsApp. */
export const AFROND_MIN_BEL = 2;
export const AFROND_MIN_BEL_DAGEN = 2;
export const AFROND_MIN_WA = 1;
/** Bij deze categorieën is de drempel niet van toepassing. */
export const AFROND_ZONDER_DREMPEL = new Set(['foutief_nummer', 'al_klant']);

/**
 * Is er genoeg moeite gedaan voor deze lead weggegooid wordt?
 *
 * @param {object} p
 * @param {number} p.bel_totaal
 * @param {number} p.bel_dagen
 * @param {number} p.wa_totaal
 * @param {boolean} p.gesproken er was echt contact (gesprek of antwoord)
 * @param {string} p.categorie
 * @returns {{ genoeg: boolean, nvt: boolean, tekort: string[] }}
 */
export function beoordeelAfronden({ bel_totaal = 0, bel_dagen = 0, wa_totaal = 0, gesproken = false, categorie = null } = {}) {
  if (AFROND_ZONDER_DREMPEL.has(String(categorie || '')) || gesproken) return { genoeg: true, nvt: true, tekort: [] };
  const tekort = [];
  const b = Number(bel_totaal) || 0, d = Number(bel_dagen) || 0, w = Number(wa_totaal) || 0;
  if (b < AFROND_MIN_BEL) tekort.push('nog ' + (AFROND_MIN_BEL - b) + '× bellen');
  if (d < AFROND_MIN_BEL_DAGEN) tekort.push('bellen op ' + AFROND_MIN_BEL_DAGEN + ' verschillende dagen (nu ' + d + ')');
  if (w < AFROND_MIN_WA) tekort.push('minstens 1 WhatsApp');
  return { genoeg: tekort.length === 0, nvt: false, tekort };
}

/**
 * Serverkant van afronden: categorie en notitie zijn verplicht.
 * @returns {null | string} foutmelding, of null als het klopt
 */
export function valideerAfronden({ categorie, notitie }) {
  if (!Object.prototype.hasOwnProperty.call(AFROND_CATEGORIEEN, String(categorie || ''))) {
    return 'Kies een categorie.';
  }
  if (String(notitie || '').trim().length < AFROND_MIN_NOTITIE) {
    return 'Schrijf in minstens ' + AFROND_MIN_NOTITIE + ' tekens waarom deze lead afgerond wordt.';
  }
  return null;
}

/** De inspanning in één zin: '2× gebeld op 1 dag, 0 WhatsApps, nooit gesproken'. */
export function inspanningTekst({ bel_totaal = 0, bel_dagen = 0, wa_totaal = 0, gesproken = false } = {}) {
  return bel_totaal + '× gebeld op ' + bel_dagen + ' dag' + (bel_dagen === 1 ? '' : 'en') + ', ' +
    wa_totaal + ' WhatsApp' + (wa_totaal === 1 ? '' : 's') + ', ' + (gesproken ? 'wel gesproken' : 'nooit gesproken');
}

// ═══════════════════════════════════════════════════════════════════════════
// ALLES SAMEN — VAN RUWE RIJEN NAAR POTTEN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bouwt alle potten uit de ruwe rijen. Puur: de aanroeper leest de databank,
 * hier wordt alleen beslist en geteld.
 *
 * @param {object}   p
 * @param {object[]} p.leads         kandidaat-leads (al op venster + traject/bron gefilterd)
 * @param {object[]} [p.extraLeads]  leads achter kaarten die buiten het venster vallen
 * @param {object[]} p.kaarten       ALLE leadkaarten (lijst 'leads'), elke status
 * @param {string[]} p.daglijstTelefoons telefoons van open/wacht-kaarten op de daglijst
 * @param {object[]} p.afspraken     follow_up_appointments-rijen (venster)
 * @param {Map<string,object>} p.trialPerLead lead_id → normaliseerTrial()-uitvoer
 * @param {Map<string,object>} p.telPerKaart  taak_id → telPogingen()-uitvoer (met pogingen)
 * @param {number}   p.nuMs
 */
export function stelPottenSamen({
  leads = [], extraLeads = [], kaarten = [], daglijstTelefoons = [], afspraken = [],
  trialPerLead = new Map(), telPerKaart = new Map(), nuMs = Date.now(), wachtUren = 48,
}) {
  const vandaag = dagInZone(nuMs);
  const daglijstStaarten = new Set(daglijstTelefoons.map(staart9).filter(Boolean));

  const kaartPerLead = new Map();
  for (const k of kaarten) {
    if (!k || !k.lead_id) continue;
    const huidig = kaartPerLead.get(k.lead_id);
    // Een levende kaart wint van een gearchiveerde; anders de nieuwste.
    const levend = (x) => x && x.status !== 'gearchiveerd';
    if (!huidig || (levend(k) && !levend(huidig)) ||
        (levend(k) === levend(huidig) && String(k.created_at || '') > String(huidig.created_at || ''))) {
      kaartPerLead.set(k.lead_id, k);
    }
  }

  const afsprakenVoor = (lead) => {
    const s = staart9(telefoonVan(lead));
    return afspraken.filter((a) => afspraakHoortBij({ staart: s, email: lead.email }, a));
  };

  const leadRij = (lead) => {
    const trial = trialPerLead.get(lead.id) || null;
    const calls = beoordeelCalls(afsprakenVoor(lead), nuMs);
    const w = berekenWarmte({ lead, trial, calls, vandaag });
    const p = productVan(lead);
    const naam = naamVan(lead);
    const aangemeldDag = lead.aangemaakt ? dagInZone(Date.parse(lead.aangemaakt)) : null;
    return {
      lead_id: lead.id,
      naam,
      voornaam: String(lead.voornaam || '').trim() || voornaamVan(naam),
      telefoon: telefoonVan(lead),
      email: lead.email || null,
      product: p.product, variant: p.variant, product_label: p.label,
      aangemaakt: lead.aangemaakt || null,
      aangemeld_dagen: aangemeldDag ? dagenTussen(aangemeldDag, vandaag) : null,
      score: w.score, label: w.label, redenen: w.redenen, chips: w.chips,
      opener: gespreksopener({ trial, calls, vandaag }),
      trial: trial ? {
        dag: trial.dag, dagen_totaal: proefDuur(trial, p.product), lessen: trial.lessen,
        trades: trial.trades, laatst_actief: trial.laatst_actief,
        ooit_ingelogd: trial.ooit_ingelogd, toegang_tot: trial.toegang_tot, dagen_over: trial.dagen_over,
      } : null,
      calls: { aantal: calls.aantal, laatste_status: calls.laatste_status, laatste_op: calls.laatste_op },
      _calls: calls,
    };
  };

  const potten = Object.fromEntries(POTTEN.map((p) => [p, []]));
  const telling = Object.fromEntries(Object.keys(UITSLUITREDENEN).map((k) => [k, 0]));

  // ── De berekende pot ────────────────────────────────────────────────────
  for (const lead of leads) {
    if (!lead || !lead.id || !isProefLead(lead)) continue;
    const kaart = kaartPerLead.get(lead.id) || null;
    const rij = leadRij(lead);
    const besluit = beslisKandidaat({ lead, calls: rij._calls, kaart, daglijstStaarten });
    if (!besluit.in) { telling[besluit.reden] = (telling[besluit.reden] || 0) + 1; continue; }
    delete rij._calls;
    potten.nieuw.push({ ...rij, kaart: null });
  }
  potten.nieuw.sort(sorteerPot);

  // ── De kaarten ──────────────────────────────────────────────────────────
  const leadOpId = new Map([...extraLeads, ...leads].filter((l) => l && l.id).map((l) => [l.id, l]));
  for (const k of kaarten) {
    const pot = potVoorKaart(k, vandaag, nuMs);
    if (!pot) continue;
    const lead = k.lead_id ? leadOpId.get(k.lead_id) : null;
    const basis = lead ? leadRij(lead) : kaartAlsLead(k, vandaag);
    // Boekte hij intussen langs een andere weg een call, dan hoort Dave dat te
    // zien vóór hij belt — de kaart sluit dan niet vanzelf.
    if (basis._calls && basis._calls.komend && k.status !== 'ingepland') {
      basis.chips = [{ tekst: 'heeft al een call gepland', soort: 'let' }, ...basis.chips];
    }
    delete basis._calls;
    const tel = telPerKaart.get(k.id) || null;
    potten[pot].push({ ...basis, kaart: kaartSamenvatting(k, tel, nuMs, wachtUren) });
  }

  const laatstePoging = (r) => Date.parse(r.kaart && r.kaart.laatste_poging || '') || 0;
  potten.terugbellen.sort((a, b) => String(a.kaart.due).localeCompare(String(b.kaart.due)) || b.score - a.score);
  potten.verlopen.sort((a, b) => b.score - a.score);
  potten.bezig.sort((a, b) => laatstePoging(a) - laatstePoging(b));
  potten.wacht.sort((a, b) => (a.kaart.resterende_uren ?? 99) - (b.kaart.resterende_uren ?? 99));
  potten.later.sort((a, b) => String(a.kaart.due).localeCompare(String(b.kaart.due)));
  potten.ingepland.sort((a, b) => String(b.kaart.afspraak_gevonden_at || '').localeCompare(String(a.kaart.afspraak_gevonden_at || '')));
  potten.afgerond.sort((a, b) => String(b.kaart.gearchiveerd_at || '').localeCompare(String(a.kaart.gearchiveerd_at || '')));

  const aantallen = Object.fromEntries(POTTEN.map((p) => [p, potten[p].length]));
  const heet = potten.nieuw.filter((r) => r.label.code === 'heet').length;

  return {
    vandaag,
    potten,
    aantallen,
    badge: aantallen.terugbellen + aantallen.verlopen + heet,
    nieuw_heet: heet,
    niet_getoond: uitsluitRegels(telling),
    dag: dagstatistiek(kaarten, telPerKaart, vandaag),
    week: weekstatistiek(kaarten, telPerKaart, nuMs),
  };
}

/** Een kaart zonder lead (bv. een opgeladen lijst): de kaart zelf is de bron. */
function kaartAlsLead(k, vandaag) {
  const naam = k.naam || '(zonder naam)';
  const ref = k.bron_ref || {};
  const aangemaakt = k.created_at || null;
  return {
    lead_id: k.lead_id || null,
    naam,
    voornaam: voornaamVan(naam),
    telefoon: k.telefoon || null,
    email: k.email || null,
    product: ref.product || null, variant: null, product_label: k.badge_label || ref.product || null,
    aangemaakt,
    aangemeld_dagen: aangemaakt ? dagenTussen(dagInZone(Date.parse(aangemaakt)), vandaag) : null,
    score: 0, label: warmteLabel(0), redenen: [], chips: [],
    opener: k.notitie ? String(k.notitie).split('\n')[0].slice(0, 140) : 'Vraag hoe het gaat.',
    trial: null,
    calls: { aantal: 0, laatste_status: null, laatste_op: null },
  };
}

/** Wat het scherm over een kaart moet weten. */
export function kaartSamenvatting(k, tel, nuMs, wachtUren = 48) {
  const t = tel || {};
  const pogingen = Array.isArray(t.pogingen) ? t.pogingen : [];
  const herinneringen = pogingen.filter((p) => p && p.soort === 'agenda_herinnering');
  const contact = pogingen.some((p) => contactJa(p));
  const eerste = pogingen.find((p) => p && p.soort !== 'ingepland') || null;
  const archief = k.status === 'gearchiveerd' ? {
    categorie: k.archief_categorie || null,
    categorie_tekst: AFROND_CATEGORIEEN[k.archief_categorie] || k.archief_categorie || null,
    reden: k.archief_reden || null,
    oordeel: beoordeelAfronden({
      bel_totaal: t.bel_totaal, bel_dagen: t.bel_dagen, wa_totaal: t.wa_totaal,
      gesproken: contact, categorie: k.archief_categorie,
    }),
    dagen_tot_afronden: eerste && k.gearchiveerd_at
      ? dagenTussen(dagInZone(Date.parse(eerste.tijdstip)), dagInZone(Date.parse(k.gearchiveerd_at)))
      : null,
  } : null;
  return {
    taak_id: k.id,
    status: k.status,
    telefoon: k.telefoon || null,
    due: k.due || null,
    later: !!k.later,
    reden_code: k.reden_code || null,
    badge_label: k.badge_label || null,
    notitie: k.notitie || null,
    terugbel_notitie: k.terugbel_notitie || null,
    agenda_doorgestuurd_at: k.agenda_doorgestuurd_at || null,
    resterende_uren: k.status === 'wacht_inplanning' ? resterendeUren(k, nuMs, wachtUren) : null,
    afspraak_gevonden_at: k.afspraak_gevonden_at || null,
    afspraak_ref: k.afspraak_ref || null,
    gearchiveerd_at: k.gearchiveerd_at || null,
    laatste_herinnering_at: herinneringen.length ? herinneringen[herinneringen.length - 1].tijdstip : null,
    bel_totaal: t.bel_totaal || 0,
    bel_dagen: t.bel_dagen || 0,
    wa_totaal: t.wa_totaal || 0,
    bel_vandaag: t.bel_vandaag || 0,
    wa_vandaag: t.wa_vandaag || 0,
    pogingen_totaal: t.pogingen_totaal || 0,
    laatste_poging: t.laatste_poging || null,
    eerste_poging: eerste ? eerste.tijdstip : null,
    contact,
    pogingen,
    archief,
  };
}

/** Was er via deze rij echt contact? Gesproken aan de lijn, of een antwoord. */
function contactJa(p) {
  if (!p) return false;
  if (p.soort === 'call') return /^gesproken/i.test(String(p.resultaat || '').trim());
  if (p.soort === 'whatsapp' || p.soort === 'spraakbericht') return p.richting === 'in';
  return false;
}

/** Wat er vandaag op de leadkaarten gebeurde. */
export function dagstatistiek(kaarten, telPerKaart, vandaag) {
  const uit = { gebeld: 0, gesproken: 0, whatsapps: 0, doorgestuurd: 0, ingepland: 0, afgerond: 0 };
  for (const k of kaarten) {
    if (k.status === 'gearchiveerd' && k.gearchiveerd_at && dagInZone(Date.parse(k.gearchiveerd_at)) === vandaag) uit.afgerond += 1;
    const t = telPerKaart.get(k.id);
    for (const p of (t && t.pogingen) || []) {
      if (!p || dagInZone(Date.parse(p.tijdstip)) !== vandaag) continue;
      const uitgaand = p.richting !== 'in';
      if (p.soort === 'call' && uitgaand) {
        uit.gebeld += 1;
        if (contactJa(p)) uit.gesproken += 1;
      } else if ((p.soort === 'whatsapp' || p.soort === 'spraakbericht') && uitgaand) uit.whatsapps += 1;
      else if (p.soort === 'agenda_doorgestuurd') uit.doorgestuurd += 1;
      else if (p.soort === 'ingepland') uit.ingepland += 1;
    }
  }
  return uit;
}

/** Doorgestuurd → ingepland over de laatste 7 dagen. */
export function weekstatistiek(kaarten, telPerKaart, nuMs) {
  const grens = nuMs - 7 * DAG_MS;
  let doorgestuurd = 0, ingepland = 0;
  for (const k of kaarten) {
    const t = telPerKaart.get(k.id);
    const gestuurd = ((t && t.pogingen) || []).some((p) => p && p.soort === 'agenda_doorgestuurd' && Date.parse(p.tijdstip) >= grens);
    if (!gestuurd) continue;
    doorgestuurd += 1;
    if (k.status === 'ingepland') ingepland += 1;
  }
  return { doorgestuurd, ingepland, pct: doorgestuurd ? Math.round((ingepland / doorgestuurd) * 100) : null };
}
