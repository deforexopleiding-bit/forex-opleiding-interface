// api/secret-area-example.js
// POST → tool-voorbeeld toevoegen { tool_id, kind:'ideal'|'counter', timeframe, instrument, note, image_path }
// DELETE ?id → voorbeeld verwijderen
// Owner-gated. image_path komt van /api/secret-area-upload (of null).

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND = new Set(['ideal', 'counter']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  try {
    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const toolId = typeof body.tool_id === 'string' ? body.tool_id.trim() : '';
      if (!UUID_RE.test(toolId)) return res.status(400).json({ error: 'tool_id (uuid) vereist' });

      // Ownership-check: tool moet van deze user zijn.
      const { data: tool } = await supabaseAdmin.from('sa_tools')
        .select('id').eq('id', toolId).eq('owner_id', ctx.userId).maybeSingle();
      if (!tool) return res.status(404).json({ error: 'Tool niet gevonden' });

      const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
      if (!KIND.has(kind)) return res.status(400).json({ error: "kind moet 'ideal' of 'counter' zijn" });

      const row = {
        owner_id:    ctx.userId,
        tool_id:     toolId,
        kind,
        timeframe:   typeof body.timeframe  === 'string' ? body.timeframe.slice(0, 40)  : null,
        instrument:  typeof body.instrument === 'string' ? body.instrument.slice(0, 40) : null,
        note:        typeof body.note       === 'string' ? body.note.slice(0, 5000)     : null,
        image_path:  typeof body.image_path === 'string' ? body.image_path.slice(0, 500): null,
        source_url:  typeof body.source_url === 'string' ? body.source_url.slice(0, 500): null,
      };
      const { data: created, error } = await supabaseAdmin
        .from('sa_tool_examples').insert(row).select('*').single();
      if (error) throw new Error('insert: ' + error.message);
      return res.status(201).json({ example: created });
    }

    if (req.method === 'DELETE') {
      const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      const { error } = await supabaseAdmin.from('sa_tool_examples')
        .delete().eq('id', id).eq('owner_id', ctx.userId);
      if (error) throw new Error('delete: ' + error.message);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sa-example]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
