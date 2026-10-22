// api/_lib/commissie-regeling.js
//
// Mentorcommissie bij wanbetalers: regeling na creditering, conceptfacturen
// en incasso. Pure functies + fail-soft loaders. Gebruikt door de
// vrijgave-engine (mentor-ledger-engine.js), het bonus-overzicht
// (mentor-bonus-overview.js) en de cockpit (commissie-core.js).
//
// ── 1. REGELING NA CREDITERING ───────────────────────────────────────────
// Maxim crediteert de open facturen (dunning_credited_debt) en maakt nieuwe
// facturen volgens een regeling. Die nieuwe facturen hebben geen deal_id en
// geen tl_subscription_id. Ze horen bij de sale waarvan de facturen
// gecrediteerd werden:
//   - handmatige keuze in commissie_factuur_koppeling wint (deal_id NULL =
//     bewust bij geen sale);
//   - anders, als de klant precies één commissie-sale heeft: die (auto, niets
//     wordt weggeschreven);
//   - anders: onbekend → cockpit "Niet gekoppelde betaling".
// Basis blijft de oorspronkelijke dealwaarde. Gecrediteerd telt niet als
// betaald, de vervangende facturen wel. De vrijgave is gecapt op de
// oorspronkelijke commissie; is de regeling lager (korting), dan krijgt de
// mentor commissie in verhouding tot wat effectief betaald is
// (pct × betaald / basis).
//
// ── 2. CONCEPTFACTUREN ───────────────────────────────────────────────────
// Een conceptfactuur (o.a. de incassofactuur voor het bureau) telt NOOIT:
// niet als betaald, niet als verwacht, niet als achterstallig, niet in de
// koppelregel.
//
// ── 3. INCASSO ───────────────────────────────────────────────────────────
// mentor_commissie_incasso: vanaf `sinds` is de klant (of één sale) niet meer
// voor de mentor. Betalingen met datum >= sinds tellen niet, ook niet als
// het bureau later geld binnenhaalt. Wat al vrijgegeven/uitbetaald is blijft
// (forward-only). Het grootboek wordt NIET aangeraakt: elke lezer laat de
// betalingen vanaf `sinds` gewoon weg. Opheffen = de markering eindigt; de
// volgende vrijgave-run haalt in wat sinds betaald is.

import { betaaldBedrag, isVolledigGecrediteerd } from './factuur-betaald.js';
import { isSchemaOntbreekt } from './commissie-toewijzing.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const isConcept = (inv) => String(inv?.status || '').toLowerCase() === 'concept';
const datum = (d) => (d ? String(d).slice(0, 10) : null);

function ontbreekt(err) {
  if (isSchemaOntbreekt(err)) return true;
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return ['42P01', 'PGRST205'].includes(code)
    || /mentor_commissie_incasso|commissie_factuur_koppeling/i.test(msg);
}

/**
 * Kredieten, handmatige koppelingen en actieve incassomarkeringen voor een
 * set klanten. Elk deel fail-soft (lege set bij fout of ontbrekende tabel).
 */
