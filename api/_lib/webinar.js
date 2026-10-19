// api/_lib/webinar.js
//
// Webinar fase 1 — de kern: planning (sessies per week), aanmelden, en de
// berichten (bevestiging + 3 reminders) per e-mail en WhatsApp.
//
// Tabellen (docs/sql-migrations/2026-10-09-webinar-fase1.sql):
//   webinar_reeksen → webinar_sessies (één per week, 'gepland'|'overgeslagen')
//   → webinar_aanmeldingen (per moment een "_op"-kolom, gezet bij het claimen)
//
// Tijd: alles in NL-wandkloktijd (Europe/Amsterdam), DST-correct omgerekend
// naar UTC. Nooit "+7 dagen in ms" (dat schuift 19:00 → 18:00/20:00 rond de
// klokwissel, zoals events-duplicate).
//
// Berichten:
//   bevestiging — direct bij aanmelding (endpoint) of, als dat niet lukte /
//                 na doorschuiven, door de cron (bevestiging_op IS NULL).
//   dag         — de dag ervoor: vanaf 24u vóór de start, en ALLEEN op de
//                 NL-kalenderdag vóór het webinar (de WA-template zegt vast
//                 "morgen"). Wie zich op de dag zelf aanmeldt krijgt hem dus nooit.
//   uur         — vanaf 1u vóór de start (tot 5 min vóór).
//   live        — vanaf de start (tot 20 min erna): "we zijn live".
// Een reminder gaat alleen naar wie VÓÓR dat moment op deze sessie stond, met
// minstens REMINDER_MIN_NA_AANMELDING ertussen (anders landt hij tegelijk met
// de bevestiging). "Op deze sessie sinds" = aangemeld_op, of — na verplaatsen
// door een nieuwe datumkeuze — het moment van verplaatsen (opSessieSinds).
// Fix 2026-10-19: daarvoor telde de oude aangemeld_op, waardoor wie van een
// latere datum naar "vandaag" wisselde direct een "Morgen is het zover" kreeg.
// Claimen = de _op-kolom zetten WHERE hij nog NULL is → nooit dubbel.
//
// WhatsApp: lead-lijn (whatsapp_module_config module 'events'), alleen als de
// template op die lijn APPROVED is (live gevraagd aan 360dialog). Anders
// alleen de mail; reden staat in berichten[moment].wa.

import { supabaseAdmin } from '../supabase.js';
import { sendTemplate } from './meta-whatsapp.js';
import { templateStatusOpLijn } from './meta-whatsapp.js';
import { sendEmailViaSmtp } from './send-email-core.js';
import { logOutboundWa } from './wa-outbound-log.js';
import { renderAfspraakMail, platteTekstAfspraak } from './mail-shell-afspraak.js';
import { templateVariabelen, renderTemplateTekst } from './webinar-templates.js';
// Fase 3: na-webinar opvolging (cyclische import is veilig: alleen in functies gebruikt).
import { opvolgRonde } from './webinar-opvolging.js';

export const ZONE = 'Europe/Amsterdam';
export const MIN = 60 * 1000;
export const UUR = 60 * MIN;
export const MAIL_VAN = 'events@deforexopleiding.nl';
export const AANTAL_WEKEN_VOORUIT = 6;
/** Datumkeuze (2026-10-13): de funnels bieden de eerstvolgende 3 doorgaande sessies aan. */
export const KEUZE_AANTAL = 3;
/** Horizon: altijd minstens zoveel komende, niet-overgeslagen sessies (ruim boven KEUZE_AANTAL). */
export const MIN_KOMENDE_SESSIES = 4;
const MAX_WEKEN_VOORUIT = 16;
export const WA_MODULE = 'events';
const ZOOM_ONTBREEKT = 'volgt vóór de start';
/** Embed van de sessie van een aanmelding — expliciet via sessie_id (zie cronRonde). */
export const SESSIE_EMBED = 'webinar_sessies!webinar_aanmeldingen_sessie_id_fkey!inner';

// ── Tijd (puur) ──────────────────────────────────────────────────────────────

/** Minuten dat NL vóór loopt op UTC op moment `date` (60 of 120). */
export function nlOffsetMin(date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const g = (t) => Number(p.find((x) => x.type === t).value);
  const alsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  const afgerond = Math.floor(date.getTime() / MIN) * MIN;
  return Math.round((alsUtc - afgerond) / MIN);
}

