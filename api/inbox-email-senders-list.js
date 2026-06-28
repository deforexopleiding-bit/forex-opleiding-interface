// api/inbox-email-senders-list.js
//
// GET → afzender-gegroepeerde lijst voor de e-mailtak van een inbox-module.
// Per uniek From-adres in INBOX van de module-mailbox wordt een item geleverd
// met (waar gevonden) klant-/attendee-match, laatste onderwerp/datum, totaal
// aantal mails en aantal ongelezen mails (geen \Seen-flag).
//
// Query:
//   module       'onboarding' | 'events' (verplicht — anders 400)
//
// RBAC (fail-closed, per module):
//   onboarding → onboarding.inbox.view
//   events     → events.inbox.view
//
// Scope (gedeelde inboxes):
//   Iedereen met de respectievelijke inbox.view-permissie ziet ALLE afzenders.
//   Geen extra customer/attendee-scope — onboarding@ en events@ zijn gedeelde
//   mailboxen. De WhatsApp-tak per module houdt z'n eigen scope; alleen
//   e-mail is openbaar binnen de RBAC-set.
//
// IMAP (hergebruikt patroon van api/emails.js fetchMailbox):
//   - Host/port via process.env.IMAP_HOST / IMAP_PORT (default 993).
//   - User: per-module (zie MODULE_ACCOUNTS).
//   - Pass: per-module env-var (ontbrekend → 200 met warning).
//   - INBOX, since 2026-01-01 — envelope + flags + uid.
//
// Afzender-match per module:
//   - onboarding → customers.email IN {afzenders} → { customer_id, name }
//   - events     → event_attendees.email IN {afzenders} → { attendee_id, name }
//
// Response 200:
//   { items:[…sorteer op last_date desc], total, unread_total, module, warning? }
//   Per item: { email, name, customer_id?, customer_name?, attendee_id?, attendee_name?,
//               last_subject, last_date, count, unread_count }
//
// Fail-soft: IMAP-fout / mailbox-fout → 200 met { items:[], total:0,
// unread_total:0, module, warning }.
// Strikt fail-closed op auth + RBAC (geen IMAP-call zonder rechten).

