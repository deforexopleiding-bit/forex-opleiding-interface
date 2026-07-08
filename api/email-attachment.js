import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { safeError } from './_lib/safe-error.js';

const ACCOUNTS = [
  { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' }
];

// Sanitiseer bestandsnaam: geen path-traversal
function safeFilename(name) {
  return String(name || 'bijlage').replace(/[/\\]/g, '_').replace(/\.\./g, '_').slice(0, 255);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed — use GET' });
  }

  const { mailbox, uid, index } = req.query;
  const attachIndex = parseInt(index || '0', 10);

  if (!mailbox || !uid) {
    return res.status(400).json({ error: 'Query parameters "mailbox" en "uid" zijn vereist.' });
  }
  if (isNaN(attachIndex) || attachIndex < 0 || attachIndex > 49) {
    return res.status(400).json({ error: 'Parameter "index" moet een getal zijn tussen 0 en 49.' });
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
    socketTimeout: 15000
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) {
        return res.status(404).json({ error: 'E-mail niet gevonden in postvak.' });
      }
      const parsed = await simpleParser(msg.source);

      const attachments = parsed.attachments || [];
      if (attachIndex >= attachments.length) {
        return res.status(404).json({ error: `Bijlage ${attachIndex} niet gevonden (mail heeft ${attachments.length} bijlage(n)).` });
      }

      const attachment = attachments[attachIndex];
      const filename   = safeFilename(attachment.filename);
      const contentType = attachment.contentType || 'application/octet-stream';
      const content    = attachment.content; // Buffer

      // ?disposition=inline → toon in browser (bijv. PDF afdrukken); default = download
      const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
      res.setHeader('Content-Length', content.length);
      return res.status(200).send(content);

    } finally {
      lock.release();
    }
  } catch (err) {
    return safeError(res, 500, err, 'Bijlage kon niet worden opgehaald.');
  } finally {
    try { await client.logout(); } catch {}
  }
}
