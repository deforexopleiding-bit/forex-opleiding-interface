// api/_lib/bubble-1on1.js
//
// Hergebruikbare classificatie van Bubble '1-1-session' records voor een
// gegeven mentor. **Spiegel** van de centrale logica in
// api/mentor-1on1-sessions.js — pas je iets in één bestand aan, hou het
// andere bestand op gelijke voet zodat mentor- en admin-side dezelfde
// 1-op-1 afleiding doen.
//
// Filters: Created By == mentorBubbleUserId, learn_type1 == 'Alpha Program'.
// Window: vanaf 2024-01-01 t/m +365d (ruim genoeg voor alle Alpha-sessies).
//
// Returnt drie Maps gekeyd op member_user (= bubble_user_id van de student):
//   - nextPlannedByMember       : eerstvolgende toekomstige planned-sessie (ISO).
//   - earliestCompletedByMember : vroegste afgeronde sessie (ISO).
//   - lastNoshowByMember        : laatste no-show (ISO).
// Plus qualified[] (voor callers die session-numbering willen).
//
// Fail-soft: bij Bubble-fout krijgen alle maps lege staat + warning-string.

import { bubbleList } from './bubble.js';

const FETCH_CAP = 3000;
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

export async function fetchOneOnOneForMentor(mentorBubbleUserId) {
  const empty = {
    qualified:                 [],
    nextPlannedByMember:       new Map(),
    earliestCompletedByMember: new Map(),
    lastNoshowByMember:        new Map(),
    warning:                   null,
  };
  if (!mentorBubbleUserId) {
    return { ...empty, warning: 'no-bubble-link' };
  }

  const nowMs = Date.now();
  const fromMs = new Date(LOOKBACK_FROM_ISO).getTime();
  const toMs   = Date.now() + (365 * 24 * 60 * 60 * 1000);
  const fromIsoStrict = new Date(fromMs - 1).toISOString();
  const toIsoStrict   = new Date(toMs + 1).toISOString();
  const dateConstraints = [
    { key: 'starting_date_date', constraint_type: 'greater than', value: fromIsoStrict },
    { key: 'starting_date_date', constraint_type: 'less than',    value: toIsoStrict   },
  ];
  const cbConstraint = { key: 'Created By', constraint_type: 'equals', value: mentorBubbleUserId };

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
    console.warn('[bubble-1on1] cb+date faalde, fallback date-only:', e?.message || e);
    try {
      const { results } = await bubbleList(
        '1-1-session',
        dateConstraints,
        { limit: FETCH_CAP },
      );
      rows = results || [];
    } catch (e2) {
      console.warn('[bubble-1on1] date-only fetch faalde:', e2?.message || e2);
      rows = [];
      warning = 'bubble-fetch-fail';
    }
  }

  const qualified = [];
  const lastNoshowByMember = new Map();
  for (const s of rows) {
    const cb = readFirst(s, ['Created By', 'created_by']);
    if (!cb || String(cb) !== mentorBubbleUserId) continue;

    const lt = pickOption(readFirst(s, ['learn_type1_option_os___learning_type']));
    if (lt !== 'Alpha Program') continue;

    const id  = readFirst(s, ['_id', 'id']);
    const sd  = readFirst(s, ['starting_date_date', 'starting date']);
    const iso = toIso(sd);
    if (!iso) continue;
    const startMs = new Date(iso).getTime();
    if (!Number.isFinite(startMs)) continue;

    const done    = asBool(readFirst(s, ['isdone_boolean', 'isDone']));
    const noshow  = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
    const memberRaw = readFirst(s, ['member_user']);
    const member_user = (memberRaw && String(memberRaw).trim()) ? String(memberRaw).trim() : null;

    if (noshow && member_user) {
      const prev = lastNoshowByMember.get(member_user);
      if (!prev || iso > prev) lastNoshowByMember.set(member_user, iso);
    }

    // Identieke planned-criterium als mentor-1on1-sessions.js — toekomst-niet-
    // afgeronde sessies + alle afgeronde sessies tellen mee.
    if (!done && startMs < nowMs) continue;
    qualified.push({ id, starts_at: iso, startMs, done, member_user });
  }

  const nextPlannedByMember       = new Map();
  const earliestCompletedByMember = new Map();
  for (const q of qualified) {
    if (!q.member_user) continue;
    if (q.done) {
      const prev = earliestCompletedByMember.get(q.member_user);
      if (!prev || q.starts_at < prev) earliestCompletedByMember.set(q.member_user, q.starts_at);
    } else if (q.startMs >= nowMs) {
      const prev = nextPlannedByMember.get(q.member_user);
      if (!prev || q.starts_at < prev) nextPlannedByMember.set(q.member_user, q.starts_at);
    }
  }

  return { qualified, nextPlannedByMember, earliestCompletedByMember, lastNoshowByMember, warning };
}
