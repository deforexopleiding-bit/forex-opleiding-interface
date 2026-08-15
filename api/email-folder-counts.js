// api/email-folder-counts.js
//
// v2 E-mail Fase 2B — teller per map voor de rail (badge-counts).
//
// GET /api/email-folder-counts[?mailbox=<slug>]
//
// Response:
//   { inbox, unread, flag, draft, sent, archive, trash, migration_ready }
//   migration_ready=false → kolommen flagged/status ontbreken; flag/archive/
//   trash zijn dan 0 en de UI toont de badges als "wacht op migratie".
//
// Permission: email.module.access.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function normMailbox(m) {
  if (!m) return null;
  const slug = String(m).trim().toLowerCase().split('@')[0];
  return ['leads','info','partners','administratie','onboarding','events','welkom'].includes(slug)
    ? slug : null;
}

async function countExact(qb) {
  const { count, error } = await qb;
  if (error) return { n: 0, err: error };
  return { n: Number(count || 0), err: null };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'email.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
  }

  const mailbox = normMailbox(req.query?.mailbox);

  // Migration-detect via probe.
  let migrationReady = true;
  try {
    const probe = await supabaseAdmin.from('email_messages').select('flagged, status').limit(1);
    if (probe.error && /column.*(flagged|status).*does not exist/i.test(probe.error.message || '')) {
      migrationReady = false;
    }
  } catch (_) { migrationReady = false; }

  const base = () => {
    let q = supabaseAdmin.from('email_messages').select('id', { count: 'exact', head: true });
    if (mailbox) q = q.eq('mailbox', mailbox);
    return q;
  };
  const drafts = () => {
    // email_drafts is user-scoped; hier tellen we alleen de eigen gebruiker.
    return supabaseAdmin.from('email_drafts').select('id', { count: 'exact', head: true }).eq('user_id', user.id);
  };
  const sent = () => {
    let q = supabaseAdmin.from('email_replies').select('id', { count: 'exact', head: true });
    if (mailbox) q = q.eq('from_address', `${mailbox}@deforexopleiding.nl`);
    return q;
  };

  try {
    // Bij niet-migreerde omgeving: alleen inbox/unread/sent/draft; rest = 0.
    const [inbox, unread, sentR] = await Promise.all([
      countExact(migrationReady ? base().eq('status', 'inbox') : base()),
      countExact(migrationReady ? base().eq('status', 'inbox').eq('is_read', false) : base().eq('is_read', false)),
      countExact(sent()),
    ]);
    let flag = { n: 0 }, archive = { n: 0 }, trash = { n: 0 };
    if (migrationReady) {
      [flag, archive, trash] = await Promise.all([
        countExact(base().eq('flagged', true).eq('status', 'inbox')),
        countExact(base().eq('status', 'archived')),
        countExact(base().eq('status', 'trashed')),
      ]);
    }
    // Drafts tabel apart proberen — als hij niet bestaat, tel 0.
    let draft = { n: 0 };
    try {
      const dr = await countExact(drafts());
      if (!dr.err) draft = dr;
    } catch (_) { /* email_drafts ontbreekt; 0 */ }

    return res.status(200).json({
      inbox:   inbox.n,
      unread:  unread.n,
      flag:    flag.n,
      draft:   draft.n,
      sent:    sentR.n,
      archive: archive.n,
      trash:   trash.n,
      migration_ready: migrationReady,
      mailbox_filter: mailbox,
    });
  } catch (e) {
    console.error('[email-folder-counts]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
