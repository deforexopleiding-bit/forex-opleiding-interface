// api/secret-area-workspace.js
// GET → { strategies[], tools[] }.
// Tools bevatten tellingen: examples_ideal, examples_counter, examples_count.
// Owner-gated.

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  try {
    const [{ data: strategies }, { data: tools }, { data: examples }] = await Promise.all([
      supabaseAdmin.from('sa_strategies')
        .select('*').eq('owner_id', ctx.userId)
        .order('created_at', { ascending: false }),
      supabaseAdmin.from('sa_tools')
        .select('*').eq('owner_id', ctx.userId)
        .order('created_at', { ascending: false }),
      supabaseAdmin.from('sa_tool_examples')
        .select('tool_id, kind').eq('owner_id', ctx.userId),
    ]);

    const countByTool = new Map();
    for (const e of (examples || [])) {
      const rec = countByTool.get(e.tool_id) || { ideal: 0, counter: 0, total: 0 };
      if (e.kind === 'ideal')   rec.ideal++;
      if (e.kind === 'counter') rec.counter++;
      rec.total++;
      countByTool.set(e.tool_id, rec);
    }
    const toolsOut = (tools || []).map((t) => {
      const c = countByTool.get(t.id) || { ideal: 0, counter: 0, total: 0 };
      return { ...t,
        examples_ideal:   c.ideal,
        examples_counter: c.counter,
        examples_count:   c.total,
      };
    });

    return res.status(200).json({
      strategies: strategies || [],
      tools:      toolsOut,
    });
  } catch (e) {
    console.error('[sa-workspace]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
