// api/email-status-update.js
//
// v2 E-mail Fase 2B — unified endpoint voor Vlag/Archief/Prullenbak/Herstel.
// Ook geschikt voor BULK-acties (accepteert ids[] array).
//
// Body (POST):
//   { ids: [rowId, ...],  action: 'flag'|'unflag'|'archive'|'trash'|'restore' }
//
// Effect per action:
//   flag     → email_messages.flagged = true
//   unflag   → email_messages.flagged = false
//   archive  → email_messages.status  = 'archived'
//   trash    → email_messages.status  = 'trashed'
//   restore  → email_messages.status  = 'inbox'
//
// IMAP-flags: best-effort. Voor 'flag'/'unflag' zetten we \Flagged;
// voor archive/trash NIET (dat is een DB-status; IMAP-copy/move is
// zwaar en niet nodig voor de v2-UI).
//
// Response:
//   { ok:true, updated:<int>, action, ids_processed, imap_errors:[..] }
//
// Runtime-detect: als schema-migratie 2026-08-15 nog niet is gedraaid
// (kolommen flagged/status ontbreken), returnt 503 met duidelijke error.
//
// Permission: email.module.access (basis) + email.reply.send (schrijf-scope).

import { ImapFlow } from 'imapflow';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ACTIONS = ['flag','unflag','archive','trash','restore'];
const IMAP_MAILBOXES = {
  'leads':         { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  'info':          { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  'partners':      { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  'administratie': { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
  'onboarding':    { user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING' },
  'events':        { user: 'events@deforexopleiding.nl',        passEnv: 'IMAP_PASS_EVENTS' },
  'welkom':        { user: 'welkom@deforexopleiding.nl',        passEnv: 'IMAP_PASS_WELKOM' },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'email.reply.send'))) {
    return res.status(403).json({ error: 'Geen rechten (email.reply.send)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  const action = String(body.action || '').toLowerCase();
  if (!ACTIONS.includes(action)) return res.status(400).json({ error: `action moet ${ACTIONS.join('|')} zijn` });
  if (ids.length === 0) return res.status(400).json({ error: 'ids[] verplicht' });
  if (ids.length > 500) return res.status(400).json({ error: 'max 500 ids per call' });

  // Runtime-detect: check of kolommen bestaan (fail-safe voor pre-migratie).
  try {
    const probe = await supabaseAdmin.from('email_messages').select('id, flagged, status').limit(1);
    if (probe.error) {
      const msg = probe.error.message || '';
      if (/column.*(flagged|status).*does not exist/i.test(msg)) {
        return res.status(503).json({
          error: 'Migratie 2026-08-15-email-v2-fase-2b.sql moet eerst gedraaid worden (kolommen flagged/status ontbreken).',
          migration_required: '2026-08-15-email-v2-fase-2b.sql',
        });
      }
    }
  } catch (e) { /* fall-through — poging tot update zal ook nog fail-safen */ }

  // Fetch de rijen voor IMAP-flag operatie (mailbox + imap_uid nodig).
  const { data: rows, error: fetchErr } = await supabaseAdmin
    .from('email_messages')
    .select('id, mailbox, imap_uid')
    .in('id', ids);
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!rows || rows.length === 0) return res.status(404).json({ error: 'Geen matches op ids' });

  // Bouw update-payload per action.
  const patch = {};
  if (action === 'flag')    patch.flagged = true;
  if (action === 'unflag')  patch.flagged = false;
  if (action === 'archive') patch.status  = 'archived';
  if (action === 'trash')   patch.status  = 'trashed';
  if (action === 'restore') patch.status  = 'inbox';

  const { data: updated, error: updErr, count } = await supabaseAdmin
    .from('email_messages')
    .update(patch)
    .in('id', ids)
    .select('id', { count: 'exact' });
  if (updErr) return res.status(500).json({ error: updErr.message });

  // IMAP \Flagged sync — alleen voor flag/unflag. Best-effort.
  const imapErrors = [];
  if (action === 'flag' || action === 'unflag') {
    // Groepeer per mailbox voor 1 IMAP-sessie per mailbox.
    const byMailbox = new Map();
    for (const r of rows) {
      if (!r.mailbox || r.imap_uid == null) continue;
      if (!byMailbox.has(r.mailbox)) byMailbox.set(r.mailbox, []);
      byMailbox.get(r.mailbox).push(String(r.imap_uid));
    }
    for (const [mailbox, uids] of byMailbox) {
      const acct = IMAP_MAILBOXES[mailbox];
      if (!acct) { imapErrors.push(`unknown mailbox ${mailbox}`); continue; }
      const pass = process.env[acct.passEnv];
      if (!pass) { imapErrors.push(`${mailbox}: pass env missing`); continue; }
      const { IMAP_HOST, IMAP_PORT } = process.env;
      if (!IMAP_HOST) { imapErrors.push('IMAP_HOST missing'); continue; }
      const client = new ImapFlow({
        host: IMAP_HOST, port: parseInt(IMAP_PORT || '993', 10), secure: true,
        auth: { user: acct.user, pass }, logger: false, socketTimeout: 9000,
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
          const uidArg = uids.join(',');
          if (action === 'flag') await client.messageFlagsAdd(uidArg, ['\\Flagged'], { uid: true });
          else                    await client.messageFlagsRemove(uidArg, ['\\Flagged'], { uid: true });
        } finally { lock.release(); }
      } catch (e) {
        imapErrors.push(`${mailbox}: ${e?.message || 'imap error'}`);
      } finally {
        try { await client.logout(); } catch {}
      }
    }
  }

  return res.status(200).json({
    ok: true,
    updated: Array.isArray(updated) ? updated.length : (count || 0),
    action,
    ids_processed: ids.length,
    imap_errors: imapErrors,
  });
}
