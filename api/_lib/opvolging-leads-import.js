// api/_lib/opvolging-leads-import.js
//
// 'LIJST OPLADEN' — oude leads in Leads bellen, gedoseerd. Puur en getest.
//
// Maxim wil oude leads kunnen opladen: calls die maanden terug geannuleerd
// werden, mensen die beloofden terug te komen en nooit gebeld zijn. Een CSV met
// naam, telefoon, email (opt.), notitie (opt.); één label voor de hele lijst
// (bv. 'Geannuleerd voorjaar').
//
// Twee stappen: eerst een VOORVERTONING (geldig / dubbel / ongeldig nummer),
// pas na bevestigen worden het kaarten — lijst 'leads', reden 'lead_bellen',
// bron 'import', badge_label = label. GEDOSEERD: max N per werkdag via de due,
// zoals de dripfeed van de zoom-opwarmronde, zodat de pot niet in één keer
// volloopt.
//
// Idempotent op het genormaliseerde nummer (laatste 9 cijfers): deze kaarten
// hebben geen lead_id, dus de unieke index op lead_id beschermt ze niet.

import { normaliseerNlBe } from './phone-e164.js';
import { staart9 } from './opvolging-leads-pot.js';

export const MAX_RIJEN = 2000;
export const STANDAARD_PER_DAG = 10;
export const MAX_PER_DAG = 100;

