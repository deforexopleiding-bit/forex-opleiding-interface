// api/inbox-emails-list.js
//
// GET → live IMAP-thread van één klant op één module-lijn (onboarding/events).
// Read-only; geen DB-schrijfacties; geen migratie; geen nieuwe tabel.
//
// Query:
//   customer_id  uuid (verplicht)
//   module       'onboarding' | 'events' (verplicht)
//
// Module → mailbox (mirror van api/send-email.js SMTP_ACCOUNTS):
//   onboarding → onboarding@deforexopleiding.nl (IMAP_PASS_ONBOARDING)
//   events     → events@deforexopleiding.nl     (IMAP_PASS_EVENTS)
//
// RBAC (fail-closed):
//   module=onboarding → onboarding.inbox.view
//   module=events     → events.inbox.view
//
// Flow:
//   1) customer lookup (id, email) — geen email → { items: [] }.
//   2) IMAP connect (zelfde patroon als api/emails.js fetchMailbox).
//   3) INBOX  → client.search({ from: customerEmail }) → inbound.
//   4) Sent-map detecteren via client.list() op specialUse '\Sent'
//      (Strato-naam kan afwijken; fallback op naam-regex).
//      → client.search({ to: customerEmail }) → outbound.
//   5) parseMessage() per bericht (envelope + bodyParts:['1'] voor preview).
//   6) Merge inbound+outbound, sort by date asc (oudste eerst).
//
// Fail-soft: IMAP-fout of Sent-map niet gevonden → warning + lege/partial items.
// Geen N+1 (één IMAP-verbinding voor één mailbox).
//
// Response 200:
//   { customer_email, items: [...], count, warning? }

import { ImapFlow } from 'imapflow';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getOnboardingScope, getMentorCustomerIds } from './_lib/onboardingScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODULE_ACCOUNTS = {
  onboarding: { user: 'onboarding@deforexopleiding.nl', passEnv: 'IMAP_PASS_ONBOARDING', permKey: 'onboarding.inbox.view' },
  events:     { user: 'events@deforexopleiding.nl',     passEnv: 'IMAP_PASS_EVENTS',     permKey: 'events.inbox.view' },
};

function escAddr(s) { return String(s || '').trim(); }

