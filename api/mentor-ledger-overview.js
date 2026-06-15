// api/mentor-ledger-overview.js
//
// GET -> totalen + per-event + per-mentor breakdown van het mentor-grootboek.
//
// Permission: mentor.ledger.view (nieuwe key).
// RBAC-gedrag:
//   - manager+ (admin/super_admin/manager): ziet alles, optioneel filter op
//     ?event_id of ?mentor_user_id
//   - rol 'mentor': forced filter op mentor_user_id = auth.uid() (eigen rijen)
//
// Query (allemaal optioneel):
//   ?event_id=<uuid>        — filter op event
//   ?mentor_user_id=<uuid>  — filter op mentor (alleen manager+ mag een
//                              ander mentor_user_id opgeven)
//
// Response 200:
//   {
//     ok: true,
//     scope: 'all'|'self',
//     totals: { omzet, bonuspot, uitgaven, netto },
//     byStatus: { pending, wachten_op_betaling, vrijgegeven, geannuleerd, uitbetaald },
//     byEvent:  [{ event_id, event_title, starts_at, omzet, bonuspot, uitgaven, netto,
//                  per_status: {...} }],
//     byMentor: [{ mentor_user_id, mentor_email, mentor_name,
//                  saldo, per_status: {...}, meegenomen_min_saldo }]
//   }
//
// saldo = sum(bonus.amount WHERE status='vrijgegeven') - sum(|uitgave.amount|)
// meegenomen_min_saldo = max(0, -saldo) — het 'gat' dat een mentor naar de
// volgende ronde moet meenemen voordat 'ie weer netto bonus krijgt.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGER_ROLES = new Set(['super_admin', 'admin', 'manager']);
const STATUSES = ['pending', 'wachten_op_betaling', 'vrijgegeven', 'geannuleerd', 'uitbetaald'];

