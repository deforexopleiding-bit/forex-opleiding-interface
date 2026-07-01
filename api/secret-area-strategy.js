// api/secret-area-strategy.js
// GET    ?id  → strategie + steps[] + checklist[]
// POST        → nieuwe strategie { name, entry, sl, tp, risk_pct, sessions[], steps[], checklist[] }
// PUT    ?id  → strategie update; steps + checklist worden vervangen (destructive replace)
// DELETE ?id  → strategie + steps + checklist verwijderen
// Owner-gated. steps + checklist worden binnen dit endpoint beheerd
// (destructive replace bij POST/PUT — simpel + consistent).

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadFull(id, ownerId) {
  const [{ data: strat }, { data: steps }, { data: checklist }] = await Promise.all([
    supabaseAdmin.from('sa_strategies')
      .select('*').eq('id', id).eq('owner_id', ownerId).maybeSingle(),
    supabaseAdmin.from('sa_strategy_steps')
      .select('*').eq('strategy_id', id).eq('owner_id', ownerId)
      .order('position', { ascending: true }),
    supabaseAdmin.from('sa_checklist_items')
      .select('*').eq('strategy_id', id).eq('owner_id', ownerId)
      .order('position', { ascending: true }),
  ]);
  if (!strat) return null;
  return { ...strat, steps: steps || [], checklist: checklist || [] };
}

function normSteps(input, strategyId, ownerId) {
  if (!Array.isArray(input)) return [];
  return input.map((s, i) => ({
    strategy_id: strategyId,
    owner_id:    ownerId,
    position:    Number.isFinite(s?.position) ? Number(s.position) : (i + 1),
    description: typeof s?.description === 'string' ? s.description.slice(0, 2000) : '',
  })).filter((s) => s.description);
}

function normChecklist(input, strategyId, ownerId) {
  if (!Array.isArray(input)) return [];
  return input.map((c, i) => ({
    strategy_id: strategyId,
    owner_id:    ownerId,
    position:    Number.isFinite(c?.position) ? Number(c.position) : (i + 1),
    label:       typeof c?.label === 'string' ? c.label.slice(0, 500) : '',
    weight:      Number.isFinite(c?.weight) ? Number(c.weight) : 1,
  })).filter((c) => c.label);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';

  try {
    if (req.method === 'GET') {
      if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      const full = await loadFull(id, ctx.userId);
      if (!full) return res.status(404).json({ error: 'Strategie niet gevonden' });
      return res.status(200).json({ strategy: full });
    }

    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const insertRow = {
        owner_id:     ctx.userId,
        name:         typeof body.name === 'string' ? body.name.slice(0, 200) : 'Nieuwe strategie',
        entry_signal: typeof body.entry_signal === 'string' ? body.entry_signal.slice(0, 2000) : null,
        sl_signal:    typeof body.sl_signal    === 'string' ? body.sl_signal.slice(0, 2000)    : null,
        tp_signal:    typeof body.tp_signal    === 'string' ? body.tp_signal.slice(0, 2000)    : null,
        risk_pct:     Number.isFinite(body?.risk_pct) ? Number(body.risk_pct) : null,
        sessions:     Array.isArray(body.sessions) ? body.sessions.slice(0, 20) : null,
        note:         typeof body.note === 'string' ? body.note.slice(0, 5000) : null,
      };
      const { data: created, error } = await supabaseAdmin
        .from('sa_strategies').insert(insertRow).select('*').single();
      if (error) throw new Error('insert: ' + error.message);

      const steps = normSteps(body.steps, created.id, ctx.userId);
      const cl    = normChecklist(body.checklist, created.id, ctx.userId);
      if (steps.length > 0) await supabaseAdmin.from('sa_strategy_steps').insert(steps);
      if (cl.length > 0)    await supabaseAdmin.from('sa_checklist_items').insert(cl);

      const full = await loadFull(created.id, ctx.userId);
      return res.status(201).json({ strategy: full });
    }

    if (req.method === 'PUT') {
      if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const patch = {};
      if (typeof body.name         === 'string') patch.name         = body.name.slice(0, 200);
      if (typeof body.entry_signal === 'string') patch.entry_signal = body.entry_signal.slice(0, 2000);
      if (typeof body.sl_signal    === 'string') patch.sl_signal    = body.sl_signal.slice(0, 2000);
      if (typeof body.tp_signal    === 'string') patch.tp_signal    = body.tp_signal.slice(0, 2000);
      if (Number.isFinite(body?.risk_pct)) patch.risk_pct = Number(body.risk_pct);
      if (Array.isArray(body.sessions))    patch.sessions = body.sessions.slice(0, 20);
      if (typeof body.note         === 'string') patch.note         = body.note.slice(0, 5000);

      const { data: updated, error } = await supabaseAdmin
        .from('sa_strategies').update(patch)
        .eq('id', id).eq('owner_id', ctx.userId).select('*').maybeSingle();
      if (error) throw new Error('update: ' + error.message);
      if (!updated) return res.status(404).json({ error: 'Strategie niet gevonden' });

      // Destructive replace van steps + checklist als aangeleverd.
      if (Array.isArray(body.steps)) {
        await supabaseAdmin.from('sa_strategy_steps')
          .delete().eq('strategy_id', id).eq('owner_id', ctx.userId);
        const steps = normSteps(body.steps, id, ctx.userId);
        if (steps.length > 0) await supabaseAdmin.from('sa_strategy_steps').insert(steps);
      }
      if (Array.isArray(body.checklist)) {
        await supabaseAdmin.from('sa_checklist_items')
          .delete().eq('strategy_id', id).eq('owner_id', ctx.userId);
        const cl = normChecklist(body.checklist, id, ctx.userId);
        if (cl.length > 0) await supabaseAdmin.from('sa_checklist_items').insert(cl);
      }

      const full = await loadFull(id, ctx.userId);
      return res.status(200).json({ strategy: full });
    }

    if (req.method === 'DELETE') {
      if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      // Steps + checklist ook opruimen (defensief; als DB cascade heeft is dit no-op).
      await supabaseAdmin.from('sa_strategy_steps')
        .delete().eq('strategy_id', id).eq('owner_id', ctx.userId);
      await supabaseAdmin.from('sa_checklist_items')
        .delete().eq('strategy_id', id).eq('owner_id', ctx.userId);
      const { error } = await supabaseAdmin.from('sa_strategies')
        .delete().eq('id', id).eq('owner_id', ctx.userId);
      if (error) throw new Error('delete: ' + error.message);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sa-strategy]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
