// api/_lib/setter-commissie-core.js
//
// Setter-commissie op FACTUREN (vervangt de payments-tabel + watermark).
//
// ── REGEL ────────────────────────────────────────────────────────────────
// Commissie = pct % van elk bedrag dat ECHT binnenkwam op een factuur van een
// setter-deal (reserveringsfee, aanbetaling, elke termijn), basis incl. btw.
//   - "Echt binnen" = betaaldBedrag(inv) uit _lib/factuur-betaald.js: een
//     volledig gecrediteerde factuur telt als 0 (creditnota ≠ betaling).
//   - Factuur → deal (zelfde patroon als _lib/sales-bonus.js resolveDeal):
//       1. invoices.deal_id                                   → 'deal'
//       2. invoices.tl_subscription_id = subscriptions.teamleader_subscription_id
//          → subscriptions.deal_id                            → 'abonnement'
//       3. deals.reservation_fee_invoice_id (uuid óf TL-id)   → 'reserveringsfee'
//     Een factuur met een deal_id van een ANDERE deal is niet van ons
//     (deal_id wint, net als in resolveDeal).
//   - pct en scope uit setter_config: alleen is_active, en alleen facturen met
//     paid_date >= effective_from.
//
// ── FORWARD-ONLY RECONCILE i.p.v. WATERMARK ──────────────────────────────
// Zelfde model als de mentorbonus: geboekte commissie blijft staan, er wordt
// NOOIT teruggeboekt (geen clawback, geen negatieve regels).
//
// Per (setter, factuur):
//   ontvangen      = betaaldBedrag(inv) op het moment van de run (een
//                    volledig gecrediteerde factuur = 0, ook als een oude rij
//                    nog 'paid' + amount_paid = totaal zegt);
//   geboekte basis = Σ setter_ledger_entries.basis voor die factuur;
//   delta          = max(0, ontvangen − geboekte basis).
// Alleen als delta ≥ € 0,01 EN het commissiebedrag van die stap > 0 komt er
// één nieuwe regel bij. Een regel is dus altijd positief.
//
// De geboekte basis werkt als HOOGWATERMERK per factuur:
//   - creditnota NA boeking → ontvangen zakt onder de geboekte basis →
//     delta 0 → niets (de geboekte commissie blijft staan, er komt niets af);
//   - creditnota VÓÓR boeking → ontvangen = 0 → niets;
//   - herbetaling na een creditnota → er komt pas weer commissie bij voor
//     het deel BOVEN de eerder geboekte basis. Per factuur wordt dus nooit
//     meer basis geboekt dan het hoogste bedrag dat er ooit tegelijk als
//     ontvangen op stond → geen dubbeltelling.
//   - deelbetalingen: elke stap een regel met de (positieve) delta.
//   - geen watermark nodig: een terug-gedateerde betaling of een factuur die
//     pas later aan de deal gekoppeld wordt, wordt de volgende run gezien.
//
// Idempotentie: idempotency_key =
//   `${setter}:inv:${invoice_id}:${n}:${ontvangen_centen}`
// met n = aantal bestaande regels voor (setter, factuur). Een tweede run ziet
// delta 0 → niets. Twee gelijktijdige runs maken dezelfde sleutel → de
// UNIQUE-index laat er één door (23505 = al geboekt). Na een boeking stijgt n,
// dus een volgende stap krijgt altijd een nieuwe, unieke sleutel.
//
// Bedrag per stap = round2(nieuw × pct) − round2(oud × pct) over de basis
// (telescopisch: Σ stappen = round2(totaal × pct)); een pct-wijziging raakt
// alleen nieuw geld.
//
// Niet meegenomen (gerapporteerd als 'overgeslagen', nooit geboekt):
//   - setter zonder (actieve) setter_config;
//   - factuur betaald vóór effective_from;
//   - testfacturen (is_test);
//   - gearchiveerde deals / afgewezen offertes (isUitgeslotenDeal);
//   - betaald zonder paid_date (komt in de data niet voor; defensief).

import { betaaldBedrag, isVolledigGecrediteerd } from './factuur-betaald.js';
import { isUitgeslotenDeal, round2 } from './setter-sale-plan.js';

export const DRY_RUN_KEY = 'setter_commissie_dry_run';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v) => Number(v) || 0;

/** 'YYYY-MM-DD' van vandaag in Amsterdam. */
export function vandaagAmsterdam(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(now);
}

/**
 * Factuur → { deal, bron }. Zie de koppelregels bovenaan.
 * @returns {Map<string, { deal: object, bron: 'deal'|'abonnement'|'reserveringsfee' }>}
 */
