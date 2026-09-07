// api/_lib/dfo-lms-sessies.js
//
// Sessies lezen uit het NIEUWE LMS (dfo-lms, tabel hlms_sessie). Vervangt de
// Bubble-bron `1-1-session` voor het CRM. Zie
// docs/dfo-lms-onboarding-koppeling-fase1.md voor het waarom.
//
// ── DE REGEL DIE DEZE MODULE AFDWINGT ────────────────────────────────────
// "Leeg" en "niet gelukt" mogen nooit hetzelfde zijn.
//
// Dat is de rode draad van alles wat we deze week gevonden hebben: elke
// Bubble-lezer in het CRM vangt zijn fouten af naar een lege lijst, waardoor
// een storing en "er is niets" er identiek uitzien. Zo kon de verschuiving
// van Bubble naar het LMS maandenlang onopgemerkt blijven — crons meldden
// keurig `checked: 0` en dat las als "er stond niets gepland".
//
// Daarom geeft deze module NOOIT alleen een lijst terug, maar altijd een
// `bron_status` erbij:
//
//   'gelezen'            de bevraging is gelukt. Nul sessies betekent dan
//                        ECHT nul sessies.
//   'onbereikbaar'       de bevraging is mislukt. Het aantal zegt niets.
//   'niet-geconfigureerd' de DFO_LMS_*-omgevingsvariabelen ontbreken.
//
// Een aanroeper die dit onderscheid negeert en alleen `sessies.length`
// bekijkt, maakt precies de fout waar deze module voor bestaat.

// ── GEEN LEERTYPE-FILTER ─────────────────────────────────────────────────
// De Bubble-lezers filterden op `learn_type1 = 'Alpha Program'`. Dat
// onderscheid is vervallen (beslissing Maxim, 7 september 2026): er is geen
// verschil meer tussen alpha en delta of wat dan ook — ELKE coachingsessie
// telt mee. Voeg hier dus geen leertype-filter toe; een sessie is een sessie.

import { getDfoLmsClient } from './dfo-lms-db.js';

export const BRON_GELEZEN            = 'gelezen';
export const BRON_ONBEREIKBAAR       = 'onbereikbaar';
export const BRON_NIET_GECONFIGUREERD = 'niet-geconfigureerd';

// Statussen waarbij een sessie als afgehandeld geldt. Sessies hierin krijgen
// geen herinnering meer: de call is al geweest of de student kwam niet.
export const AFGEHANDELDE_STATUSSEN = Object.freeze(['afgerond', 'no_show']);

const STANDAARD_LIMIET = 500;

/**
 * Sessies in een tijdvenster, met het e-mailadres van de student erbij.
 *
 * Bewust GEEN status-filter in de query maar in JS. Twee redenen:
 *
 *  1. `status NOT IN (...)` in SQL laat een rij met status NULL stilzwijgend
 *     vallen — precies het soort onzichtbare uitsluiting dat we hier juist
 *     willen vermijden.
 *  2. Zo kunnen we TELLEN wat er buiten de filter viel en dat teruggeven.
 *     Een cron die meldt "12 gevonden, 3 overgeslagen want al afgehandeld"
 *     is eerlijk; een cron die alleen de 9 noemt, niet.
 *
 * Een onbekende status komt er dus WEL doorheen: bij een herinnering is niet-
 * versturen de duurdere fout, dus we falen richting versturen.
 *
 * @param {{vanIso: string, totIso: string, limiet?: number, client?: object}} arg
 *   `client` is er alleen voor tests: laat 'm weg in productie, dan wordt
 *   de gedeelde dfo-lms-client gebruikt.
 * @returns {Promise<{
 *   bron_status: string,
 *   sessies: Array<{id, start_tijd, status, student_id, email, voornaam, achternaam}>,
 *   totaal_in_venster: number,
 *   overgeslagen_afgehandeld: number,
 *   zonder_student: number,
 *   zonder_email: number,
 *   fout: string|null,
 * }>}
 */
