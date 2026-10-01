// modules/shared/call-uitkomst-categorie.js
//
// DE BROWSER-JAS VAN api/_lib/call-uitkomst-categorie.js.
//
// Wat een call-uitkomst betekent (Sale, Opvolgen / bedenktijd, No show, …)
// staat op één plek; lees de kop van api/_lib/call-uitkomst-categorie.js voor
// het waarom. Dit bestand is een klassiek script (de views in modules/klanten-v2
// zijn geen ES-modules) en hangt de kern op window.CallUitkomstCategorie.
//
// Alles tussen KERN BEGIN en KERN EIND is BYTE VOOR BYTE gelijk aan het
// api-bestand. tests/call-uitkomst-categorie.test.js bewaakt dat, en draait
// beide kopieën op dezelfde invoer. Wijzig de kern in beide bestanden tegelijk.
//
// Geladen in modules/klanten-v2/index.html, vóór de views.

(function () {
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

  const API = Object.freeze({
    CATEGORIEEN: CATEGORIEEN,
    CATEGORIE_KEYS: CATEGORIE_KEYS,
    UITKOMST_NAAR_CATEGORIE: UITKOMST_NAAR_CATEGORIE,
    NIET_INHOUDELIJKE_UITKOMSTEN: NIET_INHOUDELIJKE_UITKOMSTEN,
    BEKENDE_UITKOMSTEN: Object.freeze(
      Object.keys(UITKOMST_NAAR_CATEGORIE).concat(NIET_INHOUDELIJKE_UITKOMSTEN),
    ),
    afspraakStaat: afspraakStaat,
    categorieVoorUitkomst: categorieVoorUitkomst,
    categorieVoorAfspraak: categorieVoorAfspraak,
    categorieInfo: categorieInfo,
  });

  if (typeof window !== 'undefined') window.CallUitkomstCategorie = API;
})();
