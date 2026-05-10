import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `Je bent een e-mailclassificator voor De Forex Opleiding.
Categoriseer de inkomende e-mail in precies één van de volgende categorieën:
- Nieuwe Lead (iemand heeft interesse getoond via een formulier of cold bericht)
- Appointment (een sessie, uitlegsessie of afspraak is ingepland of bevestigd)
- Event Aanmelding (aanmelding voor een event, seminar of webinar)
- Klantvraag (bestaande klant stelt een vraag over de opleiding of diensten)
- Factuurvraag (vraag over een factuur, betaling of administratie)
- Reclame (marketing, nieuwsbrief, promotie, koude acquisitie of spam)
- Overig (past nergens anders in)
Geef ALLEEN de categorienaam terug, niets anders.`;

const VALID_CATEGORIES = ['Nieuwe Lead','Appointment','Event Aanmelding','Klantvraag','Factuurvraag','Reclame','Overig'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
  }

  const { from, subject, bodySnippet } = req.body || {};
  if (!from && !subject) {
    return res.status(400).json({ error: 'from of subject vereist' });
  }

  const client = new Anthropic({ apiKey });

  const parts = [
    'Van: ' + (from || '—'),
    'Onderwerp: ' + (subject || '—'),
  ];
  if (bodySnippet) {
    parts.push('Inhoud (eerste 500 tekens):\n' + String(bodySnippet).slice(0, 500));
  }

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: parts.join('\n') }]
    });

    const raw = (response.content[0]?.text || '').trim();
    const category = VALID_CATEGORIES.find((c) => raw.includes(c)) || 'Overig';
    return res.status(200).json({ category });
  } catch (err) {
    console.error('Categorize API error:', err);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
}
