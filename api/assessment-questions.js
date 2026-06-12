// api/assessment-questions.js
// PUBLIEKE GET-endpoint: returnt de actieve assessment-vragen voor de
// publieke /modules/assessment.html pagina. Geen auth (deelnemers zijn niet
// ingelogd). routing_weights + is_routing worden uitgesneden zodat de
// scoring-config server-side blijft.
//
// Response 200: { questions: [{ key, section, order_index, type, label,
//                               help_text, required, options, min_words }] }
// Response 405: GET-only
// Response 500: database-fout

import { loadActiveQuestions, sanitizeQuestionsForPublic } from './_lib/assessment-validation.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  try {
    const questions = await loadActiveQuestions();
    return res.status(200).json({
      questions: sanitizeQuestionsForPublic(questions),
    });
  } catch (e) {
    console.error('[assessment-questions]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
