import { ImapFlow } from 'imapflow';

// Houd deze lijst in sync met api/emails.js — dezelfde mailboxen,
// dezelfde env-vars voor de wachtwoorden.
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

  // Vercel parseert application/json automatisch, maar voor de zekerheid:
  const body = typeof req.body === 'string'
    ? JSON.parse(req.body || '{}')
    : (req.body || {});
  const { mailbox, uid, seen = true } = body; // seen=false → markeer als ongelezen (\Seen verwijderen)

  if (!mailbox || uid === undefined || uid === null || uid === '') {
    return res.status(400).json({
      error: 'Body moet "mailbox" en "uid" bevatten.'
    });
  }

  const account = ACCOUNTS.find((a) => a.user === mailbox);
  if (!account) {
    return res.status(400).json({ error: `Onbekende mailbox: ${mailbox}` });
  }

  const pass = process.env[account.passEnv];
  if (!pass) {
    return res.status(500).json({
      error: `Wachtwoord voor ${mailbox} is niet geconfigureerd (env var ${account.passEnv}).`
    });
  }

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) {
    return res.status(500).json({ error: 'IMAP_HOST is niet geconfigureerd.' });
  }

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
      // Zet/verwijder de \Seen flag via UID-adressering. ImapFlow accepteert
      // strings of numbers; we sturen string voor robuustheid.
      if (seen === false) {
        await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
      return res.status(200).json({ ok: true, seen: seen !== false });
    } finally {
      lock.release();
    }
  } catch (err) {
    return res.status(500).json({ error: `IMAP fout: ${err.message}` });
  } finally {
    try { await client.logout(); } catch {}
  }
}
