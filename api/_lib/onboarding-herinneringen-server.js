// api/_lib/onboarding-herinneringen-server.js
//
// De IO rond de onboarding-herinneringen: instellingen, het logboek, de
// LMS-signalen, de mail. De REGELS staan in onboarding-herinneringen.js
// (puur); dit bestand voert alleen uit wat daar besloten werd.
//
// Gebruikt door: api/cron/onboarding-herinneringen.js (dagelijks),
// api/onboarding-herinneringen.js (instellingen, testmail, oude dossiers) en
// de schakelaar "Geen herinneringen" (onboarding-acties.js).

import {
  SETTING_KEY, SIGNAAL, normaliseerInstellingen, besluitHerinnering, besluitOudDossier, isKlaar, isOudDossier,
  tekstVoorFlow, heeftFlowRegels, besluitHandmatig, waaromLabel, SOORT_LABEL,
} from './onboarding-herinneringen.js';
import { resolveFlowType } from './onboarding-wizard-default.js';
import { linkVoorOnboarding, portalBasis } from './onboarding-link.js';
import { formatteer as formatteerStartcode } from './onboarding-startcode.js';
import { bouwOpmaakMail } from './onboarding-mail-opmaak.js';
import { sendOnboardingMail } from '../mailer.js';

const OPEN = ['nieuw', 'opgepakt', 'wacht_op_mentor', 'on_hold', 'wacht'];
export const SIGNAAL_SOORT = 'melding_geen_reactie';

/** Zegt een databankfout "deze tabel/kolom bestaat nog niet"? PURE. */
export function ontbreekt(err) {
  const code = String(err?.code || '');
  return code === '42P01' || code === '42703' || code === 'PGRST205' || code === 'PGRST204'
    || /onboarding_herinneringen|geen_herinneringen/.test(String(err?.message || '')) && /exist|schema cache/i.test(String(err?.message || ''));
}

export async function leesInstellingen(db) {
  const { data, error } = await db.from('app_settings').select('value').eq('key', SETTING_KEY).maybeSingle();
  if (error) throw new Error('instellingen: ' + error.message);
  return normaliseerInstellingen(data?.value);
}

/** Schrijft de RUWE waarde (met goedgekeurd_onderwerp/_tekst), upsert op key. */
export async function bewaarInstellingen(db, waarde, door = null, key = SETTING_KEY) {
  const row = { key, value: waarde, updated_by_user_id: door };
  const { data: al, error: lErr } = await db.from('app_settings').select('key').eq('key', key).maybeSingle();
  if (lErr) throw new Error('instellingen: ' + lErr.message);
  const { error } = al
    ? await db.from('app_settings').update(row).eq('key', key)
    : await db.from('app_settings').insert(row);
  if (error) throw new Error('instellingen bewaren: ' + error.message);
}

export async function leesRuweInstellingen(db, key = SETTING_KEY) {
  const { data, error } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error('instellingen: ' + error.message);
  return data?.value && typeof data.value === 'object' ? data.value : {};
}

/**
 * Het logboek per onboarding. `null` = de tabel bestaat nog niet (migratie
 * niet gedraaid) — dan mag er NIETS vertrekken: zonder logboek is "nooit
 * dubbel" niet te garanderen.
 * @returns {Promise<Map<string, Array>|null>}
 */
const LOG_KOLOMMEN = 'onboarding_id, soort, status, naar, fout, aangemaakt_op';
//  Met de hand (29 okt 2026): wie, welke tekst. Zonder migratie
//  2026-10-29-onboarding-herinnering-handmatig.sql vallen we terug op LOG_KOLOMMEN.
const LOG_KOLOMMEN_HANDMATIG = LOG_KOLOMMEN + ', handmatig, door, tekst';

export async function leesLog(db, ids) {
  const kaart = new Map();
  const uniek = [...new Set((ids || []).filter(Boolean))];
  let kolommen = LOG_KOLOMMEN_HANDMATIG;
  for (let i = 0; i < uniek.length || i === 0; i += 200) {
    const deel = uniek.slice(i, i + 200);
    const lees = (k) => {
      const q = db.from('onboarding_herinneringen').select(k);
      return deel.length ? q.in('onboarding_id', deel) : q.limit(1);
    };
    let { data, error } = await lees(kolommen);
    if (error && kolommen === LOG_KOLOMMEN_HANDMATIG && ontbreekt(error)) {
      kolommen = LOG_KOLOMMEN;
      ({ data, error } = await lees(kolommen));
    }
    if (error) {
      if (ontbreekt(error)) return null;
      throw new Error('herinneringen-log: ' + error.message);
    }
    if (!deel.length) break;
    for (const r of data || []) {
      if (!kaart.has(r.onboarding_id)) kaart.set(r.onboarding_id, []);
      kaart.get(r.onboarding_id).push(r);
    }
  }
  for (const l of kaart.values()) l.sort((a, b) => String(a.aangemaakt_op).localeCompare(String(b.aangemaakt_op)));
  return kaart;
}

