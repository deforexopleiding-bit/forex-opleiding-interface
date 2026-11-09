// api/_lib/incasso-maandlijst.js
//
// MAANDLIJST INCASSO-ABONNEMENTEN (PR 4 mentorcommissie, 3 nov 2026).
//
// Per klant met een incasso-regeling (status incasso_regeling, of een
// abonnement van soort incasso_regeling): per maand VERWACHT, ONTVANGEN en
// ACHTERSTAND. De termijnfacturen gaan niet naar de klant en niet naar het
// bureau (api/_lib/incasso-termijnfacturen.js); een betaling wordt hier
// geregistreerd via de bestaande betaalflow (finance-invoice-register-payment
// → register-payment-internal → TL + payments + invoices), waarna de
// factuurmotor de commissie vrijgeeft op wat effectief binnenkwam.
//
//   verwacht   = netto factuurbedrag (totaal − gecrediteerd) in de maand van
//                de vervaldag; voor termijnen zonder factuur: het
//                termijnbedrag van het abonnement in de maand van de termijn;
//   ontvangen  = betaald, in de maand van de betaling (betalingsregels, anders
//                paid_date); concept en volledig gecrediteerd tellen nooit;
//   achterstand= lopend: verwacht met vervaldag vóór vandaag − ontvangen, ≥ 0.

import { betaaldBedrag, isVolledigGecrediteerd, openBedrag } from './factuur-betaald.js';
import { betaalmethodenVan } from './betaalmethode.js';
import { isConcept } from './commissie-regeling.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ym = (d) => (d ? String(d).slice(0, 7) : null);

