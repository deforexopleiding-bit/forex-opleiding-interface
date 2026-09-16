// api/_lib/factuurstand-spiegel.js
//
// DE spiegel van de CRM-factuurstand naar het LMS. Eén functie, één schrijver.
//
// ── WAAROM ────────────────────────────────────────────────────────────────
// Het LMS krijgt een opvolgsysteem voor mentoren met één harde regel: één
// vervallen factuur is iets om te bespreken, twee of meer is een rood
// signaal. Het LMS kan niet bij het CRM, en het CRM blijft de bron voor
// facturen (beslissing optie B, 5 september 2026). Dus schrijft het CRM een
// spiegel: `hlms_crm_factuurstand`, één rij per actieve mentorship-student.
//
// Dit bestand is de hele spiegel. Het bepaalt WAT er geteld wordt, WELKE
// klant bij welke student hoort, en het is de enige plek die schrijft.
//
// ── ÉÉN SCHRIJVER, EN DAT IS EEN HARDE REGEL ─────────────────────────────
// `hlms_crm_factuurstand` wordt UITSLUITEND vanuit dit bestand geschreven.
// tests/factuurstand-spiegel.test.js wordt rood zodra een ander bestand naar
// die tabel schrijft. Zelfde afspraak, zelfde reden als bij
// api/_lib/onboarding-spiegel.js: er zijn een stuk of tien schrijfpunten op
// `invoices`, en bij tien is het geen kwestie óf er eentje ooit afwijkt.
//
// ── DE HERSYNC IS DE WAARHEID, DE AANROEP IS SNELHEID ────────────────────
// `api/cron/factuurstand-spiegel-sync.js` draait dit dagelijks voor iedereen.
// De aanroep bij een factuurwijziging (betaald / gecrediteerd / TL-sync) is
// er alleen zodat het meteen klopt. Vergeet iemand later een aanroep bij een
// nieuw endpoint — en dat gebeurt — dan is dat hooguit een dag vertraging in
// plaats van een stille afwijking die niemand ooit ziet.
//
// ── LEEG EN NIET-GELUKT ZIJN NOOIT HETZELFDE ─────────────────────────────
// De regel uit api/_lib/dfo-lms-sessies.js geldt hier onverkort, en hij is
// hier zelfs scherper dan elders, want deze getallen STUREN GEDRAG in het
// LMS. Drie bronstanden, en ze betekenen alle drie iets anders:
//
//   'gelezen'        het CRM is gelezen. 0 vervallen betekent dan ECHT 0.
//   'niet_gekoppeld' er is geen klant gevonden bij deze student. De nullen
//                    in die rij betekenen NIETS; het LMS opent er geen
//                    signaal op.
//   'onbereikbaar'   het CRM kon niet gelezen worden. De vorige getallen
//                    blijven staan — nooit overschrijven met nul.
//
// ── DE "TE LAAT"-GRENS IS DIE VAN JOOST, NIET EEN TWEEDE ─────────────────
// `isOverdue()` uit api/_lib/dunning-overdue-guard.js is de poort die de
// wanbetalersmotor gebruikt om te bepalen of een factuur te laat is. Die
// functie wordt hier HERGEBRUIKT, inclusief de instelbare gratieperiode
// (`app_settings.dunning_grace_days`). Er staat geen tweede definitie in dit
// bestand, en tests/factuurstand-spiegel.test.js houdt de twee tegen elkaar.
//
// Tijdzone: de guard rekent in Europe/Amsterdam. De opdracht zegt
// Europe/Brussels. Dat is dezelfde klok — beide staan het hele jaar op
// CET/CEST met identieke overgangen — dus dit is letterlijk dezelfde grens
// en niet een benadering ervan. Eén tijdzone-constante is meer waard dan een
// tweede die toevallig gelijk uitvalt.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { OPEN_INVOICE_STATUSES } from './dunning-pipeline.js';
import {
  isOverdue, todayIsoInTz, readGraceDaysSetting, DEFAULT_GRACE_DAYS,
} from './dunning-overdue-guard.js';

export const SPIEGEL_TABEL = 'hlms_crm_factuurstand';

// De drie bronstanden. Deze woorden staan in de CHECK-constraint van de
// LMS-tabel; ze zijn met opzet met een liggend streepje geschreven zoals het
// LMS ze verwacht, en dus NIET identiek aan de koppeltekens van
// api/_lib/dfo-lms-sessies.js ('niet-geconfigureerd'). Vertaal ze hier, niet
// verderop: de leeskant is het LMS en die kent maar drie woorden.
export const BRON_GELEZEN       = 'gelezen';
export const BRON_NIET_GEKOPPELD = 'niet_gekoppeld';
export const BRON_ONBEREIKBAAR  = 'onbereikbaar';