/**
 * Eén regel in het logboek. De unieke sleutel (onboarding, soort) is de
 * grendel: 23505 = er stond er al een → `false`, en dan mag de mail NIET weg.
 * @returns {Promise<boolean>} true = deze aanroep heeft de plek
 */
export async function claim(db, onboardingId, soort, extra = {}) {
  const { error } = await db.from('onboarding_herinneringen')
    .insert({ onboarding_id: onboardingId, soort, status: 'bezig', ...extra });
  if (!error) return true;
  if (error.code !== '23505') throw new Error('herinneringen-log: ' + error.message);
  //  Er stond er al een. Alleen een MISLUKTE poging mag opnieuw (de volgende dag),
  //  en dan ook weer voorwaardelijk: twee lopen tegelijk claimen hem niet allebei.
  const { data, error: uErr } = await db.from('onboarding_herinneringen')
    .update({ status: 'bezig', fout: null, aangemaakt_op: new Date().toISOString(), ...extra })
    .eq('onboarding_id', onboardingId).eq('soort', soort).eq('status', 'mislukt')
    .select('onboarding_id');
  if (uErr) throw new Error('herinneringen-log: ' + uErr.message);
  return !!(data && data.length);
}

export async function markeer(db, onboardingId, soort, patch) {
  const { error } = await db.from('onboarding_herinneringen').update(patch).eq('onboarding_id', onboardingId).eq('soort', soort);
  if (error) console.error('[onboarding-herinneringen] log bijwerken', onboardingId, soort, error.message);
}

/**
 * De oude automation "Reminder na bedenktijd" (trigger time_after_signup):
 * staat ze aan, en wanneer mailde ze al per onboarding?
 */
export async function oudeAutomation(db, ids) {
  const uit = { aan: false, namen: [], gemaild: new Map() };
  const { data: autos, error } = await db.from('onboarding_automations').select('id, name, enabled').eq('trigger_type', 'time_after_signup');
  if (error) throw new Error('automations: ' + error.message);
  uit.aan = (autos || []).some((a) => a.enabled);
  uit.namen = (autos || []).filter((a) => a.enabled).map((a) => a.name);
  const autoIds = (autos || []).map((a) => a.id);
  const uniek = [...new Set((ids || []).filter(Boolean))];
  if (!autoIds.length || !uniek.length) return uit;
  for (let i = 0; i < uniek.length; i += 200) {
    const { data: runs, error: rErr } = await db.from('onboarding_automation_runs')
      .select('id, onboarding_id, is_test').in('automation_id', autoIds).in('onboarding_id', uniek.slice(i, i + 200));
    if (rErr) throw new Error('automation-runs: ' + rErr.message);
    const obVan = new Map((runs || []).filter((r) => !r.is_test).map((r) => [r.id, r.onboarding_id]));
    const runIds = [...obVan.keys()];
    for (let j = 0; j < runIds.length; j += 200) {
      const { data: logs, error: lErr } = await db.from('onboarding_automation_run_log')
        .select('run_id, executed_at, result').eq('step_type', 'send_email').in('run_id', runIds.slice(j, j + 200));
      if (lErr) throw new Error('automation-log: ' + lErr.message);
      for (const l of logs || []) if (l?.result?.ok === true) uit.gemaild.set(obVan.get(l.run_id), l.executed_at);
    }
  }
  return uit;
}

function klantFilter(obIds, studentIds) {
  const delen = [];
  if (obIds.length) delen.push(`crm_onboarding_id.in.(${obIds.join(',')})`);
  if (studentIds.length) delen.push(`student_id.in.(${studentIds.join(',')})`);
  return delen.join(',');
}

/**
 * Per onboarding: open signaal "wil annuleren" / "geen reactie" in het LMS?
 * Gooit bij een leesfout — dan vertrekt er niets (beter een dag niets dan een
 * mail naar iemand die wil annuleren).
 * @returns {Promise<{wilAnnuleren: Set<string>, geenReactie: Set<string>}>}
 */
