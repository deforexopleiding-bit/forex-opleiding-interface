// api/_lib/cash-traject-omzetten.js
//
// Handmatig traject (mentor_cash_trajects) → factuurmotor.
//
// WAAROM (3 nov 2026, beslissing Maxim): de oude vrijval-motor gaf elke maand
// een termijn vrij op DATUM, zonder te kijken of de klant betaald had. Bij de
// drie lopende trajecten stond 259,60 vrijgegeven tegenover ± 73,20 op basis
// van betaalde CRM-facturen. Regel vanaf nu: ENKEL een betaalde factuur geeft
// commissie vrij, zonder uitzondering.
//
// OMZETTEN = per aanwezige event-mentor één gewone grootboek-parent
//   (entry_type 'bonus', status 'pending', customer_id + source_quote_id =
//   de sale) met de OORSPRONKELIJKE commissie (bonus_total / N) als
//   original_amount. De factuurmotor (releaseProportionalForPaidAmount) rekent
//   daarna: doel = original × betaald / basis.
// De bestaande vrijgegeven termijnregels (cashtraject:<id>:term:<n>:mentor:<uid>)
//   worden CHILDREN van die parent (parent_entry_id + customer_id +
//   source_quote_id). Bedrag, status, released_at en payout_id blijven EXACT
//   staan (forward-only: niemand betaalt terug). Omdat de motor "reeds
//   vrijgegeven" = som van de children neemt, komt er niets meer vrij tot de
//   betalingen het vrijgegeven bedrag hebben ingehaald (verrekening).
// parent.amount = max(0, original − reeds vrijgegeven): het deel dat nog kan
//   komen. Is er al méér vrijgegeven dan de commissie, dan 0.
//
// Idempotent: parent-sleutel `cashtraject:<id>:sale:<mentor_uid>` is uniek;
// alleen termijnregels zonder parent worden gekoppeld.
//
// SQL-tegenhanger voor de drie bestaande trajecten:
// docs/sql-migrations/2026-11-03-cashtraject-naar-factuurmotor.sql.

import { supabaseAdmin } from '../supabase.js';
import { betaaldBedrag } from './factuur-betaald.js';
import { isConcept } from './commissie-regeling.js';
import { laadUitbetaaldTot, somPerStand } from './commissie-uitbetaald.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const TERM_KEY_RE = /^cashtraject:([0-9a-f-]{36}):term:(\d+)(?::mentor:([0-9a-f-]{36}))?$/i;
export const saleParentKey = (trajectId, mentorUserId) => `cashtraject:${trajectId}:sale:${mentorUserId}`;
export const isTrajectParentKey = (key) => /^cashtraject:[0-9a-f-]{36}:sale:/i.test(String(key || ''));
export const isTrajectTermKey = (key) => TERM_KEY_RE.test(String(key || ''));

/**
 * Puur: wat er bij het omzetten geschreven wordt.
 *
 * @param {object} p
 * @param {object} p.traject   rij uit mentor_cash_trajects
 * @param {string} p.customerId
 * @param {string} p.dealId
 * @param {Array<{user_id, team_member_id}>} p.mentoren  aanwezige event-mentoren met login
 * @param {Array<{id, mentor_user_id, amount, status, parent_entry_id, idempotency_key}>} p.termijnregels
 * @returns {{ ok, reden?, parents: Array, koppelingen: Array<{entry_id, parent_key}>, per_mentor: Array }}
 */
