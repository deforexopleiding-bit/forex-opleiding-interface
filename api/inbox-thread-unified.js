// api/inbox-thread-unified.js
// GET → verenigde thread (WhatsApp + e-mail) chronologisch gesorteerd voor 1 klant.
//
// FASE 4 blok 3 — kern-endpoint van de unified inbox. Voedt de rendering
// achter de feature-flag `unified_inbox_enabled`. Fail-safe: als de flag UIT
// staat gebruikt de UI nog steeds /api/inbox-messages-list en raakt dit
// endpoint niet aan.
//
// Query:
//   ?conversation_id=<uuid>   (verplicht — WA-conv geeft ook meteen customer_id)
//   ?include_email=1|0        (default 1)
//   ?limit=200                (max items totaal, oldest-first)
//
// Response 200:
//   {
//     items: [
//       { channel: 'whatsapp'|'email',
//         id, direction: 'inbound'|'outbound', body, at, meta: {...} },
//       ...
//     ],
//     conversation: { id, customer_id, can_send_text, phone_number },
//     counts: { whatsapp, email, total }
//   }
//
// Permission: finance.inbox.view (dezelfde als inbox-messages-list).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.inbox.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view)' });
  }

  const q = req.query || {};
  const convId = q.conversation_id ? String(q.conversation_id).trim() : '';
  if (!convId || !UUID_RE.test(convId)) {
    return res.status(400).json({ error: 'conversation_id (uuid) vereist' });
  }
  const includeEmail = String(q.include_email ?? '1') === '1';
  const limit = clampInt(q.limit, 200, 10, 500);

  try {
    // 1) Conv-details.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, status, phone_number, last_inbound_at, unread_count')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conv: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // can_send_text: last_inbound_at < 24h geleden.
    let canSendText = false;
    if (conv.last_inbound_at) {
      const ms = new Date(conv.last_inbound_at).getTime();
      canSendText = (Date.now() - ms) < 24 * 3600 * 1000;
    }

    // 2) WhatsApp-messages voor deze conv.
    const { data: waMsgs, error: waErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .select('id, direction, body, media_url, media_type, template_name, status, sent_at, delivered_at, read_at, meta_wamid, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true });
    if (waErr) throw new Error('whatsapp: ' + waErr.message);

    // 3) Email-messages voor gekoppelde klant (indien any).
    let emailMsgs = [];
    if (includeEmail && conv.customer_id) {
      const { data: eMsgs, error: eErr } = await supabaseAdmin
        .from('email_messages')
        .select('id, mailbox, from_address, from_name, subject, snippet, body_text, body_html, date_received, message_id, category')
        .eq('customer_id', conv.customer_id)
        .order('date_received', { ascending: true });
      if (eErr) {
        // Fail-soft: email-fetch mag WA-thread niet blokkeren.
        console.warn('[inbox-thread-unified] email fetch failed:', eErr.message);
      } else {
        emailMsgs = eMsgs || [];
      }
    }

    // 4) Merge chronologisch.
    const items = [];
    for (const m of waMsgs || []) {
      items.push({
        channel: 'whatsapp',
        id: m.id,
        direction: m.direction, // 'inbound' | 'outbound'
        body: m.body || (m.template_name ? `[template] ${m.template_name}` : (m.media_type ? `[${m.media_type}]` : '')),
        at: m.created_at || m.sent_at,
        meta: {
          media_url: m.media_url,
          media_type: m.media_type,
          template_name: m.template_name,
          status: m.status,
          wamid: m.meta_wamid,
        },
      });
    }
    for (const m of emailMsgs) {
      items.push({
        channel: 'email',
        id: m.id,
        // Inbound = van klant naar ons. Wij hebben nu geen email-outbound-registratie
        // in email_messages (die tabel is IMAP-only inbound), dus alle rijen zijn
        // per definitie inbound. Later: outbound via SMTP → aparte tabel of
        // direction-flag.
        direction: 'inbound',
        body: (m.snippet || m.body_text || '').slice(0, 4000),
        at: m.date_received,
        meta: {
          subject: m.subject,
          mailbox: m.mailbox,
          from_address: m.from_address,
          from_name: m.from_name,
          category: m.category,
          message_id: m.message_id,
          has_html: !!m.body_html,
        },
      });
    }
    items.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

    // Truncate op limit — meest recente eerst behouden bij overflow.
    let trimmed = items;
    if (items.length > limit) {
      trimmed = items.slice(items.length - limit);
    }

    return res.status(200).json({
      items: trimmed,
      conversation: {
        id: conv.id,
        customer_id: conv.customer_id,
        can_send_text: canSendText,
        phone_number: conv.phone_number,
      },
      counts: {
        whatsapp: (waMsgs || []).length,
        email: emailMsgs.length,
        total: items.length,
        returned: trimmed.length,
      },
    });
  } catch (e) {
    console.error('[inbox-thread-unified]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
