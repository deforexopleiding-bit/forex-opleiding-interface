// api/_lib/coaching-earnings.js
//
// Gedeelde helper voor coaching-verdiensten. Wordt gebruikt door:
//   - mentor-coaching-earnings.js (UI op de Coaching-tab van mentor-dashboard)
//   - payout-generate-core.js     (snapshot voor maand-rapport)
//   - mentor-coaching-debug.js    (debugknop in het rapport)
// Door dezelfde helper te gebruiken matcht het rapport exact wat de mentor zelf ziet.
//
// Input:
//   { mentorUserId: uuid (verplicht), bubbleUserId?: string,
//     from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' (inclusief) }
//
// Output (incl btw — tarieven 35/50/25/100):
//   { breakdown:  { one_on_one, team, no_show, funded }, grand_total,
//     students_count, sessions_fetched, team_count_raw,
//     _meta: { bronnen: { lms, bubble }, lms_exacte_dubbels,
//              bubble_overgeslagen_dubbel_met_lms, lms_teamtraining, ... } }
//
// Zie docs/mentorrapport-bron-lms.md voor de volledige uitleg.
//
// ─── Twee bronnen ────────────────────────────────────────────────────────
// 1) LMS (dfo-lms, ALTIJD): hlms_sessie met mentor_id = mentorUserId en
//    status afgerond (€35) / no_show (€25), start_tijd in het venster.
//    Attributie op de mentor_id van de SESSIE (wie de call deed). Geen
//    leertype-filter. Exacte dubbels (zelfde student + start_tijd + mentor)
//    tellen één keer; opeenvolgende sessies met een andere starttijd tellen
//    wél (bewuste businessregel). Teamtraining (€50): hlms_teamtraining met
//    trainer personeel_id = mentorUserId en status 'gegeven'.
// 2) Bubble (ALLEEN vóór BUBBLE_EINDE): de oude regels, ongewijzigd —
//    1-1-session op Created By + Alpha Program + isdone, call vereist
//    member_user; team-training via tutor_user op completeddate. Een
//    Bubble-sessie telt NIET als dezelfde student (member_user ↔
//    hlms_student.bubble_user_id) die Brusselse kalenderdag een afgeronde of
//    no-show sessie in het LMS heeft (bij welke mentor ook).
//
// ─── Venster ─────────────────────────────────────────────────────────────
// [from 00:00 Europe/Brussels, (to+1) 00:00 Europe/Brussels) — DST-correct.
// Geldt voor beide bronnen.
//
// ─── Faalgedrag ──────────────────────────────────────────────────────────
// Een onbereikbare bron wordt NOOIT stil 0. LMS niet geconfigureerd of
// onbereikbaar → throw. Bubble nodig (venster vóór BUBBLE_EINDE) en
// onbereikbaar → throw. Funded-telling (CRM) faalt → throw. Enige benoemde
// uitzondering: de kolom hlms_teamtraining.status bestaat nog niet →
// team_lms = 0 met _meta.lms_teamtraining = 'stand-kolom-ontbreekt'.
//
// Funded (€100): mentor_funded_certificates, funded_month in [from, to].

import { bubbleList as bubbleListDefault } from './bubble.js';
import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';

export const RATE_1ON1   = 35;
export const RATE_TEAM   = 50;
export const RATE_NOSHOW = 25;
export const RATE_FUNDED = 100;

// Eerste dag (Brusselse tijd) waarop Bubble NIET meer bevraagd wordt.
export const BUBBLE_EINDE = '2026-10-01';

export const LMS_TEAMTRAINING_KOLOM_ONTBREEKT = 'stand-kolom-ontbreekt';

const TZ = 'Europe/Brussels';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LMS_PAGINA = 1000;
const LMS_MAX_PAGINAS = 50;
const IN_CHUNK = 100; // ids per .in()-filter — houdt de PostgREST-URL kort

// ─── Brusselse tijd ──────────────────────────────────────────────────────