// Uitkomsten van spiegelFactuurstandVoorStudent().
export const SPIEGEL_GESCHREVEN     = 'geschreven';
export const SPIEGEL_BEHOUDEN       = 'behouden';        // onbereikbaar: oude getallen blijven staan
export const SPIEGEL_VERWIJDERD     = 'verwijderd';
export const SPIEGEL_MISLUKT        = 'mislukt';
export const SPIEGEL_TABEL_ONTBREEKT = 'tabel-ontbreekt'; // het LMS heeft 'm nog niet aangemaakt

// Het product dat een mentor heeft. Een membership-student heeft geen mentor
// en dus ook geen mentoropvolging; die krijgt geen rij. Zelfde woordenlijst
// als api/_lib/dfo-lms-student.js — daar wordt 'ie geschreven, hier gelezen.
export const PRODUCT_MENTORSHIP = 'mentorship';

// Kolommen die we op hlms_student lezen. Alle zes zijn bewezen aanwezig: ze
// worden in api/_lib/dfo-lms-student.js geschreven of in
// api/_lib/dfo-lms-sessies.js gelezen. Geen enkele kolomnaam is hier bedacht
// — dat is precies de fout die de onboarding-spiegel op 25 rijen liet vallen.
const STUDENT_KOLOMMEN =
  'id, email, voornaam, achternaam, product_soort, start_datum, eind_datum, ' +
  'bubble_user_id, crm_onboarding_id';

const FACTUUR_KOLOMMEN =
  'id, customer_id, amount_total, amount_paid, credited_amount, due_date, ' +
  'status, invoice_number, is_test, is_historical';

// ───────────────────────────────────────────────────────────────────────────
// 1) DE DEFINITIE — puur, en dus toetsbaar zonder databank
// ───────────────────────────────────────────────────────────────────────────

/** Twee decimalen, zonder drijvende-komma-ruis. */
function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Wat er van een factuur nog openstaat: totaal − betaald − gecrediteerd,
 * geklemd op 0. Exact dezelfde som als `openAmount()` in
 * api/_lib/dunning-engine.js en `dunning-template-render.js`; die staan daar
 * lokaal en privé, vandaar deze derde. Wijkt er ooit eentje af, dan valt de
 * tegenproef in tests/factuurstand-spiegel.test.js om.
 *
 * PURE.
 */
export function restbedrag(inv) {
  const totaal      = Number(inv?.amount_total) || 0;
  const betaald     = Number(inv?.amount_paid) || 0;
  const gecrediteerd = Number(inv?.credited_amount) || 0;
  return Math.max(0, r2(totaal - betaald - gecrediteerd));
}

/**
 * Telt deze factuur mee als OPENSTAAND?
 *
 * Drie eisen, en alle drie zijn ze een beslissing:
 *
 *  1. STATUS uit `OPEN_INVOICE_STATUSES` — de gedeelde lijst uit
 *     api/_lib/dunning-pipeline.js: open / partially_paid / overdue. De
 *     opdracht schreef "status open"; dat is op productie (gemeten 16
 *     september 2026: paid 1.545 / open 343 / concept 77) vandaag hetzelfde,
 *     want er staat geen enkele rij op partially_paid of overdue. Toch de
 *     gedeelde lijst: zodra er ooit één rij half betaald wordt, hoort die
 *     mee te tellen en hoort dat niet van een tweede lijstje af te hangen.
 *     CONCEPT telt nergens mee — een concept is nog geen vordering.
 *  2. GEEN TESTRIJ. `is_test` is de sandbox-vlag van de wanbetalersmotor.
 *  3. RESTBEDRAG > 0. Een factuur die volledig gecrediteerd of volledig
 *     betaald is maar nog op 'open' staat, is geen vordering meer.
 *
 * `is_historical` staat hier BEWUST NIET bij. Zie de notitie onderaan dit
 * bestand: de kolom wordt nergens op true gezet en de wanbetalersmotor
 * filtert er ook niet op. Meetellen is dus hetzelfde antwoord als Joost geeft.
 *
 * PURE.
 */
export function teltMeeAlsOpen(inv) {
  if (!inv) return false;
  if (inv.is_test === true) return false;
  if (!OPEN_INVOICE_STATUSES.includes(String(inv.status || '').trim().toLowerCase())) return false;
  return restbedrag(inv) > 0;
}

/**
 * De vier getallen voor één klant.
 *
 * @param {Array<object>} facturen  rijen uit `invoices`
 * @param {{todayIso: string, graceDays?: number}} opties
 * @returns {{open_aantal: number, vervallen_aantal: number,
 *            oudste_vervaldatum: string|null, openstaand_bedrag: number}}
 *
 * `oudste_vervaldatum` is de OUDSTE vervaldatum onder de VERVALLEN facturen
 * — niet onder alle openstaande. Een klant met één factuur die pas volgende
 * maand vervalt hoort daar geen datum te krijgen: die datum zou in het LMS
 * lezen als "loopt al zo lang", terwijl er nog niets te laat is.
 *
 * PURE.
 */
