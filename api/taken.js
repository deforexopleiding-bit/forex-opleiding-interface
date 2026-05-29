import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function toUuidOrNull(id) {
  if (!id) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id)) ? String(id) : null;
}

const VALID_TASK_STATUSES = ['todo', 'progress', 'done'];

function toRow(task) {
  return {
    id:             task.id,
    titel:          task.titel         || '',
    omschrijving:   task.omschrijving  || '',
    prioriteit:     task.prioriteit    || 'Normaal',
    categorie:      task.categorie     || 'Overige',
    assigned_to_id: toUuidOrNull(task.assignedToId),
    deadline:       task.deadline      || null,
    email_id:       task.emailId       || null,
    email_subject:  task.emailSubject  || null,
    status:         task.status        || 'todo',
    notities:       task.notities      || '',
    aangemaakt:     task.aangemaakt    || new Date().toISOString(),
    afgerond_op:    task.afgerondOp    || null,
    updated_at:     new Date().toISOString()
  };
}

// Batch-lookup van profile-namen (zelfde pattern als ticket-detail.js).
async function fetchProfileNames(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', ids);
  if (error) {
    console.warn('[taken] profile-names lookup failed:', error.message);
    return {};
  }
  const map = {};
  for (const p of data || []) map[p.id] = p.full_name || p.email || null;
  return map;
}

export default async function handler(req, res) {
  const supabase = createUserClient(req);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('taken_items')
        .select('id,titel,omschrijving,prioriteit,categorie,assigned_to_id,deadline,email_id,email_subject,status,notities,aangemaakt,afgerond_op,updated_at,created_by,created_by_agent')
        .order('aangemaakt', { ascending: false })
        .limit(500);
      if (error) throw error;

      const rows = data || [];

      // Assignees-array per taak via taken_assignees.
      const taskIds = rows.map(r => r.id);
      let assigneesByTask = {};
      if (taskIds.length) {
        const { data: asgRows } = await supabaseAdmin
          .from('taken_assignees')
          .select('task_id, assignee_id')
          .in('task_id', taskIds);
        for (const a of asgRows || []) {
          (assigneesByTask[a.task_id] ||= []).push(a.assignee_id);
        }
      }

      // Name-enrich (assignee + creator + alle assignees uit join).
      const ids = new Set();
      for (const r of rows) {
        if (r.assigned_to_id) ids.add(r.assigned_to_id);
        if (r.created_by)     ids.add(r.created_by);
      }
      for (const arr of Object.values(assigneesByTask)) {
        for (const id of arr) ids.add(id);
      }
      const nameMap = await fetchProfileNames(Array.from(ids));

      const enriched = rows.map(r => ({
        ...r,
        assigned_to_name: r.assigned_to_id ? (nameMap[r.assigned_to_id] || null) : null,
        created_by_name:  r.created_by    ? (nameMap[r.created_by]    || null) : null,
        assignees: (assigneesByTask[r.id] || []).map(pid => ({
          assignee_id:   pid,
          assignee_name: nameMap[pid] || null,
        })),
      }));
      return res.status(200).json({ taken: enriched });
    } catch (err) {
      console.error('[taken] GET fout:', err.message);
      return res.status(200).json({ taken: [], error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { task, action, id, tasks } = req.body || {};
    const { data: { user: authUser } } = await supabase.auth.getUser();
    const userId = authUser?.id || null;
    if (!userId) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    // Permission-gate per action.
    const needed = action === 'delete' ? 'taken.task.delete' : 'taken.task.create';
    const allowed = await requirePermission(req, needed);
    if (!allowed) return res.status(403).json({ error: `Geen rechten voor ${needed}` });

    const checkStatus = (row) => {
      if (row.status && !VALID_TASK_STATUSES.includes(row.status)) {
        return `Ongeldige status "${row.status}". Toegestaan: ${VALID_TASK_STATUSES.join(', ')}`;
      }
      return null;
    };

    // Bulk upsert — migratie vanuit localStorage
    if (action === 'bulk_upsert' && Array.isArray(tasks)) {
      try {
        const rows = tasks.filter(t => t.id).map(toRow);
        if (!rows.length) return res.status(200).json({ ok: true, count: 0 });

        for (const r of rows) {
          const statusErr = checkStatus(r);
          if (statusErr) return res.status(400).json({ error: statusErr });
        }

        const ids = rows.map(r => r.id);
        const { data: existing } = await supabase.from('taken_items').select('id').in('id', ids);
        const existingIds = new Set((existing || []).map(r => r.id));

        // Split: nieuw (creator-velden erbij) vs bestaand (geen creator-velden overschrijven)
        const newRows    = rows.filter(r => !existingIds.has(r.id)).map(r => ({ ...r, created_by: userId, owner_id: userId, created_by_id: userId }));
        const updateRows = rows.filter(r =>  existingIds.has(r.id));

        if (newRows.length)    { const { error: e1 } = await supabase.from('taken_items').insert(newRows);                          if (e1) throw e1; }
        if (updateRows.length) { const { error: e2 } = await supabase.from('taken_items').upsert(updateRows, { onConflict: 'id' }); if (e2) throw e2; }

        console.log(`[taken] bulk_upsert: ${rows.length} taken gesynchroniseerd (${newRows.length} nieuw, ${updateRows.length} bijgewerkt)`);
        return res.status(200).json({ ok: true, count: rows.length });
      } catch (err) {
        console.error('[taken] BULK fout:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'id vereist' });
      try {
        const { error } = await supabase.from('taken_items').delete().eq('id', id);
        if (error) throw error;
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error('[taken] DELETE fout:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    if (task) {
      if (!task.id) return res.status(400).json({ error: 'task.id vereist' });
      try {
        const row = toRow(task);
        const statusErr = checkStatus(row);
        if (statusErr) return res.status(400).json({ error: statusErr });

        const { data: existing } = await supabase.from('taken_items').select('id').eq('id', row.id).maybeSingle();
        if (existing) {
          const { error } = await supabase.from('taken_items').upsert(row, { onConflict: 'id' });
          if (error) throw error;
        } else {
          // INSERT: created_by=user.id (XOR met created_by_agent — user-pad, agent blijft NULL)
          const { error } = await supabase.from('taken_items').insert({ ...row, created_by: userId, owner_id: userId, created_by_id: userId });
          if (error) {
            if (error.code === '23505') {
              console.warn('[taken] race-condition duplicate key, fallback naar update');
              const { error: upErr } = await supabase.from('taken_items').upsert(row, { onConflict: 'id' });
              if (upErr) throw upErr;
            } else {
              throw error;
            }
          }
        }
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error('[taken] UPSERT fout:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: 'task of action vereist' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
