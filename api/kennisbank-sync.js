import { supabase } from './supabase.js';

export default async function handler(req, res) {
  // ── GET — haal alle kennisbank items op ──────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { data: items, error } = await supabase
        .from('kennisbank_items')
        .select('id, type, direction, title, category, content, question, answer, label, note, times_used, times_helpful, helpfulness_score, auto_generated, source_email_id, created_at')
        .order('helpfulness_score', { ascending: false });

      if (error) throw error;
      return res.status(200).json({ items: items || [], count: (items || []).length });
    } catch (err) {
      console.error('[kennisbank-sync] GET fout:', err.message);
      return res.status(200).json({ items: [], count: 0, error: err.message });
    }
  }

  // ── POST — sync localStorage data naar Supabase ────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { profile, items } = req.body || {};
  let synced = 0;
  let skipped = 0;
  const errors = [];

  // ── Bedrijfsprofiel als kennisbank_item ────────────────────────────────
  if (profile && (profile.naam || profile.beschrijving)) {
    const profileContent = [
      profile.naam       ? `Bedrijfsnaam: ${profile.naam}` : '',
      profile.beschrijving ? `Beschrijving: ${profile.beschrijving}` : '',
      profile.doelgroep  ? `Doelgroep: ${profile.doelgroep}` : '',
      profile.tov        ? `Tone of voice: ${profile.tov}` : '',
      profile.website    ? `Website: ${profile.website}` : '',
    ].filter(Boolean).join('\n');

    try {
      const { data: existing } = await supabase
        .from('kennisbank_items')
        .select('id')
        .eq('type', 'bedrijfsprofiel')
        .maybeSingle();

      if (existing) {
        await supabase.from('kennisbank_items')
          .update({ content: profileContent, label: profile.naam || 'Bedrijfsprofiel' })
          .eq('id', existing.id);
        skipped++;
      } else {
        const { error } = await supabase.from('kennisbank_items').insert({
          type:    'bedrijfsprofiel',
          title:   profile.naam || 'Bedrijfsprofiel',
          label:   profile.naam || 'Bedrijfsprofiel',
          content: profileContent,
          helpfulness_score: 100,
          times_used: 0
        });
        if (error) errors.push('Profiel: ' + error.message);
        else synced++;
      }
    } catch (e) { errors.push('Profiel crash: ' + e.message); }
  }

  // ── Kennisbank items ───────────────────────────────────────────────────
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item.title && !item.content) continue;

      try {
        // Check of al bestaat op basis van title
        const { data: existing } = await supabase
          .from('kennisbank_items')
          .select('id')
          .eq('title', item.title || '')
          .eq('type', item.type || item.category || '')
          .maybeSingle();

        if (existing) {
          skipped++;
          continue;
        }

        const { error } = await supabase.from('kennisbank_items').insert({
          type:             item.type || item.category || 'Overig',
          direction:        item.direction || null,
          title:            item.title || item.content?.slice(0, 80) || 'Item',
          category:         item.category || null,
          content:          item.content || '',
          question:         item.question || null,
          answer:           item.answer || null,
          label:            item.label || null,
          note:             item.note || null,
          times_used:       item.times_used || 0,
          times_helpful:    item.times_helpful || 0,
          helpfulness_score: item.helpfulness_score || 0,
          auto_generated:   item.auto_generated || false,
          source_email_id:  item.source_email_id || null
        });

        if (error) errors.push(`Item "${item.title}": ${error.message}`);
        else synced++;
      } catch (e) {
        errors.push(`Item crash: ${e.message}`);
      }
    }
  }

  console.log(`[kennisbank-sync] synced: ${synced}, skipped: ${skipped}, errors: ${errors.length}`);
  return res.status(200).json({ synced, skipped, errors });
}
