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

    // 2) find-or-create conversation.
    const phone = customer.phone.startsWith('+') ? customer.phone : ('+' + customer.phone);
    let convId;
    const { data: existing } = await supabaseAdmin
      .from('whatsapp_conversations').select('id, status')
      .eq('phone_number', phone).maybeSingle();
    if (existing) {
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
      const { data: inserted, error: cErr } = await supabaseAdmin
        .from('whatsapp_conversations').insert({
          phone_number        : phone,
          phone_number_id     : pnId,
          customer_id         : customer.id,
          display_name        : String(customer.first_name || '').replace(/^🧪 TEST — /, '') || 'Sandbox',
          status              : 'open',
          last_message_at     : nowIso,
          last_message_preview: messageText.slice(0, 120),
          unread_count        : 1,
          last_inbound_at     : nowIso,
        }).select('id').single();
      if (cErr) throw new Error('conv insert: ' + cErr.message);
      convId = inserted.id;
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

    return res.status(200).json({ ok: true, conversation_id: convId, message_id: msg.id });
  } catch (e) {
    console.error('[sandbox-simulate-inbound]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
