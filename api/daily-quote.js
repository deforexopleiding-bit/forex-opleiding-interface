export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const { leads = 0, conversie = 0 } = req.query;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(200).json({ quote: 'Elke dag een nieuwe kans om te groeien en anderen te inspireren.' });
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: `Geef een korte motiverende quote voor een ondernemer in het financiële onderwijs. Max 1 zin. Nederlands. Vandaag zijn er ${leads} leads binnengekomen met ${conversie}% conversie. Geef alleen de quote zelf, zonder aanhalingstekens of uitleg.`
        }]
      }),
    });

    if (!resp.ok) throw new Error(`Anthropic ${resp.status}`);
    const data = await resp.json();
    const quote = data?.content?.[0]?.text?.trim() || 'Elke dag een nieuwe kans om te groeien.';
    return res.status(200).json({ quote });
  } catch (err) {
    console.warn('[daily-quote]', err.message);
    return res.status(200).json({ quote: 'Elke dag een nieuwe kans om te groeien en anderen te inspireren.' });
  }
}
