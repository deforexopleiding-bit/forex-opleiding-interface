// api/_lib/commissie-core.js
//
// Kern van de commissie-cockpit (Mentoren → Commissies) en de handmatige
// sale-toewijzing. De HTTP-endpoints (api/commissie-*.js) doen alleen auth +
// statuscodes; alle logica staat hier zodat ze testbaar is.
//
//   zoekOffertes        — getekende deals zoeken + bestaande commissie tonen
//   previewToewijzing   — aandeel per mentor + termijnprojectie, schrijft niets
//   opslaanToewijzing   — attribution + 1 parent per mentor + meteen vrijgave
//   annuleerToewijzing  — open parents geannuleerd; vrijgegeven blijft staan
//   commissieOverzicht  — platformbreed: KPI's, per mentor/event/sale, 12 mnd
//
// DE REGEL blijft die van de event-bonus: de mentor verdient pas wanneer de
// factuur van DEZE deal effectief betaald is (vrijgave-engine, zie
// api/_lib/commissie-toewijzing.js voor de scope op de eigen deal).

import { supabaseAdmin } from '../supabase.js';
import { computeDealTotals } from './deal-total.js';
import { betaaldBedrag, telAlsBetaald, isVolledigGecrediteerd } from './factuur-betaald.js';
import { customerDisplayName } from './customer-name.js';
import { releaseProportionalForPaidAmount } from './mentor-ledger-engine.js';
import { createNotification } from './notify.js';
import { computeBonusOverview, inclPerTerm, billingCycleMonths } from '../mentor-bonus-overview.js';
import {
  loadRegelingContext, koppelDeal, isConcept,
} from './commissie-regeling.js';
import { effectieveBetaaldatum, maakAfsluiting, plaatsTermijn } from './commissie-maand.js';
import {
  REDENEN, REDEN_LABEL, DEFAULT_PCT, aandeelPerMentor, attrIdempotencyKey, attributionIdOf,
  isSchemaOntbreekt, loadAttributions, maakSaleScope, factuurVanSale,
} from './commissie-toewijzing.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCEPTED = new Set(['accepted', 'signed']);
const OPEN_STATUSSEN = ['pending', 'wachten_op_betaling'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export class CommissieFout extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isGetekend = (d) => !!d && (ACCEPTED.has(String(d.tl_quotation_status || '').toLowerCase()) || !!d.tl_quotation_accepted_at);
const vandaag = () => new Date().toISOString().slice(0, 10);
const ym = (iso) => String(iso || '').slice(0, 7);

function addMonthsIso(isoDate, n) {
  const d = new Date(String(isoDate).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const dag = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const laatste = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dag, laatste));
  return d.toISOString().slice(0, 10);
}

async function alle(q, wat) {
  const { data, error } = await q;
  if (error) throw new Error(`${wat}: ${error.message}`);
  return data || [];
}

