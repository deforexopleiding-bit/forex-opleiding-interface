// api/_lib/coaching-earnings.js
//
// Gedeelde helper voor coaching-verdiensten. Wordt gebruikt door:
//   - mentor-coaching-earnings.js (UI op de Coaching-tab van mentor-dashboard)
//   - payout-generate-core.js     (snapshot voor maand-rapport)
//   - mentor-coaching-debug.js    (debugknop in het rapport)
// Door dezelfde helper te gebruiken matcht het rapport exact wat de mentor zelf ziet.
//
// Input:
//   { mentorUserId: uuid (verplicht),
//     from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' (inclusief) }
//
// Output (incl btw — tarieven 35/50/25/100):
//   { breakdown:  { one_on_one, team, no_show, funded }, grand_total,
//       elke cel: { count (= eenheden), rate, total, afspraken, meervoudig,
//                   meervoudig_per_eenheden },
//     students_count, sessions_fetched, team_count_raw,
//     _meta: { bronnen: { lms, oud_lms }, melding?, lms_zelfde_moment,
//              lms_teamtraining, ... } }
//
// Zie docs/mentorrapport-bron-lms.md voor de volledige uitleg.
//
// ─── Bron ────────────────────────────────────────────────────────────────
// LMS (dfo-lms): hlms_sessie met mentor_id = mentorUserId en status afgerond
// (€35) / no_show (€25), start_tijd in het venster. Attributie op de
// mentor_id van de SESSIE (wie de call deed). Geen leertype-filter. Eén
// afspraak = eenhedenVan(duur_minuten) sessies van 45 min (90 min = 2),
// exact zoals de studentteller in het LMS; de mentor krijgt €35/€25 per
// eenheid. Elke rij telt — ook rijen met dezelfde student + start_tijd +
// mentor; die worden alleen gesignaleerd in _meta.lms_zelfde_moment.
// Teamtraining (€50): hlms_teamtraining met trainer personeel_id =
// mentorUserId en status 'gegeven'.
//
// BUBBLE IS DICHT (9 okt 2026, Maxim). Tot oktober 2026 telde hier ook een
// Bubble-tak mee (1-1-session / team-training). Die bestaat niet meer: er
// gaat geen enkele aanroep meer naar Bubble. Voor een venster dat (deels)
// vóór OUDE_BRON_EINDE (1 okt 2026) ligt, telt dit dus ALLEEN het LMS-deel;
// _meta.melding zegt dat, en _meta.bronnen.oud_lms.status = 'gesloten'. Het
// volledige bedrag van die maanden staat in de opgeslagen uitbetalingen
// (mentor_payouts / mentor_payout_lines) — payout-generate-core rekent
// zulke maanden daarom niet opnieuw uit (zie daar).

// ─── Venster ─────────────────────────────────────────────────────────────
// [from 00:00 Europe/Brussels, (to+1) 00:00 Europe/Brussels) — DST-correct.
// Geldt voor beide bronnen.
//
// ─── Faalgedrag ──────────────────────────────────────────────────────────
// Een onbereikbare bron wordt NOOIT stil 0. LMS niet geconfigureerd of
// onbereikbaar → throw. Funded-telling (CRM) faalt → throw. Enige benoemde
// uitzondering: de kolom hlms_teamtraining.status bestaat nog niet →
// team_lms = 0 met _meta.lms_teamtraining = 'stand-kolom-ontbreekt'.
//
// Funded (€100): mentor_funded_certificates, funded_month in [from, to].
//
// Intake (€8,75 = ¼ × €35, sinds 5 oktober 2026): hlms_intake met
// afgerond_door = mentorUserId en GOEDGEKEURD_OP in het venster. Sinds 6
// oktober (Maxim) telt een intake pas als de hoofdmentor hem goedkeurde:
// "Intake klaar" van de mentor alleen is nog geen verloning. Zolang
// hlms_telefoon_en_intake_notitie.sql niet gedraaid is, bestaat
// goedgekeurd_op niet → intake 0 met _meta.lms_intake = 'goedkeuring-ontbreekt'. Een intake is
// GEEN hlms_sessie: hij verbruikt geen sessie van het pakket van de student
// en sluit de onboarding niet. Vier intakes = één sessie. Benoemde
// uitzondering op "nooit stil 0": zolang hlms_intake.sql niet gedraaid is,
// bestaat de tabel niet → intake 0 met _meta.lms_intake = 'tabel-ontbreekt'.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';

