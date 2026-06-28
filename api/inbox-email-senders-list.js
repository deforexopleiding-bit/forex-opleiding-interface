// api/inbox-email-senders-list.js
//
// GET → afzender-gegroepeerde lijst voor de onboarding-inbox e-mailtak.
// Per uniek From-adres in INBOX van onboarding@deforexopleiding.nl wordt een
// item geleverd met klant-match (indien gevonden), laatste onderwerp/datum,
// totaal aantal mails en aantal ongelezen mails (geen \Seen-flag).
//
// Fase 1: backend-only. Frontend hangt in Fase 2.
//
// Query:
//   module       'onboarding' (verplicht — andere modules → 400)
//
// RBAC (fail-closed):
//   onboarding.inbox.view
//
// Scope (gedeelde inbox):
//   Iedereen met onboarding.inbox.view ziet ALLE afzenders. Geen
//   customer-scope op de e-mail-kant — onboarding@ is een gedeelde mailbox
//   waar mentors en admins samen op werken. De WhatsApp-tak houdt z'n
//   eigen scope; alleen e-mail is openbaar binnen de RBAC-set.
//
// IMAP (hergebruikt patroon van api/emails.js fetchMailbox):
//   - Host/port via process.env.IMAP_HOST / IMAP_PORT (default 993).
//   - User: onboarding@deforexopleiding.nl
//   - Pass: process.env.IMAP_PASS_ONBOARDING (ontbrekend → 200 met warning).
//   - INBOX, since 2026-01-01 — envelope + flags + uid.
//
// Response 200:
//   { items:[…sorteer op last_date desc], total, unread_total, module:'onboarding', warning? }
//
// Fail-soft: IMAP-fout / mailbox-fout → 200 met { items:[], total:0,
// unread_total:0, module:'onboarding', warning }.
// Strikt fail-closed op auth + RBAC (geen IMAP-call zonder rechten).

import { ImapFlow } from 'imapflow';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const ONBOARDING_USER     = 'onboarding@deforexopleiding.nl';
const ONBOARDING_PASS_ENV = 'IMAP_PASS_ONBOARDING';
const ONBOARDING_PERM_KEY = 'onboarding.inbox.view';
const SINCE_DATE          = new Date('2026-01-01T00:00:00Z');

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
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

  // Module-gate: alleen onboarding (spiegel van inbox-conversations-list:
  // andere modules → 400). Houd hierdoor de route enkelvoudig en de
  // mailbox-keuze hard.
  const moduleKey = typeof req.query?.module === 'string' ? req.query.module.trim().toLowerCase() : '';
  if (moduleKey !== 'onboarding') {
    return res.status(400).json({ error: "module moet 'onboarding' zijn" });
  }

  // RBAC fail-closed. Geen extra customer-scope: onboarding@ is een
  // gedeelde mailbox, iedereen met onboarding.inbox.view ziet alle
  // afzenders.
  if (!(await requirePermission(req, ONBOARDING_PERM_KEY))) {
    return res.status(403).json({ error: `Geen rechten (${ONBOARDING_PERM_KEY})` });
  }

  // IMAP-config.
  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST niet geconfigureerd' });
  const port = parseInt(IMAP_PORT || '993', 10);
  const pass = process.env[ONBOARDING_PASS_ENV];
  if (!pass) {
    return res.status(200).json({
      items: [], total: 0, unread_total: 0, module: 'onboarding',
      warning: `Wachtwoord (${ONBOARDING_PASS_ENV}) niet gezet; geen IMAP-fetch.`,
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
    auth:          { user: ONBOARDING_USER, pass },
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
      items: [], total: 0, unread_total: 0, module: 'onboarding',
      warning: 'IMAP-fout: ' + (e?.message || String(e)),
    });
  }

  // Klant-matching: één query op customers.email IN {afzenders}. Lege set
  // → skip (geen unnecessary roundtrip). PostgREST default-limit van 1000
  // is hier ruim genoeg voor 8 maanden mailverkeer; bij groei kunnen we
  // dezelfde paginatie pakken als admin-rbac (gepagineerde load).
  const senderEmails = Array.from(senders.keys());
  const emailToCustomer = new Map();
  if (senderEmails.length > 0) {
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
          // Bij dubbele rijen voor hetzelfde adres: eerste-wint is acceptabel;
          // mentor-scope kijkt naar set-membership en die check werkt op alle
          // matches gelijk.
          if (!emailToCustomer.has(e)) emailToCustomer.set(e, c);
        }
      }
    } catch (e) {
      console.error('[inbox-email-senders-list] customer lookup exception:', e?.message || e);
      warning = warning || ('Klantenlookup mislukt: ' + (e?.message || e));
    }
  }

  // Items bouwen. Gedeelde inbox → geen extra filter; elke afzender komt
  // erin, met klant-velden indien gematcht (puur cosmetisch voor de naam).
  const items = [];
  let unread_total = 0;
  for (const entry of senders.values()) {
    const cust   = emailToCustomer.get(entry.email) || null;
    const custId = cust?.id || null;

    const custName = cust ? customerDisplayName(cust, '') : '';
    const displayName =
      entry.name_envelope ||
      custName ||
      entry.email;

    items.push({
      email:         entry.email,
      name:          displayName,
      customer_id:   custId,
      customer_name: custName || null,
      last_subject:  entry.last_subject,
      last_date:     entry.last_date_iso,
      count:         entry.count,
      unread_count:  entry.unread_count,
    });
    unread_total += entry.unread_count;
  }

  items.sort((a, b) => String(b.last_date).localeCompare(String(a.last_date)));

  const response = {
    items,
    total:        items.length,
    unread_total,
    module:       'onboarding',
  };
  if (warning) response.warning = warning;
  return res.status(200).json(response);
}