export async function haalSessiesInVenster({ vanIso, totIso, limiet = STANDAARD_LIMIET, client = null }) {
  const leeg = {
    bron_status: BRON_ONBEREIKBAAR,
    sessies: [],
    totaal_in_venster: 0,
    overgeslagen_afgehandeld: 0,
    zonder_student: 0,
    zonder_email: 0,
    fout: null,
  };

  const lms = client || getDfoLmsClient();
  if (!lms) {
    return { ...leeg, bron_status: BRON_NIET_GECONFIGUREERD,
      fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt' };
  }

  // 1) Sessies in het venster.
  let rijen;
  try {
    const { data, error } = await lms
      .from('hlms_sessie')
      .select('id, start_tijd, status, student_id')
      .gte('start_tijd', vanIso)
      .lt('start_tijd', totIso)
      .order('start_tijd', { ascending: true })
      .limit(limiet);
    if (error) throw new Error(error.message);
    rijen = Array.isArray(data) ? data : [];
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[dfo-lms-sessies] hlms_sessie lezen mislukt:', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }

  const totaal = rijen.length;

  // 2) Afgehandelde sessies eruit, en tellen hoeveel dat er waren.
  const afgehandeld = new Set(AFGEHANDELDE_STATUSSEN);
  const open = rijen.filter((r) => !afgehandeld.has(String(r?.status || '').trim().toLowerCase()));
  const overgeslagenAfgehandeld = totaal - open.length;

  const metStudent = open.filter((r) => r?.student_id);
  const zonderStudent = open.length - metStudent.length;

  if (metStudent.length === 0) {
    return {
      bron_status: BRON_GELEZEN, sessies: [],
      totaal_in_venster: totaal,
      overgeslagen_afgehandeld: overgeslagenAfgehandeld,
      zonder_student: zonderStudent, zonder_email: 0, fout: null,
    };
  }

  // 3) Studenten erbij. Aparte bevraging in plaats van een ingebedde select:
  // die laatste vereist een vastgelegde FK tussen hlms_sessie en hlms_student,
  // en daar kunnen we niet van uitgaan.
  let studentById = new Map();
  try {
    const ids = Array.from(new Set(metStudent.map((r) => r.student_id)));
    const { data, error } = await lms
      .from('hlms_student')
      .select('id, email, voornaam, achternaam, bubble_user_id')
      .in('id', ids);
    if (error) throw new Error(error.message);
    for (const s of (data || [])) studentById.set(String(s.id), s);
  } catch (e) {
    const msg = 'hlms_student lezen mislukt: ' + (e?.message || e);
    console.error('[dfo-lms-sessies]', msg);
    // De sessies zijn wél gelezen, maar zonder e-mailadres kan de aanroeper
    // niets. Dat is een mislukte bevraging, geen lege uitkomst.
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, totaal_in_venster: totaal, fout: msg };
  }

  const sessies = [];
  let zonderEmail = 0;
  for (const r of metStudent) {
    const stu = studentById.get(String(r.student_id)) || null;
    const email = String(stu?.email || '').trim().toLowerCase();
    if (!email) { zonderEmail++; continue; }
    sessies.push({
      id: String(r.id),
      start_tijd: r.start_tijd,
      status: r.status || null,
      student_id: String(r.student_id),
      email,
      voornaam: stu?.voornaam || null,
      achternaam: stu?.achternaam || null,
    });
  }

  return {
    bron_status: BRON_GELEZEN,
    sessies,
    totaal_in_venster: totaal,
    overgeslagen_afgehandeld: overgeslagenAfgehandeld,
    zonder_student: zonderStudent,
    zonder_email: zonderEmail,
    fout: null,
  };
}


/**
 * No-shows sinds een watermerk, met de gegevens die een signaal nodig heeft.
 *
 * Voor api/cron/noshow-detect.js. Geeft per sessie zowel de student (inclusief
 * `bubble_user_id`, de brug naar het CRM) als het e-mailadres van de mentor,
 * want daarmee wordt de CRM-mentor opgezocht.
 *
 * Zelfde regel als hierboven: 'gelezen' met nul rijen betekent ECHT nul.
 *
 * @param {{sindsIso: string, limiet?: number, client?: object}} arg
 */
export async function haalNoShowsSinds({ sindsIso, limiet = STANDAARD_LIMIET, client = null }) {
  const leeg = {
    bron_status: BRON_ONBEREIKBAAR, sessies: [],
    totaal: 0, zonder_bubble_koppeling: 0, zonder_mentor: 0, fout: null,
  };

  const lms = client || getDfoLmsClient();
  if (!lms) {
    return { ...leeg, bron_status: BRON_NIET_GECONFIGUREERD,
      fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt' };
  }

  let rijen;
  try {
    const { data, error } = await lms
      .from('hlms_sessie')
      .select('id, start_tijd, status, student_id, mentor_id')
      .eq('status', 'no_show')
      .gt('start_tijd', sindsIso)
      .order('start_tijd', { ascending: true })
      .limit(limiet);
    if (error) throw new Error(error.message);
    const sindsMs = new Date(sindsIso).getTime();
    rijen = (Array.isArray(data) ? data : []).filter((r) =>
      String(r?.status || '').trim().toLowerCase() === 'no_show'
      && r?.start_tijd && new Date(r.start_tijd).getTime() > sindsMs);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[dfo-lms-sessies] no-shows lezen mislukt:', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }

  if (rijen.length === 0) {
    return { ...leeg, bron_status: BRON_GELEZEN, fout: null };
  }

  // Studenten + mentoren erbij.
  let studentById = new Map();
  let mentorById  = new Map();
  try {
    const stuIds = Array.from(new Set(rijen.map((r) => r.student_id).filter(Boolean)));
    if (stuIds.length > 0) {
      const { data, error } = await lms
        .from('hlms_student')
        .select('id, email, voornaam, achternaam, bubble_user_id')
        .in('id', stuIds);
      if (error) throw new Error('hlms_student: ' + error.message);
      for (const r of (data || [])) studentById.set(String(r.id), r);
    }
    const mentorIds = Array.from(new Set(rijen.map((r) => r.mentor_id).filter(Boolean)));
    if (mentorIds.length > 0) {
      const { data, error } = await lms
        .from('hlms_personeel')
        .select('id, email, naam')
        .in('id', mentorIds);
      if (error) throw new Error('hlms_personeel: ' + error.message);
      for (const r of (data || [])) mentorById.set(String(r.id), r);
    }
  } catch (e) {
    const msg = 'bijgegevens lezen mislukt: ' + (e?.message || e);
    console.error('[dfo-lms-sessies]', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, totaal: rijen.length, fout: msg };
  }

  const sessies = [];
  let zonderBrug = 0;
  let zonderMentor = 0;
  for (const r of rijen) {
    const stu = studentById.get(String(r.student_id)) || null;
    const men = r.mentor_id ? (mentorById.get(String(r.mentor_id)) || null) : null;
    const brug = String(stu?.bubble_user_id || '').trim();
    if (!brug)  { zonderBrug++;   continue; }
    if (!men?.email) { zonderMentor++; continue; }
    sessies.push({
      id: String(r.id),
      start_tijd: r.start_tijd,
      student_id: String(r.student_id),
      bubble_user_id: brug,
      email: String(stu?.email || '').trim().toLowerCase() || null,
      voornaam: stu?.voornaam || null,
      achternaam: stu?.achternaam || null,
      mentor_id: String(r.mentor_id),
      mentor_email: String(men.email).trim().toLowerCase(),
    });
  }

  return {
    bron_status: BRON_GELEZEN, sessies,
    totaal: rijen.length,
    zonder_bubble_koppeling: zonderBrug,
    zonder_mentor: zonderMentor,
    fout: null,
  };
}

/**
 * Sessie-overzicht per student, gekeyed op `bubble_user_id` — precies de
 * vorm die api/onboarding-intake-status.js nodig heeft, zodat dat endpoint
 * zijn sleutel (`onboardings.bubble_user_id`) niet hoeft te wijzigen.
 *
 * Per student drie tijdstippen, met dezelfde betekenis als de Bubble-versie
 * in api/_lib/bubble-1on1.js:
 *   next   eerstvolgende TOEKOMSTIGE, nog niet afgehandelde sessie
 *   done   VROEGSTE afgeronde sessie  (dat is de "eerste call voltooid")
 *   noshow LAATSTE no-show
 *
 * @param {{bubbleUserIds: string[], nu?: Date, client?: object}} arg
 * @returns {Promise<{bron_status, perStudent: Map, fout}>}
 */
export async function haalSessieOverzichtPerStudent({ bubbleUserIds, nu = new Date(), client = null }) {
  const leeg = { bron_status: BRON_ONBEREIKBAAR, perStudent: new Map(), fout: null };

  const ids = Array.from(new Set((bubbleUserIds || [])
    .map((v) => String(v || '').trim()).filter(Boolean)));
  if (ids.length === 0) return { ...leeg, bron_status: BRON_GELEZEN, fout: null };

  const lms = client || getDfoLmsClient();
  if (!lms) {
    return { ...leeg, bron_status: BRON_NIET_GECONFIGUREERD,
      fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt' };
  }

  // 1) bubble_user_id → hlms_student.id. Dit IS de brug: 299 van de 304
  // studentrijen dragen 'm, en die waarden zijn uniek (gemeten 7-9-2026).
  let studentIdNaarBrug = new Map();
  try {
    const { data, error } = await lms
      .from('hlms_student')
      .select('id, bubble_user_id')
      .in('bubble_user_id', ids);
    if (error) throw new Error(error.message);
    for (const r of (data || [])) {
      if (r?.id && r?.bubble_user_id) {
        studentIdNaarBrug.set(String(r.id), String(r.bubble_user_id));
      }
    }
  } catch (e) {
    const msg = 'hlms_student lezen mislukt: ' + (e?.message || e);
    console.error('[dfo-lms-sessies]', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }

  if (studentIdNaarBrug.size === 0) {
    return { bron_status: BRON_GELEZEN, perStudent: new Map(), fout: null };
  }

  // 2) Alle sessies van die studenten.
  let rijen;
  try {
    const { data, error } = await lms
      .from('hlms_sessie')
      .select('id, start_tijd, status, student_id')
      .in('student_id', Array.from(studentIdNaarBrug.keys()));
    if (error) throw new Error(error.message);
    rijen = Array.isArray(data) ? data : [];
  } catch (e) {
    const msg = 'hlms_sessie lezen mislukt: ' + (e?.message || e);
    console.error('[dfo-lms-sessies]', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }

  const nuMs = nu.getTime();
  const perStudent = new Map();
  const zorg = (sleutel) => {
    if (!perStudent.has(sleutel)) perStudent.set(sleutel, { next: null, done: null, noshow: null });
    return perStudent.get(sleutel);
  };

  for (const r of rijen) {
    const sleutel = studentIdNaarBrug.get(String(r.student_id));
    if (!sleutel) continue;
    const iso = r.start_tijd ? new Date(r.start_tijd).toISOString() : null;
    if (!iso) continue;
    const ms = new Date(iso).getTime();
    const status = String(r.status || '').trim().toLowerCase();
    const v = zorg(sleutel);

    if (status === 'afgerond') {
      // VROEGSTE afgeronde sessie.
      if (!v.done || ms < new Date(v.done).getTime()) v.done = iso;
    } else if (status === 'no_show') {
      // LAATSTE no-show.
      if (!v.noshow || ms > new Date(v.noshow).getTime()) v.noshow = iso;
    } else if (ms > nuMs) {
      // Nog niet afgehandeld én in de toekomst → eerstvolgende geplande.
      if (!v.next || ms < new Date(v.next).getTime()) v.next = iso;
    }
  }

  return { bron_status: BRON_GELEZEN, perStudent, fout: null };
}


/**
 * De EERSTE sessie per student: de vroegste `start_tijd`, ongeacht status.
 *
 * Beide regels van 7 september 2026 hangen hieraan:
 *   - is die eerste sessie 'afgerond'  → de onboarding is klaar;
 *   - is die eerste sessie 'no_show'   → een signaal met een eigen type,
 *     want dan moet er iemand kort op zitten.
 *
 * "Eerste" is puur chronologisch. Er bestaat GEEN soort-onderscheid: geen
 * kennismakingsgesprek, geen Alpha/Delta. Elke coachingsessie telt mee, en
 * de vroegste is de eerste. Voeg hier dus geen type- of leertype-filter toe.
 *
 * @param {{studentIds: string[], client?: object}} arg
 * @returns {Promise<{bron_status, perStudent: Map<string, {id, start_tijd, status}>, fout}>}
 */
export async function haalEersteSessiePerStudent({ studentIds, client = null }) {
  const leeg = { bron_status: BRON_ONBEREIKBAAR, perStudent: new Map(), fout: null };

  const ids = Array.from(new Set((studentIds || [])
    .map((v) => String(v || '').trim()).filter(Boolean)));
  if (ids.length === 0) return { ...leeg, bron_status: BRON_GELEZEN, fout: null };

  const lms = client || getDfoLmsClient();
  if (!lms) {
    return { ...leeg, bron_status: BRON_NIET_GECONFIGUREERD,
      fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt' };
  }

  let rijen;
  try {
    const { data, error } = await lms
      .from('hlms_sessie')
      .select('id, start_tijd, status, student_id')
      .in('student_id', ids)
      .order('start_tijd', { ascending: true });
    if (error) throw new Error(error.message);
    rijen = Array.isArray(data) ? data : [];
  } catch (e) {
    const msg = 'hlms_sessie lezen mislukt: ' + (e?.message || e);
    console.error('[dfo-lms-sessies]', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }

  // Niet vertrouwen op de sorteervolgorde van de bron: expliciet de vroegste
  // kiezen. Een sessie zonder start_tijd kan per definitie niet de eerste zijn.
  const perStudent = new Map();
  for (const r of rijen) {
    if (!r?.student_id || !r?.start_tijd) continue;
    const sleutel = String(r.student_id);
    const ms = new Date(r.start_tijd).getTime();
    if (!Number.isFinite(ms)) continue;
    const huidige = perStudent.get(sleutel);
    if (!huidige || ms < new Date(huidige.start_tijd).getTime()) {
      perStudent.set(sleutel, {
        id: String(r.id),
        start_tijd: new Date(r.start_tijd).toISOString(),
        status: String(r.status || '').trim().toLowerCase() || null,
      });
    }
  }

  return { bron_status: BRON_GELEZEN, perStudent, fout: null };
}

/**
 * De VROEGSTE AFGERONDE sessie per student, sinds een watermerk.
 *
 * Voor api/cron/onboarding-eerste-sessie-afronden.js.
 *
 * ── LET OP HET VERSCHIL ──────────────────────────────────────────────────
 * Dit is NIET "de eerste sessie van de student, mits afgerond", maar "de
 * vroegste sessie MET status afgerond". Dat onderscheid doet ertoe zodra de
 * eerste sessie een no-show was: dan sluit die no-show niets af (er komt een
 * signaal uit), en sluit de eerstvolgende sessie die wél afgerond raakt de
 * onboarding alsnog. Anders zou één gemiste eerste call de onboarding voor
 * altijd open laten staan.
 *
 * ── AANLEIDING EN OORZAAK ZIJN TWEE DINGEN ───────────────────────────────
 * Het watermerk voorkomt een terugwerkende vloedgolf: alleen een student met
 * een afgeronde sessie NA het watermerk komt in aanmerking. Dat is de
 * AANLEIDING.
 *
 * Wat er vervolgens wordt vastgelegd is de OORZAAK: de vroegste afgeronde
 * sessie van die student, ook als die vóór het watermerk ligt. Want die maakte
 * het onboarden af — de latere sessie attendeerde ons er alleen op.
 *
 * Die twee zijn eerder samengevallen, en dat was fout. De eerste versie liet
 * een kandidaat vallen zodra hij niet zelf de vroegste was, en telde dat als
 * `eerdere_afgeronde_buiten_venster`. Gevolg: een student met een afgeronde
 * sessie vóór het watermerk kon NOOIT meer sluiten — niet bij de tweede sessie,
 * niet bij de tiende. Geen overgeslagen inhaalslag maar een permanent gat, en
 * alleen zichtbaar als een teller waar niets mee gebeurde.
 *
 * De grens blijft waar hij hoort: heeft een student ALLEEN sessies van vóór
 * het watermerk en daarna niets meer, dan is er geen aanleiding en gebeurt er
 * niets. Dat is het verschil tussen dit dichten en alsnog over de historie
 * lopen.
 *
 * Elke teruggegeven rij draagt daarom allebei: `id`/`start_tijd` van de
 * oorzaak, en `aanleiding_id`/`aanleiding_op` van de sessie die in het venster
 * viel. De aanroeper legt de oorzaak vast en verzet zijn watermerk op de
 * aanleiding — anders zou het watermerk terug in de tijd willen.
 *
 * @param {{sindsIso: string, limiet?: number, client?: object}} arg
 */
export async function haalAfgerondeEersteSessies({ sindsIso, limiet = STANDAARD_LIMIET, client = null }) {
  const leeg = {
    bron_status: BRON_ONBEREIKBAAR, sessies: [],
    totaal_afgerond: 0, gesloten_op_eerdere_sessie: 0,
    zonder_bubble_koppeling: 0, fout: null,
  };

  const lms = client || getDfoLmsClient();
  if (!lms) {
    return { ...leeg, bron_status: BRON_NIET_GECONFIGUREERD,
      fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt' };
  }

  // 1) Afgeronde sessies sinds het watermerk.
  let kandidaten;
  try {
    const { data, error } = await lms
      .from('hlms_sessie')
      .select('id, start_tijd, status, student_id')
      .eq('status', 'afgerond')
      .gt('start_tijd', sindsIso)
      .order('start_tijd', { ascending: true })
      .limit(limiet);
    if (error) throw new Error(error.message);
    // Ook in JS toetsen. De bevraging filtert al server-side, maar zo hangt
    // de regel niet af van waar hij wordt afgedwongen — en blijft hij
    // toetsbaar zonder databank.
    const sindsMs = new Date(sindsIso).getTime();
    kandidaten = (Array.isArray(data) ? data : []).filter((r) =>
      String(r?.status || '').trim().toLowerCase() === 'afgerond'
      && r?.start_tijd && new Date(r.start_tijd).getTime() > sindsMs);
  } catch (e) {
    const msg = 'afgeronde sessies lezen mislukt: ' + (e?.message || e);
    console.error('[dfo-lms-sessies]', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }

  if (kandidaten.length === 0) {
    return { ...leeg, bron_status: BRON_GELEZEN, fout: null };
  }

  // 2) Is dit ook echt de VROEGSTE afgeronde sessie van die student? Dat moet
  // over ALLE afgeronde sessies, niet alleen die na het watermerk.
  const studentIds = Array.from(new Set(kandidaten.map((r) => r.student_id).filter(Boolean)));
  let vroegsteAfgerond = new Map();
  try {
    const { data, error } = await lms
      .from('hlms_sessie')
      .select('id, start_tijd, status, student_id')
      .eq('status', 'afgerond')
      .in('student_id', studentIds);
    if (error) throw new Error(error.message);
    for (const r of (data || [])) {
      if (!r?.student_id || !r?.start_tijd) continue;
      if (String(r.status || '').trim().toLowerCase() !== 'afgerond') continue;
      const k = String(r.student_id);
      const ms = new Date(r.start_tijd).getTime();
      if (!Number.isFinite(ms)) continue;
      const h = vroegsteAfgerond.get(k);
      if (!h || ms < new Date(h.start_tijd).getTime()) {
        vroegsteAfgerond.set(k, { id: String(r.id), start_tijd: new Date(r.start_tijd).toISOString() });
      }
    }
  } catch (e) {
    const msg = 'vroegste afgeronde bepalen mislukt: ' + (e?.message || e);
    console.error('[dfo-lms-sessies]', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }

  // Eén rij per student: de vroegste afgeronde sessie als OORZAAK, de laatste
  // kandidaat binnen het venster als AANLEIDING. Kandidaten komen oplopend
  // binnen, dus de laatste overschrijving is de hoogste — en daarmee de waarde
  // waarop de aanroeper zijn watermerk mag verzetten zonder rijen over te
  // slaan.
  const perStudent = new Map();
  for (const r of kandidaten) {
    const sid = String(r.student_id);
    const oorzaak = vroegsteAfgerond.get(sid);
    if (!oorzaak) continue; // kan niet: stap 2 zag deze rij ook. Defensief.
    const bestaand = perStudent.get(sid);
    perStudent.set(sid, {
      id            : oorzaak.id,
      start_tijd    : oorzaak.start_tijd,
      student_id    : sid,
      aanleiding_id : String(r.id),
      aanleiding_op : new Date(r.start_tijd).toISOString(),
      // Sluit deze onboarding op een sessie van vóór het watermerk? Dan is het
      // vermeldenswaard, maar geen reden om 'm te laten liggen.
      op_eerdere_sessie: oorzaak.id !== String(r.id)
        ? true : (bestaand?.op_eerdere_sessie || false),
    });
  }
  const echtEerste = Array.from(perStudent.values());
  const opEerdereSessie = echtEerste.filter((r) => r.op_eerdere_sessie).length;

  if (echtEerste.length === 0) {
    return { ...leeg, bron_status: BRON_GELEZEN,
      totaal_afgerond: kandidaten.length,
      gesloten_op_eerdere_sessie: opEerdereSessie, fout: null };
  }

  // 3) De brug naar het CRM erbij.
  let studentById = new Map();
  try {
    const ids = Array.from(new Set(echtEerste.map((r) => r.student_id)));
    const { data, error } = await lms
      .from('hlms_student')
      .select('id, email, voornaam, achternaam, bubble_user_id')
      .in('id', ids);
    if (error) throw new Error(error.message);
    for (const r of (data || [])) studentById.set(String(r.id), r);
  } catch (e) {
    const msg = 'hlms_student lezen mislukt: ' + (e?.message || e);
    console.error('[dfo-lms-sessies]', msg);
    return { ...leeg, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }

  const sessies = [];
  let zonderBrug = 0;
  for (const r of echtEerste) {
    const stu = studentById.get(String(r.student_id)) || null;
    const brug = String(stu?.bubble_user_id || '').trim();
    if (!brug) { zonderBrug++; continue; }
    sessies.push({
      // OORZAAK — dit is wat de aanroeper vastlegt.
      id: String(r.id),
      start_tijd: new Date(r.start_tijd).toISOString(),
      // AANLEIDING — hierop verzet de aanroeper zijn watermerk.
      aanleiding_id: String(r.aanleiding_id),
      aanleiding_op: String(r.aanleiding_op),
      op_eerdere_sessie: !!r.op_eerdere_sessie,
      student_id: String(r.student_id),
      bubble_user_id: brug,
      email: String(stu?.email || '').trim().toLowerCase() || null,
      voornaam: stu?.voornaam || null,
      achternaam: stu?.achternaam || null,
    });
  }

  return {
    bron_status: BRON_GELEZEN, sessies,
    totaal_afgerond: kandidaten.length,
    gesloten_op_eerdere_sessie: opEerdereSessie,
    zonder_bubble_koppeling: zonderBrug,
    fout: null,
  };
}
