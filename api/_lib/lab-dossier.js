// api/_lib/lab-dossier.js
//
// Het Lab-dossier van een lead en de funnelcijfers per hook. Leest twee
// databanken:
//   CRM    lab_aanmeldingen (de touches), leads, follow_up_appointments
//          (booking_source 'the-lab'), lab_opvolging
//   LMS    hlms_lab_lead (account, kwalificatie, boeking) en hlms_lab_sessie
//          (stap, voortgang, antwoorden, trades) — via dfo-lms-db.js
//
// Puur waar het kan (labStatus, vragenUitSnapshot, aggregeerFunnel), zodat de
// regels los te toetsen zijn.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { AANLEIDING_LABELS } from './lab-uitnodiging.js';
import { LAB_SLUG, labSleutel } from './lab-config.js';

/** De vragen uit de vragenlaag van het LMS (kopie van src/features/lab/lab-vragen.ts). */
export const LMS_VRAGEN = Object.freeze({
  v1: 'Hoeveel trades heb je het afgelopen jaar bijgehouden?',
  v4: 'Wat denk je dat jouw winratio is?',
  v5: "Wat zou jij normaal doen na zo'n verlies?",
  v6: 'Zou jij dit naast je werk volhouden?',
  v7: 'Wat zou dit bedrag voor jou betekenen?',
  v9: 'Wat houdt je nu nog tegen?',
});

export const KWALIFICATIE_LABELS = Object.freeze({
  doel: { vraag: 'Doel met trading', bijverdienste: 'Bijverdienste', volledig_inkomen: 'Volledig inkomen', vermogen: 'Vermogen opbouwen', weet_niet: 'Weet ik nog niet' },
  tijd: { vraag: 'Tijd per week', minder_3u: 'Minder dan 3 uur', '3_6u': '3 tot 6 uur', meer_6u: 'Meer dan 6 uur' },
  investeren: { vraag: 'Bereid te investeren in begeleiding', ja: 'Ja', misschien: 'Misschien', nee: 'Nee' },
});

/** Afgerond = de simulatie meldde het, of de voortgang staat op 100. PURE. */
export function isAfgerond(sessie) {
  if (!sessie) return false;
  const a = sessie.snapshot?.afgerond ?? sessie.afgerond;
  return a === true || a === 'true' || Number(sessie.voortgang || 0) >= 100;
}

/** Gestart = verder dan de eerste stap. PURE. */
export function isGestart(sessie) {
  return !!sessie && Number(sessie.stap || 0) > 1;
}

/**
 * De status van één lead, van ver naar dichtbij. PURE.
 * @returns {{ code: string, label: string }}
 */
export function labStatus({ labLead, sessie, nu = Date.now() }) {
  if (labLead?.sessie_geboekt_op) return { code: 'geboekt', label: 'Sessie geboekt' };
  if (isAfgerond(sessie)) return { code: 'afgewerkt', label: 'Lab afgewerkt' };
  if (isGestart(sessie)) {
    const st = sessie.stappen ? `stap ${sessie.stap} van ${sessie.stappen}` : `stap ${sessie.stap}`;
    return { code: 'bezig', label: `Lab gestart · ${st}` };
  }
  if (labLead && labLead.toegang_tot && Date.parse(labLead.toegang_tot) < nu) return { code: 'verlopen', label: 'Toegang verlopen' };
  if (labLead?.eerste_login_op) return { code: 'ingelogd', label: 'Ingelogd' };
  if (labLead) return { code: 'aangemeld', label: 'Aangemeld' };
  return { code: 'geen_account', label: 'Geen Lab-account' };
}

/** Alle vragen + antwoorden uit een snapshot, leesbaar. PURE. */
export function vragenUitSnapshot(snapshot) {
  const uit = [];
  const s = snapshot || {};
  for (const [sleutel, v] of Object.entries(s.antwoorden || {})) {
    if (v && (v.q || v.a)) uit.push({ bron: 'lab', sleutel, vraag: String(v.q || sleutel), antwoord: String(v.a ?? '') });
  }
  for (const [id, v] of Object.entries(s.vraagAntwoorden || {})) {
    if (!v) continue;
    uit.push({ bron: 'vragenlaag', sleutel: id, vraag: LMS_VRAGEN[id] || id, antwoord: String(v.label ?? v.waarde ?? '') });
  }
  return uit;
}

/** De kwalificatie als leesbare regels. PURE. */
export function kwalificatieRegels(k) {
  if (!k) return [];
  return ['doel', 'tijd', 'investeren']
    .filter((x) => k[x])
    .map((x) => ({ vraag: KWALIFICATIE_LABELS[x].vraag, antwoord: KWALIFICATIE_LABELS[x][k[x]] || k[x] }));
}

