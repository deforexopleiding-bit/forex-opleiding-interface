// api/_lib/commissie-rekenregel.js
//
// DE REKENREGEL VAN DE MENTORCOMMISSIE (beslissing Maxim, 9 nov 2026).
// Pure functies, geen DB. Eén bron voor rapport, grootboek (factuurmotor),
// mentorzicht en controlescherm.
//
//   Elke betaalde factuur van de sale geeft
//       commissie × betaald bedrag / basis,
//   nooit meer dan de commissie min wat al vrijgegeven of uitbetaald is.
//
// Er is GEEN tweede berekening met vaste termijnbedragen meer: een
// aanbetaling, een losse factuur, abonnementen met verschillende bedragen,
// facturen buiten het termijnschema (de 13e factuur) — elke factuur telt voor
// haar eigen bedrag. Een gecrediteerde factuur telt nooit als betaald.
//
// AFGESLOTEN MAANDEN BLIJVEN EXACT ZOALS ZE ZIJN. Geen correcties voor het
// verleden, ook niet in het nadeel van het bedrijf: geen inhaal, geen
// correctievoorstellen, geen verborgen tekort. De caller geeft mee wat al in
// afgesloten rapporten zat (oude projectie, ongewijzigd) en welke facturen
// daar al in zaten; die facturen tellen hier niet opnieuw. Een betaling in
// een maand die al afgesloten is maar die in geen rapport zat, blijft op nul
// (status 'afgesloten').
//
// Een maand is open zolang het rapport dat haar uitbetaalt niet definitief is
// (commissie-maand.js maakAfsluiting). Een betaling telt in de maand van haar
// betaaldatum — exact zoals het rapport M de bonus van M-1 neemt.

import { betaaldBedrag, telAlsBetaald, isVolledigGecrediteerd, EPS } from './factuur-betaald.js';
import { ym, addYm } from './commissie-maand.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isConcept = (inv) => ['concept', 'draft'].includes(String(inv?.status || '').toLowerCase());

/**
 * De betaalde stukken van één factuur, elk met een datum.
 *   * betalingsregels (payments) met datum, tot het betaalde bedrag;
 *   * de rest (bv. betaald in Teamleader) op paid_date — enkel als de factuur
 *     volledig betaald is; zonder paid_date de vervaldag (zoals plaatsTermijn).
 * Een volledig gecrediteerde factuur of een concept heeft geen stukken.
 * Een deelbetaling zonder betalingsregel telt op paid_date; zonder enige datum
 * telt ze (nog) niet — ze telt zodra er een datum is.
 */
export function factuurStukken(inv, betalingen = []) {
  if (!inv || isConcept(inv) || isVolledigGecrediteerd(inv)) return [];
  const betaald = r2(betaaldBedrag(inv));
  if (betaald <= EPS) return [];
  const uit = [];
  let som = 0;
  const rijen = (betalingen || [])
    .filter((p) => p && p.payment_date && Number(p.amount) > 0)
    .sort((a, b) => String(a.payment_date).localeCompare(String(b.payment_date)));
  for (const p of rijen) {
    const a = r2(Math.min(Number(p.amount) || 0, betaald - som));
    if (a <= EPS) break;
    uit.push({ datum: String(p.payment_date).slice(0, 10), bedrag: a });
    som = r2(som + a);
  }
  const rest = r2(betaald - som);
  if (rest > EPS) {
    const paid = inv.paid_date ? String(inv.paid_date).slice(0, 10) : null;
    const datum = telAlsBetaald(inv)
      ? (paid || (uit.length ? uit[uit.length - 1].datum : null) || (inv.due_date && String(inv.due_date).slice(0, 10)) || null)
      : paid; // deelbetaling zonder betalingsregel: enkel met een betaaldatum
    if (datum) uit.push({ datum, bedrag: rest });
  }
  return uit;
}

/** Nog te betalen deel dat in de projectie verwacht wordt (totaal − gecrediteerd − gedateerd betaald). */
function verwachtDeel(inv, stukken) {
  if (!inv || isConcept(inv) || isVolledigGecrediteerd(inv)) return 0;
  const netto = Math.max(0, (Number(inv.amount_total) || 0) - (Number(inv.credited_amount) || 0));
  const gedateerd = stukken.reduce((t, s) => t + s.bedrag, 0);
  return Math.max(0, r2(netto - gedateerd));
}