/** NL-wandklok ('YYYY-MM-DD', 'HH:MM[:SS]') → UTC-Date. */
export function nlNaarUtc(datum, tijd) {
  const [j, m, d] = String(datum).split('-').map(Number);
  const [h, mi] = String(tijd).split(':').map(Number);
  const naief = Date.UTC(j, m - 1, d, h, mi);
  let gok = naief - 60 * MIN;
  for (let i = 0; i < 3; i++) gok = naief - nlOffsetMin(new Date(gok)) * MIN;
  return new Date(gok);
}

/** NL-kalenderdatum 'YYYY-MM-DD' van een moment. */
export function nlDatum(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function plusDagen(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n, 12));
  return dt.toISOString().slice(0, 10);
}

/** De komende `aantal` NL-data op ISO-weekdag `weekdag` (1=ma), vandaag inbegrepen. */
export function komendeData(weekdag, aantal, nu = new Date()) {
  const vandaag = nlDatum(nu);
  const [y, m, d] = vandaag.split('-').map(Number);
  const iso = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
  const eerste = plusDagen(vandaag, (weekdag - iso + 7) % 7);
  return Array.from({ length: aantal }, (_, i) => plusDagen(eerste, 7 * i));
}

/** 'maandag 13 oktober' */
export function datumLang(iso) {
  return new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
}
/** '19:00' */
export function tijdNL(iso) {
  return new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

// ── Momenten (puur) ──────────────────────────────────────────────────────────

export const MOMENTEN = Object.freeze([
  Object.freeze({ key: 'dag',  kolom: 'reminder_dag_op', template: 'webinar_reminder_dag', van: -24 * UUR, tot: -3 * UUR }),
  Object.freeze({ key: 'uur',  kolom: 'reminder_uur_op', template: 'webinar_reminder_uur', van: -60 * MIN, tot: -5 * MIN }),
  Object.freeze({ key: 'live', kolom: 'live_op',         template: 'webinar_live',         van: 0,         tot: 20 * MIN }),
]);
export const BEVESTIGING = Object.freeze({ key: 'bevestiging', kolom: 'bevestiging_op', template: 'webinar_bevestiging' });
/** Minimale tijd tussen aanmelden (= bevestiging) en een reminder. */
export const REMINDER_MIN_NA_AANMELDING = 10 * MIN;

/**
 * Sinds wanneer staat deze aanmelding op haar huidige sessie? aangemeld_op,
 * of later: het moment dat ze door een nieuwe datumkeuze verplaatst werd
 * (berichten.verplaatst_door_keuze.op, gezet door meldAan).
 */
export function opSessieSinds(aanmelding) {
  const kandidaten = [aanmelding?.aangemeld_op, aanmelding?.berichten?.verplaatst_door_keuze?.op]
    .map((v) => (v ? new Date(v).getTime() : NaN)).filter((n) => Number.isFinite(n));
  return kandidaten.length ? new Date(Math.max(...kandidaten)).toISOString() : null;
}

/**
 * Relatieve dag van het webinar t.o.v. het verzendmoment (NL-kalender):
 * zelfde dag → 'vanavond' (vanaf 18:00) of 'vandaag'; volgende dag → 'morgen';
 * anders 'op maandag 26 oktober'.
 */
export function dagWoord(startsAt, nu = new Date()) {
  const dag = nlDatum(new Date(startsAt));
  const vandaag = nlDatum(nu);
  if (dag === vandaag) return Number(tijdNL(startsAt).slice(0, 2)) >= 18 ? 'vanavond' : 'vandaag';
  if (dag === plusDagen(vandaag, 1)) return 'morgen';
  return 'op ' + datumLang(startsAt);
}

/** Is dit reminder-moment nú aan de beurt voor deze aanmelding? */
export function momentIsAanDeBeurt(moment, { startsAt, aangemeldOp, nu = new Date() }) {
  const start = new Date(startsAt).getTime();
  const t = nu.getTime() - start;
  if (t < moment.van || t >= moment.tot) return false;
  // "dag" alleen op de kalenderdag ervóór: de tekst (mail én WA-template) is "morgen".
  if (moment.key === 'dag' && dagWoord(startsAt, nu) !== 'morgen') return false;
  const sinds = new Date(aangemeldOp).getTime();
  if (!Number.isFinite(sinds)) return false;
  return sinds < start + moment.van && sinds <= nu.getTime() - REMINDER_MIN_NA_AANMELDING;
}

export function zoomVoor(sessie, reeks) {
  return String(sessie?.zoom_url || reeks?.zoom_url || '').trim() || null;
}

/** Context voor tekst + template-parameters. */
export function bouwContext({ aanmelding, sessie, reeks, nu = new Date() }) {
  const zoom = zoomVoor(sessie, reeks);
  return {
    dagWoord: dagWoord(sessie.starts_at, nu),
    voornaam: String(aanmelding?.voornaam || '').trim() || 'daar',
    datum: datumLang(sessie.starts_at),
    tijd: tijdNL(sessie.starts_at),
    eind: tijdNL(sessie.ends_at),
    zoom: zoom || ZOOM_ONTBREEKT,
    zoomUrl: zoom,
    verplaatst: !!aanmelding?.verplaatst_van_sessie_id,
    titel: reeks?.titel || 'Webinar De Forex Opleiding',
  };
}

const hoofdletter = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

/** De mail per moment. */
export function bouwMail(momentKey, c) {
  const wanneer = { label: 'Wanneer', waarde: `${c.datum}, ${c.tijd}–${c.eind}` };
  const waar = { label: 'Waar', waarde: c.zoomUrl ? `<a href="${c.zoomUrl}" style="color:#10284A">Online via Zoom</a>` : 'Online via Zoom (link volgt vóór de start)' };
  const cta = c.zoomUrl ? { label: 'Deelnemen via Zoom', url: c.zoomUrl } : null;
  const varianten = {
    bevestiging: {
      subject: c.verplaatst ? `Je webinarplek is verplaatst naar ${c.datum}` : `Je bent aangemeld: webinar op ${c.datum}`,
      titel: c.verplaatst ? 'Je webinarplek is verplaatst' : 'Je plek voor het webinar staat vast ✅',
      inleiding: c.verplaatst
        ? `Hoi ${c.voornaam}, het webinar waarvoor je je had aangemeld gaat die week niet door. We hebben je plek automatisch verplaatst naar ${c.datum} om ${c.tijd}. Je hoeft niets te doen.`
        : `Hoi ${c.voornaam}, gelukt! Je bent aangemeld voor het webinar van De Forex Opleiding. Je kijkt live mee via Zoom.`,
      voetnoot: 'Bewaar deze mail, dan heb je de Zoom-link straks bij de hand. Je krijgt de dag ervoor en een uur vooraf nog een herinnering.',
    },
    dag: {
      // Dag-tekst berekend t.o.v. het verzendmoment (normaal 'morgen').
      subject: `${hoofdletter(c.dagWoord)} om ${c.tijd}: het webinar`,
      titel: `${hoofdletter(c.dagWoord)} is het zover`,
      inleiding: `Hoi ${c.voornaam}, een herinnering: ${c.dagWoord} om ${c.tijd} begint het webinar van De Forex Opleiding.`,
      voetnoot: c.dagWoord === 'morgen' ? 'Zet het alvast in je agenda. Tot morgen!' : 'Zet het alvast in je agenda. Tot dan!',
    },
    uur: {
      subject: `Over een uur begint het webinar (${c.tijd})`,
      titel: 'Over een uur beginnen we',
      inleiding: `Hoi ${c.voornaam}, over een uur, om ${c.tijd}, begint het webinar. Klik straks op de knop om mee te doen.`,
      voetnoot: 'Tot zo!',
    },
    live: {
      subject: 'We zijn live: doe mee via Zoom',
      titel: 'We zijn live! 🔴',
      inleiding: `Hoi ${c.voornaam}, het webinar is net begonnen. Doe mee via de knop hieronder.`,
      voetnoot: '',
    },
  };
  const v = varianten[momentKey];
  const args = { subject: v.subject, titel: v.titel, inleiding: v.inleiding, details: momentKey === 'live' ? [waar] : [wanneer, waar], cta, voetnoot: v.voetnoot };
  return { subject: args.subject, html: renderAfspraakMail(args), text: platteTekstAfspraak(args) };
}

// ── Database ─────────────────────────────────────────────────────────────────

export async function haalReeks(sb = supabaseAdmin, slug = 'maandag') {
  const { data, error } = await sb.from('webinar_reeksen').select('*').eq('slug', slug).maybeSingle();
  if (error) throw new Error('webinar_reeksen lezen: ' + error.message);
  return data || null;
}

/**
 * Zorgt dat de komende weken als sessie bestaan. Overgeslagen weken blijven
 * overgeslagen. Horizon (datumkeuze, 2026-10-13): staan er na de standaard
 * AANTAL_WEKEN_VOORUIT minder dan MIN_KOMENDE_SESSIES doorgaande sessies klaar
 * (door overgeslagen weken), dan wordt verder vooruit gepland (max 16 weken),
 * zodat de funnels altijd 3 data kunnen aanbieden.
 */
export async function zorgVoorSessies(sb, reeks, { aantal = AANTAL_WEKEN_VOORUIT, nu = new Date() } = {}) {
  if (!reeks?.actief) return { aangemaakt: 0 };
  const starttijd = String(reeks.starttijd || '19:00').slice(0, 5);
  const plan = async (weken) => {
    const rijen = komendeData(reeks.weekdag, weken, nu).map((datum) => {
      const start = nlNaarUtc(datum, starttijd);
      return {
        reeks_id: reeks.id, datum,
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + (Number(reeks.duur_min) || 60) * MIN).toISOString(),
        status: 'gepland',
      };
    });
    const { data, error } = await sb.from('webinar_sessies')
      .upsert(rijen, { onConflict: 'reeks_id,datum', ignoreDuplicates: true })
      .select('id');
    if (error) throw new Error('webinar_sessies aanmaken: ' + error.message);
    return (data || []).length;
  };
  let aangemaakt = await plan(aantal);
  let weken = aantal;
  while (weken < MAX_WEKEN_VOORUIT && (await komendeSessies(sb, reeks, { nu })).length < MIN_KOMENDE_SESSIES) {
    weken = Math.min(MAX_WEKEN_VOORUIT, weken + 4);
    aangemaakt += await plan(weken);
  }
  return { aangemaakt };
}

