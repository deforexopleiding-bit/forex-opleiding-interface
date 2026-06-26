// api/mentor-taken-self.js
//
// GET → self-scoped lijst van OPEN taken die aan de ingelogde user zijn
// toegewezen. Dual-path resolutie (zelfde pattern als api/taken-badge.js):
//   pad 1: taken_items.assigned_to_id = user.id
//   pad 2: taken_assignees.assignee_id = user.id  (join → taken_items.id IN ...)
// Beide gemerged via Set zodat een taak nooit dubbel verschijnt; allebei
// status != 'done'.
//
// Permission: taken.module.access (mentor heeft die). 403 zonder.
//
// SECURITY — Hard-forced eigenaars-filter:
//   - assignee komt UITSLUITEND uit user.id (Bearer-token via
//     createUserClient.auth.getUser()). Geen ?assignee_id / ?user_id of
//     vergelijkbare client-param wordt gelezen — fail-closed op de filter.
//   - Geen user.id → 401 voordat er ook maar één query draait.
//
// Return: { items: [{ id, titel, deadline, prioriteit, status }] }.
// Sort deadline ASC nulls-last, limit 6. Lege lijst = { items: [] } (200).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const LIST_LIMIT = 6;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1. Auth-check (token → user.id; fail-closed zonder).
  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user || !user.id) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  // 2. Permission-gate.
  if (!(await requirePermission(req, 'taken.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (taken.module.access)' });
  }

  try {
    // 3. Dual-path resolutie — exact pattern uit taken-badge.js.
    //    BEWUST GENEGEERD: req.query.assignee_id / req.query.user_id (of welke
    //    naam dan ook). De assignee komt exclusief uit user.id.
    const [directRes, joinRes] = await Promise.all([
      supabase.from('taken_items')
        .select('id, titel, deadline, prioriteit, status')
        .eq('assigned_to_id', user.id)
        .neq('status', 'done'),
      supabase.from('taken_assignees')
        .select('task_id')
        .eq('assignee_id', user.id),
    ]);
    if (directRes.error) throw directRes.error;
    if (joinRes.error)   throw joinRes.error;

    const taskMap = new Map();
    for (const r of directRes.data || []) {
      if (r?.id) taskMap.set(r.id, r);
    }

    const joinIds = (joinRes.data || []).map((r) => r.task_id).filter(Boolean);
    if (joinIds.length > 0) {
      const { data: joinTasks, error: jErr } = await supabase
        .from('taken_items')
        .select('id, titel, deadline, prioriteit, status')
        .in('id', joinIds)
        .neq('status', 'done');
      if (jErr) throw jErr;
      for (const r of joinTasks || []) {
        if (r?.id && !taskMap.has(r.id)) taskMap.set(r.id, r);
      }
    }

    const items = Array.from(taskMap.values())
      .map((t) => ({
        id         : t.id,
        titel      : t.titel || '',
        deadline   : t.deadline || null,
        prioriteit : t.prioriteit || 'Normaal',
        status     : t.status || 'todo',
      }))
      .sort((a, b) => {
        // deadline ASC, nulls last.
        const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        if (da !== db) return da - db;
        // tie-breaker: titel alfabetisch zodat sort stabiel oogt.
        return String(a.titel).localeCompare(String(b.titel));
      })
      .slice(0, LIST_LIMIT);

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[mentor-taken-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
