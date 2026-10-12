// api/_lib/webinar-opvolging.js
//
// Webinar fase 3 (2026-10-12) — na-webinar opvolging voor aanmelders die GEEN
// call boekten. Twee nudges, elk per mail (events@, huisstijl, knop naar de
// boekingslink) én WhatsApp (MARKETING-templates webinar_opvolging_1/2):
//   opvolging_1 — de webinar-avond: vanaf einde + 10 min tot 21:30 NL. Gemist
//                 (cron lag eruit) = vervalt; er gaat niets 's nachts uit.
//   opvolging_2 — de dag erna, 10:00–20:00 NL.
// Aangeroepen vanuit cronRonde (api/_lib/webinar.js), elke minuut.
//
// WIE KRIJGT ER EEN (opvolgBesluit, PURE):
//   - alleen aanmelders van een sessie die echt doorging (status 'gepland',
//     afgelopen), geen testaanmeldingen;
//   - NIET wie al een webinar-call boekte: een afspraak met booking_source
//     'webinar', aangemaakt NA de aanmelding, op e-mail / telefoon (laatste 9
//     cijfers) / lead_id (via opstartsessie_submissions), niet cancelled of
//     verwijderd. Wie boekte en annuleerde krijgt de nudge dus wél;
//   - NIET wie al een andere AANKOMENDE afspraak heeft, ongeacht de bron (bv.
//     via Romy): status niet afgerond/geannuleerd en scheduled_at in de toekomst.
// De boekingsdata wordt per sessie geladen en elke 20 s ververst, dus de check
// gebeurt vlak vóór het verzenden. Boekt iemand tussen nudge 1 en 2, dan slaat
// nudge 2 over.
//
// Per aanmelder per nudge één claim op opvolging_1_op / opvolging_2_op (zelfde
// patroon als de reminders): verstuurd of overgeslagen → kolom gezet, reden in
// berichten[<key>]. Nooit dubbel. Kolommen uit migratie
// docs/sql-migrations/2026-10-12-webinar-opvolging.sql — ontbreken ze, dan doet
// deze ronde niets (de rest van de cron loopt door).
//
// Mail = marketing: mailvoorkeuren gerespecteerd (afgemeld of soort 'events'
// uit → geen mail; WhatsApp wel), met voorkeuren-/afmeldlink + List-Unsubscribe.

import { sendEmailViaSmtp } from './send-email-core.js';
import { renderAfspraakMail, platteTekstAfspraak } from './mail-shell-afspraak.js';
import { magOntvangen, zorgVoorkeur, voorkeurenUrl, afmeldUrl } from './mail-voorkeuren.js';
import { MAIL_VAN, MIN, nlDatum, nlNaarUtc, plusDagen, verstuurWa } from './webinar.js';

export const AGENDA_URL = 'https://deforexopleiding.nl/agenda/webinar';
/** Canonieke scan-omschrijving — kopie van SCAN_OMSCHRIJVING in dfo-website lib/agenda-bron-tekst.ts. */
export const SCAN_OMSCHRIJVING = 'Gratis strategie-scan (t.w.v. €99). In 15-20 minuten ontdek je samen met ons precies waar je staat, welke stappen je kunt zetten en wat jouw mogelijkheden zijn. Je ontvangt daarna een persoonlijk, uitgebreid rapport én een certificaat van De Forex Opleiding.';
export const URGENTIE = 'Er zijn maar 3 gratis scan-plekken per webinar.';
export const MIGRATIE = '2026-10-12-webinar-opvolging.sql';

export const OPVOLGINGEN = Object.freeze([
  Object.freeze({ key: 'opvolging_1', kolom: 'opvolging_1_op', template: 'webinar_opvolging_1' }),
  Object.freeze({ key: 'opvolging_2', kolom: 'opvolging_2_op', template: 'webinar_opvolging_2' }),
]);

// ── Tijdvensters (PURE, NL-wandklok, DST-correct) ────────────────────────────

