// api/_lib/incasso-termijnfacturen.js
//
// INCASSO-TERMIJNFACTUREN uitsluiten (PR 4 mentorcommissie, 3 nov 2026).
//
// De termijnfacturen van een incasso-abonnement (subscriptions.soort =
// 'incasso_regeling') en alle facturen van een klant die BIJ INCASSO staat of
// een INCASSO-REGELING heeft (api/_lib/klant-incassostatus.js), gaan niet
// naar het bureau en niet naar de klant. Ze worden handmatig opgevolgd in de
// maandlijst (api/incasso-maandlijst.js): "betaling ontvangen" zet de factuur
// op betaald via de bestaande betaalflow, de commissie volgt.
//
// Wie ze NIET meer oppikt:
//   - dunning-engine: auto-instroom in de wanbetalers-pipeline (auto:overdue —
//     zo kwam Noorulhaq Alikozai er op 8 okt in), het starten en doorlopen van
//     aanmaanruns (fetchOpenInvoices);
//   - cron-dunning-bulk-send: een goedgekeurde bulkaanmaning slaat zo'n klant over;
//   - cron-incasso-auto: maakt voor zo'n klant/factuur geen bureaudossier;
//   - sales-subscription-create: TL boekt de termijnfacturen enkel (geen
//     automatische mail naar de klant).
//
// Fail-soft: een leesfout geeft een lege uitsluiting (oude gedrag) en wordt
// gelogd — nooit een gestopte cron.

import { laadIncassoRijen, statusVan } from './klant-incassostatus.js';
import { soortKolomOntbreekt } from './subscription-soort.js';

export const UITSLUITENDE_STATUSSEN = new Set(['bij_incasso', 'incasso_regeling']);

const leeg = () => ({ klanten: new Set(), tlSubIds: new Set(), subIds: new Set(), ok: false });

/**
 * @param {object} db supabase client
 * @param {{ customerIds?: string[]|null }} opts  null = platform-breed
 * @returns {Promise<{ klanten: Set<string>, tlSubIds: Set<string>, subIds: Set<string>, ok: boolean }>}
 */
export async function laadIncassoUitsluiting(db, { customerIds = null } = {}) {
  const uit = leeg();
  try {
    // 1) Klanten met status bij_incasso / incasso_regeling.
    let rijen = [];
    if (customerIds) {
      rijen = (await laadIncassoRijen(db, customerIds, { alleenActief: true })).rijen;
    } else {
      let { data, error } = await db.from('mentor_commissie_incasso').select('customer_id, deal_id, status, opgeheven_op').is('opgeheven_op', null);
      if (error && /status/.test(String(error.message || ''))) ({ data, error } = await db.from('mentor_commissie_incasso').select('customer_id, deal_id, opgeheven_op').is('opgeheven_op', null));
      if (error) throw error;
      rijen = data || [];
    }
    for (const r of rijen) if (!r.deal_id && !r.opgeheven_op && UITSLUITENDE_STATUSSEN.has(statusVan(r))) uit.klanten.add(r.customer_id);

    // 2) Abonnementen van soort incasso_regeling (hun termijnfacturen).
    const { data: subs, error: sErr } = await db.from('subscriptions').select('id, teamleader_subscription_id, soort').eq('soort', 'incasso_regeling');
    if (sErr && !soortKolomOntbreekt(sErr)) throw sErr;
    for (const s of subs || []) {
      uit.subIds.add(s.id);
      if (s.teamleader_subscription_id) uit.tlSubIds.add(s.teamleader_subscription_id);
    }
    uit.ok = true;
  } catch (e) {
    console.warn('[incasso-termijnfacturen] uitsluiting lezen faalde (oude gedrag):', e?.message || e);
  }
  return uit;
}

/** Valt deze factuur (of de klant) buiten aanmaning/pipeline/bureau? */
export function isIncassoTermijnfactuur(inv, uitsl) {
  if (!inv || !uitsl) return false;
  if (inv.customer_id && uitsl.klanten.has(inv.customer_id)) return true;
  return !!(inv.tl_subscription_id && uitsl.tlSubIds.has(inv.tl_subscription_id));
}

/** Filter een lijst facturen; geeft { over, uitgesloten }. */
export function filterIncassoTermijnfacturen(rows, uitsl) {
  const over = [];
  let uitgesloten = 0;
  for (const r of rows || []) {
    if (isIncassoTermijnfactuur(r, uitsl)) uitgesloten += 1;
    else over.push(r);
  }
  return { over, uitgesloten };
}
