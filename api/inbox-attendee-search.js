// api/inbox-attendee-search.js
// GET → typeahead-zoek voor het Inbox 'Koppel aanmelding'-modal.
// Permission: finance.inbox.send OF events.simone.use (zelfde OR-patroon als
//   het link-endpoint; iedereen die mag versturen moet ook kunnen koppelen).
//
// Bewust slank: geen tags / status-filter / sort-opties. Alleen wat de modal
// nodig heeft (naam + email + telefoon + event-context) in een resultaat-lijst.
//
// Query params:
//   q       string  zoektekst (case-insensitive ILIKE op first_name/last_name/
//                   email/phone). Multi-woord: AND tussen woorden,
//                   OR tussen kolommen. Minimaal 2 tekens.
//   limit   int     max resultaten, default 20, clamp [1..50].
//
// Response 200:
//   { results: [{
//       id, first_name, last_name, email, phone, status,
//       event_id, event_title, event_starts_at,
//     }, ...] }
//
// Sortering: created_at desc — recent aangemeld bovenaan.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  const hasFinanceSend = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse   = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  if (!hasFinanceSend && !hasSimoneUse) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send of events.simone.use)' });
  }

  const q = String(req.query.q || '').trim();
  const rawLimit = parseInt(req.query.limit, 10) || 20;
  const limit = Math.min(50, Math.max(1, rawLimit));

  if (q.length < 2) {
    return res.status(200).json({ results: [] });
  }

  try {
    let query = supabaseAdmin
      .from('event_attendees')
      .select('id, first_name, last_name, email, phone, status, event_id, created_at, events:event_id ( id, title, starts_at )')
      // Test-attendees uitsluiten — zelfde defensieve filter als events-attendees-list.
      .eq('is_test', false);

    const words = q.split(/\s+/).filter(Boolean);
    for (const w of words) {
      const safeW = w.replace(/[,()]/g, ' ');
      const pat = `%${safeW}%`;
      query = query.or(
        `first_name.ilike.${pat},last_name.ilike.${pat},email.ilike.${pat},phone.ilike.${pat}`
      );
    }

    query = query.order('created_at', { ascending: false }).limit(limit);

    const { data, error } = await query;
    if (error) {
      console.error('[inbox-attendee-search] query error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const results = (data || []).map((a) => ({
      id:              a.id,
      first_name:      a.first_name || null,
      last_name:       a.last_name  || null,
      email:           a.email      || null,
      phone:           a.phone      || null,
      status:          a.status     || null,
      event_id:        a.event_id   || null,
      event_title:     a.events?.title     || null,
      event_starts_at: a.events?.starts_at || null,
    }));

    return res.status(200).json({ results });
  } catch (e) {
    console.error('[inbox-attendee-search]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
