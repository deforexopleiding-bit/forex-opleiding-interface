import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT =
  'Je bent een taakplanning assistent voor De Forex Opleiding. ' +
  'Analyseer de e-mailinhoud en genereer een concrete, actiegerichte taakomschrijving van maximaal 2 zinnen. ' +
  'Beschrijf WAT er gedaan moet worden, niet waarom. ' +
  'Schrijf in het Nederlands, direct en to the point. ' +
  'Geen inleiding, geen afsluiting — alleen de taakomschrijving zelf.';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd.' });
  }

  const { subject, from, category, body, reply } = req.body || {};
  if (!subject && !body) {
    return res.status(400).json({ error: 'subject of body vereist' });
  }

  const lines = [
    `E-mail van: ${from || 'Onbekend'}`,
    `Onderwerp: ${subject || '(geen onderwerp)'}`,
    `Categorie: ${category || 'Algemeen'}`,
    `Inhoud: ${(body || '').slice(0, 600) || '(niet beschikbaar)'}`,
  ];
  if (reply) lines.push(`Verstuurd antwoord: ${reply.slice(0, 200)}`);
  lines.push('\nGenereer een concrete taakomschrijving.');

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: lines.join('\n') }],
    });

    const text = (msg.content?.[0]?.text || '').trim();
    if (!text) return res.status(500).json({ error: 'Lege respons van AI' });

    console.log(`[generate-task] uid snippet: "${(bodySnippet || '').slice(0, 40)}" → "${text.slice(0, 60)}"`);
    return res.status(200).json({ description: text });
  } catch (err) {
    console.error('[generate-task] fout:', err.message);
    return res.status(500).json({ error: err.message || 'Onbekende AI fout' });
  }
}