export function koppelFacturenAanDeals({ deals = [], subs = [], invoices = [] }) {
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const dealByTlSub = new Map();
  for (const s of subs) {
    if (s.teamleader_subscription_id && dealById.has(s.deal_id)) dealByTlSub.set(s.teamleader_subscription_id, dealById.get(s.deal_id));
  }
  const dealByFee = new Map();
  for (const d of deals) if (d.reservation_fee_invoice_id) dealByFee.set(String(d.reservation_fee_invoice_id), d);

  const out = new Map();
  for (const inv of invoices) {
    const feeDeal = dealByFee.get(String(inv.id)) || (inv.tl_invoice_id ? dealByFee.get(String(inv.tl_invoice_id)) : null);
    if (inv.deal_id) {
      const d = dealById.get(inv.deal_id);
      if (d) out.set(inv.id, { deal: d, bron: feeDeal && feeDeal.id === d.id ? 'reserveringsfee' : 'deal' });
      continue; // deal_id van een andere deal → niet van deze setter
    }
    if (inv.tl_subscription_id && dealByTlSub.has(inv.tl_subscription_id)) {
      out.set(inv.id, { deal: dealByTlSub.get(inv.tl_subscription_id), bron: 'abonnement' });
      continue;
    }
    if (feeDeal) out.set(inv.id, { deal: feeDeal, bron: 'reserveringsfee' });
  }
  return out;
}

/** Commissie op een basis-stap, telescopisch afgerond (Σ stappen = round2(totaal × pct)). */
export function commissieVoorStap(oudeBasis, nieuweBasis, pct) {
  return round2(round2(n(nieuweBasis) * n(pct) / 100) - round2(n(oudeBasis) * n(pct) / 100));
}

/**
 * Wat moet er geboekt worden voor één setter? Pure functie.
 *
 * @param {object}   p
 * @param {string}   p.setterId
 * @param {object}   p.cfg            setter_config-rij (pct, is_active, effective_from) of null
 * @param {Array}    p.facturen       [{ inv, deal, bron }]
 * @param {Array}    p.bestaand       setter_ledger_entries van deze setter (invoice_id, basis, amount)
 * @returns {{ mutaties: Array, overgeslagen: Array, facturen: Array }}
 *   Elke mutatie heeft basis > 0 en amount > 0 (forward-only).
 */
export function berekenCommissieMutaties({ setterId, cfg, facturen = [], bestaand = [] }) {
  const mutaties = [];
  const overgeslagen = [];
  const perFactuur = [];
  const pct = n(cfg?.pct);
  const vanaf = cfg?.effective_from ? String(cfg.effective_from).slice(0, 10) : null;

  const bestaandPer = new Map();
  for (const e of bestaand) {
    if (!e.invoice_id) continue;
    const cur = bestaandPer.get(e.invoice_id) || { basis: 0, amount: 0, aantal: 0 };
    cur.basis = round2(cur.basis + n(e.basis));
    cur.amount = round2(cur.amount + n(e.amount));
    cur.aantal += 1;
    bestaandPer.set(e.invoice_id, cur);
  }

  for (const { inv, deal, bron } of facturen) {
    const ontvangen = round2(betaaldBedrag(inv));
    const paidDate = inv.paid_date ? String(inv.paid_date).slice(0, 10) : null;
    const al = bestaandPer.get(inv.id) || { basis: 0, amount: 0, aantal: 0 };
    const regel = {
      invoice_id: inv.id, factuurnummer: inv.invoice_number || null, deal_id: deal.id,
      customer_id: inv.customer_id || deal.customer_id || null, bron, status: inv.status || null,
      amount_total: round2(inv.amount_total), credited_amount: round2(inv.credited_amount),
      ontvangen, paid_date: paidDate, geboekte_basis: al.basis, geboekte_commissie: al.amount,
      gewenste_commissie: null, reden: null,
    };
    perFactuur.push(regel);
    const skip = (reden) => { regel.reden = reden; overgeslagen.push({ ...regel }); };

    if (inv.is_test) { skip('testfactuur'); continue; }
    if (isUitgeslotenDeal(deal)) { skip('deal_gearchiveerd_of_afgewezen'); continue; }
    if (!cfg) { skip('geen_setter_config'); continue; }
    if (!cfg.is_active) { skip('setter_config_inactief'); continue; }
    if (ontvangen > 0.005 && !paidDate) { skip('betaald_zonder_betaaldatum'); continue; }
    // Buiten de looptijd van de regeling: niets boeken.
    if (paidDate && vanaf && paidDate < vanaf) { skip('betaald_voor_effective_from'); continue; }

    // Forward-only: de geboekte basis is het hoogwatermerk.
    const hoogste = Math.max(al.basis, ontvangen);
    regel.gewenste_commissie = round2(al.amount + commissieVoorStap(al.basis, hoogste, pct));
    const deltaBasis = round2(Math.max(0, ontvangen - al.basis));
    const bedrag = commissieVoorStap(al.basis, al.basis + deltaBasis, pct);
    if (deltaBasis < 0.01 || bedrag <= 0) {
      if (al.aantal && ontvangen + 0.005 < al.basis) regel.reden = 'gecrediteerd_na_boeking_blijft_staan';
      else if (al.aantal) regel.reden = 'al_geboekt';
      else if (isVolledigGecrediteerd(inv)) regel.reden = 'gecrediteerd_geen_commissie';
      else regel.reden = 'nog_niet_betaald';
      continue;
    }

    mutaties.push({
      setter_user_id: setterId,
      deal_id: deal.id,
      customer_id: regel.customer_id,
      invoice_id: inv.id,
      payment_id: null,
      basis: deltaBasis,
      basis_incl_btw: true,
      pct,
      amount: bedrag,
      status: 'vrijgegeven',
      idempotency_key: `${setterId}:inv:${inv.id}:${al.aantal}:${Math.round(ontvangen * 100)}`,
      betaal_datum: paidDate,
      note: [
        inv.invoice_number ? `Factuur ${inv.invoice_number}` : 'Factuur',
        bron === 'reserveringsfee' ? 'reserveringsfee' : null,
      ].filter(Boolean).join(' · '),
    });
    regel.reden = 'te_boeken';
  }
  return { mutaties, overgeslagen, facturen: perFactuur };
}