/** Komende, doorgaande sessies (status 'gepland', start na nu), vroegste eerst. Zonder planning-stap. */
export async function komendeSessies(sb, reeks, { nu = new Date(), aantal = null } = {}) {
  let q = sb.from('webinar_sessies').select('*')
    .eq('reeks_id', reeks.id).eq('status', 'gepland')
    .gt('starts_at', nu.toISOString())
    .order('starts_at', { ascending: true });
  if (aantal) q = q.limit(aantal);
  const { data, error } = await q;
  if (error) throw new Error('komende sessies: ' + error.message);
  return data || [];
}

/**
 * De sessies die de funnels aanbieden: de eerstvolgende KEUZE_AANTAL doorgaande
 * (zelfde selectie en volgorde als de view website_webinar_volgende).
 */
export async function aangebodenSessies(sb, reeks, { nu = new Date() } = {}) {
  await zorgVoorSessies(sb, reeks, { nu });
  return komendeSessies(sb, reeks, { nu, aantal: KEUZE_AANTAL });
}

/** De eerstvolgende actieve sessie (start nog niet voorbij), optioneel ná een datum. */
export async function volgendeSessie(sb, reeks, { nu = new Date(), naStart = null } = {}) {
  await zorgVoorSessies(sb, reeks, { nu });
  let q = sb.from('webinar_sessies').select('*')
    .eq('reeks_id', reeks.id).eq('status', 'gepland')
    .gt('starts_at', (naStart ? new Date(naStart) : nu).toISOString())
    .order('starts_at', { ascending: true }).limit(1);
  const { data, error } = await q;
  if (error) throw new Error('volgende sessie: ' + error.message);
  return (data || [])[0] || null;
}

