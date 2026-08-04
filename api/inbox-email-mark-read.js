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
  // ── STRATEGIE-WISSEL (2026-08-03 na Khalid-bug) ─────────────────────
  // Vroeger: IMAP-search { from: custEmail, unseen: true, since: SINCE_DATE }.
  // Twee failure-modes:
  //   1) SINCE_DATE (2026-01-01) sluit oudere mails uit — thread toonde ze
  //      wel maar mark-read miste ze
  //   2) 'from'-adres-match faalt als klant vanaf ander adres mailt dan
  //      customers.email (custEmail = klant-DB, IMAP-from = feitelijke afzender)
  //   3) 'unseen: true' skipt mails die al eens door mailclient zijn gezien
  //      maar door user als ongelezen zijn hersteld → thread telt 'em wel
  //
  // Nu: gebruik email_messages als authoritatieve bron. Alle rijen waar
  // customer_id = deze klant zijn ZICHTBAAR in de thread. Hun imap_uid +
  // mailbox is bekend. Pak die uids en STORE \Seen. Zo markeren we EXACT
  // wat in de thread staat, ongeacht datum / from-adres / prior-seen-state.
  const { data: emailRows, error: emErr } = await supabaseAdmin
    .from('email_messages')
    .select('mailbox, imap_uid')
    .eq('customer_id', customerId)
    .eq('mailbox', acct.user);  // scope op deze module-mailbox
  if (emErr) {
    console.error('[inbox-email-mark-read] email_messages lookup:', emErr.message);
    return res.status(200).json({
      ok: false, module: moduleRaw, email: custEmail, marked_count: 0,
      warning: 'email_messages lookup fail: ' + emErr.message,
    });
  }
  const uidsToMark = (emailRows || [])
    .map((r) => Number(r.imap_uid))
    .filter((u) => Number.isFinite(u) && u > 0);

  let markedCount = 0;
  let warning = null;
  const targetUids = uidsToMark.slice(0, 500); // response-size cap
  if (uidsToMark.length === 0) {
    // Geen mail-rijen voor deze klant → niks te markeren. Nog steeds cache
    // invalideren (misschien stond die op verouderde count).
    invalidateEmailUnreadForCustomer(moduleRaw, custEmail);
    return res.status(200).json({
      ok: true, module: moduleRaw, email: custEmail, marked_count: 0,
      debug: {
        source: 'email_messages (0 rows)',
        searched_mailbox: acct.user,
        customer_id: customerId,
        uids_from_db: [],
      },
    });
  }

  const client = new ImapFlow({
    host: IMAP_HOST, port, secure: true,
    auth: { user: acct.user, pass },
    logger: false, socketTimeout: 15000,
  });
  try {
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX');
      try {
        // STORE +FLAGS \Seen op alle uids (batch). imapflow accepteert
        // een array van UIDs; { uid: true } behandelt ze als UIDs (i.p.v.
        // sequence numbers). Mails die al \Seen zijn: STORE is idempotent
        // (no-op). Onbekende UIDs (bv. gedeletede mail) worden genegeerd.
        await client.messageFlagsAdd(uidsToMark, ['\\Seen'], { uid: true });
        markedCount = uidsToMark.length;
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
    // Debug-info: welke UIDs zijn uit email_messages gehaald voor deze klant
    // en zijn dus gemarkeerd. Bespaart een IMAP-inspectie als marked_count
    // niet matcht met wat gebruiker verwacht.
    debug: {
      source: 'email_messages (customer_id-scoped)',
      searched_mailbox: acct.user,
      customer_id: customerId,
      uids_from_db: targetUids,
      uid_count_db: uidsToMark.length,
    },
  });
}
