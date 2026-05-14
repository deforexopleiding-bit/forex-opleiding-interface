import { createUserClient } from './supabase.js';

function toRow(task) {
  return {
    id:             task.id,
    titel:          task.titel         || '',
    omschrijving:   task.omschrijving  || '',
    prioriteit:     task.prioriteit    || 'Normaal',
    categorie:      task.categorie     || 'Overige',
    toegewezen_aan: task.toegewezenAan || null,
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

export default async function handler(req, res) {
  const supabase = createUserClient(req);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('taken_items')
        .select('id,titel,omschrijving,prioriteit,categorie,toegewezen_aan,deadline,email_id,email_subject,status,notities,aangemaakt,afgerond_op,updated_at')
        .order('aangemaakt', { ascending: false })
        .limit(500);
      if (error) throw error;
      return res.status(200).json({ taken: data || [] });
    } catch (err) {
      console.error('[taken] GET fout:', err.message);
      return res.status(200).json({ taken: [], error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { task, action, id, tasks } = req.body || {};
    const { data: { user: authUser } } = await supabase.auth.getUser();
    const userId = authUser?.id || null;

    // Bulk upsert — migratie vanuit localStorage
    if (action === 'bulk_upsert' && Array.isArray(tasks)) {
      try {
        const rows = tasks.filter(t => t.id).map(toRow);
        if (!rows.length) return res.status(200).json({ ok: true, count: 0 });

        // Existence-check: welke IDs bestaan al?
        const ids = rows.map(r => r.id);
        const { data: existing } = await supabase.from('taken_items').select('id').in('id', ids);
        const existingIds = new Set((existing || []).map(r => r.id));

        // Split: nieuw (owner_id erbij) vs bestaand (geen owner-velden overschrijven)
        const newRows    = rows.filter(r => !existingIds.has(r.id)).map(r => ({ ...r, owner_id: userId, created_by_id: userId }));
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
        // Existence-check voor split: owner alleen bij INSERT, niet bij UPDATE
        const { data: existing } = await supabase.from('taken_items').select('id').eq('id', row.id).maybeSingle();
        if (existing) {
          // UPDATE: geen owner-velden overschrijven
          const { error } = await supabase.from('taken_items').upsert(row, { onConflict: 'id' });
          if (error) throw error;
        } else {
          // INSERT: owner_id meegeven; bij race-condition (duplicate key) log en fall through
          const { error } = await supabase.from('taken_items').insert({ ...row, owner_id: userId, created_by_id: userId });
          if (error) {
            if (error.code === '23505') {
              // Duplicate key na race-condition — fallback naar update
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
