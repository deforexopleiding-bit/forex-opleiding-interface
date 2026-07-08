import { ImapFlow } from 'imapflow';
import { safeError } from './_lib/safe-error.js';

// Houd deze lijst in sync met api/emails.js — dezelfde mailboxen,
// dezelfde env-vars voor de wachtwoorden. onboarding@ is toegevoegd zodat
// de onboarding-inbox e-mail-bron de \Seen-vlag kan zetten na het
// openen van een afzender-thread (zie inbox-emails-list.js: ACCOUNTS).
const ACCOUNTS = [
  { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
  { user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING' }
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
  const { mailbox, uid, uids, seen = true } = body; // seen=false → markeer als ongelezen (\Seen verwijderen)

  // BACKWARD-COMPATIBLE: `uid` (enkele) blijft werken; `uids` (array) is
  // nieuw voor batch-marker uit de onboarding-inbox e-mail-thread.
  // Normaliseer naar één array.
  let uidList = [];
  if (Array.isArray(uids)) {
    uidList = uids.map((x) => String(x || '').trim()).filter(Boolean);
  } else if (uid !== undefined && uid !== null && uid !== '') {
    uidList = [String(uid).trim()].filter(Boolean);
  }

  if (!mailbox || uidList.length === 0) {
    return res.status(400).json({
      error: 'Body moet "mailbox" en "uid" of "uids" bevatten.'
    });
  }
  if (uidList.length > 500) {
    return res.status(400).json({ error: 'Maximaal 500 uids per call.' });
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
      // een comma-separated lijst of een UID-range; we sturen één call met
      // alle uids tegelijk zodat we geen N-keer roundtrip doen op de IMAP-
      // verbinding. Idempotent — reeds-gelezen markeren is een no-op.
      const uidArg = uidList.join(',');
      if (seen === false) {
        await client.messageFlagsRemove(uidArg, ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsAdd(uidArg, ['\\Seen'], { uid: true });
      }
      return res.status(200).json({ ok: true, seen: seen !== false, count: uidList.length });
    } finally {
      lock.release();
    }
  } catch (err) {
    return safeError(res, 500, err, 'Kon leesstatus niet bijwerken.');
  } finally {
    try { await client.logout(); } catch {}
  }
}
