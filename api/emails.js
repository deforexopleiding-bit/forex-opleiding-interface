import { ImapFlow } from 'imapflow';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const { IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS } = process.env;

  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASS) {
    return res.status(500).json({
      error:
        'IMAP environment variables not configured. Set IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS in Vercel project settings (Settings → Environment Variables).'
    });
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: parseInt(IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
    socketTimeout: 9000
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const messages = [];
      for await (const msg of client.fetch(
        { since: sevenDaysAgo },
        { envelope: true, flags: true, uid: true }
      )) {
        messages.push(parseMessage(msg));
      }

      messages.sort((a, b) => new Date(b.date) - new Date(a.date));

      const todayMessages = messages.filter(
        (m) => new Date(m.date) >= startOfToday
      );

      const counters = {
        nieuweLead: todayMessages.filter((m) => m.category === 'Nieuwe Lead')
          .length,
        nieuweUitlegsessie: todayMessages.filter(
          (m) => m.category === 'Appointment'
        ).length,
        totaalVandaag: todayMessages.length
      };

      const byCategory = {
        'Nieuwe Lead': 0,
        Appointment: 0,
        Klantvraag: 0,
        Factuurvraag: 0,
        Overig: 0
      };
      messages.forEach((m) => {
        byCategory[m.category] = (byCategory[m.category] || 0) + 1;
      });

      return res.status(200).json({
        counters,
        byCategory,
        emails: messages.slice(0, 40),
        fetchedAt: new Date().toISOString()
      });
    } finally {
      lock.release();
    }
  } catch (err) {
    return res.status(500).json({
      error: `IMAP fout: ${err.message}`
    });
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}

function parseMessage(msg) {
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
  const category = categorize(subject, fromAddress);
  const aiReply = generateReply(category, fromName || fromAddress);

  return {
    uid: msg.uid,
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

function categorize(subject, fromAddress) {
  const s = (subject || '').toLowerCase();

  // Auto-bevestigingen van betaalproviders en no-reply afzenders → Overig.
  // Belangrijk: deze check staat VOOR de factuur/betaling-regel zodat ze
  // niet ten onrechte als Factuurvraag worden geteld.
  if (isAutomatedSender(fromAddress) || isPaymentConfirmation(subject)) {
    return 'Overig';
  }

  if (
    s.includes('uitlegsessie') ||
    s.includes('afspraak ingepland') ||
    s.includes('nieuwe afspraak') ||
    s.includes('appointment') ||
    s.includes('ingepland')
  ) {
    return 'Appointment';
  }
  if (
    s.includes('nieuwe lead') ||
    s.includes('new lead') ||
    s.includes('aanmelding') ||
    /\blead\b/.test(s)
  ) {
    return 'Nieuwe Lead';
  }
  if (
    s.includes('factuur') ||
    s.includes('invoice') ||
    s.includes('betaling') ||
    s.includes('payment')
  ) {
    return 'Factuurvraag';
  }
  if (
    s.includes('?') ||
    s.includes('vraag') ||
    s.includes('hulp') ||
    s.includes('probleem') ||
    s.includes('werkt niet') ||
    s.includes('support')
  ) {
    return 'Klantvraag';
  }
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
    case 'Klantvraag':
      return `${greeting}\n\nBedankt voor je bericht. We bekijken je vraag en komen zo spoedig mogelijk (uiterlijk binnen 1 werkdag) bij je terug met een uitgebreid antwoord.\n\n${signoff}`;
    case 'Factuurvraag':
      return `${greeting}\n\nBedankt voor je bericht over de factuur. We bekijken het direct en zorgen dat je vandaag nog uitsluitsel krijgt. Mocht het sneller moeten, dan ben je telefonisch ook welkom.\n\n${signoff}`;
    default:
      return `${greeting}\n\nBedankt voor je bericht. We hebben het in goede orde ontvangen en komen zo snel mogelijk bij je terug.\n\n${signoff}`;
  }
}