export async function openSignalen(lms, rijen) {
  const wilAnnuleren = new Set();
  const geenReactie = new Set();
  const uuid = (x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x);
  const obVanStudent = new Map(rijen.filter((r) => uuid(r.dfo_lms_student_id)).map((r) => [r.dfo_lms_student_id, r.id]));
  const obIds = rijen.map((r) => r.id).filter(uuid);
  for (let i = 0; i < Math.max(obIds.length, obVanStudent.size); i += 150) {
    const f = klantFilter(obIds.slice(i, i + 150), [...obVanStudent.keys()].slice(i, i + 150));
    if (!f) break;
    const { data, error } = await lms.from('hlms_signaal')
      .select('crm_onboarding_id, student_id, soort')
      .eq('onderwerp', 'student').in('status', OPEN)
      .in('soort', ['melding_wil_annuleren', SIGNAAL_SOORT]).or(f);
    if (error) throw new Error('LMS-signalen: ' + error.message);
    for (const s of data || []) {
      const ob = s.crm_onboarding_id || obVanStudent.get(s.student_id);
      if (!ob) continue;
      (s.soort === SIGNAAL_SOORT ? geenReactie : wilAnnuleren).add(ob);
    }
  }
  return { wilAnnuleren, geenReactie };
}

/**
 * Het signaal melding_geen_reactie naar de administratie. Nooit een tweede
 * open kaart: eerst kijken, en de unieke index vangt een kruisende loop (23505).
 */
export async function zetSignaalGeenReactie(lms, r) {
  const naam = r.customer_name || 'Deze student';
  const tekst = `${naam} vulde de onboarding niet in, ook niet na de herinneringen. `
    + `Startdatum ${r.start_date || 'onbekend'} is meer dan 7 dagen voorbij. Er gaat geen mail meer uit; bel of beslis.`;
  const nu = new Date().toISOString();
  const { data, error } = await lms.from('hlms_signaal').insert({
    onderwerp: 'student', student_id: r.dfo_lms_student_id || null, crm_onboarding_id: r.id,
    soort: SIGNAAL_SOORT, zwaarte: 'oranje', status: 'nieuw', bron: 'handmatig', bak: 'admin',
    eerste_op: nu, laatst_gezien_op: nu,
    bewijs: { reden: tekst, gemeld_op: nu, melding: 'geen_reactie', via: 'onboarding_herinneringen', naam, start: r.start_date || null },
  }).select('id').single();
  if (error) {
    if (error.code === '23505') return { ok: true, al_open: true };
    throw new Error('signaal: ' + error.message);
  }
  const { error: gErr } = await lms.from('hlms_signaal_gebeurtenis').insert({ signaal_id: data.id, soort: 'geopend', tekst });
  if (gErr) console.warn('[onboarding-herinneringen] tijdlijn signaal:', gErr.message);
  return { ok: true, signaal_id: data.id };
}

/**
 * Bouw en verstuur één herinnering. `naar` overschrijft het adres (testmail
 * naar jezelf); anders customers.email. Kent zo nodig een startcode toe.
 * @returns {Promise<{ok: boolean, naar?: string, fout?: string, overgeslagen?: string}>}
 */