function round2(n) { return Math.round(Number(n) * 100) / 100; }
function emptyStatus() {
  const o = {};
  for (const s of STATUSES) o[s] = 0;
  return o;
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
  if (!(await requirePermission(req, 'mentor.ledger.view'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.ledger.view)' });
  }

  // Bepaal rol — mentor mag alleen eigen rijen zien
  let role = null;
  try {
    const { data: prof } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    role = prof?.role || null;
  } catch (e) {
    console.error('[mentor-ledger-overview] profile fetch:', e?.message || e);
  }
  const isManager = MANAGER_ROLES.has(role);
  const isMentor = role === 'mentor';
  if (!isManager && !isMentor) {
    return res.status(403).json({ error: 'Geen rol-toegang' });
  }

  // Query-params
  const qEventId  = req.query?.event_id  ? String(req.query.event_id).trim()  : null;
  const qMentorId = req.query?.mentor_user_id ? String(req.query.mentor_user_id).trim() : null;
  if (qEventId  && !UUID_RE.test(qEventId))  return res.status(400).json({ error: 'event_id ongeldig' });
  if (qMentorId && !UUID_RE.test(qMentorId)) return res.status(400).json({ error: 'mentor_user_id ongeldig' });

  // Forced filter voor mentor-rol
  const effectiveMentorId = isMentor ? user.id : qMentorId;
  const scope = isMentor ? 'self' : 'all';

  try {
    // ── Laad ledger-entries ────────────────────────────────────────────────
    let q = supabaseAdmin
      .from('mentor_ledger_entries')
      .select('id, mentor_user_id, event_id, entry_type, basis, amount, status, attendee_id, customer_id')
      .limit(5000);
    if (qEventId)         q = q.eq('event_id', qEventId);
    if (effectiveMentorId) q = q.eq('mentor_user_id', effectiveMentorId);
    const { data: entries, error: entErr } = await q;
    if (entErr) throw new Error('ledger fetch: ' + entErr.message);
    const rows = entries || [];

    // ── Globale totals + byStatus ──────────────────────────────────────────
    const totals = { omzet: 0, bonuspot: 0, uitgaven: 0, netto: 0 };
    const byStatus = emptyStatus();
    for (const r of rows) {
      const amount = Number(r.amount) || 0;
      if (STATUSES.includes(r.status)) byStatus[r.status] += amount;
      if (r.entry_type === 'bonus') {
        totals.omzet    += Number(r.basis) || 0;
        totals.bonuspot += amount;
      } else if (r.entry_type === 'uitgave') {
        totals.uitgaven += Math.abs(amount);
      }
    }
    totals.netto = totals.bonuspot - totals.uitgaven;
    for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
    for (const s of STATUSES) byStatus[s] = round2(byStatus[s]);

    // ── byEvent ────────────────────────────────────────────────────────────
    const eventIds = [...new Set(rows.map((r) => r.event_id).filter(Boolean))];
    let eventMap = new Map();
    if (eventIds.length > 0) {
      const { data: evs } = await supabaseAdmin
        .from('events')
        .select('id, title, starts_at')
        .in('id', eventIds);
      for (const e of evs || []) eventMap.set(e.id, e);
    }
    const evAgg = new Map();
    for (const r of rows) {
      const eId = r.event_id;
      if (!evAgg.has(eId)) {
        evAgg.set(eId, {
          event_id   : eId,
          event_title: eventMap.get(eId)?.title || null,
          starts_at  : eventMap.get(eId)?.starts_at || null,
          omzet      : 0, bonuspot: 0, uitgaven: 0, netto: 0,
          per_status : emptyStatus(),
        });
      }
      const cell = evAgg.get(eId);
      const amount = Number(r.amount) || 0;
      if (STATUSES.includes(r.status)) cell.per_status[r.status] += amount;
      if (r.entry_type === 'bonus') {
        cell.omzet    += Number(r.basis) || 0;
        cell.bonuspot += amount;
      } else if (r.entry_type === 'uitgave') {
        cell.uitgaven += Math.abs(amount);
      }
    }
    const byEvent = Array.from(evAgg.values())
      .map((c) => {
        c.netto = c.bonuspot - c.uitgaven;
        for (const k of ['omzet','bonuspot','uitgaven','netto']) c[k] = round2(c[k]);
        for (const s of STATUSES) c.per_status[s] = round2(c.per_status[s]);
        return c;
      })
      .sort((a, b) => (b.starts_at || '').localeCompare(a.starts_at || ''));

    // ── byMentor ───────────────────────────────────────────────────────────
    const mentorIds = [...new Set(rows.map((r) => r.mentor_user_id).filter(Boolean))];
    let mentorMap = new Map();
    if (mentorIds.length > 0) {
      const { data: profs } = await supabaseAdmin
        .from('profiles')
        .select('id, email, full_name')
        .in('id', mentorIds);
      for (const p of profs || []) mentorMap.set(p.id, p);
    }
    const mAgg = new Map();
    for (const r of rows) {
      const mId = r.mentor_user_id;
      if (!mAgg.has(mId)) {
        mAgg.set(mId, {
          mentor_user_id: mId,
          mentor_email  : mentorMap.get(mId)?.email || null,
          mentor_name   : mentorMap.get(mId)?.full_name || null,
          saldo         : 0,
          per_status    : emptyStatus(),
        });
      }
      const cell = mAgg.get(mId);
      const amount = Number(r.amount) || 0;
      if (STATUSES.includes(r.status)) cell.per_status[r.status] += amount;
      if (r.entry_type === 'bonus' && r.status === 'vrijgegeven') {
        cell.saldo += amount;
      } else if (r.entry_type === 'uitgave') {
        // Uitgaven trekken altijd af van het saldo (status 'vrijgegeven' default).
        cell.saldo -= Math.abs(amount);
      }
    }
    const byMentor = Array.from(mAgg.values())
      .map((c) => {
        c.saldo = round2(c.saldo);
        for (const s of STATUSES) c.per_status[s] = round2(c.per_status[s]);
        c.meegenomen_min_saldo = c.saldo < 0 ? round2(-c.saldo) : 0;
        return c;
      })
      .sort((a, b) => (a.mentor_name || a.mentor_email || '').localeCompare(b.mentor_name || b.mentor_email || ''));

    return res.status(200).json({
      ok: true,
      scope,
      totals,
      byStatus,
      byEvent,
      byMentor,
    });
  } catch (e) {
    console.error('[mentor-ledger-overview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