// ── Deal-context in één keer (geen N+1) ───────────────────────────────────────
// Voor een set deals: klanten, regels (basis), ALLE deals + subs van die
// klanten (welke factuur hoort bij welke sale — zelfde regel als de
// vrijgave-engine, zie factuurVanSale), facturen, betalingen, bestaande
// event-bonussen en toewijzingen.
async function dealContext(deals) {
  const dealIds = [...new Set(deals.map((d) => d.id))];
  const custIds = [...new Set(deals.map((d) => d.customer_id).filter(Boolean))];
  if (!dealIds.length) return null;
  const [lines, klantDeals, invoices, customers, ledger, attrs, regCtx] = await Promise.all([
    alle(supabaseAdmin.from('deal_line_items').select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat').in('deal_id', dealIds), 'deal_line_items'),
    custIds.length
      ? alle(supabaseAdmin.from('deals').select('id, customer_id, tl_quotation_status, tl_quotation_accepted_at, created_at, archived_at').in('customer_id', custIds), 'deals (klant)')
      : [],
    custIds.length
      ? alle(supabaseAdmin.from('invoices').select('id, customer_id, deal_id, tl_subscription_id, invoice_number, amount_total, amount_paid, credited_amount, status, due_date, paid_date, created_at').in('customer_id', custIds), 'invoices')
      : [],
    custIds.length
      ? alle(supabaseAdmin.from('customers').select('id, is_company, company_name, first_name, last_name, email').in('id', custIds), 'customers')
      : [],
    alle(supabaseAdmin.from('mentor_ledger_entries')
      .select('id, mentor_user_id, event_id, customer_id, source_quote_id, amount, original_amount, status, idempotency_key')
      .eq('entry_type', 'bonus').is('parent_entry_id', null).in('source_quote_id', dealIds), 'ledger'),
    loadAttributions(supabaseAdmin, { customerIds: custIds }),
    loadRegelingContext(supabaseAdmin, custIds),
  ]);
  const alleDeals = new Map(klantDeals.map((d) => [d.id, d]));
  for (const d of deals) if (!alleDeals.has(d.id)) alleDeals.set(d.id, d);
  const alleDealIds = [...alleDeals.keys()];
  const subs = alleDealIds.length
    ? await alle(supabaseAdmin.from('subscriptions').select('id, deal_id, amount, vat_percentage, line_items, term_count, billing_cycle, start_date, status, teamleader_subscription_id').in('deal_id', alleDealIds), 'subscriptions')
    : [];
  const saleScope = maakSaleScope({ deals: [...alleDeals.values()], subs });

  // Regeling na creditering: aan welke sale hangt een regelingsfactuur?
  const facturen = invoices.filter((i) => !isConcept(i)); // concept telt nooit
  if (regCtx.krediet.size || regCtx.handmatig.size) {
    const parents = await alle(supabaseAdmin.from('mentor_ledger_entries')
      .select('customer_id, source_quote_id, status')
      .eq('entry_type', 'bonus').is('parent_entry_id', null).in('customer_id', custIds), 'ledger (klant)');
    const salesPerKlant = new Map();
    for (const e of parents) {
      if (e.status === 'geannuleerd' || !e.source_quote_id || !e.customer_id) continue;
      if (!salesPerKlant.has(e.customer_id)) salesPerKlant.set(e.customer_id, new Set());
      salesPerKlant.get(e.customer_id).add(e.source_quote_id);
    }
    for (const inv of facturen) inv._k = koppelDeal(inv, regCtx, salesPerKlant);
  }

  // Betalingsregels (effectieve betaaldatum bij deelbetalingen) — fail-soft.
  const betalingen = new Map();
  const ids = facturen.map((i) => i.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 150) {
    const { data: pays, error } = await supabaseAdmin.from('payments')
      .select('invoice_id, amount, payment_date').in('invoice_id', ids.slice(i, i + 150));
    if (error) { console.warn('[commissie-core] payments:', error.message); break; }
    for (const p of pays || []) {
      if (!betalingen.has(p.invoice_id)) betalingen.set(p.invoice_id, []);
      betalingen.get(p.invoice_id).push(p);
    }
  }

  const linesByDeal = new Map();
  for (const l of lines) {
    if (!linesByDeal.has(l.deal_id)) linesByDeal.set(l.deal_id, []);
    linesByDeal.get(l.deal_id).push(l);
  }
  return {
    linesByDeal, subs, invoices: facturen, ledger, attrs, saleScope, betalingen,
    customerById: new Map(customers.map((c) => [c.id, c])),
  };
}

// Dealwaarde exact zoals events-complete-core (computeDealTotals op de regels).
function dealBasis(deal, ctx) {
  return computeDealTotals(deal, ctx.linesByDeal.get(deal.id) || []);
}

// Facturen + abonnementen van een sale: dezelfde regel als de vrijgave-engine.
function factuurenVanDeal(deal, ctx) {
  return ctx.invoices.filter((inv) => inv.customer_id === deal.customer_id && factuurVanSale(inv, deal.id, ctx.saleScope, deal.customer_id));
}
const subsVanDeal = (dealId, ctx) => ctx.saleScope.subsVan(dealId);

// Rapporten van de gekozen mentoren → welke maanden zijn al gesloten. Fail-soft.
async function afsluitingVoor(userIds) {
  if (!userIds?.length) return maakAfsluiting([]);
  const { data, error } = await supabaseAdmin.from('mentor_payouts')
    .select('id, period_month, status, generated_at').in('mentor_user_id', userIds);
  if (error) { console.warn('[commissie-core] rapporten:', error.message); return maakAfsluiting([]); }
  return maakAfsluiting(data || []);
}

/**
 * Termijnschema van één deal met het mentor-aandeel per termijn.
 * Bron: de subs van de sale (aanbetaling + termijnen, incl. TL-abonnementen op
 * een ghost-deal), echte facturen voor vervaldatum + betaalstatus. Facturen
 * zonder abonnementskoppeling vullen de vrije termijnen van het abonnement
 * met hetzelfde termijnbedrag (anders het enige abonnement). Zonder sub: de
 * facturen van de sale zelf; zonder facturen: één termijn "bij betaling".
 *
 * Maand van betaling (PR5, api/_lib/commissie-maand.js), zoals het rapport:
 * betaald → betaalmaand; onbetaald + vervallen → huidige maand
 * (achterstallig); open → vervalmaand; betaald in een al gesloten maand →
 * inhaal (telt in geen maand, gaat via een correctie).
 */
export function termijnSchema({ subs, facturen, basis, aandeel, startFallback = null, betalingen = new Map(), afsluiting = maakAfsluiting([]), vandaagIso = vandaag() }) {
  const actief = (subs || []).filter((s) => String(s.status || '').toLowerCase() !== 'cancelled');
  const pool = (actief.length ? actief : (subs || [])).slice()
    .sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));
  const termijnen = [];
  const lijst = (facturen || []).filter((i) => !isConcept(i));
  const subWaarde = pool.reduce((s, x) => s + inclPerTerm(x) * (Number(x.term_count) || 0), 0);
  if (pool.length && subWaarde > 0) {
    const tlIds = new Set(pool.map((s) => s.teamleader_subscription_id).filter(Boolean));
    const perSub = new Map(pool.map((s) => [s, lijst.filter((i) => i.tl_subscription_id && i.tl_subscription_id === s.teamleader_subscription_id)]));
    // Facturen zonder (bekende) abonnementskoppeling: op vervaldatum verdelen.
    const los = lijst.filter((i) => !i.tl_subscription_id || !tlIds.has(i.tl_subscription_id))
      .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
    for (const inv of los) {
      const vrij = pool.filter((s) => perSub.get(s).length < (Number(s.term_count) || 0));
      const bedrag = Number(inv.amount_total) || 0;
      const past = vrij.find((s) => Math.abs(inclPerTerm(s) - bedrag) <= Math.max(1, inclPerTerm(s) * 0.02))
        || (vrij.length === 1 ? vrij[0] : null);
      if (past) perSub.get(past).push(inv);
    }
    for (const s of pool) {
      const n = Number(s.term_count) || 0;
      const per = inclPerTerm(s);
      const invs = perSub.get(s).sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
      const cyc = billingCycleMonths(s.billing_cycle);
      for (let i = 0; i < n; i++) {
        const inv = invs[i] || null;
        const due = inv?.due_date || (s.start_date ? addMonthsIso(s.start_date, i * cyc) : null);
        termijnen.push({ due_date: due, bedrag_klant: round2(per), aandeel: aandeel * per / subWaarde, inv });
      }
    }
  } else if (lijst.length) {
    const tot = lijst.reduce((s, i) => s + (Number(i.amount_total) || 0), 0) || basis || 1;
    for (const inv of lijst.slice().sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')))) {
      termijnen.push({ due_date: inv.due_date || null, bedrag_klant: round2(inv.amount_total), aandeel: aandeel * (Number(inv.amount_total) || 0) / tot, inv });
    }
  } else {
    termijnen.push({ due_date: startFallback, bedrag_klant: round2(basis), aandeel, inv: null, schema_onbekend: true });
  }
  termijnen.sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));
  // Afronding: centen, rest op de laatste termijn zodat de som exact klopt.
  let som = 0;
  termijnen.forEach((t, i) => {
    t.index = i + 1;
    t.aandeel = i === termijnen.length - 1 ? round2(aandeel - som) : round2(t.aandeel);
    som = round2(som + t.aandeel);
    const inv = t.inv;
    delete t.inv;
    const gecrediteerd = !!(inv && isVolledigGecrediteerd(inv));
    const betaald = !!(inv && !gecrediteerd && (Number(inv.amount_total) || 0) > 0 && telAlsBetaald(inv));
    const plaats = plaatsTermijn({
      dueYmd: t.due_date || vandaagIso, betaald, gecrediteerd,
      betaaldatum: betaald ? effectieveBetaaldatum(inv, betalingen.get(inv.id)) : null,
      vandaag: vandaagIso, afsluiting,
    });
    t.status = plaats.status;
    t.maand = plaats.maand;
    t.telt = plaats.telt;
    t.inhaal = plaats.inhaal;
    t.betaald_op = plaats.betaaldatum || null;
    t.achterstallig_sinds = plaats.achterstallig_sinds || null;
  });
  return termijnen;
}

/**
 * Maand-aggregaat van termijnen: [{ month, betaald, verwacht, achterstallig }].
 * Elke termijn telt in zijn maand van betaling (t.maand, zie termijnSchema);
 * inhaal telt in geen maand.
 */
