// api/_lib/commissie-zicht.js
//
// ZICHTBAARHEID van mentorcommissie + incasso per sale (offerte), 12 nov 2026.
// Eén leeslaag voor: de kaart op de offertepagina, de kolom Commissie in
// Sales › Offertes, Soort/Hangt aan in Finance › Abonnementen en de tab
// Finance › Commissie & incasso.
//
// GEEN tweede rekenmotor:
//   - commissie (toezegging, vrijgegeven, uitbetaald) = het grootboek
//     (commissie-annulering.js: vatSamen);
//   - welke facturen en abonnementen bij de sale horen = dezelfde regel als de
//     factuurmotor (commissie-core.js: saleFacturenVoorDeals → factuurVanSale);
//     cash (cash_ontvangsten) loopt via de gewone betaalflow en telt dus mee
//     in amount_paid en in de vrijgegeven stukken;
//   - incasso = de ene status in mentor_commissie_incasso (klant-incassostatus.js);
//   - soort = subscriptions.soort / aanpassing_type / sale_deal_id.
// Alleen lezen.

import { laadCommissieVanDeals, vorigeVervangenCommissie, isActiefAbonnement } from './commissie-annulering.js';
import { saleFacturenVoorDeals } from './commissie-core.js';
import { laadIncassoRijen, huidigeStatus } from './klant-incassostatus.js';
import { customerDisplayName } from './customer-name.js';
import { SOORT_LABEL, AANPASSING_LABEL } from './subscription-soort.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GETEKEND = new Set(['accepted', 'signed']);
const DEAL_KOLOMMEN = 'id, customer_id, total_amount, discount_percentage, sale_type, quote_reference, tl_quotation_status, tl_quotation_accepted_at, created_at, archived_at, sales_user_id, traject_variant_id';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const isGetekend = (d) => !!d && (GETEKEND.has(String(d.tl_quotation_status || '').toLowerCase()) || !!d.tl_quotation_accepted_at);

async function alle(q, wat) {
  const { data, error } = await q;
  if (error) throw new Error(`${wat}: ${error.message}`);
  return data || [];
}

/** Label van een abonnementssoort ("Aanpassing · uitstel"), null zonder soort. */
export function soortTekst(s) {
  if (!s?.soort) return null;
  return (SOORT_LABEL[s.soort] || s.soort) + (s.aanpassing_type ? ' · ' + (AANPASSING_LABEL[s.aanpassing_type] || s.aanpassing_type) : '');
}

/** Hoe komt de commissie vrij? Uit de abonnementen van de sale. Puur. */
export function vrijkomenTekst(subs) {
  const actief = (subs || []).filter(isActiefAbonnement);
  const lijst = actief.length ? actief : (subs || []);
  if (!lijst.length) return 'per betaalde factuur van deze offerte';
  const een = lijst.filter((s) => Number(s.term_count) === 1).length;
  const termijnen = lijst.filter((s) => Number(s.term_count) > 1).reduce((t, s) => t + Number(s.term_count), 0);
  const delen = [];
  if (een) delen.push(een === 1 ? 'aanbetaling' : `${een} eenmalige betalingen`);
  if (termijnen) delen.push(`${termijnen} termijnen`);
  return (delen.join(' + ') || 'per betaalde factuur') + ' — per betaalde factuur naar verhouding';
}

/**
 * Statuspil van een sale (zie de opdracht): Wacht op betaling / Deels /
 * Volledig / Achterstallig / Incasso / Geannuleerd. Puur.
 */
export function statusPil({ commissie, incasso, achterstallig }) {
  const c = commissie;
  if (!c || !c.heeft_commissie) return { k: 'geen', l: 'Geen commissie', c: 'neutral' };
  if (c.status === 'geannuleerd') return { k: 'geannuleerd', l: 'Geannuleerd', c: 'neutral' };
  if (incasso && incasso.status === 'bij_incasso') return { k: 'incasso', l: 'Incasso', c: 'danger' };
  if (c.totaal > 0 && c.vrijgegeven >= c.totaal - 0.01) return { k: 'volledig', l: 'Volledig vrijgegeven', c: 'ok' };
  if (achterstallig > 0.004) return { k: 'achterstallig', l: 'Achterstallig', c: 'danger' };
  if (c.vrijgegeven > 0.004) return { k: 'deels', l: 'Deels vrijgegeven', c: 'accent' };
  return { k: 'wacht', l: 'Wacht op betaling', c: 'neutral' };
}