export function telFactuurstand(facturen, { todayIso, graceDays = DEFAULT_GRACE_DAYS } = {}) {
  let open = 0;
  let vervallen = 0;
  let bedrag = 0;
  let oudste = null;

  for (const inv of (Array.isArray(facturen) ? facturen : [])) {
    if (!teltMeeAlsOpen(inv)) continue;
    open += 1;
    bedrag += restbedrag(inv);

    // DE grens van de wanbetalersmotor, hergebruikt. Geen eigen vergelijking.
    if (!isOverdue(inv.due_date, todayIso, graceDays)) continue;
    vervallen += 1;
    const dag = String(inv.due_date).slice(0, 10);
    if (!oudste || dag < oudste) oudste = dag;
  }

  return {
    open_aantal        : open,
    vervallen_aantal   : vervallen,
    oudste_vervaldatum : oudste,
    openstaand_bedrag  : r2(bedrag),
  };
}

/**
 * Hoort deze student een rij in de spiegel te hebben?
 *
 * Twee eisen. MENTORSHIP, want membership-studenten hebben geen mentor die
 * ze opvolgt. En ACTIEF, wat hier betekent: het traject is nog niet
 * afgelopen. Een eind_datum die ontbreekt leest als "loopt door" — dat is de
 * voorzichtige kant, want een student die ten onrechte in de lijst staat is
 * zichtbaar en corrigeerbaar, eentje die er ten onrechte uit valt niet.
 *
 * Er is aan LMS-kant GEEN `actief`-kolom op hlms_student (wel op
 * hlms_personeel). Vandaar deze afleiding uit de einddatum, en vandaar dat
 * de droogloop apart meldt hoeveel studenten er op welke grond afvielen.
 *
 * PURE.
 */
export function isActieveMentorshipStudent(student, todayIso) {
  if (!student) return false;
  if (String(student.product_soort || '').trim().toLowerCase() !== PRODUCT_MENTORSHIP) return false;
  const eind = student.eind_datum ? String(student.eind_datum).slice(0, 10) : null;
  if (!eind) return true;
  return eind >= String(todayIso).slice(0, 10);
}

// ───────────────────────────────────────────────────────────────────────────
// 2) DE KOPPELING — welke klant hoort bij deze student
// ───────────────────────────────────────────────────────────────────────────

// De drie wegen, in volgorde van zekerheid. De namen komen terug in de
// droogloop, zodat de matchgraad per weg te lezen is.
export const VIA_ONBOARDING = 'onboarding';   // onboardings.dfo_lms_student_id
export const VIA_BUBBLE     = 'bubble';       // onboardings.bubble_user_id
export const VIA_EMAIL      = 'email';        // lower(customers.email)

export const REDEN_GEEN_KANDIDAAT   = 'geen-klant-gevonden';
export const REDEN_MEERDERE_KLANTEN = 'meerdere-klanten';
export const REDEN_GEEN_EMAIL       = 'student-zonder-email';

/**
 * Kies de klant uit de kandidaten van de drie wegen.
 *
 * De volgorde is hard: een zekere koppeling wint altijd van een
 * waarschijnlijke. Pas als een weg NIETS oplevert, gaan we een stap lager.
 *
 * TWEE KANDIDATEN IS GEEN KEUZE. Levert een weg meer dan één verschillende
 * klant op, dan koppelen we NIET en melden we het. Dat is de regel die Maxim
 * expliciet gesteld heeft (het bekende geval: dezelfde persoon onder twee
 * adressen, ER Schilderwerken) en het is ook de enige eerlijke: de spiegel
 * stuurt gedrag in het LMS, en een gok zou betekenen dat een mentor een
 * student aanspreekt op de factuur van iemand anders. We vallen dan ook NIET
 * terug op een lagere weg — dubbelzinnigheid op een zekerdere weg is een
 * gegevensprobleem dat een mens hoort te zien, geen reden om te raden.
 *
 * PURE.
 *
 * @param {{onboarding?: string[], bubble?: string[], email?: string[]}} kandidaten
 *   per weg de gevonden customer_id's (mogen duplicaten bevatten).
 * @returns {{customer_id: string|null, via: string|null, reden: string|null}}
 */
export function kiesKlant(kandidaten = {}) {
  const wegen = [
    [VIA_ONBOARDING, kandidaten.onboarding],
    [VIA_BUBBLE,     kandidaten.bubble],
    [VIA_EMAIL,      kandidaten.email],
  ];

  for (const [via, ruw] of wegen) {
    const uniek = Array.from(new Set(
      (Array.isArray(ruw) ? ruw : []).map((v) => String(v || '').trim()).filter(Boolean)
    ));
    if (uniek.length === 0) continue;
    if (uniek.length === 1) return { customer_id: uniek[0], via, reden: null };
    return { customer_id: null, via, reden: REDEN_MEERDERE_KLANTEN };
  }

  return { customer_id: null, via: null, reden: REDEN_GEEN_KANDIDAAT };
}