export function perMaand(termijnen) {
  const m = new Map();
  for (const t of termijnen || []) {
    if (t.status === 'gecrediteerd' || t.telt === false) continue;
    const k = t.maand || ym(t.due_date);
    if (!k) continue;
    const cel = m.get(k) || { month: k, betaald: 0, verwacht: 0, achterstallig: 0 };
    if (t.status === 'betaald') cel.betaald = round2(cel.betaald + t.aandeel);
    else cel.verwacht = round2(cel.verwacht + t.aandeel);
    if (t.status === 'achterstallig') cel.achterstallig = round2(cel.achterstallig + t.aandeel);
    m.set(k, cel);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// Bestaande commissie op een deal: event-bonus en/of actieve toewijzing.
function bestaandeCommissie(dealId, ctx, eventTitles = new Map()) {
  const parents = ctx.ledger.filter((e) => e.source_quote_id === dealId && e.status !== 'geannuleerd');
  const eventBonus = parents.filter((e) => !attributionIdOf(e));
  const toewijzing = ctx.attrs.list.find((a) => a.deal_id === dealId && a.status === 'actief') || null;
  const eventIds = [...new Set(eventBonus.map((e) => e.event_id).filter(Boolean))];
  return {
    event_bonus: eventBonus.length ? {
      aantal_mentoren: new Set(eventBonus.map((e) => e.mentor_user_id)).size,
      bedrag: round2(eventBonus.reduce((s, e) => s + Number(e.original_amount ?? e.amount ?? 0), 0)),
      events: eventIds.map((id) => ({ event_id: id, title: eventTitles.get(id) || null })),
    } : null,
    toewijzing: toewijzing ? {
      id: toewijzing.id, reden: toewijzing.reden, pct: Number(toewijzing.pct),
      aantal_mentoren: new Set(parents.filter((e) => attributionIdOf(e) === toewijzing.id).map((e) => e.mentor_user_id)).size,
    } : null,
  };
}

// ── Zoeken ────────────────────────────────────────────────────────────────────
export async function zoekOffertes({ q, limit = 15 } = {}) {
  const s = String(q || '').trim().replace(/[%,()]/g, ' ').trim();
  if (s.length < 2) return { ok: true, resultaten: [] };
  const kolommen = 'id, customer_id, total_amount, discount_percentage, sale_type, quote_reference, tl_quotation_status, tl_quotation_accepted_at, created_at, archived_at';
  let deals = [];
  if (UUID_RE.test(s)) {
    deals = await alle(supabaseAdmin.from('deals').select(kolommen).eq('id', s), 'deals (id)');
  } else {
    const custs = await alle(supabaseAdmin.from('customers').select('id')
      .or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,company_name.ilike.%${s}%,email.ilike.%${s}%`).limit(200), 'customers');
    const custIds = custs.map((c) => c.id);
    const [viaKlant, viaNummer] = await Promise.all([
      custIds.length ? alle(supabaseAdmin.from('deals').select(kolommen).in('customer_id', custIds).is('archived_at', null).limit(500), 'deals (klant)') : [],
      alle(supabaseAdmin.from('deals').select(kolommen).ilike('quote_reference', `%${s}%`).is('archived_at', null).limit(50), 'deals (nummer)'),
    ]);
    const map = new Map();
    for (const d of [...viaKlant, ...viaNummer]) map.set(d.id, d);
    deals = [...map.values()];
  }
  deals = deals.filter((d) => !d.archived_at && isGetekend(d))
    .sort((a, b) => String(b.tl_quotation_accepted_at || b.created_at || '').localeCompare(String(a.tl_quotation_accepted_at || a.created_at || '')))
    .slice(0, Math.max(1, Math.min(50, limit)));
  if (!deals.length) return { ok: true, resultaten: [] };

  const ctx = await dealContext(deals);
  const eventIds = [...new Set(ctx.ledger.map((e) => e.event_id).filter(Boolean))];
  const evs = eventIds.length ? await alle(supabaseAdmin.from('events').select('id, title').in('id', eventIds), 'events') : [];
  const eventTitles = new Map(evs.map((e) => [e.id, e.title]));

  const resultaten = deals.map((d) => {
    const c = ctx.customerById.get(d.customer_id) || null;
    const b = dealBasis(d, ctx);
    const subs = subsVanDeal(d.id, ctx).slice()
      .sort((x, y) => String(x.start_date || '').localeCompare(String(y.start_date || '')));
    const facturen = factuurenVanDeal(d, ctx);
    const bestaand = bestaandeCommissie(d.id, ctx, eventTitles);
    const waarschuwingen = [];
    if (bestaand.event_bonus) waarschuwingen.push('Deze offerte heeft al een event-bonus.');
    if (bestaand.toewijzing) waarschuwingen.push('Deze offerte is al toegewezen.');
    return {
      deal_id: d.id,
      offertenummer: d.quote_reference || null,
      klant: { id: d.customer_id, naam: customerDisplayName(c, '(klant)'), email: c?.email || null },
      getekend_op: d.tl_quotation_accepted_at || null,
      basis_incl: b.incl,
      basis_excl: b.excl,
      abonnementen: subs.map((x) => ({
        term_count: Number(x.term_count) || null,
        per_termijn_incl: round2(inclPerTerm(x)),
        billing_cycle: x.billing_cycle || null,
        start_date: x.start_date || null,
        status: x.status || null,
      })),
      gefactureerd: round2(facturen.reduce((s, i) => s + (Number(i.amount_total) || 0), 0)),
      betaald: round2(facturen.reduce((s, i) => s + betaaldBedrag(i), 0)),
      andere_getekende_deals: 0,
      bestaand,
      waarschuwingen,
    };
  });
  // Klanten met meerdere getekende deals: handig om een verlenging te herkennen.
  const perKlant = new Map();
  for (const r of resultaten) perKlant.set(r.klant.id, (perKlant.get(r.klant.id) || 0) + 1);
  for (const r of resultaten) r.andere_getekende_deals = (perKlant.get(r.klant.id) || 1) - 1;
  return { ok: true, resultaten, migratie_ok: ctx.attrs.ok };
}

// ── Validatie + preview ───────────────────────────────────────────────────────
function valideerInvoer(body) {
  const dealId = String(body?.deal_id || '').trim();
  if (!UUID_RE.test(dealId)) throw new CommissieFout(400, 'DEAL_ONGELDIG', 'deal_id (uuid) vereist');
  const mentoren = [...new Set((Array.isArray(body?.mentor_user_ids) ? body.mentor_user_ids : []).map((x) => String(x || '').trim()))];
  if (!mentoren.length) throw new CommissieFout(400, 'GEEN_MENTOR', 'Kies minstens één mentor');
  if (mentoren.some((m) => !UUID_RE.test(m))) throw new CommissieFout(400, 'MENTOR_ONGELDIG', 'mentor_user_ids ongeldig');
  if (mentoren.length > 10) throw new CommissieFout(400, 'TE_VEEL_MENTOREN', 'Maximaal 10 mentoren');
  const pct = body?.pct == null || body.pct === '' ? DEFAULT_PCT : Number(body.pct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new CommissieFout(400, 'PCT_ONGELDIG', 'Percentage moet tussen 0 en 100 liggen');
  const reden = body?.reden ? String(body.reden) : 'verlenging';
  if (!REDENEN.includes(reden)) throw new CommissieFout(400, 'REDEN_ONGELDIG', `reden moet ${REDENEN.join('/')} zijn`);
  const basisInclBtw = body?.basis_incl_btw === false ? false : true;
  const note = body?.note ? String(body.note).slice(0, 1000) : null;
  const force = body?.toch_toevoegen === true;
  const forceReden = body?.toch_reden ? String(body.toch_reden).trim().slice(0, 500) : '';
  return { dealId, mentoren, pct: round2(pct), reden, basisInclBtw, note, force, forceReden };
}

async function mentorInfo(userIds) {
  const [tms, profs] = await Promise.all([
    alle(supabaseAdmin.from('team_members').select('id, name, user_id, is_active').in('user_id', userIds), 'team_members'),
    alle(supabaseAdmin.from('profiles').select('id, full_name, email').in('id', userIds), 'profiles'),
  ]);
  const out = new Map();
  for (const uid of userIds) {
    const tm = tms.filter((t) => t.user_id === uid).sort((a, b) => Number(!!b.is_active) - Number(!!a.is_active))[0] || null;
    const p = profs.find((x) => x.id === uid) || null;
    if (!tm && !p) continue;
    out.set(uid, { user_id: uid, team_member_id: tm?.id || null, naam: tm?.name || p?.full_name || p?.email || '(mentor)' });
  }
  return out;
}

async function bereken(body) {
  const inv = valideerInvoer(body);
  const deals = await alle(supabaseAdmin.from('deals')
    .select('id, customer_id, total_amount, discount_percentage, sale_type, quote_reference, tl_quotation_status, tl_quotation_accepted_at, created_at, archived_at')
    .eq('id', inv.dealId), 'deal');
  const deal = deals[0];
  if (!deal) throw new CommissieFout(404, 'DEAL_NIET_GEVONDEN', 'Offerte niet gevonden');
  if (deal.archived_at) throw new CommissieFout(409, 'DEAL_GEARCHIVEERD', 'Deze offerte is verwijderd');
  if (!isGetekend(deal)) throw new CommissieFout(409, 'NIET_GETEKEND', 'Alleen getekende offertes kunnen toegewezen worden');
  if (!deal.customer_id) throw new CommissieFout(409, 'GEEN_KLANT', 'Offerte zonder klant');

  const ctx = await dealContext([deal]);
  const mentors = await mentorInfo(inv.mentoren);
  const onbekend = inv.mentoren.filter((m) => !mentors.has(m));
  if (onbekend.length) throw new CommissieFout(400, 'MENTOR_ONBEKEND', 'Onbekende mentor(en)', { onbekend });

  const b = dealBasis(deal, ctx);
  const basis = inv.basisInclBtw ? b.incl : b.excl;
  if (!(basis > 0)) throw new CommissieFout(409, 'DEAL_ZONDER_WAARDE', 'Offerte heeft geen waarde');
  const n = inv.mentoren.length;
  const perMentor = aandeelPerMentor(basis, inv.pct, n);
  if (!(perMentor > 0)) throw new CommissieFout(409, 'NUL_COMMISSIE', 'Commissie rondt af naar € 0');

  const subs = subsVanDeal(deal.id, ctx);
  const facturen = factuurenVanDeal(deal, ctx);
  const afsluiting = await afsluitingVoor(inv.mentoren);
  const termijnen = termijnSchema({
    subs, facturen, basis, aandeel: perMentor, startFallback: vandaag(),
    betalingen: ctx.betalingen, afsluiting,
  });
  const bestaand = bestaandeCommissie(deal.id, ctx);
  const betaald = round2(facturen.reduce((s, i) => s + betaaldBedrag(i), 0));
  return {
    inv, deal, ctx, basis, b, perMentor, termijnen, bestaand, betaald, facturen,
    mentoren: inv.mentoren.map((uid) => ({ ...mentors.get(uid), aandeel: perMentor })),
    klant: ctx.customerById.get(deal.customer_id) || null,
  };
}

export async function previewToewijzing(body) {
  const r = await bereken(body);
  // Wat meteen vrijkomt = de betaalde termijnen (zelfde rekenwijze als het
  // rapport); betaald in een al afgesloten maand gaat via een correctie.
  const betaaldeTermijnen = r.termijnen.filter((t) => t.status === 'betaald');
  const verwachtNu = round2(betaaldeTermijnen.reduce((s, t) => s + t.aandeel, 0));
  const inhaal = round2(betaaldeTermijnen.filter((t) => t.inhaal).reduce((s, t) => s + t.aandeel, 0));
  const achterstallig = round2(r.termijnen.filter((t) => t.status === 'achterstallig').reduce((s, t) => s + t.aandeel, 0));
  return {
    ok: true,
    migratie_ok: r.ctx.attrs.ok,
    deal: { id: r.deal.id, offertenummer: r.deal.quote_reference || null, klant: customerDisplayName(r.klant, '(klant)') },
    basis: r.basis, basis_incl_btw: r.inv.basisInclBtw, pct: r.inv.pct, reden: r.inv.reden,
    totaal_commissie: round2(r.perMentor * r.mentoren.length),
    mentoren: r.mentoren,
    betaald_op_deal: r.betaald,
    valt_meteen_vrij_per_mentor: verwachtNu,
    inhaal_per_mentor: inhaal,
    achterstallig_per_mentor: achterstallig,
    betaalde_termijnen: betaaldeTermijnen.length,
    termijnen: r.termijnen,
    per_maand: perMaand(r.termijnen),
    bestaand: r.bestaand,
    blokkeert: !!(r.bestaand.event_bonus || r.bestaand.toewijzing),
  };
}

// ── Opslaan ───────────────────────────────────────────────────────────────────
export async function opslaanToewijzing(body, { actorId }) {
  const r = await bereken(body);
  if (!r.ctx.attrs.ok) {
    throw new CommissieFout(503, 'MIGRATIE_ONTBREEKT', 'De database-migratie voor toewijzingen is nog niet gedraaid.');
  }
  if (r.bestaand.toewijzing) {
    throw new CommissieFout(409, 'AL_TOEGEWEZEN', 'Deze offerte is al toegewezen. Annuleer eerst de bestaande toewijzing.');
  }
  if (r.bestaand.event_bonus && !(r.inv.force && r.inv.forceReden.length >= 5)) {
    throw new CommissieFout(409, 'AL_EVENT_BONUS',
      'Op deze offerte staat al een event-bonus. Kies "toch toevoegen" met een reden als dat echt de bedoeling is.',
      { bestaand: r.bestaand });
  }

  const noteDelen = [
    `${REDEN_LABEL[r.inv.reden]} — ${r.inv.pct}% van EUR ${r.basis.toFixed(2)} ${r.inv.basisInclBtw ? 'incl' : 'excl'} BTW / ${r.mentoren.length} mentor(en)`,
  ];
  if (r.bestaand.event_bonus) noteDelen.push(`Toch toegevoegd naast event-bonus: ${r.inv.forceReden}`);
  if (r.inv.note) noteDelen.push(r.inv.note);

  const { data: attr, error: aErr } = await supabaseAdmin.from('mentor_sale_attributions').insert({
    deal_id: r.deal.id,
    customer_id: r.deal.customer_id,
    reden: r.inv.reden,
    pct: r.inv.pct,
    basis: r.basis,
    basis_incl_btw: r.inv.basisInclBtw,
    status: 'actief',
    note: noteDelen.slice(1).join(' · ') || null,
    created_by: actorId || null,
  }).select('id, created_at').single();
  if (aErr) {
    if (isSchemaOntbreekt(aErr)) throw new CommissieFout(503, 'MIGRATIE_ONTBREEKT', 'De database-migratie voor toewijzingen is nog niet gedraaid.');
    if (aErr.code === '23505') throw new CommissieFout(409, 'AL_TOEGEWEZEN', 'Deze offerte is net al toegewezen.');
    throw new Error('attribution insert: ' + aErr.message);
  }

  const parentIds = [];
  try {
    for (const m of r.mentoren) {
      const { data: row, error } = await supabaseAdmin.from('mentor_ledger_entries').insert({
        mentor_user_id: m.user_id,
        team_member_id: m.team_member_id,
        event_id: null,
        attribution_id: attr.id,
        entry_type: 'bonus',
        customer_id: r.deal.customer_id,
        basis: r.basis,
        basis_incl_btw: r.inv.basisInclBtw,
        pct: r.inv.pct,
        amount: r.perMentor,
        status: 'pending',
        source_quote_id: r.deal.id,
        idempotency_key: attrIdempotencyKey(attr.id, m.user_id),
        note: noteDelen.join(' · ').slice(0, 1000),
      }).select('id').single();
      if (error) throw new Error(`ledger insert (${m.naam}): ${error.message}`);
      parentIds.push(row.id);
    }
  } catch (e) {
    // Alles of niets: opgeruimd achterlaten zodat opnieuw proberen kan.
    console.error('[commissie-toewijzing] opslaan mislukt, terugdraaien:', e.message);
    if (parentIds.length) {
      const { error: dErr } = await supabaseAdmin.from('mentor_ledger_entries').delete().in('id', parentIds);
      if (dErr) console.error('[commissie-toewijzing] rollback ledger:', dErr.message);
    }
    const { error: d2 } = await supabaseAdmin.from('mentor_sale_attributions').delete().eq('id', attr.id);
    if (d2) {
      console.error('[commissie-toewijzing] rollback attribution:', d2.message);
      await supabaseAdmin.from('mentor_sale_attributions')
        .update({ status: 'geannuleerd', cancelled_at: new Date().toISOString(), cancelled_by: actorId || null })
        .eq('id', attr.id);
    }
    throw e;
  }

  // Al betaalde termijnen van DEZE deal meteen vrijgeven. Faalt dit, dan staat
  // de toewijzing er wel; de volgende factuursync haalt het in.
  let vrijgave = null;
  try {
    const rel = await releaseProportionalForPaidAmount({ customerId: r.deal.customer_id });
    const mijn = (rel.simulations || []).filter((s) => parentIds.includes(s.parent_id) && s.would_release);
    vrijgave = { vrijgegeven: round2(mijn.reduce((s, x) => s + Number(x.te_releasen || 0), 0)), regels: mijn.length };
  } catch (e) {
    console.error('[commissie-toewijzing] vrijgave na opslaan:', e.message);
    vrijgave = { fout: e.message };
  }

  return {
    ok: true,
    attribution_id: attr.id,
    parent_ids: parentIds,
    totaal_commissie: round2(r.perMentor * r.mentoren.length),
    per_mentor: r.perMentor,
    vrijgave,
  };
}

// ── Annuleren ─────────────────────────────────────────────────────────────────
export async function annuleerToewijzing(body, { actorId }) {
  const id = String(body?.attribution_id || '').trim();
  if (!UUID_RE.test(id)) throw new CommissieFout(400, 'ID_ONGELDIG', 'attribution_id (uuid) vereist');
  if (String(body?.bevestiging || '') !== 'ANNULEER') {
    throw new CommissieFout(400, 'BEVESTIGING', 'Typ ANNULEER om te bevestigen');
  }
  const reden = body?.reden ? String(body.reden).slice(0, 500) : null;
  const { data: attr, error } = await supabaseAdmin.from('mentor_sale_attributions')
    .select('id, deal_id, customer_id, status, note').eq('id', id).maybeSingle();
  if (error) {
    if (isSchemaOntbreekt(error)) throw new CommissieFout(503, 'MIGRATIE_ONTBREEKT', 'De database-migratie voor toewijzingen is nog niet gedraaid.');
    throw new Error('attribution fetch: ' + error.message);
  }
  if (!attr) throw new CommissieFout(404, 'NIET_GEVONDEN', 'Toewijzing niet gevonden');
  if (attr.status !== 'actief') throw new CommissieFout(409, 'AL_GEANNULEERD', 'Deze toewijzing is al geannuleerd');

  const parents = await alle(supabaseAdmin.from('mentor_ledger_entries')
    .select('id, mentor_user_id, status, amount, original_amount, note')
    .eq('attribution_id', id).is('parent_entry_id', null), 'parents');
  const parentIds = parents.map((p) => p.id);
  const kids = parentIds.length
    ? await alle(supabaseAdmin.from('mentor_ledger_entries').select('id, parent_entry_id, amount, status')
      .in('parent_entry_id', parentIds), 'children')
    : [];
  const vrijgegeven = round2(kids.filter((k) => k.status === 'vrijgegeven' || k.status === 'uitbetaald').reduce((s, k) => s + Number(k.amount || 0), 0));
  const uitbetaald = round2(kids.filter((k) => k.status === 'uitbetaald').reduce((s, k) => s + Number(k.amount || 0), 0));

  const stempel = `[${new Date().toISOString().slice(0, 10)}] Toewijzing geannuleerd${reden ? ': ' + reden : ''}`;
  let geannuleerd = 0;
  for (const p of parents.filter((x) => OPEN_STATUSSEN.includes(x.status))) {
    const { data, error: uErr } = await supabaseAdmin.from('mentor_ledger_entries')
      .update({ status: 'geannuleerd', note: [p.note, stempel].filter(Boolean).join(' · ').slice(0, 1000) })
      .eq('id', p.id).in('status', OPEN_STATUSSEN).select('id');
    if (uErr) throw new Error('parent annuleren: ' + uErr.message);
    geannuleerd += (data || []).length;
  }
  const { error: aErr } = await supabaseAdmin.from('mentor_sale_attributions').update({
    status: 'geannuleerd',
    cancelled_at: new Date().toISOString(),
    cancelled_by: actorId || null,
    note: [attr.note, stempel].filter(Boolean).join(' · ').slice(0, 1000),
  }).eq('id', id).eq('status', 'actief');
  if (aErr) throw new Error('attribution annuleren: ' + aErr.message);

  if (uitbetaald > 0) {
    // Zelfde lijn als de sales-bonus: geen stille terugdraai, wel een signaal.
    createNotification({
      toRole: ['manager', 'super_admin'],
      type: 'finance.mentor_commissie_clawback',
      title: 'Mentorcommissie al uitbetaald',
      body: `Geannuleerde toewijzing had al EUR ${uitbetaald.toFixed(2)} uitbetaald — verrekenen met een volgende uitbetaling (handmatige post).`,
      linkUrl: '/modules/klanten-v2/?v2preview=mentoren',
      entityType: 'mentor_sale_attribution',
      entityId: id,
    }).catch(() => {});
  }
  return { ok: true, attribution_id: id, geannuleerd_regels: geannuleerd, al_vrijgegeven: vrijgegeven, al_uitbetaald: uitbetaald, clawback_melding: uitbetaald > 0 };
}

// ── Platformbreed overzicht ───────────────────────────────────────────────────
function saleStatus(cel) {
  const share = Number(cel.share) || 0;
  const rel = Number(cel.vrijgegeven) || 0;
  if (cel.geannuleerd) return 'geannuleerd';
  if (cel.incasso) return 'incasso';
  if (share > 0 && rel >= share - 0.01) return 'volledig';
  if (cel.achterstallig) return 'achterstallig';
  if (rel > 0.004) return 'deels';
  return 'wacht';
}

function periodeStart(periode) {
  const nu = new Date();
  if (periode === 'dit_jaar') return `${nu.getUTCFullYear()}-01-01`;
  if (periode === '12m') { const d = new Date(nu); d.setUTCMonth(d.getUTCMonth() - 12); return d.toISOString().slice(0, 10); }
  if (periode === '90d') { const d = new Date(nu); d.setUTCDate(d.getUTCDate() - 90); return d.toISOString().slice(0, 10); }
  return null;
}

/**
 * Bouw het overzicht uit de per-mentor bonus-overzichten (dezelfde bron als
 * het mentorzicht en het payout-rapport) — zo kloppen cockpit, mentor en
 * uitbetaling altijd met elkaar.
 */
export function bouwOverzicht({ mentoren, overzichten, wanbetalers = new Set(), periode = 'alles' }) {
  const vanaf = periodeStart(periode);
  const nu = new Date();
  const dezeMaand = nu.toISOString().slice(0, 7);
  const volgende = new Date(Date.UTC(nu.getUTCFullYear(), nu.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);

  const sales = new Map(); // key → sale
  const maanden = new Map(); // month → { month, per_mentor: {uid: {betaald, verwacht}} }

  for (const m of mentoren) {
    const ov = overzichten.get(m.user_id);
    if (!ov) continue;
    for (const p of ov.projection_12m || []) {
      if (!maanden.has(p.month)) maanden.set(p.month, { month: p.month, per_mentor: {} });
      maanden.get(p.month).per_mentor[m.user_id] = { betaald: round2(p.paid), verwacht: round2(p.expected), achterstallig: round2(p.achterstallig || 0) };
    }
    for (const ev of ov.per_event || []) {
      for (const s of ev.sales || []) {
        const handmatig = s.bron === 'handmatig';
        const traject = !!s.is_cash_traject;
        const key = handmatig ? `attr:${s.attribution_id}`
          : traject ? `traject:${ev.event_id}:${s.customer_label}`
            : `ev:${ev.event_id || '-'}:${s.customer_id || s.customer_label}`;
        const datum = handmatig ? (s.created_at || null) : (ev.starts_at || null);
        if (!sales.has(key)) {
          sales.set(key, {
            key,
            bron: handmatig ? 'handmatig' : (traject ? 'traject' : 'event'),
            reden: s.reden || null,
            bron_label: handmatig ? (REDEN_LABEL[s.reden] || 'Handmatig') : (ev.event_title || (traject ? 'Handmatig traject' : 'Event')),
            event_id: ev.event_id || null,
            event_title: ev.event_title || null,
            datum,
            attribution_id: s.attribution_id || null,
            deal_id: s.deal_id || null,
            customer_id: s.customer_id || null,
            klant: s.customer_label || '—',
            dealwaarde: round2(s.basis || s.sale_total_incl || s.traject_total_incl || 0),
            pct: s.pct != null ? Number(s.pct) : null,
            term_count: s.term_count || 0,
            betaalde_termijnen: s.paid_term_count || 0,
            schema_onbekend: !!s.schema_unknown,
            achterstallig: !!s.has_overdue,
            achterstand_bedrag: round2(s.overdue_amount || 0),
            wanbetaler: !!(s.customer_id && wanbetalers.has(s.customer_id)),
            sub_geannuleerd: false,
            geannuleerd: true, // wordt false zodra één mentor een niet-geannuleerd aandeel heeft
            share: 0,
            vrijgegeven: 0,
            vrijgegeven_grootboek: 0,
            mentoren: [],
            termijnen: (s.termijnen || []).map((t) => ({ index: t.index, due_date: t.due_date, status: t.status, aandeel: 0, ...(t.vervangen ? { vervangen: true } : {}) })),
            incasso: null,      // { sinds, vervallen } — samengeteld over de mentoren
            vervallen: 0,
            niet_gedekt: 0,     // regeling: deel zonder (vervangende) factuur of termijn
          });
        }
        const cel = sales.get(key);
        const share = round2(s.mentor_share_total || 0);
        // Vrijgegeven = wat in het rapport komt (betaalde termijnen); het
        // grootboek blijft als audit naast staan (vrijgegeven_grootboek).
        const rel = round2(traject ? share : (s.vrijgegeven_rapport ?? s.released_share ?? 0));
        const relGb = round2(traject ? share : (s.released_share || 0));
        // Een sale met aandeel 0 is een geannuleerde grootboekregel.
        const mentorGeannuleerd = share <= 0 && s.status === 'geannuleerd';
        if (!mentorGeannuleerd) cel.geannuleerd = false;
        if (s.status === 'geannuleerd' && share > 0) cel.sub_geannuleerd = true;
        cel.share = round2(cel.share + share);
        cel.vrijgegeven = round2(cel.vrijgegeven + rel);
        cel.vrijgegeven_grootboek = round2(cel.vrijgegeven_grootboek + relGb);
        const verv = round2(s.incasso?.vervallen || 0);
        if (s.incasso) cel.incasso = { sinds: s.incasso.sinds, vervallen: round2((cel.incasso?.vervallen || 0) + verv) };
        cel.vervallen = round2(cel.vervallen + verv);
        cel.niet_gedekt = round2(cel.niet_gedekt + (Number(s.regeling?.niet_gedekt) || 0));
        cel.mentoren.push({ user_id: m.user_id, naam: m.naam, aandeel: share, vrijgegeven: rel, vervallen: verv, geannuleerd: mentorGeannuleerd });
        (s.termijnen || []).forEach((t, i) => {
          if (cel.termijnen[i]) cel.termijnen[i].aandeel = round2(cel.termijnen[i].aandeel + (Number(t.amount) || 0));
        });
      }
    }
  }

  let lijst = [...sales.values()];
  if (vanaf) lijst = lijst.filter((s) => !s.datum || String(s.datum).slice(0, 10) >= vanaf);
  for (const s of lijst) {
    // Incasso: wat vervalt is niet meer "open".
    s.open = round2(Math.max(0, s.share - s.vrijgegeven - (s.vervallen || 0)));
    s.status = saleStatus(s);
    const volg = s.termijnen.find((t) => t.status === 'open' || t.status === 'achterstallig');
    s.volgende_termijn = volg ? { due_date: volg.due_date, aandeel: volg.aandeel, status: volg.status } : null;
    s.risico = s.open > 0 && (s.achterstallig || s.wanbetaler || s.sub_geannuleerd);
    s.risico_redenen = [
      s.achterstallig ? 'vervallen facturen' : null,
      s.wanbetaler ? 'wanbetaler' : null,
      s.sub_geannuleerd ? 'abonnement geannuleerd' : null,
    ].filter(Boolean);
  }
  lijst.sort((a, b) => String(b.datum || '').localeCompare(String(a.datum || '')));

  const actief = lijst.filter((s) => !s.geannuleerd);
  const som = (arr, f) => round2(arr.reduce((t, x) => t + (Number(f(x)) || 0), 0));
  const verwachtIn = (maand, uids = null) => {
    const cel = maanden.get(maand);
    if (!cel) return 0;
    return round2(Object.entries(cel.per_mentor)
      .filter(([uid]) => !uids || uids.has(uid))
      .reduce((t, [, v]) => t + (Number(v.verwacht) || 0), 0));
  };

  // Verschoven termijnen + inhaalcommissie (maand van betaling, zie
  // api/_lib/commissie-maand.js), platformbreed met de mentornaam erbij.
  const verschoven = [];
  for (const m of mentoren) {
    const ov = overzichten.get(m.user_id);
    for (const v of ov?.verschoven || []) verschoven.push({ ...v, mentor_user_id: m.user_id, mentor: m.naam });
  }
  verschoven.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  const achterstallig = verschoven.filter((v) => v.status === 'achterstallig');
  const inhaal = verschoven.filter((v) => v.inhaal);

  const kpis = {
    achterstallig: som(achterstallig, (v) => v.amount),
    achterstallig_aantal: achterstallig.length,
    inhaal_open: som(inhaal.filter((v) => !v.inhaal_voorgesteld), (v) => v.amount),
    geboekt: som(actief, (s) => s.share - (s.vervallen || 0)),
    vervallen_incasso: som(actief, (s) => s.vervallen || 0),
    vervallen_incasso_aantal: actief.filter((s) => (s.vervallen || 0) > 0).length,
    vrijgegeven: som(actief, (s) => s.vrijgegeven),
    open: som(actief, (s) => s.open),
    deze_maand_verwacht: verwachtIn(dezeMaand),
    volgende_maand_verwacht: verwachtIn(volgende),
    risico: som(actief.filter((s) => s.risico), (s) => s.open),
    risico_aantal: actief.filter((s) => s.risico).length,
    aantal_sales: actief.length,
  };

  const perMentor = mentoren.map((m) => {
    const mijn = actief.map((s) => ({ s, me: s.mentoren.find((x) => x.user_id === m.user_id && !x.geannuleerd) })).filter((x) => x.me);
    return {
      user_id: m.user_id,
      naam: m.naam,
      closes: mijn.length,
      geboekt: som(mijn, (x) => x.me.aandeel - (x.me.vervallen || 0)),
      vrijgegeven: som(mijn, (x) => x.me.vrijgegeven),
      open: som(mijn, (x) => Math.max(0, x.me.aandeel - x.me.vrijgegeven - (x.me.vervallen || 0))),
      vervallen_incasso: som(mijn, (x) => x.me.vervallen || 0),
      verwacht_volgende_maand: verwachtIn(volgende, new Set([m.user_id])),
      risico: som(mijn.filter((x) => x.s.risico), (x) => Math.max(0, x.me.aandeel - x.me.vrijgegeven - (x.me.vervallen || 0))),
    };
  }).sort((a, b) => b.geboekt - a.geboekt);

  const evMap = new Map();
  for (const s of lijst) {
    const k = s.bron === 'handmatig' ? `handmatig:${s.reden || 'handmatig'}` : (s.event_id || 'zonder');
    if (!evMap.has(k)) {
      evMap.set(k, {
        key: k,
        event_id: s.bron === 'handmatig' ? null : s.event_id,
        titel: s.bron === 'handmatig' ? `Handmatig toegewezen · ${s.bron_label}` : (s.event_title || 'Zonder event'),
        is_handmatig: s.bron === 'handmatig',
        datum: s.bron === 'handmatig' ? null : s.datum,
        omzet: 0, sales: 0, pot: 0, vrijgegeven: 0, verdeling: new Map(), sale_keys: [],
      });
    }
    const e = evMap.get(k);
    e.sale_keys.push(s.key);
    if (s.geannuleerd) continue;
    e.omzet = round2(e.omzet + s.dealwaarde);
    e.sales += 1;
    e.pot = round2(e.pot + s.share - (s.vervallen || 0));
    e.vrijgegeven = round2(e.vrijgegeven + s.vrijgegeven);
    for (const me of s.mentoren) {
      if (me.geannuleerd) continue;
      const v = e.verdeling.get(me.user_id) || { user_id: me.user_id, naam: me.naam, bedrag: 0 };
      v.bedrag = round2(v.bedrag + me.aandeel);
      e.verdeling.set(me.user_id, v);
    }
  }
  const perEvent = [...evMap.values()].map((e) => ({ ...e, verdeling: [...e.verdeling.values()].sort((a, b) => b.bedrag - a.bedrag) }))
    .sort((a, b) => (a.is_handmatig - b.is_handmatig) || String(b.datum || '').localeCompare(String(a.datum || '')));

  const projectie = [...maanden.values()].sort((a, b) => a.month.localeCompare(b.month));

  return {
    kpis,
    per_mentor: perMentor,
    per_event: perEvent,
    sales: lijst,
    projectie,
    verschoven,
    achterstallig,
    inhaal,
    risicos: actief.filter((s) => s.risico).sort((a, b) => b.open - a.open)
      .map((s) => ({ key: s.key, klant: s.klant, bron_label: s.bron_label, open: s.open, redenen: s.risico_redenen })),
  };
}

export async function commissieOverzicht({ periode = 'alles' } = {}) {
  // Mentoren = iedereen met een bonus-regel in het grootboek.
  const regels = await alle(supabaseAdmin.from('mentor_ledger_entries').select('mentor_user_id, customer_id, source_quote_id, status')
    .eq('entry_type', 'bonus').is('parent_entry_id', null).limit(20000), 'mentoren');
  const uids = [...new Set(regels.map((r) => r.mentor_user_id).filter(Boolean))];
  const info = uids.length ? await mentorInfo(uids) : new Map();
  const mentoren = uids.map((u) => info.get(u) || { user_id: u, naam: '(mentor)' })
    .sort((a, b) => a.naam.localeCompare(b.naam, 'nl'));

  const overzichten = new Map();
  const fouten = [];
  for (const m of mentoren) {
    try {
      overzichten.set(m.user_id, await computeBonusOverview(m.user_id));
    } catch (e) {
      console.error('[commissie-overzicht] mentor', m.user_id, e.message);
      fouten.push({ user_id: m.user_id, naam: m.naam, fout: e.message });
    }
  }

  // Wanbetalers: klanten in een zware incassofase (fail-soft).
  const wanbetalers = new Set();
  try {
    const { data, error } = await supabaseAdmin.from('dunning_pipeline_customers')
      .select('customer_id, stage_slug').in('stage_slug', ['brief_verstuurd', 'incasso', 'afschrijven']);
    if (!error) for (const r of data || []) wanbetalers.add(r.customer_id);
  } catch { /* fail-soft */ }

  const attrs = await loadAttributions(supabaseAdmin, { ids: ['00000000-0000-0000-0000-000000000000'] });
  const basis = bouwOverzicht({ mentoren, overzichten, wanbetalers, periode });
  let wanbetaling = { incasso_ok: false, koppel_ok: false, incasso_markeringen: [], mogelijk_incasso: [], niet_gekoppeld: [], koppelingen: [] };
  try {
    wanbetaling = await wanbetalingLijsten({ regels, sales: basis.sales });
  } catch (e) {
    console.error('[commissie-overzicht] incasso/regeling:', e.message);
    fouten.push({ naam: 'Incasso / regeling', fout: e.message });
  }
  return {
    ok: true,
    periode,
    migratie_ok: attrs.ok,
    mentoren,
    fouten,
    ...basis,
    ...wanbetaling,
  };
}

// ── Wanbetaling: incasso + regeling na creditering ───────────────────────────
const INCASSO_TERMINAAL = ['betaald', 'afgeschreven', 'oninbaar', 'geretourneerd'];

/** customer_id → Set(deal-ids met (niet-geannuleerde) commissie). */
function commissieSales(regels) {
  const m = new Map();
  for (const r of regels || []) {
    if (!r.customer_id || !r.source_quote_id || r.status === 'geannuleerd') continue;
    if (!m.has(r.customer_id)) m.set(r.customer_id, new Set());
    m.get(r.customer_id).add(r.source_quote_id);
  }
  return m;
}

/**
 * Lijsten voor de cockpit: actieve incassomarkeringen, "Mogelijk incasso"
 * (dossier niet afgesloten, pipelinefase incasso, onboarding op incasso) en
 * regelingsfacturen die niet eenduidig bij één sale horen.
 */
export async function wanbetalingLijsten({ regels, sales = [] }) {
  const salesPerKlant = commissieSales(regels);
  const klanten = [...salesPerKlant.keys()];
  const leeg = { incasso_ok: true, koppel_ok: true, incasso_markeringen: [], mogelijk_incasso: [], niet_gekoppeld: [], koppelingen: [] };
  if (!klanten.length) return leeg;
  const ctx = await loadRegelingContext(supabaseAdmin, klanten);

  const custs = await alle(supabaseAdmin.from('customers').select('id, is_company, company_name, first_name, last_name').in('id', klanten), 'customers');
  const naam = new Map(custs.map((c) => [c.id, customerDisplayName(c, '(klant)')]));
  const saleLabel = new Map();
  for (const s of sales) {
    if (!s.deal_id || saleLabel.has(s.deal_id)) continue;
    saleLabel.set(s.deal_id, `${s.bron === 'handmatig' ? s.bron_label : (s.event_title || s.bron_label)} · ${s.mentoren.map((m) => m.naam).join(', ')}`);
  }
  const opties = (cid) => [...(salesPerKlant.get(cid) || [])].map((d) => ({ deal_id: d, label: saleLabel.get(d) || 'Sale' }));

  const incasso_markeringen = ctx.incasso.map((m) => ({
    id: m.id, customer_id: m.customer_id, klant: naam.get(m.customer_id) || '(klant)',
    deal_id: m.deal_id || null, sale: m.deal_id ? (saleLabel.get(m.deal_id) || 'Sale') : 'Alle sales van de klant',
    sinds: String(m.sinds).slice(0, 10), reden: m.reden, bron: m.bron, gezet_op: m.gezet_op,
  }));
  const gemarkeerd = new Set(ctx.incasso.filter((m) => !m.deal_id).map((m) => m.customer_id));

  // Signalen voor "Mogelijk incasso" — elk fail-soft.
  const signalen = new Map(); // customer_id → [{ bron, sinds }]
  const voeg = (cid, bron, d) => {
    if (!salesPerKlant.has(cid) || gemarkeerd.has(cid)) return;
    if (!signalen.has(cid)) signalen.set(cid, []);
    signalen.get(cid).push({ bron, sinds: d ? String(d).slice(0, 10) : null });
  };
  try {
    const { data } = await supabaseAdmin.from('dunning_incasso_dossiers').select('customer_id, status, opened_at').in('customer_id', klanten);
    for (const r of data || []) if (!INCASSO_TERMINAAL.includes(String(r.status || ''))) voeg(r.customer_id, 'Incassodossier (' + r.status + ')', r.opened_at);
  } catch { /* fail-soft */ }
  try {
    const { data } = await supabaseAdmin.from('dunning_pipeline_customers').select('customer_id, stage_slug, stage_changed_at').in('customer_id', klanten).eq('stage_slug', 'incasso');
    for (const r of data || []) voeg(r.customer_id, 'Wanbetalers-pipeline: incasso', r.stage_changed_at);
  } catch { /* fail-soft */ }
  try {
    const { data } = await supabaseAdmin.from('onboardings').select('customer_id, incasso_op').in('customer_id', klanten).not('incasso_op', 'is', null);
    for (const r of data || []) if (r.incasso_op) voeg(r.customer_id, 'Onboarding op incasso', r.incasso_op);
  } catch { /* fail-soft */ }
  const mogelijk_incasso = [...signalen.entries()].map(([cid, sig]) => ({
    customer_id: cid, klant: naam.get(cid) || '(klant)', signalen: sig,
    voorstel_sinds: sig.map((x) => x.sinds).filter(Boolean).sort()[0] || vandaag(),
    sales: opties(cid),
  }));

  // Regelingsfacturen zonder eenduidige sale.
  const kredietKlanten = [...ctx.krediet.keys()];
  const niet_gekoppeld = [];
  const koppelingen = [];
  if (kredietKlanten.length || ctx.handmatig.size) {
    const invs = await alle(supabaseAdmin.from('invoices')
      .select('id, customer_id, deal_id, tl_subscription_id, invoice_number, amount_total, amount_paid, credited_amount, status, due_date, created_at')
      .in('customer_id', ctx.handmatig.size ? klanten : kredietKlanten), 'invoices');
    for (const inv of invs) {
      if (isConcept(inv)) continue;
      const k = koppelDeal(inv, ctx, salesPerKlant);
      if (!k) continue;
      const rij = {
        invoice_id: inv.id, invoice_number: inv.invoice_number || null, customer_id: inv.customer_id,
        klant: naam.get(inv.customer_id) || '(klant)', bedrag: round2(inv.amount_total), betaald: round2(inv.amount_paid),
        due_date: inv.due_date || null, opties: opties(inv.customer_id),
      };
      if (k.onbekend) niet_gekoppeld.push(rij);
      else koppelingen.push({ ...rij, deal_id: k.deal, bron: k.bron, sale: k.deal ? (saleLabel.get(k.deal) || 'Sale') : 'Geen sale' });
    }
  }
  return {
    incasso_ok: ctx.incassoOk, koppel_ok: ctx.koppelOk,
    incasso_markeringen, mogelijk_incasso, niet_gekoppeld, koppelingen,
  };
}

async function commissieSalesVanKlant(customerId) {
  const rows = await alle(supabaseAdmin.from('mentor_ledger_entries').select('customer_id, source_quote_id, status')
    .eq('entry_type', 'bonus').is('parent_entry_id', null).eq('customer_id', customerId), 'ledger');
  return commissieSales(rows).get(customerId) || new Set();
}

const migratieFout = () => new CommissieFout(503, 'MIGRATIE_ONTBREEKT', 'De database-migratie voor incasso/koppeling (2026-10-22-commissie-incasso-en-koppeling.sql) is nog niet gedraaid.');
const ontbreektTabel = (err) => isSchemaOntbreekt(err) || ['42P01', 'PGRST205'].includes(String(err?.code || ''))
  || /mentor_commissie_incasso|commissie_factuur_koppeling/i.test(String(err?.message || ''));

async function inhalen(customerId) {
  try {
    const r = await releaseProportionalForPaidAmount({ customerId });
    return { vrijgegeven: round2(r.total_released) };
  } catch (e) {
    console.error('[commissie] vrijgave na wijziging:', e.message);
    return { fout: e.message };
  }
}

/** Incasso markeren of opheffen. */
export async function incassoActie(body, { actorId }) {
  const actie = String(body?.actie || '');
  if (actie === 'markeren') {
    const customerId = String(body?.customer_id || '').trim();
    const dealId = body?.deal_id ? String(body.deal_id).trim() : null;
    const sinds = String(body?.sinds || '').slice(0, 10);
    const reden = String(body?.reden || '').trim().slice(0, 500);
    if (!UUID_RE.test(customerId)) throw new CommissieFout(400, 'KLANT_ONGELDIG', 'customer_id (uuid) vereist');
    if (dealId && !UUID_RE.test(dealId)) throw new CommissieFout(400, 'DEAL_ONGELDIG', 'deal_id ongeldig');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinds)) throw new CommissieFout(400, 'DATUM_ONGELDIG', 'sinds (YYYY-MM-DD) vereist');
    if (reden.length < 3) throw new CommissieFout(400, 'REDEN', 'Geef een reden');
    const sales = await commissieSalesVanKlant(customerId);
    if (!sales.size) throw new CommissieFout(404, 'GEEN_COMMISSIE', 'Deze klant heeft geen mentorcommissie');
    if (dealId && !sales.has(dealId)) throw new CommissieFout(400, 'DEAL_ONBEKEND', 'Deze sale heeft geen mentorcommissie bij deze klant');
    // Al een actieve markering voor precies deze scope? (de unieke index
    // vangt het ook, maar zo krijgt Maxim een duidelijke melding)
    {
      let q = supabaseAdmin.from('mentor_commissie_incasso').select('id').eq('customer_id', customerId).is('opgeheven_op', null);
      q = dealId ? q.eq('deal_id', dealId) : q.is('deal_id', null);
      const { data: bestaand, error: bErr } = await q;
      if (bErr && ontbreektTabel(bErr)) throw migratieFout();
      if (bestaand && bestaand.length) throw new CommissieFout(409, 'AL_GEMARKEERD', 'Er staat al een actieve incassomarkering voor deze klant/sale');
    }
    const { data, error } = await supabaseAdmin.from('mentor_commissie_incasso').insert({
      customer_id: customerId, deal_id: dealId, sinds, reden,
      bron: body?.bron === 'voorstel' ? 'voorstel' : 'handmatig', gezet_door: actorId || null,
    }).select('id').single();
    if (error) {
      if (ontbreektTabel(error)) throw migratieFout();
      if (error.code === '23505') throw new CommissieFout(409, 'AL_GEMARKEERD', 'Er staat al een actieve incassomarkering voor deze klant/sale');
      throw new Error('incasso insert: ' + error.message);
    }
    return { ok: true, id: data.id, vrijgave: await inhalen(customerId) };
  }
  if (actie === 'opheffen') {
    const id = String(body?.id || '').trim();
    if (!UUID_RE.test(id)) throw new CommissieFout(400, 'ID_ONGELDIG', 'id (uuid) vereist');
    const { data, error } = await supabaseAdmin.from('mentor_commissie_incasso').update({
      opgeheven_op: new Date().toISOString(), opgeheven_door: actorId || null,
      opheffen_reden: body?.reden ? String(body.reden).slice(0, 500) : null,
    }).eq('id', id).is('opgeheven_op', null).select('id, customer_id');
    if (error) {
      if (ontbreektTabel(error)) throw migratieFout();
      throw new Error('incasso opheffen: ' + error.message);
    }
    if (!data || !data.length) throw new CommissieFout(404, 'NIET_GEVONDEN', 'Geen actieve markering met dit id');
    // Vanaf nu telt het weer mee: de vrijgave haalt in wat ondertussen betaald werd.
    return { ok: true, id, vrijgave: await inhalen(data[0].customer_id) };
  }
  throw new CommissieFout(400, 'ACTIE', "actie moet 'markeren' of 'opheffen' zijn");
}

/** Regelingsfactuur aan een sale hangen (of bewust aan geen), of de keuze wissen. */
export async function factuurKoppelen(body, { actorId }) {
  const invoiceId = String(body?.invoice_id || '').trim();
  if (!UUID_RE.test(invoiceId)) throw new CommissieFout(400, 'FACTUUR_ONGELDIG', 'invoice_id (uuid) vereist');
  const invs = await alle(supabaseAdmin.from('invoices').select('id, customer_id, status').eq('id', invoiceId), 'invoice');
  const inv = invs[0];
  if (!inv) throw new CommissieFout(404, 'FACTUUR_NIET_GEVONDEN', 'Factuur niet gevonden');
  if (isConcept(inv)) throw new CommissieFout(409, 'CONCEPT', 'Een conceptfactuur telt nooit voor commissie');

  const { error: dErr } = await supabaseAdmin.from('commissie_factuur_koppeling').delete().eq('invoice_id', invoiceId);
  if (dErr) {
    if (ontbreektTabel(dErr)) throw migratieFout();
    throw new Error('koppeling wissen: ' + dErr.message);
  }
  if (body?.actie === 'wissen') return { ok: true, gewist: true, vrijgave: await inhalen(inv.customer_id) };

  const dealId = body?.deal_id ? String(body.deal_id).trim() : null;
  if (dealId) {
    if (!UUID_RE.test(dealId)) throw new CommissieFout(400, 'DEAL_ONGELDIG', 'deal_id ongeldig');
    const sales = await commissieSalesVanKlant(inv.customer_id);
    if (!sales.has(dealId)) throw new CommissieFout(400, 'DEAL_ONBEKEND', 'Deze sale heeft geen mentorcommissie bij deze klant');
  }
  const { error } = await supabaseAdmin.from('commissie_factuur_koppeling').insert({
    invoice_id: invoiceId, customer_id: inv.customer_id, deal_id: dealId, bron: 'handmatig',
    note: body?.note ? String(body.note).slice(0, 500) : null, gezet_door: actorId || null,
  });
  if (error) {
    if (ontbreektTabel(error)) throw migratieFout();
    throw new Error('koppeling opslaan: ' + error.message);
  }
  return { ok: true, invoice_id: invoiceId, deal_id: dealId, vrijgave: await inhalen(inv.customer_id) };
}
