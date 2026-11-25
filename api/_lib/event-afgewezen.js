// api/_lib/event-afgewezen.js
//
// Lijst van de AFGEWEZEN event-aanmelders (Events › Inschrijvingen › Afgewezen,
// en de klik op "X afgewezen" in de dashboardtegel Event-aanmeldingen).
//
// Wie erin staat = exact wie de tegel telt: afgewezenEventMails() uit
// aanmeldingen-per-funnel.js (inzending 'afgewezen' in het venster, zonder
// toegelaten inzending of echte aanmelding in hetzelfde venster, geen test).
// Eén rij per persoon (e-mail); de jongste afgewezen inzending is leidend,
// eerdere pogingen gaan mee in `eerdere`.
//
// Reden = wat de opgeslagen inzending zelf zegt (de snapshot op het moment van
// invullen, niet de huidige vragenlijst): de knock-out-antwoorden
// (antwoorden[].afwijzer) en/of "onder de drempel" (score < drempel).
// Pure functies, geen IO.

import { afgewezenEventMails } from './aanmeldingen-per-funnel.js';

const mail = (e) => String(e || '').trim().toLowerCase();

/** Knock-outs + drempel van één opgeslagen inzending. */
export function redenVanInzending(s) {
  const antwoorden = Array.isArray(s && s.antwoorden) ? s.antwoorden : [];
  const knockouts = antwoorden
    .filter((a) => a && a.afwijzer === true)
    .map((a) => ({ vraag: String(a.vraag || ''), antwoord: String(a.gekozen_label || '') }));
  const getal = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const score = getal(s && s.score);
  const drempel = getal(s && s.drempel);
  const onderDrempel = score != null && drempel != null && score < drempel;
  return { knockouts, onder_drempel: onderDrempel, score, drempel };
}

/** 'event-3' → 'Event-3'; leeg → 'Sitepagina' (de sitepagina stuurt geen bron mee). */
export function bronLabel(bron) {
  const b = String(bron || '').trim();
  if (!b) return 'Sitepagina';
  const m = /^event-(\d+)$/i.exec(b);
  return m ? 'Event-' + m[1] : b;
}

/** Telefoon (E.164 uit de submit) → cijfers voor wa.me, anders null. */
export function whatsappCijfers(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  return d.length >= 9 ? d : null;
}

/**
 * @param {object} p
 * @param {Array} p.eventAanmeldingen { email, status, is_test }             — venster
 * @param {Array} p.eventInzendingen  { id, created_at, event_id, naam, email, telefoon,
 *                                      bron, score, drempel, resultaat, antwoorden } — venster
 * @param {Array} [p.events]          { id, title, starts_at }
 * @returns {Array} rijen, nieuwste eerst
 */
export function bouwAfgewezenLijst({ eventAanmeldingen = [], eventInzendingen = [], events = [] } = {}) {
  const wie = afgewezenEventMails({ eventAanmeldingen, eventInzendingen });
  const evMap = new Map((events || []).filter(Boolean).map((e) => [e.id, e]));
  const perMail = new Map();
  for (const s of eventInzendingen || []) {
    const m = mail(s && s.email);
    if (!wie.has(m) || String(s.resultaat || '').trim().toLowerCase() !== 'afgewezen') continue;
    if (!perMail.has(m)) perMail.set(m, []);
    perMail.get(m).push(s);
  }
  const rijen = [];
  for (const [m, lijst] of perMail) {
    lijst.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const s = lijst[0];
    const eerst = (veld) => { for (const x of lijst) if (x[veld]) return x[veld]; return null; };
    const ev = s.event_id ? evMap.get(s.event_id) : null;
    const telefoon = eerst('telefoon');
    rijen.push({
      id: s.id,
      email: m,
      naam: eerst('naam'),
      telefoon,
      whatsapp: whatsappCijfers(telefoon),
      op: s.created_at,
      bron: s.bron || null,
      bron_label: bronLabel(s.bron),
      event: ev ? { id: ev.id, title: ev.title || null, starts_at: ev.starts_at || null } : (s.event_id ? { id: s.event_id, title: null, starts_at: null } : null),
      ...redenVanInzending(s),
      pogingen: lijst.length,
      eerdere: lijst.slice(1).map((x) => ({ op: x.created_at, bron_label: bronLabel(x.bron), ...redenVanInzending(x) })),
    });
  }
  rijen.sort((a, b) => String(b.op || '').localeCompare(String(a.op || '')));
  return rijen;
}

/** Samenvatting voor de kop van de lijst. */
export function vatSamen(rijen) {
  const perReden = new Map();
  const perBron = new Map();
  let onderDrempel = 0;
  let alleenDrempel = 0;
  for (const r of rijen || []) {
    for (const k of r.knockouts || []) {
      const sleutel = k.vraag + ' → ' + k.antwoord;
      perReden.set(sleutel, (perReden.get(sleutel) || 0) + 1);
    }
    if (r.onder_drempel) onderDrempel += 1;
    if (r.onder_drempel && !(r.knockouts || []).length) alleenDrempel += 1;
    perBron.set(r.bron_label, (perBron.get(r.bron_label) || 0) + 1);
  }
  const sorteer = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, aantal]) => ({ label, aantal }));
  return { totaal: (rijen || []).length, knockouts: sorteer(perReden), onder_drempel: onderDrempel, alleen_drempel: alleenDrempel, per_bron: sorteer(perBron) };
}