const _dtf = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function _wandklok(ms) {
  const p = {};
  for (const x of _dtf.formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}

// Offset (ms) van Brussel t.o.v. UTC op een bepaald moment.
function _offsetMs(ms) {
  const p = _wandklok(ms);
  const alsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return alsUtc - Math.floor(ms / 1000) * 1000;
}

/** 'YYYY-MM-DD' → epoch-ms van 00:00 Brusselse tijd op die dag. */
export function brusselsMiddernachtMs(ymd) {
  const gok = Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
  const o1 = _offsetMs(gok);
  let t = gok - o1;
  const o2 = _offsetMs(t);
  if (o2 !== o1) t = gok - o2;
  return t;
}

/** Tijdstip (ISO of ms) → Brusselse kalenderdag 'YYYY-MM-DD'. null bij ongeldig. */
export function brusselsDag(v) {
  const ms = (typeof v === 'number') ? v : new Date(String(v)).getTime();
  if (!Number.isFinite(ms)) return null;
  const p = _wandklok(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

function plusDagen(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

// ─── Kleine helpers ──────────────────────────────────────────────────────

function asBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true','yes','ja','1'].includes(s)) return true;
    if (['false','no','nee','0'].includes(s)) return false;
  }
  return !!v;
}

function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) {
    if (u[k] !== undefined) return u[k];
  }
  return undefined;
}

// Bubble option-set → leesbare string ('Alpha Program' etc).
function pickOption(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const d = v.display || v.text || v.value || null;
    return d ? String(d).trim() || null : null;
  }
  return null;
}

