import { ImapFlow } from 'imapflow';
import { safeError } from './_lib/safe-error.js';
import { supabaseAdmin } from './supabase.js';
import { requireCrmStaff } from './_lib/crm-roles.js';

// v2 email-round: mailbox-full-address → short-label voor email_messages.mailbox
// (die kolom bevat 'info' / 'leads' / etc, zoals sync-emails.js schrijft).
function mailboxSlug(mailbox) {
  const s = String(mailbox || '').trim().toLowerCase();
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

// Houd deze lijst in sync met api/emails.js — dezelfde mailboxen,
// dezelfde env-vars voor de wachtwoorden. onboarding@ is toegevoegd zodat
// de onboarding-inbox e-mail-bron de \Seen-vlag kan zetten na het
// openen van een afzender-thread (zie inbox-emails-list.js: ACCOUNTS).
const ACCOUNTS = [
  { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
  { user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING' },
  { user: 'events@deforexopleiding.nl',        passEnv: 'IMAP_PASS_EVENTS' },
  { user: 'welkom@deforexopleiding.nl',        passEnv: 'IMAP_PASS_WELKOM' }
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  // Dit endpoint zette IMAP-vlaggen zonder enige auth-check. Nu een expliciete
  // rolpoort, dezelfde als public.is_crm_staff() in RLS — een geldig JWT alleen
  // is niet genoeg, want elk auto-aangemaakt viewer/student-account heeft er een.
  const auth = await requireCrmStaff(req);
  if (!auth) return res.status(403).json({ error: 'Toegang geweigerd. CRM-rol vereist.' });

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
      // v2 email-round: mirror de \Seen flag naar Supabase (email_messages.is_read)
      // zodat de UI-status persisteert. Sync-emails.js fetcht alleen NIEUWE UIDs
      // (from lastUid+1), dus IMAP-flags op oude rijen worden nooit her-gelezen —
      // zonder deze DB-write toont refetch de mail weer als 'ongelezen'.
      // Fail-soft: als de DB-write faalt, log en return alsnog ok (IMAP is
      // authoritative; UI-refetch corrigeert bij volgende sync).
      try {
        const slug = mailboxSlug(mailbox);
        const uidNums = uidList.map((u) => Number(u)).filter((n) => Number.isFinite(n));
        if (uidNums.length) {
          const { error: upErr } = await supabaseAdmin
            .from('email_messages')
            .update({ is_read: seen !== false })
            .eq('mailbox', slug)
            .in('imap_uid', uidNums);
          if (upErr) console.warn('[mark-read] DB is_read update:', upErr.message);
        }
      } catch (dbErr) {
        console.warn('[mark-read] DB is_read update threw:', dbErr?.message || dbErr);
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
