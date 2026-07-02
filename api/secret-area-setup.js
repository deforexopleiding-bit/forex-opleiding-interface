// api/secret-area-setup.js
//
// Owner-gated setup-model + requirements editor. Definitie-laag: modellen
// (bv. Confirmation / Continuation / Range-break) per strategie, met eisen
// (kind='vereist' | 'confluentie') en per model een min_confluence-drempel.
//
// Semantiek (bewaakt door callers, NIET hier):
//   Geldig = ALLE 'vereist'-eisen aanwezig ÉN Σ(weight van 'confluentie'-
//   eisen die aanwezig zijn) >= min_confluence.
//
// Endpoint is puur CRUD op de twee tabellen:
//   sa_setup_models       (owner_id, strategy_id, name, min_confluence,
//                          position, active)
//   sa_setup_requirements (owner_id, model_id, label, kind, weight,
//                          tool_id?, position)
//
// Routes:
//   GET  ?strategy_id=UUID     → { models: [ {...model, requirements:[...] } ] }
//   POST { entity:'model',        strategy_id, name, min_confluence? }
//                                → { model: … }
//   PUT  ?id                     { entity:'model',       name?, min_confluence?, active?, position? }
//                                → { model: … }
//   DELETE ?id&entity=model     → { ok:true }    // cascade requirements door FK
//   POST { entity:'requirement',  model_id, label, kind, weight?, tool_id?, position? }
//                                → { requirement: … }
//   PUT  ?id                     { entity:'requirement', label?, kind?, weight?, tool_id?, position?, active? }
//                                → { requirement: … }
//   DELETE ?id&entity=requirement → { ok:true }
//
// Auth: requireOwner() als eerste server-side actie (zie andere secret-area-
// endpoints). 403 bij null.

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS   = new Set(['vereist', 'confluentie']);
const MAX_NAME_LEN  = 120;
const MAX_LABEL_LEN = 500;