/** { van, tot } (Date, tot exclusief) voor een nudge bij deze sessie. */
export function opvolgVenster(key, sessie) {
  const dag = nlDatum(new Date(sessie.starts_at));
  if (key === 'opvolging_1') {
    return { van: new Date(new Date(sessie.ends_at).getTime() + 10 * MIN), tot: nlNaarUtc(dag, '21:30') };
  }
  if (key === 'opvolging_2') {
    const morgen = plusDagen(dag, 1);
    return { van: nlNaarUtc(morgen, '10:00'), tot: nlNaarUtc(morgen, '20:00') };
  }
  throw new Error('Onbekende opvolging: ' + key);
}
export function inVenster(key, sessie, nu = new Date()) {
  const v = opvolgVenster(key, sessie);
  return nu >= v.van && nu < v.tot;
}

// ── Geboekt? Aankomend? (PURE) ───────────────────────────────────────────────

const AFGEVALLEN = new Set(['cancelled', 'verwijderd']);
const NIET_AANKOMEND = new Set(['cancelled', 'verwijderd', 'verplaatst', 'completed', 'no_show']);
export const normEmail = (s) => String(s || '').trim().toLowerCase();
export const tel9 = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-9) : null; };

/** Zelfde persoon? E-mail, laatste 9 cijfers van het nummer, of lead_id via de submissie. */
export function zelfdePersoon(afspraak, aanmelding, submissions = []) {
  const e = normEmail(aanmelding.email);
  if (e && normEmail(afspraak.lead_email) === e) return true;
  const t = tel9(aanmelding.telefoon);
  if (t && tel9(afspraak.lead_phone) === t) return true;
  if (aanmelding.lead_id) {
    return submissions.some((s) => s.appointment_id === afspraak.id && s.lead_id === aanmelding.lead_id);
  }
  return false;
}

/** De webinar-boeking van deze aanmelder (na de aanmelding, niet geannuleerd/verwijderd), of null. */
export function webinarBoekingVan(aanmelding, { afspraken = [], submissions = [] } = {}) {
  const na = new Date(aanmelding.aangemeld_op || aanmelding.created_at || 0).getTime();
  return afspraken.find((a) => a.booking_source === 'webinar'
    && !AFGEVALLEN.has(String(a.status || ''))
    && new Date(a.created_at).getTime() >= na
    && zelfdePersoon(a, aanmelding, submissions)) || null;
}

/** Een aankomende, niet-afgeronde afspraak van deze persoon (welke bron ook), of null. */
export function aankomendeAfspraakVan(aanmelding, { aankomend = [], submissions = [] } = {}, nu = new Date()) {
  return aankomend.find((a) => !NIET_AANKOMEND.has(String(a.status || ''))
    && new Date(a.scheduled_at).getTime() > nu.getTime()
    && zelfdePersoon(a, aanmelding, submissions)) || null;
}

/** Moet deze aanmelder de nudge krijgen? → { sturen, reden } */
export function opvolgBesluit(aanmelding, data, nu = new Date()) {
  if (aanmelding.is_test) return { sturen: false, reden: 'test' };
  if (webinarBoekingVan(aanmelding, data)) return { sturen: false, reden: 'geboekt' };
  if (aankomendeAfspraakVan(aanmelding, data, nu)) return { sturen: false, reden: 'aankomende_afspraak' };
  return { sturen: true, reden: null };
}

// ── Mail (PURE) ──────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const scanZin = SCAN_OMSCHRIJVING.replace(/^Gratis strategie-scan \(t\.w\.v\. €99\)\. /, '');

export function bouwOpvolgMail(key, { voornaam, voorkeurenLink = null } = {}) {
  const naam = esc(String(voornaam || '').trim() || 'daar');
  const cta = { label: 'Plan je gratis scan', url: AGENDA_URL };
  const afmeld = voorkeurenLink
    ? `<br><br>Liever minder of geen mails? <a href="${esc(voorkeurenLink)}" style="color:#7a8798">Voorkeuren aanpassen of afmelden</a>.`
    : '';
  const v = key === 'opvolging_1' ? {
    subject: 'Jouw gratis strategie-scan staat klaar',
    titel: 'Jouw gratis strategie-scan staat klaar',
    inleiding: `Hoi ${naam}, bedankt voor je aanmelding voor onze webinar. De volgende stap is je gratis strategie-scan (t.w.v. €99). ${esc(scanZin)}<br><br>Er zijn maar 3 gratis scan-plekken per webinar — plan 'm nu in.`,
  } : {
    subject: 'Laatste kans: je gratis scan-plek',
    titel: 'Laatste kans op je gratis scan-plek ⏳',
    inleiding: `Hoi ${naam}, de gratis scan-plekken van deze week zijn bijna vol. Wil je jouw gratis strategie-scan (t.w.v. €99)? ${esc(scanZin)}<br><br>Plan dan vandaag nog je gratis strategie-scan in.`,
  };
  const args = { subject: v.subject, titel: v.titel, inleiding: v.inleiding, details: [], cta, voetnoot: URGENTIE + afmeld };
  return { subject: v.subject, html: renderAfspraakMail(args), text: platteTekstAfspraak(args) + (voorkeurenLink ? `\nVoorkeuren aanpassen of afmelden: ${voorkeurenLink}` : '') };
}

