// api/inbox-email-mark-read.js
//
// POST → markeer alle ongelezen mails van een klant in de module-mailbox
// als gelezen (IMAP \Seen-flag zetten). Nodig omdat we vanuit het CRM
// werken: mails worden hier gelezen, niemand opent Outlook/webmail, dus
// zonder deze endpoint blijft de ongelezen-badge eeuwig staan.
//
// Body:
//   { customer_id: <uuid>, module: 'finance'|'onboarding'|'events' }
//
// Response 200:
//   { ok: true, module, email, marked_count, warning? }
//
// AUTH: identiek aan andere inbox-endpoints — per-module inbox.view.
//   finance    → finance.inbox.view
//   onboarding → onboarding.inbox.view
//   events     → events.inbox.view
//
// FAIL-SAFE:
//   * IMAP-error / missende env / geen mails → 200 met warning + marked_count=0
//   * Geen crash van de UI: caller mag doorlopen en badge lokaal op 0 zetten
//
// SIDE-EFFECT:
//   Na succesvolle mark-read invalideren we de betreffende klant uit de
//   email-unread-cache zodat de volgende getEmailUnreadByCustomerEmail-call
//   (inbox-conversations-list) direct 0 teruggeeft — badge verdwijnt zonder
//   te wachten op 60s-cache-expire.
//
// KOLOM-MAP module → mailbox (spiegelt email-unread-per-customer.js):
//   finance    → administratie@ (IMAP_PASS_ADMINISTRATIE)
//   onboarding → onboarding@    (IMAP_PASS_ONBOARDING)
//   events     → events@        (IMAP_PASS_EVENTS)

import { ImapFlow } from 'imapflow';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { invalidateEmailUnreadForCustomer } from './_lib/email-unread-per-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SINCE_DATE = new Date('2026-01-01T00:00:00Z');

// Zelfde map als in email-unread-per-customer.js — bewust NIET geëxporteerd
// via die module om de import-boundary klein te houden. Bij uitbreiding
// (nieuwe module) update BEIDE files.
const MODULE_ACCOUNTS = {
  finance:    { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE', permKey: 'finance.inbox.view' },
  onboarding: { user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING',    permKey: 'onboarding.inbox.view' },
  events:     { user: 'events@deforexopleiding.nl',        passEnv: 'IMAP_PASS_EVENTS',        permKey: 'events.inbox.view' },
};

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth-gate: user moet ingelogd zijn.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Body-parse.
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
  const moduleRaw  = typeof body.module === 'string' ? body.module.trim().toLowerCase() : '';
  if (!UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  }
  const acct = MODULE_ACCOUNTS[moduleRaw];
  if (!acct) {
    return res.status(400).json({
      error: `module moet ${Object.keys(MODULE_ACCOUNTS).join('|')} zijn`,
    });
  }

  // RBAC — dezelfde inbox.view-permissie als de conversations-list-endpoint.
  if (!(await requirePermission(req, acct.permKey))) {
    return res.status(403).json({ error: `Geen rechten (${acct.permKey})` });
  }

  // Customer lookup → email is de match-sleutel voor IMAP from_address.
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers')
    .select('id, email')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr) {
    console.error('[inbox-email-mark-read] customer lookup:', cErr.message);
    return res.status(500).json({ error: cErr.message });
  }
  if (!cust) return res.status(404).json({ error: 'customer_id niet gevonden' });
  const custEmail = normalizeEmail(cust.email);
  if (!custEmail) {
    // Klant zonder email-adres → niks te markeren. Nette 200 zodat UI kan
    // doorlopen (email-badge is voor deze klant sowieso 0).
    return res.status(200).json({
      ok: true, module: moduleRaw, email: null, marked_count: 0,
      warning: 'klant heeft geen email-adres',
    });
  }

  // IMAP-config.
  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) {
    return res.status(200).json({
      ok: false, module: moduleRaw, email: custEmail, marked_count: 0,
      warning: 'IMAP_HOST niet geconfigureerd',
    });
  }
  const pass = process.env[acct.passEnv];
  if (!pass) {
    return res.status(200).json({
      ok: false, module: moduleRaw, email: custEmail, marked_count: 0,
      warning: `${acct.passEnv} niet gezet`,
    });
  }
  const port = parseInt(IMAP_PORT || '993', 10);

  // IMAP-verbinding + STORE \Seen. Fail-safe wrapper zodat we nooit een
  // gebroken IMAP-sessie de UI laten crashen.
  const client = new ImapFlow({
    host: IMAP_HOST, port, secure: true,
    auth: { user: acct.user, pass },
    logger: false, socketTimeout: 15000,
  });
  let markedCount = 0;
  let warning = null;
  let foundUids = [];       // debug — welke UIDs matchten het zoekcriterium
  let searchedFrom = null;  // debug — welk from-adres is gezocht
  let searchedSince = null; // debug — welke sinds-datum
  try {
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        // Zoek alle unseen mails van deze afzender sinds SINCE_DATE.
        // imapflow search syntax: { from: '<email>', unseen: true, since: <Date> }
        searchedFrom  = custEmail;
        searchedSince = SINCE_DATE.toISOString();
        const uids = await client.search({
          from:   custEmail,
          unseen: true,
          since:  SINCE_DATE,
        });
        foundUids = Array.isArray(uids) ? uids.slice(0, 100) : []; // cap voor response-size
        if (Array.isArray(uids) && uids.length > 0) {
          // STORE +FLAGS \Seen op alle gevonden UIDs (batch).
          await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
          markedCount = uids.length;
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  } catch (e) {
    console.warn('[inbox-email-mark-read] IMAP fail:', e?.message || e);
    warning = 'IMAP-fout: ' + (e?.message || String(e));
  }

  // Cache-invalidate: wis de entry van deze klant uit de module-cache zodat
  // de volgende conv-list-refresh de nieuwe 0-teller ziet. Werkt óók als de
  // IMAP-call niet is gedaan (bv. missende env) — dan wist 'ie niets, geen
  // kwaad.
  try {
    invalidateEmailUnreadForCustomer(moduleRaw, custEmail);
  } catch (e) {
    // Niet-fataal; badge blijft dan even hangen tot cache-expire.
    console.warn('[inbox-email-mark-read] cache-invalidate fail:', e?.message);
  }

  return res.status(200).json({
    ok: warning ? false : true,
    module: moduleRaw,
    email: custEmail,
    marked_count: markedCount,
    ...(warning ? { warning } : {}),
    // Debug-info voor UI / dev-tools: welk criterium is gezocht, welke UIDs
    // zijn geraakt. Bespaart een IMAP-inspectie-ronde als je in productie
    // ziet dat marked_count=0 terwijl je wél mails verwacht.
    debug: {
      searched_from: searchedFrom,
      searched_since: searchedSince,
      searched_mailbox: acct.user,
      found_uids: foundUids,
      found_uid_count: foundUids.length,
    },
  });
}
