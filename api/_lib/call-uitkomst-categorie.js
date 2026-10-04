// api/_lib/call-uitkomst-categorie.js
//
// WAT BETEKENT DE UITKOMST VAN EEN CALL — ÉÉN PLEK, VOOR SERVER EN SCHERM.
//
// `follow_up_appointments.uitkomst` draagt de woorden van de uitkomstmotor
// (api/follow-up-appointment-outcome.js): gesprek_gehad, sale, wilt_niet_meer,
// niet_geschikt, no_show, later_opnieuw, terugbel, geen_geld, onbereikbaar, …
// Dat zijn motor-woorden, geen rapport-woorden. Drie ervan betekenen voor een
// rapport hetzelfde ('Opvolgen / bedenktijd'), en een rij zonder uitkomst is
// pas te duiden met de status en de klok erbij.
//
// Die vertaling staat HIER en nergens anders. Een rapport, een dashboard of een
// scherm dat zelf een tabelletje 'gesprek_gehad → …' bijhoudt loopt vroeg of
// laat uiteen met de rest — en dan zegt het ene scherm 'Opvolgen' en het andere
// 'Gesprek gehad' over dezelfde call.
//
// ── TWEE BESTANDEN, ÉÉN KERN ─────────────────────────────────────────────
// De views in modules/klanten-v2 zijn klassieke scripts en kunnen niet uit
// api/_lib importeren; de api kan niet uit modules/shared importeren (dat is
// geen ES-module). Dus staat dezelfde kern in twee jassen:
//   - dit bestand (ES-module, voor de api en de tests);
//   - modules/shared/call-uitkomst-categorie.js (klassiek script, hangt
//     window.CallUitkomstCategorie op; geladen in modules/klanten-v2/index.html).
// Alles tussen KERN BEGIN en KERN EIND is in beide bestanden BYTE VOOR BYTE
// gelijk; tests/call-uitkomst-categorie.test.js vergelijkt de tekst én draait
// beide op dezelfde invoer. Wijzig je de kern, kopieer hem dan naar beide.
//
// ── WAAROM callStaat HIER NAGEBOUWD IS EN NIET GEÏMPORTEERD ──────────────
// callStaat staat in api/opvolging-rapport.js, en dat bestand haalt supabase,
// de werkritme-helpers en meer binnen. Een browser-script kan dat niet laden,
// en een pure helper hoort geen databank-client mee te slepen. afspraakStaat()
// hieronder is een kopie van exact die regels; de test draait hem naast de
// echte callStaat over alle statussen en tijdstippen en eist hetzelfde
// antwoord. Wijzigt callStaat, dan faalt die test.
//
// ── NIETS VERDWIJNT ──────────────────────────────────────────────────────
// Een onbekende uitkomst wordt 'Onbekend', geen stille 'Nog niet vastgelegd'
// en zeker geen weggelaten rij. Een onbekende status zonder uitkomst ook. Wie
// telt, telt elke rij; wat we niet kunnen duiden staat er met die naam bij.

// ── KERN BEGIN ──────────────────────────────────────────────────────────────
const CATEGORIEEN = Object.freeze([
  Object.freeze({ key: 'sale',                  label: 'Sale',                   kleur: '#16a34a', volgorde: 1 }),
  Object.freeze({ key: 'opvolgen',              label: 'Opvolgen / bedenktijd',  kleur: '#d97706', volgorde: 2 }),
  Object.freeze({ key: 'geen_interesse',        label: 'Geen interesse',         kleur: '#6b7280', volgorde: 3 }),
  Object.freeze({ key: 'geen_geld',             label: 'Geen geld',              kleur: '#a16207', volgorde: 4 }),
  Object.freeze({ key: 'niet_gekwalificeerd',   label: 'Niet gekwalificeerd',    kleur: '#7c3aed', volgorde: 5 }),
  Object.freeze({ key: 'no_show',               label: 'No show',                kleur: '#dc2626', volgorde: 6 }),
  Object.freeze({ key: 'onbereikbaar',          label: 'Onbereikbaar',           kleur: '#ea580c', volgorde: 7 }),
  Object.freeze({ key: 'nieuw_moment',          label: 'Nieuw moment ingepland', kleur: '#2563eb', volgorde: 8 }),
  Object.freeze({ key: 'wacht_op_nieuw_moment', label: 'Wacht op nieuw moment',  kleur: '#60a5fa', volgorde: 9 }),
  Object.freeze({ key: 'geannuleerd',           label: 'Geannuleerd',            kleur: '#9ca3af', volgorde: 10 }),
  Object.freeze({ key: 'gepland',               label: 'Gepland',                kleur: '#0ea5e9', volgorde: 11 }),
  Object.freeze({ key: 'nog_niet_vastgelegd',   label: 'Nog niet vastgelegd',    kleur: '#e11d48', volgorde: 12 }),
  Object.freeze({ key: 'onbekend',              label: 'Onbekend',               kleur: '#111827', volgorde: 13 }),
]);

const CATEGORIE_KEYS = Object.freeze(CATEGORIEEN.map(function (c) { return c.key; }));

/** Motor-woord → categorie. Alleen de uitkomsten die iets over het gesprek zeggen. */
const UITKOMST_NAAR_CATEGORIE = Object.freeze({
  sale          : 'sale',
  gesprek_gehad : 'opvolgen',
  later_opnieuw : 'opvolgen',
  terugbel      : 'opvolgen',
  wilt_niet_meer: 'geen_interesse',
  niet_geschikt : 'niet_gekwalificeerd',
  no_show       : 'no_show',
  geen_geld     : 'geen_geld',
  onbereikbaar  : 'onbereikbaar',
});

