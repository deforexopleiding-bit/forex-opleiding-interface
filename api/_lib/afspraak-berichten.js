// api/_lib/afspraak-berichten.js
//
// Bericht-definities voor de afspraak-flow: per moment de WhatsApp-template
// (naam + positionele vars) én de e-mail (subject/text/html via de branded
// mailshell). Plus formatting-helpers en de welkom-lijn-resolver.
//
// De 5 momenten en hun WA-templates (LIVE, goedgekeurd bij Meta):
//   bevestiging → afspraak_bevestiging_v1  [voornaam, moment, zoom, self]
//   r24         → afspraak_reminder_24u_v1  [voornaam, moment, zoom, self]
//   r2          → afspraak_reminder_2u_v1   [voornaam, tijd]           (+quick-reply)
//   r30         → afspraak_reminder_30m_v1  [voornaam, tijd, zoom]     (+quick-reply)
//   zoom5       → afspraak_zoom_5min_v1     [voornaam, zoom]
//
// Quick-reply-knoppen ("Ik ben erbij") zitten in de goedgekeurde template zelf
// en hebben geen runtime-parameters — sendTemplate hoeft ze niet mee te geven.
//
// LET OP: alle vijf goedgekeurde templates zeggen letterlijk
// "kennismakingsgesprek". Ook de strategie-scan (webinar/strategiescan) en The
// Lab gebruiken ze voorlopig; alleen de MAILS hebben een eigen variant.
//
// Varianten per booking_source (één keuze: `varianteVoor`):
//   · 'the-lab'                 → labVariant  (strategiesessie, 30 min)
//   · 'webinar' / 'strategiescan' → scanVariant (strategie-scan, 20 min, ons team)
//   · al de rest                → de standaardtekst in MOMENTEN (kennismakingsgesprek)
// Elke bevestigingsmail draagt een .ics (de Google-uitnodiging vanuit GHL staat
// sinds 2 nov 2026 uit op de afsprakenkalender, dus dit is het agenda-item).

import { supabaseAdmin } from '../supabase.js';
import { renderAfspraakMail, platteTekstAfspraak } from './mail-shell-afspraak.js';
import { maakIcs } from './ics.js';

export const MIN = 60 * 1000;
export const UUR = 60 * MIN;

const SELFSERVICE_BASE = (process.env.AFSPRAAK_SELFSERVICE_BASE || 'https://deforexopleiding.nl').replace(/\/+$/, '');

// ── Welkom-lijn (zelfde nummer als de toegang-flow, zodat replies in dezelfde
//    inbox landen). Losse kopie zodat cron-toegang-aanvragen.js ongemoeid blijft.
export async function resolveWelkomPhoneId() {
  try {
    const { data } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'leadsonderhoud')
      .eq('is_active', true)
      .maybeSingle();
    if (data?.phone_number_id) return String(data.phone_number_id).trim();
  } catch (e) {
    console.warn('[afspraak-berichten] welkom-phone lookup (soft):', e?.message || e);
  }
  return process.env.WELKOM_WHATSAPP_PHONE_NUMBER_ID || null;
}

// ── Formatting ─────────────────────────────────────────────────────────────
export function voornaamVan(leadName) {
  const eerste = String(leadName || '').trim().split(/\s+/)[0];
  return eerste || 'daar';
}
export function fmtMomentNL(scheduledAt) {
  const d = new Date(scheduledAt);
  const dag = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long',
  }).format(d);
  return `${dag} om ${fmtTijdNL(scheduledAt)}`;
}
export function fmtTijdNL(scheduledAt) {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(scheduledAt));
}
export function selfServiceUrl(token) {
  return `${SELFSERVICE_BASE}/afspraak/${encodeURIComponent(token)}`;
}

// Context die elke bericht-builder krijgt.
export function bouwContext(appt) {
  return {
    voornaam: voornaamVan(appt.lead_name),
    momentNL: fmtMomentNL(appt.scheduled_at),
    tijdNL:   fmtTijdNL(appt.scheduled_at),
    zoom:     appt.zoom_join_url || '',
    selfUrl:  appt.afspraak_token ? selfServiceUrl(appt.afspraak_token) : SELFSERVICE_BASE,
    // The Lab: wie de sessie geeft (gezet door de cron uit _lib/lab-gastheer.js).
    gastheer: appt.gastheer_voornaam || null,
  };
}

