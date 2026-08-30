// api/_lib/wa-outbound-log.js
//
// Fail-soft helper om uitgaande WhatsApp-berichten (van de toegang-gate motor)
// weg te schrijven naar whatsapp_conversations + whatsapp_messages, zodat ze
// in "Gesprekken" (inbox-v2 / wanbetalers inbox) verschijnen naast de inbound.
//
// v=2 (2026-08-30): bij template-sends de gerenderde body opslaan i.p.v. de
// door de caller meegegeven placeholder ("[template: X] jef"). We lezen de
// body_text uit whatsapp_meta_templates (de CRM template-opslag die de admin-
// UI Instellingen → Communicatie → WhatsApp vult) en vervangen positional
// placeholders {{1}}, {{2}}, … + named placeholders {{klant.naam}} vanuit de
// meegegeven variables-map. Fail-soft: als de template niet vindbaar is of de
// render faalt, valt hij terug op de door de caller meegegeven body (die dan
// als leesbare fallback fungeert).
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

  // v=2 (2026-08-30): bij template-sends de body renderen uit
  // whatsapp_meta_templates.body_text. Fail-soft: bij fout → caller-body als
  // fallback zodat de log-write nooit breekt.
  let renderedBody = body;
  if (templateName) {
    try {
      const rendered = await _renderTemplateBody(
        supabaseAdmin, templateName, templateVariables || {}
      );
      if (rendered && rendered.trim()) renderedBody = rendered;
    } catch (e) {
      console.warn(`[wa-outbound-log:${source}] template-render (soft):`, e?.message || e);
    }
  }

  const preview = (renderedBody || '').trim().slice(0, 120);
  const fullBody = (renderedBody || '').slice(0, 1000);

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

// ────────────────────────────────────────────────────────────────────────────
// Interne helper: template body ophalen uit whatsapp_meta_templates en de
// placeholders invullen met de meegegeven vars-map.
//
// Ondersteunt twee placeholder-vormen:
//   {{1}}, {{2}}, …            positional — vars['1'], vars['2'], …
//   {{klant.naam}}, …          named     — vars['klant.naam'] (via
//                                          meta_param_mapping.body als die
//                                          een naam-index-mapping levert,
//                                          anders directe key-match).
//
// Retourneert de gerenderde string, of null als de template niet vindbaar of
// niet approved is. Onbekende placeholders blijven ongewijzigd staan zodat
// een gemiste var zichtbaar is i.p.v. stil opgevreten.
async function _renderTemplateBody(supabaseAdmin, templateName, variablesMap) {
  if (!templateName || !supabaseAdmin) return null;
  let rows = null;
  try {
    const res = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('name, status, body_text, meta_param_mapping')
      .eq('name', templateName)
      .limit(5);
    if (res.error) return null;
    rows = Array.isArray(res.data) ? res.data : [];
  } catch (_) {
    return null;
  }
  // Approved wint; anders eerste beschikbare (bv. pending — nog steeds beter
  // dan placeholder-body).
  const tmpl = rows.find((r) => String(r.status || '').toLowerCase() === 'approved')
            || rows[0]
            || null;
  const body = tmpl?.body_text ? String(tmpl.body_text) : null;
  if (!body) return null;

  const vars = variablesMap && typeof variablesMap === 'object' ? variablesMap : {};

  // Named → positional index-map uit meta_param_mapping.body als beschikbaar.
  // Shape: { '1': 'klant.naam', '2': 'factuur.betaal_link', ... } of
  //        { 'klant.naam': '1', ... } (beide voorgekomen in de codebase).
  const nameToIndex = {};
  const bodyMap = tmpl?.meta_param_mapping?.body;
  if (bodyMap && typeof bodyMap === 'object') {
    for (const [k, v] of Object.entries(bodyMap)) {
      const kIsIdx = /^\d+$/.test(String(k));
      const vIsIdx = /^\d+$/.test(String(v));
      if (kIsIdx && !vIsIdx)      nameToIndex[String(v)] = String(k);
      else if (!kIsIdx && vIsIdx) nameToIndex[String(k)] = String(v);
    }
  }

  return body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, raw) => {
    const key = String(raw).trim();
    if (/^\d+$/.test(key)) {
      const v = vars[key];
      return v != null && v !== '' ? String(v) : `{{${key}}}`;
    }
    // Named — probeer directe key-match op vars, dan via mapping → positional.
    if (vars[key] != null && vars[key] !== '') return String(vars[key]);
    const idx = nameToIndex[key];
    if (idx && vars[idx] != null && vars[idx] !== '') return String(vars[idx]);
    return `{{${key}}}`;
  });
}
