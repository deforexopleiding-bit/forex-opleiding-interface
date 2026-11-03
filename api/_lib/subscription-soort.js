// api/_lib/subscription-soort.js
//
// SOORT ABONNEMENT — bij welke sale hoort een abonnement voor de commissie?
//
// Beslissing Maxim (3 nov 2026). Elk abonnement heeft een soort:
//   origineel        het abonnement van de sale zelf.
//   aanpassing       een wijziging van die sale: uitstel, lager bedrag of
//                    regeling (aanpassing_type). Blijft bij DEZELFDE sale.
//   incasso_regeling de termijnen van een regeling na incasso. Blijft bij
//                    dezelfde sale; telt op wat effectief bij ons binnenkomt.
//   nieuwe_offerte   een nieuwe sale. Telt NOOIT mee voor een oude event-bonus,
//                    tenzij die nieuwe sale zelf toegewezen werd (verlenging).
// origineel / aanpassing / incasso_regeling → sale_deal_id = de oorspronkelijke
// sale; de oorspronkelijke commissie blijft het maximum (de cap zit in de
// factuurmotor: nooit meer dan original_amount).
//
// Dit vervangt de 92-dagenregel van maakSaleScope (commissie-toewijzing.js):
// een uitstel van meer dan 92 dagen laat de commissie niet meer wegvallen,
// omdat het abonnement expliciet aan zijn sale hangt.
//
// Kolommen (docs/sql-migrations/2026-11-03-subscriptions-soort.sql):
//   subscriptions.soort, aanpassing_type, sale_deal_id, soort_bron,
//   soort_gezet_door, soort_gezet_op. Fail-soft: zonder migratie leest alles
//   zoals voorheen (soort onbekend → overgangsregel).

export const SOORTEN = ['origineel', 'aanpassing', 'incasso_regeling', 'nieuwe_offerte'];
export const AANPASSING_TYPES = ['uitstel', 'lager_bedrag', 'regeling'];
export const SOORT_LABEL = {
  origineel: 'Origineel',
  aanpassing: 'Aanpassing',
  incasso_regeling: 'Incasso-regeling',
  nieuwe_offerte: 'Nieuwe offerte',
};
export const AANPASSING_LABEL = { uitstel: 'uitstel', lager_bedrag: 'lager bedrag', regeling: 'regeling' };
export const SOORT_KOLOMMEN = 'soort, aanpassing_type, sale_deal_id';

const GETEKEND = new Set(['accepted', 'signed']);
const isGetekend = (d) => !!d && !d.archived_at
  && (GETEKEND.has(String(d.tl_quotation_status || '').toLowerCase()) || !!d.tl_quotation_accepted_at);
const isGhost = (d) => String(d?.tl_quotation_status || '').toLowerCase() === 'no_quotation';
const datum = (v) => (v ? String(v).slice(0, 10) : null);
const getekendOp = (d) => datum(d.tl_quotation_accepted_at || d.created_at);
const plusDagen = (iso, n) => {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Kolom bestaat (nog) niet: migratie niet gedraaid. */
export function soortKolomOntbreekt(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '');
  return ['42703', 'PGRST204'].includes(code) || /(soort|aanpassing_type|sale_deal_id)/i.test(msg) && /does not exist|could not find|schema cache/i.test(msg);
}

/**
 * Validatie voor aanmaken/wijzigen. Geeft { ok, waarde } of { ok:false, fout }.
 *
 * @param {object} invoer        { soort, aanpassing_type?, sale_deal_id? }
 * @param {object} ctx
 * @param {string|null} ctx.eigenDealId  deal waarop het abonnement staat (null = nieuwe deal)
 * @param {string|null} ctx.customerId
 * @param {Array} ctx.dealsVanKlant      deals van de klant (id, customer_id, tl_quotation_status, ...)
 */
export function valideerSoort(invoer, { eigenDealId = null, customerId = null, dealsVanKlant = [] } = {}) {
  const soort = String(invoer?.soort || '').trim();
  if (!SOORTEN.includes(soort)) {
    return { ok: false, fout: 'Kies de soort abonnement: origineel, aanpassing, incasso-regeling of nieuwe offerte.' };
  }
  let aanpassing_type = invoer?.aanpassing_type ? String(invoer.aanpassing_type) : null;
  if (soort === 'aanpassing') {
    if (!AANPASSING_TYPES.includes(aanpassing_type)) return { ok: false, fout: 'Kies het soort aanpassing: uitstel, lager bedrag of regeling.' };
  } else {
    aanpassing_type = null;
  }
  let sale = invoer?.sale_deal_id ? String(invoer.sale_deal_id) : null;
  if (soort === 'nieuwe_offerte') {
    // Een nieuwe offerte is haar eigen sale.
    sale = eigenDealId || null;
  } else if (soort === 'origineel' && !sale) {
    const eigen = dealsVanKlant.find((d) => d.id === eigenDealId);
    if (eigen && !isGhost(eigen)) sale = eigen.id;
  }
  if (soort === 'origineel' && !sale && !eigenDealId) {
    // Nieuw abonnement op een nieuwe deal (standalone): het is zelf de sale;
    // de caller vult sale_deal_id met de nieuwe deal.
    return { ok: true, waarde: { soort, aanpassing_type, sale_deal_id: null } };
  }
  if (soort !== 'nieuwe_offerte') {
    if (!sale) return { ok: false, fout: 'Kies bij welke sale dit abonnement hoort.' };
    const d = dealsVanKlant.find((x) => x.id === sale);
    if (!d) return { ok: false, fout: 'De gekozen sale hoort niet bij deze klant.' };
    if (customerId && d.customer_id && d.customer_id !== customerId) return { ok: false, fout: 'De gekozen sale hoort niet bij deze klant.' };
    if (isGhost(d) && sale !== eigenDealId) return { ok: false, fout: 'Kies een getekende sale (offerte), geen geïmporteerd abonnement.' };
  }
  return { ok: true, waarde: { soort, aanpassing_type, sale_deal_id: sale } };
}

