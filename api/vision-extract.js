import Anthropic from '@anthropic-ai/sdk';
import { requireCrmStaff } from './_lib/crm-roles.js';
import { checkRateLimit } from './_lib/rate-limit.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  // [M-03 fix 2026-08-25] Auth-gate + rate-limit. Voorheen anon-callable →
  // attacker kon Anthropic-quota leegtrekken via loop. Vision-extract kost
  // veel tokens (max_tokens 4096 + image-input).
  const auth = await requireCrmStaff(req);
  if (!auth) return res.status(403).json({ error: 'Toegang geweigerd. CRM-staff-rol vereist.' });
  const rl = await checkRateLimit({ req, bucket: 'vision-extract', maxHits: 20, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Te veel verzoeken — wacht een minuut.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY niet geconfigureerd. Voeg een API key toe in Vercel → Settings → Environment Variables.'
    });
  }

  const body = typeof req.body === 'string'
    ? JSON.parse(req.body || '{}')
    : (req.body || {});
  const { image, mimeType } = body;
  if (!image) {
    return res.status(400).json({ error: 'Body moet "image" bevatten (base64 string).' });
  }

  // Strip data-URI prefix als die er is (sommige browsers sturen
  // "data:image/png;base64,XXXX" — Anthropic verwacht alleen "XXXX").
  const cleanImage = image.includes(',') ? image.split(',')[1] : image;
  const cleanMime = mimeType || 'image/png';

  const client = new Anthropic({ apiKey });

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: cleanMime, data: cleanImage }
          },
          {
            type: 'text',
            text:
              'Extract ALLE leesbare tekst uit deze afbeelding (dit is meestal een screenshot ' +
              'van een e-mail, document of chat). Behoud structuur waar mogelijk — losse ' +
              'regels blijven losse regels, alinea\'s blijven alinea\'s. Geef de tekst terug ' +
              'in dezelfde taal als in de afbeelding. ' +
              'GEEN extra commentaar, GEEN inleiding, GEEN markdown opmaak — alleen de ' +
              'kale geëxtraheerde tekst.'
          }
        ]
      }]
    });

    const text = message.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();

    return res.status(200).json({ text, model: message.model });
  } catch (err) {
    return res.status(500).json({ error: `Vision API fout: ${err.message}` });
  }
}
