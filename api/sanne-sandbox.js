// api/sanne-sandbox.js
// POST { history: [{role, content}], user_input } -> Sanne's antwoord op basis
// van de huidige persona/prompt uit joost_config module='email'.
//
// Zelfde LLM-call als sanne-suggest maar zonder skip-filter, zonder DB-write,
// zonder autonomy-eval, zonder tool-use. Puur voor testchat in agents-v2.
//
// Permission: admin.joost_config (dezelfde als config-UI — dit is een test-tool).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { anthropicMessages, AnthropicClientError } from './_lib/anthropic-client.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const b = req.body || {};
  const history = Array.isArray(b.history) ? b.history.slice(-20) : [];
  // Accepteer zowel `user_input` (native shape) als `message` (agent-sandbox-chat shape).
  const userInput = (typeof b.user_input === 'string' ? b.user_input :
                     typeof b.message === 'string' ? b.message : '').trim();
  if (!userInput) return res.status(400).json({ error: 'user_input (of message) verplicht' });

  try {
    const { data: config } = await supabaseAdmin.from('joost_config')
      .select('persona_name, system_prompt_template, model, temperature')
      .eq('module', 'email').maybeSingle();
    if (!config) return res.status(503).json({ error: 'Sanne-config ontbreekt' });

    // Vervang alleen company_name — sandbox heeft geen echte mail-context.
    const systemPrompt = String(config.system_prompt_template || '')
      .replace(/\{\{company_name\}\}/g, 'De Forex Opleiding NL B.V.')
      .replace(/\{\{[a-z_]+\}\}/g, '(oefengesprek — geen echte klantdata)');

    const messages = [];
    for (const m of history) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const c = typeof m.content === 'string' ? m.content : '';
      if (!c) continue;
      messages.push({ role: m.role, content: c.slice(0, 2000) });
    }
    messages.push({ role: 'user', content: userInput.slice(0, 4000) });

    const data = await anthropicMessages({
      system: systemPrompt,
      messages,
      model: config.model || 'claude-sonnet-4-6',
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.3,
      max_tokens: 1024,
    });

    const textBlocks = Array.isArray(data?.content) ? data.content.filter((b) => b?.type === 'text') : [];
    const reply = textBlocks.map((b) => b.text).join('\n').trim() || '(geen antwoord)';

    return res.status(200).json({ reply, model: data?.model || null });
  } catch (e) {
    if (e instanceof AnthropicClientError && e.code === 'ANTHROPIC_KEY_MISSING') {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
    }
    console.error('[sanne-sandbox]', e?.message);
    return res.status(502).json({ error: e?.message || 'Anthropic-fout' });
  }
}
