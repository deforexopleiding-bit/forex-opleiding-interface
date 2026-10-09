// api/_lib/mentorStudents.js
//
// "Wie zijn de studenten van deze mentor?" — één bron van waarheid voor elk
// CRM-endpoint dat die vraag stelt (mentor-my-students, overdue-badge,
// signalen, 1-op-1-lijst, funded-certificaten, studentenoverzicht).
//
// BRON: het LMS (dfo-lms). Sinds 9 okt 2026 (Maxim: Bubble gaat dicht) lezen
// we niet meer uit Bubble maar uit hlms_student:
//   mentor  : team_members.user_id → team_members.email → hlms_personeel.id
//             (precies één actieve match op lower(email), anders "niet
//             gekoppeld" — gokken over wie wiens studenten ziet doen we niet).
//   student : hlms_student.mentor_id = hlms_personeel.id.
//
// DE STUDENTSLEUTEL (`student_id` in elke API-vorm):
//   hlms_student.bubble_user_id als die er is, anders hlms_student.id.
// Waarom niet gewoon hlms_student.id: de CRM-tabellen die per student iets
// bewaren (student_signals, mentor_student_assessments,
// mentor_funded_certificates) zijn jarenlang gevuld met het oude Bubble-id.
// Met deze sleutel blijft die geschiedenis aan dezelfde student hangen; een
// student die na Bubble instroomde (geen oud id) krijgt zijn LMS-id. Het is
// een historische DB-sleutel — er gaat geen enkele aanroep naar Bubble.
//
// GEEN STIL LEEG: een LMS dat niet geconfigureerd of onbereikbaar is GOOIT
// (code DFO_LMS_ONBEREIKBAAR), zodat de endpoints een 503 geven in plaats van
// "deze mentor heeft geen studenten".

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';

export const STUDENT_KOLOMMEN =
  'id, mentor_id, voornaam, achternaam, email, telefoon, product_soort, membership_type, '
  + 'start_datum, eind_datum, calls_gedaan, calls_totaal, calls_startsaldo, no_show_count, '
  + 'onboarding_status, bubble_user_id, crm_onboarding_id';

const IN_CHUNK = 100;
const SESSIE_MINUTEN = 45;

function lmsFout(msg) {
  const e = new Error(msg);
  e.code = 'DFO_LMS_ONBEREIKBAAR';
  return e;
}

/** Het LMS of een fout (nooit null terug). */
export function vereisLms() {
  const lms = getDfoLmsClient();
  if (!lms) throw lmsFout('LMS-koppeling niet geconfigureerd (DFO_LMS_SUPABASE_URL / _SERVICE_ROLE_KEY)');
  return lms;
}

const mail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** De studentsleutel — zie de kop van dit bestand. PURE. */
export function studentSleutel(row) {
  const oud = row && row.bubble_user_id ? String(row.bubble_user_id).trim() : '';
  return oud || (row && row.id ? String(row.id) : '');
}

/** Sessie-eenheden: 45 min = 1, 90 min = 2 (zelfde regel als het LMS). PURE. */
export function eenhedenVan(duurMinuten) {
  const d = (typeof duurMinuten === 'number' && Number.isFinite(duurMinuten) && duurMinuten !== 0)
    ? duurMinuten : SESSIE_MINUTEN;
  return Math.max(1, Math.round(d / SESSIE_MINUTEN));
}

/** Vandaag als 'YYYY-MM-DD' in Brusselse tijd. */
export function vandaagBrussel(nu = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(nu);
}

/**
 * Het LMS-personeels-id van een CRM-mentor (auth.users.id).
 * @returns {Promise<{ linked: boolean, personeelId: string|null, reden: string|null }>}
 */
