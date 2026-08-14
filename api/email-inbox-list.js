// api/email-inbox-list.js
//
// v2 E-mail module — GET inbox-lijst uit email_messages tabel (gevuld door
// sync-emails cron). Snel + gepagineerd + filterbaar op mailbox/folder/search.
// GEEN live IMAP-fetch — dat doet v1 (/api/emails). Deze endpoint is puur
// Supabase-read op de door de cron beheerde cache.
//
// Kolommen (bron: sync-emails.js + CLAUDE.md email_messages schema):
//   id, mailbox, imap_uid, message_id, from_address, from_name, subject,
//   date_received (NIET received_at), snippet (NIET body_snippet),
//   category, requires_action, is_read, body_fetched_at, attachments (jsonb),
//   customer_id
//
// Query-params:
//   mailbox   optional string — 'leads'|'info'|'partners'|'administratie'|
//                               'onboarding'|'events'|'welkom' of leeg=alle
//   folder    optional string — 'inbox' (default) | 'sent'
//   search    optional string — case-insensitive contains op subject OR from_address
//                               OR snippet
//   limit     optional int    — default 50, max 200
//   offset    optional int    — default 0 (paginering)
//   unread    optional 1/true — filter alleen ongelezen (is_read=false)
//
// Response:
//   { items: [{ id, mailbox, imap_uid, message_id, subject, from_address,
//     from_name, date_received, snippet, is_read, has_attachments,
//     customer_id, requires_action }],
//     total: <int>, limit, offset, hasMore: <bool> }
//
// Sent-folder (folder='sent') leest uit email_replies. Zelfde shape maar
// from_address = onze mailbox, to_address = klant. Sinds die tabel is
// wat api/send-email.js gebruikt om verzonden mail te loggen.
//
// Permission: email.module.access (spiegel van api/emails.js).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const KNOWN_MAILBOXES = [
  'leads@deforexopleiding.nl',
  'info@deforexopleiding.nl',
  'partners@deforexopleiding.nl',
  'administratie@deforexopleiding.nl',
  'onboarding@deforexopleiding.nl',
  'events@deforexopleiding.nl',
  'welkom@deforexopleiding.nl',
];

// Kort→full mailbox-naam mapping. sync-emails slaat `mailbox` op als slug
// ('leads', 'info', ...); front-end mag beide sturen.
function normalizeMailbox(m) {
  if (!m) return null;
  const s = String(m).trim().toLowerCase();
  if (KNOWN_MAILBOXES.includes(s)) return s.split('@')[0];   // 'info@...' → 'info'
  const slug = s.split('@')[0];
  return ['leads','info','partners','administratie','onboarding','events','welkom'].includes(slug)
    ? slug : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'email.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
  }

  const q = req.query || {};
  const mailbox = normalizeMailbox(q.mailbox);
  const folder  = String(q.folder || 'inbox').toLowerCase();
  const search  = typeof q.search === 'string' ? q.search.trim() : '';
  let limit  = Number(q.limit  || 50);
  let offset = Number(q.offset || 0);
  if (!Number.isFinite(limit)  || limit  < 1) limit  = 50;
  if (limit > 200) limit = 200;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const unreadOnly = String(q.unread || '') === '1' || String(q.unread || '').toLowerCase() === 'true';

  try {
    if (folder === 'sent') {
      // ── Verzonden folder — uit email_replies ────────────────────────────
      // Kolommen: id, email_id, email_subject, final_reply, from_address,
      //           to_address, cc_address, bcc_address, sent_at, sent_by_id,
      //           attachments (jsonb).
      let qb = supabaseAdmin
        .from('email_replies')
        .select('id, email_id, email_subject, from_address, to_address, cc_address, sent_at, attachments', { count: 'exact' })
        .order('sent_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (mailbox) {
        // from_address in email_replies is de FULL email (bv. 'info@deforexopleiding.nl')
        qb = qb.eq('from_address', `${mailbox}@deforexopleiding.nl`);
      }
      if (search) {
        const pat = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
        qb = qb.or(`email_subject.ilike.${pat},to_address.ilike.${pat}`);
      }
      const { data, error, count } = await qb;
      if (error) throw error;
      const items = (data || []).map((r) => ({
        id:              String(r.id),
        mailbox:         (r.from_address || '').split('@')[0] || null,
        imap_uid:        null,
        message_id:      null,
        subject:         r.email_subject || '(geen onderwerp)',
        from_address:    r.from_address,
        from_name:       null,
        to_address:      r.to_address,
        date_received:   r.sent_at,
        snippet:         null,
        is_read:         true,
        has_attachments: Array.isArray(r.attachments) && r.attachments.length > 0,
        customer_id:     null,
        requires_action: false,
        _source:         'sent',
      }));
      const total   = typeof count === 'number' ? count : items.length;
      const hasMore = offset + items.length < total;
      return res.status(200).json({ items, total, limit, offset, hasMore, folder: 'sent' });
    }

    // ── Inbox folder — uit email_messages ─────────────────────────────────
    let qb = supabaseAdmin
      .from('email_messages')
      .select('id, mailbox, imap_uid, message_id, from_address, from_name, subject, date_received, snippet, is_read, requires_action, category, attachments, customer_id', { count: 'exact' })
      .order('date_received', { ascending: false })
      .range(offset, offset + limit - 1);
    if (mailbox) qb = qb.eq('mailbox', mailbox);
    if (unreadOnly) qb = qb.eq('is_read', false);
    if (search) {
      const pat = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      qb = qb.or(`subject.ilike.${pat},from_address.ilike.${pat},snippet.ilike.${pat}`);
    }
    const { data, error, count } = await qb;
    if (error) throw error;
    const items = (data || []).map((r) => ({
      id:              String(r.id),
      mailbox:         r.mailbox,
      imap_uid:        r.imap_uid,
      message_id:      r.message_id,
      subject:         r.subject || '(geen onderwerp)',
      from_address:    r.from_address,
      from_name:       r.from_name,
      to_address:      null,
      date_received:   r.date_received,
      snippet:         r.snippet,
      is_read:         !!r.is_read,
      has_attachments: Array.isArray(r.attachments) && r.attachments.length > 0,
      customer_id:     r.customer_id,
      requires_action: !!r.requires_action,
      category:        r.category || null,
      _source:         'inbox',
    }));
    const total   = typeof count === 'number' ? count : items.length;
    const hasMore = offset + items.length < total;
    return res.status(200).json({ items, total, limit, offset, hasMore, folder: 'inbox' });
  } catch (e) {
    console.error('[email-inbox-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
