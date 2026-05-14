import { supabaseAdmin as supabase, verifyAdmin } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  try {
    // ── Laatste 20 sync-log entries (alle mailboxen) ──────────────────────
    const { data: logs, error: logErr } = await supabase
      .from('email_sync_log')
      .select('*')
      .order('completed_at', { ascending: false })
      .limit(20);

    if (logErr) throw new Error('sync_log ophalen mislukt: ' + logErr.message);

    // ── Meest recente sync-status per mailbox ─────────────────────────────
    const latestPerMailbox = {};
    for (const row of (logs || [])) {
      if (!latestPerMailbox[row.mailbox]) latestPerMailbox[row.mailbox] = row;
    }

    // ── Totaal gesynchroniseerde mails per mailbox ────────────────────────
    const { data: msgRows, error: msgErr } = await supabase
      .from('email_messages')
      .select('mailbox, category');

    if (msgErr) throw new Error('email_messages ophalen mislukt: ' + msgErr.message);

    const perMailbox = {};
    const catDist    = {};
    for (const r of (msgRows || [])) {
      perMailbox[r.mailbox] = (perMailbox[r.mailbox] || 0) + 1;
      catDist[r.category]   = (catDist[r.category]   || 0) + 1;
    }

    // ── Laatste sync-tijdstip (over alle mailboxen) ───────────────────────
    const lastSync = logs?.[0]?.completed_at || logs?.[0]?.started_at || null;

    // ── Eventuele recente fouten ──────────────────────────────────────────
    const recentErrors = (logs || [])
      .filter(l => l.status === 'error')
      .slice(0, 5)
      .map(l => ({ mailbox: l.mailbox, error: l.error_message, at: l.completed_at }));

    return res.status(200).json({
      ok:                     true,
      last_sync:              lastSync,
      totaal_gesynchroniseerd: (msgRows || []).length,
      per_mailbox:            perMailbox,
      categorie_verdeling:    catDist,
      laatste_sync_per_mailbox: latestPerMailbox,
      recente_fouten:         recentErrors,
      sync_log:               logs || [],
    });
  } catch (err) {
    console.error('[sync-status]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
