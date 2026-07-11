// api/wanbetalers-sandbox-simulate-inbound.js
// POST { body } → voegt een fake inkomend WA-bericht toe voor de test-persoon
// via hetzelfde code-pad als inbox-webhook (whatsapp_conversations + _messages
// insert, last_inbound_at, dunning-pipeline 'in_gesprek'-trigger).
// Super_admin only.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const messageText = String(body.body || '').trim() || 'Ik zal deze week betalen.';

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });
    if (!customer.phone) return res.status(400).json({ error: 'Test-persoon heeft geen telefoonnummer.' });

    const nowIso = new Date().toISOString();

    // 1) Finance-WABA phone_number_id — hergebruikt uit whatsapp_module_config.
    const { data: modCfg } = await supabaseAdmin
      .from('whatsapp_module_config').select('phone_number_id')
      .eq('module', 'finance').eq('is_active', true).maybeSingle();
    const pnId = modCfg?.phone_number_id || null;

    // 2) find-or-create conversation op de VOLLEDIGE unieke sleutel
    // (phone_number, phone_number_id). Alleen op phone matchen faalt bij
    // legacy pnid=null-rijen naast een pnid-gebonden rij → duplicate-key
    // op de unieke index whatsapp_conversations_phone_pnid_key.
    const phone = customer.phone.startsWith('+') ? customer.phone : ('+' + customer.phone);
    let convId;

    async function _findConv() {
      let q = supabaseAdmin
        .from('whatsapp_conversations').select('id, status, customer_id')
        .eq('phone_number', phone);
      q = (pnId == null) ? q.is('phone_number_id', null) : q.eq('phone_number_id', pnId);
      const { data: rows } = await q.limit(1);
      return (rows && rows[0]) || null;
    }

    let existing = await _findConv();

    // Guard: kaap nooit een echt (niet-test) gesprek voor een andere klant.
    if (existing && existing.customer_id && existing.customer_id !== customer.id) {
      const { data: owner } = await supabaseAdmin
        .from('customers').select('is_test').eq('id', existing.customer_id).maybeSingle();
      if (owner && owner.is_test === false) {
        return res.status(409).json({
          error: 'Er bestaat al een echt gesprek met dit nummer voor een andere klant. Gebruik een ander test-telefoonnummer.',
        });
      }
    }

    const displayName = String(customer.first_name || '').replace(/^🧪 TEST — /, '') || 'Sandbox';

    if (existing) {
      // Adopt: koppel aan de test-klant + registreer inbound-timestamps.
      convId = existing.id;
      const currentStatus = String(existing.status || 'open');
      const nextStatus    = (currentStatus === 'archived') ? 'archived' : 'open';
      await supabaseAdmin.from('whatsapp_conversations').update({
        last_message_at     : nowIso,
        last_message_preview: messageText.slice(0, 120),
        last_inbound_at     : nowIso,
        status              : nextStatus,
        customer_id         : customer.id,
      }).eq('id', existing.id);
    } else {
      // Insert; bij dup-key (race of subtiel formaatverschil) opnieuw zoeken
      // op de volledige sleutel en de gevonden rij adopteren.
      const { data: inserted, error: cErr } = await supabaseAdmin
        .from('whatsapp_conversations').insert({
          phone_number        : phone,
          phone_number_id     : pnId,
          customer_id         : customer.id,
          display_name        : displayName,
          status              : 'open',
          last_message_at     : nowIso,
          last_message_preview: messageText.slice(0, 120),
          unread_count        : 1,
          last_inbound_at     : nowIso,
        }).select('id').single();
      if (cErr) {
        const isDup = /duplicate key|whatsapp_conversations_phone_pnid_key|23505/i.test(cErr.message || '');
        if (!isDup) throw new Error('conv insert: ' + cErr.message);
        const retry = await _findConv();
        if (!retry) throw new Error('conv insert (race): ' + cErr.message);
        convId = retry.id;
        const currentStatus = String(retry.status || 'open');
        const nextStatus    = (currentStatus === 'archived') ? 'archived' : 'open';
        await supabaseAdmin.from('whatsapp_conversations').update({
          last_message_at     : nowIso,
          last_message_preview: messageText.slice(0, 120),
          last_inbound_at     : nowIso,
          status              : nextStatus,
          customer_id         : customer.id,
        }).eq('id', retry.id);
      } else {
        convId = inserted.id;
      }
    }

    // 3) Insert het inbound bericht.
    const { data: msg, error: mErr } = await supabaseAdmin
      .from('whatsapp_messages').insert({
        conversation_id: convId,
        direction      : 'in',
        body           : messageText,
        status         : 'delivered',
        delivered_at   : nowIso,
        created_at     : nowIso,
      }).select('id').single();
    if (mErr) throw new Error('msg insert: ' + mErr.message);

    // 4) Pipeline-trigger 'on_inbound_to_in_gesprek' — hergebruikt lib direct.
    try {
      const { isAutoEnabled, setStage } = await import('./_lib/dunning-pipeline.js');
      if (await isAutoEnabled('on_inbound_to_in_gesprek')) {
        await setStage(customer.id, 'in_gesprek', 'inbound_reply', 'sandbox:inbound', {
          onlyIfFrom: new Set(['nieuw', 'aangemaand']),
        });
      }
    } catch (e) {
      console.warn('[sandbox-simulate-inbound] pipeline hook soft-fail', e?.message);
    }

    // 5) Joost-keten — zelfde als de echte inbox-webhook (runJoostSuggest +
    // autonomie-chain via HTTP self-call), maar SYNCHROON. De #691-guard
    // in joost-send-autonomous onderschept de echte Meta-send voor
    // is_test-klanten (dry-run → gelogd + outbound message in de chat).
    // Alles fail-soft: een Joost-fout mag de inbound-simulatie NOOIT laten
    // falen.
    const joost = { ran: false, suggestion_id: null, suggested_reply: null, autonomy_sent: false, note: null };
    try {
      const { runJoostSuggest } = await import('./_lib/joost-suggest-core.js');
      const sug = await runJoostSuggest({
        supabase              : supabaseAdmin,
        conversationId        : convId,
        triggeredByMessageId  : msg.id,
        autoTriggered         : true,
        requestedByUserId     : null,
        clientIp              : null,
        // Sandbox-bypass: honoreerd door core alleen bij is_test-klant.
        allowDisabledForTest  : true,
      });
      if (sug?.status === 200 && sug.body?.suggestion?.id) {
        joost.ran = true;
        joost.suggestion_id   = sug.body.suggestion.id;
        joost.suggested_reply = sug.body.suggestion.suggested_reply || null;
        // Autonomie-chain — zelfde als de webhook (HTTP self-call).
        // De #691-guard vangt is_test-klanten op.
        const token = process.env.INTERNAL_API_TOKEN;
        if (token) {
          const base = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : (process.env.APP_BASE_URL || 'http://localhost:3000');
          try {
            const r2 = await fetch(`${base}/api/joost-send-autonomous`, {
              method:  'POST',
              headers: { 'content-type': 'application/json', 'x-internal-token': token },
              body:    JSON.stringify({ suggestion_id: joost.suggestion_id, test_bypass: true }),
            });
            joost.autonomy_sent = r2.ok;
            if (!r2.ok) {
              const txt = await r2.text().catch(() => '');
              joost.note = 'autonomie HTTP ' + r2.status + ': ' + (txt || '').slice(0, 160);
            }
          } catch (fetchErr) {
            joost.note = 'autonomie fetch fail: ' + (fetchErr?.message || fetchErr);
          }
        } else {
          joost.note = 'INTERNAL_API_TOKEN ontbreekt — alleen concept, geen autonome send';
        }
      } else {
        joost.note = 'suggest status ' + (sug?.status) + ': ' + (sug?.body?.error || sug?.body?.message || '');
      }
    } catch (e) {
      joost.note = 'joost fail-soft: ' + (e?.message || e);
    }

    return res.status(200).json({ ok: true, conversation_id: convId, message_id: msg.id, joost });
  } catch (e) {
    console.error('[sandbox-simulate-inbound]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
