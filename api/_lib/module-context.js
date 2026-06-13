// api/_lib/module-context.js
//
// Send-time lookup van de whatsapp_module_config rij die hoort bij een
// zendende WhatsApp-lijn (phone_number_id). De rij levert per-module
// (per-afdeling) contactgegevens die bij send-time worden geresolved in
// {{afdeling.telefoon}}, {{afdeling.whatsapp}}, {{afdeling.email}} en
// {{afdeling.ondertekenaar}} placeholders.
//
// Strategie (Joost-gate-hardening, Fase 0):
//   1) Exacte match op (phone_number_id, is_active=true) -> returns row.
//   2) Geen match -> returns null. GEEN silent-finance-failover.
//
// REDEN VOOR DE STRICT-NO-FAILOVER:
// De oude failover-naar-module='finance' bij een ongeconfigureerd nummer
// gaf een silent-failure-mode: een nieuw events-WABA-nummer dat (nog)
// niet in whatsapp_module_config stond, kreeg de finance-row -> Joost
// reageerde op event-leads alsof het wanbetalers waren. Defense-in-depth
// callers (zoals inbox-webhook Joost-trigger) gaten al op
// moduleCtx.module === 'finance' && is_active === true. Het verwijderen
// van de fallback zorgt dat een onbekend nummer EXPLICIET null teruggeeft
// zodat callers het ongerouteerd-pad nemen (logging, geen Joost-trigger,
// conversatie blijft wel persisted in whatsapp_conversations zodat geen
// data verloren gaat).
//
// Caller-impact:
//   - inbox-send-template.js:319-333 was al null-safe (warning + lege
//     afdeling.* placeholders).
//   - joost-suggest.js:246-247 heeft eigen ?? 'finance'-fallback;
//     auto-trigger pad bereikt 'm nooit meer met null door de gehardende
//     gate in inbox-webhook.
//   - inbox-webhook.js Joost-trigger: gate vereist nu expliciet
//     moduleCtx.module==='finance' AND is_active===true.
//
// Geen caching-laag: whatsapp_module_config is < 10 rijen, elke send doet
// al andere lookups, en stale cache zou afdelings-gegevens kunnen kapen
// na een admin-mutatie.
//
// Caller MOET een supabaseAdmin-client meegeven - vermijdt circulaire
// imports en houdt deze helper testbaar.

const MODULE_CONTEXT_SELECT =
  'id, module, phone_number_id, business_account_id, display_label, ' +
  'afdeling_telefoon, afdeling_whatsapp, afdeling_email, afdeling_ondertekenaar, is_active';

/**
 * Haalt de whatsapp_module_config rij op voor een phone_number_id.
 *
 * @param {object} supabaseAdmin  - service-role client (createClient(SERVICE_ROLE)).
 * @param {string|null|undefined} phoneNumberId - Meta phone_number_id van de zendende lijn.
 * @returns {Promise<object|null>} { id, module, phone_number_id, business_account_id,
 *                                   display_label, afdeling_telefoon,
 *                                   afdeling_whatsapp, afdeling_email,
 *                                   afdeling_ondertekenaar, is_active }
 *                                   of null als geen exacte match in
 *                                   whatsapp_module_config (geen finance-failover meer).
 */
export async function getModuleContextByPhoneNumberId(supabaseAdmin, phoneNumberId) {
  if (!supabaseAdmin) {
    // eslint-disable-next-line no-console
    console.warn('[module-context] supabaseAdmin ontbreekt - return null');
    return null;
  }
  if (!phoneNumberId) {
    // Geen lijn-identifier -> kan niets resolven. Caller logt indien nodig.
    return null;
  }

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
      return null;
    }
    // data: object of null. Bij null -> ongeconfigureerd nummer; caller
    // beslist (in de praktijk: skipt module-specifieke side-effects zoals
    // Joost-trigger of afdeling.* template-vars).
    return data || null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[module-context] phone_number_id lookup exception:', e.message);
    return null;
  }
}
