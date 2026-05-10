import Anthropic from '@anthropic-ai/sdk';

const SYSTEM_PROMPT = `Je bent een vriendelijke en persoonlijke e-mailassistent voor De Forex Opleiding. \
Je schrijft altijd in het Nederlands. Je tone of voice is warm, professioneel en persoonlijk. \
Je reageert specifiek op de inhoud van de e-mail die je ontvangt. \
Je gebruikt de kennisbank voorbeelden als leidraad voor je schrijfstijl en antwoorden. \
Je ondertekent altijd namens Team De Forex Opleiding.

Schrijf alleen de e-mailtekst — geen introductiezin zoals "Hier is het antwoord:" of uitleg. \
Begin direct met de aanhef (bijv. "Beste [naam],") en sluit af met een ondertekening.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is niet geconfigureerd. Voeg deze toe aan Vercel → Settings → Environment Variables.'
    });
  }

  const { email, kennisbankContext, learningExamples } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: 'email ontbreekt in request body' });
  }

  const client = new Anthropic({ apiKey });

  // Bouw de gebruikers-context op
  const parts = [];

  // Bedrijfsprofiel uit kennisbank
  if (kennisbankContext?.profile) {
    parts.push(`## Bedrijfsprofiel\n${kennisbankContext.profile}`);
  }

  // Kennisbank-items (FAQ, stijlgids, etc.)
  if (kennisbankContext?.items?.length) {
    const itemText = kennisbankContext.items
      .map((item) => {
        const lines = [];
        if (item.title) lines.push(`### ${item.title}`);
        if (item.category) lines.push(`Categorie: ${item.category}`);
        if (item.content) lines.push(item.content);
        if (item.question && item.answer) {
          lines.push(`V: ${item.question}\nA: ${item.answer}`);
        }
        return lines.join('\n');
      })
      .join('\n\n');
    parts.push(`## Kennisbank\n${itemText}`);
  }

  // Leervoorbeelden: eerder goedgekeurde/bewerkte antwoorden als few-shot
  if (learningExamples?.length) {
    const recent = learningExamples.slice(-5); // max 5 meest recente
    const exText = recent
      .map((ex) =>
        `Categorie: ${ex.category}\nOnderwerp: ${ex.originalEmail?.subject || '—'}\nGoedgekeurd antwoord:\n${ex.userVersion}`
      )
      .join('\n\n---\n\n');
    parts.push(`## Eerdere goedgekeurde antwoorden (schrijfstijl leidraad)\n${exText}`);
  }

  // De te beantwoorden e-mail
  const emailSection = [
    '## Te beantwoorden e-mail',
    `Van: ${email.from || email.fromAddress || 'Onbekend'}`,
    `Aan: ${email.mailbox || '—'}`,
    `Onderwerp: ${email.subject || '(geen onderwerp)'}`,
    `Categorie: ${email.category || 'Overig'}`,
    '',
    email.body ? `Inhoud:\n${email.body}` : '(Geen e-mailinhoud beschikbaar — baseer het antwoord op het onderwerp en de categorie.)'
  ].join('\n');
  parts.push(emailSection);

  const userMessage = parts.join('\n\n') +
    '\n\nSchrijf een passend antwoord op deze e-mail.';

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const reply = response.content[0]?.text?.trim() || '';
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Anthropic API error:', err);
    return res.status(500).json({
      error: `AI-generatie mislukt: ${err.message || 'onbekende fout'}`
    });
  }
}