async function waLijn(sb) {
  const { data, error } = await sb.from('whatsapp_module_config')
    .select('phone_number_id').eq('module', WA_MODULE).eq('is_active', true).maybeSingle();
  if (error) throw new Error('whatsapp_module_config: ' + error.message);
  return data?.phone_number_id || null;
}

const wacht = (ms) => new Promise((ok) => setTimeout(ok, ms));
const isTijdelijk = (e) => /429|too many|rate|throughput|timeout|ETIMEDOUT|ECONNRESET|5\d\d/i.test(String(e?.message || e || ''));

export async function verstuurWa(sb, { telefoon, templateNaam, ctx, wachtMs = 7000 }) {
  if (!telefoon) return { ok: false, overgeslagen: 'geen_telefoon' };
  const pnId = await waLijn(sb);
  if (!pnId) return { ok: false, overgeslagen: 'geen_wa_lijn' };
  const status = await templateStatusOpLijn(pnId, templateNaam);
  if (status !== 'APPROVED') return { ok: false, overgeslagen: 'template_' + String(status || 'onbekend').toLowerCase() };
  // De dag-template zegt vast "morgen": nooit versturen als dat niet klopt.
  if (templateNaam === 'webinar_reminder_dag' && ctx?.dagWoord && ctx.dagWoord !== 'morgen') {
    return { ok: false, overgeslagen: 'dag_tekst_klopt_niet' };
  }
  const variables = templateVariabelen(templateNaam, ctx);
  let laatste = null;
  for (let poging = 1; poging <= 2; poging++) {
    try {
      const { wamid } = await sendTemplate({ to: telefoon.replace(/^\+/, ''), templateName: templateNaam, variables, phoneNumberId: pnId });
      const log = await logOutboundWa(sb, {
        toPhone: telefoon, phoneNumberId: pnId, body: renderTemplateTekst(templateNaam, ctx), wamid: wamid || null,
        templateName: templateNaam, templateVariables: Object.fromEntries(variables.map((v, i) => [i + 1, v])), source: 'webinar',
      });
      if (!log?.ok) console.warn('[webinar] WA-log mislukt:', log?.error);
      return { ok: true, wamid: wamid || null };
    } catch (e) {
      laatste = e;
      if (poging === 1 && isTijdelijk(e)) { await wacht(wachtMs); continue; }
      break;
    }
  }
  return { ok: false, fout: String(laatste?.message || laatste).slice(0, 300) };
}