export async function getMentorLmsKoppeling(effectiveUserId) {
  if (!effectiveUserId || typeof effectiveUserId !== 'string') {
    return { linked: false, personeelId: null, reden: 'geen-gebruiker' };
  }
  const { data: tm, error } = await supabaseAdmin
    .from('team_members')
    .select('id, email, is_active')
    .eq('user_id', effectiveUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw new Error('team_members lookup: ' + error.message);
  const e = mail(tm?.email);
  if (!e) return { linked: false, personeelId: null, reden: tm ? 'mentor-zonder-email' : 'geen-teamlid' };

  const lms = vereisLms();
  const { data: pers, error: pErr } = await lms.from('hlms_personeel').select('id, email, actief');
  if (pErr) throw lmsFout('hlms_personeel lezen: ' + pErr.message);
  const hits = (pers || []).filter((p) => mail(p.email) === e && p.actief !== false);
  if (hits.length === 1) return { linked: true, personeelId: String(hits[0].id), reden: null };
  return { linked: false, personeelId: null, reden: hits.length === 0 ? 'mentor-niet-in-lms' : 'meerdere-lms-mentors' };
}

/** Alle hlms_student-rijen van één mentor (personeels-id). Gooit bij een leesfout. */
export async function fetchLmsStudentenVanMentor(personeelId) {
  if (!personeelId) return [];
  const lms = vereisLms();
  const { data, error } = await lms
    .from('hlms_student')
    .select(STUDENT_KOLOMMEN)
    .eq('mentor_id', personeelId)
    .limit(2000);
  if (error) throw lmsFout('hlms_student lezen: ' + error.message);
  return data || [];
}

/** Alle hlms_student-rijen (admin-overzicht). Gooit bij een leesfout. */
export async function fetchAlleLmsStudenten() {
  const lms = vereisLms();
  const out = [];
  for (let van = 0; van < 20000; van += 1000) {
    const { data, error } = await lms
      .from('hlms_student')
      .select(STUDENT_KOLOMMEN)
      .order('id', { ascending: true })
      .range(van, van + 999);
    if (error) throw lmsFout('hlms_student lezen: ' + error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Naam per hlms_personeel.id. Faalzacht: lege Map bij een leesfout. */
export async function personeelNamen() {
  const lms = getDfoLmsClient();
  const map = new Map();
  if (!lms) return map;
  const { data, error } = await lms.from('hlms_personeel').select('id, naam, email');
  if (error) { console.warn('[mentorStudents] hlms_personeel namen:', error.message); return map; }
  for (const p of data || []) map.set(String(p.id), (p.naam && String(p.naam).trim()) || p.email || null);
  return map;
}

/**
 * Verbruikte LMS-sessies per student (afgerond + no-show, in eenheden).
 * Faalzacht: `null` bij een leesfout — de aanroeper toont dan alleen het
 * startsaldo en zegt dat de telling ontbreekt.
 * @returns {Promise<Map<string,{afgerond:number,noShow:number}>|null>}
 */
export async function telSessiesPerStudent(studentIds) {
  const ids = [...new Set((studentIds || []).filter(Boolean).map(String))];
  const map = new Map();
  if (ids.length === 0) return map;
  const lms = getDfoLmsClient();
  if (!lms) return null;
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await lms
      .from('hlms_sessie')
      .select('student_id, status, duur_minuten')
      .in('student_id', ids.slice(i, i + IN_CHUNK))
      .in('status', ['afgerond', 'no_show'])
      .limit(10000);
    if (error) { console.warn('[mentorStudents] hlms_sessie tellen:', error.message); return null; }
    for (const r of data || []) {
      const k = String(r.student_id);
      const t = map.get(k) || { afgerond: 0, noShow: 0 };
      if (r.status === 'afgerond') t.afgerond += eenhedenVan(r.duur_minuten);
      else t.noShow += eenhedenVan(r.duur_minuten);
      map.set(k, t);
    }
  }
  return map;
}

/**
 * hlms_student-rij → de student-vorm van de mentor-endpoints. PURE.
 * calls_1on1_done = startsaldo + verbruikt in het LMS (zoals de LMS-teller).
 * `archived` = toegang verlopen (eind_datum vóór vandaag).
 */
export function mapLmsStudentRow(row, telling = null, vandaag = vandaagBrussel()) {
  const voornaam = String(row?.voornaam || '').trim();
  const achternaam = String(row?.achternaam || '').trim();
  const email = mail(row?.email) || null;
  const name = [voornaam, achternaam].filter(Boolean).join(' ') || email || '';
  const startsaldo = Math.max(0, Number(row?.calls_startsaldo ?? row?.calls_gedaan ?? 0) || 0);
  const t = telling || { afgerond: 0, noShow: 0 };
  const eind = row?.eind_datum ? String(row.eind_datum).slice(0, 10) : null;
  return {
    student_id        : studentSleutel(row),
    lms_student_id    : row?.id ? String(row.id) : null,
    name,
    email,
    telefoon          : row?.telefoon ? String(row.telefoon).trim() || null : null,
    program           : row?.product_soort || null,
    membership        : row?.membership_type || null,
    onboarding_status : row?.onboarding_status || null,
    calls_1on1_done   : startsaldo + t.afgerond + t.noShow,
    calls_1on1_total  : Math.max(0, Number(row?.calls_totaal ?? 0) || 0),
    calls_telling_ontbreekt: telling === null,
    no_shows          : t.noShow,
    start_datum       : row?.start_datum || null,
    eind_datum        : eind,
    mentor_lms_id     : row?.mentor_id ? String(row.mentor_id) : null,
    archived          : !!(eind && eind < vandaag),
  };
}

/**
 * Volledige student-vormen van de eigen mentor.
 * @returns {Promise<{ linked: boolean, reden: string|null, students: object[] }>}
 */
export async function getMentorStudents(effectiveUserId, { metTelling = true } = {}) {
  const k = await getMentorLmsKoppeling(effectiveUserId);
  if (!k.linked) return { linked: false, reden: k.reden, students: [] };
  const rows = await fetchLmsStudentenVanMentor(k.personeelId);
  const telling = metTelling ? await telSessiesPerStudent(rows.map((r) => r.id)) : null;
  const vandaag = vandaagBrussel();
  const students = rows
    .map((r) => mapLmsStudentRow(r, telling ? (telling.get(String(r.id)) || { afgerond: 0, noShow: 0 }) : null, vandaag))
    .filter((s) => s.student_id);
  return { linked: true, reden: null, students };
}

/**
 * Alleen de (lowercased) e-mails van de eigen studenten — voor de
 * factuur-badges en de scope-check bij het opnieuw sturen van een factuur.
 * @returns {Promise<{ linked: boolean, emails: string[] }>}
 */
export async function getMentorStudentEmails(effectiveUserId) {
  const { linked, students } = await getMentorStudents(effectiveUserId, { metTelling: false });
  if (!linked) return { linked: false, emails: [] };
  const set = new Set(students.map((s) => s.email).filter(Boolean));
  return { linked: true, emails: Array.from(set) };
}

/**
 * Hoort deze studentsleutel bij deze mentor? Voor eigendomschecks
 * (funded-certificaten, signalen). Zoekt in het LMS op de sleutel (oud id óf
 * LMS-id) en vergelijkt hlms_student.mentor_id met het personeels-id.
 * @returns {Promise<{ ok: boolean, reden?: string, student?: object }>}
 */
export async function isStudentVanMentor(effectiveUserId, sleutel) {
  const s = String(sleutel || '').trim();
  if (!s) return { ok: false, reden: 'student_id ontbreekt' };
  const k = await getMentorLmsKoppeling(effectiveUserId);
  if (!k.linked) return { ok: false, reden: 'mentor niet gekoppeld aan het LMS (' + k.reden + ')' };
  const lms = vereisLms();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  let q = lms.from('hlms_student').select(STUDENT_KOLOMMEN).limit(2);
  q = isUuid ? q.or(`id.eq.${s},bubble_user_id.eq.${s}`) : q.eq('bubble_user_id', s);
  const { data, error } = await q;
  if (error) throw lmsFout('hlms_student lezen: ' + error.message);
  const rows = data || [];
  if (rows.length === 0) return { ok: false, reden: 'student niet gevonden in het LMS' };
  if (rows.length > 1) return { ok: false, reden: 'studentsleutel is niet eenduidig' };
  if (String(rows[0].mentor_id || '') !== k.personeelId) {
    return { ok: false, reden: 'student hoort niet bij deze mentor' };
  }
  return { ok: true, student: mapLmsStudentRow(rows[0], null) };
}

/** HTTP-status voor een fout uit deze module. */
export function httpStatusVoor(e) {
  return e && e.code === 'DFO_LMS_ONBEREIKBAAR' ? 503 : 500;
}

// ── E-mail → mentornaam (org-breed) ────────────────────────────────────────
// Voor readers zoals sales-retention die per klant de mentor willen tonen.
// Vervangt bubbleStudentMentors.js. Cache 15 min; FAALZACHT: bij een
// LMS-fout een lege Map (de aanroeper valt terug op de CRM-mentor).
const MENTOR_MAP_TTL_MS = 15 * 60 * 1000;
let _mentorMapCache = { at: 0, map: null, promise: null };

/** @returns {Promise<Map<string,string>>} lower(email) → mentornaam */
export async function getStudentMentorNaamMap() {
  const now = Date.now();
  if (_mentorMapCache.map && (now - _mentorMapCache.at) < MENTOR_MAP_TTL_MS) return _mentorMapCache.map;
  if (_mentorMapCache.promise) return _mentorMapCache.promise;
  const p = (async () => {
    try {
      const [rows, namen] = await Promise.all([fetchAlleLmsStudenten(), personeelNamen()]);
      const map = new Map();
      for (const r of rows) {
        const e = mail(r.email);
        const nm = r.mentor_id ? namen.get(String(r.mentor_id)) : null;
        if (e && nm) map.set(e, nm);
      }
      _mentorMapCache = { at: Date.now(), map, promise: null };
      return map;
    } catch (e) {
      console.warn('[mentorStudents] mentor-map fail-soft:', e?.message || e);
      _mentorMapCache.promise = null;
      return new Map();
    }
  })();
  _mentorMapCache.promise = p;
  return p;
}
