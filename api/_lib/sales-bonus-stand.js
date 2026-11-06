// api/_lib/sales-bonus-stand.js
//
// Hoeveel van een SALES-bonus (tabel `bonuses`) is effectief VERDIEND, en wat
// stellen we voor (houden / ongeldig / aanpassen)? Eén rekenkern voor het
// bonusoverzicht, de controle voor admins, het Finance-dashboard, het
// sales-dashboard en de rapporten. ALLEEN LEZEN: deze module schrijft niets.
//
// REGEL 4 (Maxim, 6 nov 2026): een bonus is pas verdiend en telt pas mee als
// er effectief betaald is, zoals bij de mentoren, in verhouding tot wat
// betaald is. Geannuleerde of gecrediteerde termijnen tellen nooit.
//
//   verdiend = min(bonus.amount, pct × betaald_excl_toegewezen / 100)
//
//   - pct: sales_bonus_configs van de ontvanger op de aanmaakdag (leeg → 3%).
//   - basis: het eerste abonnement met 1 termijn van de bonusdeal (excl. btw),
//     anders amount / pct. Een bonus "verbruikt" hooguit zijn basis aan
//     betalingen; wat overblijft gaat naar de volgende bonus van dezelfde sale
//     (Andy De Landtsheer: vier termijnen, elk een eigen bonus → alleen de
//     betaalde termijnen tellen).
//   - Welke facturen horen bij de sale? Exact dezelfde regel als de
//     mentorcommissie (api/_lib/commissie-toewijzing.js maakSaleScope /
//     factuurVanSale + api/_lib/commissie-regeling.js koppelDeal): handmatige
//     koppeling in commissie_factuur_koppeling wint, dan deal_id, dan het
//     abonnement (tl_subscription_id; soort + sale_deal_id), dan ghost-deals
//     van de sale, dan een losse factuur bij de ENIGE sale van de klant.
//     Daarbovenop: facturen op de eigen (ghost-)deal van de bonus.
//   - De betaalde reserveringsfee van de eigen offerte telt WEL (deel van de
//     prijs); die van een andere deal niet.
//   - Nooit: conceptfacturen, het gecrediteerde deel (betaaldBedrag),
//     betalingen tijdens incasso (incassoVoor / betaaldVoor, zoals bij de
//     mentoren), en facturen van vóór de deal (tekenen/aanmaken − 3 dagen).
//   - Betaald wordt omgerekend naar excl. btw: × (totaal − btw) / totaal.
//
// Een sale = de offerte waar de bonus aan hangt. Een bonus op een ghost-deal
// (abonnement zonder offerte) hangt aan de sale van zijn abonnement
// (soort/sale_deal_id, anders de overgangsregel van maakSaleScope), anders aan
// zichzelf.

import { betaaldBedrag, isVolledigGecrediteerd, openBedrag } from './factuur-betaald.js';
import { maakSaleScope, factuurVanSale, commissieSalesVan, loadAttributions, isGetekendDeal } from './commissie-toewijzing.js';
import { loadRegelingContext, koppelDeal, incassoVoor, betaaldVoor, isConcept } from './commissie-regeling.js';
import { laadSubsMetSoort } from './subscription-soort.js';
import { isGhostDeal, STANDAARD_PCT } from './sales-bonus-regels.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.005;
export const ACTIEF = new Set(['pending', 'earned', 'invoiced', 'paid']);
const NOG_NIET_UITBETAALD = new Set(['pending', 'earned', 'invoiced']);
const ADMIN_ROLLEN = new Set(['super_admin', 'admin']);

export const AUDIT_BESLISSING = 'sales.bonus.beslissing';
export const AUDIT_TOEKENNING = 'sales.bonus.toekennen';