export const RATE_1ON1   = 35;
export const RATE_TEAM   = 50;
export const RATE_NOSHOW = 25;
export const RATE_FUNDED = 100;
/** Een afgeronde intake is een kwart sessie. */
export const INTAKE_EENHEID = 0.25;
export const RATE_INTAKE = RATE_1ON1 * INTAKE_EENHEID;
export const LMS_INTAKE_TABEL_ONTBREEKT = 'tabel-ontbreekt';
export const LMS_INTAKE_GOEDKEURING_ONTBREEKT = 'goedkeuring-ontbreekt';

/** De kolom goedgekeurd_op bestaat (nog) niet. PURE. */
export function isGoedkeuringKolomOntbreekt(error) {
  const code = String(error?.code || '');
  return (code === '42703' || code === 'PGRST204' || code === 'PGRST100')
    && /goedgekeurd_op/.test(String(error?.message || ''));
}

// Eerste dag (Brusselse tijd) waarop de oude leeromgeving niet meer meetelde.
// Vensters die daarvóór beginnen zijn met deze helper alleen voor het
// LMS-deel te berekenen — zie de kop.
export const OUDE_BRON_EINDE = '2026-10-01';
export const MELDING_OUDE_BRON =
  'Perioden vóór 1 oktober 2026 zijn deels in de oude leeromgeving (Bubble) gegeven, '
  + 'die gesloten is. Dit toont alleen het LMS-deel; het volledige bedrag van die '
  + 'maanden staat in de opgeslagen uitbetaling.';

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

// De tabel zelf bestaat niet (migratie nog niet gedraaid): Postgres 42P01 of
// PostgREST PGRST205 ("Could not find the table").
export function isTabelOntbreektFout(error) {
  if (!error) return false;
  const code = String(error.code || '');
  if (code === '42P01' || code === 'PGRST205') return true;
  return /relation .* does not exist|could not find the table/i.test(String(error.message || ''));
}

export function emptyBreakdown() {
  return {
    one_on_one : { count: 0, rate: RATE_1ON1,   total: 0 },
    team       : { count: 0, rate: RATE_TEAM,   total: 0 },
    no_show    : { count: 0, rate: RATE_NOSHOW, total: 0 },
    funded     : { count: 0, rate: RATE_FUNDED, total: 0 },
    intake     : { count: 0, rate: RATE_INTAKE, total: 0 },
  };
}

// ─── Sessie-eenheden ─────────────────────────────────────────────────────

export const EENHEID_MINUTEN = 45;

/**
 * Aantal sessie-eenheden van 45 min voor een afspraak — identiek aan de
 * studentteller in het LMS: max(1, round(duur / 45)); duur null/0 → 45.
 * 30 → 1, 45 → 1, 60 → 1, 90 → 2, 135 → 3, 180 → 4.
 */
export function eenhedenVan(duurMinuten) {
  let d = Number(duurMinuten);
  if (!Number.isFinite(d) || d <= 0) d = EENHEID_MINUTEN;
  return Math.max(1, Math.round(d / EENHEID_MINUTEN));
}

// Telling per categorie: eenheden (= wat betaald wordt), afspraken (rijen) en
// per_eenheden { aantalEenheden: aantalAfspraken } voor de meervoudige.
function nieuweTelling() { return { eenheden: 0, afspraken: 0, per_eenheden: {} }; }
function telAfspraak(t, eenheden, n = 1) {
  t.eenheden  += eenheden * n;
  t.afspraken += n;
  if (eenheden > 1) t.per_eenheden[eenheden] = (t.per_eenheden[eenheden] || 0) + n;
}
function meervoudigVan(t) {
  return Object.values(t.per_eenheden).reduce((a, b) => a + b, 0);
}

/**
 * Label voor een payoutregel. Zonder meervoudige afspraken het gewone label;
 * mét bv. "1-op-1 sessies à 45 min (86 afspraken, waarvan 5 van 90 min)".
 */