// ── Database ─────────────────────────────────────────────────────────────────

/** Boekingsdata om "geboekt / aankomend" te bepalen. */
export async function laadBoekingData(sb, { vanaf, nu = new Date() }) {
  const velden = 'id, lead_email, lead_phone, status, booking_source, created_at, scheduled_at';
  const [a, k, s] = await Promise.all([
    sb.from('follow_up_appointments').select(velden).eq('booking_source', 'webinar').gte('created_at', vanaf).limit(5000),
    sb.from('follow_up_appointments').select(velden).gt('scheduled_at', nu.toISOString()).in('status', ['scheduled', 'wacht_op_reschedule']).limit(5000),
    sb.from('opstartsessie_submissions').select('lead_id, appointment_id, booking_source').eq('booking_source', 'webinar').not('lead_id', 'is', null).limit(5000),
  ]);
  if (a.error) throw new Error('webinar-boekingen lezen: ' + a.error.message);
  if (k.error) throw new Error('aankomende afspraken lezen: ' + k.error.message);
  if (s.error) console.warn('[webinar-opvolging] submissies lezen (fail-soft):', s.error.message);
  return { afspraken: a.data || [], aankomend: k.data || [], submissions: s.error ? [] : (s.data || []) };
}

/** Claim de nudge-kolom (verstuurd of overgeslagen). null = al door een ander gedaan. */
async function claim(sb, aanmelding, opv, nuIso) {
  const { data, error } = await sb.from('webinar_aanmeldingen')
    .update({ [opv.kolom]: nuIso, updated_at: nuIso })
    .eq('id', aanmelding.id).is(opv.kolom, null)
    .select('id, berichten');
  if (error) throw new Error(`claim ${opv.key}: ${error.message}`);
  return data && data.length ? data[0] : null;
}

async function bewaar(sb, aanmelding, opv, gelezen, resultaat) {
  const berichten = { ...(gelezen.berichten || {}), [opv.key]: resultaat };
  const { error } = await sb.from('webinar_aanmeldingen').update({ berichten }).eq('id', aanmelding.id);
  if (error) console.error('[webinar-opvolging] resultaat opslaan mislukt', { aanmelding: aanmelding.id, fout: error.message });
}