// ── THE LAB ────────────────────────────────────────────────────────────────
// Een boeking vanuit The Lab (booking_source 'the-lab') is geen
// kennismakingsgesprek maar de STRATEGIESESSIE van 30 minuten met Dave. Zelfde
// momenten, eigen teksten:
//   · de bevestiging zegt wat we bespreken en draagt een .ics-uitnodiging;
//   · de korte herinnering valt 1 uur vooraf (niet 2) en gaat alleen per mail —
//     de goedgekeurde WhatsApp-template zegt "over 2 uur". Voor WhatsApp staan
//     de Lab-templates klaar in docs/whatsapp-templates-the-lab.md;
//   · elke mail draagt de link om te verzetten (de self-service-pagina).
export const LAB_BRON = 'the-lab';
export const LAB_DUUR_MIN = 30;
export function isLabAfspraak(a) { return String(a?.booking_source || '') === LAB_BRON; }

export const LAB_BESPREKEN = [
  'je resultaat uit The Lab: wat ging goed, waar liep je vast',
  'je doel met trading en hoeveel tijd je er echt voor hebt',
  'of trading bij je past, en zo ja: welke route daarbij hoort',
];

function metWie(c) { return c.gastheer ? `met ${c.gastheer}` : 'met ons team'; }
function besprekenHtml() {
  return '<br><br><b>Wat we bespreken:</b><br>' + LAB_BESPREKEN.map((x) => '• ' + x).join('<br>');
}

/** De .ics bij de bevestiging. PURE. */
export function labIcsBijlage(a, c) {
  const titel = `Strategiesessie ${metWie(c)} — De Forex Opleiding`;
  const beschrijving = [
    `Dertig minuten ${metWie(c)}.`,
    'Wat we bespreken:', ...LAB_BESPREKEN.map((x) => '- ' + x),
    c.zoom ? `Deelnemen: ${c.zoom}` : 'De Zoom-link staat in je bevestigingsmail.',
    `Verzetten: ${c.selfUrl}`,
  ].join('\n');
  return {
    filename: 'strategiesessie.ics',
    contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
    content: maakIcs({ uid: a.id || a.afspraak_token || a.scheduled_at, start: a.scheduled_at, duurMin: LAB_DUUR_MIN, titel, beschrijving, locatie: c.zoom || 'Zoom', url: c.zoom || c.selfUrl }),
  };
}

