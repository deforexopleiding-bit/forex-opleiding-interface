// api/_lib/webinar-dashboard.js
//
// Webinar fase 3 (2026-10-12) — de trechter per funnel (webinar-v1 vs v2) en
// totaal: aanmeldingen → calls → sales → Karls commissie. Bewust GEEN opkomst /
// show-rate. Plus "calls via de QR zonder aanmelding" apart.
//
// Definities (zelfde als de na-webinar opvolging, api/_lib/webinar-opvolging.js):
//   - aanmeldingen = rijen in webinar_aanmeldingen (geen test); personen = uniek
//     e-mailadres; de funnel van een persoon = die van zijn EERSTE aanmelding;
//   - call = een afspraak met booking_source 'webinar', ná de aanmelding, op
//     e-mail / telefoon (laatste 9) / lead_id, niet cancelled/verwijderd
//     (webinarBoekingVan) — geteld per persoon;
//   - QR zonder aanmelding = zo'n (oorspronkelijke, niet verzette) boeking die
//     bij geen enkele aanmelder hoort;
//   - sale = een deal met setter = de eigenaar van de 'webinar'-link (Karl), niet
//     gearchiveerd/afgewezen; bij een aanmelder via source_lead_id = lead_id of
//     e-mail/telefoon van de klant, anders "zonder aanmelding";
//   - commissie = de setter-motor (laadCommissieData + planCommissie): al geboekt
//     (setter_ledger_entries) + wat de cron nu zou boeken. Met de dry-run AAN is
//     "geboekt" 0 en is "zou boeken" het bedrag.

import { webinarBoekingVan, zelfdePersoon, normEmail, tel9 } from './webinar-opvolging.js';
import { laadCommissieData, planCommissie, isSetterCommissieDryRun } from './setter-commissie-core.js';
import { isUitgeslotenDeal, round2 } from './setter-sale-plan.js';

export const FUNNELS = Object.freeze(['webinar-v1', 'webinar-v2']);
const AFGEVALLEN = new Set(['cancelled', 'verwijderd']);

const leeg = () => ({ aanmeldingen: 0, personen: 0, calls: 0, sales: 0, commissie_geboekt: 0, commissie_te_boeken: 0, commissie: 0 });

/** Commissie per deal uit het setter-plan: { [deal_id]: { geboekt, te_boeken } }. PURE. */
export function commissiePerDeal(plan, entries = []) {
  const perDeal = {};
  const bij = (id) => (perDeal[id] = perDeal[id] || { geboekt: 0, te_boeken: 0 });
  const dealVanFactuur = new Map((plan?.facturen || []).map((f) => [f.invoice_id, f.deal_id]));
  for (const e of entries) {
    const d = dealVanFactuur.get(e.invoice_id);
    if (d) bij(d).geboekt = round2(bij(d).geboekt + Number(e.amount || 0));
  }
  for (const m of plan?.mutaties || []) bij(m.deal_id).te_boeken = round2(bij(m.deal_id).te_boeken + Number(m.amount || 0));
  return perDeal;
}

/**
 * De trechter. PURE.
 * @param {object} p
 * @param {Array} p.aanmeldingen  webinar_aanmeldingen
 * @param {Array} p.afspraken     follow_up_appointments met booking_source 'webinar'
 * @param {Array} p.submissions   opstartsessie_submissions (webinar, met lead_id)
 * @param {Array} p.deals         deals van de setter (Karl)
 * @param {Array} p.klanten       customers { id, email, phone } van die deals
 * @param {object} p.commissie    { [deal_id]: { geboekt, te_boeken } }
 */