/**
 * Geplande termijnen van lopende abonnementen die nog geen factuur hebben.
 * Een termijn is gedekt als een factuur van dat abonnement (tl_subscription_id)
 * in dezelfde maand vervalt.
 */
export function geplandeTermijnen({ subs = [], facturen = [], perTermijnIncl, cyclusMaanden, addMonthsIso, vanafYm = null }) {
  const uit = [];
  for (const s of subs || []) {
    if (String(s.status || '').toLowerCase() === 'cancelled') continue;
    const n = Number(s.term_count) || 0;
    const per = perTermijnIncl ? perTermijnIncl(s) : 0;
    if (!n || !(per > 0) || !s.start_date) continue;
    const cyc = cyclusMaanden ? cyclusMaanden(s.billing_cycle) : 1;
    const eigen = s.teamleader_subscription_id
      ? facturen.filter((f) => f.tl_subscription_id === s.teamleader_subscription_id)
      : [];
    // Gedekt = een factuur van dit abonnement, of een ongekoppelde factuur van
    // de sale (Teamleader koppelt niet altijd), in dezelfde maand. Liever een
    // termijn te weinig verwachten dan dubbel; komt de factuur, dan telt ze.
    const gedekt = new Set(eigen.map((f) => ym(f.due_date)).filter(Boolean));
    for (const f of facturen) if (!f.tl_subscription_id && f.due_date) gedekt.add(ym(f.due_date));
    for (let k = 0; k < n; k++) {
      const due = addMonthsIso(s.start_date, k * cyc);
      if (!due || gedekt.has(ym(due))) continue;
      // Een termijn uit een voorbije maand zonder factuur wordt niet meer
      // verwacht (nooit gefactureerd, of vervangen); komt de factuur alsnog,
      // dan telt die factuur.
      if (vanafYm && ym(due) < vanafYm) continue;
      uit.push({ due_date: due, bedrag_incl: r2(per), sub_id: s.id });
    }
  }
  return uit.sort((a, b) => a.due_date.localeCompare(b.due_date));
}

/**
 * Reken één sale (één mentor).
 *
 * @param {object} p
 * @param {number} p.commissie        oorspronkelijke commissie van deze mentor (original_amount)
 * @param {number} p.basis            bonus-basis (incl. btw)
 * @param {Array}  p.facturen         facturen van DEZE sale (factuurVanSale)
 * @param {Map}    p.betalingen       invoice_id → payments
 * @param {Array}  p.subs             abonnementen van de sale (voor geplande termijnen)
 * @param {object} p.afsluiting       maakAfsluiting() van deze mentor
 * @param {string} p.vandaag          YYYY-MM-DD
 * @param {string|null} p.incassoSinds betalingen vanaf deze datum tellen niet (bij_incasso/oninbaar)
 * @param {Set}    p.bevrorenFacturen facturen die al in een afgesloten rapport zaten (tellen niet opnieuw)
 * @param {number} p.bevrorenBedrag   wat afgesloten rapporten voor deze sale uitkeerden
 * @param {number} p.legacyAfgesloten grootboek vrijgegeven/uitbetaald vóór de open maanden
 * @param {number} p.voorschot        al uitgekeerd maar aan geen bevroren factuur toegerekend (oude trajectregels)
 * @param {Function} p.perTermijnIncl, p.cyclusMaanden, p.addMonthsIso
 * @returns {{ termijnen, stukken, ruimte, nieuw_betaald, nieuw_verwacht }}
 *   stukken = betaalde stukken in open maanden met bedrag > 0 (wat het grootboek vrijgeeft).
 */