export async function stuurHerinnering(db, ob, tekst, { naar = null, onderwerpPrefix = '' } = {}) {
  const { data: cust, error } = await db.from('customers').select('email, first_name, last_name').eq('id', ob.customer_id).maybeSingle();
  if (error) return { ok: false, fout: 'klant: ' + error.message };
  const adres = naar || cust?.email || null;
  if (!adres) return { ok: false, overgeslagen: 'geen_email' };
  const { data: vers, error: vErr } = await db.from('onboardings').select('id, token, startcode, traject_id').eq('id', ob.id).maybeSingle();
  if (vErr) return { ok: false, fout: 'onboarding: ' + vErr.message };
  //  1-op-1 of membership: de regels met [1-op-1]/[membership] (een membership heeft geen mentor).
  let trajectType = ob.traject_type;
  if (trajectType === undefined && vers?.traject_id) {
    const { data: t, error: tErr } = await db.from('onboarding_trajecten').select('type').eq('id', vers.traject_id).maybeSingle();
    if (tErr) return { ok: false, fout: 'traject: ' + tErr.message };
    trajectType = t?.type || null;
  }
  const body = tekstVoorFlow(tekst.tekst, resolveFlowType(trajectType));
  //  Kent zo nodig een startcode toe; achter de vlag de portal, anders de wizard.
  const persoonlijk = await linkVoorOnboarding(db, { id: ob.id, token: vers?.token, startcode: vers?.startcode || null });
  if (!persoonlijk.startcode) return { ok: false, fout: 'geen startcode' };
  const waarden = {
    '{{klant.voornaam}}': String(cust?.first_name || '').trim() || 'daar',
    '{{klant.achternaam}}': String(cust?.last_name || '').trim(),
    '{{onboarding.startcode}}': formatteerStartcode(persoonlijk.startcode),
    '{{onboarding.persoonlijke_link}}': persoonlijk.link,
    '{{onboarding.wizard_link}}': persoonlijk.link,
  };
  const mail = bouwOpmaakMail({ subject: tekst.onderwerp, body, waarden, link: persoonlijk.link });
  let onderwerp = String(tekst.onderwerp);
  for (const [k, v] of Object.entries(waarden)) onderwerp = onderwerp.split(k).join(v);
  const res = await sendOnboardingMail({ to: adres, subject: onderwerpPrefix + onderwerp, text: mail.text, html: mail.html });
  if (!res || res.success === false) return { ok: false, naar: adres, fout: res?.error || 'mail mislukt' };
  return { ok: true, naar: adres };
}

/**
 * DE LIJST VAN VANDAAG — wat de cron zou doen, voor elke open onboarding.
 * Eén functie voor de cron, de droogloop en het voorbeeld in het CRM.
 *
 * @param {{db, lms, rijen: object[], vandaag: string}} p
 *   rijen = bouwOverzichtRijen({scope:'active'}) (met geen_herinneringen_op)
 * @returns {Promise<{log: Map|null, oude: object, plan: Array, oudeDossiers: Array}>}
 */
export async function planHerinneringen({ db, lms, rijen, vandaag }) {
  const open = (rijen || []).filter((r) => !isKlaar(r) && !['geannuleerd', 'gearchiveerd'].includes(String(r.status || '').toLowerCase()));
  const ids = open.map((r) => r.id);
  const [log, oude] = await Promise.all([leesLog(db, ids), oudeAutomation(db, ids)]);
  if (!lms) throw new Error('De koppeling met het LMS is niet geconfigureerd: zonder de signalen ("wil annuleren") vertrekt er niets.');
  const sig = await openSignalen(lms, open);
  const plan = [];
  const oudeDossiers = [];
  for (const r of open) {
    const eigen = log ? (log.get(r.id) || []) : [];
    //  De oude automation mailde al op dag 15: die telt als herinnering_1.
    const overgenomen = !eigen.some((l) => l.soort === 'herinnering_1') && oude.gemaild.has(r.id)
      ? [{ soort: 'herinnering_1', status: 'overgenomen', aangemaakt_op: oude.gemaild.get(r.id), naar: null }] : [];
    const ctxLog = [...eigen, ...overgenomen];
    const ctx = { vandaag, log: ctxLog, wilAnnuleren: sig.wilAnnuleren.has(r.id), oudeAutomationAan: oude.aan };
    const b = besluitHerinnering(r, ctx);
    //  Staat er al een open "geen reactie" in het LMS, dan geen tweede.
    const besluit = b.actie === 'signaal' && sig.geenReactie.has(r.id) ? { actie: 'niets', waarom: 'signaal_al_open' } : b;
    plan.push({ rij: r, besluit, log: ctxLog, overgenomen: overgenomen[0] || null });
    if (isOudDossier(r, vandaag)) oudeDossiers.push({ rij: r, besluit: besluitOudDossier(r, ctx), log: ctxLog });
  }
  return { log, oude, plan, oudeDossiers };
}

