// api/_lib/scan-dashboard.js — strategie-scan fase 4: dashboard-cijfers (pure).
//
// Invoer: de scans zoals api/scans-overzicht.js ze levert (met `klant` uit
// api/_lib/scan-klant.js → bepaalKlant). Uitvoer: alles wat het dashboard toont.
//   - aantal scans per periode (week of maand, in Nederlandse tijd), met daarin
//     hoeveel er klant werden;
//   - verdeling uitkomst-categorieën, aanbevolen trajecten en day/swing;
//   - conversie naar klant (automatisch uit de deals óf handmatig — de
//     handmatige status heeft voorrang, zoals in het overzicht), totaal en per
//     categorie / traject / aanpak, met de dealwaarde waar een gewonnen deal
//     gekoppeld is.
// Concepten tellen NIET mee in de cijfers (nog geen uitkomst); hun aantal
// staat er apart bij.

import { CATEGORIEEN, TRAJECTEN, AANPAKKEN } from '../../modules/scan/scan-model.js';

const ZONE = 'Europe/Amsterdam';
const dagFmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' van een moment, in Nederlandse tijd. */
export function nlDag(iso) { return dagFmt.format(new Date(iso)); }

const plusDagen = (dag, n) => {
  const d = new Date(dag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Maandag van de week van `dag` (YYYY-MM-DD). */
export function weekStart(dag) {
  const wd = new Date(dag + 'T12:00:00Z').getUTCDay(); // 0 = zondag
  return plusDagen(dag, wd === 0 ? -6 : 1 - wd);
}
const maandStart = (dag) => dag.slice(0, 8) + '01';
const volgendeMaand = (dag) => {
  const [j, m] = dag.split('-').map(Number);
  return (m === 12 ? j + 1 : j) + '-' + String(m === 12 ? 1 : m + 1).padStart(2, '0') + '-01';
};
const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function label(start, groep) {
  const [j, m, d] = start.split('-').map(Number);
  return groep === 'maand' ? MAANDEN[m - 1] + ' ' + String(j).slice(2) : d + ' ' + MAANDEN[m - 1];
}

/** Week bij korte periodes (≤ 120 dagen), anders maand. */
export function kiesGroep(van, tot) {
  if (!van || !tot) return 'maand';
  const dagen = (Date.parse(tot) - Date.parse(van)) / 86400000;
  return dagen <= 120 ? 'week' : 'maand';
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function verdeling(lijst, sleutel, volgorde, leeg) {
  const tel = new Map();
  for (const s of lijst) { const k = s[sleutel] || leeg; tel.set(k, (tel.get(k) || 0) + 1); }
  // Vaste volgorde, altijd allemaal (ook 0): vergelijkbaar tussen periodes.
  const namen = [...volgorde, ...[...tel.keys()].filter((k) => !volgorde.includes(k)).sort()];
  return namen.map((naam) => ({ naam, aantal: tel.get(naam) || 0, pct: pct(tel.get(naam) || 0, lijst.length) }));
}

function conversie(lijst, sleutel, volgorde, leeg) {
  const groepen = new Map();
  for (const s of lijst) {
    const k = s[sleutel] || leeg;
    if (!groepen.has(k)) groepen.set(k, []);
    groepen.get(k).push(s);
  }
  const namen = [...volgorde, ...[...groepen.keys()].filter((k) => !volgorde.includes(k)).sort()];
  return namen.map((naam) => {
    const g = groepen.get(naam) || []; const t = telKlanten(g);
    return { naam, scans: g.length, klanten: t.klanten, conversie: pct(t.klanten, g.length), dealwaarde: t.dealwaarde };
  });
}

/** Klanten + dealwaarde (elke gewonnen deal één keer, ook als hij bij twee scans hoort). */
function telKlanten(lijst) {
  const deals = new Map(); let klanten = 0; let auto = 0; let hand = 0; let zonderDeal = 0;
  for (const s of lijst) {
    const k = s.klant || {};
    if (!k.klant) continue;
    klanten++;
    if (k.bron === 'handmatig') hand++; else auto++;
    if (k.auto && k.auto.deal_id) deals.set(k.auto.deal_id, Number(k.auto.bedrag) || 0);
    else zonderDeal++;
  }
  const dealwaarde = Math.round([...deals.values()].reduce((a, b) => a + b, 0) * 100) / 100;
  return { klanten, auto, hand, zonderDeal, dealwaarde, deals: deals.size };
}

/**
 * @param {object[]} scans  rijen uit scans-overzicht (status, aangemaakt, readiness_score, categorie, aanbevolen_*, klant)
 * @param {{ van?: string|null, tot?: string|null, groep?: 'week'|'maand'|null, nu?: Date }} opties
 *        van/tot = 'YYYY-MM-DD' (tot inclusief), in Nederlandse tijd.
 */
export function berekenScanDashboard(scans, { van = null, tot = null, groep = null, nu = new Date() } = {}) {
  const vandaag = nlDag(nu);
  const inPeriode = (scans || []).filter((s) => {
    if (!s || !s.aangemaakt) return false;
    const d = nlDag(s.aangemaakt);
    return (!van || d >= van) && (!tot || d <= tot);
  });
  const concepten = inPeriode.filter((s) => s.status === 'concept').length;
  const lijst = inPeriode.filter((s) => s.status !== 'concept');

  const start = van || (lijst.length ? lijst.map((s) => nlDag(s.aangemaakt)).sort()[0] : vandaag);
  const eind = tot || vandaag;
  const g = groep === 'week' || groep === 'maand' ? groep : kiesGroep(start, eind);

  // Reeks: elke week/maand van start t/m eind, ook als er niets gebeurde.
  const reeks = [];
  let cur = g === 'week' ? weekStart(start) : maandStart(start);
  for (let i = 0; cur <= eind && i < 400; i++) {
    const volgende = g === 'week' ? plusDagen(cur, 7) : volgendeMaand(cur);
    const hier = lijst.filter((s) => { const d = nlDag(s.aangemaakt); return d >= cur && d < volgende; });
    reeks.push({ start: cur, label: label(cur, g), scans: hier.length, klanten: hier.filter((s) => s.klant && s.klant.klant).length });
    cur = volgende;
  }

  const t = telKlanten(lijst);
  const scores = lijst.map((s) => s.readiness_score).filter((x) => typeof x === 'number');
  return {
    periode: { van: start, tot: eind, groep: g },
    totaal: {
      scans: lijst.length,
      concepten,
      verstuurd: lijst.filter((s) => s.status === 'verstuurd').length,
      verstuurd_pct: pct(lijst.filter((s) => s.status === 'verstuurd').length, lijst.length),
      gem_readiness: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      klanten: t.klanten,
      conversie: pct(t.klanten, lijst.length),
      klanten_automatisch: t.auto,
      klanten_handmatig: t.hand,
      klanten_zonder_deal: t.zonderDeal,
      dealwaarde: t.dealwaarde,
      deals: t.deals,
      gem_dealwaarde: t.deals ? Math.round(t.dealwaarde / t.deals) : null,
    },
    reeks,
    verdeling: {
      categorie: verdeling(lijst, 'categorie', CATEGORIEEN, 'Onbekend'),
      traject: verdeling(lijst, 'aanbevolen_traject', TRAJECTEN, 'Onbekend'),
      aanpak: verdeling(lijst, 'aanbevolen_aanpak', AANPAKKEN, 'Geen (nu nog niet)'),
    },
    conversie: {
      categorie: conversie(lijst, 'categorie', CATEGORIEEN, 'Onbekend'),
      traject: conversie(lijst, 'aanbevolen_traject', TRAJECTEN, 'Onbekend'),
      aanpak: conversie(lijst, 'aanbevolen_aanpak', AANPAKKEN, 'Geen (nu nog niet)'),
    },
  };
}
