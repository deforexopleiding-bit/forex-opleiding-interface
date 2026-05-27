// POST /api/learn — Klanten/Email leerlogica endpoint.
//
// Thin wrapper rondom api/_lib/email-learn.js (Fase email-classifier-fix
// commit 1). De leerlogica is verplaatst naar de gedeelde helper zodat
// reclassify-tool + backfill-endpoint dezelfde flow kunnen aanroepen
// (gelijkschakeling Reclassify ↔ Train Agent).
//
// Endpoint-contract (request/response) IDENTIEK aan vorige versie:
//   - Methode: POST
//   - Body: { email_id?, sender, subject?, body_snippet?, old_category?,
//             new_category, corrected_by?, correction_type?,
//             old_requires_action?, new_requires_action?, reason?, email_list? }
//   - 200: { ok, sender_email, new_category, learn_example_id, ..., message }
//   - 400: { error: 'sender en new_category zijn vereist' / 'Ongeldige categorie: X' }
//   - 405: { error: 'Method not allowed' }
//   - 500: { error: <reden> }
//
// Callers (geverifieerd via STAP 0 grep, alle in modules/email.html):
//   - verplaatsNaarSectie() (regel 2090)
//   - bevestigVerplaatsEnTrain() (regel 2155)
//   - (anonieme flow regel 2500)
//   - bulk verplaats-en-train loop (regel 3723)

import { createUserClient } from './supabase.js';
import { applyLearning } from './_lib/email-learn.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createUserClient(req);

  try {
    const result = await applyLearning({ supabase, ...(req.body || {}) });
    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message });
  }
}