/** Minuten tussen start en laatste stand. PURE. */
export function minutenInLab(sessie) {
  if (!sessie?.gestart_op || !sessie?.bijgewerkt_op) return null;
  const ms = Date.parse(sessie.bijgewerkt_op) - Date.parse(sessie.gestart_op);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 60000) : null;
}

const SESSIE_LICHT = 'sessie_id, auth_id, stap, stappen, voortgang, gestart_op, bijgewerkt_op, afgerond:snapshot->>afgerond, leadscore:snapshot->leadscore';
const LEAD_KOLOMMEN = 'id, auth_id, email, voornaam, achternaam, telefoon, crm_lead_id, hook, utm, toegang_van, toegang_tot, eerste_login_op, laatste_login_op, kwalificatie, sessie_geboekt_op, sessie_moment, is_test, aangemaakt_op';
// Sinds hlms_lab_lead_gebeurtenis.sql (15 okt): de gekozen route. Apart, zodat
// een LMS zonder die migratie het dossier niet breekt.
const LEAD_ROUTE_KOLOMMEN = 'route, route_gekozen_op';

/** De ingang die de lead koos, leesbaar. */
export const ROUTE_LABELS = Object.freeze({ lab: 'Ik heb 20 minuten (The Lab)', kort: 'Ik heb 5 minuten (korte route)', praten: 'Ik wil meteen praten' });

/** Wat een gebeurtenis zegt, voor Dave. PURE. */
export function gebeurtenisRegel(g) {
  const d = g?.data || {};
  switch (g?.soort) {
    case 'kaart_getoond': return 'Boekingskaart in The Lab getoond' + (d.na ? ` (na ${d.na})` : '');
    case 'kaart_geklikt': return 'Klikte op de boekingskaart in The Lab';
    case 'kaart_gesloten': return 'Sloot de boekingskaart in The Lab';
    case 'route_gekozen': return 'Koos: ' + (ROUTE_LABELS[g.sleutel] || g.sleutel);
    case 'route_terugkeer': return 'Kwam terug na een pauze';
    case 'video_gestart': return 'Startte video' + (d.titel ? `: ${d.titel}` : '');
    case 'video_voltooid': return 'Keek video uit' + (d.titel ? `: ${d.titel}` : '');
    case 'bevestiging_ics': return 'Zette de sessie in zijn agenda (.ics)';
    case 'terugbellen_gevraagd': return 'Vroeg om teruggebeld te worden';
    case 'uitnodiging_getoond': return 'Kreeg de uitnodiging "Plan je sessie met Dave"' + (AANLEIDING_LABELS[d.aanleiding] ? ` (${AANLEIDING_LABELS[d.aanleiding]})` : '');
    case 'uitnodiging_gesloten': return 'Sloot de uitnodiging';
    case 'uitnodiging_niet_nu': return 'Koos "Niet nu" bij de uitnodiging';
    case 'uitnodiging_geboekt': return d.bron === 'balk' ? 'Boekte via de sessiebalk' : 'Boekte via de uitnodiging';
    case 'balk_geklikt': return 'Klikte op de sessiebalk ("Plan in")';
    default: return String(g?.soort || '');
  }
}

/** Nieuwste sessie per auth_id. PURE. */
export function nieuwstePerAuth(sessies) {
  const m = new Map();
  for (const s of sessies || []) {
    const h = m.get(s.auth_id);
    if (!h || String(s.bijgewerkt_op) > String(h.bijgewerkt_op)) m.set(s.auth_id, s);
  }
  return m;
}

/**
 * Lab-leads + hun lichte sessiestand voor een lijst auth-id's (of alle, als
 * `authIds` leeg is binnen een periode). Gooit bij een LMS-fout.
 */
export async function leesLmsStand({ authIds = null, sinds = null } = {}) {
  const lms = getDfoLmsClient();
  if (!lms) { const e = new Error('LMS niet geconfigureerd'); e.code = 'lms_niet_geconfigureerd'; throw e; }
  let q = lms.from('hlms_lab_lead').select(LEAD_KOLOMMEN).order('aangemaakt_op', { ascending: false }).limit(5000);
  if (authIds) q = q.in('auth_id', authIds.length ? authIds : ['00000000-0000-0000-0000-000000000000']);
  if (sinds) q = q.gte('aangemaakt_op', sinds);
  const { data: leads, error } = await q;
  if (error) { const e = new Error('hlms_lab_lead: ' + error.message); e.code = error.code; throw e; }
  const ids = (leads || []).map((l) => l.auth_id);
  let sessies = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: se } = await lms.from('hlms_lab_sessie').select(SESSIE_LICHT).in('auth_id', ids.slice(i, i + 200));
    if (se) { const e = new Error('hlms_lab_sessie: ' + se.message); e.code = se.code; throw e; }
    sessies = sessies.concat(data || []);
  }
  return { leads: leads || [], sessiePerAuth: nieuwstePerAuth(sessies) };
}