/**
 * Een klant telt alleen mee als kandidaat als het een ECHTE klant is.
 * Testrijen doen niet mee — zelfde regel als de inhaalslag in
 * api/_lib/onboarding-lms-backfill.js, en om dezelfde reden: de
 * testonboarding stond daar gewoon tussen de kandidaten.
 *
 * PURE.
 */
export function isEchteKlant(klant) {
  if (!klant) return false;
  if (klant.is_test === true) return false;
  return true;
}

/**
 * Zoek de klantkandidaten voor één student, in het CRM.
 *
 * Deze functie doet GEEN keuze — dat doet kiesKlant(). Hier wordt alleen
 * verzameld, zodat de droogloop kan laten zien wat elke weg opleverde en de
 * keuze zelf een pure functie blijft.
 *
 * @param {object} student rij uit hlms_student
 * @param {{db?: object, index?: object}} ctx
 *   `index` is de voorgeladen verzameling van de nachtelijke ronde; ontbreekt
 *   die, dan zoekt deze functie per student. Beide wegen leveren dezelfde
 *   kandidaten op — het verschil is alleen hoeveel bevragingen het kost.
 */
export async function zoekKlantKandidaten(student, ctx = {}) {
  const db = ctx.db || supabaseAdmin;
  const email = String(student?.email || '').trim().toLowerCase();
  const bubble = String(student?.bubble_user_id || '').trim();
  const studentId = String(student?.id || '').trim();

  if (ctx.index) {
    return {
      onboarding: ctx.index.perStudentId.get(studentId) || [],
      bubble    : bubble ? (ctx.index.perBubbleId.get(bubble) || []) : [],
      email     : email  ? (ctx.index.perEmail.get(email) || []) : [],
    };
  }

  // Losse weg: één bevraging op onboardings (beide kolommen tegelijk) en één
  // op customers. Gebruikt door de aanroep na een factuurwijziging.
  const uit = { onboarding: [], bubble: [], email: [] };

  const filters = [];
  if (studentId) filters.push('dfo_lms_student_id.eq.' + studentId);
  if (bubble)    filters.push('bubble_user_id.eq.' + bubble);
  if (filters.length > 0) {
    const { data, error } = await db
      .from('onboardings')
      .select('id, customer_id, dfo_lms_student_id, bubble_user_id, is_test')
      .or(filters.join(','));
    if (error) throw new Error('onboardings lezen: ' + error.message);
    for (const ob of (data || [])) {
      if (ob?.is_test === true || !ob?.customer_id) continue;
      if (studentId && String(ob.dfo_lms_student_id || '') === studentId) uit.onboarding.push(ob.customer_id);
      else if (bubble && String(ob.bubble_user_id || '') === bubble)      uit.bubble.push(ob.customer_id);
    }
  }

  if (email) {
    const { data, error } = await db
      .from('customers')
      .select('id, email, is_test')
      .ilike('email', email);
    if (error) throw new Error('customers lezen: ' + error.message);
    // `ilike` zonder jokertekens is al exact, maar `%` en `_` in een
    // e-mailadres zouden het patroon oprekken. Daarom de na-controle in JS,
    // net als in api/_lib/dfo-lms-student.js.
    for (const k of (data || [])) {
      if (!isEchteKlant(k)) continue;
      if (String(k.email || '').trim().toLowerCase() === email) uit.email.push(k.id);
    }
  }

  return uit;
}

// ───────────────────────────────────────────────────────────────────────────
// 3) DE SCHRIJFBESLISSING — wat er gebeurt als het CRM niet te lezen is
// ───────────────────────────────────────────────────────────────────────────

/**
 * Wat schrijven we als de bron onbereikbaar was?
 *
 * Bestond er al een rij, dan raken we de GETALLEN NIET AAN: alleen
 * `bron_status`, `bron_fout` en `bijgewerkt_op` gaan mee. De vorige stand
 * blijft staan, en aan de tijdstempel is te zien dat hij stilstaat. Dat is
 * de regel uit de opdracht, en het is ook de enige die klopt: een mislukte
 * lezing is geen uitspraak over de factuurstand van deze klant.
 *
 * Bestond er nog GEEN rij, dan schrijven we er wel één, met nullen en
 * `bron_status='onbereikbaar'`. Die nullen zeggen niets — dat is precies wat
 * de bronstand meldt — maar een rij die zegt "ik weet het niet" is meer waard
 * dan helemaal geen rij, want geen rij ziet er in het LMS identiek uit als
 * een student die nog nooit gespiegeld is.
 *
 * PURE.
 */
export function bepaalOnbereikbaarPatch(bestaand, fout, nuIso) {
  if (bestaand) {
    return {
      bron_status  : BRON_ONBEREIKBAAR,
      bron_fout    : fout || 'onbekend',
      bijgewerkt_op: nuIso,
    };
  }
  return {
    vervallen_aantal  : 0,
    open_aantal       : 0,
    oudste_vervaldatum: null,
    openstaand_bedrag : null,
    bron_status       : BRON_ONBEREIKBAAR,
    bron_fout         : fout || 'onbekend',
    bijgewerkt_op     : nuIso,
  };
}

