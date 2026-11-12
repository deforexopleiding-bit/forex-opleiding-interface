// api/_lib/commissie-incasso-overzicht.js
//
// Finance › "Commissie & incasso" (12 nov 2026). Alleen lezen. Bronnen:
//   - Te checken: Mentoren › Commissies › Controle (commissie-controle.js) —
//     ZELFDE rijen, dus beide schermen tonen hetzelfde aantal voor
//     "soort ontbreekt" en "event-sale zonder commissie"; aangevuld met de
//     signalen van de annulatie-regels (vervangen niet gekoppeld, commissie
//     zonder actief abonnement, verkoper is mentor maar geen commissie);
//   - Incasso: mentor_commissie_incasso (de ene status, klant-incassostatus.js),
//     abonnementen van soort incasso_regeling, dunning_incasso_dossiers;
//   - Abonnementen per soort: subscriptions.soort.
// "Commissie per sale" haalt de UI uit /api/commissie-overzicht (geen tweede
// rekenmotor). De mens kiest altijd: hier wordt niets gewijzigd.

import { commissieControle } from './commissie-controle.js';
import { leesAnnulering, vorigeVervangenCommissie, isActiefAbonnement, saleVanAbonnement, OPEN_STATUSSEN } from './commissie-annulering.js';
import { laadZicht, isGetekend } from './commissie-zicht.js';
import { laadSubsMetSoort, SOORTEN } from './subscription-soort.js';
import { statusVan, STATUS_LABEL } from './klant-incassostatus.js';
import { customerDisplayName } from './customer-name.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function alle(db, tabel, kolommen, bouw = (q) => q) {
  const uit = [];
  for (let van = 0; ; van += 1000) {
    const { data, error } = await bouw(db.from(tabel).select(kolommen)).range(van, van + 999);
    if (error) throw new Error(`${tabel}: ${error.message}`);
    uit.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return uit;
}
const inChunks = async (ids, fn) => {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...(await fn(ids.slice(i, i + 150))));
  return out;
};

/** Puur: Te checken-items uit de Controle-rijen. */
export function teCheckenUitControle(rijen) {
  const items = [];
  for (const r of rijen || []) {
    const a = r.afwijkingen || [];
    if (a.includes('geen_commissie')) {
      items.push({ code: 'event_sale_niet_aanwezig', klant: r.klant, customer_id: r.customer_id, deal_id: r.deal_id, event_id: r.event_id, event: r.event,
        uitleg: r.uitleg || 'Getekende deal op een event met aanwezige mentoren, zonder commissie.', deelnemer_status: r.deelnemer_status || null });
    }
    if (a.includes('soort_ontbreekt')) {
      for (const s of r.zonder_soort || []) {
        items.push({ code: 'soort_ontbreekt', klant: r.klant, customer_id: r.customer_id, deal_id: r.deal_id, subscription_id: s.id, sub: s,
          mentoren: r.mentoren || [], bron: r.bron, event: r.event, uitleg: 'Abonnement zonder soort bij een sale met commissie.' });
      }
    }
  }
  return items;
}

