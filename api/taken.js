import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('taken_items')
        .select('*')
        .order('aangemaakt', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ taken: data || [] });
    } catch (err) {
      console.error('[taken] GET fout:', err.message);
      return res.status(200).json({ taken: [], error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { task, action, id } = req.body || {};

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
        const { error } = await supabase.from('taken_items').upsert({
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
        }, { onConflict: 'id' });
        if (error) throw error;
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
