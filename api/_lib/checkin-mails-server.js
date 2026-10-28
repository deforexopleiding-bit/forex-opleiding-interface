// api/_lib/checkin-mails-server.js
//
// De IO rond de check-in-mails (28 okt 2026): het logboek `checkin_mails`
// (CRM), de live campagnes en toewijzingen (LMS), en de mail zelf. De regels:
// checkin-mails.js (puur).

import { SETTING_KEY, besluitCheckinMail, codeFmt, link, genegeerd, normaliseerInstellingen } from './checkin-mails.js';
import { bouwOpmaakMail } from './onboarding-mail-opmaak.js';
import { sendMail } from '../mailer.js';
import { ontbreekt } from './onboarding-herinneringen-server.js';

const CODE_REGEL = '{{checkin.code}}';

export async function leesInstellingen(db) {
  const { data, error } = await db.from('app_settings').select('value').eq('key', SETTING_KEY).maybeSingle();
  if (error) throw new Error('instellingen: ' + error.message);
  return normaliseerInstellingen(data?.value);
}

/** Het logboek per toewijzing; null = de tabel bestaat nog niet. */
export async function leesLog(db, ids) {
  const kaart = new Map();
  const uniek = [...new Set((ids || []).filter(Boolean))];
  if (!uniek.length) {
    const { error } = await db.from('checkin_mails').select('toewijzing_id').limit(1);
    if (error) { if (ontbreekt(error) || /checkin_mails/.test(error.message || '')) return null; throw new Error('checkin-mails-log: ' + error.message); }
    return kaart;
  }
  for (let i = 0; i < uniek.length; i += 200) {
    const { data, error } = await db.from('checkin_mails').select('toewijzing_id, soort, status, naar, aangemaakt_op').in('toewijzing_id', uniek.slice(i, i + 200));
    if (error) {
      if (ontbreekt(error) || /checkin_mails/.test(error.message || '')) return null;
      throw new Error('checkin-mails-log: ' + error.message);
    }
    for (const r of data || []) {
      if (!kaart.has(r.toewijzing_id)) kaart.set(r.toewijzing_id, []);
      kaart.get(r.toewijzing_id).push(r);
    }
  }
  return kaart;
}

/** Eerst claimen (unieke sleutel), dan pas mailen. Een mislukte mag opnieuw. */
export async function claim(db, toewijzingId, soort, campagneId) {
  const { error } = await db.from('checkin_mails').insert({ toewijzing_id: toewijzingId, campagne_id: campagneId, soort, status: 'bezig' });
  if (!error) return true;
  if (error.code !== '23505') throw new Error('checkin-mails-log: ' + error.message);
  const { data, error: uErr } = await db.from('checkin_mails')
    .update({ status: 'bezig', fout: null, aangemaakt_op: new Date().toISOString() })
    .eq('toewijzing_id', toewijzingId).eq('soort', soort).eq('status', 'mislukt').select('toewijzing_id');
  if (uErr) throw new Error('checkin-mails-log: ' + uErr.message);
  return !!(data && data.length);
}

export async function markeer(db, toewijzingId, soort, patch) {
  const { error } = await db.from('checkin_mails').update(patch).eq('toewijzing_id', toewijzingId).eq('soort', soort);
  if (error) console.error('[checkin-mails] log bijwerken', toewijzingId, soort, error.message);
}

/**
 * Het plan van vandaag: per toewijzing in een LIVE campagne de beslissing.
 * @returns {Promise<{log: Map|null, campagnes: object[], plan: Array<{toewijzing, campagne, student, besluit}>, genegeerd: number}>}
 */
export async function planCheckinMails({ db, lms, vandaag }) {
  if (!lms) throw new Error('De koppeling met het LMS is niet geconfigureerd.');
  const { data: campagnes, error: cErr } = await lms.from('hlms_checkin_campagne').select('id, slug, naam, status, live_op').eq('status', 'live');
  if (cErr) throw new Error('campagnes: ' + cErr.message);
  const plan = [];
  let aantalGenegeerd = 0;
  if (!(campagnes || []).length) return { log: await leesLog(db, []), campagnes: [], plan, genegeerd: 0 };
  const ids = campagnes.map((c) => c.id);
  const toewijzingen = [];
  for (let van = 0; ; van += 1000) {
    const { data, error } = await lms.from('hlms_checkin_toewijzing')
      .select('id, campagne_id, student_id, code, is_test, status, verstuurd_op')
      .in('campagne_id', ids).eq('is_test', false).range(van, van + 999);
    if (error) throw new Error('toewijzingen: ' + error.message);
    toewijzingen.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const studentIds = [...new Set(toewijzingen.map((t) => t.student_id))];
  const studenten = new Map();
  for (let i = 0; i < studentIds.length; i += 200) {
    const { data, error } = await lms.from('hlms_student').select('id, email, voornaam').in('id', studentIds.slice(i, i + 200));
    if (error) throw new Error('studenten: ' + error.message);
    for (const s of data || []) studenten.set(s.id, s);
  }
  const log = await leesLog(db, toewijzingen.map((t) => t.id));
  const perId = new Map(campagnes.map((c) => [c.id, c]));
  for (const t of toewijzingen) {
    const c = perId.get(t.campagne_id);
    const s = studenten.get(t.student_id) || null;
    if (genegeerd(t, c, vandaag)) aantalGenegeerd++;
    const besluit = besluitCheckinMail({ toewijzing: t, campagne: c, vandaag, log: log ? (log.get(t.id) || []) : [], email: s?.email || null });
    plan.push({ toewijzing: t, campagne: c, student: s, besluit });
  }
  return { log, campagnes, plan, genegeerd: aantalGenegeerd };
}

/** Bouw en verstuur één check-in-mail (vanaf info@). */
export async function stuurCheckinMail(tekst, { naar, voornaam, code, onderwerpPrefix = '' }) {
  if (!naar) return { ok: false, overgeslagen: 'geen_email' };
  const url = link(code);
  const waarden = {
    '{{student.voornaam}}': String(voornaam || '').trim() || 'daar',
    [CODE_REGEL]: codeFmt(code),
    '{{checkin.link}}': url,
  };
  const mail = bouwOpmaakMail({ subject: tekst.onderwerp, body: tekst.tekst, waarden, link: url, codeLabel: 'Jouw code', codeRegel: CODE_REGEL });
  let onderwerp = String(tekst.onderwerp);
  for (const [k, v] of Object.entries(waarden)) onderwerp = onderwerp.split(k).join(v);
  const res = await sendMail({ to: naar, subject: onderwerpPrefix + onderwerp, text: mail.text, html: mail.html });
  if (!res || res.success === false) return { ok: false, naar, fout: res?.error || 'mail mislukt' };
  return { ok: true, naar };
}
