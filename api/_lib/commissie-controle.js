// api/_lib/commissie-controle.js
//
// CONTROLESCHERM mentorcommissie (PR 5, 3 nov 2026) — Mentoren › Commissies ›
// Controle. Alleen LEZEN, geen enkele correctie.
//
// Per sale (alle events, toewijzingen en trajecten): event, mentoren,
// klantstatus (incasso), betaald, vrijgegeven, werkelijk uitbetaald, wat het
// zou moeten zijn, verschil, en de afwijkingen. "Zou moeten zijn" rekent
// EXACT zoals de factuurmotor (releaseProportionalForPaidAmount): dezelfde
// sale-regel (factuurVanSale, met soort abonnement en koppelregel), dezelfde
// incassostop (incassoVoor + betaaldVoor), per mentor
//   doel = oorspronkelijke commissie × min(1, betaald / basis).
// Vrijgegeven = children vrijgegeven/uitbetaald (+ de parent zelf in de oude
// flow). Werkelijk uitbetaald: zie commissie-uitbetaald.js.
//
// Afwijkingen (code → uitleg):
//   te_veel_vrijgegeven        grootboek vrijgegeven > doel (verrekening loopt)
//   achter                     doel > grootboek vrijgegeven (motor moet nog draaien)
//   rapport_te_veel / _te_weinig  wat het rapport uitkeert wijkt > € 0,50 af van het doel
//                              (het rapport rekent per betaalde TERMIJN, de factuurmotor
//                              op het betaalde BEDRAG — kleine verschillen zijn normaal)
// Rapportkant (computeBonusOverview per mentor = de bron van het mentorrapport):
//   rapport_vrijgegeven  = wat het rapport voor deze sale uitkeert of zal uitkeren
//   in_definitief_rapport = deel dat al in een goedgekeurd/uitbetaald rapport zat
//   werkelijk_uitbetaald = idem, rapport uitbetaald of goedgekeurd t/m de grens
//   geen_commissie             event-sale (getekende deal, aanwezige mentoren) zonder grootboekregel
//   soort_ontbreekt            abonnement van de sale zonder soort (overgangsregel)
//   niet_gekoppelde_betaling   betaalde factuur zonder deal/abonnement die bij geen sale kan
//   factuur_te_veel_betaald    amount_paid > factuurbedrag op een factuur van de sale
//   traject_niet_omgezet       handmatig traject zonder factuurmotor
//   status_achter              werkelijk uitbetaald, status nog goedgekeurd/vrijgegeven
//   vrijgegeven_niet_in_rapport vrijgegeven zonder factuurcheck, in geen rapport

import {
  loadAttributions, attributionIdOf, maakSaleScope, factuurVanSale, commissieSalesVan, isGetekendDeal,
} from './commissie-toewijzing.js';
import { loadRegelingContext, koppelDeal, incassoVoor, incassoStatusVoor, betaaldVoor, isConcept } from './commissie-regeling.js';
import { betaaldBedrag } from './factuur-betaald.js';
import { laadSubsMetSoort } from './subscription-soort.js';
import { huidigeStatus } from './klant-incassostatus.js';
import { laadUitbetaaldTot, regelStand } from './commissie-uitbetaald.js';
import { isTrajectTermKey, isTrajectParentKey } from './cash-traject-omzetten.js';
import { customerDisplayName } from './customer-name.js';
import { computeBonusOverview } from '../mentor-bonus-overview.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.01;

export const AFWIJKING_LABEL = {
  te_veel_vrijgegeven: 'Te veel vrijgegeven (grootboek)',
  rapport_te_veel: 'Rapport geeft meer dan het zou moeten',
  rapport_te_weinig: 'Rapport geeft minder dan het zou moeten',
  achter: 'Grootboek loopt achter',
  geen_commissie: 'Sale zonder commissie',
  soort_ontbreekt: 'Soort abonnement ontbreekt',
  niet_gekoppelde_betaling: 'Betaling bij geen sale',
  factuur_te_veel_betaald: 'Factuur te veel betaald',
  traject_niet_omgezet: 'Traject niet omgezet',
  status_achter: 'Uitbetaald, status loopt achter',
  vrijgegeven_niet_in_rapport: 'Vrijgegeven, in geen rapport',
};