/** 'YYYY-MM' waarin een ledger-regel valt: betaaldatum, anders aanmaakdatum. */
export function maandVanRegel(e) {
  const d = e?.betaal_datum || e?.created_at;
  return d ? String(d).slice(0, 7) : null;
}

/**
 * Maandoverzicht voor één setter: geboekt (grootboek) + berekend (wat de
 * facturen zeggen — gelijk aan geboekt zodra de cron draait zonder dry-run).
 */
export function maandOverzicht({ entries = [], facturen = [], pct = 0 }) {
  const m = new Map();
  const get = (ym) => {
    if (!m.has(ym)) m.set(ym, { maand: ym, ontvangen: 0, berekend: 0, geboekt: 0, uitbetaald: 0, regels: 0 });
    return m.get(ym);
  };
  for (const e of entries) {
    const ym = maandVanRegel(e);
    if (!ym) continue;
    const b = get(ym);
    b.geboekt = round2(b.geboekt + n(e.amount));
    if (e.status === 'uitbetaald') b.uitbetaald = round2(b.uitbetaald + n(e.amount));
    b.regels += 1;
  }
  for (const f of facturen) {
    if (f.gewenste_commissie == null || !f.paid_date) continue;
    const b = get(f.paid_date.slice(0, 7));
    b.ontvangen = round2(b.ontvangen + f.ontvangen);
    // Forward-only: berekend = wat er (al of straks) geboekt staat voor deze
    // factuur — een creditnota na boeking verlaagt dat niet.
    b.berekend = round2(b.berekend + n(f.gewenste_commissie));
  }
  return [...m.values()].sort((a, b) => b.maand.localeCompare(a.maand));
}

// ── DB-laag ──────────────────────────────────────────────────────────────

async function alle(q, label) {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data || [];
}

const INV_COLS = 'id, invoice_number, customer_id, deal_id, tl_invoice_id, tl_subscription_id, status, amount_total, amount_paid, credited_amount, issue_date, paid_date, is_test';

/**
 * Laad alles wat nodig is voor de commissie van de opgegeven setters (of alle
 * setters met een deal). Alleen SELECTs.
 */
