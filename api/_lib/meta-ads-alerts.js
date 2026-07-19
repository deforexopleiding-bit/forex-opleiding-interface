// api/_lib/meta-ads-alerts.js
//
// Pure evaluator voor Meta Ads-alerts (fase 3). Geen DB / geen HTTP-calls,
// zodat de logica los unit-testbaar is (zie tests/meta-ads-alerts.test.js).
//
// Drie regels (elk apart aan/uit via de rules):
//   1) meta_ads_cpl_high   — spend / leads > cpl_threshold_eur (leads > 0).
//   2) meta_ads_no_leads   — spend in venster > 0 EN 0 leads over venster.
//   3) meta_ads_cost_spike — spend gisteren > (1 + pct/100) × eergisteren,
//                            en spend gisteren ≥ cost_spike_min_spend_eur
//                            (anti-ruis: kleine budgetten geven anders 200%
//                            "spikes" bij €5 → €15 die niet zorgwekkend zijn).
//
// Signatuur (pure):
//   evaluateAlerts({ campaigns, insightsByCampaign, rules, today })
//     - campaigns: [{ meta_id: text, id: uuid, name, effective_status }, ...]
//     - insightsByCampaign: Map<meta_id, [{ date: 'YYYY-MM-DD', spend, leads }, ...]>
//     - rules: {
//         cpl_enabled, cpl_threshold_eur,
//         no_leads_enabled, no_leads_hours,
//         cost_spike_enabled, cost_spike_pct, cost_spike_min_spend_eur,
//       }
//     - today: 'YYYY-MM-DD' (Europe/Amsterdam-lokaal; caller berekent).
//   → [{ type, entity_uuid, meta_id, name, title, body, priority, details }, ...]
//
// De cron neemt deze array en maakt via createNotification één rij per
// alert-object aan (met dedup op entity_id UUID + type).

export const ALERT_DEFAULTS = Object.freeze({
  cpl_enabled: true,
  cpl_threshold_eur: 35,
  no_leads_enabled: true,
  no_leads_hours: 24,
  cost_spike_enabled: true,
  cost_spike_pct: 40,
  cost_spike_min_spend_eur: 50,
});

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normaliseer rules met defaults + type-coercie. Onbekende/foutieve waarden
 * vallen terug op ALERT_DEFAULTS zodat één corrupt veld nooit de hele cron
 * blokkeert.
 */
export function normalizeRules(input) {
  const r = { ...ALERT_DEFAULTS };
  if (!input || typeof input !== 'object') return r;
  if (typeof input.cpl_enabled === 'boolean')          r.cpl_enabled = input.cpl_enabled;
  if (typeof input.no_leads_enabled === 'boolean')     r.no_leads_enabled = input.no_leads_enabled;
  if (typeof input.cost_spike_enabled === 'boolean')   r.cost_spike_enabled = input.cost_spike_enabled;
  const numOr = (v, fallback, min = 0) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  r.cpl_threshold_eur         = numOr(input.cpl_threshold_eur, ALERT_DEFAULTS.cpl_threshold_eur, 0);
  r.no_leads_hours            = numOr(input.no_leads_hours,    ALERT_DEFAULTS.no_leads_hours,    1);
  r.cost_spike_pct            = numOr(input.cost_spike_pct,    ALERT_DEFAULTS.cost_spike_pct,    0);
  r.cost_spike_min_spend_eur  = numOr(input.cost_spike_min_spend_eur, ALERT_DEFAULTS.cost_spike_min_spend_eur, 0);
  return r;
}

/**
 * Datum-shift YMD (Europe/Amsterdam-lokaal). `days` negatief = terug in tijd.
 */