export async function loadRegelingContext(db, customerIds = []) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  const ctx = {
    krediet: new Map(),     // customer_id → { eerste: 'YYYY-MM-DD', invoiceIds: Set }
    handmatig: new Map(),   // invoice_id  → { deal_id|null, bron }
    incasso: [],            // actieve markeringen
    incassoOk: false,
    koppelOk: false,
  };
  if (!ids.length) return { ...ctx, incassoOk: true, koppelOk: true };

  try {
    const { data, error } = await db.from('dunning_credited_debt')
      .select('customer_id, invoice_id, credited_on').in('customer_id', ids);
    if (error) console.warn('[commissie-regeling] kredieten:', error.message);
    for (const r of data || []) {
      if (!r.customer_id) continue;
      const k = ctx.krediet.get(r.customer_id) || { eerste: null, invoiceIds: new Set() };
      const d = datum(r.credited_on);
      if (d && (!k.eerste || d < k.eerste)) k.eerste = d;
      if (r.invoice_id) k.invoiceIds.add(r.invoice_id);
      ctx.krediet.set(r.customer_id, k);
    }
  } catch (e) { console.warn('[commissie-regeling] kredieten:', e?.message || e); }

  try {
    const { data, error } = await db.from('commissie_factuur_koppeling')
      .select('invoice_id, customer_id, deal_id, bron').in('customer_id', ids);
    if (error) { if (!ontbreekt(error)) console.warn('[commissie-regeling] koppeling:', error.message); }
    else {
      ctx.koppelOk = true;
      for (const r of data || []) ctx.handmatig.set(r.invoice_id, { deal_id: r.deal_id || null, bron: r.bron || 'handmatig' });
    }
  } catch (e) { console.warn('[commissie-regeling] koppeling:', e?.message || e); }

  try {
    const { data, error } = await db.from('mentor_commissie_incasso')
      .select('id, customer_id, deal_id, sinds, reden, bron, gezet_op, opgeheven_op').in('customer_id', ids);
    if (error) { if (!ontbreekt(error)) console.warn('[commissie-regeling] incasso:', error.message); }
    else {
      ctx.incassoOk = true;
      ctx.incasso = (data || []).filter((r) => !r.opgeheven_op);
    }
  } catch (e) { console.warn('[commissie-regeling] incasso:', e?.message || e); }

  return ctx;
}

/** Klanten met gecrediteerde schuld: hun regelingsfacturen hebben aandacht nodig. */
export const heeftKrediet = (ctx, customerId) => !!(customerId && ctx?.krediet?.has(customerId));

/**
 * Is dit een regelingsfactuur? Klant met gecrediteerde schuld, factuur zonder
 * deal en zonder abonnement, geen concept, niet zelf gecrediteerd, gemaakt op
 * of na de eerste creditering.
 */
export function isRegelingsFactuur(inv, ctx) {
  if (!inv || isConcept(inv) || inv.deal_id || inv.tl_subscription_id) return false;
  const k = ctx?.krediet?.get(inv.customer_id);
  if (!k) return false;
  if (k.invoiceIds.has(inv.id) || isVolledigGecrediteerd(inv)) return false;
  const gemaakt = datum(inv.created_at) || datum(inv.due_date);
  return !k.eerste || !gemaakt || gemaakt >= k.eerste;
}

/**
 * Bij welke sale hoort deze factuur voor de commissie?
 * @param {Map<string, Set<string>>} salesPerKlant customer_id → deal-ids met commissie
 * @returns {undefined | { deal: string|null, bron: 'handmatig'|'auto' } | { onbekend: true }}
 *   undefined = geen koppelregel van toepassing (gewone factuur).
 */
export function koppelDeal(inv, ctx, salesPerKlant) {
  if (!inv || isConcept(inv)) return undefined;
  const h = ctx?.handmatig?.get(inv.id);
  if (h) return { deal: h.deal_id || null, bron: 'handmatig' };
  if (!isRegelingsFactuur(inv, ctx)) return undefined;
  const sales = salesPerKlant?.get(inv.customer_id);
  if (sales && sales.size === 1) return { deal: [...sales][0], bron: 'auto' };
  return { onbekend: true };
}

/** Actieve incassomarkering voor (klant, sale): specifiek voor de sale gaat voor klantbreed. */
export function incassoVoor(markeringen, customerId, dealId) {
  if (!customerId || !markeringen?.length) return null;
  const actief = markeringen.filter((m) => m.customer_id === customerId && !m.opgeheven_op);
  return actief.find((m) => dealId && m.deal_id === dealId)
    || actief.find((m) => !m.deal_id)
    || null;
}

/**
 * Wat er van deze factuur betaald werd VÓÓR `sinds` (incasso). Met
 * betalingsregels: hun som vóór sinds (max het betaalde bedrag). Zonder: het
 * hele betaalde bedrag als paid_date < sinds, anders 0 (onbekende datum →
 * niet meetellen; wat al vrijgegeven is blijft sowieso staan).
 */