/** Postgres undefined_table. Betekent hier: het LMS heeft de tabel nog niet. */
export function isTabelOntbreekt(error) {
  if (!error) return false;
  if (String(error.code || '') === '42P01') return true;
  const m = String(error.message || '').toLowerCase();
  return m.includes('does not exist') || m.includes('could not find the table')
      || m.includes('schema cache');
}

// ───────────────────────────────────────────────────────────────────────────
// 4) DE SPIEGEL ZELF
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bouw de leescontext: de LMS-cliënt, de dag van vandaag en de
 * gratieperiode van de wanbetalersmotor. Eén keer per ronde, zodat elke
 * student in dezelfde ronde op dezelfde dag en dezelfde grens gemeten wordt.
 */
export async function maakContext(opties = {}) {
  const db  = opties.db || supabaseAdmin;
  const lms = opties.lmsClient || getDfoLmsClient();
  const todayIso = opties.todayIso || todayIsoInTz(opties.nu || new Date());
  const graceDays = Number.isFinite(Number(opties.graceDays))
    ? Number(opties.graceDays)
    : await readGraceDaysSetting(db);
  return { db, lms, todayIso, graceDays, index: opties.index || null };
}

/**
 * Lees de openstaande facturen van één of meer klanten.
 *
 * Gooit bij een leesfout — dat is met opzet. De aanroeper zet daarop
 * `bron_status='onbereikbaar'` en laat de oude getallen staan; een lege lijst
 * teruggeven zou "deze klant heeft niets openstaan" betekenen en dat is een
 * heel ander bericht.
 */
export async function leesOpenFacturen(db, customerIds = null) {
  const ids = customerIds ? Array.from(new Set(customerIds.filter(Boolean))) : null;
  if (ids && ids.length === 0) return [];

  const rijen = [];
  const PAGINA = 1000;
  // Eigen paginering in plaats van fetchAllRows() uit dunning-engine.js: die
  // import zou de hele aanmaanmotor (templates, Meta-verzending, arrangement-
  // hooks) meeslepen voor twaalf regels. De grens van 1000 rijen die
  // PostgREST stil trekt is hier even echt; alleen de kosten van de oplossing
  // verschillen.
  for (let van = 0; van < 100000; van += PAGINA) {
    let q = db.from('invoices').select(FACTUUR_KOLOMMEN)
      .in('status', OPEN_INVOICE_STATUSES)
      .eq('is_test', false);
    if (ids) q = q.in('customer_id', ids);
    const { data, error } = await q.range(van, van + PAGINA - 1);
    if (error) throw new Error('invoices lezen: ' + error.message);
    const blok = Array.isArray(data) ? data : [];
    rijen.push(...blok);
    if (blok.length < PAGINA) break;
  }
  return rijen;
}

/**
 * Spiegel de factuurstand van ÉÉN student.
 *
 * Gooit NOOIT. De aanroeper krijgt een uitkomst terug en beslist zelf.
 *
 * @param {object} student rij uit hlms_student (minimaal id, email,
 *   product_soort, bubble_user_id)
 * @param {object} ctx uit maakContext()
 * @param {{facturen?: Array, dry?: boolean}} [opties]
 *   `facturen` is de voorgeladen set van de nachtelijke ronde; ontbreekt die,
 *   dan worden ze hier per klant gelezen.
 * @returns {Promise<object>} { resultaat, bron_status, via, reden, rij, fout }
 */
