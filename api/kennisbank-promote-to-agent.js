// api/kennisbank-promote-to-agent.js
//
// POST → kopieer een kennisbank_artikel naar de agent-specifieke kennis:
//   - trio (joost/simone/mila) → joost_config.knowledge_base[<onderwerp>] = content
//   - lisa                     → append aan lisa_config.kb_faq (via lisa-config save_draft)
//
// Body: { artikel_id: uuid, target_agent: 'joost'|'simone'|'mila'|'lisa' }
//
// Voor Joost: BEWERKEN persona/toon/KB is expliciet toegestaan (persona-scope
// is scheidbaar van incasso-reken-logica). Model/temperature/context/autonomy
// blijven read-only via de UI en worden hier NIET geraakt.
//
// Bumped usage_count op het artikel na succes.
//
// Fail-soft 503 (MIGRATION_MISSING) als de kennisbank_artikelen-tabel er nog
// niet is; 400 als target_agent niet mapt op een backend-module.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_TO_MODULE = { joost: 'finance', simone: 'events', mila: 'onboarding' };

function isMissingTable(err) {
  if (!err) return false;
  return err.code === '42P01' || /relation .* does not exist/i.test(err.message || '');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const body = req.body || {};
  const artikel_id   = (body.artikel_id || '').toString();
  const target_agent = (body.target_agent || '').toString().toLowerCase();

  if (!UUID_RX.test(artikel_id)) return res.status(400).json({ error: 'artikel_id ongeldig (uuid vereist)' });
  if (!['joost','simone','mila','lisa'].includes(target_agent)) {
    return res.status(400).json({ error: 'target_agent moet joost/simone/mila/lisa zijn' });
  }

  try {
    // 1) Fetch artikel
    const { data: art, error: artErr } = await supabaseAdmin
      .from('kennisbank_artikelen')
      .select('id, onderwerp, categorie, content, agents, usage_count')
      .eq('id', artikel_id)
      .maybeSingle();
    if (artErr) {
      if (isMissingTable(artErr)) return res.status(503).json({
        error: 'kennisbank_artikelen-tabel bestaat nog niet. Draai migratie 2026-08-13-kennisbank-artikelen.sql.',
        code: 'MIGRATION_MISSING',
      });
      throw artErr;
    }
    if (!art) return res.status(404).json({ error: 'artikel niet gevonden' });

    // 2) Target agent → welke config
    if (target_agent === 'lisa') {
      // Append aan kb_faq van de actieve Lisa-versie via save_draft.
      // We lezen huidige kb_faq, appenden {vraag: onderwerp, antwoord: content}, en schrijven terug.
      const { data: lisaRow, error: lisaErr } = await supabaseAdmin
        .from('lisa_config')
        .select('id, version, kb_faq, is_active')
        .eq('is_active', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lisaErr) throw lisaErr;
      if (!lisaRow) return res.status(500).json({ error: 'Geen actieve Lisa-config gevonden' });
      const cur = Array.isArray(lisaRow.kb_faq) ? lisaRow.kb_faq : [];
      const already = cur.some((q) => q && q.vraag === art.onderwerp);
      if (already) return res.status(409).json({ error: 'Artikel staat al in Lisa kb_faq (zelfde vraag)' });
      const next = [...cur, { vraag: art.onderwerp, antwoord: art.content || '', keywords: [] }];
      const { error: upErr } = await supabaseAdmin
        .from('lisa_config')
        .update({ kb_faq: next })
        .eq('id', lisaRow.id);
      if (upErr) throw upErr;
    } else {
      // Trio: joost_config.knowledge_base[onderwerp] = content (of {answer, categorie}).
      const moduleKey = AGENT_TO_MODULE[target_agent];
      const { data: cfg, error: cfgErr } = await supabaseAdmin
        .from('joost_config')
        .select('module, knowledge_base')
        .eq('module', moduleKey)
        .maybeSingle();
      if (cfgErr) throw cfgErr;
      const base = (cfg?.knowledge_base && typeof cfg.knowledge_base === 'object' && !Array.isArray(cfg.knowledge_base))
        ? { ...cfg.knowledge_base } : {};
      // Gebruik onderwerp als key (slugified) om collisies te beperken.
      const key = String(art.onderwerp || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || ('artikel_' + artikel_id.slice(0,8));
      if (base[key] !== undefined) return res.status(409).json({ error: 'Sleutel bestaat al in knowledge_base: ' + key });
      base[key] = art.content || '';
      if (cfg) {
        const { error: upErr } = await supabaseAdmin
          .from('joost_config').update({ knowledge_base: base, updated_by_user_id: user.id })
          .eq('module', moduleKey);
        if (upErr) throw upErr;
      } else {
        const { error: insErr } = await supabaseAdmin
          .from('joost_config').insert({ module: moduleKey, knowledge_base: base, updated_by_user_id: user.id });
        if (insErr) throw insErr;
      }
    }

    // 3) Bump usage_count + zorg dat agent in agents-array staat (best-effort)
    try {
      const nextAgents = Array.isArray(art.agents) ? [...new Set([...art.agents, target_agent])] : [target_agent];
      await supabaseAdmin
        .from('kennisbank_artikelen')
        .update({ usage_count: (art.usage_count || 0) + 1, agents: nextAgents })
        .eq('id', artikel_id);
    } catch (e) {
      console.warn('[promote-to-agent] usage bump faalde:', e?.message || e);
    }

    return res.status(200).json({ ok: true, artikel_id, target_agent });
  } catch (e) {
    console.error('[promote-to-agent]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