export async function commissieIncassoOverzicht(db) {
  const fouten = [];
  const veilig = async (wat, fn, standaard) => {
    try { return await fn(); } catch (e) { console.error('[commissie-incasso-overzicht]', wat, e?.message || e); fouten.push({ naam: wat, fout: e?.message || String(e) }); return standaard; }
  };

  // 1) Controle = dezelfde bron als Mentoren › Commissies › Controle.
  const controle = await veilig('Controle', () => commissieControle(db), { rijen: [] });
  const teChecken = teCheckenUitControle(controle.rijen);

  // 2) Grootboek-ouders (alle) voor de annulatie-signalen.
  const parents = await veilig('Grootboek', () => alle(db, 'mentor_ledger_entries',
    'id, mentor_user_id, customer_id, source_quote_id, status, note, attribution_id, event_id, amount, original_amount, created_at',
    (q) => q.eq('entry_type', 'bonus').is('parent_entry_id', null)), []);
  const custIdsLedger = [...new Set(parents.map((p) => p.customer_id).filter(Boolean))];

  // 2a) Commissie open op een offerte die weg/gearchiveerd is of geen actief abonnement meer heeft.
  await veilig('Commissie zonder abonnement', async () => {
    const open = parents.filter((p) => OPEN_STATUSSEN.includes(p.status) && p.source_quote_id && p.customer_id);
    const custIds = [...new Set(open.map((p) => p.customer_id))];
    if (!custIds.length) return;
    const deals = await inChunks(custIds, (ids) => alle(db, 'deals', 'id, customer_id, quote_reference, archived_at', (q) => q.in('customer_id', ids)));
    const subs = await laadSubsMetSoort(db, deals.map((d) => d.id), 'id, deal_id, status');
    const dealById = new Map(deals.map((d) => [d.id, d]));
    const custs = await inChunks(custIds, (ids) => alle(db, 'customers', 'id, is_company, company_name, first_name, last_name, is_test', (q) => q.in('id', ids)));
    const naam = new Map(custs.map((c) => [c.id, customerDisplayName(c, '(klant)')]));
    const gezien = new Set();
    for (const p of open) {
      if (gezien.has(p.source_quote_id)) continue;
      gezien.add(p.source_quote_id);
      const d = dealById.get(p.source_quote_id) || null;
      const eigen = subs.filter((s) => saleVanAbonnement(s) === p.source_quote_id);
      const geenActief = eigen.length > 0 && !eigen.some(isActiefAbonnement);
      if (d && !d.archived_at && !geenActief) continue;
      teChecken.push({ code: 'commissie_zonder_abonnement', klant: naam.get(p.customer_id) || '(klant)', customer_id: p.customer_id, deal_id: p.source_quote_id,
        offerte: d?.quote_reference || null, deal_bestaat: !!d,
        uitleg: !d ? 'Offerte is verwijderd, de commissie staat nog open.' : d.archived_at ? 'Offerte is gearchiveerd, de commissie staat nog open.' : 'Geen actief abonnement meer op deze sale, de commissie staat nog open.' });
    }
  }, null);

  // 2b) Offerte vervangen, nieuwe offerte nog niet toegewezen.
  await veilig('Vervangen niet gekoppeld', async () => {
    const klanten = [...new Set(parents.filter((p) => leesAnnulering(p)?.soort === 'vervangen').map((p) => p.customer_id).filter(Boolean))];
    for (const c of klanten) {
      const deals = await alle(db, 'deals', 'id, customer_id, quote_reference, tl_quotation_status, tl_quotation_accepted_at, created_at, archived_at', (q) => q.eq('customer_id', c));
      const nieuw = deals.filter((d) => isGetekend(d) && !d.archived_at)
        .sort((a, b) => String(b.tl_quotation_accepted_at || b.created_at || '').localeCompare(String(a.tl_quotation_accepted_at || a.created_at || '')))[0] || null;
      const v = await vorigeVervangenCommissie(db, { customerId: c, dealId: nieuw?.id || '00000000-0000-0000-0000-000000000000' });
      if (!v) continue;
      teChecken.push({ code: 'vervangen_niet_gekoppeld', customer_id: c, deal_id: nieuw?.id || null, offerte: nieuw?.quote_reference || null,
        vorige: v, klant: null, uitleg: nieuw ? 'Vorige offerte had commissie en werd vervangen; koppel de nieuwe offerte.' : 'Vorige offerte had commissie en werd vervangen; er is nog geen nieuwe getekende offerte.' });
    }
  }, null);

  // 2c) Verkoper is mentor, getekende offerte zonder commissie (geen membership).
  await veilig('Verkoper is mentor', async () => {
    const tms = await alle(db, 'team_members', 'user_id, type', (q) => q.eq('type', 'mentor'));
    const mentorUids = [...new Set(tms.map((t) => t.user_id).filter(Boolean))];
    if (!mentorUids.length) return;
    const deals = await inChunks(mentorUids, (ids) => alle(db, 'deals', 'id, tl_quotation_status, tl_quotation_accepted_at, archived_at, sales_user_id', (q) => q.in('sales_user_id', ids).is('archived_at', null)));
    const metCommissie = new Set(parents.map((p) => p.source_quote_id).filter(Boolean));
    const kand = deals.filter((d) => isGetekend(d) && !metCommissie.has(d.id)).map((d) => d.id);
    const zicht = await laadZicht(db, kand, { metFacturen: false });
    for (const z of zicht.values()) {
      if (!(z.te_checken || []).includes('verkoper_mentor_geen_commissie')) continue;
      teChecken.push({ code: 'verkoper_mentor_geen_commissie', klant: z.klant, customer_id: z.customer_id, deal_id: z.deal_id, offerte: z.offerte,
        verkoper: z.verkoper, uitleg: `Verkoper ${z.verkoper?.naam || ''} is mentor; er staat geen commissie op deze getekende offerte.` });
    }
  }, null);

  // Klantnamen aanvullen.
  await veilig('Klantnamen', async () => {
    const zonder = [...new Set(teChecken.filter((t) => !t.klant && t.customer_id).map((t) => t.customer_id))];
    if (!zonder.length) return;
    const custs = await inChunks(zonder, (ids) => alle(db, 'customers', 'id, is_company, company_name, first_name, last_name', (q) => q.in('id', ids)));
    const naam = new Map(custs.map((c) => [c.id, customerDisplayName(c, '(klant)')]));
    for (const t of teChecken) if (!t.klant) t.klant = naam.get(t.customer_id) || '(klant)';
  }, null);

  // 3) Incasso — de ene status + regelingen + dossiers.
  const incasso = await veilig('Incasso', async () => {
    const rijen = await alle(db, 'mentor_commissie_incasso', 'id, customer_id, deal_id, sinds, reden, status, afgesloten_als, incasso_sinds, opgeheven_op, opheffen_reden', (q) => q.is('deal_id', null));
    const subsReg = await alle(db, 'subscriptions', 'id, deal_id, description, status, start_date, term_count, sale_deal_id', (q) => q.eq('soort', 'incasso_regeling')).catch(() => []);
    const dossiers = await alle(db, 'dunning_incasso_dossiers', 'id, customer_id, status, opened_at, updated_at').catch(() => []);
    const dealIdsReg = [...new Set(subsReg.map((s) => s.deal_id).filter(Boolean))];
    const regDeals = dealIdsReg.length ? await inChunks(dealIdsReg, (ids) => alle(db, 'deals', 'id, customer_id', (q) => q.in('id', ids))) : [];
    const klantVanDeal = new Map(regDeals.map((d) => [d.id, d.customer_id]));
    const custIds = [...new Set([...rijen.map((r) => r.customer_id), ...dossiers.map((d) => d.customer_id), ...regDeals.map((d) => d.customer_id)].filter(Boolean))];
    const custs = custIds.length ? await inChunks(custIds, (ids) => alle(db, 'customers', 'id, is_company, company_name, first_name, last_name', (q) => q.in('id', ids))) : [];
    const naam = new Map(custs.map((c) => [c.id, customerDisplayName(c, '(klant)')]));
    const metCommissie = new Set(custIdsLedger);
    const kaart = (r) => ({ customer_id: r.customer_id, klant: naam.get(r.customer_id) || '(klant)', sinds: r.sinds || null, reden: r.reden || null,
      status: statusVan(r), label: STATUS_LABEL[statusVan(r)] || statusVan(r), afgesloten_als: r.afgesloten_als || null, opgeheven_op: r.opgeheven_op || null,
      commissie: metCommissie.has(r.customer_id),
      dossier: dossiers.find((d) => d.customer_id === r.customer_id) ? { status: dossiers.find((d) => d.customer_id === r.customer_id).status } : null,
      regeling_abonnementen: subsReg.filter((s) => klantVanDeal.get(s.deal_id) === r.customer_id).length });
    const actief = rijen.filter((r) => !r.opgeheven_op);
    const bij = actief.filter((r) => statusVan(r) === 'bij_incasso').map(kaart);
    const reg = actief.filter((r) => statusVan(r) === 'incasso_regeling').map(kaart);
    const dicht = [...actief.filter((r) => statusVan(r) === 'afgesloten'), ...rijen.filter((r) => r.opgeheven_op)].map(kaart)
      .sort((a, b) => String(b.opgeheven_op || b.sinds || '').localeCompare(String(a.opgeheven_op || a.sinds || ''))).slice(0, 100);
    return { bij_incasso: bij, regeling: reg, afgesloten: dicht, regeling_abonnementen: subsReg.length, dossiers: dossiers.length };
  }, { bij_incasso: [], regeling: [], afgesloten: [], regeling_abonnementen: 0, dossiers: 0 });

  // 4) Abonnementen per soort.
  const perSoort = await veilig('Abonnementen per soort', async () => {
    const subs = await alle(db, 'subscriptions', 'id, soort, status');
    const tel = {};
    for (const s of subs) {
      const k = SOORTEN.includes(s.soort) ? s.soort : 'leeg';
      tel[k] = tel[k] || { totaal: 0, actief: 0 };
      tel[k].totaal += 1;
      if (isActiefAbonnement(s)) tel[k].actief += 1;
    }
    return tel;
  }, {});

  const telCode = (c) => teChecken.filter((t) => t.code === c).length;
  const salesMetCommissie = new Set(parents.filter((p) => p.status !== 'geannuleerd').map((p) => p.source_quote_id || p.id)).size;
  return {
    ok: true,
    fouten,
    kpis: {
      sales_met_commissie: salesMetCommissie,
      te_checken: teChecken.length,
      bij_incasso: incasso.bij_incasso.length,
      incasso_regelingen: incasso.regeling.length,
      abonnementen_zonder_soort_met_commissie: telCode('soort_ontbreekt'),
    },
    te_checken: teChecken,
    te_checken_per_code: {
      event_sale_niet_aanwezig: telCode('event_sale_niet_aanwezig'),
      vervangen_niet_gekoppeld: telCode('vervangen_niet_gekoppeld'),
      verkoper_mentor_geen_commissie: telCode('verkoper_mentor_geen_commissie'),
      commissie_zonder_abonnement: telCode('commissie_zonder_abonnement'),
      soort_ontbreekt: telCode('soort_ontbreekt'),
    },
    incasso,
    per_soort: perSoort,
    controle_totalen: controle.totalen || null,
  };
}

export const _test = { round2 };
