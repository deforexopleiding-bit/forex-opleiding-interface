// api/_lib/ghl-import.js
//
// GHL-import (2026-10-26) — oude GHL-contacten als leads, in weekbatches voor de
// webinar-uitnodigingen. PURE: lezen, controleren, ontdubbelen en de rijen
// opbouwen. De endpoint (api/leads-import-ghl.js) leest de bestaande leads en
// schrijft.
//
// Twee bestanden:
//   soort 'mail'     — ghl-import-mailbaar.csv: batch, voornaam, achternaam, email,
//                      telefoon (E.164), tag, created → bron 'Import'
//   soort 'telefoon' — ghl-import-telefoon-only.csv: zelfde kolommen zonder e-mail
//                      → bron 'Import-telefoon' (voor later WhatsApp/SMS)
//
// Regels:
//   · GEEN traject → buiten de funnelcijfers, de tegels, de belpot en de
//     welkom-wachtrij. Soort 'onbekend', toestemming false, geen
//     advertentie_toestemming; de import gaat niet via een website-route, dus
//     er gaat niets naar Meta (geen pixel, geen CAPI).
//   · Ontdubbelen: bestaat het e-mailadres (of bij telefoon-only het nummer) al →
//     overslaan en tellen, NOOIT overschrijven. Ook binnen het bestand één keer.
//   · Sorteerdatum: `aangemaakt` = vóór de oudste lead in het CRM (min 1 dag),
//     dan één seconde per rij, nieuwste GHL-datum bovenaan → de import staat bij
//     nieuw → oud ALTIJD achteraan, met behoud van de onderlinge volgorde. De
//     echte datum staat in ghl_created. `laatste_aanmelding` = dezelfde oude datum
//     (anders telt het TV-bord ze als heraanmelding van vandaag).

import { splitsRegel } from './opvolging-leads-import.js';

export const BRON_MAIL = 'Import';
export const BRON_TELEFOON = 'Import-telefoon';
export const IMPORT_BRONNEN = Object.freeze([BRON_MAIL, BRON_TELEFOON]);
export const MAX_RIJEN = 20000;
export const MAX_BATCH = 99;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const E164_RE = /^\+\d{8,15}$/;
const KOLOMMEN = Object.freeze({
  batch: ['batch', 'import_batch'],
  voornaam: ['voornaam', 'first name', 'firstname'],
  achternaam: ['achternaam', 'last name', 'lastname'],
  email: ['email', 'e-mail'],
  telefoon: ['telefoon', 'phone', 'telefoonnummer'],
  tag: ['tag', 'tags', 'bron'],
  created: ['created', 'aangemaakt', 'date created'],
});

/** CSV → ruwe rijen (komma of puntkomma, aanhalingstekens). PURE. */
export function leesGhlCsv(tekst, soort = 'mail') {
  const regels = String(tekst || '').replace(/^﻿/, '').split(/\r?\n/).filter((r) => r.trim());
  if (regels.length < 2) return { rijen: [], fout: 'Het bestand heeft een kopregel en minstens één rij nodig.' };
  if (regels.length - 1 > MAX_RIJEN) return { rijen: [], fout: 'Maximaal ' + MAX_RIJEN + ' rijen per keer.' };
  const sep = (regels[0].split(';').length > regels[0].split(',').length) ? ';' : ',';
  const kop = splitsRegel(regels[0], sep).map((k) => k.toLowerCase().trim());
  const index = {};
  for (const [veld, namen] of Object.entries(KOLOMMEN)) {
    const i = kop.findIndex((k) => namen.includes(k));
    if (i >= 0) index[veld] = i;
  }
  if (soort === 'mail' && index.email == null) return { rijen: [], fout: 'Geen kolom email in de kopregel.' };
  if (soort === 'mail' && index.batch == null) return { rijen: [], fout: 'Geen kolom batch in de kopregel.' };
  if (soort === 'telefoon' && index.telefoon == null) return { rijen: [], fout: 'Geen kolom telefoon in de kopregel.' };
  const rijen = regels.slice(1).map((r, n) => {
    const c = splitsRegel(r, sep);
    const v = (veld) => (index[veld] == null ? '' : String(c[index[veld]] ?? '').trim());
    return { regel: n + 2, batch: v('batch'), voornaam: v('voornaam'), achternaam: v('achternaam'), email: v('email'), telefoon: v('telefoon'), tag: v('tag'), created: v('created') };
  });
  return { rijen, fout: null };
}

