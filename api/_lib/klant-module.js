// api/_lib/klant-module.js
//
// Welke module hoort bij een gesprek op het KLANTNUMMER (2026-10-07)?
//
// Onboarding en finance/dunning delen sinds 2026-10-07 één WhatsApp-nummer
// (wa-nummers.js → klantnummer, inkomend_resolver 'klant'). Het lijn-ID zegt
// dus niet meer of een gesprek bij onboarding of bij finance hoort; dat
// bepalen we per klant:
//
//   actieve onboarding  ÉN  geen openstaande aanmaning  → 'onboarding'
//   anders (ook: geen klant gekoppeld)                  → 'finance'
//
// Actieve onboarding = een onboardings-rij die niet gearchiveerd of
// geannuleerd is en niet écht afgelopen (onboarding-einde.js: 'afgerond'
// zonder sessie = alleen wizard voltooid = nog lopend).
// Openstaande aanmaning = een dunning-workflow-run 'active'/'paused', of een
// dunning-pipeline-fase die niet eindigt (alles behalve opgelost/afschrijven).
// Betalen gaat vóór: wie in de aanmaanstraat zit, valt onder finance/Joost,
// ook als de onboarding nog loopt.
//
// Fail-soft: bij een leesfout → 'finance' (de bestaande eigenaar van deze lijn).

import { onboardingAfgesloten } from './onboarding-einde.js';

export const ONBOARDING = 'onboarding';
export const FINANCE = 'finance';
const NIET_ACTIEF = new Set(['gearchiveerd', 'geannuleerd']);
const EINDFASES = new Set(['opgelost', 'afschrijven']);
const OPEN_RUN = new Set(['active', 'paused']);
const CHUNK = 200;

/** Loopt deze onboarding nog? PURE. */
export function isActieveOnboarding(ob) {
  if (!ob || ob.archived_at) return false;
  if (NIET_ACTIEF.has(String(ob.status || '').trim().toLowerCase())) return false;
  return !onboardingAfgesloten(ob);
}

/** Heeft deze klant een openstaande aanmaning? PURE. */
export function heeftOpenAanmaning({ runs = [], pipeline = null } = {}) {
  if (runs.some((r) => OPEN_RUN.has(String(r?.status || '').toLowerCase()))) return true;
  const fase = pipeline && String(pipeline.stage_slug || '').toLowerCase();
  return !!fase && !EINDFASES.has(fase);
}

/** De beslissing. PURE. */
export function kiesKlantModule({ onboardings = [], runs = [], pipeline = null } = {}) {
  const actief = onboardings.some(isActieveOnboarding);
  return actief && !heeftOpenAanmaning({ runs, pipeline }) ? ONBOARDING : FINANCE;
}

/**
 * Module per klant, in batches. Klanten zonder rijen → 'finance'.
 * @returns {Promise<Map<string, 'onboarding'|'finance'>>}
 */
export async function bepaalKlantModules(sb, customerIds) {
  const ids = [...new Set((customerIds || []).filter(Boolean).map(String))];
  const uit = new Map(ids.map((id) => [id, FINANCE]));
  if (!ids.length) return uit;
  const obs = new Map(), runs = new Map(), pipe = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const deel = ids.slice(i, i + CHUNK);
      const [o, r, p] = await Promise.all([
        sb.from('onboardings')
          .select('customer_id, status, archived_at, auto_afgerond_op, auto_afgerond_sessie_id, handmatig_afgerond_op')
          .in('customer_id', deel),
        sb.from('dunning_workflow_runs').select('customer_id, status').in('customer_id', deel).in('status', [...OPEN_RUN]),
        sb.from('dunning_pipeline_customers').select('customer_id, stage_slug').in('customer_id', deel),
      ]);
      if (o.error || r.error || p.error) {
        console.warn('[klant-module] lezen (soft, terugval finance):', (o.error || r.error || p.error).message);
        return uit;
      }
      for (const x of o.data || []) push(obs, String(x.customer_id), x);
      for (const x of r.data || []) push(runs, String(x.customer_id), x);
      for (const x of p.data || []) pipe.set(String(x.customer_id), x);
    }
  } catch (e) {
    console.warn('[klant-module] exception (soft, terugval finance):', e?.message || e);
    return uit;
  }
  for (const id of ids) {
    uit.set(id, kiesKlantModule({ onboardings: obs.get(id) || [], runs: runs.get(id) || [], pipeline: pipe.get(id) || null }));
  }
  return uit;
}

/** Module voor één klant (null/onbekend → 'finance'). */
export async function bepaalKlantModule(sb, customerId) {
  if (!customerId) return FINANCE;
  return (await bepaalKlantModules(sb, [customerId])).get(String(customerId)) || FINANCE;
}

/**
 * Lijst-filter voor de inbox: staat `pnId` op een gedeeld klantnummer, dan
 * houdt dit alleen de gesprekken over waarvan de klant bij `module` hoort.
 * Andere nummers → rows ongewijzigd. Gesprekken zonder klant → finance.
 * Fail-soft: bij een fout in de resolver valt alles onder finance (bepaalKlantModules).
 */
export async function filterGesprekkenOpKlantModule(sb, rows, pnId, module) {
  const lijst = Array.isArray(rows) ? rows : [];
  if (!lijst.length || !pnId) return { rows: lijst, gefilterd: false };
  let nummer = null;
  try {
    const { d360NummerVoorPhoneNumberId } = await import('./meta-whatsapp.js');
    nummer = await d360NummerVoorPhoneNumberId(pnId);
  } catch (e) {
    console.warn('[klant-module] nummer-lookup (soft):', e?.message || e);
  }
  if (nummer?.inkomend_resolver !== 'klant') return { rows: lijst, gefilterd: false };
  const modules = await bepaalKlantModules(sb, lijst.map((r) => r.customer_id));
  const doel = String(module || '').toLowerCase();
  return {
    rows: lijst.filter((r) => (r.customer_id ? modules.get(String(r.customer_id)) : FINANCE) === doel),
    gefilterd: true,
  };
}