function plusDagen(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function plusMaanden(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Excl.-btw-factor van een factuur (1 als het totaal ontbreekt). */
export function exclFactor(inv) {
  const t = Number(inv?.amount_total) || 0;
  const v = Number(inv?.vat_amount) || 0;
  if (!(t > 0)) return 1;
  return Math.max(0, Math.min(1, (t - v) / t));
}

function eersteAanbetaling(subs) {
  return (subs || [])
    .filter((s) => (Number(s.term_count) || 1) === 1 && Number(s.amount) > 0)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0] || null;
}

/** Percentage voor deze ontvanger op deze dag (zelfde selectie als de aanmaak). */
export function pctVoor(configs, userId, dag) {
  const d = String(dag || '').slice(0, 10);
  const kand = (configs || [])
    .filter((c) => c.user_id === userId && String(c.active_from || '') <= d && (!c.active_until || String(c.active_until) > d))
    .sort((a, b) => String(b.active_from).localeCompare(String(a.active_from)));
  const p = Number(kand[0]?.percentage);
  return Number.isFinite(p) && p > 0 ? p : STANDAARD_PCT;
}

/**
 * Pure berekening.
 * @param {object} p
 * @param {Array} p.bonussen      rijen uit `bonuses`
 * @param {Array} p.deals         ALLE deals van de betrokken klanten
 * @param {Array} p.subs          abonnementen van die deals (met soort-kolommen indien aanwezig)
 * @param {Array} p.facturen      facturen van die klanten
 * @param {object} p.regCtx       loadRegelingContext (koppelingen, kredieten, incasso)
 * @param {Map}   p.mentorSales   customer_id → Set(deal) met mentorcommissie
 * @param {Map}   p.betalingen    invoice_id → [{ amount, payment_date }] (enkel nodig bij incasso)
 * @param {Map}   p.klanten       customer_id → { naam, is_test }
 * @param {Map}   p.profielen     user_id → { full_name, email, role }
 * @param {Array} p.configs       sales_bonus_configs
 * @param {Map}   p.beslissingen  bonus_id → laatste beslissing { beslissing, reden, door, op }
 * @param {Map}   p.toekenningen  bonus_id → { reden, telt_volledig, basis, door, op }
 * @param {string} p.vandaag      YYYY-MM-DD
 * @returns {Array<object>} per bonus de stand
 */
export function berekenBonusStand({
  bonussen = [], deals = [], subs = [], facturen = [], regCtx = null, mentorSales = new Map(),
  betalingen = new Map(), klanten = new Map(), profielen = new Map(), configs = [],
  beslissingen = new Map(), toekenningen = new Map(), vandaag = new Date().toISOString().slice(0, 10),
} = {}) {
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const subsPerDeal = new Map();
  for (const s of subs) {
    if (!subsPerDeal.has(s.deal_id)) subsPerDeal.set(s.deal_id, []);
    subsPerDeal.get(s.deal_id).push(s);
  }
  const feeIds = new Set();
  for (const d of deals) if (d.reservation_fee_invoice_id) feeIds.add(String(d.reservation_fee_invoice_id));
  const isFee = (inv) => feeIds.has(String(inv.id)) || (inv.tl_invoice_id && feeIds.has(String(inv.tl_invoice_id)));

  const actief = bonussen.filter((b) => b.status !== 'voided');
  const voegToe = (m, c, d) => { if (!c || !d) return; if (!m.has(c)) m.set(c, new Set()); m.get(c).add(d); };

  // 1) Sale per bonus (pass 1 met de offerte-deals, pass 2 met de uitkomst).
  const sales0 = new Map();
  for (const [c, set] of mentorSales) for (const d of set) voegToe(sales0, c, d);
  // Pass 1: elke getekende offerte van de klant is een kandidaat-sale, OOK
  // gearchiveerde (een geannuleerde sale blijft de sale van zijn bonussen;
  // Andy De Landtsheer: offerte + ghost-deals gearchiveerd op 29 okt).
  const bonusKlanten = new Set(actief.map((b) => dealById.get(b.deal_id)?.customer_id).filter(Boolean));
  for (const d of deals) {
    if (bonusKlanten.has(d.customer_id) && !isGhostDeal(d) && isGetekendDeal(d)) voegToe(sales0, d.customer_id, d.id);
  }
  for (const b of actief) {
    const deal = dealById.get(b.deal_id);
    if (deal && !isGhostDeal(deal)) voegToe(sales0, deal.customer_id, deal.id);
  }
  const scope0 = maakSaleScope({ deals, subs, commissieSales: sales0 });
  const saleVan = (b) => {
    const deal = dealById.get(b.deal_id);
    if (!deal) return b.deal_id;
    if (!isGhostDeal(deal)) return deal.id;
    const eigen = subsPerDeal.get(deal.id) || [];
    const s = eersteAanbetaling(eigen) || eigen[0];
    const viaSub = s ? scope0.dealVanSub(s) : null;
    return viaSub || deal.id;
  };
  const saleVanBonus = new Map(actief.map((b) => [b.id, saleVan(b)]));
  const commissieSales = new Map();
  for (const [c, set] of mentorSales) for (const d of set) voegToe(commissieSales, c, d);
  for (const b of actief) voegToe(commissieSales, dealById.get(b.deal_id)?.customer_id, saleVanBonus.get(b.id));
  const scope = maakSaleScope({ deals, subs, commissieSales });

  // 2) Facturen per klant + koppelregel.
  const facturenPerKlant = new Map();
  for (const inv of facturen) {
    if (isConcept(inv)) continue;
    inv._k = koppelDeal(inv, regCtx, commissieSales);
    if (!facturenPerKlant.has(inv.customer_id)) facturenPerKlant.set(inv.customer_id, []);
    facturenPerKlant.get(inv.customer_id).push(inv);
  }

  // 3) Groepen (klant + sale).
  const groepen = new Map();
  for (const b of bonussen) {
    const deal = dealById.get(b.deal_id) || null;
    const cust = deal?.customer_id || null;
    const sale = saleVanBonus.get(b.id) || b.deal_id;
    const key = `${cust}|${sale}`;
    if (!groepen.has(key)) groepen.set(key, { cust, sale, bonussen: [] });
    groepen.get(key).bonussen.push(b);
  }

  const uit = [];
  for (const g of groepen.values()) {
    const saleDeal = dealById.get(g.sale) || null;
    const bonusDeals = new Set(g.bonussen.map((b) => b.deal_id));
    const tlIds = new Set();
    for (const d of [g.sale, ...bonusDeals]) {
      for (const s of subsPerDeal.get(d) || []) if (s.teamleader_subscription_id) tlIds.add(s.teamleader_subscription_id);
    }
    const groepSubs = new Map();
    for (const s of [...scope.subsVan(g.sale), ...[...bonusDeals].flatMap((d) => subsPerDeal.get(d) || []), ...(subsPerDeal.get(g.sale) || [])]) groepSubs.set(s.id, s);
    const incasso = incassoVoor(regCtx?.incasso || [], g.cust, g.sale);

    // De reserveringsfee van de offerte zelf IS een betaling voor de sale
    // (fee + aanbetalingsfactuur = de prijs; Marc De Bock: 100 + 11.900 =
    // 12.000). De fee van een andere deal hoort hier niet.
    const eigenFee = new Set();
    for (const d of [g.sale, ...bonusDeals]) {
      const f = dealById.get(d)?.reservation_fee_invoice_id;
      if (f) eigenFee.add(String(f));
    }
    const isEigenFee = (inv) => eigenFee.has(String(inv.id)) || (inv.tl_invoice_id && eigenFee.has(String(inv.tl_invoice_id)));
    const hoort = (inv) => {
      if (isEigenFee(inv)) return true;
      if (isFee(inv)) return false;
      if (inv._k) return !inv._k.onbekend && (inv._k.deal === g.sale || bonusDeals.has(inv._k.deal));
      if (inv.deal_id && bonusDeals.has(inv.deal_id)) return true;
      if (inv.tl_subscription_id && tlIds.has(inv.tl_subscription_id)) return true;
      return factuurVanSale(inv, g.sale, scope, g.cust);
    };
    // Kandidaten: facturen van de klant + facturen met deal_id op een deal van
    // deze groep, ook als ze op een ander klantrecord staan (dubbele klant).
    const groepDeals = new Set([g.sale, ...bonusDeals]);
    const kandidaten = new Map((facturenPerKlant.get(g.cust) || []).map((i) => [i.id, i]));
    for (const inv of facturen) {
      if (!isConcept(inv) && inv.deal_id && groepDeals.has(inv.deal_id) && !kandidaten.has(inv.id)) kandidaten.set(inv.id, inv);
    }
    const andereKlant = [...kandidaten.values()].filter((i) => i.customer_id && i.customer_id !== g.cust);
    const eigenFacturen = [...kandidaten.values()].filter(hoort)
      .sort((a, b) => String(a.issue_date || a.created_at || '').localeCompare(String(b.issue_date || b.created_at || '')));
    let betaaldExcl = 0;
    let openExcl = 0;
    const factuurRegels = [];
    // Per factuur wat er (excl. btw) nog te verdelen is over de bonussen.
    const potten = [];
    for (const inv of eigenFacturen) {
      const betaald = betaaldVoor(inv, betalingen.get(inv.id), incasso?.sinds || null);
      const f = exclFactor(inv);
      const open = isVolledigGecrediteerd(inv) ? 0 : openBedrag(inv);
      betaaldExcl += betaald * f;
      openExcl += open * f;
      potten.push({ datum: String(inv.issue_date || inv.created_at || '').slice(0, 10), betaald: r2(betaald * f), metOpen: r2((betaald + open) * f) });
      factuurRegels.push({
        id: inv.id, nummer: inv.invoice_number || null, datum: inv.issue_date || null, status: inv.status || null,
        totaal: r2(inv.amount_total), betaald: r2(betaald), open: r2(open), gecrediteerd: r2(inv.credited_amount),
        via: isEigenFee(inv) ? 'reserveringsfee' : (inv._k ? (inv._k.bron === 'handmatig' ? 'koppeling' : 'regeling') : (inv.deal_id ? 'deal' : (inv.tl_subscription_id ? 'abonnement' : 'enige sale'))),
      });
    }
    betaaldExcl = r2(betaaldExcl);
    openExcl = r2(openExcl);
    // Losse facturen van de klant die we aan geen enkele sale kunnen hangen.
    const onbekend = (facturenPerKlant.get(g.cust) || []).filter((inv) => !isFee(inv)
      && ((inv._k && inv._k.onbekend) || (!inv._k && !inv.deal_id && !inv.tl_subscription_id
        && !scope.enigeCommissieSale(g.cust) && (commissieSales.get(g.cust)?.size || 0) > 1))
      && (betaaldBedrag(inv) > 0 || openBedrag(inv) > 0));

    // Volgorde: bonus op de offerte zelf eerst, dan ghost-bonussen op startdatum.
    const meta = g.bonussen.map((b) => {
      const eigen = subsPerDeal.get(b.deal_id) || [];
      const aanb = eersteAanbetaling(eigen);
      const toek = toekenningen.get(b.id) || null;
      const pct = pctVoor(configs, b.sales_user_id, b.created_at);
      let basis = toek?.basis != null && Number(toek.basis) > 0 ? Number(toek.basis) : (aanb ? Number(aanb.amount) : 0);
      if (!(basis > 0)) basis = pct > 0 ? r2(Number(b.amount) * 100 / pct) : 0;
      // Een bonus kan geen betaling opeisen van een factuur die al bestond
      // vóór zijn deal er was (offerte getekend / ghost-deal aangemaakt, met
      // 3 dagen speling): die hoort bij een eerder abonnement of een oudere sale.
      const deal = dealById.get(b.deal_id);
      const sinds = deal ? (isGhostDeal(deal) ? deal.created_at : (deal.tl_quotation_accepted_at || deal.created_at)) : null;
      const vanaf = sinds ? plusDagen(String(sinds).slice(0, 10), -3) : '';
      return { b, aanb, pct, basis: r2(basis), toek, vanaf, start: aanb?.start_date || eigen[0]?.start_date || null };
    }).sort((x, y) => {
      const xs = x.b.deal_id === g.sale ? 0 : 1; const ys = y.b.deal_id === g.sale ? 0 : 1;
      if (xs !== ys) return xs - ys;
      return String(x.start || x.b.created_at || '').localeCompare(String(y.start || y.b.created_at || ''));
    });
    const opOfferte = meta.some((m) => m.b.deal_id === g.sale && m.b.status !== 'voided');

    const neemUit = (veld, vanaf, max) => {
      let genomen = 0;
      for (const p of potten) {
        if (genomen >= max - EPS) break;
        if (vanaf && p.datum && p.datum < vanaf) continue;
        const n = Math.min(p[veld], max - genomen);
        if (n > 0) { p[veld] = r2(p[veld] - n); genomen = r2(genomen + n); }
      }
      return genomen;
    };
    const groepSubsLijst = [...groepSubs.values()];
    // Een abonnement "loopt" als het niet geannuleerd is EN er nog termijnen
    // komen (laatste termijn ≥ vandaag − 45 d). Een abonnement met 1 termijn
    // waarvan de factuur al lang gecrediteerd is, loopt niet meer.
    const grens = plusDagen(vandaag, -45);
    const subLoopt = (x) => {
      if (String(x.status || '').toLowerCase() === 'cancelled') return false;
      const laatste = x.end_date ? String(x.end_date).slice(0, 10)
        : (x.start_date ? plusMaanden(String(x.start_date).slice(0, 10), Math.max(0, (Number(x.term_count) || 1) - 1)) : null);
      return !laatste || laatste >= grens;
    };
    const lopendAbo = groepSubsLijst.some(subLoopt);
    const nietGeannuleerd = groepSubsLijst.some((x) => String(x.status || '').toLowerCase() !== 'cancelled');
    const nietInTl = groepSubsLijst.some((x) => subLoopt(x) && !x.teamleader_subscription_id);
    const openFacturen = factuurRegels.filter((f) => f.open > EPS).length;
    const loopt = lopendAbo || openFacturen > 0;

    for (const m of meta) {
      const b = m.b;
      const deal = dealById.get(b.deal_id) || null;
      // Dubbel: er is al een bonus op de offerte zelf, of een eerdere
      // ghost-bonus van dezelfde sale met hetzelfde bedrag en dezelfde start
      // (zelfde abonnement twee keer ingevoerd).
      const identiek = !opOfferte && meta.slice(0, meta.indexOf(m)).some((x) => x.b.status !== 'voided'
        && Math.abs(x.basis - m.basis) < 0.02 && x.start && x.start === m.start);
      const dubbel = b.status !== 'voided' && ((opOfferte && b.deal_id !== g.sale) || identiek);
      const amount = r2(b.amount);
      let verdiend = 0; let maxHaalbaar = 0;
      if (b.status !== 'voided' && !dubbel) {
        if (m.toek?.telt_volledig) {
          verdiend = amount; maxHaalbaar = amount;
        } else {
          const neem = neemUit('betaald', m.vanaf, m.basis);
          verdiend = r2(Math.min(amount, m.pct * neem / 100));
          const neemMax = neemUit('metOpen', m.vanaf, m.basis);
          maxHaalbaar = r2(Math.min(amount, m.pct * neemMax / 100));
        }
      }
      const eigenSubs = subsPerDeal.get(b.deal_id) || [];
      const soortAanb = (m.aanb || eigenSubs[0])?.soort || null;
      const klant = klanten.get(g.cust) || {};
      const ontvanger = profielen.get(b.sales_user_id) || null;
      const verkoperSale = saleDeal && !isGhostDeal(saleDeal) ? saleDeal.sales_user_id || null : null;
      const signalen = [];
      if (deal && isGhostDeal(deal)) signalen.push('ontstaan bij het aanmaken van een abonnement zonder offerte');
      if (ontvanger && ADMIN_ROLLEN.has(ontvanger.role)) signalen.push('ontvanger is een admin-/systeemaccount');
      if (verkoperSale && verkoperSale !== b.sales_user_id && ADMIN_ROLLEN.has(profielen.get(verkoperSale)?.role)) {
        signalen.push(`de offerte staat op ${profielen.get(verkoperSale)?.full_name || 'een systeemaccount'} (import): wie de sale deed is niet zeker`);
      }
      if (andereKlant.length) signalen.push(`${andereKlant.length} factuur/facturen van deze deal staan op een ander klantrecord (dubbele klant?)`);
      if (onbekend.length) signalen.push(`${onbekend.length} factuur/facturen van de klant niet aan een sale gekoppeld`);
      if (incasso) signalen.push(`incasso sinds ${incasso.sinds}: betalingen vanaf dan tellen (nog) niet`);
      if (nietInTl && !factuurRegels.length) signalen.push('abonnement staat niet in Teamleader: er komt geen factuur');
      if (b.status === 'paid' && verdiend < amount - EPS) signalen.push(`al uitbetaald, maar slechts ${verdiend.toFixed(2)} verdiend`);

      // Voorstel.
      let voorstel; let reden; let voorstelBedrag = null; let voorstelOntvanger = null;
      if (b.status === 'voided') { voorstel = 'ongeldig'; reden = 'al ongeldig'; }
      else if (klant.is_test) { voorstel = 'ongeldig'; reden = 'testklant'; }
      else if (deal && isGhostDeal(deal) && (soortAanb === 'aanpassing' || soortAanb === 'incasso_regeling')) {
        voorstel = 'ongeldig'; reden = 'ontstaan uit een aanpassing/regeling/incasso: de commissie blijft bij de sale (regel 2)';
      } else if (dubbel) {
        voorstel = 'ongeldig'; reden = identiek
          ? 'zelfde abonnement nog eens ingevoerd (zelfde bedrag en start): de commissie telt één keer (regel 2)'
          : 'tweede bonus op dezelfde sale: de commissie blijft bij de bonus op de offerte (regel 2)';
      } else if (verkoperSale && verkoperSale !== b.sales_user_id && !m.toek && !ADMIN_ROLLEN.has(profielen.get(verkoperSale)?.role)) {
        voorstel = 'aanpassen'; voorstelOntvanger = verkoperSale;
        reden = `ontvanger is niet de verkoper van de offerte (${profielen.get(verkoperSale)?.full_name || verkoperSale}) (regel 1)`;
      } else if (verdiend >= amount - EPS) { voorstel = 'houden'; reden = 'volledig betaald'; }
      else if (loopt) {
        voorstel = 'houden';
        reden = verdiend > EPS
          ? `loopt: ${verdiend.toFixed(2)} van ${amount.toFixed(2)} verdiend, de rest volgt naar betaling`
          : 'loopt: nog niets betaald, telt pas mee naar betaling';
        if (!factuurRegels.length) {
          const eerste = groepSubsLijst.filter((x) => String(x.status || '').toLowerCase() !== 'cancelled').map((x) => x.start_date).filter(Boolean).sort()[0];
          reden += eerste ? ` (eerste factuur nog niet gemaakt; start ${eerste})` : ' (nog geen factuur)';
        } else if (!lopendAbo && maxHaalbaar < amount - EPS) reden += ` (met wat nu open staat max ${maxHaalbaar.toFixed(2)})`;
        if (!lopendAbo && openFacturen) reden += nietGeannuleerd ? '; geen termijnen meer, wel een gekoppelde factuur open' : '; abonnement geannuleerd maar er staat een gekoppelde factuur open';
      } else if (verdiend <= EPS) {
        voorstel = 'ongeldig'; reden = !groepSubsLijst.length ? 'geen abonnement en niets betaald'
          : (nietGeannuleerd
            ? (factuurRegels.length ? 'geen termijnen meer, niets betaald en niets open (factuur gecrediteerd)' : 'geen termijnen meer en nooit gefactureerd')
            : (betaaldExcl > EPS
              ? `alle abonnementen geannuleerd; wat voor de sale betaald is (${betaaldExcl.toFixed(2)} excl.) dekt al de eerdere bonus(sen) van deze sale`
              : 'alle abonnementen geannuleerd en niets betaald'));
      } else {
        voorstel = 'aanpassen'; voorstelBedrag = verdiend;
        reden = `afgerond met minder betaald dan de basis: naar verhouding ${verdiend.toFixed(2)} (klant betaalde ${betaaldExcl.toFixed(2)} excl. btw voor de sale)`;
      }

      uit.push({
        bonus_id: b.id,
        status: b.status,
        bedrag: amount,
        ontvanger_id: b.sales_user_id,
        ontvanger_naam: ontvanger?.full_name || ontvanger?.email || null,
        ontvanger_rol: ontvanger?.role || null,
        customer_id: g.cust,
        klant_naam: klant.naam || null,
        is_test: !!klant.is_test,
        deal_id: b.deal_id,
        deal_bron: deal?.source || null,
        deal_ref: deal?.quote_reference || null,
        sale_deal_id: g.sale,
        sale_ref: saleDeal?.quote_reference || null,
        sale_verkoper_id: verkoperSale,
        sale_verkoper_naam: verkoperSale ? (profielen.get(verkoperSale)?.full_name || null) : null,
        soort: soortAanb,
        abonnementen: groepSubsLijst.map((s) => ({ id: s.id, deal_id: s.deal_id, status: s.status, term_count: s.term_count, amount: r2(s.amount), start_date: s.start_date || null, soort: s.soort || null })),
        abonnement_status: !groepSubsLijst.length ? 'geen' : (lopendAbo ? 'actief' : (nietGeannuleerd ? 'afgelopen' : 'geannuleerd')),
        pct: m.pct,
        basis: m.basis,
        betaald_excl_sale: betaaldExcl,
        open_excl_sale: openExcl,
        verdiend,
        nog_niet_verdiend: b.status === 'voided' ? 0 : r2(Math.max(0, amount - verdiend)),
        max_haalbaar: maxHaalbaar,
        dubbel,
        facturen: factuurRegels,
        onbekende_facturen: onbekend.map((i) => ({ id: i.id, nummer: i.invoice_number || null, totaal: r2(i.amount_total), betaald: r2(betaaldBedrag(i)) })),
        signalen,
        controleren: signalen.some((x) => /systeemaccount|niet zeker|zonder offerte|niet aan een sale|niet in Teamleader|al uitbetaald|ander klantrecord/.test(x)),
        voorstel, reden,
        voorstel_bedrag: voorstelBedrag,
        voorstel_ontvanger_id: voorstelOntvanger,
        beslissing: beslissingen.get(b.id) || null,
        toekenning: m.toek,
        created_at: b.created_at || null,
      });
    }
  }
  return uit;
}

/**
 * Totalen die de dashboards tonen. `verdiend_open` = verdiend en nog niet
 * uitbetaald (status pending/earned/invoiced) — dat is wat er effectief
 * openstaat. `nog_niet_verdiend` = wat pas meetelt als er betaald wordt.
 */
export function totalen(stand, { zonderTest = true } = {}) {
  const t = { verdiend_open: 0, nog_niet_verdiend: 0, uitbetaald: 0, aantal_actief: 0, bonus_bedrag_actief: 0 };
  for (const s of stand) {
    if (zonderTest && s.is_test) continue;
    if (!ACTIEF.has(s.status)) continue;
    t.aantal_actief += 1;
    t.bonus_bedrag_actief += s.bedrag;
    if (NOG_NIET_UITBETAALD.has(s.status)) {
      t.verdiend_open += s.verdiend;
      t.nog_niet_verdiend += s.nog_niet_verdiend;
    } else if (s.status === 'paid') t.uitbetaald += s.bedrag;
  }
  for (const k of Object.keys(t)) if (k !== 'aantal_actief') t[k] = r2(t[k]);
  return t;
}

// ── Laden ───────────────────────────────────────────────────────────────
async function inStukken(db, tabel, kolommen, kolom, ids, extra = (q) => q) {
  const lijst = [...new Set((ids || []).filter(Boolean))];
  const uit = [];
  for (let i = 0; i < lijst.length; i += 150) {
    const { data, error } = await extra(db.from(tabel).select(kolommen).in(kolom, lijst.slice(i, i + 150)));
    if (error) throw new Error(`${tabel}: ${error.message}`);
    uit.push(...(data || []));
  }
  return uit;
}

/** Beslissingen + handmatige toekenningen uit agent_audit_log (fail-soft). */
export async function laadBeslissingen(db) {
  const beslissingen = new Map(); const toekenningen = new Map();
  try {
    const { data, error } = await db.from('agent_audit_log')
      .select('action, payload, triggered_by, created_at')
      .in('action', [AUDIT_BESLISSING, AUDIT_TOEKENNING])
      .order('created_at', { ascending: true })
      .limit(5000);
    if (error) { console.warn('[sales-bonus-stand] beslissingen:', error.message); return { beslissingen, toekenningen }; }
    for (const r of data || []) {
      const p = r.payload || {};
      if (!p.bonus_id) continue;
      if (r.action === AUDIT_TOEKENNING) {
        toekenningen.set(p.bonus_id, { reden: p.reden || null, telt_volledig: !!p.telt_volledig, basis: p.basis ?? null, door: r.triggered_by || null, op: r.created_at });
      } else {
        beslissingen.set(p.bonus_id, { beslissing: p.beslissing, reden: p.reden || null, oud: p.oud || null, nieuw: p.nieuw || null, door: r.triggered_by || null, op: r.created_at });
      }
    }
  } catch (e) { console.warn('[sales-bonus-stand] beslissingen:', e?.message || e); }
  return { beslissingen, toekenningen };
}

/**
 * Laad alles en reken. Filters: bonusIds, salesUserId, metVoided.
 * @returns {Promise<{ stand: Array, totalen: object }>}
 */
export async function laadBonusStand(db, { bonusIds = null, salesUserId = null, metVoided = false } = {}) {
  let q = db.from('bonuses')
    .select('id, deal_id, sales_user_id, amount, status, created_at, earned_at, paid_at, voided_at, void_reason, clawback_pending')
    .order('created_at', { ascending: true }).limit(5000);
  if (bonusIds && bonusIds.length) q = q.in('id', bonusIds);
  if (salesUserId) q = q.eq('sales_user_id', salesUserId);
  if (!metVoided) q = q.neq('status', 'voided');
  const { data: bonussen, error } = await q;
  if (error) throw new Error('bonuses: ' + error.message);
  if (!bonussen?.length) return { stand: [], totalen: totalen([]) };

  const dealKol = 'id, customer_id, sales_user_id, source, status, tl_quotation_status, tl_quotation_accepted_at, created_at, archived_at, reservation_fee_invoice_id, quote_reference, total_amount';
  const bonusDeals = await inStukken(db, 'deals', dealKol, 'id', bonussen.map((b) => b.deal_id));
  const custIds = [...new Set(bonusDeals.map((d) => d.customer_id).filter(Boolean))];
  const deals = await inStukken(db, 'deals', dealKol, 'customer_id', custIds);
  for (const d of bonusDeals) if (!deals.some((x) => x.id === d.id)) deals.push(d);
  const subs = [];
  const dealIds = deals.map((d) => d.id);
  for (let i = 0; i < dealIds.length; i += 150) {
    subs.push(...await laadSubsMetSoort(db, dealIds.slice(i, i + 150), 'id, deal_id, teamleader_subscription_id, start_date, end_date, status, term_count, amount, created_at, postponed_months, original_start_date'));
  }
  const factKol = 'id, customer_id, deal_id, tl_subscription_id, tl_invoice_id, invoice_number, amount_total, amount_paid, vat_amount, credited_amount, status, issue_date, due_date, paid_date, created_at';
  const facturen = await inStukken(db, 'invoices', factKol, 'customer_id', custIds);
  // Ook facturen met deal_id op deze deals maar op een ander klantrecord.
  const viaDeal = await inStukken(db, 'invoices', factKol, 'deal_id', dealIds);
  for (const f of viaDeal) if (!facturen.some((x) => x.id === f.id)) facturen.push(f);
  const klantRijen = await inStukken(db, 'customers', 'id, first_name, last_name, company_name, is_company, is_test', 'id', custIds);
  const klanten = new Map(klantRijen.map((c) => [c.id, {
    naam: c.is_company ? (c.company_name || null) : ([c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.company_name || null),
    is_test: !!c.is_test,
  }]));
  const userIds = new Set(bonussen.map((b) => b.sales_user_id));
  for (const d of deals) if (d.sales_user_id) userIds.add(d.sales_user_id);
  const profielRijen = await inStukken(db, 'profiles', 'id, full_name, email, role', 'id', [...userIds]);
  const profielen = new Map(profielRijen.map((p) => [p.id, p]));

  const regCtx = await loadRegelingContext(db, custIds);
  let mentorSales = new Map();
  try {
    const parents = await inStukken(db, 'mentor_ledger_entries', 'customer_id, source_quote_id, status', 'customer_id', custIds,
      (x) => x.eq('entry_type', 'bonus').is('parent_entry_id', null));
    const attrs = await loadAttributions(db, { customerIds: custIds });
    mentorSales = commissieSalesVan(parents, attrs.list || []);
  } catch (e) { console.warn('[sales-bonus-stand] mentorcommissie-sales:', e?.message || e); }

  const betalingen = new Map();
  if (regCtx.incasso.length && facturen.length) {
    try {
      const pays = await inStukken(db, 'payments', 'invoice_id, amount, payment_date', 'invoice_id', facturen.map((f) => f.id));
      for (const p of pays) {
        if (!betalingen.has(p.invoice_id)) betalingen.set(p.invoice_id, []);
        betalingen.get(p.invoice_id).push(p);
      }
    } catch (e) { console.warn('[sales-bonus-stand] betalingen:', e?.message || e); }
  }
  let configs = [];
  try {
    const { data } = await db.from('sales_bonus_configs').select('user_id, percentage, threshold_amount, active_from, active_until');
    configs = data || [];
  } catch (_) { /* standaard 3% */ }
  const { beslissingen, toekenningen } = await laadBeslissingen(db);

  const stand = berekenBonusStand({ bonussen, deals, subs, facturen, regCtx, mentorSales, betalingen, klanten, profielen, configs, beslissingen, toekenningen });
  return { stand, totalen: totalen(stand) };
}