async function alle(db, tabel, kolommen, bouw) {
  const out = [];
  for (let van = 0; ; van += 1000) {
    let q = db.from(tabel).select(kolommen);
    if (bouw) q = bouw(q);
    const { data, error } = await q.range(van, van + 999);
    if (error) throw new Error(`${tabel}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const inChunks = async (ids, fn) => {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...(await fn(ids.slice(i, i + 150))));
  return out;
};

/**
 * Puur: één sale-rij uit zijn parents + context. Geëxporteerd voor tests.
 */
export function rekenSale({ parents, kids, facturen, scope, customerId, dealId, incassoRijen = [], betalingen = new Map(), payoutById = new Map(), uitbetaaldTot }) {
  const incasso = incassoVoor(incassoRijen, customerId, dealId);
  const sinds = incasso ? String(incasso.sinds).slice(0, 10) : null;
  const vanSale = dealId ? facturen.filter((inv) => factuurVanSale(inv, dealId, scope, customerId)) : [];
  const betaald = round2(vanSale.reduce((t, inv) => t + (sinds ? betaaldVoor(inv, betalingen.get(inv.id), sinds) : betaaldBedrag(inv)), 0));
  const afw = new Set();
  if (vanSale.some((inv) => (Number(inv.amount_paid) || 0) > (Number(inv.amount_total) || 0) + 0.005)) afw.add('factuur_te_veel_betaald');
  if (dealId && scope.zonderSoort(dealId).length) afw.add('soort_ontbreekt');

  const perMentor = [];
  let commissie = 0, doel = 0, vrij = 0, werkelijk = 0, statusUit = 0, nietInRapport = 0;
  for (const p of parents) {
    const geannuleerd = p.status === 'geannuleerd';
    const eigenKids = kids.filter((k) => k.parent_entry_id === p.id);
    const vrijRegels = eigenKids.filter((k) => ['vrijgegeven', 'uitbetaald'].includes(k.status));
    if (['vrijgegeven', 'uitbetaald'].includes(p.status)) vrijRegels.push(p);
    const original = geannuleerd ? 0 : round2(p.original_amount != null ? p.original_amount : (Number(p.amount) || 0) + eigenKids.reduce((t, k) => t + (Number(k.amount) || 0), 0));
    const basis = Number(p.basis) || 0;
    const d = geannuleerd || basis <= 0 ? 0 : round2(original * Math.min(1, betaald / basis));
    const v = round2(vrijRegels.reduce((t, k) => t + (Number(k.amount) || 0), 0));
    let w = 0, su = 0, nr = 0;
    for (const k of vrijRegels) {
      const stand = regelStand(k, payoutById, uitbetaaldTot);
      if (stand === 'uitbetaald') { w += Number(k.amount) || 0; su += Number(k.amount) || 0; }
      else if (stand === 'uitbetaald_status_achter') w += Number(k.amount) || 0;
      else if (stand === 'niet_in_rapport' && isTrajectTermKey(k.idempotency_key)) nr += Number(k.amount) || 0;
    }
    commissie += original; doel += d; vrij += v; werkelijk += w; statusUit += su; nietInRapport += nr;
    perMentor.push({ mentor_user_id: p.mentor_user_id, status: p.status, commissie: original, doel: d, vrijgegeven: v, werkelijk_uitbetaald: round2(w), verschil: round2(v - d) });
  }
  const verschil = round2(vrij - doel);
  if (verschil > EPS) afw.add('te_veel_vrijgegeven');
  if (verschil < -EPS) afw.add('achter');
  if (round2(werkelijk - statusUit) > EPS) afw.add('status_achter');
  if (nietInRapport > EPS) afw.add('vrijgegeven_niet_in_rapport');
  return {
    betaald, commissie: round2(commissie), zou_moeten_zijn: round2(doel), vrijgegeven: round2(vrij),
    werkelijk_uitbetaald: round2(werkelijk), status_uitbetaald: round2(statusUit),
    verschil_status_werkelijkheid: round2(werkelijk - statusUit), vrijgegeven_niet_in_rapport: round2(nietInRapport),
    verschil, incasso_stop: sinds, afwijkingen: [...afw], per_mentor: perMentor,
    facturen: vanSale.map((i) => ({ id: i.id, nummer: i.invoice_number || null, bedrag: round2(i.amount_total), betaald: round2(betaaldBedrag(i)), status: i.status, due_date: i.due_date || null })),
  };
}

export async function commissieControle(db) {
  const [parentsAlle, attrs0] = await Promise.all([
    alle(db, 'mentor_ledger_entries', 'id, mentor_user_id, event_id, attendee_id, customer_id, basis, pct, amount, original_amount, status, source_quote_id, idempotency_key, attribution_id, released_at, payout_id, created_at',
      (q) => q.eq('entry_type', 'bonus').is('parent_entry_id', null)),
    Promise.resolve(null),
  ]);
  void attrs0;
  // Niet omgezette trajecttermijnen (customer_id NULL) apart.
  const oudeTraject = parentsAlle.filter((e) => isTrajectTermKey(e.idempotency_key));
  const parents = parentsAlle.filter((e) => !isTrajectTermKey(e.idempotency_key));
  const custIds = [...new Set(parents.map((p) => p.customer_id).filter(Boolean))];
  const kids = parents.length ? await inChunks(parents.map((p) => p.id), (ids) => alle(db, 'mentor_ledger_entries',
    'id, parent_entry_id, amount, status, idempotency_key, payout_id, released_at', (q) => q.in('parent_entry_id', ids))) : [];

  // Event-sales zonder commissie: deelnemer met een getekende deal op een
  // event met aanwezige mentoren, zonder enige grootboekregel.
  const attendees = await alle(db, 'event_attendees', 'id, event_id, customer_id, deal_id, first_name, last_name, status, bonus_excluded, is_test',
    (q) => q.not('deal_id', 'is', null));
  const metParent = new Set(parentsAlle.map((p) => p.attendee_id).filter(Boolean));
  const kandidaten = attendees.filter((a) => !metParent.has(a.id) && !a.bonus_excluded && !a.is_test);
  const allCust = [...new Set([...custIds, ...kandidaten.map((a) => a.customer_id).filter(Boolean)])];

  const [deals, invoices, customers, events, attrs, regCtx, uitbetaaldTot] = await Promise.all([
    allCust.length ? inChunks(allCust, (ids) => alle(db, 'deals', 'id, customer_id, tl_quotation_status, tl_quotation_accepted_at, created_at, archived_at', (q) => q.in('customer_id', ids))) : [],
    allCust.length ? inChunks(allCust, (ids) => alle(db, 'invoices', 'id, customer_id, deal_id, tl_subscription_id, invoice_number, amount_total, amount_paid, credited_amount, status, due_date, paid_date, created_at', (q) => q.in('customer_id', ids))) : [],
    allCust.length ? inChunks(allCust, (ids) => alle(db, 'customers', 'id, is_company, company_name, first_name, last_name, email, is_test', (q) => q.in('id', ids))) : [],
    alle(db, 'events', 'id, title, starts_at'),
    loadAttributions(db, { customerIds: custIds }),
    loadRegelingContext(db, allCust),
    laadUitbetaaldTot(db),
  ]);
  const subs = await laadSubsMetSoort(db, deals.map((d) => d.id), 'id, deal_id, teamleader_subscription_id, start_date, status, term_count');
  const salesPerKlant = commissieSalesVan(parents, attrs.list || []);
  const scope = maakSaleScope({ deals, subs, commissieSales: salesPerKlant });
  const facturen = invoices.filter((i) => !isConcept(i));
  for (const inv of facturen) inv._k = koppelDeal(inv, regCtx, salesPerKlant);
  const betalingen = new Map();
  if (regCtx.incasso.length) {
    const ids = facturen.filter((f) => regCtx.incasso.some((m) => m.customer_id === f.customer_id)).map((f) => f.id);
    for (const p of ids.length ? await inChunks(ids, (c) => alle(db, 'payments', 'invoice_id, amount, payment_date', (q) => q.in('invoice_id', c))) : []) {
      if (!betalingen.has(p.invoice_id)) betalingen.set(p.invoice_id, []);
      betalingen.get(p.invoice_id).push(p);
    }
  }
  const payoutIds = [...new Set([...kids, ...parentsAlle].map((k) => k.payout_id).filter(Boolean))];
  const payouts = payoutIds.length ? await inChunks(payoutIds, (ids) => alle(db, 'mentor_payouts', 'id, status, period_month', (q) => q.in('id', ids))) : [];
  const payoutById = new Map(payouts.map((p) => [p.id, p]));
  const mentorIds = [...new Set(parentsAlle.map((p) => p.mentor_user_id).filter(Boolean))];
  const tms = mentorIds.length ? await alle(db, 'team_members', 'user_id, name', (q) => q.in('user_id', mentorIds)) : [];
  const naamMentor = new Map(tms.map((t) => [t.user_id, t.name]));
  const custById = new Map(customers.map((c) => [c.id, c]));
  const eventById = new Map(events.map((e) => [e.id, e]));
  const factPerKlant = new Map();
  for (const f of facturen) { if (!factPerKlant.has(f.customer_id)) factPerKlant.set(f.customer_id, []); factPerKlant.get(f.customer_id).push(f); }

  // Groeperen per sale: toewijzing = eigen sale; anders deal (of deelnemer).
  const groepen = new Map();
  for (const p of parents) {
    const a = attributionIdOf(p);
    const key = a ? 'attr:' + a : 'deal:' + (p.source_quote_id || ('att:' + (p.attendee_id || p.id)));
    if (!groepen.has(key)) groepen.set(key, { key, attribution_id: a, deal_id: p.source_quote_id || null, customer_id: p.customer_id, event_id: p.event_id, parents: [] });
    groepen.get(key).parents.push(p);
  }

  const rijen = [];
  for (const g of groepen.values()) {
    const r = rekenSale({ parents: g.parents, kids, facturen: factPerKlant.get(g.customer_id) || [], scope, customerId: g.customer_id, dealId: g.deal_id,
      incassoRijen: regCtx.incasso, betalingen, payoutById, uitbetaaldTot });
    const st = huidigeStatus(regCtx.incasso, g.customer_id);
    const traject = g.parents.some((p) => isTrajectParentKey(p.idempotency_key));
    const losseBetaald = (factPerKlant.get(g.customer_id) || []).filter((inv) => inv._k?.onbekend && betaaldBedrag(inv) > 0);
    if (losseBetaald.length) r.afwijkingen.push('niet_gekoppelde_betaling');
    rijen.push({
      sleutel: g.key, bron: g.attribution_id ? 'toewijzing' : (traject ? 'traject' : 'event'),
      customer_id: g.customer_id, klant: customerDisplayName(custById.get(g.customer_id), '(klant)'),
      deal_id: g.deal_id, event_id: g.event_id, event: eventById.get(g.event_id)?.title || null,
      mentoren: [...new Set(g.parents.map((p) => naamMentor.get(p.mentor_user_id) || p.mentor_user_id))],
      klantstatus: { status: st.status, label: st.label, sinds: st.sinds },
      incasso_status: incassoStatusVoor(regCtx.incasso, g.customer_id, g.deal_id) ? st.label : null,
      basis: round2(g.parents[0]?.basis), pct: g.parents[0]?.pct != null ? Number(g.parents[0].pct) : null,
      geannuleerd: g.parents.every((p) => p.status === 'geannuleerd'),
      ...r,
    });
  }

  // Event-sales zonder commissie.
  const mentorsPerEvent = new Map();
  if (kandidaten.length) {
    const evIds = [...new Set(kandidaten.map((a) => a.event_id))];
    const ems = await inChunks(evIds, (ids) => alle(db, 'event_mentors', 'event_id, was_present', (q) => q.in('event_id', ids)));
    for (const m of ems) if (m.was_present) mentorsPerEvent.set(m.event_id, (mentorsPerEvent.get(m.event_id) || 0) + 1);
  }
  const dealById = new Map(deals.map((d) => [d.id, d]));
  for (const a of kandidaten) {
    const d = dealById.get(a.deal_id);
    if (!d || !isGetekendDeal(d) || d.archived_at) continue;
    if (!(mentorsPerEvent.get(a.event_id) > 0)) continue;
    if (custById.get(a.customer_id)?.is_test) continue;
    const r = rekenSale({ parents: [], kids: [], facturen: factPerKlant.get(a.customer_id) || [], scope, customerId: a.customer_id, dealId: a.deal_id, incassoRijen: regCtx.incasso, betalingen, payoutById, uitbetaaldTot });
    rijen.push({
      sleutel: 'geen:' + a.id, bron: 'event', customer_id: a.customer_id,
      klant: customerDisplayName(custById.get(a.customer_id), `${a.first_name || ''} ${a.last_name || ''}`.trim() || '(klant)'),
      deal_id: a.deal_id, event_id: a.event_id, event: eventById.get(a.event_id)?.title || null, mentoren: [],
      klantstatus: { status: 'actief', label: 'Actief' }, basis: null, pct: null, geannuleerd: false,
      ...r, afwijkingen: ['geen_commissie'], deelnemer_status: a.status,
      uitleg: `Getekende deal, ${mentorsPerEvent.get(a.event_id)} aanwezige mentor(en), deelnemer staat op "${a.status}" — er is geen commissie aangemaakt.`,
    });
  }

  // Niet omgezette trajecten (oude termijnregels zonder parent).
  if (oudeTraject.length) {
    const tIds = [...new Set(oudeTraject.map((e) => /^cashtraject:([0-9a-f-]{36}):/i.exec(e.idempotency_key)?.[1]).filter(Boolean))];
    const trajecten = tIds.length ? await alle(db, 'mentor_cash_trajects', 'id, client_label, status, event_id, bonus_total, total_amount', (q) => q.in('id', tIds)) : [];
    for (const t of trajecten) {
      const regels = oudeTraject.filter((e) => e.idempotency_key.startsWith(`cashtraject:${t.id}:`));
      const vrij = round2(regels.filter((e) => ['vrijgegeven', 'uitbetaald'].includes(e.status)).reduce((s, e) => s + Number(e.amount || 0), 0));
      let w = 0, nr = 0;
      for (const e of regels) {
        const s = regelStand(e, payoutById, uitbetaaldTot);
        if (s === 'uitbetaald' || s === 'uitbetaald_status_achter') w += Number(e.amount) || 0;
        else if (s === 'niet_in_rapport') nr += Number(e.amount) || 0;
      }
      rijen.push({
        sleutel: 'traject:' + t.id, bron: 'traject', customer_id: null, klant: t.client_label, deal_id: null, event_id: t.event_id,
        event: eventById.get(t.event_id)?.title || null,
        mentoren: [...new Set(regels.map((e) => naamMentor.get(e.mentor_user_id) || e.mentor_user_id))],
        klantstatus: { status: 'onbekend', label: 'geen klant gekoppeld' }, basis: round2(t.total_amount), pct: null, geannuleerd: false,
        betaald: null, commissie: round2(t.bonus_total), zou_moeten_zijn: null, vrijgegeven: vrij, werkelijk_uitbetaald: round2(w),
        status_uitbetaald: 0, verschil_status_werkelijkheid: round2(w), vrijgegeven_niet_in_rapport: round2(nr), verschil: null,
        afwijkingen: ['traject_niet_omgezet', ...(w > EPS ? ['status_achter'] : []), ...(nr > EPS ? ['vrijgegeven_niet_in_rapport'] : [])],
        traject_status: t.status, per_mentor: [], facturen: [],
        uitleg: 'Handmatig traject zonder klant: geen factuurcheck mogelijk. Omzetten via docs/sql-migrations/2026-11-03-cashtraject-naar-factuurmotor.sql.',
      });
    }
  }

  // Rapportkant: per mentor het overzicht (dezelfde bron als het rapport).
  const perSaleRapport = await rapportPerSale(db, mentorIds, uitbetaaldTot);
  for (const r of rijen) {
    const rp = r.deal_id ? perSaleRapport.get(r.deal_id) : null;
    if (r.bron === 'traject' && !r.deal_id) continue;
    r.rapport_vrijgegeven = rp ? round2(rp.vrijgegeven) : 0;
    r.in_definitief_rapport = rp ? round2(rp.definitief) : 0;
    r.rapport_werkelijk_uitbetaald = rp ? round2(rp.werkelijk) : 0;
    r.rapport_status_uitbetaald = rp ? round2(rp.statusUit) : 0;
    if (r.zou_moeten_zijn != null && !r.afwijkingen.includes('geen_commissie')) {
      const dv = round2(r.rapport_vrijgegeven - r.zou_moeten_zijn);
      r.verschil_rapport = dv;
      if (dv > 0.5) r.afwijkingen.push('rapport_te_veel');
      if (dv < -0.5) r.afwijkingen.push('rapport_te_weinig');
    }
    // Werkelijk uitbetaald = rapportkant (de echte betaling); verschil status.
    r.werkelijk_uitbetaald = r.rapport_werkelijk_uitbetaald;
    r.verschil_status_werkelijkheid = round2(r.rapport_werkelijk_uitbetaald - r.rapport_status_uitbetaald);
    r.afwijkingen = r.afwijkingen.filter((a) => a !== 'status_achter');
    if (r.verschil_status_werkelijkheid > EPS) r.afwijkingen.push('status_achter');
  }

  rijen.sort((a, b) => (b.afwijkingen.length > 0) - (a.afwijkingen.length > 0) || Math.abs(b.verschil || 0) - Math.abs(a.verschil || 0) || String(a.klant).localeCompare(String(b.klant)));
  const som = (k) => round2(rijen.reduce((t, r) => t + (Number(r[k]) || 0), 0));
  return {
    rijen,
    totalen: {
      sales: rijen.length, met_afwijking: rijen.filter((r) => r.afwijkingen.length).length,
      commissie: som('commissie'), zou_moeten_zijn: som('zou_moeten_zijn'), vrijgegeven: som('vrijgegeven'),
      rapport_vrijgegeven: som('rapport_vrijgegeven'), in_definitief_rapport: som('in_definitief_rapport'),
      werkelijk_uitbetaald: som('werkelijk_uitbetaald'), status_uitbetaald: som('status_uitbetaald'),
      verschil_status_werkelijkheid: som('verschil_status_werkelijkheid'), vrijgegeven_niet_in_rapport: som('vrijgegeven_niet_in_rapport'),
      te_veel_vrijgegeven: round2(rijen.reduce((t, r) => t + Math.max(0, r.verschil || 0), 0)),
      achter: round2(rijen.reduce((t, r) => t + Math.max(0, -(r.verschil || 0)), 0)),
    },
    uitbetaald_tot: uitbetaaldTot,
    labels: AFWIJKING_LABEL,
  };
}

/**
 * Rapportkant per sale (deal_id): per mentor computeBonusOverview — dezelfde
 * bron als het mentorrapport. Termijnen met uitbetaald_in zaten al in een
 * definitief rapport (goedgekeurd/uitbetaald); verrekende termijnen tellen
 * niet. Oude trajectregels: hun bedrag staat in verrekening.reeds_in_rapport.
 */
/**
 * Puur: telt één sale uit het overzicht van één mentor op bij de rapportkant.
 * Geëxporteerd voor tests.
 *
 * Oude trajectregels (verrekening.reeds_in_rapport) zaten al in een rapport en
 * tellen als werkelijk uitbetaald. Hun STATUS telt als uitbetaald voor het deel
 * dat in het grootboek op 'uitbetaald' staat (reeds_status_uitbetaald). Vóór
 * 6 nov telde dat deel nooit mee als status uitbetaald, waardoor het scherm
 * "status loopt achter" toonde terwijl de regels en de rapporten juni–september
 * al op uitbetaald stonden. Een overzicht zonder dat veld (oude vorm) valt
 * terug op het oude gedrag.
 */
export function telRapportSale(acc0, c, uid, rapportStatus, tot) {
  const acc = acc0 || { vrijgegeven: 0, definitief: 0, werkelijk: 0, statusUit: 0 };
  acc.vrijgegeven += Number(c.vrijgegeven_rapport) || 0;
  for (const t of c.termijnen || []) {
    if (t.status !== 'betaald' || !t.uitbetaald_in) continue;
    const bedrag = (Number(t.amount) || 0) - (Number(t.verrekend) || 0);
    if (bedrag <= 0) continue;
    acc.definitief += bedrag;
    const rp = rapportStatus.get(`${uid}|${t.uitbetaald_in}`);
    if (rp?.status === 'uitbetaald') { acc.werkelijk += bedrag; acc.statusUit += bedrag; }
    else if (rp?.status === 'goedgekeurd' && tot && t.uitbetaald_in <= tot) acc.werkelijk += bedrag;
  }
  const reeds = Number(c.verrekening?.reeds_in_rapport) || 0;
  if (reeds > 0) {
    acc.definitief += reeds;
    acc.werkelijk += reeds;
    acc.statusUit += Math.min(reeds, Math.max(0, Number(c.verrekening?.reeds_status_uitbetaald) || 0));
  }
  return acc;
}

async function rapportPerSale(db, mentorIds, uitbetaaldTot) {
  const uit = new Map();
  if (!mentorIds.length) return uit;
  const rapporten = await alle(db, 'mentor_payouts', 'mentor_user_id, period_month, status', (q) => q.in('mentor_user_id', mentorIds));
  const rapportStatus = new Map(rapporten.map((r) => [`${r.mentor_user_id}|${String(r.period_month).slice(0, 7)}`, r]));
  const tot = String(uitbetaaldTot || '').slice(0, 7);
  for (const uid of mentorIds) {
    let o;
    try { o = await computeBonusOverview(uid); } catch (e) { console.warn('[commissie-controle] overzicht', uid, e?.message || e); continue; }
    for (const ev of o.per_event || []) {
      for (const c of ev.sales || []) {
        if (!c.deal_id || c.is_cash_traject) continue;
        uit.set(c.deal_id, telRapportSale(uit.get(c.deal_id), c, uid, rapportStatus, tot));
      }
    }
  }
  return uit;
}