import { ImapFlow } from 'imapflow';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const MODULE_ACCOUNTS = {
  onboarding: {
    user:    'onboarding@deforexopleiding.nl',
    passEnv: 'IMAP_PASS_ONBOARDING',
    permKey: 'onboarding.inbox.view',
    match:   'customers',
  },
  events: {
    user:    'events@deforexopleiding.nl',
    passEnv: 'IMAP_PASS_EVENTS',
    permKey: 'events.inbox.view',
    match:   'event_attendees',
  },
};
const SINCE_DATE = new Date('2026-01-01T00:00:00Z');

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function attendeeDisplayName(a, fallback = '') {
  if (!a) return fallback;
  const n = `${(a.first_name || '').trim()} ${(a.last_name || '').trim()}`.trim();
  return n || fallback;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Module-gate: alleen onboarding/events. Andere modules → 400.
  const moduleKey = typeof req.query?.module === 'string' ? req.query.module.trim().toLowerCase() : '';
  const acct = MODULE_ACCOUNTS[moduleKey];
  if (!acct) {
    return res.status(400).json({ error: "module moet 'onboarding' of 'events' zijn" });
  }

  // RBAC fail-closed. Geen extra customer/attendee-scope — gedeelde inboxes.
  if (!(await requirePermission(req, acct.permKey))) {
    return res.status(403).json({ error: `Geen rechten (${acct.permKey})` });
  }

  // IMAP-config.
  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST niet geconfigureerd' });
  const port = parseInt(IMAP_PORT || '993', 10);
  const pass = process.env[acct.passEnv];
  if (!pass) {
    return res.status(200).json({
      items: [], total: 0, unread_total: 0, module: moduleKey,
      warning: `Wachtwoord (${acct.passEnv}) niet gezet; geen IMAP-fetch.`,
    });
  }

  // Per uniek normalized From-adres aggregeren we tijdens de fetch — sneller
  // en zuiniger dan een raw-array opbouwen en achteraf reducen.
  // Shape per entry:
  //   { email, name_envelope, last_subject, last_date_iso, count, unread_count }
  const senders = new Map();
  let warning = null;

  const client = new ImapFlow({
    host:          IMAP_HOST,
    port,
    secure:        true,
    auth:          { user: acct.user, pass },
    logger:        false,
    socketTimeout: 9000,
  });

  try {
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        for await (const msg of client.fetch(
          { since: SINCE_DATE },
          { envelope: true, flags: true, uid: true }
        )) {
          const env = msg.envelope || {};
          const fromEntry = env.from?.[0];
          const fromAddr  = normalizeEmail(fromEntry?.address || '');
          if (!fromAddr) continue;
          const fromName  = fromEntry?.name || '';
          const subject   = env.subject || '(geen onderwerp)';
          const dateIso   = env.date ? new Date(env.date).toISOString() : new Date().toISOString();
          const isUnread  = !msg.flags?.has('\\Seen');

          let entry = senders.get(fromAddr);
          if (!entry) {
            entry = {
              email:         fromAddr,
              name_envelope: fromName || '',
              last_subject:  subject,
              last_date_iso: dateIso,
              count:         0,
              unread_count:  0,
            };
            senders.set(fromAddr, entry);
          }
          entry.count += 1;
          if (isUnread) entry.unread_count += 1;
          if (dateIso > entry.last_date_iso) {
            entry.last_date_iso = dateIso;
            entry.last_subject  = subject;
            if (fromName && !entry.name_envelope) entry.name_envelope = fromName;
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error('[inbox-email-senders-list] IMAP failure:', e?.message || e);
    return res.status(200).json({
      items: [], total: 0, unread_total: 0, module: moduleKey,
      warning: 'IMAP-fout: ' + (e?.message || String(e)),
    });
  }

  // Afzender-matching per module: één IN-query op de bijbehorende tabel.
  // Lege set → skip. PostgREST default-limit van 1000 is ruim genoeg voor
  // 8 maanden mailverkeer; bij groei pakken we paginatie zoals admin-rbac.
  const senderEmails = Array.from(senders.keys());
  const emailToCustomer = new Map();
  const emailToAttendee = new Map();
  if (senderEmails.length > 0) {
    if (acct.match === 'customers') {
      try {
        const { data: custRows, error: custErr } = await supabaseAdmin
          .from('customers')
          .select('id, email, first_name, last_name, company_name, is_company')
          .in('email', senderEmails);
        if (custErr) {
          console.error('[inbox-email-senders-list] customer lookup:', custErr.message);
          warning = warning || ('Klantenlookup mislukt: ' + custErr.message);
        } else {
          for (const c of (custRows || [])) {
            const e = normalizeEmail(c.email);
            if (!e) continue;
            // Bij dubbele rijen voor hetzelfde adres: eerste-wint is acceptabel.
            if (!emailToCustomer.has(e)) emailToCustomer.set(e, c);
          }
        }
      } catch (e) {
        console.error('[inbox-email-senders-list] customer lookup exception:', e?.message || e);
        warning = warning || ('Klantenlookup mislukt: ' + (e?.message || e));
      }
    } else if (acct.match === 'event_attendees') {
      try {
        const { data: attRows, error: attErr } = await supabaseAdmin
          .from('event_attendees')
          .select('id, email, first_name, last_name')
          .in('email', senderEmails);
        if (attErr) {
          console.error('[inbox-email-senders-list] attendee lookup:', attErr.message);
          warning = warning || ('Attendee-lookup mislukt: ' + attErr.message);
        } else {
          for (const a of (attRows || [])) {
            const e = normalizeEmail(a.email);
            if (!e) continue;
            if (!emailToAttendee.has(e)) emailToAttendee.set(e, a);
          }
        }
      } catch (e) {
        console.error('[inbox-email-senders-list] attendee lookup exception:', e?.message || e);
        warning = warning || ('Attendee-lookup mislukt: ' + (e?.message || e));
      }
    }
  }

  // Items bouwen. Gedeelde inbox → geen extra filter; elke afzender komt
  // erin, met klant-/attendee-velden indien gematcht (cosmetisch voor de naam).
  const items = [];
  let unread_total = 0;
  for (const entry of senders.values()) {
    const item = {
      email:         entry.email,
      name:          entry.name_envelope || entry.email,
      last_subject:  entry.last_subject,
      last_date:     entry.last_date_iso,
      count:         entry.count,
      unread_count:  entry.unread_count,
    };

    if (acct.match === 'customers') {
      const cust   = emailToCustomer.get(entry.email) || null;
      const custId = cust?.id || null;
      const custName = cust ? customerDisplayName(cust, '') : '';
      item.name          = entry.name_envelope || custName || entry.email;
      item.customer_id   = custId;
      item.customer_name = custName || null;
    } else if (acct.match === 'event_attendees') {
      const att   = emailToAttendee.get(entry.email) || null;
      const attId = att?.id || null;
      const attName = att ? attendeeDisplayName(att, '') : '';
      item.name          = entry.name_envelope || attName || entry.email;
      item.attendee_id   = attId;
      item.attendee_name = attName || null;
    }

    items.push(item);
    unread_total += entry.unread_count;
  }

  items.sort((a, b) => String(b.last_date).localeCompare(String(a.last_date)));

  const response = {
    items,
    total:        items.length,
    unread_total,
    module:       moduleKey,
  };
  if (warning) response.warning = warning;
  return res.status(200).json(response);
}