/**
 * Bij welke sale hoort dit abonnement? Puur.
 *   undefined → soort onbekend: de caller past de overgangsregel toe.
 *   null      → bewust bij geen sale (soort gezet maar zonder sale).
 *   string    → deal-id van de sale.
 */
export function saleVanSoort(sub) {
  if (!sub || !sub.soort) return undefined;
  if (sub.soort === 'nieuwe_offerte') return sub.sale_deal_id || sub.deal_id || null;
  return sub.sale_deal_id || null;
}

/**
 * Backfillvoorstel voor een bestaand abonnement. Puur; gokt niet.
 * @returns {{ soort, aanpassing_type, sale_deal_id, zeker: boolean, reden: string }}
 */
export function stelSoortVoor(sub, { deals = [] } = {}) {
  const eigen = deals.find((d) => d.id === sub.deal_id) || null;
  const custId = eigen?.customer_id || null;
  const getekend = deals.filter((d) => d.customer_id === custId && isGetekend(d))
    .sort((a, b) => String(getekendOp(a)).localeCompare(String(getekendOp(b))));
  const leeg = (reden, extra = {}) => ({ soort: null, aanpassing_type: null, sale_deal_id: null, zeker: false, reden, ...extra });

  // Abonnement op een echte (getekende) offerte: de sale is die offerte zelf.
  if (eigen && isGetekend(eigen)) {
    const eerder = getekend.filter((d) => d.id !== eigen.id && getekendOp(d) < getekendOp(eigen));
    return eerder.length
      ? { soort: 'nieuwe_offerte', aanpassing_type: null, sale_deal_id: eigen.id, zeker: true, reden: 'eigen getekende offerte; de klant had al een eerdere sale' }
      : { soort: 'origineel', aanpassing_type: null, sale_deal_id: eigen.id, zeker: true, reden: 'eigen getekende offerte' };
  }
  if (eigen && !isGhost(eigen)) return leeg('offerte niet getekend of gearchiveerd');
  const start = datum(sub.start_date);
  if (!start) return leeg('geen startdatum');
  const kandidaten = getekend.filter((d) => getekendOp(d) <= plusDagen(start, 31));
  if (!kandidaten.length) return leeg('geen getekende sale vóór de start');
  const laatste = kandidaten[kandidaten.length - 1];
  if (kandidaten.length > 1) return leeg('meerdere getekende sales — kies er één', { kandidaten: kandidaten.map((d) => d.id) });
  const uitgesteld = (Number(sub.postponed_months) || 0) > 0 || !!sub.original_start_date;
  if (uitgesteld) return { soort: 'aanpassing', aanpassing_type: 'uitstel', sale_deal_id: laatste.id, zeker: true, reden: 'uitgesteld abonnement van de enige sale' };
  if (start <= plusDagen(getekendOp(laatste), 92)) {
    return { soort: 'origineel', aanpassing_type: null, sale_deal_id: laatste.id, zeker: true, reden: 'geïmporteerd abonnement van de enige sale (start ≤ 92 d na tekenen)' };
  }
  return leeg('start meer dan 92 dagen na tekenen: uitstel, regeling of nieuwe offerte?', { kandidaten: [laatste.id] });
}

/**
 * Abonnementen van deze deals mét soort-kolommen; valt terug op de
 * basiskolommen zolang de migratie niet gedraaid is.
 */
export async function laadSubsMetSoort(db, dealIds, basisKolommen, { order = null } = {}) {
  const ids = [...new Set((dealIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const vraag = (kolommen) => {
    let q = db.from('subscriptions').select(kolommen).in('deal_id', ids);
    if (order) q = q.order(order.col, order.opts || {});
    return q;
  };
  let { data, error } = await vraag(`${basisKolommen}, ${SOORT_KOLOMMEN}`);
  if (error && soortKolomOntbreekt(error)) ({ data, error } = await vraag(basisKolommen));
  if (error) throw new Error('subscriptions: ' + error.message);
  return data || [];
}

/**
 * Soort voor een lijst nieuwe abonnementen (aanmaakflow). Per abonnement
 * `soort` (+ aanpassing_type, sale_deal_id), of één keer op body-niveau
 * (`commissie_soort`). Eerst de vorm (zonder DB), dan per klant.
 */
export function soortInvoerVan(sub, body) {
  if (sub && sub.soort) return { soort: sub.soort, aanpassing_type: sub.aanpassing_type || null, sale_deal_id: sub.sale_deal_id || null };
  const top = body?.commissie_soort;
  if (top && typeof top === 'object' && top.soort) return { soort: top.soort, aanpassing_type: top.aanpassing_type || null, sale_deal_id: top.sale_deal_id || null };
  return { soort: null };
}

export async function valideerSoortenVoorKlant(db, { customerId, eigenDealId = null, invoer = [] }) {
  let deals = [];
  if (customerId) {
    const { data, error } = await db.from('deals')
      .select('id, customer_id, tl_quotation_status, tl_quotation_accepted_at, created_at, archived_at')
      .eq('customer_id', customerId);
    if (error) throw new Error('deals: ' + error.message);
    deals = data || [];
  }
  const uit = [];
  for (const i of invoer) {
    const r = valideerSoort(i, { eigenDealId, customerId, dealsVanKlant: deals });
    if (!r.ok) return { ok: false, fout: r.fout };
    uit.push(r.waarde);
  }
  return { ok: true, waarden: uit };
}