/**
 * De schakelaar "Geen herinneringen" per student (drawer van het LMS-bord en
 * het CRM-dossier). Aan = geen enkele automatische onboarding-herinnering meer
 * voor deze student; wie en wanneer staat erbij.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function zetGeenHerinneringen(db, { onboardingId, aan, door }) {
  if (!onboardingId) return { status: 400, body: { error: 'onboarding_id ontbreekt' } };
  const patch = aan
    ? { geen_herinneringen_op: new Date().toISOString(), geen_herinneringen_door: String(door || 'onbekend').slice(0, 200) }
    : { geen_herinneringen_op: null, geen_herinneringen_door: null };
  const { data, error } = await db.from('onboardings').update(patch).eq('id', onboardingId).select('id, geen_herinneringen_op, geen_herinneringen_door').maybeSingle();
  if (error) {
    if (ontbreekt(error)) return { status: 503, body: { error: 'De migratie 2026-10-28-onboarding-opvolgflow.sql is nog niet gedraaid.', code: 'migratie_ontbreekt' } };
    throw new Error('geen herinneringen: ' + error.message);
  }
  if (!data) return { status: 404, body: { error: 'Onboarding niet gevonden.' } };
  return { status: 200, body: { ok: true, geen_herinneringen: data.geen_herinneringen_op ? { op: data.geen_herinneringen_op, door: data.geen_herinneringen_door } : null } };
}

/**
 * Een TESTMAIL van één tekst — altijd naar de ingelogde gebruiker zelf, met
 * een voorbeeldcode. Zo ziet Maxim de mail zoals een student hem krijgt,
 * zonder dat er één student iets ontvangt. Staan er regels per traject in,
 * dan twee mails: de versie voor 1-op-1 en die voor membership.
 */
export async function stuurTestHerinnering(tekst, { naar, voornaam = 'Maxim' }) {
  if (!naar) return { ok: false, fout: 'geen e-mailadres voor de testmail' };
  const link = portalBasis() + '?code=TEST-CODE';
  const waarden = {
    '{{klant.voornaam}}': voornaam, '{{klant.achternaam}}': '',
    '{{onboarding.startcode}}': 'TEST-CODE',
    '{{onboarding.persoonlijke_link}}': link, '{{onboarding.wizard_link}}': link,
  };
  let onderwerp = String(tekst.onderwerp);
  for (const [k, v] of Object.entries(waarden)) onderwerp = onderwerp.split(k).join(v);
  const versies = heeftFlowRegels(tekst.tekst)
    ? [['1op1', '[TEST 1-op-1] '], ['membership', '[TEST membership] ']]
    : [['1op1', '[TEST] ']];
  for (const [flow, prefix] of versies) {
    const mail = bouwOpmaakMail({ subject: tekst.onderwerp, body: tekstVoorFlow(tekst.tekst, flow), waarden, link });
    const res = await sendOnboardingMail({ to: naar, subject: prefix + onderwerp, text: mail.text, html: mail.html });
    if (!res || res.success === false) return { ok: false, fout: res?.error || 'mail mislukt' };
  }
  return { ok: true, naar, versies: versies.length };
}

/**
 * Bestaan de kolommen voor "met de hand" (handmatig, door, tekst)? Zonder die
 * migratie vertrekt er met de hand NIETS: het logboek moet zeggen wie het deed.
 */
export async function heeftHandmatigKolommen(db) {
  const { error } = await db.from('onboarding_herinneringen').select('handmatig, door, tekst').limit(1);
  if (!error) return true;
  if (ontbreekt(error)) return false;
  throw new Error('herinneringen-log: ' + error.message);
}

/**
 * "HERINNERING NU VERSTUREN" — de voorvertoning: per gevraagde onboarding wie
 * wel en wie niet (en waarom), met naam, mailadres en welke tekst. Leest alles
 * zelf; gelooft van de aanvrager enkel de ids.
 *
 * @param {{db, lms, rijen: object[], ids: string[], vandaag: string}} p
 *   rijen = bouwOverzichtRijen({scope:'active'})
 */