export function berekenDashboard({ aanmeldingen = [], afspraken = [], submissions = [], deals = [], klanten = [], commissie = {} } = {}) {
  const echt = aanmeldingen.filter((a) => !a.is_test);
  // Personen: uniek e-mailadres; funnel = die van de eerste aanmelding.
  const personen = new Map();
  for (const a of [...echt].sort((x, y) => String(x.aangemeld_op).localeCompare(String(y.aangemeld_op)))) {
    const k = normEmail(a.email);
    if (!personen.has(k)) personen.set(k, { funnel: FUNNELS.includes(a.bron) ? a.bron : 'overig', rijen: [] });
    personen.get(k).rijen.push(a);
  }
  const per = Object.fromEntries([...FUNNELS, 'overig'].map((f) => [f, leeg()]));
  for (const a of echt) per[FUNNELS.includes(a.bron) ? a.bron : 'overig'].aanmeldingen++;
  for (const p of personen.values()) {
    per[p.funnel].personen++;
    if (p.rijen.some((a) => webinarBoekingVan(a, { afspraken, submissions }))) per[p.funnel].calls++;
  }

  // QR zonder aanmelding: oorspronkelijke, geldige webinar-boekingen die bij niemand horen.
  const zonder = leeg();
  const hoortBij = (afspraak) => [...personen.values()].find((p) => p.rijen.some((a) => zelfdePersoon(afspraak, a, submissions))) || null;
  for (const b of afspraken) {
    if (b.booking_source !== 'webinar' || b.parent_appointment_id || AFGEVALLEN.has(String(b.status || ''))) continue;
    if (!hoortBij(b)) zonder.calls++;
  }

  // Sales + commissie per funnel.
  const klantVan = new Map(klanten.map((k) => [k.id, k]));
  const persoonVanDeal = (d) => {
    for (const p of personen.values()) {
      if (d.source_lead_id && p.rijen.some((a) => a.lead_id && a.lead_id === d.source_lead_id)) return p;
    }
    const k = klantVan.get(d.customer_id);
    if (!k) return null;
    const e = normEmail(k.email); const t = tel9(k.phone);
    for (const p of personen.values()) {
      if (p.rijen.some((a) => (e && normEmail(a.email) === e) || (t && tel9(a.telefoon) === t))) return p;
    }
    return null;
  };
  for (const d of deals) {
    if (isUitgeslotenDeal(d)) continue;
    const p = persoonVanDeal(d);
    const doel = p ? per[p.funnel] : zonder;
    doel.sales++;
    const c = commissie[d.id] || { geboekt: 0, te_boeken: 0 };
    doel.commissie_geboekt = round2(doel.commissie_geboekt + c.geboekt);
    doel.commissie_te_boeken = round2(doel.commissie_te_boeken + c.te_boeken);
  }

  const afronden = (r) => ({ ...r, commissie: round2(r.commissie_geboekt + r.commissie_te_boeken) });
  const funnels = FUNNELS.map((f) => ({ funnel: f, ...afronden(per[f]) }));
  if (per.overig.aanmeldingen) funnels.push({ funnel: 'overig', ...afronden(per.overig) });
  const totaal = afronden(funnels.reduce((t, r) => {
    for (const k of Object.keys(t)) t[k] = round2(t[k] + r[k]);
    return t;
  }, leeg()));
  return { funnels, totaal, zonder_aanmelding: afronden(zonder) };
}

/** Alles laden en berekenen (lezend). */
export async function laadDashboard(sb) {
  const lees = async (q, wat) => { const { data, error } = await q; if (error) throw new Error(wat + ': ' + error.message); return data || []; };
  const { data: bron } = await sb.from('booking_sources').select('owner_user_id').eq('slug', 'webinar').maybeSingle();
  const setterId = bron?.owner_user_id || null;
  const [aanmeldingen, afspraken, submissions] = await Promise.all([
    lees(sb.from('webinar_aanmeldingen').select('id, email, telefoon, lead_id, bron, aangemeld_op, is_test').limit(20000), 'aanmeldingen'),
    lees(sb.from('follow_up_appointments').select('id, lead_email, lead_phone, status, booking_source, created_at, scheduled_at, parent_appointment_id').eq('booking_source', 'webinar').limit(20000), 'webinar-boekingen'),
    sb.from('opstartsessie_submissions').select('lead_id, appointment_id, booking_source').eq('booking_source', 'webinar').not('lead_id', 'is', null).limit(20000)
      .then(({ data, error }) => { if (error) console.warn('[webinar-dashboard] submissies (fail-soft):', error.message); return data || []; }),
  ]);

  let deals = []; let klanten = []; let commissie = {}; let setterNaam = null;
  const dryRun = await isSetterCommissieDryRun(sb);
  if (setterId) {
    deals = await lees(sb.from('deals').select('id, customer_id, source_lead_id, setter_user_id, archived_at, tl_quotation_status').eq('setter_user_id', setterId), 'deals');
    const klantIds = [...new Set(deals.map((d) => d.customer_id).filter(Boolean))];
    if (klantIds.length) klanten = await lees(sb.from('customers').select('id, email, phone').in('id', klantIds), 'klanten');
    const data = await laadCommissieData(sb, { setterIds: [setterId] });
    const [plan] = planCommissie(data);
    commissie = commissiePerDeal(plan, data.entries);
    const { data: prof } = await sb.from('profiles').select('full_name').eq('id', setterId).maybeSingle();
    setterNaam = prof?.full_name || null;
  }
  return {
    ...berekenDashboard({ aanmeldingen, afspraken, submissions, deals, klanten, commissie }),
    setter: setterId ? { id: setterId, naam: setterNaam } : null,
    dry_run: dryRun,
    gegenereerd_op: new Date().toISOString(),
  };
}
