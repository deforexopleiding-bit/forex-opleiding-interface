// api/_lib/support-alarm.js
//
// EEN SUPPORTCHAT MAG NOOIT GEMIST WORDEN.
//
// Twee kanalen, één regel over wat "onbeantwoord" is:
//
//   1. De rinkelende balk in het CRM (modules/klanten-v2/support-alarm.js,
//      gevoed door api/support-alarm.js). Rinkelt zolang er een gesprek is
//      waarin het laatste woord van de klant nog geen antwoord van een mens
//      kreeg. "Ik neem het" stopt 'm bij iedereen; na `escalatie_min` minuten
//      wordt de balk rood.
//   2. Een mail naar het team (standaard administratie@), server-side, dus
//      ook als niemand het CRM open heeft. Bij elk NIEUW gesprek, en als een
//      klant opnieuw schrijft terwijl er al `mail_stilte_min` minuten
//      niemand van ons reageerde. Nooit per bericht: hooguit één mail per
//      gesprek per stilteperiode, geclaimd via `team_gemaild_op`
//      (migratie 2026-10-21-support-chat-alarm.sql).
//
// Wat "van ons" is: een bericht van een medewerker, of het oppakken van het
// gesprek (toegewezen_op). Sam (de bot) telt NIET als antwoord van ons — een
// bezoeker die de bot spreekt, zit wél in de chat en kan een mens nodig
// hebben. Een bot-gesprek alarmeert daarom alleen zolang het vers is
// (BOT_VENSTER_MIN): daarna is de bezoeker weg en had Sam het antwoord.
// Een gesprek in de wachtrij (wacht_op_ons) alarmeert zonder tijdslimiet.
//
// Alles boven de streep "── met database ──" is PUUR en getest in
// tests/support-alarm.test.js.

import { waitUntil } from '@vercel/functions';
import { supabaseAdmin } from '../supabase.js';
import { sendEmailViaSmtp } from './send-email-core.js';
import { renderMailShell, platteTekstMail, escMailHtml } from './mail-shell.js';
import { toonSupportTelefoon } from './support-telefoon.js';

export const MIN = 60 * 1000;

export const ALARM_STANDAARD = Object.freeze({
  geluid: true,            // rinkelen in het CRM (per browser nog los uit te zetten)
  interval_s: 4,           // om de hoeveel seconden het belletje klinkt
  escalatie_min: 5,        // na zoveel minuten onbeantwoord: rode balk
  mail_aan: true,
  mail_naar: 'administratie@deforexopleiding.nl',
  mail_stilte_min: 30,     // klant schrijft opnieuw na zoveel minuten stilte van ons → mail
});

/** Een bot-gesprek alarmeert zolang het laatste klantbericht hooguit zo oud is. */
export const BOT_VENSTER_MIN = 30;

/** Een gesprek zonder teammail telt als "nieuw" zolang het zo jong is. */
export const NIEUW_VENSTER_MIN = 10;

export const APP_SETTINGS_KEY = 'support_alarm';

const MAILBOX_RE = /^[a-z0-9._+-]+@deforexopleiding\.nl$/;

const ms = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