export function rekenSaleCommissie(p) {
  const C = Math.max(0, Number(p.commissie) || 0);
  const B = Number(p.basis) || 0;
  const vandaag = p.vandaag;
  const nuYm = ym(vandaag);
  const afs = p.afsluiting || { gesloten: () => false };
  const bevroren = p.bevrorenFacturen || new Set();
  const sinds = p.incassoSinds ? String(p.incassoSinds).slice(0, 10) : null;
  const ruimteStart = Math.max(0, r2(C - Math.max(Number(p.bevrorenBedrag) || 0, Number(p.legacyAfgesloten) || 0)));
  const aandeel = (bedrag) => (B > 0 ? (C * bedrag) / B : 0);

  const facturen = (p.facturen || []).filter((f) => !isConcept(f))
    .slice().sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));

  // 1) Items: betaalde stukken, verwachte facturen, geplande termijnen.
  const betaaldItems = [];
  const verwachtItems = [];
  const vast = []; // termijnen zonder bedrag (gecrediteerd, afgesloten, incasso)
  for (const inv of facturen) {
    if (bevroren.has(inv.id)) continue;
    if (isVolledigGecrediteerd(inv)) {
      vast.push({ inv, due_date: inv.due_date || null, status: 'gecrediteerd', maand: ym(inv.due_date) });
      continue;
    }
    const stukken = factuurStukken(inv, p.betalingen?.get ? p.betalingen.get(inv.id) : []);
    for (const s of stukken) {
      const maand = ym(s.datum);
      if (afs.gesloten(maand)) { vast.push({ inv, due_date: inv.due_date, status: 'afgesloten', maand, betaald_op: s.datum, betaald: s.bedrag }); continue; }
      if (sinds && s.datum >= sinds) { vast.push({ inv, due_date: inv.due_date, status: 'incasso', maand, betaald_op: s.datum, betaald: s.bedrag }); continue; }
      betaaldItems.push({ inv, due_date: inv.due_date || s.datum, datum: s.datum, maand, betaald: s.bedrag, klant: s.bedrag, ruw: aandeel(s.bedrag) });
    }
    const rest = verwachtDeel(inv, stukken);
    if (rest > EPS) {
      if (sinds) { vast.push({ inv, due_date: inv.due_date, status: 'incasso', maand: nuYm }); continue; }
      const due = inv.due_date ? String(inv.due_date).slice(0, 10) : vandaag;
      const achter = due < vandaag;
      verwachtItems.push({ inv, due_date: due, maand: achter ? nuYm : ym(due), status: achter ? 'achterstallig' : 'open', achterstallig_sinds: achter ? due : null, klant: rest, ruw: aandeel(rest) });
    }
  }
  if (!sinds) {
    for (const g of geplandeTermijnen({ subs: p.subs, facturen, perTermijnIncl: p.perTermijnIncl, cyclusMaanden: p.cyclusMaanden, addMonthsIso: p.addMonthsIso, vanafYm: nuYm })) {
      const achter = g.due_date < vandaag;
      verwachtItems.push({ inv: null, due_date: g.due_date, maand: achter ? nuYm : ym(g.due_date), status: achter ? 'achterstallig' : 'open', gepland: true, achterstallig_sinds: achter ? g.due_date : null, klant: g.bedrag_incl, ruw: aandeel(g.bedrag_incl) });
    }
  }
  betaaldItems.sort((a, b) => a.datum.localeCompare(b.datum) || String(a.inv.id).localeCompare(String(b.inv.id)));
  verwachtItems.sort((a, b) => a.due_date.localeCompare(b.due_date));

  // 2) Verdelen: eerst het voorschot verrekenen, dan nooit boven de ruimte.
  let ruimte = ruimteStart;
  let voorschot = Math.max(0, Number(p.voorschot) || 0);
  const neem = (ruw) => {
    const v = Math.min(voorschot, ruw);
    voorschot = r2(voorschot - v);
    const a = Math.max(0, Math.min(ruimte, r2(ruw - v)));
    ruimte = r2(ruimte - a);
    return { bedrag: r2(a), verrekend: r2(v) };
  };
  const termijnen = [];
  const stukken = [];
  let nieuwBetaald = 0;
  let nieuwVerwacht = 0;
  for (const it of betaaldItems) {
    const { bedrag, verrekend } = neem(it.ruw);
    nieuwBetaald = r2(nieuwBetaald + bedrag);
    termijnen.push({
      invoice_id: it.inv.id, factuur_nummer: it.inv.invoice_number || null, due_date: it.due_date, betaald_op: it.datum,
      maand: it.maand, status: bedrag > 0 || verrekend <= 0 ? 'betaald' : 'verrekend', amount: bedrag, klant_bedrag: it.klant,
      ...(verrekend > 0 ? { verrekend } : {}), regel: 'factuur',
    });
    if (bedrag > 0) stukken.push({ invoice_id: it.inv.id, datum: it.datum, maand: it.maand, bedrag });
  }
  for (const it of verwachtItems) {
    const { bedrag, verrekend } = neem(it.ruw);
    nieuwVerwacht = r2(nieuwVerwacht + bedrag);
    termijnen.push({
      invoice_id: it.inv?.id || null, factuur_nummer: it.inv?.invoice_number || null, due_date: it.due_date,
      maand: it.maand, status: it.status, amount: bedrag, klant_bedrag: it.klant, achterstallig_sinds: it.achterstallig_sinds,
      ...(verrekend > 0 ? { verrekend } : {}), ...(it.gepland ? { gepland: true } : {}), regel: 'factuur',
    });
  }
  for (const it of vast) {
    termijnen.push({
      invoice_id: it.inv?.id || null, factuur_nummer: it.inv?.invoice_number || null, due_date: it.due_date || null,
      betaald_op: it.betaald_op || null, maand: it.maand || null, status: it.status, amount: 0, klant_bedrag: it.betaald || 0, regel: 'factuur',
      ...(it.status === 'gecrediteerd' ? { vervangen: true } : {}),
      ...(it.status === 'afgesloten' ? { uitleg: 'Betaald in een maand die al afgesloten is: geen inhaal (beslissing 9 nov 2026).' } : {}),
    });
  }
  termijnen.sort((a, b) => String(a.due_date || a.maand || '').localeCompare(String(b.due_date || b.maand || '')));
  return { termijnen, stukken, ruimte: ruimteStart, nieuw_betaald: nieuwBetaald, nieuw_verwacht: nieuwVerwacht };
}