export async function spiegelFactuurstandVoorStudent(student, ctx, opties = {}) {
  const studentId = String(student?.id || '').trim();
  const nuIso = new Date().toISOString();

  if (!studentId) {
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_ONBEREIKBAAR,
      via: null, reden: null, fout: 'student zonder id' };
  }
  if (!ctx?.lms) {
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_ONBEREIKBAAR,
      via: null, reden: null, fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt' };
  }

  // ── 1) De klant zoeken ────────────────────────────────────────────────
  let keuze;
  let kandidaten = null;
  try {
    kandidaten = await zoekKlantKandidaten(student, ctx);
    keuze = kiesKlant(kandidaten);
    if (!keuze.customer_id && !String(student?.email || '').trim()
        && keuze.reden === REDEN_GEEN_KANDIDAAT) {
      keuze = { ...keuze, reden: REDEN_GEEN_EMAIL };
    }
  } catch (e) {
    // Het CRM is niet te lezen. Dat is iets ANDERS dan "geen klant": de
    // eerste laat de oude getallen staan, de tweede zet ze op nul.
    return await schrijfOnbereikbaar(ctx, studentId, 'koppeling: ' + (e?.message || e), nuIso, opties);
  }

  // ── 2) Geen klant → nullen die niets betekenen ────────────────────────
  if (!keuze.customer_id) {
    const rij = {
      student_id        : studentId,
      vervallen_aantal  : 0,
      open_aantal       : 0,
      oudste_vervaldatum: null,
      // Bewust null en niet 0.00: bij 'niet_gekoppeld' is er geen bedrag
      // bekend, en 0,00 euro leest als "niets openstaand".
      openstaand_bedrag : null,
      bron_status       : BRON_NIET_GEKOPPELD,
      bron_fout         : keuze.reden || REDEN_GEEN_KANDIDAAT,
      bijgewerkt_op     : nuIso,
    };
    return await schrijfRij(ctx, rij, opties, {
      via: keuze.via, reden: keuze.reden, bron_status: BRON_NIET_GEKOPPELD,
    });
  }

  // ── 3) De facturen tellen ─────────────────────────────────────────────
  let stand;
  try {
    const facturen = opties.facturen
      ? opties.facturen.filter((f) => String(f.customer_id) === String(keuze.customer_id))
      : await leesOpenFacturen(ctx.db, [keuze.customer_id]);
    stand = telFactuurstand(facturen, { todayIso: ctx.todayIso, graceDays: ctx.graceDays });
  } catch (e) {
    return await schrijfOnbereikbaar(ctx, studentId, e?.message || String(e), nuIso, opties);
  }

  const rij = {
    student_id        : studentId,
    vervallen_aantal  : stand.vervallen_aantal,
    open_aantal       : stand.open_aantal,
    oudste_vervaldatum: stand.oudste_vervaldatum,
    openstaand_bedrag : stand.openstaand_bedrag,
    bron_status       : BRON_GELEZEN,
    bron_fout         : null,
    bijgewerkt_op     : nuIso,
  };
  return await schrijfRij(ctx, rij, opties, {
    via: keuze.via, reden: null, bron_status: BRON_GELEZEN,
    customer_id: keuze.customer_id,
  });
}

/** De enige plek waar er inhoud naar de spiegeltabel gaat. */
async function schrijfRij(ctx, rij, opties, extra) {
  if (opties.dry) {
    return { resultaat: SPIEGEL_GESCHREVEN, fout: null, rij, dry: true, ...extra };
  }
  const { error } = await ctx.lms.from(SPIEGEL_TABEL).upsert(rij, { onConflict: 'student_id' });
  if (error) {
    if (isTabelOntbreekt(error)) {
      return { resultaat: SPIEGEL_TABEL_ONTBREEKT, fout: error.message, rij, ...extra };
    }
    console.error('[factuurstand-spiegel] ' + rij.student_id + ': ' + error.message);
    return { resultaat: SPIEGEL_MISLUKT, fout: 'spiegel schrijven: ' + error.message, rij, ...extra };
  }
  return { resultaat: SPIEGEL_GESCHREVEN, fout: null, rij, ...extra };
}

/**
 * Bron onbereikbaar. Eerst kijken wat er staat, dan pas beslissen wat er
 * geschreven wordt — zie bepaalOnbereikbaarPatch().
 */
async function schrijfOnbereikbaar(ctx, studentId, fout, nuIso, opties) {
  console.error('[factuurstand-spiegel] ' + studentId + ': ' + fout);

  let bestaand = null;
  try {
    const { data, error } = await ctx.lms
      .from(SPIEGEL_TABEL).select('student_id').eq('student_id', studentId).maybeSingle();
    if (error) {
      if (isTabelOntbreekt(error)) {
        return { resultaat: SPIEGEL_TABEL_ONTBREEKT, bron_status: BRON_ONBEREIKBAAR,
          via: null, reden: null, fout };
      }
      throw new Error(error.message);
    }
    bestaand = data || null;
  } catch (e) {
    // Ook de spiegel zelf is niet te lezen. Dan schrijven we niets: een
    // upsert zou hier de bestaande rij kunnen overschrijven met nullen, en
    // dat is exact wat niet mag.
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_ONBEREIKBAAR, via: null, reden: null,
      fout: fout + ' (en spiegel niet leesbaar: ' + (e?.message || e) + ')' };
  }

  const patch = bepaalOnbereikbaarPatch(bestaand, fout, nuIso);
  if (opties.dry) {
    return { resultaat: bestaand ? SPIEGEL_BEHOUDEN : SPIEGEL_GESCHREVEN,
      bron_status: BRON_ONBEREIKBAAR, via: null, reden: null, fout, rij: patch, dry: true };
  }

  const { error } = bestaand
    ? await ctx.lms.from(SPIEGEL_TABEL).update(patch).eq('student_id', studentId)
    : await ctx.lms.from(SPIEGEL_TABEL).upsert({ student_id: studentId, ...patch },
        { onConflict: 'student_id' });
  if (error) {
    if (isTabelOntbreekt(error)) {
      return { resultaat: SPIEGEL_TABEL_ONTBREEKT, bron_status: BRON_ONBEREIKBAAR,
        via: null, reden: null, fout };
    }
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_ONBEREIKBAAR, via: null, reden: null,
      fout: fout + ' (en bronstand niet weg te schrijven: ' + error.message + ')' };
  }
  return { resultaat: bestaand ? SPIEGEL_BEHOUDEN : SPIEGEL_GESCHREVEN,
    bron_status: BRON_ONBEREIKBAAR, via: null, reden: null, fout };
}