export function shiftYmd(ymd, days) {
  if (!YMD_RE.test(String(ymd))) throw new Error('shiftYmd: invalid ymd');
  const [y, m, d] = ymd.split('-').map((s) => parseInt(s, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Pure evaluator. Returnt een array van alert-objecten die de cron dan naar
 * createNotification pipet. Geen side-effects.
 */
export function evaluateAlerts({ campaigns, insightsByCampaign, rules, today }) {
  const out = [];
  if (!Array.isArray(campaigns) || campaigns.length === 0) return out;
  if (!YMD_RE.test(String(today))) return out;
  const r = normalizeRules(rules);
  if (!r.cpl_enabled && !r.no_leads_enabled && !r.cost_spike_enabled) return out;

  const yesterday    = shiftYmd(today, -1);
  const dayBefore    = shiftYmd(today, -2);
  const noLeadsDays  = Math.max(1, Math.ceil(r.no_leads_hours / 24));
  const noLeadsFrom  = shiftYmd(today, -(noLeadsDays - 1)); // inclusive, incl. vandaag

  for (const c of campaigns) {
    if (!c || !c.meta_id || !c.id) continue;
    // Alleen alerten op actieve campagnes; PAUSED/DELETED = geen actie.
    if (String(c.effective_status || '').toUpperCase() !== 'ACTIVE') continue;
    const rows = insightsByCampaign.get(c.meta_id) || [];

    // ── Regel 1: CPL boven drempel ──────────────────────────────────────
    if (r.cpl_enabled) {
      // Neem het no_leads-venster ook hier — anders zou een enkele slechte
      // dag lang na dato blijven alerten. Zelfde venster = coherent.
      const window = rows.filter((x) => x.date >= noLeadsFrom && x.date <= today);
      const spend = window.reduce((s, x) => s + Number(x.spend || 0), 0);
      const leads = window.reduce((s, x) => s + Number(x.leads || 0), 0);
      if (leads > 0) {
        const cpl = spend / leads;
        if (cpl > r.cpl_threshold_eur) {
          out.push({
            type:        'meta_ads_cpl_high',
            entity_uuid: c.id,
            meta_id:     c.meta_id,
            name:        c.name || null,
            title:       `Kosten per lead te hoog: ${c.name || c.meta_id}`,
            body:        `Kosten per lead in het laatste venster (${noLeadsDays}d): € ${cpl.toFixed(2)} — boven de drempel van € ${r.cpl_threshold_eur.toFixed(2)}. Spend € ${spend.toFixed(2)} / ${leads} leads.`,
            priority:    'normal',
            details:     { spend, leads, cpl, threshold: r.cpl_threshold_eur, days: noLeadsDays },
          });
        }
      }
    }

    // ── Regel 2: Stilstand — spend maar 0 leads in venster ──────────────
    if (r.no_leads_enabled) {
      const window = rows.filter((x) => x.date >= noLeadsFrom && x.date <= today);
      const spend  = window.reduce((s, x) => s + Number(x.spend || 0), 0);
      const leads  = window.reduce((s, x) => s + Number(x.leads || 0), 0);
      if (spend > 0 && leads === 0) {
        out.push({
          type:        'meta_ads_no_leads',
          entity_uuid: c.id,
          meta_id:     c.meta_id,
          name:        c.name || null,
          title:       `Geen leads: ${c.name || c.meta_id}`,
          body:        `Geen leads in de laatste ${r.no_leads_hours} uur (${noLeadsDays}d), terwijl er € ${spend.toFixed(2)} is uitgegeven. Check targeting, creative of formulier.`,
          priority:    'normal',
          details:     { spend, leads, hours: r.no_leads_hours, days: noLeadsDays },
        });
      }
    }

    // ── Regel 3: Kostenpiek gisteren t.o.v. eergisteren ─────────────────
    if (r.cost_spike_enabled) {
      const y = rows.find((x) => x.date === yesterday);
      const b = rows.find((x) => x.date === dayBefore);
      const spendY = y ? Number(y.spend || 0) : 0;
      const spendB = b ? Number(b.spend || 0) : 0;
      // Beide dagen nodig voor een zinnige piek-vergelijking; anti-ruis via min-spend.
      if (spendB > 0 && spendY >= r.cost_spike_min_spend_eur) {
        const factor = spendY / spendB;
        const pct    = (factor - 1) * 100;
        if (pct > r.cost_spike_pct) {
          out.push({
            type:        'meta_ads_cost_spike',
            entity_uuid: c.id,
            meta_id:     c.meta_id,
            name:        c.name || null,
            title:       `Kostenpiek: ${c.name || c.meta_id}`,
            body:        `Spend gisteren € ${spendY.toFixed(2)} — ${pct.toFixed(0)}% hoger dan eergisteren (€ ${spendB.toFixed(2)}). Drempel: +${r.cost_spike_pct}%.`,
            priority:    'normal',
            details:     { spend_yesterday: spendY, spend_day_before: spendB, pct, threshold_pct: r.cost_spike_pct },
          });
        }
      }
    }
  }

  return out;
}
