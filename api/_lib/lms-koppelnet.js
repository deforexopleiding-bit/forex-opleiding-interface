// api/_lib/lms-koppelnet.js
//
// WIE HANGT ER AAN HET LMS? Het vangnet voor als het LMS niet te lezen is.
//
// ── WAAROM DIT EEN EIGEN BESTAND IS ──────────────────────────────────────
// Dit stond tot 21 september 2026 in api/_lib/lms-hold.js. Die poort is weg
// (zie hieronder), maar het vangnet niet: de stilte-poort heeft het nodig en
// de factuurspiegel schrijft de afdruk waar het op leunt. Eén plek, want
// twee kopieën van "wie hangt er aan het LMS" lopen gegarandeerd uit elkaar
// zodra er een vierde koppelweg bij komt.
//
// ── WAAROM DE HOLD-POORT WEG IS ──────────────────────────────────────────
// #1622 liet de motor zwijgen bij elke `hlms_student_hold`. Sinds het LMS
// ook AUTOMATISCHE betalingsholds kan schrijven (2+ vervallen facturen,
// `door` leeg, `reden_soort='betaling'`) zou die poort precies de
// wanbetalers stilleggen die wél een aanmaning horen te krijgen. Beslissing
// Maxim, 21 september 2026: alleen `hlms_crm_stilte` legt de motor stil, en
// daar staat per rij een mens onder. Zie api/_lib/lms-stilte.js.
//
// ── WAT HET VANGNET IS, EN WAT NIET ──────────────────────────────────────
// Het is een zo BREED mogelijke verzameling klanten die aan een LMS-student
// (kunnen) hangen. Het wordt alleen gebruikt om bij een storing niets te
// versturen — nooit om iets te versturen. Te breed is hier dus de veilige
// kant: iemand een dag later manen kost weinig, manen tegen een afspraak in
// kost vertrouwen.

import { supabaseAdmin } from '../supabase.js';

// app_settings-sleutel met de klanten die de factuurspiegel voor het laatst
// aan een LMS-student heeft kunnen koppelen. Zie leesGekoppeldeKlanten().
export const GEKOPPELD_SETTING_KEY = 'lms_gekoppelde_klanten';

/** 'YYYY-MM-DD' uit een datum- of tijdstempelwaarde; null als er niets staat. */
function dag(waarde) {
  const s = String(waarde || '').trim();
  return s ? s.slice(0, 10) : null;
}

/** 'YYYY-MM-DD' → 'dd-mm-jjjj'. Geen datum → null. */
export function nlDatum(iso) {
  const d = dag(iso);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [j, m, dd] = d.split('-');
  return dd + '-' + m + '-' + j;
}

/**
 * De klanten die de factuurspiegel voor het laatst aan een LMS-student heeft
 * kunnen koppelen, zoals weggeschreven in `app_settings`.
 *
 * ── WAAROM DIT BESTAAT ──────────────────────────────────────────────────
 * Het vangnet hieronder moet weten WELKE klanten aan een LMS-student hangen.
 * Twee van de drie koppelwegen staan in het CRM zelf (`onboardings.
 * dfo_lms_student_id` en `.bubble_user_id`) en zijn dus ook leesbaar als het
 * LMS plat ligt. De derde — het e-mailadres — heeft aan CRM-kant GEEN spoor:
 * die koppeling bestaat alleen doordat een student in het LMS hetzelfde
 * adres draagt. Precies die klanten zouden bij een storing door het vangnet
 * heen vallen.
 *
 * Daarom laat de nachtelijke spiegelronde een afdruk achter van de klanten
 * die hij heeft gekoppeld. Geen tweede waarheid: het is een AFDRUK van de
 * spiegel, hij wordt alleen gebruikt om het vangnet BREDER te maken, nooit
 * om iets te versturen, en als hij ontbreekt of oud is doet het vangnet het
 * nog steeds met de twee CRM-wegen.
 *
 * Fail-soft: onleesbaar → lege verzameling (de twee CRM-wegen blijven).
 */
export async function leesGekoppeldeKlanten(db = supabaseAdmin) {
  try {
    const { data, error } = await db
      .from('app_settings').select('value').eq('key', GEKOPPELD_SETTING_KEY).maybeSingle();
    if (error) throw new Error(error.message);
    const ids = data?.value?.customer_ids;
    return {
      klanten: new Set(Array.isArray(ids) ? ids.map(String).filter(Boolean) : []),
      bijgewerkt_op: data?.value?.bijgewerkt_op || null,
    };
  } catch (e) {
    console.warn('[lms-koppelnet] afdruk van gekoppelde klanten onleesbaar:', e?.message || e);
    return { klanten: new Set(), bijgewerkt_op: null };
  }
}

/**
 * Alle klanten die aan een LMS-student gekoppeld (kunnen) zijn — het
 * vangnet voor als het LMS niet te lezen is.
 *
 * Twee bronnen, allebei in het CRM: de onboardings die een LMS-verwijzing
 * of een Bubble-id dragen, plus de afdruk van de spiegel. Samen zo breed
 * mogelijk; dat is hier de bedoeling.
 */
export async function bouwVangnet(db) {
  const uit = new Set();
  let crmFout = null;

  try {
    const { data, error } = await db
      .from('onboardings')
      .select('customer_id, dfo_lms_student_id, bubble_user_id, is_test')
      .or('dfo_lms_student_id.not.is.null,bubble_user_id.not.is.null');
    if (error) throw new Error(error.message);
    for (const ob of (data || [])) {
      if (ob?.is_test === true || !ob?.customer_id) continue;
      uit.add(String(ob.customer_id));
    }
  } catch (e) {
    // Ook het CRM hapert. Dan blijft alleen de afdruk over; dat is nog
    // altijd beter dan een leeg vangnet, en het wordt luid gelogd.
    crmFout = e?.message || String(e);
    console.error('[lms-koppelnet] vangnet: onboardings onleesbaar — ' + crmFout);
  }

  const afdruk = await leesGekoppeldeKlanten(db);
  for (const id of afdruk.klanten) uit.add(id);

  return { klanten: uit, afdruk_bijgewerkt_op: afdruk.bijgewerkt_op, crm_fout: crmFout };
}