/**
 * Wat moet een mens nakijken op deze sale? Puur. Codes:
 *   verkoper_mentor_geen_commissie   getekend, verkoper is mentor, geen commissie (geen membership)
 *   commissie_zonder_abonnement      open commissie, offerte gearchiveerd/weg of geen actief abonnement meer
 *   soort_ontbreekt                  sale met commissie heeft een abonnement zonder soort
 */
export function teChecken({ deal, commissie, verkoper, membership, subs, incasso = null }) {
  const uit = [];
  const getekend = deal ? isGetekend(deal) : false;
  if (deal && getekend && !deal.archived_at && verkoper?.is_mentor && !commissie?.heeft_commissie && !membership) {
    uit.push('verkoper_mentor_geen_commissie');
  }
  if (commissie?.open) {
    const actief = (subs || []).some(isActiefAbonnement);
    // Bij een open incasso-markering verklaart de incassostatus het al
    // (commissie staat stil); die klant staat onder het tabblad Incasso.
    if (!incasso && (!deal || deal.archived_at || ((subs || []).length && !actief))) uit.push('commissie_zonder_abonnement');
    // Soort enkel voor abonnementen die nog lopen (active / paused).
    if ((subs || []).some((s) => !s.soort && ['active', 'paused'].includes(String(s.status || '').toLowerCase()))) uit.push('soort_ontbreekt');
  }
  return uit;
}
export const TE_CHECKEN_LABEL = {
  verkoper_mentor_geen_commissie: 'Verkoper is mentor maar geen commissie',
  commissie_zonder_abonnement: 'Commissie op een gearchiveerde/verwijderde offerte zonder actief abonnement',
  soort_ontbreekt: 'Abonnement zonder soort bij een sale met commissie',
  event_sale_niet_aanwezig: 'Event-sale gekoppeld maar deelnemer niet op Aanwezig',
  vervangen_niet_gekoppeld: 'Offerte vervangen, nieuwe offerte nog niet toegewezen',
};

async function verkopers(db, uids) {
  const out = new Map();
  if (!uids.length) return out;
  const [profs, tms] = await Promise.all([
    db.from('profiles').select('id, full_name, email, role').in('id', uids),
    db.from('team_members').select('user_id, name, type, is_active').in('user_id', uids),
  ]);
  for (const p of profs.data || []) out.set(p.id, { user_id: p.id, naam: p.full_name || p.email || '(verkoper)', is_mentor: String(p.role || '') === 'mentor' });
  for (const t of tms.data || []) {
    const cur = out.get(t.user_id) || { user_id: t.user_id, naam: t.name || '(verkoper)', is_mentor: false };
    if (t.name) cur.naam = t.name;
    if (String(t.type || '') === 'mentor') cur.is_mentor = true;
    out.set(t.user_id, cur);
  }
  return out;
}

async function membershipDeals(db, deals) {
  const varIds = [...new Set(deals.map((d) => d.traject_variant_id).filter(Boolean))];
  const out = new Set();
  if (!varIds.length) return out;
  const { data: vars } = await db.from('traject_variants').select('id, name, traject_id').in('id', varIds);
  const tIds = [...new Set((vars || []).map((v) => v.traject_id).filter(Boolean))];
  const { data: ts } = tIds.length ? await db.from('trajects').select('id, name').in('id', tIds) : { data: [] };
  const tNaam = new Map((ts || []).map((t) => [t.id, t.name || '']));
  const isMem = new Set((vars || []).filter((v) => /membership/i.test(`${v.name || ''} ${tNaam.get(v.traject_id) || ''}`)).map((v) => v.id));
  for (const d of deals) if (isMem.has(d.traject_variant_id)) out.add(d.id);
  return out;
}

/**
 * Zicht per deal. opts.metFacturen = facturen + abonnementen van de sale
 * (zelfde regel als de factuurmotor). Zonder: enkel grootboek + incasso +
 * verkoper (snel, voor lijsten).
 * @returns {Map<dealId, object>}
 */