async function verstuurMail(aanmelding, momentKey, ctx) {
  const m = bouwMail(momentKey, ctx);
  const r = await sendEmailViaSmtp({ fromMailbox: MAIL_VAN, to: aanmelding.email, subject: m.subject, text: m.text, html: m.html });
  return r?.ok ? { ok: true } : { ok: false, fout: String(r?.reason || r?.code || 'onbekend').slice(0, 300) };
}

/**
 * Claim + verstuur één moment voor één aanmelding. Claimen gebeurt eerst
 * (kolom := now() WHERE kolom IS NULL); lukt de claim niet, dan deed een
 * ander proces het al → { overgeslagen: 'al_geclaimd' }.
 */
export async function verstuurMoment(sb, { aanmelding, sessie, reeks, moment, wachtMs, nu: verzendNu = new Date() }) {
  const nu = new Date().toISOString();
  const { data: claim, error: cErr } = await sb.from('webinar_aanmeldingen')
    .update({ [moment.kolom]: nu, updated_at: nu })
    .eq('id', aanmelding.id).is(moment.kolom, null)
    .select('id, berichten');
  if (cErr) throw new Error(`claim ${moment.key}: ${cErr.message}`);
  if (!claim || !claim.length) return { overgeslagen: 'al_geclaimd' };

  const ctx = bouwContext({ aanmelding, sessie, reeks, nu: verzendNu });
  const alsFout = (e) => ({ ok: false, fout: String(e?.message || e).slice(0, 300) });
  // Mail en WhatsApp tegelijk: scheelt per aanmelder een paar seconden.
  const [mail, wa] = await Promise.all([
    verstuurMail(aanmelding, moment.key, ctx).catch(alsFout),
    verstuurWa(sb, { telefoon: aanmelding.telefoon, templateNaam: moment.template, ctx, wachtMs }).catch(alsFout),
  ]);
  if (!mail.ok) console.error(`[webinar] mail ${moment.key} mislukt`, { aanmelding: aanmelding.id, fout: mail.fout });
  if (!wa.ok && wa.fout) console.error(`[webinar] WA ${moment.key} mislukt`, { aanmelding: aanmelding.id, fout: wa.fout });

  const berichten = { ...(claim[0].berichten || {}), [moment.key]: { op: nu, mail, wa } };
  const { error: bErr } = await sb.from('webinar_aanmeldingen').update({ berichten }).eq('id', aanmelding.id);
  if (bErr) console.error('[webinar] resultaat opslaan mislukt', { aanmelding: aanmelding.id, fout: bErr.message });
  return { mail, wa };
}

/**
 * Aanmelden voor de eerstvolgende actieve sessie. Idempotent per (sessie, e-mail):
 * een tweede aanmelding geeft { al_aangemeld: true } en stuurt geen tweede
 * bevestiging (tenzij de eerste nooit verstuurd is).
 */
/** Komende aanmeldingen van deze persoon (zelfde e-mail óf nummer) op doorgaande sessies. */
async function komendeAanmeldingenVan(sb, { mail, telefoon, komend }) {
  const ids = new Set(komend.map((s) => s.id));
  const lees = async (q, wat) => { const { data, error } = await q; if (error) throw new Error(wat + ': ' + error.message); return data || []; };
  const rijen = [
    ...await lees(sb.from('webinar_aanmeldingen').select('*').ilike('email', mail), 'aanmeldingen op e-mail'),
    ...(telefoon ? await lees(sb.from('webinar_aanmeldingen').select('*').eq('telefoon', telefoon), 'aanmeldingen op nummer') : []),
  ];
  const uniek = [...new Map(rijen.map((r) => [r.id, r])).values()].filter((r) => ids.has(r.sessie_id) && !r.is_test);
  const start = new Map(komend.map((s) => [s.id, String(s.starts_at)]));
  return uniek.sort((a, b) => start.get(a.sessie_id).localeCompare(start.get(b.sessie_id)));
}

