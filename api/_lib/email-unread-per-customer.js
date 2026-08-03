// api/_lib/email-unread-per-customer.js
//
// Levert per klant het aantal ongelezen e-mails in de INBOX van de module-
// mailbox. Bedoeld voor inbox-conversations-list.js zodat de gesprekken-tab
// een ongelezen-badge kan tonen (zelfde UX als whatsapp_conversations.unread_count).
//
// ONTWERP:
//   * IMAP is de AUTORITATIEVE bron van waarheid — wij zetten geen \Seen-
//     flags vanuit ons systeem. Als een collega een mail als gelezen markt
//     in de mailclient (Strato Webmail / Outlook), zien wij dat bij de
//     volgende fetch. Geen DB-persist, geen kolom-migratie, geen sync-code.
//   * Cache TTL 60s in-memory per module — voorkomt dat elke conv-list-
//     refresh een verse IMAP-fetch triggert (IMAP kost ~1-3s).
//   * Fail-safe: bij IMAP-error / geen wachtwoord / onbekende module returnt
//     de helper een lege Map + warning. Caller mag doorlopen zonder badge.
//
// GEBRUIKT DOOR:
//   * api/inbox-conversations-list.js (email_unread_count per row)
//
// FAIL-SAFE contract:
//   Returnt altijd { unreadByEmail: Map<lowercase_email, number>, warning?: string }.
//   Nooit throw — caller kan zonder guards de Map.get()-lookup doen.

import { ImapFlow } from 'imapflow';

const CACHE_TTL_MS = 60 * 1000;
const SINCE_DATE = new Date('2026-01-01T00:00:00Z');

// Module → { mailbox-user, env-var-naam voor wachtwoord }.
// finance-inbox = administratie@ (dunning-mails komen daar binnen).
// Uitbreidbaar: nieuwe modules bijzetten met eigen mailbox.
const MODULE_ACCOUNTS = {
  finance:    { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
  onboarding: { user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING' },
  events:     { user: 'events@deforexopleiding.nl',        passEnv: 'IMAP_PASS_EVENTS' },
};

// In-memory cache per module: { fetchedAt, unreadByEmail }.
const _cache = new Map();

/**
 * Wis de cache. Gebruikt door tests + optioneel als iemand net
 * mailboxen heeft opgeschoond.
 */
export function resetEmailUnreadCache() {
  _cache.clear();
}

/**
 * Normaliseer email voor case-insensitive match met customers.email.
 */
function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Fetch alle inbox-mails van de module-mailbox, tel unread per from_address.
 * Fail-safe: bij fout returnt lege Map + warning. Nooit throw.
 *
 * @param {object} args
 * @param {string} args.module              'finance' | 'onboarding' | 'events'
 * @param {object} [args.imapFlowFactory]   optioneel voor tests: () => new ImapFlow(...)
 * @returns {Promise<{ unreadByEmail: Map<string,number>, warning?: string }>}
 */
async function fetchUnreadFromImap({ module, imapFlowFactory }) {
  const acct = MODULE_ACCOUNTS[module];
  if (!acct) {
    return { unreadByEmail: new Map(), warning: `onbekende module '${module}'` };
  }
  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) {
    return { unreadByEmail: new Map(), warning: 'IMAP_HOST niet geconfigureerd' };
  }
  const pass = process.env[acct.passEnv];
  if (!pass) {
    return { unreadByEmail: new Map(), warning: `${acct.passEnv} niet gezet — geen IMAP-fetch` };
  }
  const port = parseInt(IMAP_PORT || '993', 10);

  const unreadByEmail = new Map();
  const client = imapFlowFactory
    ? imapFlowFactory({ IMAP_HOST, port, user: acct.user, pass })
    : new ImapFlow({
        host: IMAP_HOST, port, secure: true,
        auth: { user: acct.user, pass },
        logger: false, socketTimeout: 9000,
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
          if (msg.flags?.has('\\Seen')) continue; // alleen ongelezen tellen
          const fromAddr = normalizeEmail(msg.envelope?.from?.[0]?.address || '');
          if (!fromAddr) continue;
          unreadByEmail.set(fromAddr, (unreadByEmail.get(fromAddr) || 0) + 1);
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
    return { unreadByEmail };
  } catch (e) {
    return {
      unreadByEmail: new Map(),
      warning: 'IMAP-fout: ' + (e?.message || String(e)),
    };
  }
}

/**
 * Publieke API — cached wrapper rond fetchUnreadFromImap. Werkt per module;
 * dezelfde module binnen TTL retourneert cache-hit zonder IMAP-fetch.
 *
 * @param {object} args
 * @param {string} args.module              module-key (finance/onboarding/events)
 * @param {string[]} [args.filterEmails]    optioneel: filter Map naar alleen deze
 *                                          adressen (case-insensitive). Bespaart
 *                                          memory bij grote inboxen — Map wordt
 *                                          pas gefilterd na de cache-hit.
 * @param {object} [args.imapFlowFactory]   test-injectie
 * @returns {Promise<{ unreadByEmail: Map<string,number>, warning?: string,
 *                     cached: boolean }>}
 */
export async function getEmailUnreadByCustomerEmail({ module, filterEmails, imapFlowFactory }) {
  const now = Date.now();
  const cached = _cache.get(module);
  let result;
  let wasCached = false;
  if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    result = { unreadByEmail: cached.unreadByEmail, warning: cached.warning };
    wasCached = true;
  } else {
    result = await fetchUnreadFromImap({ module, imapFlowFactory });
    // Cache óók bij warning (bv. missende env) zodat we niet elke request
    // opnieuw dezelfde failing IMAP-connect doen.
    _cache.set(module, {
      fetchedAt:      now,
      unreadByEmail:  result.unreadByEmail,
      warning:        result.warning,
    });
  }

  // Optionele filter — beperkt Map tot alleen de gevraagde adressen.
  if (Array.isArray(filterEmails) && filterEmails.length > 0) {
    const wantedSet = new Set(filterEmails.map(normalizeEmail).filter(Boolean));
    const filtered = new Map();
    for (const [email, count] of result.unreadByEmail.entries()) {
      if (wantedSet.has(email)) filtered.set(email, count);
    }
    return {
      unreadByEmail: filtered,
      warning:       result.warning,
      cached:        wasCached,
    };
  }

  return {
    unreadByEmail: result.unreadByEmail,
    warning:       result.warning,
    cached:        wasCached,
  };
}