// ───────────────────────────────────────────────────────────────────────────
// 5) DE AANROEP NA EEN FACTUURWIJZIGING
// ───────────────────────────────────────────────────────────────────────────

/**
 * Welke actieve mentorship-studenten hangen (mogelijk) aan deze klant?
 *
 * Omgekeerde richting van zoekKlantKandidaten: van klant naar student. De
 * KEUZE wordt hier niet overgedaan — we verzamelen alleen kandidaten en
 * laten spiegelFactuurstandVoorStudent() per student de volledige regel
 * opnieuw toepassen. Zo bestaat er maar één koppelingsregel, ook al zijn er
 * twee ingangen.
 */
async function zoekStudentenVoorKlant(ctx, customerId) {
  const { data: obs, error: obErr } = await ctx.db
    .from('onboardings')
    .select('dfo_lms_student_id, bubble_user_id, is_test')
    .eq('customer_id', customerId);
  if (obErr) throw new Error('onboardings lezen: ' + obErr.message);

  const studentIds = [];
  const bubbleIds  = [];
  for (const ob of (obs || [])) {
    if (ob?.is_test === true) continue;
    if (ob?.dfo_lms_student_id) studentIds.push(String(ob.dfo_lms_student_id));
    if (ob?.bubble_user_id)     bubbleIds.push(String(ob.bubble_user_id));
  }

  const { data: klant, error: kErr } = await ctx.db
    .from('customers').select('id, email, is_test').eq('id', customerId).maybeSingle();
  if (kErr) throw new Error('customers lezen: ' + kErr.message);
  if (!isEchteKlant(klant)) return [];
  const email = String(klant?.email || '').trim().toLowerCase();

  const gevonden = new Map();
  const voegToe = (rijen) => {
    for (const r of (rijen || [])) if (r?.id) gevonden.set(String(r.id), r);
  };

  if (studentIds.length > 0) {
    const { data, error } = await ctx.lms
      .from('hlms_student').select(STUDENT_KOLOMMEN).in('id', studentIds);
    if (error) throw new Error('hlms_student lezen: ' + error.message);
    voegToe(data);
  }
  if (bubbleIds.length > 0) {
    const { data, error } = await ctx.lms
      .from('hlms_student').select(STUDENT_KOLOMMEN).in('bubble_user_id', bubbleIds);
    if (error) throw new Error('hlms_student lezen: ' + error.message);
    voegToe(data);
  }
  if (email) {
    const { data, error } = await ctx.lms
      .from('hlms_student').select(STUDENT_KOLOMMEN).ilike('email', email);
    if (error) throw new Error('hlms_student lezen: ' + error.message);
    voegToe((data || []).filter(
      (r) => String(r?.email || '').trim().toLowerCase() === email));
  }

  return Array.from(gevonden.values())
    .filter((s) => isActieveMentorshipStudent(s, ctx.todayIso));
}

// Klanten waarvan we NET hebben vastgesteld dat er geen actieve
// mentorship-student aan hangt. Puur een rem op de uurlijkse volledige
// Teamleader-sync: die kan in één run honderden facturen aanraken, en voor
// verreweg de meeste klanten is het antwoord "hier hoort geen student bij".
// Zonder dit geheugen kost elke zo'n factuur drie bevragingen om tot
// diezelfde uitkomst te komen.
//
// ALLEEN HET NEGATIEVE ANTWOORD wordt onthouden, en maar vijf minuten. Een
// klant waar wél een student bij hoort wordt elke keer opnieuw doorgerekend —
// dat is nou juist het werk. En een student die tijdens een lopende sync
// ontstaat, wordt hooguit één ronde later meegenomen; de ronde van vannacht
// haalt dat sowieso in.
const _geenStudentTot = new Map();
const GEEN_STUDENT_GEHEUGEN_MS = 5 * 60 * 1000;

/**
 * Aanroep-helper voor endpoints: spiegel NA een geslaagde factuurwijziging.
 *
 * Faalzacht en bewust zonder terugkoppeling: een mislukte spiegel mag een
 * betaling, een creditering of een TL-synchronisatie nooit tegenhouden. Wat
 * er misging staat in de log, en de ronde van vannacht herstelt het.
 *
 * Niet meegegeven aan de afweging: of dit "de moeite waard" is. De aanroeper
 * beslist dát (alleen bij een ECHTE wijziging aanroepen, zie de aanroepers);
 * deze functie beslist alleen nog of er iets te spiegelen valt.
 *
 * @param {string} customerId
 * @param {string} label naam van de aanroeper, voor de logregel
 */