function buildPreview(text, max = 200) {
  if (!text) return '';
  // Strip carriage returns + comprimeer whitespace; knip op max.
  const compact = String(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return compact.slice(0, max);
}

function parseMessage(msg, mailbox, direction) {
  const env = msg.envelope || {};
  const subject = env.subject || '(geen onderwerp)';
  const fromEntry = env.from?.[0];
  const fromName    = fromEntry?.name || '';
  const fromAddress = fromEntry?.address || '';
  const fromText = fromName ? `${fromName} <${fromAddress}>` : (fromAddress || 'Onbekend');
  const toEntry = env.to?.[0];
  const toAddress = toEntry?.address || '';
  const date = env.date ? new Date(env.date).toISOString() : new Date().toISOString();

  // bodyParts is een Map als wij bodyParts:['1'] hebben gevraagd.
  // Multipart-cases kunnen falen → lege preview is acceptabel.
  let preview = '';
  try {
    const bp = msg.bodyParts;
    let raw = null;
    if (bp && typeof bp.get === 'function') {
      raw = bp.get('1') || bp.get('TEXT') || null;
    }
    if (raw) {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      preview = buildPreview(text, 200);
    }
  } catch { /* fail-soft */ }

  return {
    uid:       `${mailbox}:${msg.uid}`,
    mailbox,
    direction,                              // 'inbound' | 'outbound'
    from:      fromText,
    from_name: fromName || fromAddress.split('@')[0] || '',
    to:        toAddress,
    subject,
    date,
    preview,
  };
}

// Detecteer Sent-map via specialUse '\Sent' (RFC 6154). Strato kan localized
// naam hebben ("Verzonden objecten"); we vertrouwen op specialUse en vallen
// terug op een naam-regex (sent/verzonden) zonder hardcoded string.
function findSentMailbox(boxes) {
  if (!Array.isArray(boxes)) return null;
  const isSentFlag = (b) => {
    const su = b?.specialUse;
    if (!su) return false;
    if (Array.isArray(su)) return su.includes('\\Sent');
    return String(su) === '\\Sent';
  };
  let hit = boxes.find(isSentFlag);
  if (hit) return hit.path || hit.name || null;
  // Fallback: naam-regex op path of name.
  hit = boxes.find((b) => /(^|\/)(sent|verzonden)/i.test(String(b?.path || b?.name || '')));
  return hit ? (hit.path || hit.name || null) : null;
}

async function searchAndFetch(client, criteria, opts) {
  const uids = await client.search(criteria, { uid: true });
  if (!Array.isArray(uids) || uids.length === 0) return [];
  const out = [];
  for await (const msg of client.fetch(uids, opts, { uid: true })) {
    out.push(msg);
  }
  return out;
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

  // Validatie.
  const customerId = typeof req.query?.customer_id === 'string' ? req.query.customer_id.trim() : '';
  const attendeeId = typeof req.query?.attendee_id === 'string' ? req.query.attendee_id.trim() : '';
  // Nieuw: `email`-param voor de onboarding-tak. Maakt thread-ophaal mogelijk
  // voor mailers ZONDER klant-koppeling (mail-only studenten / leads). Wordt
  // genormaliseerd zodat alle downstream-vergelijkingen op lowercase werken.
  const emailParam = typeof req.query?.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  const moduleKey  = typeof req.query?.module === 'string' ? req.query.module.trim().toLowerCase() : '';
  const acct = MODULE_ACCOUNTS[moduleKey];
  if (!acct) return res.status(400).json({ error: "module moet 'onboarding' of 'events' zijn" });
  if (moduleKey === 'onboarding') {
    // Onboarding-pad: customer_id OF email is voldoende. Beide leeg → 400.
    // attendee_id wordt genegeerd (events-only).
    if (!UUID_RE.test(customerId) && !emailParam) {
      return res.status(400).json({ error: 'customer_id of email vereist voor onboarding' });
    }
  } else {
    // Events-pad: customer_id OF attendee_id volstaat — events-conversaties
    // hangen aan een attendee, niet altijd aan een (gekoppelde) klant.
    if (!UUID_RE.test(customerId) && !UUID_RE.test(attendeeId)) {
      return res.status(400).json({ error: 'customer_id of attendee_id (uuid) vereist voor events' });
    }
  }

  // RBAC fail-closed.
  if (!(await requirePermission(req, acct.permKey))) {
    return res.status(403).json({ error: `Geen rechten (${acct.permKey})` });
  }

  // Scope-enforcement (alleen onboarding-pad — events heeft geen mentor-
  // scope, identiek aan api/inbox-conversations-list.js dat events/finance
  // overslaat). Mentor met onboarding.view_own mag alleen mail van klanten
  // binnen z'n eigen toegewezen onboardings ophalen; admins/super_admin
  // (seesAll) blijven ongemoeid. Fail-closed: lege/onmatched lijst → 403.
  //
  // Email-only pad (geen customer_id, alleen email): voor mentor-scope eisen
  // we dat het opgegeven adres exact één klant matched ÉN dat die klant in
  // mentor.getMentorCustomerIds zit. Onbekend adres (geen customer_id match)
  // → 403 voor mentor; unscoped → toegestaan.
  if (moduleKey === 'onboarding') {
    const scope = await getOnboardingScope(req);
    if (!scope.seesAll) {
      if (!scope.seesOwn) {
        return res.status(403).json({ error: 'Geen onboarding-scope' });
      }
      const allowed = (await getMentorCustomerIds(scope.userId)).map(String);
      let effectiveCustomerId = UUID_RE.test(customerId) ? String(customerId) : null;
      if (!effectiveCustomerId && emailParam) {
        const { data: cust, error: custLookupErr } = await supabaseAdmin
          .from('customers')
          .select('id')
          .eq('email', emailParam)
          .maybeSingle();
        if (custLookupErr) {
          console.error('[inbox-emails-list] scope email-lookup:', custLookupErr.message);
        }
        if (cust?.id) effectiveCustomerId = String(cust.id);
      }
      if (!effectiveCustomerId || !allowed.includes(effectiveCustomerId)) {
        return res.status(403).json({ error: 'Klant buiten je scope' });
      }
    }
  }

  // E-mail-resolutie (module-bewust).
  //   onboarding → customers.email via customer_id (ongewijzigd).
  //   events     → event_attendees.email via attendee_id; fallback op
  //                customers.email via customer_id; geen rij/email → 200
  //                met lege thread (fail-soft).
  // De variabele customerEmail blijft de IMAP-search voeden (geen rename
  // nodig — semantisch is het 'het e-mailadres van de tegenpartij').
  let customerEmail = '';
  if (moduleKey === 'onboarding') {
    if (UUID_RE.test(customerId)) {
      const { data: customer, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id, email')
        .eq('id', customerId)
        .maybeSingle();
      if (custErr) return res.status(500).json({ error: 'customer lookup: ' + custErr.message });
      if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });
      customerEmail = customer.email ? String(customer.email).trim().toLowerCase() : '';
    } else if (emailParam) {
      // Email-only pad (mail-only student/lead): gebruik het opgegeven adres
      // rechtstreeks als thread-sleutel. Scope-check is hierboven al voldaan
      // voor mentors; admins/super_admin krijgen elk adres.
      customerEmail = emailParam;
    }
  } else {
    // events — attendee-first.
    if (UUID_RE.test(attendeeId)) {
      const { data: att, error: attErr } = await supabaseAdmin
        .from('event_attendees')
        .select('id, email')
        .eq('id', attendeeId)
        .maybeSingle();
      if (attErr) return res.status(500).json({ error: 'attendee lookup: ' + attErr.message });
      if (att?.email) customerEmail = String(att.email).trim().toLowerCase();
    }
    if (!customerEmail && UUID_RE.test(customerId)) {
      const { data: customer, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id, email')
        .eq('id', customerId)
        .maybeSingle();
      if (custErr) return res.status(500).json({ error: 'customer lookup: ' + custErr.message });
      if (customer?.email) customerEmail = String(customer.email).trim().toLowerCase();
    }
  }
  if (!customerEmail) {
    return res.status(200).json({ customer_email: '', items: [], count: 0 });
  }

  // IMAP.
  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST niet geconfigureerd' });
  const port = parseInt(IMAP_PORT || '993', 10);
  const pass = process.env[acct.passEnv];
  if (!pass) {
    return res.status(200).json({
      customer_email: customerEmail, items: [], count: 0,
      warning: `Wachtwoord (${acct.passEnv}) niet gezet; geen IMAP-fetch.`,
    });
  }

  const client = new ImapFlow({
    host:          IMAP_HOST,
    port,
    secure:        true,
    auth:          { user: acct.user, pass },
    logger:        false,
    socketTimeout: 9000,
  });

  const items = [];
  let warning = null;
  const fetchOpts = { envelope: true, uid: true, bodyParts: ['1'] };

  try {
    await client.connect();
    try {
      // INBOX → inbound.
      const inboxLock = await client.getMailboxLock('INBOX');
      try {
        const inboundMsgs = await searchAndFetch(client, { from: customerEmail }, fetchOpts);
        for (const m of inboundMsgs) items.push(parseMessage(m, acct.user, 'inbound'));
      } finally {
        inboxLock.release();
      }

      // Sent-map detecteren + outbound.
      let sentPath = null;
      try {
        const boxes = await client.list();
        sentPath = findSentMailbox(boxes);
      } catch (e) {
        warning = 'Mailbox-lijst niet ophaalbaar: ' + (e?.message || e);
      }
      if (sentPath) {
        try {
          const sentLock = await client.getMailboxLock(sentPath);
          try {
            const outboundMsgs = await searchAndFetch(client, { to: customerEmail }, fetchOpts);
            for (const m of outboundMsgs) items.push(parseMessage(m, sentPath, 'outbound'));
          } finally {
            sentLock.release();
          }
        } catch (e) {
          warning = `Sent-map (${sentPath}) niet leesbaar: ` + (e?.message || e);
        }
      } else if (!warning) {
        warning = 'Geen Sent-map gevonden (specialUse \\\\Sent of naam sent/verzonden ontbreekt).';
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  } catch (e) {
    // Hele IMAP-poging mislukt — fail-soft naar lege items + warning.
    console.error('[inbox-emails-list] IMAP failure:', e?.message || e);
    return res.status(200).json({
      customer_email: customerEmail, items: [], count: 0,
      warning: 'IMAP-fout: ' + (e?.message || String(e)),
    });
  }

  items.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const response = { customer_email: customerEmail, items, count: items.length };
  if (warning) response.warning = warning;
  return res.status(200).json(response);
}