/**
 * Aanmelden voor een webinar-sessie.
 *
 * Datumkeuze (2026-10-13): `sessieId` = de door de deelnemer gekozen sessie. Die
 * MOET één van de op dit moment aangeboden sessies zijn (de eerstvolgende
 * KEUZE_AANTAL doorgaande — aangebodenSessies); verleden, overgeslagen of
 * onbekend → { ongeldigeSessie: true } (de client wordt niet vertrouwd). Zonder
 * sessieId (de website van vóór de datumkeuze, of een formulier zonder opties):
 * de eerstvolgende (oude gedrag) — en wie al voor een komende sessie staat,
 * blijft daar staan ({ alAangemeld: true }); zonder keuze wordt nooit verplaatst.
 *
 * Al aangemeld (zelfde e-mail of nummer) voor een komende sessie:
 *   - zelfde datum → { alAangemeld: true }, geen tweede bevestiging (tenzij de
 *     eerste nooit verstuurd is);
 *   - andere datum → die aanmelding VERPLAATSEN naar de gekozen sessie (claims
 *     terug op NULL) en een verse bevestiging sturen → { verplaatst: true }.
 */
export async function meldAan(sb, { voornaam, email, telefoon, bron, leadId = null, toestemming = false, sessieId = null, nu = new Date() }) {
  const reeks = await haalReeks(sb);
  if (!reeks || !reeks.actief) return { geenSessie: true };
  const aangeboden = await aangebodenSessies(sb, reeks, { nu });
  if (!aangeboden.length) return { geenSessie: true };
  let sessie = sessieId ? aangeboden.find((s) => s.id === sessieId) : aangeboden[0];
  if (!sessie) return { ongeldigeSessie: true, aangeboden };

  const mail = String(email).trim().toLowerCase();
  let lead = leadId || null;
  if (!lead) {
    const { data: l } = await sb.from('leads').select('id').ilike('email', mail).is('verwijderd_op', null).limit(1);
    lead = l?.[0]?.id || null;
  }
  const aanvullen = async (aanmelding) => {
    const aanvulling = {};
    if (!aanmelding.telefoon && telefoon) aanvulling.telefoon = telefoon;
    if (!aanmelding.lead_id && lead) aanvulling.lead_id = lead;
    if (Object.keys(aanvulling).length) {
      await sb.from('webinar_aanmeldingen').update(aanvulling).eq('id', aanmelding.id);
      Object.assign(aanmelding, aanvulling);
    }
  };
  const bevestig = async (aanmelding) => (!aanmelding.bevestiging_op
    ? verstuurMoment(sb, { aanmelding, sessie, reeks, moment: BEVESTIGING })
    : null);

  // Al aangemeld voor een komende sessie (e-mail of nummer)?
  const komend = await komendeSessies(sb, reeks, { nu });
  const eerder = await komendeAanmeldingenVan(sb, { mail, telefoon: telefoon || null, komend });
  // Zonder sessieId geen keuze → een bestaande komende aanmelding blijft staan
  // (backward-compatible met de website van vóór de datumkeuze).
  const opGekozen = eerder.find((a) => a.sessie_id === sessie.id) || (sessieId ? null : eerder[0] || null);
  if (opGekozen) {
    if (opGekozen.sessie_id !== sessie.id) sessie = komend.find((s) => s.id === opGekozen.sessie_id) || sessie;
    await aanvullen(opGekozen);
    return { aanmelding: opGekozen, sessie, reeks, alAangemeld: true, verplaatst: false, bevestiging: await bevestig(opGekozen) };
  }
  if (eerder.length) {
    // Andere datum gekozen → de (vroegste) bestaande aanmelding verplaatsen.
    const oud = eerder[0];
    // nu (niet een losse new Date()): dit moment telt als "op deze sessie sinds"
    // voor de reminders (opSessieSinds).
    const t = nu.toISOString();
    const reset = { sessie_id: sessie.id, verplaatst_van_sessie_id: null, bevestiging_op: null, reminder_dag_op: null, reminder_uur_op: null, live_op: null, updated_at: t };
    for (const k of ['opvolging_1_op', 'opvolging_2_op']) if (k in oud) reset[k] = null;
    reset.berichten = { ...(oud.berichten || {}), verplaatst_door_keuze: { op: t, van_sessie_id: oud.sessie_id } };
    const { data: upd, error: uErr } = await sb.from('webinar_aanmeldingen').update(reset).eq('id', oud.id).select('*');
    if (uErr) throw new Error('aanmelding verplaatsen: ' + uErr.message);
    const aanmelding = (upd && upd[0]) || { ...oud, ...reset };
    await aanvullen(aanmelding);
    return { aanmelding, sessie, reeks, alAangemeld: false, verplaatst: true, van_sessie_id: oud.sessie_id, bevestiging: await bevestig(aanmelding) };
  }

  const rij = { sessie_id: sessie.id, lead_id: lead, voornaam: String(voornaam || '').trim() || null, email: mail, telefoon: telefoon || null, bron: bron || null, toestemming: !!toestemming };
  let aanmelding; let alAangemeld = false;
  const { data: nieuw, error: iErr } = await sb.from('webinar_aanmeldingen').insert(rij).select('*').single();
  if (!iErr) aanmelding = nieuw;
  else if (iErr.code === '23505') {
    // Race: tegelijk aangemeld (of testaanmelding op dit adres) → als al aangemeld behandelen.
    alAangemeld = true;
    const { data: bestaand, error: bErr } = await sb.from('webinar_aanmeldingen').select('*')
      .eq('sessie_id', sessie.id).ilike('email', mail).limit(1);
    if (bErr || !bestaand?.length) throw new Error('bestaande aanmelding lezen: ' + (bErr?.message || 'niet gevonden'));
    aanmelding = bestaand[0];
    await aanvullen(aanmelding);
  } else throw new Error('aanmelding opslaan: ' + iErr.message);

  return { aanmelding, sessie, reeks, alAangemeld, verplaatst: false, bevestiging: await bevestig(aanmelding) };
}

