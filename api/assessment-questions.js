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
import { getActiveQuestionnaire } from './_lib/assessment-questionnaires.js';
import { safeError } from './_lib/safe-error.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  try {
    // FEATURE C: filter op vragen van de actieve vragenlijst. Bij geen
    // actieve rij (legacy / pre-migration): fall back op alle actieve vragen
    // ongeacht questionnaire_id zodat de publieke flow nooit ineens stilstaat.
    const activeQ = await getActiveQuestionnaire();
    const questions = await loadActiveQuestions(activeQ?.id || null);
    return res.status(200).json({
      questions: sanitizeQuestionsForPublic(questions),
    });
  } catch (e) {
    return safeError(res, 500, e);
  }
}