export function planOmzetting({ traject, customerId, dealId, mentoren = [], termijnregels = [], betaald = null, payoutById = new Map(), uitbetaaldTot }) {
  const leeg = (reden) => ({ ok: false, reden, parents: [], koppelingen: [], per_mentor: [] });
  if (!traject?.id) return leeg('traject ontbreekt');
  if (!customerId) return leeg('klant ontbreekt: zonder klant geen factuurcheck');
  if (!dealId) return leeg('sale (deal) ontbreekt: zonder sale geen factuurcheck');
  const basis = round2(traject.total_amount);
  const pct = Number(traject.pct) || 0;
  const bonusTotal = round2(traject.bonus_total);
  if (!(basis > 0) || !(pct > 0) || !(bonusTotal > 0)) return leeg('bedrag, percentage of commissie ontbreekt');

  // Mentoren: aanwezig op het event (met login) + iedereen die al een
  // termijnregel kreeg (anders zou zijn vrijgegeven deel nergens hangen).
  const uids = [];
  const tmVan = new Map();
  for (const m of mentoren) {
    if (!m?.user_id || uids.includes(m.user_id)) continue;
    uids.push(m.user_id);
    tmVan.set(m.user_id, m.team_member_id || null);
  }
  const regels = termijnregels.filter((e) => isTrajectTermKey(e.idempotency_key)
    && TERM_KEY_RE.exec(e.idempotency_key)[1] === traject.id);
  for (const e of regels) {
    if (e.mentor_user_id && !uids.includes(e.mentor_user_id)) uids.push(e.mentor_user_id);
  }
  if (!uids.length) return leeg('geen aanwezige event-mentoren met login');

  // Oorspronkelijke commissie per mentor: bonus_total / N, restcent bij de laatste.
  const n = uids.length;
  const per = round2(bonusTotal / n);
  const parents = [];
  const koppelingen = [];
  const per_mentor = [];
  uids.forEach((uid, i) => {
    const original = i === n - 1 ? round2(bonusTotal - per * (n - 1)) : per;
    const eigen = regels.filter((e) => e.mentor_user_id === uid && e.status !== 'geannuleerd');
    const reeds = round2(eigen.reduce((s, e) => s + (Number(e.amount) || 0), 0));
    const key = saleParentKey(traject.id, uid);
    parents.push({
      mentor_user_id : uid,
      team_member_id : tmVan.get(uid) || null,
      event_id       : traject.event_id,
      entry_type     : 'bonus',
      customer_id    : customerId,
      basis,
      basis_incl_btw : true,
      pct,
      amount         : round2(Math.max(0, original - reeds)),
      original_amount: original,
      status         : 'pending',
      source_quote_id: dealId,
      source_invoice_id: null,
      idempotency_key: key,
      note           : `Handmatig traject ${traject.client_label || ''} omgezet naar factuurmotor — ${n} mentor(en); al vrijgegeven ${reeds.toFixed(2)} telt als reeds vrijgegeven`,
    });
    for (const e of eigen) if (!e.parent_entry_id) koppelingen.push({ entry_id: e.id, parent_key: key });
    // Dry-run: doel volgens de factuurmotor (commissie × betaald / basis) en
    // wat daarvan werkelijk uitbetaald is (rapport-status vs werkelijkheid).
    const stand = somPerStand(eigen, payoutById, uitbetaaldTot);
    const doel = betaald == null ? null : round2(original * Math.min(1, Math.max(0, betaald) / basis));
    per_mentor.push({
      mentor_user_id: uid,
      oorspronkelijk: original,
      reeds_vrijgegeven: reeds,
      nog_open: round2(Math.max(0, original - reeds)),
      te_veel: round2(Math.max(0, reeds - original)),
      doel_op_betaalde_facturen: doel,
      te_veel_vrijgegeven_t_o_v_doel: doel == null ? null : round2(Math.max(0, reeds - doel)),
      werkelijk_uitbetaald: stand.werkelijk_uitbetaald,
      status_uitbetaald: stand.status_uitbetaald,
      verschil_status_werkelijkheid: stand.verschil_status_werkelijkheid,
      vrijgegeven_niet_in_rapport: stand.niet_in_rapport,
      in_rapport_niet_uitbetaald: stand.in_rapport,
      te_veel_uitbetaald_t_o_v_doel: doel == null ? null : round2(Math.max(0, stand.werkelijk_uitbetaald - doel)),
      nog_te_krijgen_t_o_v_doel: doel == null ? null : round2(Math.max(0, doel - stand.werkelijk_uitbetaald)),
    });
  });
  return { ok: true, parents, koppelingen, per_mentor };
}

/**
 * Verrekening voor het overzicht/rapport. `reeds` = wat al vrijgegeven werd
 * via het oude traject. De eerste `reeds` euro aan BETAALDE termijnen is
 * daarmee al vergoed en telt niet opnieuw (geen dubbele commissie, geen
 * inhaal). Wat erboven komt telt wel. Termijnen in volgorde aanbieden.
 *
 * @param {number} reeds
 * @returns {{ neem(bedrag:number): number, rest(): number }} neem → het verrekende deel
 */
export function maakVerrekenaar(reeds) {
  let rest = round2(Math.max(0, Number(reeds) || 0));
  return {
    neem(bedrag) {
      const b = round2(bedrag);
      if (rest <= 0 || b <= 0) return 0;
      const a = round2(Math.min(rest, b));
      rest = round2(rest - a);
      return a;
    },
    rest: () => rest,
  };
}

/** Aanwezige event-mentoren met login (zelfde bron als de oude motor). */
async function aanwezigeMentoren(eventId) {
  const { data, error } = await supabaseAdmin
    .from('event_mentors')
    .select('team_member_id, was_present, team_members:team_member_id ( id, user_id )')
    .eq('event_id', eventId);
  if (error) throw new Error('event_mentors: ' + error.message);
  return (data || [])
    .filter((m) => m.was_present === true && m.team_members?.user_id)
    .map((m) => ({ team_member_id: m.team_member_id, user_id: m.team_members.user_id }));
}

/**
 * Zet één traject om (of berekent het enkel met dryRun). Schrijft parents,
 * koppelt de bestaande termijnregels en zet het traject op 'omgezet'.
 * Geen vrijgave hier: dat doet de factuurmotor (die rekent 0 zolang er te
 * veel vrijgegeven is).
 */
