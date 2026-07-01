import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createNotification } from './_lib/notify.js';

function toUuidOrNull(id) {
  if (!id) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id)) ? String(id) : null;
}

const VALID_TASK_STATUSES = ['todo', 'progress', 'done'];

// Permission-fallback: probeer keys in volgorde, eerste hit = allow.
// Voorkomt dat nieuwere keys (taken.task.edit / .status_change) iedereen
// blokkeren voordat ze in permission_settings zijn gepushed.
async function permitAny(req, ...keys) {
  for (const k of keys) {
    if (await requirePermission(req, k)) return true;
  }
  return false;
}

// super_admin via profiles.role OF user_roles (multi-role union). Manager telt NIET.
// Pattern uit admin-impersonate.js / requirePermission RPC.
async function isSuperAdmin(userId) {
  if (!userId) return false;
  try {
    const { data: prof } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (prof?.role === 'super_admin') return true;
    const { data: roles } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', userId);
    return (roles || []).some((r) => r && r.role === 'super_admin');
  } catch (e) {
    console.warn('[taken] isSuperAdmin lookup faalde:', e?.message || e);
    return false;
  }
}

async function isAssignee(taskId, userId) {
  if (!taskId || !userId) return false;
  const { data, error } = await supabaseAdmin
    .from('taken_assignees')
    .select('assignee_id')
    .eq('task_id', taskId)
    .eq('assignee_id', userId)
    .limit(1);
  if (error) {
    console.warn('[taken] isAssignee lookup:', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

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
      // ── Server-side scoping ─────────────────────────────────────────────
      // scope='mine'           → assigned_to_id=user.id OF taken_assignees.assignee_id=user.id
      // scope='assigned_by_me' → created_by=user.id
      // Hard op user.id; geen client-param die een andere user kan kiezen.
      const { data: { user: authUser } } = await supabase.auth.getUser();
      const userId = authUser?.id || null;
      if (!userId) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const scopeRaw = typeof req.query?.scope === 'string' ? req.query.scope.trim() : '';
      const scope = (scopeRaw === 'assigned_by_me') ? 'assigned_by_me' : 'mine';

      let rows = [];
      if (scope === 'assigned_by_me') {
        const { data, error } = await supabaseAdmin
          .from('taken_items')
          .select('id,titel,omschrijving,prioriteit,categorie,assigned_to_id,deadline,email_id,email_subject,status,notities,aangemaakt,afgerond_op,updated_at,created_by,created_by_agent')
          .eq('created_by', userId)
          .order('aangemaakt', { ascending: false })
          .limit(500);
        if (error) throw error;
        rows = data || [];
      } else {
        // 'mine' — dual-pad (zoals taken-badge). Union via Map om dubbeltellingen
        // te voorkomen.
        const [directRes, joinRes] = await Promise.all([
          supabaseAdmin.from('taken_items')
            .select('id,titel,omschrijving,prioriteit,categorie,assigned_to_id,deadline,email_id,email_subject,status,notities,aangemaakt,afgerond_op,updated_at,created_by,created_by_agent')
            .eq('assigned_to_id', userId)
            .order('aangemaakt', { ascending: false })
            .limit(500),
          supabaseAdmin.from('taken_assignees')
            .select('task_id')
            .eq('assignee_id', userId),
        ]);
        if (directRes.error) throw directRes.error;
        if (joinRes.error)   throw joinRes.error;

        const map = new Map();
        for (const r of (directRes.data || [])) if (r?.id) map.set(r.id, r);

        const joinTaskIds = (joinRes.data || []).map((r) => r.task_id).filter(Boolean);
        if (joinTaskIds.length > 0) {
          const { data: joinTasks, error: jErr } = await supabaseAdmin
            .from('taken_items')
            .select('id,titel,omschrijving,prioriteit,categorie,assigned_to_id,deadline,email_id,email_subject,status,notities,aangemaakt,afgerond_op,updated_at,created_by,created_by_agent')
            .in('id', joinTaskIds);
          if (jErr) throw jErr;
          for (const r of (joinTasks || [])) {
            if (r?.id && !map.has(r.id)) map.set(r.id, r);
          }
        }
        rows = Array.from(map.values())
          .sort((a, b) => (a.aangemaakt < b.aangemaakt ? 1 : (a.aangemaakt > b.aangemaakt ? -1 : 0)));
      }

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
    const { task, action, id, tasks, status: statusParam } = req.body || {};
    const { data: { user: authUser } } = await supabase.auth.getUser();
    const userId = authUser?.id || null;
    if (!userId) return res.status(401).json({ error: 'Niet geauthenticeerd' });

    const superAdmin = await isSuperAdmin(userId);

    const checkStatus = (row) => {
      if (row.status && !VALID_TASK_STATUSES.includes(row.status)) {
        return `Ongeldige status "${row.status}". Toegestaan: ${VALID_TASK_STATUSES.join(', ')}`;
      }
      return null;
    };

    // ── action: 'status_change' ──────────────────────────────────────────
    // Aparte status-only path. Creator OF assignee OF super_admin mag de
    // status verzetten (drag-drop, status-strip). Niet voor edit/delete.
    if (action === 'status_change') {
      if (!(await permitAny(req, 'taken.task.status_change', 'taken.task.create'))) {
        return res.status(403).json({ error: 'Geen rechten voor taken.task.status_change' });
      }
      if (!id) return res.status(400).json({ error: 'id vereist' });
      const newStatus = (typeof statusParam === 'string' ? statusParam.trim() : '');
      if (!VALID_TASK_STATUSES.includes(newStatus)) {
        return res.status(400).json({ error: `Ongeldige status "${newStatus}". Toegestaan: ${VALID_TASK_STATUSES.join(', ')}` });
      }
      try {
        const { data: existing, error: lkErr } = await supabaseAdmin
          .from('taken_items')
          .select('id, created_by, assigned_to_id, status')
          .eq('id', id)
          .maybeSingle();
        if (lkErr) throw lkErr;
        if (!existing) return res.status(404).json({ error: 'Taak niet gevonden' });

        let canChange = superAdmin
          || existing.created_by === userId
          || existing.assigned_to_id === userId;
        if (!canChange) canChange = await isAssignee(id, userId);
        if (!canChange) {
          return res.status(403).json({ error: 'Alleen de maker, toegewezene of super_admin mag de status wijzigen' });
        }

        const patch = {
          status: newStatus,
          afgerond_op: newStatus === 'done' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        };
        const { error: upErr } = await supabaseAdmin.from('taken_items').update(patch).eq('id', id);
        if (upErr) throw upErr;
        // Fail-soft: als de taak op 'done' gezet wordt door iemand anders
        // dan de maker, laat de maker het weten.
        if (newStatus === 'done' && existing.created_by && existing.created_by !== userId) {
          // Laad titel voor de body (extra select, fail-soft).
          try {
            const { data: t } = await supabaseAdmin
              .from('taken_items')
              .select('titel')
              .eq('id', id)
              .maybeSingle();
            createNotification({
              toUserId:   existing.created_by,
              type:       'task.completed',
              title:      'Taak afgerond',
              body:       (t && t.titel) || null,
              linkUrl:    '/modules/taken.html',
              entityType: 'task',
              entityId:   id,
              createdBy:  userId,
            }).catch(() => {});
          } catch (_) { /* fail-soft */ }
        }
        return res.status(200).json({ ok: true, status: newStatus });
      } catch (err) {
        console.error('[taken] status_change fout:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── action: 'bulk_upsert' ────────────────────────────────────────────
    // Migratie vanuit localStorage. Ownership ook hier: bestaande rijen
    // alleen bijwerken als caller=eigenaar OF super_admin; niet-eigen rijen
    // worden overgeslagen (log).
    if (action === 'bulk_upsert' && Array.isArray(tasks)) {
      if (!(await requirePermission(req, 'taken.task.create'))) {
        return res.status(403).json({ error: 'Geen rechten voor taken.task.create' });
      }
      try {
        const rows = tasks.filter(t => t.id).map(toRow);
        if (!rows.length) return res.status(200).json({ ok: true, count: 0 });

        for (const r of rows) {
          const statusErr = checkStatus(r);
          if (statusErr) return res.status(400).json({ error: statusErr });
        }

        const ids = rows.map(r => r.id);
        const { data: existing } = await supabaseAdmin
          .from('taken_items')
          .select('id, created_by')
          .in('id', ids);
        const existingMap = new Map((existing || []).map((r) => [r.id, r]));

        const newRows = [];
        const updateRows = [];
        const skipped = [];
        for (const r of rows) {
          const ex = existingMap.get(r.id);
          if (ex) {
            if (superAdmin || ex.created_by === userId) {
              updateRows.push(r); // toRow() bevat geen created_by → blijft ongewijzigd
            } else {
              skipped.push(r.id);
            }
          } else {
            newRows.push({ ...r, created_by: userId, owner_id: userId, created_by_id: userId });
          }
        }

        if (newRows.length)    { const { error: e1 } = await supabaseAdmin.from('taken_items').insert(newRows);                          if (e1) throw e1; }
        if (updateRows.length) { const { error: e2 } = await supabaseAdmin.from('taken_items').upsert(updateRows, { onConflict: 'id' }); if (e2) throw e2; }

        if (skipped.length) {
          console.warn(`[taken] bulk_upsert ownership-skip: ${skipped.length} taken (niet eigen, geen super_admin)`);
        }
        console.log(`[taken] bulk_upsert: ${rows.length} taken (${newRows.length} nieuw, ${updateRows.length} bijgewerkt, ${skipped.length} overgeslagen)`);
        return res.status(200).json({ ok: true, count: newRows.length + updateRows.length, skipped: skipped.length });
      } catch (err) {
        console.error('[taken] BULK fout:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── action: 'delete' ─────────────────────────────────────────────────
    // Alleen creator OF super_admin. super_admin → delete by id.
    // Anders delete .eq('id', id).eq('created_by', userId); bij 0 rijen → 403.
    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'id vereist' });
      if (!(await requirePermission(req, 'taken.task.delete'))) {
        return res.status(403).json({ error: 'Geen rechten voor taken.task.delete' });
      }
      try {
        if (superAdmin) {
          const { error } = await supabaseAdmin.from('taken_items').delete().eq('id', id);
          if (error) throw error;
          return res.status(200).json({ ok: true });
        }
        const { data, error } = await supabaseAdmin
          .from('taken_items')
          .delete()
          .eq('id', id)
          .eq('created_by', userId)
          .select('id');
        if (error) throw error;
        if (!Array.isArray(data) || data.length === 0) {
          return res.status(403).json({ error: 'Alleen de maker of super_admin mag deze taak verwijderen' });
        }
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error('[taken] DELETE fout:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── { task }-upsert: split nieuw vs bestaand ─────────────────────────
    if (task) {
      if (!task.id) return res.status(400).json({ error: 'task.id vereist' });
      try {
        const row = toRow(task);
        const statusErr = checkStatus(row);
        if (statusErr) return res.status(400).json({ error: statusErr });

        const { data: existing } = await supabaseAdmin
          .from('taken_items')
          .select('id, created_by')
          .eq('id', row.id)
          .maybeSingle();

        const wasNewTask = !existing;
        if (existing) {
          // EDIT — alleen creator OF super_admin.
          if (!(await permitAny(req, 'taken.task.edit', 'taken.task.create'))) {
            return res.status(403).json({ error: 'Geen rechten voor taken.task.edit' });
          }
          if (!(superAdmin || existing.created_by === userId)) {
            return res.status(403).json({ error: 'Alleen de maker of super_admin mag deze taak bewerken' });
          }
          // toRow() bevat geen created_by-veld → created_by wordt nooit overschreven.
          const { error } = await supabaseAdmin.from('taken_items').upsert(row, { onConflict: 'id' });
          if (error) throw error;
        } else {
          // NIEUW — taken.task.create vereist; created_by = userId.
          if (!(await requirePermission(req, 'taken.task.create'))) {
            return res.status(403).json({ error: 'Geen rechten voor taken.task.create' });
          }
          const { error } = await supabaseAdmin
            .from('taken_items')
            .insert({ ...row, created_by: userId, owner_id: userId, created_by_id: userId });
          if (error) {
            if (error.code === '23505') {
              // Race: row is intussen aangemaakt door dezelfde caller; alleen eigen
              // record bijwerken (zelfde created_by-guard als reguliere edit).
              console.warn('[taken] race-condition duplicate key, fallback naar update voor eigen rij');
              const { data: existing2 } = await supabaseAdmin
                .from('taken_items')
                .select('created_by')
                .eq('id', row.id)
                .maybeSingle();
              if (!existing2 || !(superAdmin || existing2.created_by === userId)) {
                return res.status(409).json({ error: 'Taak bestaat al en is niet van jou' });
              }
              const { error: upErr } = await supabaseAdmin.from('taken_items').upsert(row, { onConflict: 'id' });
              if (upErr) throw upErr;
            } else {
              throw error;
            }
          }
        }
        // Fail-soft dual-write: notificeer assignees bij een NIEUWE taak.
        // Verzamel assigned_to_id + alle taken_assignees.assignee_id, dedup,
        // skip de maker zelf.
        if (wasNewTask) {
          try {
            const recipients = new Set();
            if (row.assigned_to_id) recipients.add(row.assigned_to_id);
            const { data: extra } = await supabaseAdmin
              .from('taken_assignees')
              .select('assignee_id')
              .eq('task_id', row.id);
            if (Array.isArray(extra)) {
              for (const a of extra) if (a && a.assignee_id) recipients.add(a.assignee_id);
            }
            recipients.delete(userId);
            for (const uid of recipients) {
              createNotification({
                toUserId:   uid,
                type:       'task.assigned',
                title:      'Nieuwe taak toegewezen',
                body:       row.titel || null,
                linkUrl:    '/modules/taken.html',
                entityType: 'task',
                entityId:   row.id,
                createdBy:  userId,
              }).catch(() => {});
            }
          } catch (_) { /* fail-soft */ }
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
