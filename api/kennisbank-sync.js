import { createUserClient } from './supabase.js';
import { safeError } from './_lib/safe-error.js';

export default async function handler(req, res) {
  const supabase = createUserClient(req);

  // ── GET — haal alle kennisbank items op ──────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { data: items, error } = await supabase
        .from('kennisbank_items')
        .select('id, type, direction, title, content, label, note, category, helpfulness_score, times_used, created_at, updated_at')
        .order('helpfulness_score', { ascending: false });

      if (error) throw error;
      return res.status(200).json({ items: items || [], count: (items || []).length });
    } catch (err) {
      // Behoud items+count in de response-shape voor de FE; details naar log.
      console.error('[kennisbank-sync] GET fout:', err?.message || err);
      return res.status(500).json({ items: [], count: 0, error: 'Er ging iets mis. Probeer het later opnieuw.' });
    }
  }

  // ── PUT — update item op Supabase uuid ───────────────────────────────────
  if (req.method === 'PUT') {
    const id = req.query?.id;
    if (!id) return res.status(400).json({ error: 'id vereist' });
    const item = req.body || {};
    try {
      const payload = {
        type:       item.type                        || 'Algemeen',
        direction:  item.richting || item.direction  || null,
        content:    item.content                     || '',
        note:       item.note                        || null,
        updated_at: new Date().toISOString(),
      };
      if (item.title) payload.title = String(item.title).slice(0, 200);
      const { error } = await supabase.from('kennisbank_items').update(payload).eq('id', id);
      if (error) throw error;
      console.log('[kennisbank-sync] PUT id:', id);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return safeError(res, 500, err);
    }
  }

  // ── DELETE — verwijder item op Supabase uuid ─────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query?.id;
    if (!id) return res.status(400).json({ error: 'id vereist' });
    try {
      const { error } = await supabase.from('kennisbank_items').delete().eq('id', id);
      if (error) throw error;
      console.log('[kennisbank-sync] DELETE id:', id);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return safeError(res, 500, err);
    }
  }

  // ── POST — sync acties ────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};

  // ── Nieuwe acties: upsert_item / delete_item / sync_profile ──────────────
  if (body.action === 'upsert_item') {
    const item = body.item;
    if (!item) return res.status(400).json({ error: 'item vereist' });

    // Gebruik item.label als deduplicatiesleutel (niet item.id — auto-gegenereerde items hebben geen id)
    const labelKey = item.label || null;

    try {
      const { data: existing } = labelKey
        ? await supabase.from('kennisbank_items').select('id').eq('label', labelKey).maybeSingle()
        : { data: null };

      const payload = {
        type:             item.type            || 'Algemeen',
        direction:        item.richting        || item.direction || null,
        title:            (item.title || '').slice(0, 200) || (item.content || '').slice(0, 80) || 'Item',
        content:          item.content         || '',
        note:             item.note            || null,
        label:            labelKey,
        auto_generated:   item.auto_generated  ?? false,
        source_email_id:  item.source_email_id ? String(item.source_email_id) : null,
        helpfulness_score: item.helpfulness_score ?? 0,
        times_used:       item.times_used      ?? 0,
        updated_at:       new Date().toISOString()
      };

      let insertErr;
      if (existing) {
        const { error } = await supabase.from('kennisbank_items').update(payload).eq('id', existing.id);
        insertErr = error;
      } else {
        const { error } = await supabase.from('kennisbank_items').insert({
          ...payload,
          created_at: new Date().toISOString()
        });
        insertErr = error;
        // Fallback: één of meer kolommen bestaan nog niet — probeer met minimale set
        if (insertErr && insertErr.message?.includes('42703')) {
          const { error: e2 } = await supabase.from('kennisbank_items').insert({
            type:       payload.type    || 'Algemeen',
            content:    payload.content || '',
            created_at: new Date().toISOString()
          });
          insertErr = e2;
        }
      }
      if (insertErr) throw insertErr;
      console.log(`[kennisbank-sync] upsert_item → label: ${labelKey} | auto: ${payload.auto_generated} | title: ${payload.title.slice(0, 40)}`);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return safeError(res, 500, err);
    }
  }

  if (body.action === 'delete_item') {
    const localId = body.local_id;
    if (!localId) return res.status(400).json({ error: 'local_id vereist' });
    try {
      await supabase.from('kennisbank_items').delete().eq('label', localId);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return safeError(res, 500, err);
    }
  }

  if (body.action === 'sync_profile') {
    const profile = body.profile;
    if (!profile) return res.status(400).json({ error: 'profile vereist' });
    try {
      const { data: existing } = await supabase
        .from('kennisbank_items')
        .select('id')
        .eq('label', '_profile')
        .maybeSingle();

      const payload = {
        type:    'bedrijfsprofiel',
        label:   '_profile',
        title:   profile.bedrijfsnaam || 'Bedrijfsprofiel',
        content: JSON.stringify(profile),
        helpfulness_score: 100,
        updated_at: new Date().toISOString()
      };

      if (existing) {
        await supabase.from('kennisbank_items').update(payload).eq('id', existing.id);
      } else {
        await supabase.from('kennisbank_items').insert({ ...payload, times_used: 0, auto_generated: false });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      return safeError(res, 500, err);
    }
  }

  // ── Legacy: bulk sync van localStorage items + profile ────────────────────
  const { profile, items } = body;
  let synced = 0;
  let skipped = 0;
  const errors = [];

  if (profile && (profile.naam || profile.beschrijving)) {
    const profileContent = [
      profile.naam         ? `Bedrijfsnaam: ${profile.naam}` : '',
      profile.beschrijving ? `Beschrijving: ${profile.beschrijving}` : '',
      profile.doelgroep    ? `Doelgroep: ${profile.doelgroep}` : '',
      profile.tov          ? `Tone of voice: ${profile.tov}` : '',
      profile.website      ? `Website: ${profile.website}` : '',
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
        if (error) {
          console.error('[kennisbank-sync] profiel insert fout:', error?.message || error);
          errors.push('Profiel: kon niet gesynchroniseerd worden.');
        } else {
          synced++;
        }
      }
    } catch (e) {
      console.error('[kennisbank-sync] profiel crash:', e?.message || e);
      errors.push('Profiel: kon niet gesynchroniseerd worden.');
    }
  }

  if (Array.isArray(items)) {
    for (const item of items) {
      if (!item.title && !item.content) continue;

      try {
        const { data: existing } = await supabase
          .from('kennisbank_items')
          .select('id')
          .eq('title', item.title || '')
          .eq('type', item.type || item.category || '')
          .maybeSingle();

        if (existing) { skipped++; continue; }

        const { error } = await supabase.from('kennisbank_items').insert({
          type:              item.type || item.category || 'Overig',
          direction:         item.direction || null,
          title:             item.title || item.content?.slice(0, 80) || 'Item',
          category:          item.category || null,
          content:           item.content || '',
          question:          item.question || null,
          answer:            item.answer || null,
          label:             item.label || null,
          note:              item.note || null,
          times_used:        item.times_used || 0,
          times_helpful:     item.times_helpful || 0,
          helpfulness_score: item.helpfulness_score || 0,
          auto_generated:    item.auto_generated || false,
          source_email_id:   item.source_email_id || null
        });

        if (error) {
          console.error('[kennisbank-sync] item insert fout:', item.title, error?.message || error);
          errors.push(`Item "${item.title}": kon niet gesynchroniseerd worden.`);
        } else {
          synced++;
        }
      } catch (e) {
        console.error('[kennisbank-sync] item crash:', e?.message || e);
        errors.push('Item: kon niet gesynchroniseerd worden.');
      }
    }
  }

  console.log(`[kennisbank-sync] synced: ${synced}, skipped: ${skipped}, errors: ${errors.length}`);
  return res.status(200).json({ synced, skipped, errors });
}
