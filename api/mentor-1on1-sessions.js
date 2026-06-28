// api/mentor-1on1-sessions.js
//
// GET → per-sessie 1-op-1 lijst voor de ingelogde mentor (SELF-scope):
//   - planned   : isdone !== true  EN  starts_at >= nu        (oplopend)
//   - completed : isdone === true                              (aflopend)
// Bedoeld voor het "1-op-1 sessies"-blok op de Studenten-pagina.
//
// Read-only proxy op bubble.io. Geen DB-schrijfacties; geen migratie.
//
// RBAC (fail-closed):
//   mentor.module.access  — zelfde gate als de self-path in
//                           api/mentor-coaching-earnings.js.
//
// SELF-scope:
//   bubbleUserId wordt afgeleid van auth.uid() via team_members
//   (user_id + is_active=true), spiegel van mentor-coaching-earnings.js.
//   Geen bubble-koppeling → 200 met lege lijsten + warning.
//
// Bedragen:
//   Per afgeronde sessie het 1-op-1 per-sessie tarief uit
//   api/_lib/coaching-earnings.js (RATE_1ON1, momenteel €35 incl btw).
//   Daar veranderen we NIETS aan de berekening of money-flow; we hergebruiken
//   alleen de constante zodat dit endpoint nooit kan afdwalen van Financiën.
//
// Bubble-fetch:
//   object '1-1-session', Created By = bubbleUserId, learn_type1 = 'Alpha Program'.
//   Window: completed van laatste ~180 dagen + alle toekomstige planned, om
//   zowel "wat staat er nog" als "wat is recent gedaan" in één call te dekken
//   zonder een onbegrensde geschiedenis te trekken.
//
// Response 200:
//   { planned:[{id,starts_at}], completed:[{id,starts_at,amount}],
//     rate, currency:'EUR', counts:{planned,completed}, warning? }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleList } from './_lib/bubble.js';
import { RATE_1ON1 } from './_lib/coaching-earnings.js';

const FETCH_CAP = 3000;
const LOOKBACK_DAYS = 180;

function asBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'ja', '1'].includes(s)) return true;
    if (['false', 'no', 'nee', '0'].includes(s)) return false;
  }
  return !!v;
}

function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) {
    if (u[k] !== undefined) return u[k];
  }
  return undefined;
}

function pickOption(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const d = v.display || v.text || v.value || null;
    return d ? String(d).trim() || null : null;
  }
  return null;
}

function toIso(raw) {
  if (!raw) return null;
  const d = (typeof raw === 'number') ? new Date(raw) : new Date(String(raw));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

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

  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  try {
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('bubble_user_id, is_active')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);

    const emptyResp = {
      planned:   [],
      completed: [],
      rate:      RATE_1ON1,
      currency:  'EUR',
      counts:    { planned: 0, completed: 0 },
    };

    if (!tm?.bubble_user_id) {
      return res.status(200).json({
        ...emptyResp,
        warning: 'Geen Bubble-koppeling voor deze mentor (team_members.bubble_user_id leeg).',
      });
    }
    const bubbleUserId = tm.bubble_user_id;

    // Window: lookback ~180d t/m ver in de toekomst. Bubble's date-constraints
    // zijn strikt, dus we stretchen de randen vergelijkbaar met
    // coaching-earnings.js (greater-than/less-than).
    const now = Date.now();
    const fromMs = now - (LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const toMs   = now + (365 * 24 * 60 * 60 * 1000);
    const fromIsoStrict = new Date(fromMs - 1).toISOString();
    const toIsoStrict   = new Date(toMs + 1).toISOString();
    const dateConstraints = [
      { key: 'starting_date_date', constraint_type: 'greater than', value: fromIsoStrict },
      { key: 'starting_date_date', constraint_type: 'less than',    value: toIsoStrict   },
    ];
    const cbConstraint = { key: 'Created By', constraint_type: 'equals', value: bubbleUserId };

    // Eerst server-side Created-By + date proberen; bij falen fallback op
    // date-only (zoals coaching-earnings.js doet) en in JS attribueren.
    let rows = [];
    let warning = null;
    try {
      const { results } = await bubbleList(
        '1-1-session',
        [...dateConstraints, cbConstraint],
        { limit: FETCH_CAP },
      );
      rows = results || [];
    } catch (e) {
      console.warn('[mentor-1on1-sessions] cb+date faalde, fallback date-only:', e?.message || e);
      try {
        const { results } = await bubbleList(
          '1-1-session',
          dateConstraints,
          { limit: FETCH_CAP },
        );
        rows = results || [];
      } catch (e2) {
        console.warn('[mentor-1on1-sessions] date-only fetch faalde:', e2?.message || e2);
        rows = [];
        warning = 'Bubble-fetch mislukt; lijst kan onvolledig zijn.';
      }
    }

    const planned = [];
    const completed = [];
    const nowMs = Date.now();
    for (const s of rows) {
      const cb = readFirst(s, ['Created By', 'created_by']);
      if (!cb || String(cb) !== bubbleUserId) continue;

      const lt = pickOption(readFirst(s, ['learn_type1_option_os___learning_type']));
      if (lt !== 'Alpha Program') continue;

      const id  = readFirst(s, ['_id', 'id']);
      const sd  = readFirst(s, ['starting_date_date', 'starting date']);
      const iso = toIso(sd);
      if (!iso) continue;
      const startMs = new Date(iso).getTime();
      if (!Number.isFinite(startMs)) continue;

      const done = asBool(readFirst(s, ['isdone_boolean', 'isDone']));
      if (done) {
        completed.push({ id, starts_at: iso, amount: RATE_1ON1 });
      } else if (startMs >= nowMs) {
        planned.push({ id, starts_at: iso });
      }
    }

    planned.sort((a, b)   => String(a.starts_at).localeCompare(String(b.starts_at)));
    completed.sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)));

    const payload = {
      planned,
      completed,
      rate:     RATE_1ON1,
      currency: 'EUR',
      counts:   { planned: planned.length, completed: completed.length },
    };
    if (warning) payload.warning = warning;
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[mentor-1on1-sessions]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
