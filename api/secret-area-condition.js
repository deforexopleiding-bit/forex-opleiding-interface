// api/secret-area-condition.js
// Owner-gated marktcondities. Scope: 'global' (workspace-breed) OF 'strategy'
// (gebonden aan een strategy_id — geërfd bij alle sessies/setups).
// ctype = 'filter' (nooit als …) / 'voorwaarde' (alleen als …) / 'uitzondering'
// (tenzij …). Frontend hangt de mens-vriendelijke prefix aan het label.
//
//   GET                      → { conditions: [ …owner-scoped ] }
//   POST { scope, ctype, label, strategy_id?, position? }
//                            → { condition: <ins> }
//   PUT ?id  { label?, active?, position? }
//                            → { condition: <upd> }
//   DELETE ?id               → { ok:true }

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';

const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES    = new Set(['global', 'strategy']);
const CTYPES    = new Set(['filter', 'voorwaarde', 'uitzondering']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('sa_conditions')
        .select('*')
        .eq('owner_id', ctx.userId)
        .order('position', { ascending: true });
      if (error) throw new Error('list: ' + error.message);
      return res.status(200).json({ conditions: data || [] });
    }

    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const scope = typeof body.scope === 'string' ? body.scope.trim() : '';
      const ctype = typeof body.ctype === 'string' ? body.ctype.trim() : '';
      const label = typeof body.label === 'string' ? body.label.slice(0, 500).trim() : '';
      if (!SCOPES.has(scope))  return res.status(400).json({ error: "scope moet 'global' of 'strategy' zijn" });
      if (!CTYPES.has(ctype))  return res.status(400).json({ error: "ctype moet 'filter'|'voorwaarde'|'uitzondering' zijn" });
      if (!label)              return res.status(400).json({ error: 'label vereist' });
      const strategyId = typeof body.strategy_id === 'string' ? body.strategy_id.trim() : null;
      if (scope === 'strategy') {
        if (!strategyId || !UUID_RE.test(strategyId)) {
          return res.status(400).json({ error: "strategy_id (uuid) vereist bij scope='strategy'" });
        }
        const { data: strat } = await supabaseAdmin.from('sa_strategies')
          .select('id').eq('id', strategyId).eq('owner_id', ctx.userId).maybeSingle();
        if (!strat) return res.status(404).json({ error: 'Strategie niet gevonden' });
      }
      const row = {
        owner_id:    ctx.userId,
        scope,
        ctype,
        label,
        strategy_id: scope === 'strategy' ? strategyId : null,
        position:    Number.isFinite(body?.position) ? Number(body.position) : 0,
        active:      body.active === false ? false : true,
      };
      const { data: created, error } = await supabaseAdmin
        .from('sa_conditions').insert(row).select('*').single();
      if (error) throw new Error('insert: ' + error.message);
      return res.status(201).json({ condition: created });
    }

    if (req.method === 'PUT') {
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const patch = {};
      if (typeof body.label    === 'string')  patch.label    = body.label.slice(0, 500).trim();
      if (typeof body.active   === 'boolean') patch.active   = body.active;
      if (Number.isFinite(body?.position))    patch.position = Number(body.position);
      const { data: updated, error } = await supabaseAdmin
        .from('sa_conditions').update(patch)
        .eq('id', id).eq('owner_id', ctx.userId).select('*').maybeSingle();
      if (error) throw new Error('update: ' + error.message);
      if (!updated) return res.status(404).json({ error: 'Conditie niet gevonden' });
      return res.status(200).json({ condition: updated });
    }

    if (req.method === 'DELETE') {
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      const { error } = await supabaseAdmin.from('sa_conditions')
        .delete().eq('id', id).eq('owner_id', ctx.userId);
      if (error) throw new Error('delete: ' + error.message);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sa-condition]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
