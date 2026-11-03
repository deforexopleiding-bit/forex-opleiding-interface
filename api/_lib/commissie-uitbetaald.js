// api/_lib/commissie-uitbetaald.js
//
// "Is deze commissie al uitbetaald?" — status in de database tegenover de
// werkelijkheid.
//
// WAAROM (3 nov 2026, Maxim): de rapporten juni t/m september 2026 zijn
// effectief uitbetaald, maar staan in mentor_payouts nog op 'goedgekeurd' en
// hun grootboekregels op 'vrijgegeven'. Gemeten: de knop "Markeer uitbetaald"
// (RPC mark_payout_paid) faalt op elk van die rapporten met bonus_drift — de
// RPC telt de regels van de RAPPORTMAAND met payout_id NULL, terwijl het
// rapport de regels van de maand ervoor koppelt (payout_id gezet). Zolang dat
// zo is, rekenen dry-run en controlescherm een rapport in status
// 'goedgekeurd' met period_month <= de grens als werkelijk uitbetaald en tonen
// ze het verschil met de status apart. Status zelf wordt hier NIET gewijzigd
// (definitief SQL, beslissing Maxim 3 nov: docs/sql-migrations/2026-11-03-rapporten-juni-september-uitbetaald.sql).
//
// Grens: app_settings 'mentor_rapporten_werkelijk_uitbetaald_tot'
// ({ "period_month": "YYYY-MM-01" }), standaard 2026-09-01 (Maxims melding).

export const UITBETAALD_TOT_STANDAARD = '2026-09-01';

const ym = (d) => (d ? String(d).slice(0, 7) : null);

/** Grens uit app_settings (faalzacht: standaard bij elke fout). */
export async function laadUitbetaaldTot(db) {
  try {
    const { data, error } = await db.from('app_settings').select('value')
      .eq('key', 'mentor_rapporten_werkelijk_uitbetaald_tot').maybeSingle();
    if (error || !data) return UITBETAALD_TOT_STANDAARD;
    const v = data.value;
    const s = typeof v === 'string' ? v : (v && (v.period_month || v.tot));
    return /^\d{4}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 7) + '-01' : UITBETAALD_TOT_STANDAARD;
  } catch {
    return UITBETAALD_TOT_STANDAARD;
  }
}

/** Werkelijk uitbetaald rapport: status 'uitbetaald', of 'goedgekeurd' t/m de grens. */
export function rapportWerkelijkUitbetaald(payout, tot = UITBETAALD_TOT_STANDAARD) {
  if (!payout) return false;
  if (payout.status === 'uitbetaald') return true;
  return payout.status === 'goedgekeurd' && !!payout.period_month && ym(payout.period_month) <= ym(tot);
}

/**
 * Stand van één grootboekregel.
 * @returns {'uitbetaald'|'uitbetaald_status_achter'|'in_rapport'|'niet_in_rapport'|'niet_vrijgegeven'}
 *   uitbetaald_status_achter = werkelijk uitbetaald, maar status zegt nog vrijgegeven/goedgekeurd.
 */
export function regelStand(entry, payoutById, tot = UITBETAALD_TOT_STANDAARD) {
  if (!entry) return 'niet_vrijgegeven';
  if (entry.status === 'uitbetaald') return 'uitbetaald';
  if (entry.status !== 'vrijgegeven') return 'niet_vrijgegeven';
  if (!entry.payout_id) return 'niet_in_rapport';
  const p = payoutById?.get ? payoutById.get(entry.payout_id) : null;
  if (rapportWerkelijkUitbetaald(p, tot)) return 'uitbetaald_status_achter';
  return 'in_rapport';
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Som per stand over een lijst regels. */
export function somPerStand(entries, payoutById, tot = UITBETAALD_TOT_STANDAARD) {
  const uit = { uitbetaald: 0, uitbetaald_status_achter: 0, in_rapport: 0, niet_in_rapport: 0 };
  for (const e of entries || []) {
    const s = regelStand(e, payoutById, tot);
    if (s in uit) uit[s] = round2(uit[s] + (Number(e.amount) || 0));
  }
  return {
    ...uit,
    vrijgegeven: round2(uit.uitbetaald + uit.uitbetaald_status_achter + uit.in_rapport + uit.niet_in_rapport),
    werkelijk_uitbetaald: round2(uit.uitbetaald + uit.uitbetaald_status_achter),
    status_uitbetaald: uit.uitbetaald,
    verschil_status_werkelijkheid: uit.uitbetaald_status_achter,
  };
}
