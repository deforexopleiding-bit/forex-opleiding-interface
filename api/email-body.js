import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const ACCOUNTS = [
  { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' }
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  const body = typeof req.body === 'string'
    ? JSON.parse(req.body || '{}')
    : (req.body || {});
  const { mailbox, uid } = body;

  if (!mailbox || uid === undefined || uid === null || uid === '') {
    return res.status(400).json({ error: 'Body moet "mailbox" en "uid" bevatten.' });
  }

  const account = ACCOUNTS.find((a) => a.user === mailbox);
  if (!account) return res.status(400).json({ error: `Onbekende mailbox: ${mailbox}` });

  const pass = process.env[account.passEnv];
  if (!pass) {
    return res.status(500).json({
      error: `Wachtwoord voor ${mailbox} is niet geconfigureerd (env var ${account.passEnv}).`
    });
  }

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST is niet geconfigureerd.' });

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: parseInt(IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: account.user, pass },
    logger: false,
    socketTimeout: 9000
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
      if (!msg || !msg.source) {
        return res.status(404).json({ error: 'E-mail niet gevonden in postvak.' });
      }
      const parsed = await simpleParser(msg.source);

      // Plain-text bij voorkeur (veilig en beknopt). Als alleen HTML
      // beschikbaar is gebruiken we mailparser's textAsHtml-fallback,
      // omgezet naar plain text via een eenvoudige strip — voor nu
      // tonen we geen rauwe HTML in de UI om injectie-risico te vermijden.
      let text = parsed.text || '';
      if (!text && parsed.html) {
        text = String(parsed.html)
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      const fromEntry = parsed.from?.value?.[0];
      const toEntries = parsed.to?.value || [];

      return res.status(200).json({
        subject: parsed.subject || '',
        from: fromEntry
          ? (fromEntry.name ? `${fromEntry.name} <${fromEntry.address}>` : fromEntry.address)
          : (parsed.from?.text || ''),
        to: toEntries.length
          ? toEntries.map((t) => t.name ? `${t.name} <${t.address}>` : t.address).join(', ')
          : (parsed.to?.text || ''),
        cc: parsed.cc?.text || '',
        date: parsed.date ? new Date(parsed.date).toISOString() : null,
        text,
        hasHtml: Boolean(parsed.html)
      });
    } finally {
      lock.release();
    }
  } catch (err) {
    return res.status(500).json({ error: `IMAP fout: ${err.message}` });
  } finally {
    try { await client.logout(); } catch {}
  }
}