function inRange(rawDate, fromMs, toMsExclusive) {
  if (!rawDate) return false;
  const t = (typeof rawDate === 'number') ? rawDate : new Date(String(rawDate)).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= fromMs && t < toMsExclusive;
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function bronFout(bron, msg, code) {
  const e = new Error(`${bron}: ${msg}`);
  e.code = code;
  return e;
}

function lmsFout(msg) { return bronFout('LMS onbereikbaar', msg, 'LMS_ONBEREIKBAAR'); }

export function isKolomOntbreektFout(error) {
  if (!error) return false;
  if (String(error.code || '') === '42703') return true;
  return /column .* does not exist/i.test(String(error.message || ''));
}

export function emptyBreakdown() {
  return {
    one_on_one : { count: 0, rate: RATE_1ON1,   total: 0 },
    team       : { count: 0, rate: RATE_TEAM,   total: 0 },
    no_show    : { count: 0, rate: RATE_NOSHOW, total: 0 },
    funded     : { count: 0, rate: RATE_FUNDED, total: 0 },
  };
}

// ─── LMS-tak ─────────────────────────────────────────────────────────────

// Gepagineerde select: bouwQuery() levert een verse keten zonder range.
async function lmsAlles(bouwQuery, label) {
  const rijen = [];
  for (let pagina = 0; pagina < LMS_MAX_PAGINAS; pagina++) {
    const van = pagina * LMS_PAGINA;
    const { data, error } = await bouwQuery().range(van, van + LMS_PAGINA - 1);
    if (error) throw lmsFout(`${label}: ${error.message || error.code || 'onbekende fout'}`);
    const arr = Array.isArray(data) ? data : [];
    rijen.push(...arr);
    if (arr.length < LMS_PAGINA) return rijen;
  }
  throw lmsFout(`${label}: meer dan ${LMS_PAGINA * LMS_MAX_PAGINAS} rijen — venster te groot`);
}

async function lmsSessiesVanMentor(lms, mentorUserId, vanIso, totIso) {
  const rijen = await lmsAlles(() => lms
    .from('hlms_sessie')
    .select('id, student_id, mentor_id, start_tijd, status')
    .eq('mentor_id', mentorUserId)
    .in('status', ['afgerond', 'no_show'])
    .gte('start_tijd', vanIso)
    .lt('start_tijd', totIso)
    .order('start_tijd', { ascending: true })
    .order('id', { ascending: true }), 'hlms_sessie');

  // Exacte dubbels: zelfde student + zelfde moment + zelfde mentor = één call.
  // Is één van de dubbels afgerond, dan telt de groep als afgerond.
  const groepen = new Map();
  let zonderStudent = 0;
  for (const r of rijen) {
    const status = String(r?.status || '').trim().toLowerCase();
    if (status !== 'afgerond' && status !== 'no_show') continue;
    const t = new Date(String(r.start_tijd)).getTime();
    let sleutel;
    if (r.student_id && Number.isFinite(t)) {
      sleutel = `${r.student_id}|${t}|${r.mentor_id || mentorUserId}`;
    } else {
      zonderStudent += 1;
      sleutel = `id|${r.id}`;
    }
    const bestaand = groepen.get(sleutel);
    if (!bestaand) groepen.set(sleutel, { status, n: 1 });
    else {
      bestaand.n += 1;
      if (status === 'afgerond') bestaand.status = 'afgerond';
    }
  }
  let afgerond = 0, noShow = 0, dubbels = 0;
  for (const g of groepen.values()) {
    if (g.status === 'afgerond') afgerond += 1; else noShow += 1;
    dubbels += g.n - 1;
  }
  return { rijen: rijen.length, afgerond, no_show: noShow, exacte_dubbels: dubbels, zonder_student: zonderStudent };
}

async function lmsTeamtrainingen(lms, mentorUserId, vanIso, totIso) {
  const koppels = await lmsAlles(() => lms
    .from('hlms_teamtraining_trainer')
    .select('training_id')
    .eq('personeel_id', mentorUserId)
    .order('training_id', { ascending: true }), 'hlms_teamtraining_trainer');
  const ids = Array.from(new Set(koppels.map((k) => k?.training_id).filter(Boolean).map(String)));
  if (ids.length === 0) return { team: 0, status: 'gelezen', rijen: 0 };

  let team = 0, rijen = 0;
  for (const deel of chunks(ids, IN_CHUNK)) {
    const { data, error } = await lms
      .from('hlms_teamtraining')
      .select('id, start_tijd, status')
      .in('id', deel)
      .eq('status', 'gegeven')
      .gte('start_tijd', vanIso)
      .lt('start_tijd', totIso);
    if (error) {
      if (isKolomOntbreektFout(error)) {
        return { team: 0, status: LMS_TEAMTRAINING_KOLOM_ONTBREEKT, rijen: 0 };
      }
      throw lmsFout(`hlms_teamtraining: ${error.message || error.code || 'onbekende fout'}`);
    }
    const arr = Array.isArray(data) ? data : [];
    rijen += arr.length;
    const gezien = new Set();
    for (const t of arr) {
      if (String(t?.status || '') !== 'gegeven') continue;
      if (gezien.has(String(t.id))) continue;
      gezien.add(String(t.id));
      team += 1;
    }
  }
  return { team, status: 'gelezen', rijen };
}

// Set van `${bubble_user_id}|${brusselsDag}` voor alle afgeronde/no-show
// LMS-sessies (bij welke mentor ook) van de gegeven Bubble-studenten.
async function lmsDagenVanBubbleStudenten(lms, bubbleIds, vanIso, totIso) {
  const set = new Set();
  if (bubbleIds.length === 0) return set;
  const bubbleVanStudent = new Map();
  for (const deel of chunks(bubbleIds, IN_CHUNK)) {
    const { data, error } = await lms
      .from('hlms_student')
      .select('id, bubble_user_id')
      .in('bubble_user_id', deel);
    if (error) throw lmsFout(`hlms_student: ${error.message || error.code || 'onbekende fout'}`);
    for (const s of (data || [])) {
      if (s?.id && s?.bubble_user_id) bubbleVanStudent.set(String(s.id), String(s.bubble_user_id));
    }
  }
  const studentIds = Array.from(bubbleVanStudent.keys());
  for (const deel of chunks(studentIds, IN_CHUNK)) {
    const rijen = await lmsAlles(() => lms
      .from('hlms_sessie')
      .select('id, student_id, start_tijd, status')
      .in('student_id', deel)
      .in('status', ['afgerond', 'no_show'])
      .gte('start_tijd', vanIso)
      .lt('start_tijd', totIso)
      .order('id', { ascending: true }), 'hlms_sessie (ontdubbeling)');
    for (const r of rijen) {
      const bid = bubbleVanStudent.get(String(r.student_id));
      const dag = brusselsDag(r.start_tijd);
      if (bid && dag) set.add(`${bid}|${dag}`);
    }
  }
  return set;
}

// ─── Bubble-tak ──────────────────────────────────────────────────────────

async function bubbleTak({ bubbleList, lms, bubbleUserId, vanMs, totMs }) {
  // Bubble greater-than/less-than op date-constraints zijn strikt.
  const dateConstraints = [
    { key: 'starting_date_date', constraint_type: 'greater than', value: new Date(vanMs - 1).toISOString() },
    { key: 'starting_date_date', constraint_type: 'less than',    value: new Date(totMs).toISOString() },
  ];
  const cbConstraint = { key: 'Created By', constraint_type: 'equals', value: bubbleUserId };

  // Probeer eerst server-side filter op Created By; fallback date-only. Faalt
  // ook die → throw (nooit stil 0).
  const FETCH_CAP = 3000;
  const fetchPaths = [];
  let sessionRows;
  let cbConstraintApplied = false;
  try {
    const { results } = await bubbleList('1-1-session', [...dateConstraints, cbConstraint], { limit: FETCH_CAP });
    sessionRows = results || [];
    cbConstraintApplied = true;
    fetchPaths.push('date+cb');
  } catch (e) {
    console.warn('[coaching-earnings] Created-By server-constraint faalde, fallback date-only:', e?.message || e);
    try {
      const { results } = await bubbleList('1-1-session', dateConstraints, { limit: FETCH_CAP });
      sessionRows = results || [];
      fetchPaths.push('date-only');
    } catch (e2) {
      const err = new Error('Bubble onbereikbaar (1-1-session): ' + (e2?.message || e2));
      err.code = e2?.code || 'BUBBLE_ONBEREIKBAAR';
      throw err;
    }
  }

  // Kandidaten volgens de ongewijzigde Bubble-regels.
  const kandidaten = [];
  let afterCbFilter = 0;
  let orphanCallsSkipped = 0;
  for (const s of sessionRows) {
    const cb = readFirst(s, ['Created By', 'created_by']);
    if (!cb || String(cb) !== bubbleUserId) continue;
    afterCbFilter += 1;
    const lt = pickOption(readFirst(s, ['learn_type1_option_os___learning_type']));
    if (lt !== 'Alpha Program') continue;
    if (!asBool(readFirst(s, ['isdone_boolean', 'isDone']))) continue;
    const sd = readFirst(s, ['starting_date_date', 'starting date']);
    if (!inRange(sd, vanMs, totMs)) continue;
    const ns = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
    const member = readFirst(s, ['member_user']);
    const memberStr = (member && String(member).trim()) ? String(member).trim() : null;
    if (!ns && !memberStr) { orphanCallsSkipped += 1; continue; }
    kandidaten.push({ ns, member: memberStr, dag: brusselsDag(sd) });
  }

  // Ontdubbelen tegen het LMS (zelfde student + zelfde Brusselse dag).
  const memberIds = Array.from(new Set(kandidaten.map((k) => k.member).filter(Boolean)));
  const lmsDagen = await lmsDagenVanBubbleStudenten(
    lms, memberIds, new Date(vanMs).toISOString(), new Date(totMs).toISOString());
  let calls = 0, noShow = 0, overgeslagen = 0;
  for (const k of kandidaten) {
    if (k.member && k.dag && lmsDagen.has(`${k.member}|${k.dag}`)) { overgeslagen += 1; continue; }
    if (k.ns) noShow += 1; else calls += 1;
  }

  // Team-trainingen via tutor_user op completeddate.
  let teamRows;
  try {
    const { results } = await bubbleList(
      'team-training',
      [{ key: 'tutor_user', constraint_type: 'equals', value: bubbleUserId }],
      { limit: 1000 },
    );
    teamRows = results || [];
  } catch (e) {
    const err = new Error('Bubble onbereikbaar (team-training): ' + (e?.message || e));
    err.code = e?.code || 'BUBBLE_ONBEREIKBAAR';
    throw err;
  }
  let team = 0;
  for (const tt of teamRows) {
    const done = asBool(readFirst(tt, ['isdone_boolean', 'isDone']));
    const dt   = readFirst(tt, ['completeddate_date', 'completedDate']);
    if (done && inRange(dt, vanMs, totMs)) team += 1;
  }

  return {
    calls, no_show: noShow, team, overgeslagen,
    sessions_fetched: sessionRows.length, team_count_raw: teamRows.length,
    afterCbFilter, orphanCallsSkipped, cbConstraintApplied, fetchPaths,
  };
}

// ─── Hoofdfunctie ────────────────────────────────────────────────────────
//
// `deps` is er alleen voor tests: { lmsClient, bubbleList, crmClient }.
// Laat 'm weg in productie.
export async function computeCoachingEarnings({ bubbleUserId, mentorUserId, from, to }, deps = {}) {
  if (!mentorUserId) throw new Error('coaching-earnings: mentorUserId vereist');
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    throw new Error('coaching-earnings: from/to moeten YYYY-MM-DD zijn');
  }
  if (from > to) throw new Error('coaching-earnings: from > to');

  const vanMs = brusselsMiddernachtMs(from);
  const totMs = brusselsMiddernachtMs(plusDagen(to, 1));
  if (!Number.isFinite(vanMs) || !Number.isFinite(totMs)) throw new Error('coaching-earnings: ongeldige datum');
  const vanIso = new Date(vanMs).toISOString();
  const totIso = new Date(totMs).toISOString();

  // ── LMS (altijd) ──────────────────────────────────────────────────────
  const lms = deps.lmsClient || getDfoLmsClient();
  if (!lms) {
    throw bronFout('LMS niet geconfigureerd', 'DFO_LMS_SUPABASE_URL/KEY ontbreekt', 'LMS_NIET_GECONFIGUREERD');
  }
  let lmsSessies, lmsTeam;
  try {
    lmsSessies = await lmsSessiesVanMentor(lms, mentorUserId, vanIso, totIso);
    lmsTeam    = await lmsTeamtrainingen(lms, mentorUserId, vanIso, totIso);
  } catch (e) {
    if (e?.code === 'LMS_ONBEREIKBAAR') throw e;
    throw lmsFout(e?.message || String(e));
  }

  // ── Bubble (alleen deel vóór BUBBLE_EINDE) ────────────────────────────
  const bubbleEindeMs = brusselsMiddernachtMs(BUBBLE_EINDE);
  const bubbleTotMs = Math.min(totMs, bubbleEindeMs);
  let bubble = null;
  let bubbleStatus;
  if (vanMs >= bubbleEindeMs) {
    bubbleStatus = 'niet-van-toepassing';
  } else if (!bubbleUserId) {
    bubbleStatus = 'geen-bubble-koppeling';
  } else {
    bubble = await bubbleTak({
      bubbleList: deps.bubbleList || bubbleListDefault,
      lms, bubbleUserId, vanMs, totMs: bubbleTotMs,
    });
    bubbleStatus = 'gelezen';
  }

  // ── Funded (CRM) ──────────────────────────────────────────────────────
  const crm = deps.crmClient || supabaseAdmin;
  const { count, error: fundedErr } = await crm
    .from('mentor_funded_certificates')
    .select('id', { count: 'exact', head: true })
    .eq('mentor_user_id', mentorUserId)
    .gte('funded_month', from)
    .lte('funded_month', to);
  if (fundedErr) throw new Error('funded-certificaten lezen mislukt: ' + fundedErr.message);
  const funded = Number(count) || 0;

  const oneOnOne = lmsSessies.afgerond + (bubble?.calls   || 0);
  const noShow   = lmsSessies.no_show  + (bubble?.no_show || 0);
  const team     = lmsTeam.team        + (bubble?.team    || 0);

  const breakdown = {
    one_on_one : { count: oneOnOne, rate: RATE_1ON1,   total: oneOnOne * RATE_1ON1   },
    team       : { count: team,     rate: RATE_TEAM,   total: team     * RATE_TEAM   },
    no_show    : { count: noShow,   rate: RATE_NOSHOW, total: noShow   * RATE_NOSHOW },
    funded     : { count: funded,   rate: RATE_FUNDED, total: funded   * RATE_FUNDED },
  };
  const grand_total = breakdown.one_on_one.total
                    + breakdown.team.total
                    + breakdown.no_show.total
                    + breakdown.funded.total;

  return {
    breakdown,
    grand_total,
    students_count   : 0,
    sessions_fetched : lmsSessies.rijen + (bubble?.sessions_fetched || 0),
    team_count_raw   : lmsTeam.rijen + (bubble?.team_count_raw || 0),
    _meta: {
      venster: { van: vanIso, tot: totIso, tijdzone: TZ, bubble_einde: BUBBLE_EINDE },
      bronnen: {
        lms: {
          status  : 'gelezen',
          afgerond: lmsSessies.afgerond,
          no_show : lmsSessies.no_show,
          team    : lmsTeam.team,
        },
        bubble: {
          status : bubbleStatus,
          calls  : bubble?.calls   || 0,
          no_show: bubble?.no_show || 0,
          team   : bubble?.team    || 0,
        },
      },
      lms_sessies_gelezen               : lmsSessies.rijen,
      lms_exacte_dubbels                : lmsSessies.exacte_dubbels,
      lms_zonder_student                : lmsSessies.zonder_student,
      lms_teamtraining                  : lmsTeam.status,
      bubble_overgeslagen_dubbel_met_lms: bubble?.overgeslagen || 0,
      // Bubble-diagnose (zelfde velden als vóór de LMS-omzetting).
      fetchedRaw          : bubble?.sessions_fetched || 0,
      afterCbFilter       : bubble?.afterCbFilter || 0,
      alphaDone           : bubble?.calls || 0,
      alphaNoshow         : bubble?.no_show || 0,
      orphanCallsSkipped  : bubble?.orphanCallsSkipped || 0,
      cbConstraintApplied : bubble?.cbConstraintApplied || false,
      fetchPaths          : bubble?.fetchPaths || [],
    },
  };
}
