// api/_lib/wa-outbound-log.js
//
// Fail-soft helper om uitgaande WhatsApp-berichten (van de toegang-gate motor)
// weg te schrijven naar whatsapp_conversations + whatsapp_messages, zodat ze
// in "Gesprekken" (inbox-v2 / wanbetalers inbox) verschijnen naast de inbound.
//
// Voor bestaande dunning-flows wordt dit patroon al gebruikt — zie
// api/cron-dunning-conversation-reminders.js:857-882. Zelfde vorm hier:
//   1. whatsapp_conversations opzoeken op (phone_number, phone_number_id).
//   2. Bestaat niet → INSERT nieuwe conv (status='open', phone_number,
//      phone_number_id gezet). Geen customer_id lookup — dat doet de
//      inbox-webhook later bij de eerste inbound.
//   3. INSERT whatsapp_messages: direction='out', body (gerenderde tekst),
//      template_name, template_variables (jsonb), meta_wamid, status='queued',
//      sent_at, sent_by_user_id=null.
//   4. UPDATE conv.last_message_at + last_message_preview.
//
// ALLE stappen fail-soft: elke fout → console.warn, GEEN throw. De caller
// verstuurt WA/mail sowieso al; log-fout mag de send-flow niet breken.

/**
 * @param {object} supabaseAdmin  service-role client
 * @param {object} args
 * @param {string} args.toPhone         Lead-telefoon in E.164 (+31…). Verplicht.
 * @param {string} args.phoneNumberId   Meta phone_number_id van de zendende lijn. Verplicht.
 * @param {string} args.body            Gerenderde bericht-tekst (mét vars ingevuld). Max ~1000 chars.
 * @param {string|null} [args.wamid]    Meta wamid van de send. NULL als onbekend.
 * @param {string|null} [args.templateName]  Bij template-send: naam (bv. 'bevestig_toegang_a').
 * @param {object|null} [args.templateVariables]  jsonb {1: 'X', 2: 'Y'} bij template.
 * @param {string} [args.source]        'toegang-gate-cron' | 'toegang-gate-webhook'. Voor logs.
 * @returns {Promise<{ ok:boolean, conv_id?:string, message_id?:string, error?:string }>}
 */
export async function logOutboundWa(supabaseAdmin, {
  toPhone, phoneNumberId, body, wamid,
  templateName = null, templateVariables = null, source = 'toegang-gate',
}) {
  if (!supabaseAdmin) return { ok: false, error: 'supabaseAdmin ontbreekt' };
  if (!toPhone || !phoneNumberId) return { ok: false, error: 'toPhone + phoneNumberId vereist' };

  // Normaliseer telefoon naar +E.164.
  const digits = String(toPhone).replace(/[^\d+]/g, '');
  const phoneE164Plus = digits.startsWith('+') ? digits : ('+' + digits.replace(/^0+/, ''));
  if (phoneE164Plus.length < 8) return { ok: false, error: 'phone te kort' };

  const nowIso = new Date().toISOString();
  const preview = (body || '').trim().slice(0, 120);
  const fullBody = (body || '').slice(0, 1000);

  // ── 1) Conv opzoeken (lijn-specifiek) ─────────────────────────────────
  let convId = null;
  try {
    const { data: existing } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number_id')
      .eq('phone_number', phoneE164Plus)
      .eq('phone_number_id', String(phoneNumberId))
      .maybeSingle();
    if (existing?.id) {
      convId = existing.id;
    } else {
      // Fallback: één-per-nummer UNIQUE index betekent dat er ook een rij
      // zonder pnId kan bestaan (legacy). Try zonder pnId — als match:
      // heal 'em met de pnId zodra we outbound naar die lijn sturen.
      const { data: legacy } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, phone_number_id')
        .eq('phone_number', phoneE164Plus)
        .maybeSingle();
      if (legacy?.id) {
        convId = legacy.id;
        if (!legacy.phone_number_id) {
          await supabaseAdmin.from('whatsapp_conversations')
            .update({ phone_number_id: String(phoneNumberId) })
            .eq('id', convId);
        }
      }
    }
  } catch (e) {
    console.warn(`[wa-outbound-log:${source}] conv lookup (soft):`, e?.message || e);
  }

  // ── 2) Conv insert als geen bestaande ────────────────────────────────
  if (!convId) {
    try {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .insert({
          phone_number:         phoneE164Plus,
          phone_number_id:      String(phoneNumberId),
          status:               'open',
          last_message_at:      nowIso,
          last_message_preview: preview,
          unread_count:         0,
        })
        .select('id').maybeSingle();
      if (insErr) throw insErr;
      convId = inserted?.id || null;
    } catch (e) {
      // 23505 = UNIQUE constraint (race): een andere insert (bv. Meta-inbox-webhook)
      // heeft 'em net gemaakt. Re-fetch en probeer opnieuw.
      if (e?.code === '23505') {
        try {
          const { data: raced } = await supabaseAdmin
            .from('whatsapp_conversations')
            .select('id')
            .eq('phone_number', phoneE164Plus)
            .maybeSingle();
          convId = raced?.id || null;
        } catch (_) {}
      } else {
        console.warn(`[wa-outbound-log:${source}] conv insert (soft):`, e?.message || e);
      }
    }
  }

  if (!convId) return { ok: false, error: 'geen conv_id verkregen' };

  // ── 3) Message INSERT ─────────────────────────────────────────────────
  let messageId = null;
  try {
    const { data: msg, error: msgErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert({
        conversation_id:    convId,
        direction:          'out',
        meta_wamid:         wamid || null,
        body:               fullBody,
        template_name:      templateName,
        template_variables: templateVariables,
        status:             'queued',
        sent_at:            nowIso,
        sent_by_user_id:    null,
      })
      .select('id').maybeSingle();
    if (msgErr) throw msgErr;
    messageId = msg?.id || null;
  } catch (e) {
    // meta_wamid UNIQUE: als de send dubbel wordt gelogd (bv. cron + webhook
    // hetzelfde bericht) → skip stil. 23505 op meta_wamid = idempotent no-op.
    if (e?.code === '23505') {
      return { ok: true, conv_id: convId, message_id: null, deduped: true };
    }
    console.warn(`[wa-outbound-log:${source}] message insert (soft):`, e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }

  // ── 4) Conv touch (last_message_at + preview) ─────────────────────────
  try {
    await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: nowIso, last_message_preview: preview })
      .eq('id', convId);
  } catch (e) {
    console.warn(`[wa-outbound-log:${source}] conv touch (soft):`, e?.message || e);
  }

  return { ok: true, conv_id: convId, message_id: messageId };
}
