// api/_lib/module-context.js
//
// Send-time lookup van de whatsapp_module_config rij die hoort bij een
// zendende WhatsApp-lijn (phone_number_id). De rij levert per-module
// (per-afdeling) contactgegevens die bij send-time worden geresolved in
// {{afdeling.telefoon}}, {{afdeling.whatsapp}}, {{afdeling.email}} en
// {{afdeling.ondertekenaar}} placeholders.
//
// Strategie:
//   1) Probeer exacte match op phone_number_id + is_active=true.
//   2) Bij geen match (legacy conversation rows zonder phone_number_id, of
//      een nummer dat (nog) niet in whatsapp_module_config staat): fallback
//      op module='finance' + is_active=true. Dit is de huidige default-lijn
//      en zorgt dat afdeling.* nooit leeg blijft tijdens de uitrol-fase.
//   3) Bij ook geen finance-rij: null. Caller geeft het door aan
//      resolveVariables/buildMetaVariablesFromMapping, die op hun beurt
//      lege strings invullen + waarschuwing loggen.
//
// Geen caching-laag: whatsapp_module_config is < 10 rijen, elke send doet
// al andere lookups, en stale cache zou afdelings-gegevens kunnen kapen
// na een admin-mutatie.
//
// Caller MOET een supabaseAdmin-client meegeven — vermijdt circulaire
// imports en houdt deze helper testbaar.

const MODULE_CONTEXT_SELECT =
  'id, module, phone_number_id, business_account_id, display_label, ' +
  'afdeling_telefoon, afdeling_whatsapp, afdeling_email, afdeling_ondertekenaar';

const FALLBACK_MODULE = 'finance';

/**
 * Haalt de whatsapp_module_config rij op voor een phone_number_id.
 *
 * @param {object} supabaseAdmin  - service-role client (createClient(SERVICE_ROLE)).
 * @param {string|null|undefined} phoneNumberId - Meta phone_number_id van de zendende lijn.
 * @returns {Promise<object|null>} { module, phone_number_id, business_account_id,
 *                                   display_label, afdeling_telefoon,
 *                                   afdeling_whatsapp, afdeling_email,
 *                                   afdeling_ondertekenaar } of null.
 */
export async function getModuleContextByPhoneNumberId(supabaseAdmin, phoneNumberId) {
  if (!supabaseAdmin) {
    // eslint-disable-next-line no-console
    console.warn('[module-context] supabaseAdmin ontbreekt — return null');
    return null;
  }

  // Stap 1: exacte phone_number_id match.
  if (phoneNumberId) {
    try {
      const { data, error } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select(MODULE_CONTEXT_SELECT)
        .eq('phone_number_id', String(phoneNumberId))
        .eq('is_active', true)
        .maybeSingle();
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[module-context] phone_number_id lookup error:', error.message);
      } else if (data) {
        return data;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[module-context] phone_number_id lookup exception:', e.message);
    }
  }

  // Stap 2: fallback op default-module ('finance').
  try {
    const { data, error } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select(MODULE_CONTEXT_SELECT)
      .eq('module', FALLBACK_MODULE)
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      // eslint-disable-next-line no-console
      console.error('[module-context] fallback module lookup error:', error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[module-context] fallback module lookup exception:', e.message);
    return null;
  }
}