/** Eén CSV-regel splitsen, met aanhalingstekens en ; of , als scheiding. */
export function splitsRegel(regel, sep) {
  const uit = [];
  let cel = '', inQ = false;
  for (let i = 0; i < regel.length; i++) {
    const c = regel[i];
    if (inQ) {
      if (c === '"' && regel[i + 1] === '"') { cel += '"'; i++; }
      else if (c === '"') inQ = false;
      else cel += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { uit.push(cel.trim()); cel = ''; }
    else cel += c;
  }
  uit.push(cel.trim());
  return uit;
}

const KOLOMMEN = {
  naam: ['naam', 'name', 'volledige naam', 'lead'],
  voornaam: ['voornaam', 'first name', 'firstname'],
  achternaam: ['achternaam', 'last name', 'lastname'],
  telefoon: ['telefoon', 'telefoonnummer', 'tel', 'gsm', 'phone', 'nummer', 'mobiel'],
  email: ['email', 'e-mail', 'mail', 'emailadres'],
  notitie: ['notitie', 'notes', 'opmerking', 'note'],
};

/**
 * De CSV in rijen. De eerste regel is de kop; kolommen worden op naam herkend.
 * @returns {{ rijen: object[], fout: string|null }}
 */
export function leesCsv(tekst) {
  const regels = String(tekst || '').replace(/^﻿/, '').split(/\r?\n/).filter((r) => r.trim());
  if (regels.length < 2) return { rijen: [], fout: 'De lijst heeft een kopregel en minstens één lead nodig.' };
  if (regels.length - 1 > MAX_RIJEN) return { rijen: [], fout: 'Maximaal ' + MAX_RIJEN + ' leads per keer.' };
  const sep = (regels[0].split(';').length > regels[0].split(',').length) ? ';' : ',';
  const kop = splitsRegel(regels[0], sep).map((k) => k.toLowerCase().trim());
  const index = {};
  for (const [veld, namen] of Object.entries(KOLOMMEN)) {
    const i = kop.findIndex((k) => namen.includes(k));
    if (i >= 0) index[veld] = i;
  }
  if (index.telefoon == null) return { rijen: [], fout: 'Geen kolom telefoon gevonden in de kopregel.' };
  if (index.naam == null && index.voornaam == null) return { rijen: [], fout: 'Geen kolom naam gevonden in de kopregel.' };
  const rijen = regels.slice(1).map((r, n) => {
    const c = splitsRegel(r, sep);
    const v = (veld) => (index[veld] == null ? '' : String(c[index[veld]] || '').trim());
    const naam = v('naam') || [v('voornaam'), v('achternaam')].filter(Boolean).join(' ');
    return { regel: n + 2, naam, telefoon_ruw: v('telefoon'), email: v('email') || null, notitie: v('notitie') || null };
  });
  return { rijen, fout: null };
}

/** De werkdag (ma–vr) n werkdagen na `vanaf` (YYYY-MM-DD); 0 = vanaf zelf als werkdag, anders de eerstvolgende. */
export function werkdagPlus(vanaf, n) {
  const d = new Date(vanaf + 'T12:00:00Z');
  const isWerk = () => { const w = d.getUTCDay(); return w !== 0 && w !== 6; };
  while (!isWerk()) d.setUTCDate(d.getUTCDate() + 1);
  let rest = n;
  while (rest > 0) { d.setUTCDate(d.getUTCDate() + 1); if (isWerk()) rest -= 1; }
  return d.toISOString().slice(0, 10);
}

/**
 * De voorvertoning: per rij geldig / dubbel / ongeldig, en voor de geldige een
 * due volgens de dosering.
 *
 * @param {object} p
 * @param {object[]} p.rijen            uit leesCsv()
 * @param {string[]} p.bekendeTelefoons telefoons die al een leadkaart, een
 *                                      lopende daglijstkaart of een lead in de pot hebben
 * @param {string}   p.vandaag          YYYY-MM-DD (Amsterdam)
 * @param {number}   p.perDag
 * @param {number}   p.alVandaag        geïmporteerde kaarten die al op vandaag staan
 */
export function maakVoorvertoning({ rijen, bekendeTelefoons = [], vandaag, perDag = STANDAARD_PER_DAG, alVandaag = 0 }) {
  const n = Math.max(1, Math.min(MAX_PER_DAG, Math.floor(Number(perDag) || STANDAARD_PER_DAG)));
  const bekend = new Set(bekendeTelefoons.map(staart9).filter(Boolean));
  const inLijst = new Set();
  const uit = [];
  let geldig = 0;
  for (const r of rijen) {
    const norm = normaliseerNlBe(r.telefoon_ruw);
    const s = staart9(norm.telefoon || r.telefoon_ruw);
    if (!r.naam) { uit.push({ ...r, status: 'ongeldig', reden: 'geen naam' }); continue; }
    if (!norm.e164 || !s) { uit.push({ ...r, status: 'ongeldig', reden: 'ongeldig nummer' + (norm.reden ? ' (' + norm.reden + ')' : '') }); continue; }
    if (bekend.has(s)) { uit.push({ ...r, telefoon: norm.e164, status: 'dubbel', reden: 'al een kaart of al in de pot' }); continue; }
    if (inLijst.has(s)) { uit.push({ ...r, telefoon: norm.e164, status: 'dubbel', reden: 'twee keer in deze lijst' }); continue; }
    inLijst.add(s);
    // De dosering: wat er vandaag al geïmporteerd staat telt mee.
    const plek = alVandaag + geldig;
    const due = werkdagPlus(vandaag, Math.floor(plek / n));
    uit.push({ ...r, telefoon: norm.e164, status: 'geldig', due });
    geldig += 1;
  }
  const geldige = uit.filter((r) => r.status === 'geldig');
  const vandaagAantal = geldige.filter((r) => r.due === vandaag).length;
  const tot = geldige.length ? geldige[geldige.length - 1].due : null;
  return {
    rijen: uit,
    per_dag: n,
    aantallen: {
      geldig: geldige.length,
      dubbel: uit.filter((r) => r.status === 'dubbel').length,
      ongeldig: uit.filter((r) => r.status === 'ongeldig').length,
    },
    vandaag: vandaagAantal,
    verspreid_tot: tot,
    samenvatting: geldige.length
      ? vandaagAantal + ' vandaag' + (tot && tot !== vandaag ? ', rest verspreid tot ' + tot : '')
      : 'niets om op te laden',
  };
}

/** De kaart voor één geldige rij. */
export function importKaart({ rij, label, nuIso }) {
  return {
    lijst: 'leads',
    lead_id: null,
    reden: 'lead_bellen',
    bron: 'import',
    status: 'open',
    due: rij.due,
    later: false,
    naam: rij.naam,
    telefoon: rij.telefoon,
    email: rij.email || null,
    badge_label: label,
    notitie: [String(nuIso).slice(0, 10) + ' · Opgeladen in Leads bellen (' + label + ').', rij.notitie].filter(Boolean).join('\n\n'),
    bron_ref: { import_label: label, import_op: nuIso, product: null },
  };
}