export async function omzetTraject({ trajectId, customerId = null, dealId = null, dryRun = true } = {}) {
  const { data: t, error: tErr } = await supabaseAdmin
    .from('mentor_cash_trajects')
    .select('id, event_id, customer_id, client_label, total_amount, term_count, pct, bonus_total, start_month, status')
    .eq('id', trajectId).maybeSingle();
  if (tErr) throw new Error('traject: ' + tErr.message);
  if (!t) return { ok: false, reden: 'traject niet gevonden' };
  const cust = customerId || t.customer_id || null;
  const deal = dealId || t.deal_id || null;

  if (deal) {
    const { data: d, error: dErr } = await supabaseAdmin.from('deals').select('id, customer_id').eq('id', deal).maybeSingle();
    if (dErr) throw new Error('deal: ' + dErr.message);
    if (!d) return { ok: false, reden: 'deal niet gevonden' };
    if (cust && d.customer_id !== cust) return { ok: false, reden: 'deal hoort niet bij deze klant' };
  }

  const mentoren = await aanwezigeMentoren(t.event_id);
  const { data: regels, error: rErr } = await supabaseAdmin
    .from('mentor_ledger_entries')
    .select('id, mentor_user_id, amount, status, parent_entry_id, idempotency_key, payout_id, released_at')
    .like('idempotency_key', `cashtraject:${t.id}:%`);
  if (rErr) throw new Error('grootboek: ' + rErr.message);

  // Dry-run-context: betaald op de facturen van de klant (zelfde regel als de
  // factuurmotor bij een klant met één commissie-sale) + rapportstanden.
  let betaald = null;
  if (cust) {
    const { data: invs, error: iErr } = await supabaseAdmin.from('invoices')
      .select('id, amount_total, amount_paid, credited_amount, status').eq('customer_id', cust);
    if (iErr) throw new Error('facturen: ' + iErr.message);
    betaald = round2((invs || []).filter((i) => !isConcept(i)).reduce((som, i) => som + betaaldBedrag(i), 0));
  }
  const payoutIds = [...new Set((regels || []).map((e) => e.payout_id).filter(Boolean))];
  const payoutById = new Map();
  if (payoutIds.length) {
    const { data: ps, error: pErr } = await supabaseAdmin.from('mentor_payouts')
      .select('id, status, period_month').in('id', payoutIds);
    if (pErr) throw new Error('rapporten: ' + pErr.message);
    for (const p of ps || []) payoutById.set(p.id, p);
  }
  const uitbetaaldTot = await laadUitbetaaldTot(supabaseAdmin);
  const plan = planOmzetting({ traject: t, customerId: cust, dealId: deal, mentoren, termijnregels: regels || [], betaald, payoutById, uitbetaaldTot });
  const bestaand = new Map((regels || []).filter((e) => isTrajectParentKey(e.idempotency_key)).map((e) => [e.idempotency_key, e.id]));
  const uit = { ...plan, traject_id: t.id, client_label: t.client_label, customer_id: cust, deal_id: deal, betaald_crm: betaald, uitbetaald_tot: uitbetaaldTot, dry_run: !!dryRun, al_omgezet: bestaand.size > 0 };
  if (!plan.ok || dryRun) return uit;

  // 1) Parents (23505 = al omgezet → bestaande id gebruiken).
  const idVan = new Map(bestaand);
  for (const p of plan.parents) {
    if (idVan.has(p.idempotency_key)) continue;
    const { data, error } = await supabaseAdmin.from('mentor_ledger_entries').insert(p).select('id').maybeSingle();
    if (error && error.code !== '23505') throw new Error('parent insert: ' + error.message);
    if (data?.id) idVan.set(p.idempotency_key, data.id);
    else {
      const { data: b } = await supabaseAdmin.from('mentor_ledger_entries').select('id').eq('idempotency_key', p.idempotency_key).maybeSingle();
      if (b?.id) idVan.set(p.idempotency_key, b.id);
    }
  }
  // 2) Termijnregels koppelen — alleen metadata, nooit bedrag/status.
  for (const k of plan.koppelingen) {
    const pid = idVan.get(k.parent_key);
    if (!pid) throw new Error('parent ontbreekt na insert: ' + k.parent_key);
    const { error } = await supabaseAdmin.from('mentor_ledger_entries')
      .update({ parent_entry_id: pid, customer_id: cust, source_quote_id: deal })
      .eq('id', k.entry_id).is('parent_entry_id', null);
    if (error) throw new Error('koppelen: ' + error.message);
  }
  // 3) Traject markeren (nooit meer datumvrijval).
  const { error: uErr } = await supabaseAdmin.from('mentor_cash_trajects')
    .update({ status: 'omgezet', customer_id: cust, deal_id: deal, omgezet_op: new Date().toISOString() })
    .eq('id', t.id);
  if (uErr) throw new Error('traject markeren: ' + uErr.message);
  return { ...uit, dry_run: false };
}
