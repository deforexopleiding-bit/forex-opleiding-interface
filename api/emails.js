import { ImapFlow } from 'imapflow';
import { supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// Mapping mailbox → env variable that holds its IMAP password.
// To add another mailbox: add an entry here, set the password env var
// in Vercel (and locally in .env), then add the address as an option
// in modules/email.html.
const ACCOUNTS = [
  { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
  { user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING' },
  { user: 'events@deforexopleiding.nl',        passEnv: 'IMAP_PASS_EVENTS' }
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Security H2 — RBAC-gate. Lees-endpoint dat mailbox-content teruggeeft.
  const allowed = await requirePermission(req, 'email.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (email.module.access)' });

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) {
    return res.status(500).json({
      error: 'IMAP_HOST not configured. Set IMAP_HOST in Vercel project settings.'
    });
  }

  // Only fetch from accounts whose password is actually configured.
  // Missing credentials = silently skipped, so the dashboard keeps
  // working as you progressively add mailboxes.
  const enabledAccounts = ACCOUNTS.filter((a) => process.env[a.passEnv]);
  if (enabledAccounts.length === 0) {
    return res.status(500).json({
      error:
        'No IMAP accounts configured. Set at least one of: ' +
        ACCOUNTS.map((a) => a.passEnv).join(', ') +
        ' in Vercel project settings.'
    });
  }

  const earliestDate = new Date('2026-01-01T00:00:00.000Z');
  const port = parseInt(IMAP_PORT || '993', 10);

  // Fetch from each enabled mailbox in parallel — one slow account
  // shouldn't block the others, and Vercel's 10s function timeout
  // would be reached if we connected sequentially.
  const results = await Promise.allSettled(
    enabledAccounts.map((account) => fetchMailbox(IMAP_HOST, port, account, earliestDate))
  );

  const allMessages = [];
  const errors = [];
  results.forEach((r, idx) => {
    const account = enabledAccounts[idx];
    if (r.status === 'fulfilled') {
      allMessages.push(...r.value);
    } else {
      errors.push({
        mailbox: account.user,
        error: String(r.reason?.message || r.reason)
      });
    }
  });

  // If every mailbox failed, surface that as an error response.
  if (allMessages.length === 0 && errors.length > 0) {
    return res.status(500).json({
      error: 'Geen enkele mailbox kon worden uitgelezen.',
      errors
    });
  }

  allMessages.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Fase 3: JOIN met email_classifications voor effective category + requires_action.
  // Eén batch SELECT op alle uids; geen N+1. Bij DB-fout: response gaat door met
  // alleen IMAP-hardrule categorie + requires_action=false fallback.
  try {
    const uids = allMessages.map(m => m.uid).slice(0, 1000); // cap matches slice hieronder
    if (uids.length) {
      const { data: classifications, error: classErr } = await supabaseAdmin
        .from('email_classifications')
        .select('email_uid, category, requires_action, confidence, source, priority, reasoning, classified_at')
        .in('email_uid', uids);
      if (classErr) {
        console.warn('[emails.js] classifications batch select fout:', classErr.message);
      } else {
        const classMap = new Map((classifications || []).map(c => [c.email_uid, c]));
        for (const msg of allMessages) {
          const c = classMap.get(msg.uid);
          if (c) {
            // DB overschrijft IMAP-hardrule indien category bekend.
            if (c.category) msg.category = c.category;
            // requires_action: null/undefined in DB → false (geen actie tenzij gemarkeerd).
            msg.requires_action = c.requires_action === true;
            // Metadata voor frontend (debugging / confidence-dots / sentiment etc).
            msg.classification = {
              confidence:    c.confidence,
              source:        c.source,
              priority:      c.priority,
              reasoning:     c.reasoning,
              classified_at: c.classified_at,
            };
          } else {
            // Geen classifier-resultaat → consumer mag IMAP-category gebruiken,
            // requires_action defaultt op false (niet undefined; dashboard filter
            // matched exact === true).
            msg.requires_action = false;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[emails.js] classifications join exception:', e.message);
  }

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMessages = allMessages.filter((m) => new Date(m.date) >= startOfToday);

  const counters = {
    nieuweLead:         todayMessages.filter((m) => m.category === 'Nieuwe Lead').length,
    nieuweUitlegsessie: todayMessages.filter((m) => m.category === 'Appointment').length,
    eventAanmelding:    todayMessages.filter((m) => m.category === 'Event Aanmelding').length,
    totaalVandaag:      todayMessages.length
  };

  const byCategory = {
    'Nieuwe Lead': 0,
    Appointment: 0,
    'Event Aanmelding': 0,
    Klantvragen: 0,
    Partners: 0,
    Betaalbevestigingen: 0,
    'Openstaande facturen': 0,
    'Aankopen/betalingen': 0,
    Reclame: 0,
    Overig: 0
  };
  allMessages.forEach((m) => {
    byCategory[m.category] = (byCategory[m.category] || 0) + 1;
  });

  return res.status(200).json({
    counters,
    byCategory,
    emails: allMessages.slice(0, 1000),
    mailboxes: enabledAccounts.map((a) => a.user),
    errors: errors.length ? errors : undefined,
    fetchedAt: new Date().toISOString()
  });
}

async function fetchMailbox(host, port, account, earliestDate) {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: account.user, pass: process.env[account.passEnv] },
    logger: false,
    socketTimeout: 9000
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const messages = [];
      for await (const msg of client.fetch(
        { since: earliestDate },
        {
          envelope: true,
          flags: true,
          uid: true,
          headers: ['list-unsubscribe', 'precedence']
        }
      )) {
        messages.push(parseMessage(msg, account.user));
      }
      return messages;
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch {}
  }
}

function parseMessage(msg, mailbox) {
  const subject = msg.envelope?.subject || '(geen onderwerp)';
  const fromEntry = msg.envelope?.from?.[0];
  const fromName = fromEntry?.name || '';
  const fromAddress = fromEntry?.address || '';
  const fromText = fromName
    ? `${fromName} <${fromAddress}>`
    : fromAddress || 'Onbekend';
  const toEntry = msg.envelope?.to?.[0];
  const toAddress = toEntry?.address || '';
  const date = msg.envelope?.date
    ? new Date(msg.envelope.date).toISOString()
    : new Date().toISOString();

  // Headers we requested are returned as a Buffer (or string) of raw text.
  // Extract two bulk-mail signals: List-Unsubscribe (any presence) and
  // Precedence: bulk/list/junk.
  const headerText = msg.headers
    ? (typeof msg.headers === 'string' ? msg.headers : msg.headers.toString('utf8')).toLowerCase()
    : '';
  const headerInfo = {
    hasUnsubscribe: /^list-unsubscribe:/m.test(headerText),
    isBulk:         /^precedence:\s*(bulk|list|junk)/m.test(headerText)
  };

  const category = categorize(subject, fromAddress, headerInfo);
  const aiReply = generateReply(category, fromName || fromAddress);

  return {
    // Mailbox-prefixed UID so two mailboxes with the same numeric UID
    // don't collide in the frontend's decisions/state map.
    uid: `${mailbox}:${msg.uid}`,
    mailbox,
    subject,
    from: fromText,
    fromName: fromName || fromAddress.split('@')[0] || 'Onbekend',
    fromAddress,
    toAddress,
    date,
    category,
    aiReply,
    unread: !msg.flags?.has('\\Seen')
  };
}

function isAutomatedSender(fromAddress) {
  const f = (fromAddress || '').toLowerCase();
  if (!f) return false;
  // Specific payment provider / SaaS domains that send auto-confirmations.
  // Extend this list as new providers come into use.
  if (/@(mollie\.com|teamleader\.eu|stripe\.com|buckaroo\.nl|pay\.nl|paypal\.com)$/.test(f)) {
    return true;
  }
  // Common no-reply local parts
  const localPart = f.split('@')[0] || '';
  if (/^(no[-_.]?reply|donotreply|do[-_.]?not[-_.]?reply|noresponse)$/.test(localPart)) {
    return true;
  }
  return false;
}

function isPaymentConfirmation(subject) {
  const s = (subject || '').toLowerCase();
  return (
    s.includes('betaling ontvangen') ||
    s.includes('betaling bevestigd') ||
    s.includes('factuur voldaan') ||
    s.includes('bedankt voor je betaling') ||
    s.includes('bedankt voor uw betaling') ||
    s.includes('payment confirmed') ||
    s.includes('payment received') ||
    s.includes('thank you for your payment')
  );
}

function isMarketing(subject, fromAddress, headerInfo) {
  const s = (subject || '').toLowerCase();
  const f = (fromAddress || '').toLowerCase();

  // Sterkste signaal: List-Unsubscribe header is per RFC 2369 een
  // bulk-mail indicator → altijd Reclame.
  if (headerInfo && headerInfo.hasUnsubscribe) return true;

  // Marketing-trefwoorden in onderwerp.
  const subjectKeywords = [
    'aanbieding', 'korting', 'sale', 'newsletter', 'nieuwsbrief',
    'promotie', 'gratis', 'exclusief aanbod', 'beperkte tijd'
  ];
  if (subjectKeywords.some((k) => s.includes(k))) return true;

  // Marketing-achtige afzender + bulk-indicator (Precedence: bulk/list).
  // We vereisen de bulk-indicator om eenmalige transactionele noreply-mails
  // niet ten onrechte als reclame te markeren.
  const localPart = f.split('@')[0] || '';
  const senderHint =
    /^(noreply|no-reply|marketing|newsletter|news|info|nieuws|promo)$/.test(localPart) ||
    /^(noreply|no-reply|marketing|newsletter|news|info|nieuws|promo)[-._]/.test(localPart);
  if (senderHint && headerInfo && headerInfo.isBulk) return true;

  return false;
}

function categorize(subject, fromAddress, headerInfo) {
  const s = (subject || '').toLowerCase();

  // 1. Lead — gebaseerd op onderwerp, ongeacht afzender.
  if (
    s.includes('nieuwe lead') ||
    s.includes('new lead') ||
    /\blead(s)?\b/.test(s)
  ) {
    return 'Nieuwe Lead';
  }

  // 2. Event Aanmelding — eigen categorie voor seminar-/event-
  //    aanmeldingen. Deze check staat VOOR Appointment, anders zou
  //    "Aanmelding ingepland" als gewone afspraak worden geteld.
  if (
    s.includes('event aanmelding') ||
    s.includes('aanmelding') ||
    s.includes('gent')
  ) {
    return 'Event Aanmelding';
  }

  // 3. Appointment — alleen nog echte uitlegsessies / afspraken
  //    (Event Aanmelding is hierboven al afgevangen).
  if (
    s.includes('uitlegsessie') ||
    s.includes('ingepland') ||
    s.includes('appointment') ||
    s.includes('nieuwe afspraak') ||
    s.includes('afspraak ingepland')
  ) {
    return 'Appointment';
  }

  // 4. Specifieke betalingsbevestigingen → altijd Overig (vóór de
  //    generieke factuur-check, anders wint die).
  if (isPaymentConfirmation(subject)) {
    return 'Overig';
  }

  // 3. Factuur / betaling onderwerpen — afzender bepaalt of het een
  //    echte klantvraag is of een automatische bevestiging.
  if (
    s.includes('factuur') ||
    s.includes('invoice') ||
    s.includes('betaling') ||
    s.includes('payment')
  ) {
    if (isAutomatedSender(fromAddress)) return 'Overig';
    return 'Klantvragen';
  }

  // 5. Reclame / marketing.
  if (isMarketing(subject, fromAddress, headerInfo)) {
    return 'Reclame';
  }

  // Klantvraag-heuristiek (fallback voor klantvragen zonder factuur-context).
  if (
    s.includes('?') ||
    s.includes('vraag') ||
    s.includes('hulp') ||
    s.includes('probleem') ||
    s.includes('werkt niet') ||
    s.includes('support')
  ) {
    return 'Klantvragen';
  }

  // 6. Al het overige.
  return 'Overig';
}

function generateReply(category, name) {
  const greeting = `Beste ${name || 'daar'},`;
  const signoff = 'Met vriendelijke groet,\nTeam De Forex Opleiding';

  switch (category) {
    case 'Nieuwe Lead':
      return `${greeting}\n\nBedankt voor je interesse in De Forex Opleiding! Een van onze adviseurs neemt binnen 24 uur persoonlijk contact met je op om je situatie te bespreken en de juiste vervolgstappen te plannen.\n\nIn de tussentijd kun je alvast onze gratis introductievideo bekijken.\n\n${signoff}`;
    case 'Appointment':
      return `${greeting}\n\nBedankt voor de bevestiging — je uitlegsessie staat ingepland. Je ontvangt vlak voor de afspraak een herinnering met de toegangslink.\n\nMocht je voor die tijd nog vragen hebben, laat het gerust weten.\n\n${signoff}`;
    case 'Klantvragen':
      return `${greeting}\n\nBedankt voor je bericht. We bekijken je vraag en komen zo spoedig mogelijk (uiterlijk binnen 1 werkdag) bij je terug met een uitgebreid antwoord.\n\n${signoff}`;
    case 'Partners':
      return `${greeting}\n\nBedankt voor je bericht. We bekijken je voorstel en nemen zo spoedig mogelijk contact met je op.\n\n${signoff}`;
    default:
      return `${greeting}\n\nBedankt voor je bericht. We hebben het in goede orde ontvangen en komen zo snel mogelijk bij je terug.\n\n${signoff}`;
  }
}
