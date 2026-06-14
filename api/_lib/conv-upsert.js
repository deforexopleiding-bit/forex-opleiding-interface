// api/_lib/conv-upsert.js
//
// Outbound conv-upsert helper. Bedoeld voor scenarios waar we een outbound
// WhatsApp-bericht willen sturen naar een telefoonnummer dat nog geen
// conversation-rij heeft (bv. events-attendee-send-invite naar een attendee
// die nooit eerder geantwoord heeft).
//
// Match-strategie spiegelt inbox-webhook.upsertConversation (sinds #192
// multi-line fix): UNIQUE op (phone_number, phone_number_id) tuple. We
// laten de live inbound-upsert in api/inbox-webhook.js ongemoeid om
// finance / events-inbound geen risico te lopen op regressie -- deze
// outbound-helper is een dedicated sibling.
//
// Verschillen met de inbound-upsert:
//   - Geen inbound-specifieke velden (unread_count blijft 0, geen
//     last_inbound_at bumping).
//   - Geen audit-row "conversation_created" via logInboxAudit -- de
//     calling endpoint kan zelf een audit-row in audit_log droppen als
//     gewenst (verschilt per use-case: send-invite valt onder
//     events.attendee.edit, geen finance-inbox-audit).
//   - Geen customer-phone-lookup fallback. Caller bepaalt customerId
//     vooraf (mag null zijn voor signup-first attendees).
//
// Returnt { id, created, customerId }:
//   - id: conv-uuid van de bestaande of net-aangemaakte rij
//   - created: true bij INSERT, false bij SELECT-hit
//   - customerId: customer_id van de conv (kan null)

import { supabaseAdmin } from '../supabase.js';

/**
 * Upsert whatsapp_conversations voor outbound aanmaak/lookup.
 *
 * @param {object} opts
 * @param {string} opts.phoneE164Plus  Telefoonnummer met '+', bv. '+31655270212'.
 * @param {string} opts.phoneNumberId  Meta WABA phone_number_id van de afzendlijn.
 *                                     Tuple-match key #2 (UNIQUE sinds #192).
 * @param {string} [opts.displayName]  Optionele display_name (bv. attendee-naam).
 * @param {string} [opts.customerId]   Optionele customer_id koppeling.
 * @returns {Promise<{ id: string, created: boolean, customerId: string|null }>}
 */
export async function upsertOutboundConversation({
  phoneE164Plus,
  phoneNumberId,
  displayName = null,
  customerId = null,
} = {}) {
  if (!phoneE164Plus) throw new Error('upsertOutboundConversation: phoneE164Plus vereist');
  if (!phoneNumberId) throw new Error('upsertOutboundConversation: phoneNumberId vereist');

  // 1. Tuple-SELECT op (phone_number, phone_number_id).
  const { data: existing, error: selErr } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id, customer_id, phone_number_id')
    .eq('phone_number',    phoneE164Plus)
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle();
  if (selErr) {
    throw new Error('conv select: ' + selErr.message);
  }

  if (existing) {
    return {
      id        : existing.id,
      created   : false,
      customerId: existing.customer_id || null,
    };
  }

  // 2. INSERT — outbound-shape (geen last_inbound_at, unread_count=0).
  const nowIso = new Date().toISOString();
  const insertPayload = {
    phone_number     : phoneE164Plus,
    phone_number_id  : phoneNumberId,
    display_name     : displayName,
    customer_id      : customerId,
    status           : 'open',
    last_message_at  : nowIso,
    unread_count     : 0,
  };
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('whatsapp_conversations')
    .insert(insertPayload)
    .select('id')
    .single();
  if (insErr) {
    // 23505 race: een andere caller heeft net dezelfde tuple gemaakt
    // (bv. een inbound-webhook die net binnenkwam). Re-select via tuple.
    if (insErr.code === '23505' || /duplicate key/i.test(insErr.message || '')) {
      const { data: again, error: againErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, customer_id')
        .eq('phone_number',    phoneE164Plus)
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle();
      if (againErr) throw new Error('conv re-select after race: ' + againErr.message);
      if (again) {
        return {
          id        : again.id,
          created   : false,
          customerId: again.customer_id || null,
        };
      }
    }
    throw new Error('conv insert: ' + insErr.message);
  }
  return {
    id        : inserted.id,
    created   : true,
    customerId: customerId,
  };
}