/**
 * Een week overslaan: status 'overgeslagen' en de aanmelders doorschuiven naar
 * de eerstvolgende actieve sessie. Hun berichten-claims worden gereset; de cron
 * stuurt binnen 5 minuten een nieuwe bevestiging ("je plek is verplaatst").
 * Staat iemand al op de doelsessie, dan vervalt de dubbele aanmelding.
 */
export async function slaSessieOver(sb, { sessieId, doorUserId = null, notitie = null, nu = new Date() }) {
  const { data: sessie, error } = await sb.from('webinar_sessies').select('*').eq('id', sessieId).maybeSingle();
  if (error) throw new Error('sessie lezen: ' + error.message);
  if (!sessie) return { fout: 'NIET_GEVONDEN' };
  if (new Date(sessie.starts_at) <= nu) return { fout: 'AL_BEGONNEN' };
  const t = nu.toISOString();
  const { error: uErr } = await sb.from('webinar_sessies')
    .update({ status: 'overgeslagen', overgeslagen_op: t, overgeslagen_door: doorUserId, notitie, updated_at: t })
    .eq('id', sessieId);
  if (uErr) throw new Error('overslaan: ' + uErr.message);

  const reeks = { ...(await haalReeksOpId(sb, sessie.reeks_id)) };
  const doel = await volgendeSessie(sb, reeks, { nu, naStart: sessie.starts_at });
  const { data: aanm, error: aErr } = await sb.from('webinar_aanmeldingen').select('id, email').eq('sessie_id', sessieId);
  if (aErr) throw new Error('aanmelders lezen: ' + aErr.message);
  if (!aanm?.length) return { verplaatst: 0, vervallen: 0, doel };
  if (!doel) return { verplaatst: 0, vervallen: 0, doel: null, waarschuwing: 'Geen volgende actieve sessie — aanmelders niet verplaatst.' };

  const { data: alOpDoel } = await sb.from('webinar_aanmeldingen').select('email').eq('sessie_id', doel.id);
  const bezet = new Set((alOpDoel || []).map((r) => String(r.email).toLowerCase()));
  let verplaatst = 0; let vervallen = 0;
  for (const a of aanm) {
    try {
      if (bezet.has(String(a.email).toLowerCase())) {
        const { error: dErr } = await sb.from('webinar_aanmeldingen').delete().eq('id', a.id);
        if (dErr) throw new Error(dErr.message);
        vervallen++;
        continue;
      }
      const { error: mErr } = await sb.from('webinar_aanmeldingen').update({
        sessie_id: doel.id, verplaatst_van_sessie_id: sessieId,
        bevestiging_op: null, reminder_dag_op: null, reminder_uur_op: null, live_op: null, updated_at: t,
      }).eq('id', a.id);
      if (mErr) throw new Error(mErr.message);
      bezet.add(String(a.email).toLowerCase());
      verplaatst++;
    } catch (e) {
      console.error('[webinar] doorschuiven mislukt', { aanmelding: a.id, fout: e?.message || e });
    }
  }
  return { verplaatst, vervallen, doel };
}

export async function haalReeksOpId(sb, id) {
  const { data, error } = await sb.from('webinar_reeksen').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('reeks lezen: ' + error.message);
  return data;
}

/**
 * Cron-ronde: sessies aanvullen, ontbrekende bevestigingen versturen, en de
 * reminders die nu aan de beurt zijn. Per aanmelding try/catch.
 * Tijdbudget: Vercel kapt af op 60 s. Na `budgetMs` stopt de ronde netjes; wat
 * bleef liggen pakt de volgende (cron draait elke minuut, de vensters zijn ruim).
 */
