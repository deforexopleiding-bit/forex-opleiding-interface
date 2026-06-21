// api/mentor-recurring-save.js
//
// POST → insert of update mentor_recurring_items (vaste maandposten).
//
// Permission: mentor.payout.manage.
//
// Body:
//   { id?: uuid (zonder = insert; met = update),
//     mentor_user_id: uuid (verplicht bij insert; bij update genegeerd
//                          maar wel gevalideerd als aanwezig),
//     label: string (1..200),
//     amount_incl: number (>= 0),
//     active: bool (default true),
//     start_month?: 'YYYY-MM' | 'YYYY-MM-DD' | '' | null
//       — vanaf welke maand de post meetelt; leeg/ontbrekend = vanaf altijd
//       (NULL in DB). Wordt genormaliseerd naar 1e van de maand. }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// 'YYYY-MM' of 'YYYY-MM-DD' → 'YYYY-MM-01' (NULL als input leeg of ongeldig).
// Geeft false terug bij EXPLICIET ongeldige string (niet-leeg + niet-parsbaar)
// zodat de caller een 400 kan returnen i.p.v. stilzwijgend NULL te bewaren.
function normalizeStartMonth(v) {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  const s = v.trim();
  if (!s) return { ok: true, value: null };
  const m = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!m) return { ok: false };
  const y = Number(m[1]), mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return { ok: false };
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return { ok: false };
  return { ok: true, value: `${y}-${String(mo).padStart(2, '0')}-01` };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const id           = typeof body.id === 'string' ? body.id.trim() : '';
  const mentorUserId = typeof body.mentor_user_id === 'string' ? body.mentor_user_id.trim() : '';
  const label        = typeof body.label === 'string' ? body.label.trim() : '';
  const amountIncl   = round2(body.amount_incl);
  const active       = body.active === undefined ? true : !!body.active;
  const sm           = normalizeStartMonth(body.start_month);

  if (id && !UUID_RE.test(id))                       return res.status(400).json({ error: 'id (uuid) ongeldig' });
  if (mentorUserId && !UUID_RE.test(mentorUserId))   return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
  if (!label || label.length > 200)                  return res.status(400).json({ error: 'label vereist (1..200 chars)' });
  if (!Number.isFinite(amountIncl) || amountIncl < 0) return res.status(400).json({ error: 'amount_incl moet >= 0 zijn' });
  if (!sm.ok)                                         return res.status(400).json({ error: 'start_month moet YYYY-MM zijn (of leeg)' });

  try {
    if (id) {
      // UPDATE — mentor_user_id wordt NIET overschreven (eigenaarschap immutable).
      const { data, error } = await supabaseAdmin
        .from('mentor_recurring_items')
        .update({ label, amount_incl: amountIncl, active, start_month: sm.value })
        .eq('id', id)
        .select('id, mentor_user_id, label, amount_incl, active, start_month')
        .single();
      if (error) throw new Error('recurring update: ' + error.message);
      return res.status(200).json({ ok: true, item: data });
    } else {
      if (!mentorUserId) return res.status(400).json({ error: 'mentor_user_id vereist bij insert' });
      const { data, error } = await supabaseAdmin
        .from('mentor_recurring_items')
        .insert({
          mentor_user_id: mentorUserId,
          label,
          amount_incl   : amountIncl,
          active,
          start_month   : sm.value,
        })
        .select('id, mentor_user_id, label, amount_incl, active, start_month')
        .single();
      if (error) throw new Error('recurring insert: ' + error.message);
      return res.status(200).json({ ok: true, item: data });
    }
  } catch (e) {
    console.error('[mentor-recurring-save]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
