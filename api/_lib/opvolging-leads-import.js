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
//
// APARTE LIJST (27 okt): dezelfde CSV, voorvertoning en dubbel-check, maar
// zonder dosering (alles op vandaag) en met bron_ref.aparte_lijst_id. Die
// kaarten staan dan alleen in de chip van hun lijst
// (zie opvolging-leads-lijsten.js).
//
// VERHUIZEN (27 okt, na de eerste echte lijst): wie al als OPEN kaart in de
// algemene pot staat, wordt bij een aparte lijst niet geweigerd maar
// verhuisd: dezelfde kaart (historiek, pogingen, terugbelafspraak) krijgt
// alleen bron_ref.aparte_lijst_id erbij. Zie maakAparteVoorvertoning().

import { normaliseerNlBe } from './phone-e164.js';
import { staart9, telefoonVan } from './opvolging-leads-pot.js';
import { aparteLijstVan } from './opvolging-leads-lijsten.js';

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
 * @param {boolean}  [p.dosering=true]  false = aparte lijst: alles meteen op vandaag
 */
export function maakVoorvertoning({ rijen, bekendeTelefoons = [], vandaag, perDag = STANDAARD_PER_DAG, alVandaag = 0, dosering = true }) {
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
    const due = dosering ? werkdagPlus(vandaag, Math.floor(plek / n)) : vandaag;
    uit.push({ ...r, telefoon: norm.e164, status: 'geldig', due });
    geldig += 1;
  }
  const geldige = uit.filter((r) => r.status === 'geldig');
  const vandaagAantal = geldige.filter((r) => r.due === vandaag).length;
  const tot = geldige.length ? geldige[geldige.length - 1].due : null;
  return {
    rijen: uit,
    per_dag: dosering ? n : null,
    dosering: !!dosering,
    aantallen: {
      geldig: geldige.length,
      dubbel: uit.filter((r) => r.status === 'dubbel').length,
      ongeldig: uit.filter((r) => r.status === 'ongeldig').length,
    },
    vandaag: vandaagAantal,
    verspreid_tot: tot,
    samenvatting: !geldige.length ? 'niets om op te laden'
      : !dosering ? 'alle ' + geldige.length + ' meteen zichtbaar in de lijst'
        : vandaagAantal + ' vandaag' + (tot && tot !== vandaag ? ', rest verspreid tot ' + tot : ''),
  };
}

/**
 * De kaart voor één geldige rij.
 * @param {object} [p.aparteLijst] { id, naam } — de kaart hoort bij die aparte lijst
 */