export function coachingRegelLabel(basis, cel) {
  const per = cel?.meervoudig_per_eenheden || {};
  const delen = Object.keys(per).map(Number).sort((a, b) => a - b)
    .map((e) => `${per[e]} van ${e * EENHEID_MINUTEN} min`);
  if (!delen.length) return basis;
  const lijst = delen.length > 1 ? `${delen.slice(0, -1).join(', ')} en ${delen[delen.length - 1]}` : delen[0];
  const n = Number(cel.afspraken) || 0;
  return `${basis} à ${EENHEID_MINUTEN} min (${n} ${n === 1 ? 'afspraak' : 'afspraken'}, waarvan ${lijst})`;
}

/** Label van de intakeregel op de uitbetaling: "Intakes: 3 × 0,25". */
export function intakeRegelLabel(n) {
  return `Intakes: ${Number(n) || 0} × ${String(INTAKE_EENHEID).replace('.', ',')}`;
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
    .select('id, student_id, mentor_id, start_tijd, status, duur_minuten')
    .eq('mentor_id', mentorUserId)
    .in('status', ['afgerond', 'no_show'])
    .gte('start_tijd', vanIso)
    .lt('start_tijd', totIso)
    .order('start_tijd', { ascending: true })
    .order('id', { ascending: true }), 'hlms_sessie');

  // Elke rij telt, met eenhedenVan(duur_minuten) eenheden — exact zoals de
  // studentteller in het LMS. Geen ontdubbeling meer: rijen met dezelfde
  // student + start_tijd + mentor worden alleen gesignaleerd (lms_zelfde_moment).
  const afgerond = nieuweTelling();
  const noShow   = nieuweTelling();
  const momenten = new Map();
  let zonderStudent = 0;
  for (const r of rijen) {
    const status = String(r?.status || '').trim().toLowerCase();
    if (status !== 'afgerond' && status !== 'no_show') continue;
    telAfspraak(status === 'afgerond' ? afgerond : noShow, eenhedenVan(r.duur_minuten));
    const t = new Date(String(r.start_tijd)).getTime();
    if (!r.student_id || !Number.isFinite(t)) { zonderStudent += 1; continue; }
    const sleutel = `${r.student_id}|${t}|${r.mentor_id || mentorUserId}`;
    const m = momenten.get(sleutel);
    if (m) m.rijen += 1;
    else momenten.set(sleutel, { student_id: r.student_id, start_tijd: new Date(t).toISOString(), rijen: 1 });
  }
  const zelfdeMoment = [...momenten.values()].filter((m) => m.rijen > 1);
  return { rijen: rijen.length, afgerond, no_show: noShow, zelfde_moment: zelfdeMoment, zonder_student: zonderStudent };
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

// GOEDGEKEURDE intakes van deze mentor in het venster (zie de kop).
async function lmsIntakes(lms, mentorUserId, vanIso, totIso) {
  const rijen = [];
  for (let pagina = 0; pagina < LMS_MAX_PAGINAS; pagina++) {
    const van = pagina * LMS_PAGINA;
    const { data, error } = await lms
      .from('hlms_intake')
      .select('crm_onboarding_id, goedgekeurd_op')
      .eq('afgerond_door', mentorUserId)
      .gte('goedgekeurd_op', vanIso)
      .lt('goedgekeurd_op', totIso)
      .order('goedgekeurd_op', { ascending: true })
      .range(van, van + LMS_PAGINA - 1);
    if (error) {
      if (isTabelOntbreektFout(error)) return { intakes: 0, status: LMS_INTAKE_TABEL_ONTBREEKT };
      if (isGoedkeuringKolomOntbreekt(error)) return { intakes: 0, status: LMS_INTAKE_GOEDKEURING_ONTBREEKT };
      throw lmsFout(`hlms_intake: ${error.message || error.code || 'onbekende fout'}`);
    }
    const arr = Array.isArray(data) ? data : [];
    rijen.push(...arr);
    if (arr.length < LMS_PAGINA) return { intakes: rijen.length, status: 'gelezen' };
  }
  throw lmsFout(`hlms_intake: meer dan ${LMS_PAGINA * LMS_MAX_PAGINAS} rijen — venster te groot`);
}