/**
 * Wat geeft het grootboek nog vrij? Puur. Per stuk (factuur + betaaldatum) één
 * child; een stuk kan groeien (deelbetaling) → het verschil. Al vrijgegeven
 * grootboekregels in OPEN maanden met een oude sleutel (vóór deze regel) zijn
 * een pot die eerst verrekend wordt — nooit dubbel.
 *
 * @param {object} p
 * @param {string} p.parentId
 * @param {Array}  p.stukken     uit rekenSaleCommissie
 * @param {Array}  p.kinderen    children van de parent ({ idempotency_key, amount, status, released_at })
 * @param {Function} p.gesloten  (ym) → maand afgesloten?
 * @param {number} p.rest        parent.amount (nog niet vrijgegeven deel)
 * @returns {Array<{ sleutel, bedrag, released_month, stuk }>}
 */
export const STUK_PREFIX = (parentId, invoiceId, datum) => `${parentId}:stuk:${invoiceId}:${datum}:`;
export const isStukSleutel = (key) => /:stuk:[^:]+:\d{4}-\d{2}-\d{2}:\d+$/.test(String(key || ''));

export function teSchrijvenStukken({ parentId, stukken = [], kinderen = [], gesloten = () => false, rest = Infinity }) {
  const telt = (k) => ['vrijgegeven', 'uitbetaald'].includes(k.status);
  // Pot: oude grootboekregels (geen stuk-sleutel) vrijgegeven in een open maand.
  let pot = r2(kinderen.filter((k) => telt(k) && !isStukSleutel(k.idempotency_key)
    && !gesloten(k.released_at ? String(k.released_at).slice(0, 7) : null))
    .reduce((t, k) => t + (Number(k.amount) || 0), 0));
  let over = Number.isFinite(rest) ? Math.max(0, r2(rest)) : Infinity;
  const uit = [];
  for (const s of [...stukken].sort((a, b) => a.datum.localeCompare(b.datum) || String(a.invoice_id).localeCompare(String(b.invoice_id)))) {
    const prefix = STUK_PREFIX(parentId, s.invoice_id, s.datum);
    const al = r2(kinderen.filter((k) => telt(k) && String(k.idempotency_key || '').startsWith(prefix)).reduce((t, k) => t + (Number(k.amount) || 0), 0));
    const gedekt = Math.min(pot, Math.max(0, r2(s.bedrag - al)));
    pot = r2(pot - gedekt);
    let nodig = r2(s.bedrag - al - gedekt);
    if (nodig > over) nodig = r2(over);
    if (nodig <= 0.004) continue;
    over = r2(over - nodig);
    uit.push({ sleutel: prefix + Math.round(r2(al + nodig) * 100), bedrag: nodig, released_month: s.maand, stuk: s });
  }
  return uit;
}

export { addYm };