export function importKaart({ rij, label, nuIso, aparteLijst = null }) {
  const waar = aparteLijst ? 'aparte lijst: ' + label : label;
  const ref = { import_label: label, import_op: nuIso, product: null };
  if (aparteLijst) { ref.aparte_lijst_id = aparteLijst.id; ref.aparte_lijst_naam = aparteLijst.naam; }
  return {
    lijst: 'leads',
    // Een aparte lijst koppelt een lead uit de berekende pot Nieuw aan zijn
    // kaart; de algemene pot laat lead_id leeg zoals altijd.
    lead_id: rij.lead_id || null,
    reden: 'lead_bellen',
    bron: 'import',
    status: 'open',
    due: rij.due,
    later: false,
    naam: rij.naam,
    telefoon: rij.telefoon,
    email: rij.email || null,
    badge_label: label,
    notitie: [String(nuIso).slice(0, 10) + ' · Opgeladen in Leads bellen (' + waar + ').', rij.notitie].filter(Boolean).join('\n\n'),
    bron_ref: ref,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// APARTE LIJST — nieuw / verhuisd uit de pot / overgeslagen
// ═══════════════════════════════════════════════════════════════════════════

/** Waarom een rij bij een aparte lijst overgeslagen wordt. */
export const OVERSLAAN = Object.freeze({
  ongeldig           : 'ongeldig nummer of naam',
  dubbel_in_lijst    : 'twee keer in deze lijst',
  andere_lijst       : 'al in een andere aparte lijst',
  wacht              : 'wacht op inplanning (agenda gestuurd)',
  gearchiveerde_lijst: 'in een gearchiveerde aparte lijst',
  ingepland          : 'al ingepland',
  afgerond           : 'eerder afgerond',
  daglijst           : 'staat op de daglijst',
});

const LOPEND = new Set(['open', 'wacht_inplanning', 'wacht_verplaatsing']);

/**
 * De voorvertoning van een NIEUWE APARTE LIJST. Per rij:
 *   geldig       — nieuw: er komt een kaart in de lijst (due = vandaag). Stond
 *                  hij als lead in de berekende pot Nieuw, dan krijgt de kaart
 *                  zijn lead_id (en verdwijnt hij uit Nieuw).
 *   verhuis      — staat als OPEN kaart in de algemene pot: die kaart(en)
 *                  verhuizen naar de lijst (verhuis_ids), er komt geen tweede.
 *   overgeslagen — met soort + reden (OVERSLAAN).
 *
 * @param {object}   p
 * @param {object[]} p.rijen       uit leesCsv()
 * @param {object[]} p.kaarten     alle leadkaarten: { id, telefoon, status, lead_id, bron_ref, naam, badge_label }
 * @param {string[]} p.daglijstTelefoons telefoons van lopende daglijstkaarten
 * @param {object[]} p.kandidaten  leads van de berekende pot (leesKandidaten)
 * @param {string[]} p.actieveLijstIds
 * @param {string}   p.vandaag     YYYY-MM-DD
 */
export function maakAparteVoorvertoning({ rijen, kaarten = [], daglijstTelefoons = [], kandidaten = [], actieveLijstIds = [], vandaag }) {
  const actief = new Set(actieveLijstIds);
  const daglijst = new Set(daglijstTelefoons.map(staart9).filter(Boolean));

  // Telefoon → kaarten. Ook via de lead: een leadkaart zonder (of met een
  // anders geschreven) nummer hoort toch bij het nummer van zijn lead.
  const perStaart = new Map();
  const erbij = (s, k) => {
    if (!s) return;
    if (!perStaart.has(s)) perStaart.set(s, new Set());
    perStaart.get(s).add(k);
  };
  const kaartenPerLead = new Map();
  for (const k of kaarten) {
    if (!k) continue;
    erbij(staart9(k.telefoon), k);
    if (k.lead_id) {
      if (!kaartenPerLead.has(k.lead_id)) kaartenPerLead.set(k.lead_id, []);
      kaartenPerLead.get(k.lead_id).push(k);
    }
  }
  const kandidaatPerStaart = new Map();
  for (const l of kandidaten) {
    const s = staart9(telefoonVan(l));
    if (!s || !l || !l.id) continue;
    if (!kandidaatPerStaart.has(s)) kandidaatPerStaart.set(s, l);
    for (const k of kaartenPerLead.get(l.id) || []) erbij(s, k);
  }

  const inLijst = new Set();
  const uit = [];
  const over = (r, soort, extra = {}) => uit.push({ ...r, ...extra, status: 'overgeslagen', soort, reden: OVERSLAAN[soort] });
  for (const r of rijen) {
    const norm = normaliseerNlBe(r.telefoon_ruw);
    const s = staart9(norm.telefoon || r.telefoon_ruw);
    if (!r.naam || !norm.e164 || !s) {
      uit.push({ ...r, status: 'overgeslagen', soort: 'ongeldig',
        reden: !r.naam ? 'geen naam' : 'ongeldig nummer' + (norm.reden ? ' (' + norm.reden + ')' : '') });
      continue;
    }
    const tel = norm.e164;
    if (inLijst.has(s)) { over(r, 'dubbel_in_lijst', { telefoon: tel }); continue; }
    inLijst.add(s);

    const ks = [...(perStaart.get(s) || [])];
    const lijstVan = (k) => aparteLijstVan(k);
    const verhuis = ks.filter((k) => k.status === 'open' && !lijstVan(k));
    if (verhuis.length) {
      const k = verhuis[0];
      uit.push({ ...r, telefoon: tel, status: 'verhuis', verhuis_ids: verhuis.map((x) => x.id),
        kaart: { naam: k.naam || null, badge_label: k.badge_label || null } });
      continue;
    }
    const lopend = ks.filter((k) => LOPEND.has(String(k.status || '')));
    if (lopend.some((k) => lijstVan(k) && actief.has(lijstVan(k)))) { over(r, 'andere_lijst', { telefoon: tel }); continue; }
    if (lopend.some((k) => !lijstVan(k))) { over(r, 'wacht', { telefoon: tel }); continue; }
    if (lopend.length) { over(r, 'gearchiveerde_lijst', { telefoon: tel }); continue; }
    if (ks.some((k) => k.status === 'ingepland')) { over(r, 'ingepland', { telefoon: tel }); continue; }
    if (ks.some((k) => k.status === 'gearchiveerd')) { over(r, 'afgerond', { telefoon: tel }); continue; }
    if (daglijst.has(s)) { over(r, 'daglijst', { telefoon: tel }); continue; }
    const lead = kandidaatPerStaart.get(s) || null;
    uit.push({ ...r, telefoon: tel, status: 'geldig', due: vandaag, lead_id: lead ? lead.id : null,
      uit_nieuw: !!lead });
  }

  const tel = (st) => uit.filter((r) => r.status === st).length;
  const redenen = {};
  for (const r of uit) if (r.status === 'overgeslagen') redenen[r.soort] = (redenen[r.soort] || 0) + 1;
  const nieuw = tel('geldig'), verhuis = tel('verhuis'), overgeslagen = tel('overgeslagen');
  return {
    rijen: uit,
    per_dag: null,
    dosering: false,
    aantallen: { geldig: nieuw, verhuis, overgeslagen },
    overgeslagen_redenen: Object.keys(OVERSLAAN).filter((k) => redenen[k])
      .map((k) => ({ soort: k, aantal: redenen[k], tekst: OVERSLAAN[k] })),
    vandaag: nieuw + verhuis,
    verspreid_tot: null,
    samenvatting: nieuw + verhuis
      ? [nieuw ? nieuw + ' nieuw' : null, verhuis ? verhuis + ' verhuisd uit de pot' : null].filter(Boolean).join(' + ') +
        ', alles meteen zichtbaar in de lijst'
      : 'niets om op te laden',
  };
}

/**
 * De nieuwe bron_ref van een kaart die naar een aparte lijst verhuist: de
 * bestaande sleutels blijven, alleen de lijst komt erbij.
 */
export function verhuisdeBronRef(bronRef, aparteLijst, nuIso) {
  const basis = bronRef && typeof bronRef === 'object' && !Array.isArray(bronRef) ? bronRef : {};
  return { ...basis, aparte_lijst_id: aparteLijst.id, aparte_lijst_naam: aparteLijst.naam, aparte_lijst_verhuisd_op: nuIso };
}