export async function laadZicht(db, dealIds, { metFacturen = true } = {}) {
  const ids = [...new Set((dealIds || []).filter((d) => UUID_RE.test(String(d || ''))))];
  const out = new Map();
  if (!ids.length) return out;
  const deals = [];
  for (let i = 0; i < ids.length; i += 150) deals.push(...await alle(db.from('deals').select(DEAL_KOLOMMEN).in('id', ids.slice(i, i + 150)), 'deals'));
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const commissie = await laadCommissieVanDeals(db, ids);
  const custIds = [...new Set(deals.map((d) => d.customer_id).filter(Boolean))];
  const [inc, vk, mem, custs] = await Promise.all([
    laadIncassoRijen(db, custIds, { alleenActief: true }),
    verkopers(db, [...new Set(deals.map((d) => d.sales_user_id).filter(Boolean))]),
    membershipDeals(db, deals),
    custIds.length ? alle(db.from('customers').select('id, is_company, company_name, first_name, last_name').in('id', custIds), 'customers') : [],
  ]);
  const klantNaam = new Map(custs.map((c) => [c.id, customerDisplayName(c, '(klant)')]));
  let sale = new Map();
  if (metFacturen && deals.length) {
    for (let i = 0; i < deals.length; i += 60) {
      const m = await saleFacturenVoorDeals(deals.slice(i, i + 60));
      sale = new Map([...sale, ...m]);
    }
  }
  for (const id of ids) {
    const d = dealById.get(id) || null;
    const c = commissie.get(id);
    const f = sale.get(id) || null;
    const incasso = d?.customer_id ? huidigeStatus(inc.rijen, d.customer_id) : null;
    const incassoUit = incasso && incasso.status !== 'actief' ? { status: incasso.status, label: incasso.label, sinds: incasso.sinds } : null;
    const verkoper = d?.sales_user_id ? (vk.get(d.sales_user_id) || { user_id: d.sales_user_id, naam: '(verkoper)', is_mentor: false }) : null;
    const subs = f ? f.subs.map((s) => ({
      id: s.id, deal_id: s.deal_id, description: s.description || null, status: s.status, soort: s.soort || null,
      aanpassing_type: s.aanpassing_type || null, sale_deal_id: s.sale_deal_id || null, soort_label: soortTekst(s),
      start_date: s.start_date || null, term_count: s.term_count || null, amount: s.amount ?? null,
    })) : [];
    out.set(id, {
      deal_id: id,
      bestaat: !!d,
      offerte: d?.quote_reference || null,
      customer_id: d?.customer_id || null,
      klant: d?.customer_id ? (klantNaam.get(d.customer_id) || null) : null,
      getekend: d ? isGetekend(d) : null,
      gearchiveerd: !!d?.archived_at,
      membership: mem.has(id),
      verkoper,
      commissie: c,
      incasso: incassoUit,
      abonnementen: subs,
      abonnementen_actief: subs.filter(isActiefAbonnement).length,
      facturen: f ? { aantal: f.facturen.length, betaald: f.betaald, open: f.open, achterstallig: f.achterstallig, achterstallig_aantal: f.achterstallig_aantal } : null,
      basis_incl: f ? f.basis_incl : (d ? round2(d.total_amount) : null),
      vrijkomen: f ? vrijkomenTekst(f.subs) : null,
      status: statusPil({ commissie: c, incasso: incassoUit, achterstallig: f?.achterstallig || 0 }),
      te_checken: teChecken({ deal: d, commissie: c, verkoper, membership: mem.has(id), subs: f ? f.subs : [], incasso: incassoUit }),
    });
  }
  return out;
}

/** Eén offerte met alles voor de kaart (incl. banner "vorige offerte had commissie"). */
export async function zichtVoorDeal(db, dealId) {
  const z = (await laadZicht(db, [dealId], { metFacturen: true })).get(dealId);
  if (!z) return null;
  if (z.customer_id && z.getekend && !(z.commissie?.status === 'actief')) {
    try { z.vorige_vervangen = await vorigeVervangenCommissie(db, { customerId: z.customer_id, dealId }); } catch (e) {
      console.warn('[commissie-zicht] vorige vervangen:', e?.message || e);
      z.vorige_vervangen = null;
    }
  } else z.vorige_vervangen = null;
  return z;
}