async function assertStrategyOwned(userId, strategyId) {
  const { data } = await supabaseAdmin.from('sa_strategies')
    .select('id').eq('id', strategyId).eq('owner_id', userId).maybeSingle();
  return !!data;
}
async function assertModelOwned(userId, modelId) {
  const { data } = await supabaseAdmin.from('sa_setup_models')
    .select('id').eq('id', modelId).eq('owner_id', userId).maybeSingle();
  return !!data;
}
async function assertToolOwned(userId, toolId) {
  const { data } = await supabaseAdmin.from('sa_tools')
    .select('id').eq('id', toolId).eq('owner_id', userId).maybeSingle();
  return !!data;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  const id     = typeof req.query?.id     === 'string' ? req.query.id.trim()     : '';
  const entity = typeof req.query?.entity === 'string' ? req.query.entity.trim() : '';

  try {
    // ── GET: modellen + requirements voor één strategie ────────────────
    if (req.method === 'GET') {
      const strategyId = typeof req.query?.strategy_id === 'string' ? req.query.strategy_id.trim() : '';
      if (!UUID_RE.test(strategyId)) return res.status(400).json({ error: 'strategy_id (uuid) vereist' });
      if (!(await assertStrategyOwned(ctx.userId, strategyId))) {
        return res.status(404).json({ error: 'Strategie niet gevonden' });
      }
      const { data: models, error: mErr } = await supabaseAdmin
        .from('sa_setup_models')
        .select('id, strategy_id, name, min_confluence, position, active, created_at, updated_at')
        .eq('owner_id', ctx.userId).eq('strategy_id', strategyId)
        .order('position', { ascending: true });
      if (mErr) throw new Error('models: ' + mErr.message);
      const ids = (models || []).map((m) => m.id);
      let reqs = [];
      if (ids.length) {
        const { data: rq, error: rErr } = await supabaseAdmin
          .from('sa_setup_requirements')
          .select('id, model_id, label, kind, weight, tool_id, position, active, created_at, updated_at')
          .eq('owner_id', ctx.userId).in('model_id', ids)
          .order('position', { ascending: true });
        if (rErr) throw new Error('requirements: ' + rErr.message);
        reqs = rq || [];
      }
      const out = (models || []).map((m) => ({
        ...m,
        requirements: reqs.filter((r) => r.model_id === m.id),
      }));
      return res.status(200).json({ models: out });
    }

    // ── POST: create model of requirement ─────────────────────────────
    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const ent  = typeof body.entity === 'string' ? body.entity.trim() : entity;
      if (ent === 'model') {
        const strategyId    = typeof body.strategy_id === 'string' ? body.strategy_id.trim() : '';
        const name          = typeof body.name === 'string' ? body.name.slice(0, MAX_NAME_LEN).trim() : '';
        const minConfluence = Number.isFinite(body?.min_confluence) ? Number(body.min_confluence) : 0;
        if (!UUID_RE.test(strategyId)) return res.status(400).json({ error: 'strategy_id (uuid) vereist' });
        if (!name)                     return res.status(400).json({ error: 'name vereist' });
        if (minConfluence < 0)         return res.status(400).json({ error: 'min_confluence moet >= 0 zijn' });
        if (!(await assertStrategyOwned(ctx.userId, strategyId))) {
          return res.status(404).json({ error: 'Strategie niet gevonden' });
        }
        const { data: created, error } = await supabaseAdmin.from('sa_setup_models').insert({
          owner_id:       ctx.userId,
          strategy_id:    strategyId,
          name,
          min_confluence: minConfluence,
          position:       Number.isFinite(body?.position) ? Number(body.position) : 0,
          active:         body.active === false ? false : true,
        }).select('*').single();
        if (error) throw new Error('model insert: ' + error.message);
        return res.status(201).json({ model: created });
      }
      if (ent === 'requirement') {
        const modelId = typeof body.model_id === 'string' ? body.model_id.trim() : '';
        const label   = typeof body.label    === 'string' ? body.label.slice(0, MAX_LABEL_LEN).trim() : '';
        const kind    = typeof body.kind     === 'string' ? body.kind.trim() : '';
        const weight  = Number.isFinite(body?.weight) ? Number(body.weight) : 1;
        let toolId    = typeof body.tool_id  === 'string' && body.tool_id.trim() ? body.tool_id.trim() : null;
        if (!UUID_RE.test(modelId)) return res.status(400).json({ error: 'model_id (uuid) vereist' });
        if (!label)                 return res.status(400).json({ error: 'label vereist' });
        if (!KINDS.has(kind))       return res.status(400).json({ error: "kind moet 'vereist' of 'confluentie' zijn" });
        if (weight < 0)             return res.status(400).json({ error: 'weight moet >= 0 zijn' });
        if (!(await assertModelOwned(ctx.userId, modelId))) {
          return res.status(404).json({ error: 'Model niet gevonden' });
        }
        if (toolId) {
          if (!UUID_RE.test(toolId)) return res.status(400).json({ error: 'tool_id ongeldig' });
          if (!(await assertToolOwned(ctx.userId, toolId))) toolId = null; // silent-strip
        }
        const { data: created, error } = await supabaseAdmin.from('sa_setup_requirements').insert({
          owner_id: ctx.userId,
          model_id: modelId,
          label, kind, weight,
          tool_id:  toolId,
          position: Number.isFinite(body?.position) ? Number(body.position) : 0,
          active:   body.active === false ? false : true,
        }).select('*').single();
        if (error) throw new Error('requirement insert: ' + error.message);
        return res.status(201).json({ requirement: created });
      }
      return res.status(400).json({ error: "entity moet 'model' of 'requirement' zijn" });
    }

    // ── PUT: update ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const ent  = typeof body.entity === 'string' ? body.entity.trim() : entity;
      if (ent === 'model') {
        const patch = {};
        if (typeof body.name === 'string')            patch.name = body.name.slice(0, MAX_NAME_LEN).trim();
        if (Number.isFinite(body?.min_confluence))    patch.min_confluence = Math.max(0, Number(body.min_confluence));
        if (typeof body.active === 'boolean')         patch.active = body.active;
        if (Number.isFinite(body?.position))          patch.position = Number(body.position);
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'niks om te updaten' });
        const { data: updated, error } = await supabaseAdmin.from('sa_setup_models')
          .update(patch).eq('id', id).eq('owner_id', ctx.userId).select('*').maybeSingle();
        if (error) throw new Error('model update: ' + error.message);
        if (!updated) return res.status(404).json({ error: 'Model niet gevonden' });
        return res.status(200).json({ model: updated });
      }
      if (ent === 'requirement') {
        const patch = {};
        if (typeof body.label === 'string')           patch.label = body.label.slice(0, MAX_LABEL_LEN).trim();
        if (typeof body.kind  === 'string') {
          if (!KINDS.has(body.kind)) return res.status(400).json({ error: "kind moet 'vereist' of 'confluentie' zijn" });
          patch.kind = body.kind;
        }
        if (Number.isFinite(body?.weight))            patch.weight = Math.max(0, Number(body.weight));
        if (Number.isFinite(body?.position))          patch.position = Number(body.position);
        if (typeof body.active === 'boolean')         patch.active = body.active;
        // tool_id: null of uuid; ontkoppelen door tool_id: null.
        if ('tool_id' in body) {
          if (body.tool_id == null || body.tool_id === '') patch.tool_id = null;
          else if (typeof body.tool_id === 'string' && UUID_RE.test(body.tool_id.trim())) {
            const okTool = await assertToolOwned(ctx.userId, body.tool_id.trim());
            patch.tool_id = okTool ? body.tool_id.trim() : null;
          } else {
            return res.status(400).json({ error: 'tool_id ongeldig' });
          }
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'niks om te updaten' });
        const { data: updated, error } = await supabaseAdmin.from('sa_setup_requirements')
          .update(patch).eq('id', id).eq('owner_id', ctx.userId).select('*').maybeSingle();
        if (error) throw new Error('requirement update: ' + error.message);
        if (!updated) return res.status(404).json({ error: 'Eis niet gevonden' });
        return res.status(200).json({ requirement: updated });
      }
      return res.status(400).json({ error: "entity moet 'model' of 'requirement' zijn" });
    }

    // ── DELETE ────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      if (entity === 'model') {
        // sa_setup_requirements FK cascade: als de DB die niet doet, ruimen we
        // ze zelf op eerst om weeskinderen te voorkomen.
        await supabaseAdmin.from('sa_setup_requirements')
          .delete().eq('model_id', id).eq('owner_id', ctx.userId);
        const { error } = await supabaseAdmin.from('sa_setup_models')
          .delete().eq('id', id).eq('owner_id', ctx.userId);
        if (error) throw new Error('model delete: ' + error.message);
        return res.status(200).json({ ok: true });
      }
      if (entity === 'requirement') {
        const { error } = await supabaseAdmin.from('sa_setup_requirements')
          .delete().eq('id', id).eq('owner_id', ctx.userId);
        if (error) throw new Error('requirement delete: ' + error.message);
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "entity moet 'model' of 'requirement' zijn" });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sa-setup]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