export function inclPerTermijn(sub) {
  const lines = Array.isArray(sub?.line_items) ? sub.line_items : [];
  if (lines.length) {
    return round2(lines.reduce((t, l) => t + (Number(l.amount) || 0) * (1 + (Number(l.vat_percentage) || 0) / 100), 0));
  }
  const vat = sub?.vat_percentage != null ? Number(sub.vat_percentage) : 21;
  return round2((Number(sub?.amount) || 0) * (1 + vat / 100));
}
function cyclus(c) {
  const s = String(c || '').toLowerCase();
  if (s.includes('quarter') || s === 'per_quarter') return 3;
  if (s.includes('year') || s === 'per_year') return 12;
  return 1;
}
function plusMaanden(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  const dag = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const laatste = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dag, laatste));
  return d.toISOString().slice(0, 10);
}
function maandenTussen(van, tot) {
  const out = [];
  if (!van || !tot || van > tot) return out;
  let [y, m] = van.split('-').map(Number);
  const [ty, tm] = tot.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Welke facturen horen bij het incassotraject van deze klant? */
export function trajectFacturen({ facturen = [], subs = [], status = null }) {
  const tl = new Set(subs.map((s) => s.teamleader_subscription_id).filter(Boolean));
  const sinds = status?.status === 'incasso_regeling' ? (status.sinds || null) : null;
  return facturen.filter((f) => {
    if (isConcept(f)) return false; // de bureaufactuur (concept) telt nooit
    if (f.tl_subscription_id && tl.has(f.tl_subscription_id)) return true;
    // Regeling zonder (gekoppeld) abonnement: de facturen vanaf de regeling.
    if (!tl.size && sinds) {
      const d = String(f.issue_date || f.created_at || f.due_date || '').slice(0, 10);
      return d && d >= sinds && !isVolledigGecrediteerd(f);
    }
    return false;
  });
}

/**
 * @param {object} p
 * @param {Array} p.facturen     facturen van het traject (trajectFacturen)
 * @param {Array} p.subs         incasso_regeling-abonnementen
 * @param {Map}   p.betalingen   invoice_id → [{ amount, payment_date, payment_method?, source? }]
 * @param {string} p.vandaag     YYYY-MM-DD
 */
export function bouwMaandlijst({ facturen = [], subs = [], betalingen = new Map(), vandaag }) {
  const maanden = new Map(); // ym → { verwacht, ontvangen, verwacht_vervallen, facturen: [] }
  const rij = (k) => {
    if (!maanden.has(k)) maanden.set(k, { maand: k, verwacht: 0, ontvangen: 0, verwacht_vervallen: 0, facturen: [], gepland: 0 });
    return maanden.get(k);
  };
  const metFactuur = new Set(); // `${sub_tl}|${ym}` — termijnen die al een factuur hebben

  for (const f of facturen) {
    const netto = Math.max(0, round2((Number(f.amount_total) || 0) - (Number(f.credited_amount) || 0)));
    const k = ym(f.due_date) || ym(f.issue_date) || ym(f.created_at);
    if (!k) continue;
    if (f.tl_subscription_id) metFactuur.add(`${f.tl_subscription_id}|${k}`);
    const r = rij(k);
    if (!isVolledigGecrediteerd(f)) {
      r.verwacht = round2(r.verwacht + netto);
      if (f.due_date && String(f.due_date).slice(0, 10) < vandaag) r.verwacht_vervallen = round2(r.verwacht_vervallen + netto);
    }
    r.facturen.push({
      id: f.id, nummer: f.invoice_number || null, bedrag: netto, open: openBedrag(f),
      due_date: f.due_date || null, betaald: betaaldBedrag(f), status: f.status,
      gecrediteerd: isVolledigGecrediteerd(f),
      // Hoe betaald (Contant / Bank / Teamleader …); null zolang niets betaald.
      betaalmethode: betaalmethodenVan(betalingen.get(f.id) || [], f).label,
    });
    // Ontvangen in de maand van de betaling.
    const pays = (betalingen.get(f.id) || []).filter((p) => p && Number(p.amount) > 0 && p.payment_date);
    const betaald = betaaldBedrag(f);
    if (pays.length) {
      let rest = betaald;
      for (const p of pays.sort((a, b) => String(a.payment_date).localeCompare(String(b.payment_date)))) {
        const a = Math.min(rest, Number(p.amount) || 0);
        if (a <= 0) break;
        rest = round2(rest - a);
        const rp = rij(ym(p.payment_date));
        rp.ontvangen = round2(rp.ontvangen + a);
      }
    } else if (betaald > 0) {
      const rp = rij(ym(f.paid_date) || k);
      rp.ontvangen = round2(rp.ontvangen + betaald);
    }
  }
  // Nog niet gefactureerde termijnen van de abonnementen.
  for (const s of subs) {
    if (String(s.status || '').toLowerCase() === 'cancelled') continue;
    const n = Number(s.term_count) || 0;
    const per = inclPerTermijn(s);
    if (!s.start_date || !n || !(per > 0)) continue;
    for (let i = 0; i < n; i++) {
      const due = plusMaanden(s.start_date, i * cyclus(s.billing_cycle));
      const k = ym(due);
      if (s.teamleader_subscription_id && metFactuur.has(`${s.teamleader_subscription_id}|${k}`)) continue;
      const r = rij(k);
      r.verwacht = round2(r.verwacht + per);
      r.gepland = round2(r.gepland + per);
      if (due < vandaag) r.verwacht_vervallen = round2(r.verwacht_vervallen + per);
    }
  }

  const sleutels = [...maanden.keys()].sort();
  if (!sleutels.length) return { maanden: [], totaal: { verwacht: 0, ontvangen: 0, achterstand: 0 } };
  const lijst = [];
  let cumV = 0, cumO = 0;
  for (const k of maandenTussen(sleutels[0], sleutels[sleutels.length - 1])) {
    const r = maanden.get(k) || { maand: k, verwacht: 0, ontvangen: 0, verwacht_vervallen: 0, facturen: [], gepland: 0 };
    cumV = round2(cumV + r.verwacht_vervallen);
    cumO = round2(cumO + r.ontvangen);
    lijst.push({ ...r, achterstand: round2(Math.max(0, cumV - cumO)) });
  }
  const totV = round2(lijst.reduce((t, r) => t + r.verwacht, 0));
  const totO = round2(lijst.reduce((t, r) => t + r.ontvangen, 0));
  const vervallen = round2(lijst.reduce((t, r) => t + r.verwacht_vervallen, 0));
  return { maanden: lijst, totaal: { verwacht: totV, ontvangen: totO, achterstand: round2(Math.max(0, vervallen - totO)) } };
}