export async function laadCommissieData(db, { setterIds = null } = {}) {
  let dq = db.from('deals')
    .select('id, customer_id, setter_user_id, archived_at, tl_quotation_status, reservation_fee_invoice_id, quote_reference')
    .not('setter_user_id', 'is', null);
  if (setterIds) dq = dq.in('setter_user_id', setterIds);
  const deals = await alle(dq, 'deals');
  const ids = setterIds || [...new Set(deals.map((d) => d.setter_user_id))];

  const configs = ids.length
    ? await alle(db.from('setter_config').select('user_id, pct, is_active, effective_from').in('user_id', ids), 'setter_config')
    : [];
  const dealIds = deals.map((d) => d.id);
  const subs = dealIds.length
    ? await alle(db.from('subscriptions').select('id, deal_id, status, teamleader_subscription_id').in('deal_id', dealIds), 'subscriptions')
    : [];
  const tlSubIds = [...new Set(subs.map((s) => s.teamleader_subscription_id).filter(Boolean))];
  const feeIds = deals.map((d) => d.reservation_fee_invoice_id).filter(Boolean).map(String);
  const feeUuids = feeIds.filter((x) => UUID_RE.test(x));
  const feeTl = feeIds.filter((x) => !UUID_RE.test(x));

  const delen = await Promise.all([
    dealIds.length ? alle(db.from('invoices').select(INV_COLS).in('deal_id', dealIds), 'invoices(deal)') : [],
    tlSubIds.length ? alle(db.from('invoices').select(INV_COLS).in('tl_subscription_id', tlSubIds), 'invoices(abonnement)') : [],
    feeUuids.length ? alle(db.from('invoices').select(INV_COLS).in('id', feeUuids), 'invoices(fee)') : [],
    feeTl.length ? alle(db.from('invoices').select(INV_COLS).in('tl_invoice_id', feeTl), 'invoices(fee-tl)') : [],
  ]);
  const invoices = [...new Map(delen.flat().map((i) => [i.id, i])).values()];

  const entries = ids.length
    ? await alle(db.from('setter_ledger_entries')
      .select('id, setter_user_id, invoice_id, basis, amount, status, created_at')
      .in('setter_user_id', ids), 'setter_ledger_entries')
    : [];
  return { setterIds: ids, deals, configs, subs, invoices, entries };
}

/** Combineer data → plan per setter. Pure. */
export function planCommissie(data, _opts = {}) {
  const koppeling = koppelFacturenAanDeals(data);
  const perSetter = [];
  for (const sid of data.setterIds) {
    const cfg = data.configs.find((c) => c.user_id === sid) || null;
    const facturen = [];
    for (const inv of data.invoices) {
      const k = koppeling.get(inv.id);
      if (k && k.deal.setter_user_id === sid) facturen.push({ inv, ...k });
    }
    const bestaand = data.entries.filter((e) => e.setter_user_id === sid);
    const r = berekenCommissieMutaties({ setterId: sid, cfg, facturen, bestaand });
    perSetter.push({
      setter_user_id: sid,
      config: cfg,
      deals: data.deals.filter((d) => d.setter_user_id === sid).length,
      ...r,
      te_boeken: round2(r.mutaties.reduce((s, m) => s + m.amount, 0)),
    });
  }
  return perSetter;
}

/**
 * Ledger-regels van één setter MET betaal_datum. Fail-soft vóór de migratie
 * (kolom bestaat nog niet → 42703): dan zonder, en valt de maand terug op
 * created_at.
 */
export async function laadLedgerRegels(db, setterId) {
  const basis = 'id, deal_id, customer_id, invoice_id, payment_id, basis, pct, amount, status, note, created_at, paid_at';
  const run = (cols) => db.from('setter_ledger_entries').select(cols)
    .eq('setter_user_id', setterId).order('created_at', { ascending: false }).limit(5000);
  let { data, error } = await run(basis + ', betaal_datum');
  if (error && (error.code === '42703' || /betaal_datum/.test(error.message || ''))) {
    ({ data, error } = await run(basis));
  }
  if (error) throw new Error('setter_ledger_entries: ' + error.message);
  return data || [];
}

/** Dry-run-vlag: ontbreekt de rij of faalt het lezen → dry-run AAN. */
export async function isSetterCommissieDryRun(db) {
  try {
    const { data, error } = await db.from('app_settings').select('value').eq('key', DRY_RUN_KEY).maybeSingle();
    if (error || !data) return true;
    return data.value?.enabled !== false;
  } catch {
    return true;
  }
}

/** Schrijf de mutaties (één insert per regel; 23505 = al geboekt). */
export async function boekMutaties(db, mutaties) {
  const out = { created: 0, skipped: 0, errors: [] };
  for (const m of mutaties) {
    // Forward-only vangnet: nooit een regel van <= 0 boeken.
    if (!(Number(m.amount) > 0) || !(Number(m.basis) > 0)) {
      console.error('[setter-commissie] regel <= 0 geweigerd', m.idempotency_key, m.amount);
      out.errors.push({ key: m.idempotency_key, error: 'bedrag of basis <= 0 geweigerd (forward-only)' });
      continue;
    }
    try {
      const { error } = await db.from('setter_ledger_entries').insert(m);
      if (!error) { out.created++; continue; }
      if (error.code === '23505') { out.skipped++; continue; }
      console.error('[setter-commissie] insert faalde', m.idempotency_key, error.message);
      out.errors.push({ key: m.idempotency_key, error: error.message });
    } catch (e) {
      console.error('[setter-commissie] insert exception', m.idempotency_key, e?.message || e);
      out.errors.push({ key: m.idempotency_key, error: e?.message || String(e) });
    }
  }
  return out;
}