/**
 * Wat een lab-lead deed in Jouw route (okt 2026): de gekozen ingang en wanneer
 * hij een video uitkeek. Per lab-lead-id. FAIL-SOFT: een LMS zonder de migratie
 * hlms_lab_lead_gebeurtenis.sql (of een leesfout) geeft een lege kaart — de
 * motor gedraagt zich dan zoals vóór Jouw route.
 *
 * `videoTijden` = per uitgekeken video (één keer per video) het moment, oplopend —
 * zo kan de motor "de eerste 5 van het leerpad" zien (zie `videosKlaarOp`).
 *
 * @returns {Promise<Map<string, { route: string|null, routeOp: number|null, videoOp: number|null, videoTijden: number[] }>>}
 */
/**
 * Wanneer stap 1 van Jouw route ("de video's") af was, of `null`. Zelfde regel
 * als het LMS (`videosAf` in jouw-route-regels.ts): route `kort` na de eerste
 * video, anders na de eerste 5 van het leerpad. PURE.
 */
export const LEERPAD_LAB_NA = 5;
export function videosKlaarOp(gedrag) {
  const tijden = gedrag?.videoTijden || [];
  const nodig = gedrag?.route === 'kort' ? 1 : LEERPAD_LAB_NA;
  return tijden.length >= nodig ? tijden[nodig - 1] : null;
}

export async function leesLabGedrag(leadIds) {
  const uit = new Map();
  const lms = getDfoLmsClient();
  const ids = [...new Set((leadIds || []).filter(Boolean))];
  if (!lms || !ids.length) return uit;
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const deel = ids.slice(i, i + 200);
      const [rt, gb] = await Promise.all([
        lms.from('hlms_lab_lead').select('id, route, route_gekozen_op').in('id', deel),
        lms.from('hlms_lab_lead_gebeurtenis').select('lead_id, soort, sleutel, op').in('lead_id', deel).eq('soort', 'video_voltooid'),
      ]);
      for (const r of rt.error ? [] : rt.data || []) {
        uit.set(r.id, { route: r.route || null, routeOp: r.route_gekozen_op ? Date.parse(r.route_gekozen_op) : null, videoOp: null, videoTijden: [] });
      }
      const eerstePerVideo = new Map(); // lead_id → Map(sleutel → vroegste ms)
      for (const g of gb.error ? [] : gb.data || []) {
        const x = uit.get(g.lead_id) || { route: null, routeOp: null, videoOp: null, videoTijden: [] };
        const t = Date.parse(g.op);
        if (Number.isFinite(t) && (x.videoOp == null || t < x.videoOp)) x.videoOp = t;
        uit.set(g.lead_id, x);
        if (!Number.isFinite(t)) continue;
        const per = eerstePerVideo.get(g.lead_id) || new Map();
        const k = g.sleutel || `#${per.size}`;
        if (!per.has(k) || t < per.get(k)) per.set(k, t);
        eerstePerVideo.set(g.lead_id, per);
      }
      for (const [id, per] of eerstePerVideo) uit.get(id).videoTijden = [...per.values()].sort((a, b) => a - b);
    }
  } catch (e) {
    console.warn('[lab-dossier] leesLabGedrag (soft):', e?.message || e);
  }
  return uit;
}

/**
 * Funnel per hook (of campagne). PURE.
 *
 * Eén lead = één e-mailadres. Hij telt bij de hook van zijn EERSTE aanmelding
 * in de periode — een tweede touch met een andere hook verschuift hem niet
 * (dan zou de eerste hook nooit zijn eigen boekingen zien). Het aantal touches
 * per hook staat er apart bij.
 *
 * @param {object[]} aanmeldingen  lab_aanmeldingen-rijen (oplopend of niet)
 * @param {Map}      lmsPerEmail   email → { labLead, sessie }
 * @param {Set}      klanten       lowercase e-mails die klant werden
 * @param {'hook'|'campagne'} per
 */