// Motor-woorden die NIETS over het gesprek zeggen: de afspraak is verzet of
// geannuleerd. Die worden behandeld als 'geen uitkomst' en vallen terug op de
// status — net als een lege uitkomst. Ze zijn bekend, dus niet 'Onbekend'.
const NIET_INHOUDELIJKE_UITKOMSTEN = Object.freeze(['verzetten', 'annuleren']);

// Kopie van callStaat (api/opvolging-rapport.js). Niet aanpassen zonder
// callStaat mee te nemen; de test vergelijkt ze.
const AFSPRAAK_BEOORDEELBAAR = Object.freeze(['scheduled', 'in_progress', 'completed', 'no_show']);
const AFSPRAAK_SPELING_MIN = 15;
const AFSPRAAK_STANDAARD_DUUR_MIN = 30;

function afspraakStaat(a, nuMs) {
  const status = String(a.status || 'scheduled');
  if (status === 'cancelled')  return 'geannuleerd';
  if (status === 'verplaatst') return 'verplaatst';
  if (AFSPRAAK_BEOORDEELBAAR.indexOf(status) < 0) return 'onbeoordeelbaar';
  const start = Date.parse(a.scheduled_at);
  if (!Number.isFinite(start)) return 'te_beoordelen';
  const duur = Number.isFinite(a.duration_minutes) && a.duration_minutes > 0
    ? a.duration_minutes : AFSPRAAK_STANDAARD_DUUR_MIN;
  const klaar = start + (duur + AFSPRAAK_SPELING_MIN) * 60000;
  return nuMs < klaar ? 'gepland' : 'te_beoordelen';
}

function normaliseerUitkomst(u) {
  return u == null ? '' : String(u).trim().toLowerCase();
}

/**
 * Categorie voor een losse uitkomst-waarde.
 * @returns {?string} categorie-key; null bij een lege of niet-inhoudelijke
 *   uitkomst (dan beslist de status); 'onbekend' bij een onbekend woord.
 */
function categorieVoorUitkomst(uitkomst) {
  const u = normaliseerUitkomst(uitkomst);
  if (!u) return null;
  if (NIET_INHOUDELIJKE_UITKOMSTEN.indexOf(u) >= 0) return null;
  return Object.prototype.hasOwnProperty.call(UITKOMST_NAAR_CATEGORIE, u)
    ? UITKOMST_NAAR_CATEGORIE[u] : 'onbekend';
}

/**
 * De categorie van één afspraak-rij. Geeft ALTIJD een key uit CATEGORIE_KEYS.
 *
 * Volgorde:
 *   1. een inhoudelijke uitkomst wint (wat er besloten is blijft staan, ook
 *      als de afspraak daarna verzet werd);
 *   2. status cancelled / verwijderd       → geannuleerd;
 *   3. status verplaatst of een opvolger   → nieuw_moment;
 *   4. status wacht_op_reschedule          → wacht_op_nieuw_moment;
 *   5. de klok via afspraakStaat: nog niet voorbij → gepland,
 *      voorbij zonder uitkomst → nog_niet_vastgelegd;
 *   6. alles wat overblijft                → onbekend.
 *
 * @param {object} appt  rij met minstens status, scheduled_at, uitkomst
 * @param {{nuMs?:number, heeftOpvolger?:boolean}} [opties]
 *   heeftOpvolger: er bestaat een rij met parent_appointment_id = appt.id.
 */
function categorieVoorAfspraak(appt, opties) {
  const a = appt || {};
  const o = opties || {};
  const nuMs = Number.isFinite(o.nuMs) ? o.nuMs : Date.now();

  const viaUitkomst = categorieVoorUitkomst(a.uitkomst);
  if (viaUitkomst) return viaUitkomst;

  const status = String(a.status || 'scheduled');
  if (status === 'cancelled' || status === 'verwijderd') return 'geannuleerd';
  if (status === 'verplaatst' || o.heeftOpvolger === true) return 'nieuw_moment';
  if (status === 'wacht_op_reschedule') return 'wacht_op_nieuw_moment';

  const staat = afspraakStaat(a, nuMs);
  if (staat === 'gepland') return 'gepland';
  if (staat === 'te_beoordelen') return 'nog_niet_vastgelegd';
  return 'onbekend';
}

/** De categorie-definitie (label, kleur, volgorde) bij een key; onbekend als terugval. */
function categorieInfo(key) {
  for (let i = 0; i < CATEGORIEEN.length; i += 1) {
    if (CATEGORIEEN[i].key === key) return CATEGORIEEN[i];
  }
  return CATEGORIEEN[CATEGORIEEN.length - 1];
}
// ── KERN EIND ───────────────────────────────────────────────────────────────

/** De motor-woorden die deze module kent (inhoudelijk + niet-inhoudelijk). */
export const BEKENDE_UITKOMSTEN = Object.freeze(
  Object.keys(UITKOMST_NAAR_CATEGORIE).concat(NIET_INHOUDELIJKE_UITKOMSTEN),
);

export {
  CATEGORIEEN,
  CATEGORIE_KEYS,
  UITKOMST_NAAR_CATEGORIE,
  NIET_INHOUDELIJKE_UITKOMSTEN,
  afspraakStaat,
  categorieVoorUitkomst,
  categorieVoorAfspraak,
  categorieInfo,
};