/** Eén ruwe rij → genormaliseerd, of { fout }. PURE. */
export function controleerRij(r, soort = 'mail') {
  const email = String(r.email || '').trim().toLowerCase();
  const telRuw = String(r.telefoon || '').replace(/[\s()-]/g, '');
  const telefoon = E164_RE.test(telRuw) ? telRuw : null;
  let batch = null;
  if (String(r.batch || '').trim()) {
    const b = Number(r.batch);
    if (!Number.isInteger(b) || b < 1 || b > MAX_BATCH) return { fout: 'batch ' + JSON.stringify(r.batch) + ' is geen getal van 1 t/m ' + MAX_BATCH };
    batch = b;
  }
  if (soort === 'mail') {
    if (!EMAIL_RE.test(email)) return { fout: 'geen geldig e-mailadres' };
    if (batch == null) return { fout: 'geen batch' };
  } else if (!telefoon) {
    return { fout: 'geen geldig telefoonnummer (E.164, bv. +31612345678)' };
  }
  const t = Date.parse(String(r.created || ''));
  return {
    regel: r.regel,
    email: soort === 'mail' ? email : null,
    telefoon,
    voornaam: String(r.voornaam || '').trim().slice(0, 120) || null,
    achternaam: String(r.achternaam || '').trim().slice(0, 120) || null,
    ghl_tag: String(r.tag || '').trim().slice(0, 200) || null,
    ghl_created: Number.isFinite(t) ? new Date(t).toISOString() : null,
    import_batch: batch,
    telefoon_ongeldig: !!telRuw && !telefoon,
  };
}

/**
 * Het plan: wat nieuw is, wat al bestaat, wat niet klopt — en de rijen voor de
 * insert met hun sorteerdatum. PURE.
 * @param {Array} rijen       uit leesGhlCsv
 * @param {object} o
 * @param {Set<string>} o.bestaandeEmails     lower(email) van alle leads
 * @param {Set<string>} o.bestaandeTelefoons  telefoon_e164 van alle leads
 * @param {string|null} o.oudsteAangemaakt    ISO van de oudste lead (null = nu)
 * @param {'mail'|'telefoon'} o.soort
 * @param {number} [o.nuMs]
 */
export function maakImportPlan(rijen, { bestaandeEmails = new Set(), bestaandeTelefoons = new Set(), oudsteAangemaakt = null, soort = 'mail', nuMs = Date.now() } = {}) {
  const ongeldig = [];
  const bestaand = [];
  const gezien = new Set();
  let dubbelInBestand = 0;
  let telefoonOngeldig = 0;
  const kandidaten = [];
  for (const r of rijen || []) {
    const c = controleerRij(r, soort);
    if (c.fout) { ongeldig.push({ regel: r.regel, reden: c.fout }); continue; }
    const sleutel = soort === 'mail' ? c.email : c.telefoon;
    if (gezien.has(sleutel)) { dubbelInBestand += 1; continue; }
    gezien.add(sleutel);
    if (c.telefoon_ongeldig) telefoonOngeldig += 1;
    const bestaat = soort === 'mail' ? bestaandeEmails.has(c.email) : bestaandeTelefoons.has(c.telefoon);
    if (bestaat) { bestaand.push(c); continue; }
    kandidaten.push(c);
  }
  // Nieuwste GHL-datum eerst (zonder datum achteraan), daarna de volgorde in het bestand.
  kandidaten.sort((a, b) => {
    const ta = a.ghl_created ? Date.parse(a.ghl_created) : -Infinity;
    const tb = b.ghl_created ? Date.parse(b.ghl_created) : -Infinity;
    return tb - ta || a.regel - b.regel;
  });
  const basisMs = (oudsteAangemaakt ? Date.parse(oudsteAangemaakt) : nuMs) - 24 * 60 * 60 * 1000;
  const bron = soort === 'mail' ? BRON_MAIL : BRON_TELEFOON;
  const nieuw = kandidaten.map((c, i) => {
    const sorteer = new Date(basisMs - i * 1000).toISOString();
    return {
      voornaam: c.voornaam, achternaam: c.achternaam, email: c.email,
      telefoon: c.telefoon, telefoon_e164: c.telefoon,
      bron, soort: 'onbekend', traject: null, toestemming: false,
      aangemaakt: sorteer, laatste_aanmelding: sorteer,
      import_batch: c.import_batch, ghl_tag: c.ghl_tag, ghl_created: c.ghl_created,
    };
  });
  const perBatch = {};
  const tel = (b, k) => { const s = b == null ? 'zonder' : String(b); perBatch[s] = perBatch[s] || { nieuw: 0, bestaand: 0 }; perBatch[s][k] += 1; };
  for (const r of nieuw) tel(r.import_batch, 'nieuw');
  for (const r of bestaand) tel(r.import_batch, 'bestaand');
  return {
    nieuw,
    bestaand: bestaand.map((c) => ({ regel: c.regel, email: c.email, telefoon: c.telefoon, import_batch: c.import_batch })),
    ongeldig,
    dubbel_in_bestand: dubbelInBestand,
    telefoon_ongeldig: telefoonOngeldig,
    per_batch: perBatch,
    sorteer_van: nieuw.length ? nieuw[0].aangemaakt : null,
    sorteer_tot: nieuw.length ? nieuw[nieuw.length - 1].aangemaakt : null,
  };
}

/** Is dit een import-lead (bron Import / Import-telefoon)? PURE. */
export function isImportBron(bron) {
  return IMPORT_BRONNEN.includes(String(bron || ''));
}
