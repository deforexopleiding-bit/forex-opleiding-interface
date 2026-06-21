// api/bubble-mentors-list.js
// GET -> lijst bubble.io Users met role=mentor (voor admin picker).
//
// Permission: events.team_member.link (zelfde admin-gevoelige key als
// team-member-link-user, want we serveren externe identiteits-data die alleen
// de admin nodig heeft voor de koppel-actie).
//
// Query:
//   ?q=<string>  (optioneel — filter na fetch op naam/email substring, case-insensitive)
//
// Response 200: { mentors: [{ bubble_user_id, name, email }, ...] }
// 401 zonder user | 403 zonder permission | 503 als BUBBLE_* env-vars ontbreken |
// 502 als bubble-API een fout teruggeeft | 500 anderzijds.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleList, bubbleUserDisplay } from './_lib/bubble.js';

const HARD_CAP = 500;

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
  if (!(await requirePermission(req, 'events.team_member.link'))) {
    return res.status(403).json({ error: 'Geen rechten (events.team_member.link)' });
  }

  const q = typeof req.query?.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const debugKeys = req.query?.debug === 'keys';

  try {
    const constraints = [
      { key: 'role', constraint_type: 'equals', value: 'mentor' },
    ];
    const { results } = await bubbleList('user', constraints, { limit: HARD_CAP });

    // Tijdelijke debug-tak: KEYS-ONLY uitvoer zodat we de echte Bubble-shape
    // kunnen zien zonder namen/e-mails/IDs te lekken. Admin-gated via dezelfde
    // permission als de reguliere lijst (events.team_member.link).
    if (debugKeys) {
      const sample = (results && results[0]) || null;
      return res.status(200).json({
        debug: {
          count       : Array.isArray(results) ? results.length : 0,
          sampleKeys  : sample ? Object.keys(sample) : [],
          authShape   : (sample && sample.authentication) ? Object.keys(sample.authentication) : null,
          emailNested : !!(sample && sample.authentication && sample.authentication.email),
        },
      });
    }

    let mentors = (results || []).map((u) => {
      const { name, email } = bubbleUserDisplay(u);
      return {
        bubble_user_id: String(u._id || ''),
        name,
        email,
      };
    }).filter((m) => m.bubble_user_id);

    if (q) {
      mentors = mentors.filter((m) => {
        const n = (m.name  || '').toLowerCase();
        const e = (m.email || '').toLowerCase();
        return n.includes(q) || e.includes(q);
      });
    }

    mentors.sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));

    return res.status(200).json({ mentors });
  } catch (e) {
    console.error('[bubble-mentors-list]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_')) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