const LAB_MAIL = {
  bevestiging: (a, c) => ({
    subject: `Je strategiesessie ${metWie(c)} staat vast`,
    titel: 'Je strategiesessie staat vast ✅',
    inleiding: `Hoi ${c.voornaam}, top. Je strategiesessie van 30 minuten ${metWie(c)} staat gepland. De uitnodiging voor je agenda zit in de bijlage.${besprekenHtml()}`,
    details: [{ label: 'Wanneer', waarde: c.momentNL }, { label: 'Duur', waarde: '30 minuten' }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
  }),
  r24: (a, c) => ({
    subject: `Morgen: je strategiesessie ${metWie(c)}`,
    titel: 'Morgen is het zover',
    inleiding: `Hoi ${c.voornaam}, morgen spreek je ${c.gastheer || 'ons team'} — 30 minuten, via Zoom. Neem je resultaat uit The Lab erbij en denk even na over één vraag: wat wil je over een jaar met trading bereikt hebben?`,
    details: [{ label: 'Wanneer', waarde: c.momentNL }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
  }),
  r2: (a, c) => ({
    subject: `Over een uur: je strategiesessie ${metWie(c)}`,
    titel: 'Over een uur is het zover',
    inleiding: `Hoi ${c.voornaam}, om ${c.tijdNL} start je strategiesessie ${metWie(c)}. Zit je er een paar minuten vroeger klaar voor? Een rustige plek en je laptop of gsm volstaan.`,
    details: [{ label: 'Wanneer', waarde: `Vandaag om ${c.tijdNL}` }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
  }),
  r30: (a, c) => ({
    subject: 'Over 30 minuten begint je strategiesessie',
    titel: 'Over 30 minuten begint je sessie',
    inleiding: `Hoi ${c.voornaam}, over 30 minuten (${c.tijdNL}) begint je strategiesessie ${metWie(c)}. We houden je plek graag vrij — laat je even weten of het lukt?`,
    details: [{ label: 'Waar', waarde: zoomDetail(c.zoom) }],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
  }),
  zoom5: (a, c) => ({
    subject: 'We beginnen zo — je strategiesessie',
    titel: 'We beginnen zo! ⏱️',
    inleiding: `Hoi ${c.voornaam}, over ongeveer 5 minuten start je strategiesessie ${metWie(c)}. Klik hieronder om te joinen.`,
    cta: c.zoom ? { label: 'Nu deelnemen', url: c.zoom } : null,
    voetnoot: 'Lukt het inloggen niet meteen? Stuur ons even een berichtje, dan helpen we je er zo doorheen.',
  }),
};

/** De Lab-variant van een moment (mail + of er WhatsApp mag). PURE. */
export function labVariant(key, a, c) {
  const bouw = LAB_MAIL[key];
  if (!bouw) return null;
  const args = bouw(a, c);
  if (key !== 'zoom5' && key !== 'r30') args.voetnoot = selfServiceVoetnoot(a, c);
  const mail = bouwMail(args);
  if (key === 'bevestiging') mail.attachments = [labIcsBijlage(a, c)];
  return { mail, whatsapp: key !== 'r2' };
}

// ── STRATEGIE-SCAN (webinar + strategiescan) ──────────────────────────────
// Wie via het webinar (QR → /agenda/webinar) of de scan-landingspagina boekt,
// boekt een STRATEGIE-SCAN: 20 minuten via Zoom met ons team (bewust geen naam:
// de scan gebeurt met het team, niet per se met Dave). Zelfde momenten en
// timing als de standaard; WhatsApp blijft de goedgekeurde templates gebruiken.
export const SCAN_BRONNEN = ['webinar', 'strategiescan'];
export const SCAN_DUUR = 20;
export function isScanAfspraak(a) {
  return SCAN_BRONNEN.includes(String(a?.booking_source || '').trim().toLowerCase());
}

export const SCAN_BEKIJKEN = [
  ['Je tradet al', 'dan doen we een audit van je tradeplan, je journal en je strategie.'],
  ['Je tradet nog niet', 'dan bekijken we of trading in je dagelijks leven past.'],
];
const SCAN_ACTIEPLAN = 'Je gaat weg met een concreet actieplan.';

function scanBekijkenHtml() {
  return '<br><br><b>Wat we bekijken:</b><br>'
    + SCAN_BEKIJKEN.map(([wie, wat]) => `• <b>${wie}?</b> ${wat}`).join('<br>')
    + `<br><br>${SCAN_ACTIEPLAN}`;
}

const SCAN_MAIL = {
  bevestiging: (a, c) => ({
    subject: 'Je strategie-scan staat gepland',
    titel: 'Je strategie-scan staat gepland ✅',
    inleiding: `Hoi ${c.voornaam}, gelukt! Je gratis strategie-scan staat gepland: 20 minuten via Zoom met ons team. De uitnodiging voor je agenda zit in de bijlage.${scanBekijkenHtml()}`,
    details: [{ label: 'Wanneer', waarde: c.momentNL }, { label: 'Duur', waarde: '20 minuten' }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
  }),
  r24: (a, c) => ({
    subject: 'Herinnering: morgen je strategie-scan',
    titel: 'Tot morgen! 🙌',
    inleiding: `Hoi ${c.voornaam}, nog even een vriendelijke herinnering: morgen staat je strategie-scan met ons team gepland. 20 minuten via Zoom. Trade je al? Houd dan je tradeplan en je journal bij de hand.`,
    details: [{ label: 'Wanneer', waarde: c.momentNL }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
  }),
  r2: (a, c) => ({
    subject: 'Over 2 uur: je strategie-scan',
    titel: 'Over 2 uur is het zover 🎯',
    inleiding: `Hoi ${c.voornaam}, over 2 uur (om ${c.tijdNL}) start je strategie-scan met ons team. Zit je er een paar minuten vroeger klaar voor? Een rustige plek en je laptop of gsm volstaan.`,
    details: [{ label: 'Wanneer', waarde: `Vandaag om ${c.tijdNL}` }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
  }),
  r30: (a, c) => ({
    subject: 'Over 30 minuten begint je strategie-scan',
    titel: 'Over 30 minuten begint je scan',
    inleiding: `Hoi ${c.voornaam}, over 30 minuten (${c.tijdNL}) begint je strategie-scan en we houden je plek graag vrij. Laat je ons even weten of het je lukt?`,
    details: [{ label: 'Waar', waarde: zoomDetail(c.zoom) }],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
  }),
  zoom5: (a, c) => ({
    subject: 'We beginnen zo — join je strategie-scan',
    titel: 'We beginnen zo! ⏱️',
    inleiding: `Hoi ${c.voornaam}, over ongeveer 5 minuten start je strategie-scan. Klik hieronder om direct te joinen.`,
    cta: c.zoom ? { label: 'Nu deelnemen', url: c.zoom } : null,
    voetnoot: 'Lukt het inloggen niet meteen? Stuur ons even een berichtje, dan helpen we je er zo doorheen.',
  }),
};

/** De .ics bij de bevestiging van een strategie-scan. PURE. */
export function scanIcsBijlage(a, c) {
  return afspraakIcsBijlage(a, c, {
    filename: 'strategie-scan.ics',
    titel: 'Strategie-scan — De Forex Opleiding',
    duurMin: SCAN_DUUR,
    regels: [
      '20 minuten via Zoom met ons team van De Forex Opleiding.',
      'Wat we bekijken:', ...SCAN_BEKIJKEN.map(([wie, wat]) => `- ${wie}? ${wat}`),
      SCAN_ACTIEPLAN,
    ],
  });
}

/** De scan-variant van een moment (mail + of er WhatsApp mag). PURE. */
export function scanVariant(key, a, c) {
  const bouw = SCAN_MAIL[key];
  if (!bouw) return null;
  const args = bouw(a, c);
  if (key !== 'zoom5' && key !== 'r30') args.voetnoot = selfServiceVoetnoot(a, c);
  const mail = bouwMail(args);
  if (key === 'bevestiging') mail.attachments = [scanIcsBijlage(a, c)];
  // WhatsApp: de goedgekeurde algemene templates (zeggen "kennismakingsgesprek").
  return { mail, whatsapp: true };
}

/**
 * De variant voor deze afspraak, of null voor de standaardtekst. Eén plek
 * voor de keuze, zodat cron en testsend hetzelfde kiezen. PURE.
 */
export function varianteVoor(key, a, c) {
  if (isLabAfspraak(a)) return labVariant(key, a, c);
  if (isScanAfspraak(a)) return scanVariant(key, a, c);
  return null;
}

// ── .ics voor elke bevestiging ─────────────────────────────────────────────
// Naam = De Forex Opleiding (in de titel). Bewust GEEN ORGANIZER: een
// persoonlijk adres hoort er niet in, en met een organizer behandelen sommige
// agenda's de bijlage als uitnodiging waarop je moet antwoorden.
export const STANDAARD_DUUR = 20; // "ongeveer 20 minuten" in de standaardtekst

/** Generieke .ics-bijlage. PURE. */
export function afspraakIcsBijlage(a, c, { filename, titel, duurMin, regels = [] }) {
  const beschrijving = [
    ...regels,
    c.zoom ? `Deelnemen: ${c.zoom}` : 'De Zoom-link staat in je bevestigingsmail.',
    `Verzetten of annuleren: ${c.selfUrl}`,
  ].join('\n');
  return {
    filename,
    contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
    content: maakIcs({ uid: a.id || a.afspraak_token || a.scheduled_at, start: a.scheduled_at, duurMin, titel, beschrijving, locatie: c.zoom || 'Zoom', url: c.zoom || c.selfUrl }),
  };
}

/** De .ics bij de standaardbevestiging (kennismakingsgesprek). PURE. */
export function standaardIcsBijlage(a, c) {
  return afspraakIcsBijlage(a, c, {
    filename: 'kennismakingsgesprek.ics',
    titel: 'Kennismakingsgesprek — De Forex Opleiding',
    duurMin: STANDAARD_DUUR,
    regels: ['Kennismakingsgesprek via Zoom met De Forex Opleiding.'],
  });
}

function zoomDetail(zoom) {
  return zoom
    ? `<a href="${zoom}" style="color:#10284A">Deelnemen via Zoom</a>`
    : 'Via Zoom';
}
function bouwMail(args) {
  return {
    subject: args.subject,
    html:    renderAfspraakMail(args),
    text:    platteTekstAfspraak(args),
  };
}

// Self-service-voetnoot, afgestemd op de nieuwe regels:
//   • > 2 uur vóór de afspraak: verzetten óf annuleren mag (we vragen kort een reden).
//   • ≤ 2 uur vóór de afspraak: annuleren kan niet meer — alleen verzetten (met reden).
// De pagina /afspraak/<token> is en blijft de bron van waarheid; deze tekst volgt
// alleen de situatie op het moment van versturen.
function selfServiceVoetnoot(appt, c) {
  const binnen2u = new Date(appt.scheduled_at).getTime() - Date.now() <= 2 * UUR;
  if (binnen2u) {
    return `Komt het nu echt niet uit? Je kunt je afspraak nog <a href="${c.selfUrl}" style="color:#10284A">verzetten naar een ander moment</a> — we vragen je daarbij kort om een reden. Annuleren kan binnen 2 uur voor de afspraak niet meer.`;
  }
  return `Kan het onverhoopt niet doorgaan? Je kunt je afspraak <a href="${c.selfUrl}" style="color:#10284A">verzetten of annuleren</a> — we vragen je daarbij kort om een reden.`;
}

// ── De 5 momenten ──────────────────────────────────────────────────────────
// match(appt, nowMs) bepaalt of dit moment nú van toepassing is. Er is geen
// nacht-guard meer (verwijderd 2026-09-10, analoog aan cron-toegang-aanvragen
// #1557): late boekingen kregen anders pas de ochtend erna hun bevestiging.
// De bevestiging heeft nog wel `vereistZoom: true` — geen Zoom-link →
// geen bevestiging, ongeacht tijd.
export const MOMENTEN = [
  {
    key: 'bevestiging',
    kolom: 'bevestiging_sent_at',
    vereistZoom: true,               // pas versturen zodra de Zoom-link binnen is
    match: (a, nowMs) => !a.bevestiging_sent_at && !!a.zoom_join_url && new Date(a.scheduled_at).getTime() > nowMs,
    waTemplate: 'afspraak_bevestiging_v1',
    waVars: (a, c) => [c.voornaam, c.momentNL, c.zoom, c.selfUrl],
    mail: (a, c) => ({
      ...bouwMail({
        subject: 'Je kennismakingsgesprek staat gepland',
        titel: 'Je kennismakingsgesprek staat gepland ✅',
        inleiding: `Hoi ${c.voornaam}, gelukt! Je kennismakingsgesprek met De Forex Opleiding staat gepland. In ongeveer 20 minuten kijken we samen naar jouw situatie en je doelen, en maken we een persoonlijk plan. Geen verplichtingen.`,
        details: [{ label: 'Wanneer', waarde: c.momentNL }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
        cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
        voetnoot: selfServiceVoetnoot(a, c),
      }),
      // Agenda-item: de Google-uitnodiging uit GHL staat uit.
      attachments: [standaardIcsBijlage(a, c)],
    }),
  },
  {
    key: 'r24',
    kolom: 'reminder_24u_at',
    venster: { onder: 2 * UUR, boven: 24 * UUR },
    match: (a, nowMs) => { const t = new Date(a.scheduled_at).getTime() - nowMs; return !a.reminder_24u_at && t > 2 * UUR && t <= 24 * UUR; },
    waTemplate: 'afspraak_reminder_24u_v1',
    waVars: (a, c) => [c.voornaam, c.momentNL, c.zoom, c.selfUrl],
    mail: (a, c) => bouwMail({
      subject: 'Herinnering: morgen je kennismakingsgesprek',
      titel: 'Tot morgen! 🙌',
      inleiding: `Hoi ${c.voornaam}, nog even een vriendelijke herinnering: morgen staat je kennismakingsgesprek met De Forex Opleiding gepland. Zorg dat je er een paar minuten van tevoren klaar voor zit.`,
      details: [{ label: 'Wanneer', waarde: c.momentNL }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
      cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
      voetnoot: selfServiceVoetnoot(a, c),
    }),
  },
  {
    key: 'r2',
    kolom: 'reminder_2u_at',
    venster: { onder: 30 * MIN, boven: 2 * UUR },
    // The Lab: 1 uur vooraf in plaats van 2 (zie labVariant).
    match: (a, nowMs) => { const t = new Date(a.scheduled_at).getTime() - nowMs; return !a.reminder_2u_at && t > 30 * MIN && t <= (isLabAfspraak(a) ? UUR : 2 * UUR); },
    waTemplate: 'afspraak_reminder_2u_v1',
    waVars: (a, c) => [c.voornaam, c.tijdNL],
    mail: (a, c) => bouwMail({
      subject: 'Over 2 uur: je kennismakingsgesprek',
      titel: 'Over 2 uur is het zover 🎯',
      inleiding: `Hoi ${c.voornaam}, over 2 uur (om ${c.tijdNL}) start je kennismakingsgesprek met De Forex Opleiding. We hebben speciaal tijd voor jou vrijgemaakt.`,
      details: [{ label: 'Wanneer', waarde: `Vandaag om ${c.tijdNL}` }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
      cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
      voetnoot: selfServiceVoetnoot(a, c),
    }),
  },
  {
    key: 'r30',
    kolom: 'reminder_30m_at',
    alleenOnbevestigd: true,          // 30m alleen als lead nog niet bevestigd heeft
    venster: { onder: 5 * MIN, boven: 30 * MIN },
    match: (a, nowMs) => { const t = new Date(a.scheduled_at).getTime() - nowMs; return !a.reminder_30m_at && !a.bevestigd_at && t > 5 * MIN && t <= 30 * MIN; },
    waTemplate: 'afspraak_reminder_30m_v1',
    waVars: (a, c) => [c.voornaam, c.tijdNL, c.zoom],
    mail: (a, c) => bouwMail({
      subject: 'Over 30 minuten begint je kennismakingsgesprek',
      titel: 'Over 30 minuten begint je gesprek',
      inleiding: `Hoi ${c.voornaam}, over 30 minuten (${c.tijdNL}) begint je kennismakingsgesprek en we houden je plek graag vrij. Laat je ons even weten of het je lukt?`,
      details: [{ label: 'Waar', waarde: zoomDetail(c.zoom) }],
      cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
    }),
  },
  {
    key: 'zoom5',
    kolom: 'zoom_5min_at',
    venster: { onder: 0, boven: 5 * MIN },
    match: (a, nowMs) => { const t = new Date(a.scheduled_at).getTime() - nowMs; return !a.zoom_5min_at && t > 0 && t <= 5 * MIN; },
    waTemplate: 'afspraak_zoom_5min_v1',
    waVars: (a, c) => [c.voornaam, c.zoom],
    mail: (a, c) => bouwMail({
      subject: 'We beginnen zo — join je kennismakingsgesprek',
      titel: 'We beginnen zo! ⏱️',
      inleiding: `Hoi ${c.voornaam}, over ongeveer 5 minuten start je kennismakingsgesprek. Klik hieronder om direct te joinen.`,
      cta: c.zoom ? { label: 'Nu deelnemen', url: c.zoom } : null,
      voetnoot: 'Lukt het inloggen niet meteen? Stuur ons even een berichtje, dan helpen we je er zo doorheen.',
    }),
  },
];