export function aggregeerFunnel(aanmeldingen, lmsPerEmail, klanten = new Set(), per = 'hook') {
  const eerste = new Map();
  const touches = new Map();
  const sleutelVan = (a) => labSleutel(a, per);
  const gesorteerd = [...(aanmeldingen || [])].sort((x, y) => String(x.aangemaakt).localeCompare(String(y.aangemaakt)));
  for (const a of gesorteerd) {
    if (a.is_test) continue;
    const k = sleutelVan(a);
    touches.set(k, (touches.get(k) || 0) + 1);
    const em = String(a.email || '').toLowerCase();
    if (em && !eerste.has(em)) eerste.set(em, k);
  }
  const rijen = new Map();
  const leeg = (k) => ({ sleutel: k, touches: touches.get(k) || 0, leads: 0, ingelogd: 0, gestart: 0, afgewerkt: 0, geboekt: 0, klant: 0, route: { lab: 0, kort: 0, praten: 0 } });
  for (const [em, k] of eerste) {
    if (!rijen.has(k)) rijen.set(k, leeg(k));
    const r = rijen.get(k);
    const l = lmsPerEmail.get(em) || {};
    r.leads++;
    if (l.labLead?.eerste_login_op) r.ingelogd++;
    if (isGestart(l.sessie)) r.gestart++;
    if (isAfgerond(l.sessie)) r.afgewerkt++;
    if (l.labLead?.sessie_geboekt_op || l.geboekt) r.geboekt++;
    if (klanten.has(em)) r.klant++;
    const rt = l.route || l.labLead?.route;
    if (rt && r.route[rt] != null) r.route[rt]++;
  }
  const lijst = [...rijen.values()].sort((a, b) => b.leads - a.leads || a.sleutel.localeCompare(b.sleutel));
  const totaal = lijst.reduce((t, r) => {
    for (const k of ['touches', 'leads', 'ingelogd', 'gestart', 'afgewerkt', 'geboekt', 'klant']) t[k] += r[k];
    for (const k of ['lab', 'kort', 'praten']) t.route[k] += r.route[k];
    return t;
  }, { sleutel: 'Totaal', touches: 0, leads: 0, ingelogd: 0, gestart: 0, afgewerkt: 0, geboekt: 0, klant: 0, route: { lab: 0, kort: 0, praten: 0 } });
  return { rijen: lijst, totaal, perRoute: perRoute(eerste, lmsPerEmail) };
}

/** Conversie per gekozen route (Jouw route): leads en geboekt. PURE. */
export function perRoute(eersteOfEmails, lmsPerEmail) {
  const uit = { lab: { leads: 0, geboekt: 0 }, kort: { leads: 0, geboekt: 0 }, praten: { leads: 0, geboekt: 0 }, geen: { leads: 0, geboekt: 0 } };
  const emails = eersteOfEmails instanceof Map ? [...eersteOfEmails.keys()] : [...(eersteOfEmails || [])];
  for (const em of emails) {
    const l = lmsPerEmail.get(em) || {};
    const rt = l.route || l.labLead?.route || 'geen';
    const b = uit[rt] || uit.geen;
    b.leads++;
    if (l.labLead?.sessie_geboekt_op || l.geboekt) b.geboekt++;
  }
  return uit;
}