export async function planHandmatig({ db, lms, rijen, ids, vandaag }) {
  const gevraagd = [...new Set((ids || []).filter(Boolean))];
  const opId = new Map((rijen || []).map((r) => [r.id, r]));
  const gevonden = gevraagd.map((id) => opId.get(id)).filter(Boolean);
  const [log, oude, inst, kolommen] = await Promise.all([
    leesLog(db, gevonden.map((r) => r.id)), oudeAutomation(db, gevonden.map((r) => r.id)), leesInstellingen(db), heeftHandmatigKolommen(db),
  ]);
  if (!lms) throw new Error('De koppeling met het LMS is niet geconfigureerd: zonder de signalen ("wil annuleren") vertrekt er niets.');
  const sig = await openSignalen(lms, gevonden);
  const custIds = [...new Set(gevonden.map((r) => r.customer_id).filter(Boolean))];
  const mail = new Map();
  for (let i = 0; i < custIds.length; i += 200) {
    const { data, error } = await db.from('customers').select('id, email').in('id', custIds.slice(i, i + 200));
    if (error) throw new Error('klanten: ' + error.message);
    for (const c of data || []) mail.set(c.id, String(c.email || '').trim() || null);
  }
  const items = gevraagd.map((id) => {
    const r = opId.get(id);
    if (!r) return { onboarding_id: id, naam: null, email: null, besluit: { actie: 'niets', waarom: 'niet_gevonden' } };
    const eigen = log ? (log.get(r.id) || []) : [];
    //  De oude automation mailde al op dag 15: die telt als herinnering_1.
    const overgenomen = !eigen.some((l) => l.soort === 'herinnering_1') && oude.gemaild.has(r.id)
      ? { soort: 'herinnering_1', status: 'overgenomen', aangemaakt_op: oude.gemaild.get(r.id) } : null;
    const ctxLog = overgenomen ? [...eigen, overgenomen] : eigen;
    let besluit = besluitHandmatig(r, { vandaag, log: ctxLog, wilAnnuleren: sig.wilAnnuleren.has(r.id), teksten: inst.teksten });
    const email = mail.get(r.customer_id) || null;
    if (besluit.actie === 'mail' && !email) besluit = { actie: 'niets', waarom: 'geen_email' };
    return { onboarding_id: id, naam: r.customer_name || null, email, rij: r, overgenomen, besluit };
  });
  return { logboek: log !== null, kolommen, inst, items };
}

/** Het antwoord voor het LMS (zonder de interne rij). PURE. */
export function handmatigVoorLms(items) {
  return (items || []).map((it) => ({
    onboarding_id: it.onboarding_id,
    naam: it.naam,
    email: it.email,
    mag: it.besluit.actie === 'mail',
    tekst: it.besluit.actie === 'mail' ? it.besluit.tekst : (it.besluit.tekst || null),
    tekst_label: it.besluit.tekst ? (SOORT_LABEL[it.besluit.tekst] || it.besluit.tekst) : null,
    waarom: it.besluit.actie === 'mail' ? null : it.besluit.waarom,
    waarom_label: it.besluit.actie === 'mail' ? null : waaromLabel(it.besluit),
    uitkomst: it.uitkomst || null,
    fout: it.fout || null,
  }));
}

/**
 * En versturen: opnieuw plannen (de stand van NU, niet die van de
 * voorvertoning), dan per student eerst claimen, dan mailen. Nooit dubbel: de
 * unieke sleutel (onboarding, soort) is de grendel.
 * @param {{db, lms, rijen, ids, vandaag, door: string}} p
 */
export async function stuurHandmatig({ db, lms, rijen, ids, vandaag, door }) {
  const plan = await planHandmatig({ db, lms, rijen, ids, vandaag });
  if (!plan.logboek || !plan.kolommen) return { ...plan, migratie_ontbreekt: true };
  for (const it of plan.items) {
    const b = it.besluit;
    if (b.actie !== 'mail') continue;
    try {
      if (it.overgenomen && await claim(db, it.rij.id, 'herinnering_1')) {
        await markeer(db, it.rij.id, 'herinnering_1', { status: 'overgenomen', aangemaakt_op: it.overgenomen.aangemaakt_op });
      }
      if (!(await claim(db, it.rij.id, b.soort, { handmatig: true, door, tekst: b.tekst }))) {
        it.besluit = { actie: 'niets', waarom: 'recent', sinds: vandaag };
        it.uitkomst = 'overgeslagen';
        continue;
      }
      const m = await stuurHerinnering(db, it.rij, plan.inst.teksten[b.tekst]);
      if (m.ok) {
        await markeer(db, it.rij.id, b.soort, { status: 'verstuurd', naar: m.naar });
        it.uitkomst = 'verstuurd';
      } else {
        await markeer(db, it.rij.id, b.soort, { status: 'mislukt', naar: m.naar || null, fout: (m.fout || m.overgeslagen || '').slice(0, 300) });
        it.uitkomst = 'mislukt';
        it.fout = m.fout || m.overgeslagen || 'mail mislukt';
      }
    } catch (e) {
      it.uitkomst = 'mislukt';
      it.fout = (e?.message || String(e)).slice(0, 300);
      console.error('[onboarding-herinneringen] met de hand', it.onboarding_id, it.fout);
    }
  }
  return plan;
}
