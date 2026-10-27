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
export const POTTEN = ['belrij', 'terugbellen', 'verlopen', 'bezig', 'nieuw', 'wacht', 'later', 'ingepland', 'afgerond'];

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
  in_aparte_lijst: 'staat al in een aparte lijst',
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
export function beslisKandidaat({ lead, calls, kaart, daglijstStaarten, aparteStaarten, aparteLeadIds }) {
  const tel = telefoonVan(lead);
  if (!tel) return { in: false, reden: 'geen_telefoon' };
  if (lead.customer_id) return { in: false, reden: 'al_klant' };
  if (kaart && kaart.status === 'gearchiveerd') return { in: false, reden: 'weggegooid' };
  if (kaart) return { in: false, reden: 'eigen_kaart' };
  // Zijn kaart staat in een aparte lijst (bv. verhuisd uit de pot).
  if (aparteLeadIds && aparteLeadIds.has(lead.id)) return { in: false, reden: 'in_aparte_lijst' };
  const c = calls || {};
  if (c.komend) return { in: false, reden: 'komende_call' };
  if (c.met_uitkomst) return { in: false, reden: 'call_uitkomst' };
  const s = staart9(tel);
  if (s && daglijstStaarten && daglijstStaarten.has(s)) return { in: false, reden: 'op_daglijst' };
  // Al op een lopende kaart in een aparte lijst: die lijst staat volledig apart.
  if (s && aparteStaarten && aparteStaarten.has(s)) return { in: false, reden: 'in_aparte_lijst' };
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
 * @param {object} [opties]
 * @param {boolean} [opties.zonderVenster] ingepland/afgerond zonder termijn
 *   (een aparte lijst toont zijn hele historiek)
 * @param {boolean} [opties.zonderDosering] een latere `due` die geen
 *   terugbelafspraak is, telt als nu (een aparte lijst kent geen dosering;
 *   een uit de pot verhuisde kaart houdt zijn due, maar staat meteen klaar)
 */
export function potVoorKaart(kaart, vandaag, nuMs = Date.now(), { zonderVenster = false, zonderDosering = false } = {}) {
  if (!kaart) return null;
  const st = String(kaart.status || '');
  const due = String(kaart.due || '');
  if (st === 'open') {
    // Een terugbelafspraak staat ALTIJD in Terugbellen — ook vóór de dag zelf.
    // Zo is er één plek waar alle beloftes aan leads staan, met de datum erbij;
    // op de dag zelf komt hij bovenaan de Belrij. (Vroeger verdween hij tot die
    // dag in 'Later', tussen de opgeladen lijsten.)
    if (kaart.reden_code === REDEN_CODE_TERUGBELLEN) return 'terugbellen';
    if (due > vandaag && !zonderDosering) return 'later';
    if (kaart.reden_code === REDEN_CODE_VERLOPEN) return 'verlopen';
    return 'bezig';
  }
  if (st === 'wacht_inplanning') return 'wacht';
  if (st === 'ingepland') {
    const op = Date.parse(kaart.afspraak_gevonden_at || kaart.updated_at || '');
    if (zonderVenster) return 'ingepland';
    return Number.isFinite(op) && nuMs - op <= INGEPLAND_DAGEN * DAG_MS ? 'ingepland' : null;
  }
  if (st === 'gearchiveerd') {
    const op = Date.parse(kaart.gearchiveerd_at || '');
    if (zonderVenster) return 'afgerond';
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
// BELRONDES — WIE IS ER NU AAN DE BEURT, EN WIE WACHT OP ZIJN VOLGENDE RONDE
// ═══════════════════════════════════════════════════════════════════════════
//
// Het probleem dat dit oplost (gemeten 13 okt): 54 kaarten stonden in Bezig,
// allemaal met due = vandaag, gesorteerd op 'oudste poging eerst'. Wie niet
// opnam, stond na het ophangen gewoon weer in dezelfde lijst. Dave bleef zo in
// Bezig hangen — dezelfde mensen die niet opnemen — terwijl de verse leads in
// Nieuw geen enkel belletje kregen.
//
// DE REGEL: een lead die je net probeerde, is even NIET aan de beurt. Hij
// schuift door naar zijn volgende belronde, op een ander moment van de dag of
// een andere dag (dat verhoogt de kans dat hij opneemt). Pas als die ronde er
// is, staat hij weer in de Belrij. Alles wordt AFGELEID uit de belpogingen die
// de softphone zelf logt — Dave hoeft niets aan te klikken om de cadans te
// laten werken. Klikt hij wel een uitkomst aan, dan wordt het preciezer.
//
// Een RONDE is één poging-moment: twee keer kort na elkaar bellen (meteen
// herbellen) is één ronde, niet twee.

/** Calls binnen zoveel minuten van elkaar horen bij dezelfde ronde. */
export const RONDE_GAP_MIN = 60;
/** Na zoveel rondes zonder resultaat: uitgebeld — afronden of nog één laatste poging. */
export const MAX_RONDES = 5;
/**
 * De pauze NA ronde n (index n−1). Ronde 1 → 3 uur later nog eens (ander
 * moment van dezelfde dag), daarna oplopend over dagen.
 */
export const RONDE_PAUZE = Object.freeze([
  { uren: 3 },   // na ronde 1: dezelfde dag, 3 uur later
  { dagen: 1 },  // na ronde 2: morgen
  { dagen: 2 },  // na ronde 3: overmorgen
  { dagen: 3 },  // na ronde 4: drie dagen later
]);
/** Belvenster: vóór START_UUR en na EIND_UUR wordt niemand 'aan de beurt'. */
export const START_UUR = 9;
export const EIND_UUR = 20;

/** De secties van de Belrij, in volgorde van prioriteit. */
export const BELRIJ_SECTIES = Object.freeze([
  { code: 'reageerde', label: 'Reageerde op je bericht', uitleg: 'Stuurde iets terug na je laatste poging. Bel nu: hij is wakker.' },
  { code: 'terugbellen', label: 'Afgesproken terugbellen', uitleg: 'Vroeg zelf om vandaag gebeld te worden. Een belofte — eerst deze.' },
  { code: 'verlopen', label: 'Agenda gekregen, niets ingepland', uitleg: 'Toonde interesse maar koos binnen 48 uur geen moment.' },
  { code: 'vers', label: 'Nieuw: vers of heet', uitleg: 'Aangemeld in de laatste 2 dagen, of heet door zijn LMS-gebruik. Hoe sneller je belt, hoe hoger de kans.' },
  { code: 'opnieuw', label: 'Volgende belronde', uitleg: 'Nam eerder niet op; zijn volgende ronde is er. Eerste rondes eerst.' },
  { code: 'nieuw', label: 'Overige nieuwe leads', uitleg: 'Nog niet gebeld, warmste eerst.' },
  { code: 'uitgebeld', label: 'Uitgebeld — rond af', uitleg: MAX_RONDES + ' rondes zonder resultaat. Stuur een laatste WhatsApp of rond af.' },
]);
/** Deze secties tellen mee in de badge op de knop in Vandaag. */
export const BELRIJ_DRINGEND = new Set(['reageerde', 'terugbellen', 'verlopen', 'vers', 'opnieuw']);

/** Is deze poging een belpoging van ons? (afgebroken vóór opnemen telt niet) */
export function isBelpoging(p) {
  if (!p || p.soort !== 'call' || p.richting === 'in') return false;
  return !/^afgebroken/i.test(String(p.resultaat || '').trim());
}

/** Een uitgaande poging van eender welke soort (bellen, appen, agenda sturen). */
function isUitgaand(p) {
  if (!p) return false;
  if (p.soort === 'call') return isBelpoging(p);
  if (p.soort === 'whatsapp' || p.soort === 'spraakbericht') {
    if (p.richting === 'in') return false;
    // Status-regels (afgeleverd/gelezen) zijn geen nieuwe poging.
    return !/^WhatsApp (afgeleverd|gelezen)/i.test(String(p.resultaat || ''));
  }
  return p.soort === 'agenda_doorgestuurd' || p.soort === 'agenda_herinnering';
}

/**
 * De belrondes uit de pogingen. Alleen calls vanaf `vanafMs`.
 * @returns {{start:number, eind:number, calls:number}[]} oudste eerst
 */
export function belRondes(pogingen, vanafMs = 0) {
  const calls = (Array.isArray(pogingen) ? pogingen : [])
    .filter(isBelpoging)
    .map((p) => Date.parse(p.tijdstip))
    .filter((t) => Number.isFinite(t) && t >= vanafMs)
    .sort((a, b) => a - b);
  const rondes = [];
  for (const t of calls) {
    const laatste = rondes[rondes.length - 1];
    if (laatste && t - laatste.eind <= RONDE_GAP_MIN * 60000) { laatste.eind = t; laatste.calls += 1; }
    else rondes.push({ start: t, eind: t, calls: 1 });
  }
  return rondes;
}

/** YYYY-MM-DD + n kalenderdagen. */
export function dagPlusN(dag, n) {
  const d = new Date(String(dag).slice(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Het uur (0–23) in Amsterdam van een moment. */
function uurInZone(ms) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
}

/** Het moment `dag` om `uur`:`min` Amsterdamse tijd, in ms. Zomer- en wintertijd-vast. */
export function momentInZone(dag, uur, min = 0) {
  const gok = Date.parse(String(dag).slice(0, 10) + 'T' + String(uur).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':00Z');
  // Verschil tussen wat de gok in Amsterdam aanwijst en wat we willen.
  for (const corr of [0, 1, 2, -1]) {
    const t = gok - corr * 3600000;
    if (dagInZone(t) === String(dag).slice(0, 10) && uurInZone(t) === uur) return t;
  }
  return gok - 2 * 3600000;
}

/**
 * Wanneer mag ronde n+1 beginnen, als ronde n eindigde op `eindMs`?
 * Valt het buiten het belvenster, dan de eerstvolgende ochtend om START_UUR.
 */
export function volgendeRondeMs(eindMs, rondeNr) {
  const pauze = RONDE_PAUZE[Math.min(Math.max(rondeNr, 1), RONDE_PAUZE.length) - 1];
  const dag = dagInZone(eindMs);
  if (pauze.uren) {
    const t = eindMs + pauze.uren * 3600000;
    if (dagInZone(t) === dag && uurInZone(t) < EIND_UUR) return t;
    return momentInZone(dagPlusN(dag, 1), START_UUR);
  }
  return momentInZone(dagPlusN(dag, pauze.dagen), START_UUR);
}

/** Zoveel regels houdt het uitkomstlogboek van één kaart bij. */
export const LOG_MAX = 60;

/** Het logboek met één regel erbij (nieuwste achteraan, begrensd). */
export function logErbij(kaart, regel) {
  const oud = Array.isArray(kaart && kaart.uitkomst_log) ? kaart.uitkomst_log : [];
  return [...oud, { op: new Date().toISOString(), ...regel }].slice(-LOG_MAX);
}

/** De uitkomsten die Dave na een call kan aanklikken. */
export const UITKOMSTEN = Object.freeze({
  geen_gehoor   : 'Geen gehoor',
  voicemail     : 'Voicemail',
  gesproken     : 'Gesproken',
  foutief_nummer: 'Foutief nummer',
});

/** Het uitkomstlogboek van een kaart, altijd als array, oudste eerst. */
export function logVan(kaart) {
  const l = kaart && Array.isArray(kaart.uitkomst_log) ? kaart.uitkomst_log : [];
  return l.filter((e) => e && e.op).sort((a, b) => String(a.op).localeCompare(String(b.op)));
}

/**
 * Het moment vanaf wanneer de rondes van deze kaart tellen.
 *
 * Een terugbelafspraak is een nieuwe start: de lead vroeg zelf om die dag
 * gebeld te worden, dus wat er daarvóór gebeurde telt niet als ronde van deze
 * afspraak. De dag komt uit het logboek (de doorrol schuift `due` elke nacht
 * naar vandaag, die is dus geen betrouwbare startdag). Zelfde voor een
 * verlopen inplantermijn: vanaf de dag dat hij terugkwam.
 */
export function activatieMs(kaart) {
  if (!kaart) return 0;
  if (kaart.reden_code === REDEN_CODE_TERUGBELLEN) {
    const afspraak = logVan(kaart).filter((e) => e.soort === 'terugbel' && e.due).pop();
    const dag = afspraak ? afspraak.due : kaart.due;
    return dag ? momentInZone(dag, 0) : 0;
  }
  if (kaart.reden_code === REDEN_CODE_VERLOPEN) {
    const terug = Date.parse(kaart.verlopen_op || '');
    if (Number.isFinite(terug)) return terug;
    return kaart.due ? momentInZone(kaart.due, 0) : 0;
  }
  return 0;
}

/**
 * Het belplan van één kaart: hoeveel rondes, wanneer de volgende, en of hij nu
 * aan de beurt is.
 *
 * @param {object} p
 * @param {object} p.kaart     opvolging_taken-rij (met volgende_poging_at, uitkomst_log)
 * @param {object[]} p.pogingen volledige historie (pogingen + WA-regels), oudste eerst
 * @param {number} p.nuMs
 */
export function belPlan({ kaart, pogingen, nuMs }) {
  const alle = belRondes(pogingen, 0);
  const vanaf = activatieMs(kaart);
  const rondes = vanaf ? belRondes(pogingen, vanaf) : alle;
  const laatste = rondes[rondes.length - 1] || null;

  let volgende = laatste ? volgendeRondeMs(laatste.eind, rondes.length) : null;
  // Handmatig gekozen moment ('probeer vanavond opnieuw'): telt als het ná de
  // laatste ronde ligt. Belt hij intussen toch, dan wint het latere van de twee.
  const hand = Date.parse(kaart && kaart.volgende_poging_at || '');
  const handmatig = Number.isFinite(hand) && (!laatste || hand > laatste.eind);
  if (handmatig) volgende = volgende == null ? hand : Math.max(hand, volgende);

  // Reageerde de lead na onze laatste uitgaande poging? Dan is hij nu warm.
  const lijst = Array.isArray(pogingen) ? pogingen : [];
  const laatsteUit = lijst.filter(isUitgaand).map((p) => Date.parse(p.tijdstip)).filter(Number.isFinite);
  const laatsteIn = lijst.filter((p) => p && (p.soort === 'whatsapp' || p.soort === 'spraakbericht') && p.richting === 'in')
    .map((p) => Date.parse(p.tijdstip)).filter(Number.isFinite);
  // Een aangeklikte uitkomst of beslissing na het antwoord telt ook als
  // 'gezien en afgehandeld' — anders blijft een gelezen 'nee' bovenaan staan.
  const logMs = logVan(kaart).map((e) => Date.parse(e.op)).filter(Number.isFinite);
  const uitMax = Math.max(0, ...laatsteUit, ...logMs);
  const inMax = laatsteIn.length ? Math.max(...laatsteIn) : 0;
  // Een terugbelafspraak voor later is zelf al het antwoord op wat hij zei:
  // zonder logregel weten we niet of die vóór of na zijn bericht gemaakt is,
  // dus dan geen 'reageerde' tot de afgesproken dag.
  const vandaagDag = dagInZone(nuMs);
  const latereAfspraak = kaart && kaart.reden_code === REDEN_CODE_TERUGBELLEN &&
    String(kaart.due || '') > vandaagDag && !logMs.some((t) => t > inMax);
  const reageerde = inMax > 0 && inMax > uitMax && !latereAfspraak;
  const antwoord = reageerde
    ? lijst.filter((p) => p && p.richting === 'in' && Date.parse(p.tijdstip) === inMax).map((p) => String(p.resultaat || '')).pop() || null
    : null;

  // Een belpoging van vandaag zonder aangeklikte uitkomst erna.
  // Een vervolgstap (bericht, agenda, inplanning) na de call telt ook als
  // afgehandeld: dan is er duidelijk iets met die call gedaan.
  const log = logVan(kaart);
  const vervolg = lijst.filter((p) => p && p.richting !== 'in' &&
    (p.soort === 'agenda_doorgestuurd' || p.soort === 'agenda_herinnering' || p.soort === 'ingepland' ||
     ((p.soort === 'whatsapp' || p.soort === 'spraakbericht') && isUitgaand(p))))
    .map((p) => Date.parse(p.tijdstip)).filter(Number.isFinite);
  const laatsteLog = Math.max(log.length ? Date.parse(log[log.length - 1].op) || 0 : 0, ...vervolg, 0);
  const laatsteCall = alle.length ? alle[alle.length - 1].eind : 0;
  const uitkomstOpen = laatsteCall > 0 && laatsteCall > laatsteLog && dagInZone(laatsteCall) === dagInZone(nuMs);

  const uitgebeld = rondes.length >= MAX_RONDES && !handmatig;
  const binnenVenster = uurInZone(nuMs) >= START_UUR && uurInZone(nuMs) < EIND_UUR;
  return {
    rondes: rondes.length,
    rondes_totaal: alle.length,
    laatste_ronde_at: laatste ? new Date(laatste.eind).toISOString() : null,
    volgende_at: volgende != null ? new Date(volgende).toISOString() : null,
    // Zonder ronde is hij meteen aan de beurt. Buiten het belvenster telt
    // 'klaar' nog steeds — Dave beslist zelf of hij om 20u30 nog belt.
    klaar: reageerde || volgende == null || volgende <= nuMs,
    handmatig,
    uitgebeld,
    reageerde,
    // De tekst van zijn laatste bericht, zonder het technische voorvoegsel.
    antwoord: antwoord ? antwoord.replace(/^antwoord ontvangen(\s*\([^)]*\))?:\s*/i, '').slice(0, 160) || null : null,
    uitkomst_open: uitkomstOpen,
    binnen_venster: binnenVenster,
  };
}

/** 'nu', 'vandaag 15:30', 'morgen 09:00', 'do 16 okt 09:00'. */
export function momentTekst(iso, nuMs) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  if (t <= nuMs) return 'nu';
  const uur = new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  const d = dagenTussen(dagInZone(nuMs), dagInZone(t));
  if (d === 0) return 'vandaag ' + uur;
  if (d === 1) return 'morgen ' + uur;
  const dag = new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short' })
    .format(new Date(t)).replace(/\./g, '');
  return dag + ' ' + uur;
}

/**
 * In welke sectie van de Belrij hoort een rij? null = nu niet aan de beurt.
 * @param {object} r  rij met .kaart (of null voor een nieuwe lead) en .label
 * @param {string} pot de pot van de kaart
 */
export function belrijSectie(r, pot, vandaag) {
  const k = r && r.kaart;
  if (!k) {
    // Nieuwe lead zonder kaart.
    if ((r.aangemeld_dagen != null && r.aangemeld_dagen <= 2) || (r.label && r.label.code === 'heet')) return 'vers';
    return 'nieuw';
  }
  const plan = k.plan || {};
  if (!['bezig', 'terugbellen', 'verlopen', 'wacht'].includes(pot)) return null;
  if (plan.reageerde) return 'reageerde';
  if (pot === 'wacht') return null;
  if (pot === 'terugbellen') {
    if (String(k.due || '') > String(vandaag || '')) return null;   // nog niet de dag
    if (!plan.klaar) return null;
    return plan.rondes >= 3 ? 'opnieuw' : 'terugbellen';
  }
  if (!plan.klaar) return null;
  if (pot === 'verlopen') return plan.uitgebeld ? 'uitgebeld' : 'verlopen';
  return plan.uitgebeld ? 'uitgebeld' : 'opnieuw';
}

const SECTIE_VOLGORDE = Object.fromEntries(BELRIJ_SECTIES.map((s, i) => [s.code, i]));

/** Sortering binnen en tussen de secties van de Belrij. */
export function sorteerBelrij(a, b) {
  const s = SECTIE_VOLGORDE[a.sectie] - SECTIE_VOLGORDE[b.sectie];
  if (s) return s;
  if (a.sectie === 'opnieuw' || a.sectie === 'uitgebeld') {
    const ra = (a.kaart && a.kaart.plan && a.kaart.plan.rondes) || 0;
    const rb = (b.kaart && b.kaart.plan && b.kaart.plan.rondes) || 0;
    if (ra !== rb) return ra - rb;
  }
  if (a.sectie === 'terugbellen') return String(a.kaart.due).localeCompare(String(b.kaart.due)) || b.score - a.score;
  return sorteerPot(a, b);
}

/** 'vandaag 10:12', 'gisteren 16:40', '3 dagen geleden'. */
export function geledenMoment(iso, nuMs) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const uur = new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  const d = dagenTussen(dagInZone(t), dagInZone(nuMs));
  if (d === 0) return 'vandaag ' + uur;
  if (d === 1) return 'gisteren ' + uur;
  return d + ' dagen geleden';
}

/** Waarom staat hij hier — één korte zin voor op de rij. */
export function waaromTekst(r, nuMs) {
  const k = r.kaart;
  const plan = (k && k.plan) || {};
  switch (r.sectie) {
    case 'reageerde': return 'Antwoordde na je laatste poging';
    case 'terugbellen': return 'Afgesproken: vandaag terugbellen';
    case 'verlopen': return 'Kreeg de agenda, koos geen moment';
    case 'vers': return r.aangemeld_dagen != null && r.aangemeld_dagen <= 2 ? 'Vers aangemeld' : 'Heet door LMS-gebruik';
    case 'opnieuw': return 'Ronde ' + ((plan.rondes || 0) + 1) + ' van ' + MAX_RONDES + (plan.laatste_ronde_at ? ' · vorige poging ' + geledenMoment(plan.laatste_ronde_at, nuMs) : '');
    case 'uitgebeld': return (plan.rondes || 0) + ' rondes zonder resultaat';
    case 'nieuw': return 'Nog niet gebeld';
    default: return '';
  }
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
 * @param {Set<string>} [p.aparteStaarten] laatste 9 cijfers van lopende kaarten in een aparte lijst
 * @param {Set<string>} [p.aparteLeadIds]  leads met een kaart in een aparte lijst
 * @param {boolean}  [p.zonderVenster] ingepland/afgerond zonder termijn (voor een aparte lijst)
 * @param {boolean}  [p.zonderDosering] geen 'later' op due (voor een aparte lijst)
 */
export function stelPottenSamen({
  leads = [], extraLeads = [], kaarten = [], daglijstTelefoons = [], afspraken = [],
  trialPerLead = new Map(), telPerKaart = new Map(), nuMs = Date.now(), wachtUren = 48,
  aparteStaarten = new Set(), aparteLeadIds = new Set(), zonderVenster = false, zonderDosering = false,
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
    const besluit = beslisKandidaat({ lead, calls: rij._calls, kaart, daglijstStaarten, aparteStaarten, aparteLeadIds });
    if (!besluit.in) { telling[besluit.reden] = (telling[besluit.reden] || 0) + 1; continue; }
    delete rij._calls;
    potten.nieuw.push({ ...rij, kaart: null });
  }
  potten.nieuw.sort(sorteerPot);

  // ── De kaarten ──────────────────────────────────────────────────────────
  const leadOpId = new Map([...extraLeads, ...leads].filter((l) => l && l.id).map((l) => [l.id, l]));
  for (const k of kaarten) {
    const pot = potVoorKaart(k, vandaag, nuMs, { zonderVenster, zonderDosering });
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
    const plan = belPlan({ kaart: k, pogingen: (tel && tel.pogingen) || [], nuMs });
    potten[pot].push({ ...basis, kaart: { ...kaartSamenvatting(k, tel, nuMs, wachtUren), plan } });
  }

  // In belronde: wie nu aan de beurt is bovenaan, daarna op volgende ronde.
  const volgendeMs = (r) => {
    const p = r.kaart && r.kaart.plan;
    if (!p || p.klaar) return 0;
    return Date.parse(p.volgende_at || '') || 0;
  };
  potten.terugbellen.sort((a, b) => String(a.kaart.due).localeCompare(String(b.kaart.due)) || b.score - a.score);
  potten.verlopen.sort((a, b) => volgendeMs(a) - volgendeMs(b) || b.score - a.score);
  potten.bezig.sort((a, b) => volgendeMs(a) - volgendeMs(b) ||
    ((a.kaart.plan && a.kaart.plan.rondes) || 0) - ((b.kaart.plan && b.kaart.plan.rondes) || 0) || b.score - a.score);
  potten.wacht.sort((a, b) => (a.kaart.resterende_uren ?? 99) - (b.kaart.resterende_uren ?? 99));
  potten.later.sort((a, b) => String(a.kaart.due).localeCompare(String(b.kaart.due)));
  potten.ingepland.sort((a, b) => String(b.kaart.afspraak_gevonden_at || '').localeCompare(String(a.kaart.afspraak_gevonden_at || '')));
  potten.afgerond.sort((a, b) => String(b.kaart.gearchiveerd_at || '').localeCompare(String(a.kaart.gearchiveerd_at || '')));

  // ── De Belrij: één lijst, van boven naar onder ─────────────────────────
  // Elke rij in hoogstens één sectie. Wie in afkoeling zit (net geprobeerd),
  // staat er niet in — die wacht op zijn volgende ronde.
  const secties = Object.fromEntries(BELRIJ_SECTIES.map((x) => [x.code, 0]));
  let wachtOpRonde = 0;
  let eerstvolgende = null;
  for (const pot of ['nieuw', 'terugbellen', 'verlopen', 'bezig', 'wacht']) {
    for (const r of potten[pot]) {
      const sectie = belrijSectie(r, pot, vandaag);
      if (!sectie) {
        const p = r.kaart && r.kaart.plan;
        if (p && !p.klaar && pot !== 'wacht' && (pot !== 'terugbellen' || String(r.kaart.due) <= vandaag)) {
          wachtOpRonde += 1;
          if (p.volgende_at && (!eerstvolgende || p.volgende_at < eerstvolgende)) eerstvolgende = p.volgende_at;
        }
        continue;
      }
      secties[sectie] += 1;
      const rij = { ...r, sectie, pot };
      rij.waarom = waaromTekst(rij, nuMs);
      potten.belrij.push(rij);
    }
  }
  potten.belrij.sort(sorteerBelrij);
  const dringend = Object.entries(secties).filter(([c]) => BELRIJ_DRINGEND.has(c)).reduce((n, [, v]) => n + v, 0);

  const aantallen = Object.fromEntries(POTTEN.map((p) => [p, potten[p].length]));
  const heet = potten.nieuw.filter((r) => r.label.code === 'heet').length;
  // De badge op de knop in Vandaag: terugbellen + termijn verlopen + nieuwe
  // leads die heet ÉN warm zijn. Alleen heet telde eerst — op 2 okt waren er
  // nul hete leads, en dan licht de knop nooit op terwijl er 20 warme wachten.
  const warmOfHeet = potten.nieuw.filter((r) => r.label.code === 'heet' || r.label.code === 'warm').length;

  return {
    vandaag,
    potten,
    aantallen,
    // De badge op de knop in Vandaag: wat er NU dringend te bellen valt —
    // gereageerd, afgesproken, termijn verlopen, vers/heet en de volgende
    // belronde. Niet de grote rest van Nieuw, niet wie in afkoeling zit.
    badge: dringend,
    belrij: { secties, dringend, wacht_op_ronde: wachtOpRonde, eerstvolgende_at: eerstvolgende,
      eerstvolgende_tekst: eerstvolgende ? momentTekst(eerstvolgende, nuMs) : null },
    nieuw_heet: heet,
    nieuw_warm_of_heet: warmOfHeet,
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
    // Een Meta-bericht dat niet aankwam (failed-status). Alleen tonen als er
    // daarna niets meer verstuurd is: dan is het de laatste stand.
    wa_mislukt: waMislukt(pogingen),
    pogingen,
    archief,
    // Wat Dave na zijn calls aanklikte (geen gehoor, voicemail, terugbellen…).
    uitkomsten: logVan(k).slice(-5),
  };
}

/** De melding van het laatste uitgaande WhatsApp-bericht als dat niet afgeleverd werd. */
export function waMislukt(pogingen) {
  const uit = (Array.isArray(pogingen) ? pogingen : [])
    .filter((p) => p && (p.soort === 'whatsapp' || p.soort === 'spraakbericht') && p.richting !== 'in');
  const laatste = uit[uit.length - 1];
  return laatste && /^WhatsApp niet afgeleverd/i.test(String(laatste.resultaat || '')) ? String(laatste.resultaat) : null;
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
