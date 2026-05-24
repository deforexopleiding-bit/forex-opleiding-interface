// api/kb-auto-tag.js
// AI tag-suggesties voor een kennisbank-item (Claude Sonnet 4.6 — snel/goedkoop).
//   POST { item_id, content }  → { suggested_tags: [name], reasoning, tokens_used }
// Suggesties worden gevalideerd tegen de echte kb_tags-lijst (geen verzonnen tags).
//
// Auth: verifyAdmin (hard) + requirePermissionFailOpen('kennisbank.item.edit').

import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

const MODEL = 'claude-sonnet-4-6'; // sneller + goedkoper dan Opus; tagging is low-stakes

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const auth = await verifyAdmin(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await requirePermissionFailOpen(req, 'kennisbank.item.edit'))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

  try {
    const { item_id, content } = req.body || {};
    if (!item_id || !content) return res.status(400).json({ error: 'item_id + content required' });

    // Beschikbare tags ophalen
    const { data: tags } = await supabaseAdmin.from('kb_tags').select('name, description');
    if (!tags || !tags.length) {
      return res.status(200).json({ suggested_tags: [], reasoning: 'Er zijn nog geen tags om uit te kiezen.', tokens_used: 0 });
    }
    const tagList = tags.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n');

    const systemPrompt = `Je bent een AI die kennisbank-items tagt voor een trading-opleiding bedrijf (De Forex Opleiding).

Beschikbare tags:
${tagList}

Analyseer de content van het item en stel relevante tags voor.
- Kies ALLEEN uit bovenstaande lijst (gebruik exact de naam)
- Stel 1-4 tags voor (niet te veel)
- Alleen tags die echt relevant zijn voor de content
- Geef geen tags die niet bestaan in de lijst

Antwoord UITSLUITEND met geldige JSON:
{"suggested_tags": ["tag1", "tag2"], "reasoning": "korte uitleg waarom deze tags"}`;

    const client = new Anthropic({ apiKey });
    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Item content:\n\n${String(content).substring(0, 2000)}` }],
      });
    } catch (err) {
      console.error('kb-auto-tag Anthropic error:', err?.message || err);
      return res.status(502).json({ error: `AI-suggestie mislukt: ${err?.message || 'onbekende fout'}` });
    }

    const text = response.content?.[0]?.text || '';
    const cleaned = text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}');
      parsed = JSON.parse(s !== -1 && e > s ? cleaned.slice(s, e + 1) : cleaned);
    } catch (e) {
      return res.status(500).json({ error: 'AI gaf ongeldige JSON terug', raw: text });
    }

    // Valideren: alleen tags die echt bestaan
    const validNames = new Set(tags.map((t) => t.name));
    const validSuggestions = (parsed.suggested_tags || []).filter((name) => validNames.has(name));

    return res.status(200).json({
      suggested_tags: validSuggestions,
      reasoning: parsed.reasoning || '',
      tokens_used: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    });
  } catch (err) {
    console.error('kb-auto-tag error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
