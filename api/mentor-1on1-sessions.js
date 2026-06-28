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
import { getMentorStudents } from './_lib/mentorStudents.js';

const FETCH_CAP = 3000;
// Voor session-numbering moeten ALLE 1-op-1 sessies van een student meekomen
// (Alpha is begrensd ~24 sessies). We pakken 2024-01-01 als harde ondergrens —
// breed genoeg om historische sessies te dekken zonder onbegrensde fetches.
const LOOKBACK_FROM_ISO = '2024-01-01T00:00:00Z';

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

    // Student-map opbouwen (bubble_student_id → { name, calls_1on1_total }).
    // Voor nummering en weergave. Fail-soft: bij Bubble-fout doorlopen we
    // zonder namen — de sessie-lijst valt terug op '—' en geen totaal.
    const studentMap = new Map();
    try {
      const { students } = await getMentorStudents(user.id);
      for (const s of (students || [])) {
        if (!s || !s.bubble_student_id) continue;
        studentMap.set(String(s.bubble_student_id), {
          name:              s.name || null,
          calls_1on1_total:  Number.isFinite(s.calls_1on1_total) ? Number(s.calls_1on1_total) : null,
        });
      }
    } catch (e) {
      console.warn('[mentor-1on1-sessions] getMentorStudents faalde, lijst zonder namen:', e?.message || e);
    }

    // Window: vanaf 2024-01-01 t/m +365d. Bubble's date-constraints zijn
    // strikt, dus we stretchen de randen vergelijkbaar met
    // coaching-earnings.js (greater-than/less-than).
    const fromMs = new Date(LOOKBACK_FROM_ISO).getTime();
    const toMs   = Date.now() + (365 * 24 * 60 * 60 * 1000);
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

    // Pre-pass: verzamel alle gekwalificeerde sessies (afgerond + geplande
    // toekomst) met hun member_user, zodat we daarna per student kunnen
    // nummeren (oplopend op starts_at).
    const qualified = []; // { id, starts_at, isoMs, done, member_user }
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
      // planned-criterium identiek aan voorheen (toekomstige niet-afgeronde);
      // afgeronde sessies tellen sowieso mee in de nummering.
      if (!done && startMs < nowMs) continue;

      const memberRaw = readFirst(s, ['member_user']);
      const member_user = (memberRaw && String(memberRaw).trim()) ? String(memberRaw).trim() : null;

      qualified.push({ id, starts_at: iso, startMs, done, member_user });
    }

    // Nummering per student: groepeer op member_user, sorteer asc op starts_at,
    // index+1 = session_number. Sessies zonder member_user krijgen geen nummer
    // (die kunnen niet aan een student worden toegerekend).
    const sessionNumber = new Map(); // session-id → number
    {
      const byStudent = new Map();
      for (const q of qualified) {
        if (!q.member_user) continue;
        if (!byStudent.has(q.member_user)) byStudent.set(q.member_user, []);
        byStudent.get(q.member_user).push(q);
      }
      for (const list of byStudent.values()) {
        list.sort((a, b) => a.startMs - b.startMs);
        list.forEach((q, idx) => { sessionNumber.set(q.id, idx + 1); });
      }
    }

    const planned = [];
    const completed = [];
    for (const q of qualified) {
      const meta = q.member_user ? studentMap.get(q.member_user) : null;
      const student_name   = meta?.name || '—';
      const session_total  = meta?.calls_1on1_total ?? null;
      const session_number = q.member_user ? (sessionNumber.get(q.id) ?? null) : null;
      const base = {
        id:             q.id,
        starts_at:      q.starts_at,
        student_name,
        member_user:    q.member_user,
        session_number,
        session_total,
      };
      if (q.done) {
        completed.push({ ...base, amount: RATE_1ON1 });
      } else {
        planned.push(base);
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
