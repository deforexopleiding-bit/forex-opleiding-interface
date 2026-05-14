import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  const supabase = createUserClient(req);

  if (req.method === 'GET') {
    const user = req.query?.user || 'Jeffrey';
    const { data, error } = await supabase.from('undo_history')
      .select('id, action_type, action_data, performed_at, label')
      .eq('performed_by', user)
      .eq('is_undone', false)
      .order('performed_at', { ascending: false })
      .limit(10);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ history: data || [] });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, type, data: actionData, label, performed_by = 'Jeffrey', id } = req.body || {};

  // ── Sla nieuwe actie op ──────────────────────────────────────────────────
  if (action === 'save') {
    try {
      // Trim: verwijder oudste entries als er >= 10 zijn
      const { data: existing } = await supabase.from('undo_history')
        .select('id')
        .eq('performed_by', performed_by)
        .order('performed_at', { ascending: true });

      if (existing && existing.length >= 10) {
        const toDelete = existing.slice(0, existing.length - 9).map((e) => e.id);
        await supabase.from('undo_history').delete().in('id', toDelete);
      }

      const { data: inserted, error: insErr } = await supabase.from('undo_history').insert({
        action_type:  type,
        action_data:  actionData || {},
        label:        label || type,
        performed_by: performed_by,
      }).select('id').single();

      if (insErr) {
        console.warn('[undo] save fout:', insErr.message);
        return res.status(200).json({ ok: false, error: insErr.message });
      }

      return res.status(200).json({ ok: true, id: inserted?.id });
    } catch (e) {
      console.error('[undo] save crash:', e.message);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── Voer undo uit ────────────────────────────────────────────────────────
  if (action === 'undo') {
    try {
      // Markeer als ongedaan
      if (id) {
        await supabase.from('undo_history').update({
          is_undone: true,
          undone_at: new Date().toISOString()
        }).eq('id', id);
      }

      let reverted = false;

      if (!actionData || !type) {
        return res.status(200).json({ ok: true, reverted: false, message: 'Geen data om terug te draaien' });
      }

      // Categorie-wijziging / reclame / not_spam
      if (['category_change', 'mark_reclame', 'not_spam'].includes(type)) {
        const { email_id, email_sender, old_category, learn_example_id, old_confidence } = actionData;

        // Verwijder het learn_example dat aangemaakt was
        if (learn_example_id) {
          const { error: delErr } = await supabase.from('learn_examples').delete().eq('id', learn_example_id);
          if (delErr) console.warn('[undo] learn_examples delete fout:', delErr.message);
          else reverted = true;
        } else if (email_id) {
          // Fallback: verwijder meest recente entry voor dit email_id
          const { data: examples } = await supabase.from('learn_examples')
            .select('id, corrected_at')
            .eq('email_id', email_id)
            .order('corrected_at', { ascending: false })
            .limit(1);
          if (examples?.length) {
            await supabase.from('learn_examples').delete().eq('id', examples[0].id);
            reverted = true;
          }
        }

        // Herstel email_pattern confidence als die veranderd was
        if (email_sender && old_confidence != null && old_category) {
          const { error: patErr } = await supabase.from('email_patterns')
            .update({
              category:  old_category,
              confidence: old_confidence,
              source:    'manual',
              last_corrected_at: new Date().toISOString()
            })
            .eq('sender_email', email_sender);
          if (patErr) console.warn('[undo] email_patterns herstel fout:', patErr.message);
          else reverted = true;
        }
      }

      // Kennisbank item toevoegen ongedaan maken
      if (type === 'kennisbank_add') {
        const { kennisbank_id } = actionData;
        if (kennisbank_id) {
          const { error: kbErr } = await supabase.from('kennisbank_items').delete().eq('id', kennisbank_id);
          if (kbErr) console.warn('[undo] kennisbank delete fout:', kbErr.message);
          else reverted = true;
        }
      }

      console.log(`[undo] ${type} → reverted: ${reverted}`);
      return res.status(200).json({ ok: true, reverted, type });
    } catch (e) {
      console.error('[undo] undo crash:', e.message);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  return res.status(400).json({ error: 'Onbekende actie — gebruik: save of undo' });
}
