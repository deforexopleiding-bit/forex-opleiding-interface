// api/_lib/lab-trial-stand.js
//
// De stand van een trial-lead in het ECHTE LMS (dfo-lms), per e-mail — voor
// Opvolging › Leads bellen en Leadsonderhoud › The Lab. Zelfde weg als de
// Lab-cijfers: hlms_lab_lead (account, logins, boeking), hlms_lab_sessie (The
// Lab) en hlms_lab_lead_gebeurtenis (video_voltooid = de video-voortgang van
// een lab-lead; hlms_les_voortgang is enkel voor studenten).
//
// labTrialAlsWarmte() geeft dezelfde vorm als normaliseerTrial() (trial_warmte
// van het oude trial-LMS), zodat de warmte en de chips van Leads bellen voor
// een nieuwe trial gewoon werken.

import { getDfoLmsClient } from './dfo-lms-db.js';
import { leesLabGedrag, isAfgerond, isGestart, nieuwstePerAuth } from './lab-dossier.js';

const DAG = 86400000;
const SESSIE_LICHT = 'sessie_id, auth_id, stap, stappen, voortgang, gestart_op, bijgewerkt_op, afgerond:snapshot->>afgerond';
const KOLOMMEN = 'id, auth_id, email, voornaam, toegang_van, toegang_tot, eerste_login_op, laatste_login_op, sessie_geboekt_op, sessie_moment, is_test, product, bron, aangemaakt_op';

/**
 * @param {string[]} emails
 * @returns {Promise<Map<string, { labLead, sessie, videos: number, videoTijden: number[], route: string|null }>>}
 *   sleutel = e-mail in kleine letters. Gooit bij een LMS-fout.
 */
export async function leesLabStandPerEmail(emails) {
  const uit = new Map();
  const lms = getDfoLmsClient();
  const lijst = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  if (!lms || !lijst.length) return uit;
  const leads = [];
  for (let i = 0; i < lijst.length; i += 150) {
    const { data, error } = await lms.from('hlms_lab_lead').select(KOLOMMEN).in('email', lijst.slice(i, i + 150));
    if (error) throw new Error('hlms_lab_lead: ' + error.message);
    leads.push(...(data || []));
  }
  if (!leads.length) return uit;
  let sessies = [];
  const auths = leads.map((l) => l.auth_id).filter(Boolean);
  for (let i = 0; i < auths.length; i += 200) {
    const { data, error } = await lms.from('hlms_lab_sessie').select(SESSIE_LICHT).in('auth_id', auths.slice(i, i + 200));
    if (error) throw new Error('hlms_lab_sessie: ' + error.message);
    sessies = sessies.concat(data || []);
  }
  const perAuth = nieuwstePerAuth(sessies);
  const gedrag = await leesLabGedrag(leads.map((l) => l.id));
  const titels = await leesVideoTitels(lms, leads.map((l) => l.id));
  for (const l of leads) {
    const g = gedrag.get(l.id) || {};
    uit.set(String(l.email).toLowerCase(), {
      labLead: l, sessie: perAuth.get(l.auth_id) || null,
      videos: (g.videoTijden || []).length, videoTijden: g.videoTijden || [], route: g.route || null,
      videoTitels: titels.get(l.id) || [],
    });
  }
  return uit;
}

/** Welke video's een lab-lead uitkeek (titel, één keer per video, oudste eerst). Fail-soft. */
async function leesVideoTitels(lms, leadIds) {
  const uit = new Map();
  try {
    for (let i = 0; i < leadIds.length; i += 200) {
      const { data, error } = await lms.from('hlms_lab_lead_gebeurtenis').select('lead_id, sleutel, data, op')
        .in('lead_id', leadIds.slice(i, i + 200)).eq('soort', 'video_voltooid').order('op', { ascending: true });
      if (error) throw new Error(error.message);
      for (const g of data || []) {
        const lijst = uit.get(g.lead_id) || [];
        const titel = String(g.data?.titel || '').trim() || 'video';
        if (!lijst.some((x) => x.sleutel === g.sleutel)) lijst.push({ sleutel: g.sleutel, titel, op: g.op });
        uit.set(g.lead_id, lijst);
      }
    }
  } catch (e) {
    console.warn('[lab-trial-stand] video-titels (soft):', e?.message || e);
  }
  return uit;
}

/**
 * Een score 0–45 op de schaal van trial_warmte, transparant opgebouwd:
 * ingelogd +5, per uitgekeken video +4 (max 20), Lab gestart +8, afgewerkt +12.
 * PURE.
 */
export function labScore({ ingelogd, videos, gestart, afgerond }) {
  return Math.min(45, (ingelogd ? 5 : 0) + Math.min(20, 4 * Number(videos || 0)) + (gestart ? 8 : 0) + (afgerond ? 12 : 0));
}

/** De stand in de vorm van normaliseerTrial() (opvolging-leads-pot.js). PURE. */
export function labTrialAlsWarmte(stand, nuMs = Date.now()) {
  if (!stand?.labLead) return null;
  const l = stand.labLead;
  const van = l.toegang_van ? String(l.toegang_van).slice(0, 10) : null;
  const tot = l.toegang_tot ? String(l.toegang_tot).slice(0, 10) : null;
  const totMs = l.toegang_tot ? Date.parse(l.toegang_tot) : NaN;
  const vanMs = l.toegang_van ? Date.parse(l.toegang_van) : NaN;
  const gestart = isGestart(stand.sessie);
  const afgerond = isAfgerond(stand.sessie);
  const ingelogd = !!l.eerste_login_op;
  const actief = [l.laatste_login_op, stand.sessie?.bijgewerkt_op, ...(stand.videoTijden || []).map((t) => new Date(t).toISOString())]
    .filter(Boolean).sort().pop() || null;
  const totaal = Number.isFinite(totMs) && Number.isFinite(vanMs) ? Math.round((totMs - vanMs) / DAG) : null;
  return {
    score: labScore({ ingelogd, videos: stand.videos, gestart, afgerond }),
    toegang_tot: tot,
    toegang_van: van,
    verlopen: Number.isFinite(totMs) ? totMs < nuMs : false,
    dagen_over: Number.isFinite(totMs) ? Math.ceil((totMs - nuMs) / DAG) : null,
    dag: Number.isFinite(vanMs) ? Math.floor((nuMs - vanMs) / DAG) + 1 : null,
    dagen_totaal: totaal && totaal > 0 ? totaal : null,
    lessen: stand.videos || 0,
    sessies: null,
    trades: afgerond ? 1 : null,
    laatst_actief: actief,
    ooit_ingelogd: ingelogd,
    // Extra voor wie het wil tonen (Leads bellen leest het niet stuk).
    lab: { gestart, afgerond, stap: stand.sessie?.stap ?? null, stappen: stand.sessie?.stappen ?? null, geboekt: !!l.sessie_geboekt_op, product: l.product || null },
  };
}