export async function cronRonde(sb, { nu = new Date(), wachtMs, budgetMs = 45 * 1000 } = {}) {
  const uit = { sessies_aangemaakt: 0, bevestiging: 0, dag: 0, uur: 0, live: 0, opvolging_1: 0, opvolging_2: 0, opvolging_overgeslagen: 0, fouten: 0, eerste_fouten: [], afgebroken: false };
  const deadline = Date.now() + budgetMs;
  const tijdOp = () => { if (Date.now() > deadline) { uit.afgebroken = true; return true; } return false; };
  const fout = (ctx, e) => {
    uit.fouten++;
    if (uit.eerste_fouten.length < 3) uit.eerste_fouten.push(`${ctx}: ${String(e?.message || e).slice(0, 200)}`);
    console.error('[cron-webinar]', ctx, e?.message || e);
  };
  const { data: reeksen, error } = await sb.from('webinar_reeksen').select('*').eq('actief', true);
  if (error) throw new Error('reeksen lezen: ' + error.message);
  for (const reeks of reeksen || []) {
    try { uit.sessies_aangemaakt += (await zorgVoorSessies(sb, reeks, { nu })).aangemaakt; } catch (e) { fout('sessies', e); }
    // Actieve sessies van nu-30 min tot +25 uur: daar vallen alle momenten in.
    const { data: sessies, error: sErr } = await sb.from('webinar_sessies').select('*')
      .eq('reeks_id', reeks.id).eq('status', 'gepland')
      .gte('starts_at', new Date(nu.getTime() - 30 * MIN).toISOString())
      .lte('starts_at', new Date(nu.getTime() + 25 * UUR).toISOString());
    if (sErr) { fout('sessies lezen', sErr); continue; }
    // Bevestigingen die nog openstaan (endpoint faalde / doorgeschoven) — ook verder vooruit.
    // De koppeling MOET bij naam: webinar_aanmeldingen heeft twee FK's naar
    // webinar_sessies (sessie_id én verplaatst_van_sessie_id). Een kale
    // webinar_sessies!inner gaf PGRST201 ("more than one relationship") en dus
    // nooit een bevestiging na doorschuiven (2026-10-12). Resultaatsleutel blijft
    // 'webinar_sessies'.
    const { data: open, error: oErr } = await sb.from('webinar_aanmeldingen')
      .select(`*, ${SESSIE_EMBED}(*)`)
      .is('bevestiging_op', null).eq('is_test', false)
      .eq('webinar_sessies.status', 'gepland').eq('webinar_sessies.reeks_id', reeks.id)
      .gt('webinar_sessies.starts_at', nu.toISOString())
      .limit(50);
    if (oErr) fout('open bevestigingen lezen', oErr);
    for (const a of open || []) {
      if (tijdOp()) return uit;
      try {
        const r = await verstuurMoment(sb, { aanmelding: a, sessie: a.webinar_sessies, reeks, moment: BEVESTIGING, wachtMs });
        if (!r.overgeslagen) uit.bevestiging++;
      } catch (e) { fout('bevestiging ' + a.id, e); }
    }
    for (const sessie of sessies || []) {
      const actief = MOMENTEN.filter((m) => {
        const t = nu.getTime() - new Date(sessie.starts_at).getTime();
        return t >= m.van && t < m.tot;
      });
      if (!actief.length) continue;
      const { data: aanm, error: aErr } = await sb.from('webinar_aanmeldingen').select('*')
        .eq('sessie_id', sessie.id).eq('is_test', false);
      if (aErr) { fout('aanmelders ' + sessie.id, aErr); continue; }
      for (const a of aanm || []) {
        for (const m of actief) {
          if (a[m.kolom]) continue;
          if (tijdOp()) return uit;
          if (!momentIsAanDeBeurt(m, { startsAt: sessie.starts_at, aangemeldOp: opSessieSinds(a), nu })) continue;
          try {
            const r = await verstuurMoment(sb, { aanmelding: a, sessie, reeks, moment: m, wachtMs, nu });
            if (!r.overgeslagen) uit[m.key]++;
          } catch (e) { fout(`${m.key} ${a.id}`, e); }
        }
      }
    }
  }
  // Fase 3: na-webinar opvolging (na de reminders — die zijn tijdkritischer).
  for (const reeks of reeksen || []) {
    if (tijdOp()) return uit;
    try { await opvolgRonde(sb, reeks, { nu, wachtMs, tijdOp, fout, uit }); } catch (e) { fout('opvolging', e); }
  }
  return uit;
}