// ─── Hoofdfunctie ────────────────────────────────────────────────────────
//
// `deps` is er alleen voor tests: { lmsClient, crmClient }.
// Laat 'm weg in productie.
export async function computeCoachingEarnings({ mentorUserId, from, to }, deps = {}) {
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
  let lmsSessies, lmsTeam, lmsIntake;
  try {
    lmsSessies = await lmsSessiesVanMentor(lms, mentorUserId, vanIso, totIso);
    lmsTeam    = await lmsTeamtrainingen(lms, mentorUserId, vanIso, totIso);
    lmsIntake  = await lmsIntakes(lms, mentorUserId, vanIso, totIso);
  } catch (e) {
    if (e?.code === 'LMS_ONBEREIKBAAR') throw e;
    throw lmsFout(e?.message || String(e));
  }

  // ── Oude bron (vóór OUDE_BRON_EINDE) — gesloten ──────────────────────
  const oudeBronGeraakt = vanMs < brusselsMiddernachtMs(OUDE_BRON_EINDE);

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

  // Eenheden per categorie.
  const t1 = { ...lmsSessies.afgerond, per_eenheden: { ...lmsSessies.afgerond.per_eenheden } };
  const tn = { ...lmsSessies.no_show,  per_eenheden: { ...lmsSessies.no_show.per_eenheden } };
  const team = lmsTeam.team;

  const cel = (count, rate, extra = {}) => ({
    count, rate, total: count * rate,
    afspraken: count, meervoudig: 0, meervoudig_per_eenheden: {}, ...extra,
  });
  const celVan = (t, rate) => cel(t.eenheden, rate, {
    afspraken: t.afspraken, meervoudig: meervoudigVan(t), meervoudig_per_eenheden: t.per_eenheden,
  });
  // count = eenheden (wat betaald wordt); afspraken = rijen; meervoudig =
  // afspraken van meer dan één eenheid.
  const breakdown = {
    one_on_one : celVan(t1, RATE_1ON1),
    team       : cel(team,   RATE_TEAM),
    no_show    : celVan(tn, RATE_NOSHOW),
    funded     : cel(funded, RATE_FUNDED),
    // count = aantal intakes; eenheid = het deel van een sessie dat elk telt.
    intake     : cel(lmsIntake.intakes, RATE_INTAKE, { eenheid: INTAKE_EENHEID }),
  };
  const grand_total = breakdown.one_on_one.total
                    + breakdown.team.total
                    + breakdown.no_show.total
                    + breakdown.funded.total
                    + breakdown.intake.total;

  return {
    breakdown,
    grand_total,
    students_count   : 0,
    sessions_fetched : lmsSessies.rijen,
    team_count_raw   : lmsTeam.rijen,
    _meta: {
      venster: { van: vanIso, tot: totIso, tijdzone: TZ, oude_bron_einde: OUDE_BRON_EINDE },
      ...(oudeBronGeraakt ? { melding: MELDING_OUDE_BRON } : {}),
      bronnen: {
        lms: {
          status  : 'gelezen',
          afgerond: lmsSessies.afgerond.eenheden,
          no_show : lmsSessies.no_show.eenheden,
          team    : lmsTeam.team,
          intakes : lmsIntake.intakes,
          afspraken: {
            afgerond: lmsSessies.afgerond.afspraken,
            no_show : lmsSessies.no_show.afspraken,
          },
          meervoudig: {
            afgerond: lmsSessies.afgerond.per_eenheden,
            no_show : lmsSessies.no_show.per_eenheden,
          },
        },
        oud_lms: {
          status: oudeBronGeraakt ? 'gesloten' : 'niet-van-toepassing',
        },
      },
      lms_sessies_gelezen               : lmsSessies.rijen,
      lms_zelfde_moment                 : lmsSessies.zelfde_moment,
      lms_zonder_student                : lmsSessies.zonder_student,
      lms_teamtraining                  : lmsTeam.status,
      lms_intake                        : lmsIntake.status,
    },
  };
}