function geheel(v, min, max, standaard) {
  const n = Number(v);
  if (!Number.isFinite(n)) return standaard;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * De instellingen uit app_settings, geschoond en aangevuld. PUUR.
 * Een kapotte of ontbrekende waarde valt terug op de standaard — een alarm dat
 * stilvalt door een typefout in de configuratie is precies wat we niet willen.
 */
export function leesAlarmInstellingen(waarde) {
  const v = waarde && typeof waarde === 'object' ? waarde : {};
  const naar = String(v.mail_naar || '').trim().toLowerCase();
  return {
    geluid: v.geluid !== false,
    interval_s: geheel(v.interval_s, 2, 30, ALARM_STANDAARD.interval_s),
    escalatie_min: geheel(v.escalatie_min, 1, 60, ALARM_STANDAARD.escalatie_min),
    mail_aan: v.mail_aan !== false,
    mail_naar: MAILBOX_RE.test(naar) ? naar : ALARM_STANDAARD.mail_naar,
    mail_stilte_min: geheel(v.mail_stilte_min, 5, 240, ALARM_STANDAARD.mail_stilte_min),
  };
}

/**
 * Valideer een wijziging uit de instellingenpagina. PUUR.
 * @returns {{ waarde: object, fouten: string[] }}
 */
export function valideerAlarmWijziging(huidig, wijziging) {
  const basis = leesAlarmInstellingen(huidig);
  const w = wijziging && typeof wijziging === 'object' ? wijziging : {};
  const fouten = [];
  const uit = { ...basis };
  if ('geluid' in w) uit.geluid = w.geluid === true;
  if ('mail_aan' in w) uit.mail_aan = w.mail_aan === true;
  const getal = (veld, min, max, label) => {
    if (!(veld in w)) return;
    const n = Number(w[veld]);
    if (!Number.isFinite(n) || n < min || n > max) fouten.push(`${label} moet tussen ${min} en ${max} liggen`);
    else uit[veld] = Math.round(n);
  };
  getal('interval_s', 2, 30, 'Het belinterval (seconden)');
  getal('escalatie_min', 1, 60, 'De escalatietijd (minuten)');
  getal('mail_stilte_min', 5, 240, 'De stilte voor een herhaalmail (minuten)');
  if ('mail_naar' in w) {
    const m = String(w.mail_naar || '').trim().toLowerCase();
    if (!MAILBOX_RE.test(m)) fouten.push('Het meldadres moet een @deforexopleiding.nl-adres zijn');
    else uit.mail_naar = m;
  }
  return { waarde: uit, fouten };
}

/** De eerste woorden van een bericht, op één regel. PUUR. */
export function eersteWoorden(tekst, max = 70) {
  const t = String(tekst == null ? '' : tekst).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const knip = t.slice(0, max);
  const spatie = knip.lastIndexOf(' ');
  return (spatie > max * 0.5 ? knip.slice(0, spatie) : knip).replace(/[\s,.;:!?-]+$/, '') + '…';
}

/** Laatste handeling van ons: antwoord van een medewerker of het oppakken. PUUR. */
export function laatsteVanOns(g) {
  const a = ms(g?.laatste_ons_bericht_op);
  const b = g?.toegewezen_aan ? ms(g?.toegewezen_op) : null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

/**
 * Staat dit gesprek op een antwoord van ons te wachten? PUUR.
 * Kijkt alleen naar de tijdstempels op het gesprek (zonder berichten).
 */
export function wachtOpOns(g, nu) {
  if (!g || g.status === 'afgehandeld') return false;
  const k = ms(g.laatste_klant_bericht_op);
  if (k == null) return false;
  const ons = laatsteVanOns(g);
  if (ons != null && k <= ons) return false;
  if (g.status !== 'wacht_op_ons' && nu - k > BOT_VENSTER_MIN * MIN) return false;
  return true;
}

/**
 * De alarmen voor één medewerker. PUUR.
 *
 * @param {object[]} gesprekken  rijen uit support_gesprekken
 * @param {object[]} klantBerichten  { gesprek_id, tekst, created_at } van de klant
 * @param {{ nu:number, userId:string|null, cfg:object }} opts
 * @returns {object[]} urgent eerst, dan het langst wachtende eerst
 */
export function alarmLijst(gesprekken, klantBerichten, { nu, userId = null, cfg = ALARM_STANDAARD } = {}) {
  const perGesprek = new Map();
  for (const b of klantBerichten || []) {
    if (!b || !b.gesprek_id) continue;
    if (!perGesprek.has(b.gesprek_id)) perGesprek.set(b.gesprek_id, []);
    perGesprek.get(b.gesprek_id).push(b);
  }
  const escalatieMs = (Number(cfg?.escalatie_min) || ALARM_STANDAARD.escalatie_min) * MIN;
  const uit = [];
  for (const g of gesprekken || []) {
    if (!wachtOpOns(g, nu)) continue;
    const ons = laatsteVanOns(g);
    // Het OUDSTE klantbericht sinds ons laatste woord: daar begint het wachten.
    // Een klant die elke minuut iets toevoegt, mag de escalatie niet uitstellen.
    const open = (perGesprek.get(g.id) || [])
      .filter((b) => { const t = ms(b.created_at); return t != null && (ons == null || t > ons); })
      .sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const sinds = open.length ? ms(open[0].created_at) : ms(g.laatste_klant_bericht_op);
    const urgent = nu - sinds >= escalatieMs;
    const voorMij = !!(userId && g.toegewezen_aan === userId);
    // Opgepakt door een collega: niet bij mij rinkelen — tenzij het escaleert.
    if (g.toegewezen_aan && !voorMij && !urgent) continue;
    uit.push({
      id: g.id,
      kenmerk: g.kenmerk || null,
      naam: g.naam || null,
      soort: g.soort || null,
      onderwerp: g.onderwerp || null,
      status: g.status,
      eerste_woorden: eersteWoorden(open.length ? open[0].tekst : '') || null,
      sinds: new Date(sinds).toISOString(),
      wacht_s: Math.max(0, Math.floor((nu - sinds) / 1000)),
      niveau: urgent ? 'urgent' : 'nieuw',
      toegewezen_aan: g.toegewezen_aan || null,
      voor_mij: voorMij,
      // Stabiel zolang het over hetzelfde onbeantwoorde stuk gaat: "Stil" en
      // "Beantwoorden" gelden voor deze sleutel (plus het niveau, client-side).
      sleutel: `${g.id}:${sinds}`,
    });
  }
  uit.sort((a, b) => (a.niveau === b.niveau ? b.wacht_s - a.wacht_s : (a.niveau === 'urgent' ? -1 : 1)));
  return uit;
}

/**
 * Moet het team nu een mail krijgen over dit gesprek? PUUR.
 * Aan te roepen NADAT een klantbericht is opgeslagen (of het gesprek net
 * begon), met de rij zoals die vóór dat bericht was — of erna, dat maakt voor
 * deze velden niet uit.
 *
 * @returns {'nieuw'|'opnieuw'|null}
 */
export function teamMailReden(g, { nu, cfg = ALARM_STANDAARD } = {}) {
  if (!g || !cfg?.mail_aan) return null;
  const stilte = (Number(cfg.mail_stilte_min) || ALARM_STANDAARD.mail_stilte_min) * MIN;
  const start = ms(g.created_at) ?? nu;
  const team = ms(g.team_gemaild_op);
  if (team == null && nu - start < NIEUW_VENSTER_MIN * MIN) return 'nieuw';
  const ons = laatsteVanOns(g) ?? start;
  if (nu - ons > stilte && (team == null || nu - team > stilte)) return 'opnieuw';
  return null;
}

/** Basisadres van het CRM, voor links in mails. */
export function crmBasis() {
  return String(process.env.PUBLIC_BASE_URL || 'https://crm.deforexopleiding.nl').replace(/\/+$/, '');
}

/** Pad naar één gesprek in de supportmodule (v2-shell). PUUR. */
export function crmGesprekPad(gesprekId) {
  return `/modules/klanten-v2/?v2preview=support&gesprek=${encodeURIComponent(gesprekId)}`;
}

/** Volledige deeplink naar één gesprek, voor mails. PUUR (op de env na). */
export function crmGesprekLink(gesprekId) {
  return crmBasis() + crmGesprekPad(gesprekId);
}

/** Een testgesprek herkennen we aan het +labtest-adres. PUUR. */
export function isTestGesprek(g) {
  return /\+labtest@/i.test(String(g?.email || ''));
}

/**
 * De teammail. PUUR: geeft { subject, text, html } terug.
 * Bewust GEEN kenmerk (SUP-…) in het onderwerp: cron-support-mail leest elke
 * mailbox op dat patroon, en deze mail hoort niet als klantantwoord terug in
 * het gesprek te belanden.
 */
export function bouwTeamMail({ gesprek, reden, eersteBericht, laatsteBericht, aantalOnbeantwoord = 0 }) {
  const g = gesprek || {};
  const naam = g.naam || 'Een bezoeker';
  const link = crmGesprekLink(g.id);
  const tel = g.telefoon ? (toonSupportTelefoon(g.telefoon) || g.telefoon) : null;
  const soortLabel = g.soort === 'klant'
    ? (g.customer_id ? 'Klant (gekoppeld aan klantdossier)' : 'Klant (nog niet geverifieerd)')
    : 'Bezoeker';
  const eerste = String(eersteBericht || '').trim();
  const laatste = String(laatsteBericht || '').trim();
  const test = isTestGesprek(g) ? '[TEST] ' : '';
  const subject = reden === 'opnieuw'
    ? `${test}Chat wacht op antwoord: ${naam} — ${eersteWoorden(laatste || eerste, 50)}`
    : `${test}Nieuwe chat: ${naam} — ${eersteWoorden(eerste, 50)}`;
  const titel = reden === 'opnieuw' ? 'Iemand wacht in de chat' : 'Iemand zit in de chat';
  const intro = reden === 'opnieuw'
    ? `${naam} schrijft opnieuw, en er reageerde al een tijd niemand van ons.`
      + (aantalOnbeantwoord > 1 ? ` Er staan ${aantalOnbeantwoord} berichten zonder antwoord.` : '')
    : `${naam} is een gesprek begonnen in de supportchat op de website.`;

  const rij = (label, waarde) => `<tr><td style="padding:5px 14px 5px 0;color:#586374;font-size:13px;vertical-align:top;white-space:nowrap">${label}</td>`
    + `<td style="padding:5px 0;font-size:14px;color:#10284A">${waarde}</td></tr>`;
  const e = escMailHtml;
  const tabel = '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 14px">'
    + rij('Naam', e(g.naam || '—'))
    + rij('E-mail', g.email ? `<a href="mailto:${e(g.email)}" style="color:#10284A">${e(g.email)}</a>` : '—')
    + rij('Gsm', g.telefoon ? `<a href="tel:${e(g.telefoon)}" style="color:#10284A;font-weight:700">${e(tel)}</a>` : '— geen nummer')
    + rij('Wie', e(soortLabel))
    + rij('Onderwerp', e(g.onderwerp || '—'))
    + rij('Pagina', g.bron_url ? `<a href="${e(g.bron_url)}" style="color:#10284A">${e(g.bron_url)}</a>` : '—')
    + rij('Kenmerk', e(g.kenmerk || '—'))
    + '</table>';
  const blok = (label, t) => `<p style="margin:0 0 6px;color:#586374;font-size:13px">${label}</p>`
    + `<p style="margin:0 0 14px;padding:12px 14px;background:#F2F4F7;border-radius:8px;white-space:pre-wrap">${e(String(t).slice(0, 1500))}</p>`;

  const html = renderMailShell({
    titel,
    inhoud_html: `<p style="margin:0 0 12px">${e(intro)}</p>${tabel}`
      + (eerste ? blok('Eerste bericht', eerste) : '')
      + (reden === 'opnieuw' && laatste && laatste !== eerste ? blok('Nieuwste bericht', laatste) : ''),
    cta: { label: 'Open gesprek in CRM', url: link },
    voetnoot: 'Deze melding gaat naar het team bij elk nieuw chatgesprek, en opnieuw als een klant schrijft terwijl er al een tijd niemand van ons reageerde.',
  });
  const text = platteTekstMail({
    titel,
    inhoud_tekst: [
      intro, '',
      `Naam: ${g.naam || '—'}`,
      `E-mail: ${g.email || '—'}`,
      `Gsm: ${g.telefoon ? `${tel} (tel:${g.telefoon})` : '— geen nummer'}`,
      `Wie: ${soortLabel}`,
      `Onderwerp: ${g.onderwerp || '—'}`,
      `Pagina: ${g.bron_url || '—'}`,
      `Kenmerk: ${g.kenmerk || '—'}`,
      '',
      eerste ? `Eerste bericht:\n${eerste.slice(0, 1500)}` : '',
      reden === 'opnieuw' && laatste && laatste !== eerste ? `\nNieuwste bericht:\n${laatste.slice(0, 1500)}` : '',
    ].join('\n'),
    cta: { label: 'Open gesprek in CRM', url: link },
  });
  return { subject, text, html };
}

// ── met database ───────────────────────────────────────────────────────────

/** De alarminstellingen uit app_settings (fail-soft: standaard bij een fout). */
export async function haalAlarmInstellingen() {
  try {
    const { data } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', APP_SETTINGS_KEY).maybeSingle();
    return leesAlarmInstellingen(data?.value);
  } catch (e) {
    console.warn('[support-alarm] instellingen lezen mislukt, standaard gebruikt:', e?.message || e);
    return leesAlarmInstellingen(null);
  }
}

const GESPREK_VELDEN = 'id, kenmerk, soort, onderwerp, status, naam, email, telefoon, customer_id, '
  + 'toegewezen_aan, toegewezen_op, laatste_klant_bericht_op, laatste_ons_bericht_op, '
  + 'bron_url, created_at, team_gemaild_op';

/**
 * Mail het team als dat nu moet. Idempotent en race-vrij: de mail wordt eerst
 * geclaimd met een voorwaardelijke update op team_gemaild_op; wie de claim
 * niet krijgt, mailt niet. Mislukt het versturen, dan gaat de claim terug,
 * zodat het volgende klantbericht of de cron het opnieuw probeert.
 *
 * Gooit nooit: de chat van de bezoeker mag hier niet op stuklopen.
 *
 * @param {{ gesprekId:string, nu?:number, cfg?:object }} p
 * @returns {Promise<{ verstuurd:boolean, reden:string|null, fout?:string }>}
 */
export async function meldTeam({ gesprekId, nu = Date.now(), cfg = null, alleenNieuw = false }) {
  try {
    const instellingen = cfg || await haalAlarmInstellingen();
    const { data: g, error } = await supabaseAdmin
      .from('support_gesprekken').select(GESPREK_VELDEN).eq('id', gesprekId).maybeSingle();
    if (error || !g) return { verstuurd: false, reden: null, fout: error?.message || 'gesprek niet gevonden' };

    // alleenNieuw: het vangnet in de cron. Een gesprek dat nooit een teammail
    // kreeg (versturen mislukte, of de functie werd afgekapt) krijgt alsnog de
    // "nieuwe chat"-mail, ook als het al ouder is dan NIEUW_VENSTER_MIN.
    const reden = alleenNieuw
      ? (instellingen.mail_aan && !g.team_gemaild_op ? 'nieuw' : null)
      : teamMailReden(g, { nu, cfg: instellingen });
    if (!reden) return { verstuurd: false, reden: null };

    const claimOp = new Date(nu).toISOString();
    let claim = supabaseAdmin.from('support_gesprekken').update({ team_gemaild_op: claimOp }).eq('id', g.id);
    claim = g.team_gemaild_op ? claim.eq('team_gemaild_op', g.team_gemaild_op) : claim.is('team_gemaild_op', null);
    const { data: geclaimd, error: claimFout } = await claim.select('id');
    if (claimFout) return { verstuurd: false, reden, fout: claimFout.message };
    if (!geclaimd || !geclaimd.length) return { verstuurd: false, reden: null };   // een ander verzoek was ons voor

    const { data: berichten } = await supabaseAdmin
      .from('support_berichten')
      .select('tekst, created_at')
      .eq('gesprek_id', g.id)
      .eq('afzender', 'klant')
      .order('created_at', { ascending: true })
      .limit(200);
    const lijst = berichten || [];
    const ons = laatsteVanOns(g);
    const onbeantwoord = lijst.filter((b) => ons == null || (ms(b.created_at) ?? 0) > ons);

    const mail = bouwTeamMail({
      gesprek: g,
      reden,
      eersteBericht: lijst[0]?.tekst || '',
      laatsteBericht: lijst[lijst.length - 1]?.tekst || '',
      aantalOnbeantwoord: onbeantwoord.length,
    });
    const r = await sendEmailViaSmtp({
      fromMailbox: 'info@deforexopleiding.nl',
      to: instellingen.mail_naar,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    if (!r?.ok) {
      // Claim terug, alleen als niemand er intussen iets anders van maakte.
      await supabaseAdmin.from('support_gesprekken')
        .update({ team_gemaild_op: g.team_gemaild_op || null })
        .eq('id', g.id).eq('team_gemaild_op', claimOp);
      console.error('[support-alarm] teammail mislukt:', g.kenmerk, r?.reason || 'onbekend');
      return { verstuurd: false, reden, fout: r?.reason || 'versturen mislukt' };
    }
    return { verstuurd: true, reden };
  } catch (e) {
    console.error('[support-alarm] teammail mislukt:', e?.message || e);
    return { verstuurd: false, reden: null, fout: e?.message || String(e) };
  }
}

/**
 * Laat een belofte afmaken nadat het antwoord al weg is (Vercel waitUntil).
 * Buiten Vercel draait de belofte gewoon door; gaat ze toch verloren, dan
 * pikt cron-support-opvolging een gemiste "nieuwe chat"-mail op.
 */
export function inAchtergrond(belofte) {
  try { waitUntil(belofte); } catch (e) {
    console.warn('[support-alarm] waitUntil niet beschikbaar:', e?.message || e);
  }
  return belofte;
}