/** Lees het volledige dossier van één lead (op lead-id of e-mail). */
export async function leesDossier({ leadId = null, email = null }) {
  let lead = null;
  if (leadId) {
    const { data, error } = await supabaseAdmin.from('leads')
      .select('id, voornaam, achternaam, email, telefoon_e164, bron, soort, traject, status').eq('id', leadId).maybeSingle();
    if (error) throw new Error('leads: ' + error.message);
    lead = data;
  }
  const mail = String(email || lead?.email || '').trim().toLowerCase();
  if (!mail && !leadId) return null;

  const filters = [];
  if (leadId) filters.push(`lead_id.eq.${leadId}`);
  if (mail) filters.push(`email.eq."${mail.replace(/"/g, '')}"`);
  const { data: touches, error: tf } = await supabaseAdmin.from('lab_aanmeldingen')
    .select('id, aangemaakt, hook, utm_source, utm_medium, utm_campaign, utm_content, landingspagina, toestemming, resultaat, mail_status, wa_status, is_test')
    .or(filters.join(','))
    .order('aangemaakt', { ascending: true }).limit(50);
  const aanmeldingen = tf ? [] : (touches || []);
  if (tf) console.warn('[lab-dossier] lab_aanmeldingen (soft):', tf.message);

  const lms = getDfoLmsClient();
  let labLead = null; let sessie = null; let lmsFout = null; let gebeurtenissen = [];
  if (lms) {
    let q = lms.from('hlms_lab_lead').select(LEAD_KOLOMMEN).limit(1);
    q = leadId && !mail ? q.eq('crm_lead_id', leadId) : q.ilike('email', mail);
    const { data: ll, error: le } = await q;
    if (le) lmsFout = le.message; else labLead = ll?.[0] || null;
    if (labLead) {
      const { data: ss, error: se } = await lms.from('hlms_lab_sessie')
        .select('sessie_id, stap, stappen, voortgang, gestart_op, bijgewerkt_op, snapshot')
        .eq('auth_id', labLead.auth_id).order('bijgewerkt_op', { ascending: false }).limit(1);
      if (se) lmsFout = se.message; else sessie = ss?.[0] || null;
      // Route en gebeurtenissen: fail-soft (een LMS zonder de migratie = leeg).
      const { data: rt } = await lms.from('hlms_lab_lead').select(LEAD_ROUTE_KOLOMMEN).eq('id', labLead.id).maybeSingle();
      if (rt) Object.assign(labLead, rt);
      const { data: gb, error: ge } = await lms.from('hlms_lab_lead_gebeurtenis')
        .select('soort, sleutel, data, op').eq('lead_id', labLead.id).order('op', { ascending: true }).limit(200);
      if (!ge) gebeurtenissen = gb || [];
    }
  } else {
    lmsFout = 'LMS niet geconfigureerd';
  }

  let afspraken = [];
  if (mail) {
    const { data: fa, error: fe } = await supabaseAdmin.from('follow_up_appointments')
      .select('id, scheduled_at, status, booking_source').eq('booking_source', LAB_SLUG).ilike('lead_email', mail)
      .order('scheduled_at', { ascending: false }).limit(5);
    if (fe) console.warn('[lab-dossier] afspraken (soft):', fe.message); else afspraken = fa || [];
  }

  let opvolging = [];
  if (aanmeldingen.length) {
    const { data: ov, error: oe } = await supabaseAdmin.from('lab_opvolging')
      .select('aangemaakt, stap, kanaal, status, detail').in('aanmelding_id', aanmeldingen.map((a) => a.id))
      .order('aangemaakt', { ascending: true }).limit(100);
    if (!oe) opvolging = ov || [];
  }

  const snap = sessie?.snapshot || null;
  const eerste = aanmeldingen[0] || null;
  return {
    lead,
    email: mail || null,
    status: labStatus({ labLead, sessie: sessie && { ...sessie, afgerond: snap?.afgerond } }),
    lms_fout: lmsFout,
    hook: labLead?.hook || eerste?.hook || null,
    campagne: eerste?.utm_campaign || labLead?.utm?.campaign || null,
    aanmeldingen,
    account: labLead && {
      aangemaakt_op: labLead.aangemaakt_op, toegang_tot: labLead.toegang_tot,
      eerste_login_op: labLead.eerste_login_op, laatste_login_op: labLead.laatste_login_op,
      sessie_geboekt_op: labLead.sessie_geboekt_op, sessie_moment: labLead.sessie_moment, is_test: labLead.is_test,
    },
    kwalificatie: kwalificatieRegels(labLead?.kwalificatie),
    sessie: sessie && {
      stap: sessie.stap, stappen: sessie.stappen, stap_naam: snap?.stapNaam || null, voortgang: sessie.voortgang,
      gestart_op: sessie.gestart_op, bijgewerkt_op: sessie.bijgewerkt_op, minuten: minutenInLab(sessie),
      afgerond: isAfgerond({ ...sessie, afgerond: snap?.afgerond }),
      baseline: snap?.baseline ?? null, eindcijfer: snap?.eindcijfer ?? null,
      leadscore: snap?.leadscore ?? null,
      taken: snap?.taken || {},
      trades: Array.isArray(snap?.trades) ? snap.trades : [],
    },
    vragen: vragenUitSnapshot(snap),
    afspraken,
    opvolging,
    route: labLead?.route ? { code: labLead.route, label: ROUTE_LABELS[labLead.route] || labLead.route, op: labLead.route_gekozen_op || null } : null,
    gebeurtenissen: gebeurtenissen.map((g) => ({ op: g.op, soort: g.soort, regel: gebeurtenisRegel(g) })),
    video: {
      gestart: gebeurtenissen.filter((g) => g.soort === 'video_gestart').length,
      voltooid: gebeurtenissen.filter((g) => g.soort === 'video_voltooid').length,
    },
  };
}