export async function spiegelFactuurstandNaWijziging(customerId, label) {
  const id = String(customerId || '').trim();
  if (!id) return { ok: false, reden: 'geen customer_id' };

  try {
    const lms = getDfoLmsClient();
    // Geen LMS-koppeling geconfigureerd is geen fout van deze klant; de
    // cliënt logt de ontbrekende omgevingsvariabelen zelf, één keer.
    if (!lms) return { ok: false, reden: 'dfo-lms-niet-geconfigureerd' };

    const tot = _geenStudentTot.get(id);
    if (tot && tot > Date.now()) return { ok: true, studenten: 0, uit_geheugen: true };

    const ctx = await maakContext({ lmsClient: lms });
    const studenten = await zoekStudentenVoorKlant(ctx, id);
    if (studenten.length === 0) {
      _geenStudentTot.set(id, Date.now() + GEEN_STUDENT_GEHEUGEN_MS);
      return { ok: true, studenten: 0 };
    }
    _geenStudentTot.delete(id);

    let geschreven = 0;
    for (const student of studenten) {
      // Per student een eigen poging: één student die struikelt mag de
      // andere niet meenemen.
      try {
        const uit = await spiegelFactuurstandVoorStudent(student, ctx);
        if (uit.resultaat === SPIEGEL_GESCHREVEN) geschreven++;
        else if (uit.resultaat === SPIEGEL_TABEL_ONTBREEKT) {
          console.warn('[' + label + '] hlms_crm_factuurstand bestaat nog niet in het LMS '
            + '— spiegel overgeslagen');
          return { ok: false, reden: 'tabel-ontbreekt' };
        } else if (uit.resultaat === SPIEGEL_MISLUKT) {
          console.warn('[' + label + '] factuurstand-spiegel mislukt voor student '
            + student.id + ': ' + (uit.fout || 'onbekend')
            + ' — de ronde van vannacht herstelt dit.');
        }
      } catch (e) {
        console.warn('[' + label + '] factuurstand-spiegel gooide voor student '
          + student.id + ': ' + (e?.message || e));
      }
    }
    return { ok: true, studenten: studenten.length, geschreven };
  } catch (e) {
    console.warn('[' + label + '] factuurstand-spiegel overgeslagen: ' + (e?.message || e));
    return { ok: false, reden: e?.message || String(e) };
  }
}

// Exporteren voor de ronde in api/_lib/factuurstand-sync.js.
export { STUDENT_KOLOMMEN, FACTUUR_KOLOMMEN };

// ───────────────────────────────────────────────────────────────────────────
// NOTITIE — wat `invoices.is_historical` betekent, en waarom hij meetelt
// ───────────────────────────────────────────────────────────────────────────
//
// Gemeten in de broncode (16 september 2026):
//   * De kolom komt uit docs/sql-migrations/2026-05-30-finance-fase-1-
//     fundament.sql: `is_historical boolean NOT NULL DEFAULT false`.
//   * Er zijn precies TWEE plekken die hem schrijven — api/_lib/invoice-
//     upsert.js:127 en api/finance-tl-invoice-sync.js:207 — en allebei zetten
//     hem hard op `false`.
//   * Er is GEEN plek in het hele CRM die hem op `true` zet, en geen enkele
//     lezer die erop filtert. (De `is_historical` die je wél overal ziet
//     staan, hoort bij `events` — dat is een andere tabel en een ander begrip:
//     handmatig ingevoerde evenementen uit het verleden.)
//
// Betekenis: op `invoices` is het een SLAPENDE vlag, bedoeld voor facturen die
// van vóór het CRM stammen en met de hand ingevoerd zouden worden. Zolang
// niets hem zet, staat hij op productie op false voor alle 1.965 rijen.
//
// Beslissing: ze tellen MEE — dat wil zeggen, er wordt niet op gefilterd.
// Twee redenen, in volgorde van gewicht:
//   1. De wanbetalersmotor filtert er ook niet op. De opdracht is expliciet
//      dat de "te laat"-grens exact die van Joost is; een extra filter aan
//      deze kant zou betekenen dat een student die van Joost een aanmaning
//      krijgt in het LMS geen signaal geeft. Twee systemen die over dezelfde
//      factuur iets anders zeggen is erger dan één die iets meetelt wat
//      misschien oud is.
//   2. Een openstaande, vervallen factuur IS een openstaande vordering,
//      ongeacht uit welk tijdperk hij komt. Uitsluiten zou een bedrag
//      onzichtbaar maken op grond van een vlag die niemand ooit zet.
//
// De droogloop telt ze apart (`is_historical_meegeteld`), zodat deze
// beslissing herzien kan worden op grond van een getal in plaats van een
// aanname, mocht er ooit iemand beginnen met die vlag te zetten.