async function verstuurOpvolgMail(sb, aanmelding, opv) {
  let voorkeur = null;
  try { voorkeur = await zorgVoorkeur(sb, aanmelding.email, aanmelding.lead_id || null); }
  catch (e) { console.warn('[webinar-opvolging] voorkeur (fail-soft):', e?.message || e); }
  const mag = magOntvangen(voorkeur, 'events');
  if (!mag.ok) return { ok: false, overgeslagen: mag.reden };
  const link = voorkeur?.token ? voorkeurenUrl(voorkeur.token) : null;
  const m = bouwOpvolgMail(opv.key, { voornaam: aanmelding.voornaam, voorkeurenLink: link });
  const headers = voorkeur?.token
    ? { 'List-Unsubscribe': `<${afmeldUrl(voorkeur.token)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined;
  const r = await sendEmailViaSmtp({ fromMailbox: MAIL_VAN, to: aanmelding.email, subject: m.subject, text: m.text, html: m.html, headers });
  return r?.ok ? { ok: true } : { ok: false, fout: String(r?.reason || r?.code || 'onbekend').slice(0, 300) };
}

/** Eén nudge voor één aanmelder: besluit → claim → mail + WhatsApp → resultaat. */
export async function verwerkOpvolging(sb, { aanmelding, opv, data, nu = new Date(), wachtMs }) {
  const besluit = opvolgBesluit(aanmelding, data, nu);
  const nuIso = new Date().toISOString();
  const gelezen = await claim(sb, aanmelding, opv, nuIso);
  if (!gelezen) return { overgeslagen: 'al_geclaimd' };
  if (!besluit.sturen) {
    await bewaar(sb, aanmelding, opv, gelezen, { op: nuIso, overgeslagen: besluit.reden });
    return { overgeslagen: besluit.reden };
  }
  const alsFout = (e) => ({ ok: false, fout: String(e?.message || e).slice(0, 300) });
  const [mail, wa] = await Promise.all([
    verstuurOpvolgMail(sb, aanmelding, opv).catch(alsFout),
    verstuurWa(sb, { telefoon: aanmelding.telefoon, templateNaam: opv.template, ctx: { voornaam: String(aanmelding.voornaam || '').trim() || 'daar' }, wachtMs }).catch(alsFout),
  ]);
  if (!mail.ok && mail.fout) console.error(`[webinar-opvolging] mail ${opv.key} mislukt`, { aanmelding: aanmelding.id, fout: mail.fout });
  if (!wa.ok && wa.fout) console.error(`[webinar-opvolging] WA ${opv.key} mislukt`, { aanmelding: aanmelding.id, fout: wa.fout });
  await bewaar(sb, aanmelding, opv, gelezen, { op: nuIso, mail, wa });
  return { mail, wa };
}

const VERS_MS = 20 * 1000;

/**
 * De opvolg-ronde voor één reeks (vanuit cronRonde). Muteert `uit`:
 * opvolging_1 / opvolging_2 (verstuurd) en opvolging_overgeslagen.
 */
export async function opvolgRonde(sb, reeks, { nu = new Date(), wachtMs, tijdOp = () => false, fout = () => {}, uit }) {
  const { data: sessies, error } = await sb.from('webinar_sessies').select('*')
    .eq('reeks_id', reeks.id).eq('status', 'gepland')
    .gte('starts_at', new Date(nu.getTime() - 3 * 24 * 60 * MIN).toISOString())
    .lte('ends_at', nu.toISOString());
  if (error) { fout('opvolging sessies', error); return; }
  for (const sessie of sessies || []) {
    const actief = OPVOLGINGEN.filter((o) => inVenster(o.key, sessie, nu));
    if (!actief.length) continue;
    const { data: aanm, error: aErr } = await sb.from('webinar_aanmeldingen').select('*')
      .eq('sessie_id', sessie.id).eq('is_test', false);
    if (aErr) { fout('opvolging aanmelders ' + sessie.id, aErr); continue; }
    if (!aanm || !aanm.length) continue;
    if (!('opvolging_1_op' in aanm[0])) {
      if (!uit.opvolging_migratie_ontbreekt) console.warn(`[webinar-opvolging] kolommen ontbreken — draai ${MIGRATIE}; nudges overgeslagen`);
      uit.opvolging_migratie_ontbreekt = true;
      return;
    }
    const open = aanm.filter((a) => actief.some((o) => !a[o.kolom]));
    if (!open.length) continue;
    const vanaf = open.reduce((m, a) => (String(a.aangemeld_op) < m ? String(a.aangemeld_op) : m), String(open[0].aangemeld_op));
    let data = null; let geladen = 0;
    for (const a of open) {
      for (const o of actief) {
        if (a[o.kolom]) continue;
        if (tijdOp()) return;
        try {
          if (!data || Date.now() - geladen > VERS_MS) { data = await laadBoekingData(sb, { vanaf, nu: new Date() }); geladen = Date.now(); }
          const r = await verwerkOpvolging(sb, { aanmelding: a, opv: o, data, nu: new Date(), wachtMs });
          if (r.overgeslagen && r.overgeslagen !== 'al_geclaimd') uit.opvolging_overgeslagen = (uit.opvolging_overgeslagen || 0) + 1;
          else if (!r.overgeslagen) uit[o.key] = (uit[o.key] || 0) + 1;
        } catch (e) { fout(`${o.key} ${a.id}`, e); }
      }
    }
  }
}
