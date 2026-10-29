// api/_lib/meta-lead-settings.js
//
// Zelf-beheerbare instellingen voor de Meta-leadkoppeling (app_settings-sleutel
// `meta_lead_settings`), bediend via het Meta-koppeling-paneel in leadsonderhoud.
//
//   { funnels: { opstartsessie, webinar, lab }, testmode, test_event_code }
//
// - funnels: per bron aan/uit (default AAN = huidig gedrag). Uit → de sender
//   stuurt niets en logt status='skipped', skip_reason='funnel uitgezet'.
// - testmode + test_event_code: vervangt het handmatig zetten van
//   META_CAPI_TEST_EVENT_CODE in Vercel. Geconfigureerd → de instelling wint;
//   niet geconfigureerd → env-fallback (huidig gedrag). Default: UIT (live).
//
// LET OP: hier zit GEEN consent-schakelaar. De toestemmings-gate (beslisMetaLead)
// blijft volledig intact en wordt elders alleen read-only getoond.

import { supabaseAdmin } from '../supabase.js';

export const META_LEAD_SETTINGS_KEY = 'meta_lead_settings';
export const META_FUNNELS = Object.freeze(['opstartsessie', 'webinar', 'lab']);

/** bron (endpoint-slug) → funnel-sleutel. */
export function funnelVanBron(bron) {
  const b = String(bron || '').toLowerCase();
  if (b === 'lab' || b === 'the-lab') return 'lab';
  if (b.startsWith('webinar')) return 'webinar';
  return 'opstartsessie';
}

/** Leest de instellingen met veilige defaults. Gooit nooit. */
export async function leesMetaLeadSettings(sb = supabaseAdmin) {
  try {
    const { data } = await sb.from('app_settings').select('value').eq('key', META_LEAD_SETTINGS_KEY).maybeSingle();
    const geconfigureerd = !!(data && data.value && typeof data.value === 'object' && !Array.isArray(data.value));
    const v = geconfigureerd ? data.value : {};
    const f = (v.funnels && typeof v.funnels === 'object') ? v.funnels : {};
    return {
      funnels: {
        opstartsessie: f.opstartsessie !== false,
        webinar: f.webinar !== false,
        lab: f.lab !== false,
      },
      testmode: v.testmode === true,
      test_event_code: typeof v.test_event_code === 'string' ? v.test_event_code.trim().slice(0, 100) : '',
      geconfigureerd,
    };
  } catch (e) {
    console.warn('[meta-lead-settings] lezen mislukt → defaults:', e?.message || e);
    return { funnels: { opstartsessie: true, webinar: true, lab: true }, testmode: false, test_event_code: '', geconfigureerd: false };
  }
}

/** Mag deze bron een Lead sturen? (default ja) */
export function funnelAan(settings, bron) {
  return settings?.funnels?.[funnelVanBron(bron)] !== false;
}

/**
 * Effectieve test-event-code: de geconfigureerde instelling wint (testmode aan →
 * code, uit → null=live). Niet geconfigureerd → env-fallback (huidig gedrag).
 */
export function effectieveTestCode(settings) {
  if (settings && settings.geconfigureerd) {
    return settings.testmode ? (settings.test_event_code || null) : null;
  }
  const env = String(process.env.META_CAPI_TEST_EVENT_CODE || '').trim();
  return env || null;
}