export function betaaldVoor(inv, betalingen, sinds) {
  if (isConcept(inv)) return 0;
  const b = betaaldBedrag(inv);
  if (!sinds) return b;
  if (b <= 0) return 0;
  const rijen = (betalingen || []).filter((p) => p && p.payment_date && Number(p.amount) > 0);
  if (rijen.length) {
    const som = rijen.filter((p) => datum(p.payment_date) < sinds).reduce((t, p) => t + (Number(p.amount) || 0), 0);
    return round2(Math.min(b, som));
  }
  return inv.paid_date && datum(inv.paid_date) < sinds ? b : 0;
}

/**
 * Termijnschema op basis van de ECHTE facturen (voor sales met een regeling
 * na creditering). Elke factuur is een termijn met commissie in verhouding
 * tot haar netto bedrag (totaal − gecrediteerd) t.o.v. de basis. Volledig
 * gecrediteerd → "gecrediteerd → vervangen door regeling", € 0. Daarna de
 * nog niet gefactureerde termijnen van lopende abonnementen. Gecapt op het
 * aandeel; wat overblijft is niet gedekt (korting / geen schema).
 *
 * @returns {{ termijnen: Array<{ due_date, inv, aandeel, gecrediteerd, vervangen, gepland }>, niet_gedekt: number }}
 */
export function regelingTermijnen({ facturen, basis, aandeel, subs = [], perTermijnIncl, cyclusMaanden, addMonthsIso }) {
  const b = Number(basis) || 0;
  const totaal = Number(aandeel) || 0;
  const lijst = (facturen || []).filter((i) => !isConcept(i))
    .slice().sort((x, y) => String(x.due_date || '9999').localeCompare(String(y.due_date || '9999')));
  const termijnen = [];
  let som = 0;
  const neem = (ruw) => {
    const vrij = Math.max(0, round2(totaal - som));
    const a = Math.min(vrij, round2(ruw));
    som = round2(som + a);
    return a;
  };
  let laatsteDue = null;
  for (const inv of lijst) {
    if (inv.due_date && (!laatsteDue || inv.due_date > laatsteDue)) laatsteDue = inv.due_date;
    if (isVolledigGecrediteerd(inv)) {
      termijnen.push({ due_date: inv.due_date || null, inv, aandeel: 0, gecrediteerd: true, vervangen: true, gepland: false });
      continue;
    }
    const netto = Math.max(0, (Number(inv.amount_total) || 0) - (Number(inv.credited_amount) || 0));
    termijnen.push({ due_date: inv.due_date || null, inv, aandeel: b > 0 ? neem(totaal * netto / b) : 0, gecrediteerd: false, vervangen: false, gepland: false });
  }
  // Nog niet gefactureerde termijnen van lopende abonnementen (na de laatste factuur).
  const actief = (subs || []).filter((s) => String(s.status || '').toLowerCase() !== 'cancelled');
  const gepland = [];
  for (const s of actief) {
    const n = Number(s.term_count) || 0;
    const per = perTermijnIncl(s);
    if (!n || !(per > 0) || !s.start_date) continue;
    const cyc = cyclusMaanden(s.billing_cycle);
    for (let k = 0; k < n; k++) {
      const due = addMonthsIso(s.start_date, k * cyc);
      if (due && (!laatsteDue || due > laatsteDue)) gepland.push({ due, per });
    }
  }
  gepland.sort((x, y) => x.due.localeCompare(y.due));
  for (const g of gepland) {
    if (som >= totaal - 0.005) break;
    termijnen.push({ due_date: g.due, inv: null, aandeel: b > 0 ? neem(totaal * g.per / b) : 0, gecrediteerd: false, vervangen: false, gepland: true });
  }
  return { termijnen, niet_gedekt: Math.max(0, round2(totaal - som)) };
}
