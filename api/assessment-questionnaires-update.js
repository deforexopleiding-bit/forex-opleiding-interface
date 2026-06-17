// api/assessment-questionnaires-update.js
//
// FEATURE C — PATCH: bestaande assessment-vragenlijst aanpassen.
// Query: ?id=<uuid>  |  body.id=<uuid>
// Body (alle velden optioneel):
//   {
//     name?: string,                      // 1..200 chars na trim
//     gevorderd_threshold?: integer >= 0,
//     motivatie_floor?:     integer >= 0,
//     low_mid_threshold?:   integer >= 0,
//   }
//
// Permission: admin.joost_config.
//
// is_active wordt NIET door deze endpoint gewijzigd — gebruik -activate
// (exclusief in transactie) zodat de "exact 1 actief"-invariant veilig blijft.
// slug is immutable (forwards-compat: response.questionnaire_id-FK is gekoppeld
// op uuid, niet op slug; slug-rename is daarmee veilig maar hier niet nodig).
//
// FORWARD-ONLY INVARIANT (zelfde idee als assessment_questions):
//   drempel-edits beïnvloeden GEEN bestaande assessment_responses. Score-jsonb
//   en routing_result zijn at-submit vastgelegd; alleen nieuwe submits na
//   deze update gebruiken de nieuwe drempels.
//
// Response 200: { item }
// Response 400/401/403/404/405/500: zie code.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 200;

function validateThreshold(label, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: `${label} moet een integer >= 0 zijn` };
  }
  return { ok: true, value: n };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'PATCH only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const id = (req.query?.id ? String(req.query.id) : null)
    || (typeof body.id === 'string' ? body.id : null);
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id (uuid) vereist via ?id of body.id' });
  }

  const patch = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > MAX_NAME) {
      return res.status(400).json({ error: `name vereist; max ${MAX_NAME} chars` });
    }
    patch.name = body.name.trim();
  }
  if (body.gevorderd_threshold !== undefined) {
    const v = validateThreshold('gevorderd_threshold', body.gevorderd_threshold);
    if (!v.ok) return res.status(400).json({ error: v.error });
    patch.gevorderd_threshold = v.value;
  }
  if (body.motivatie_floor !== undefined) {
    const v = validateThreshold('motivatie_floor', body.motivatie_floor);
    if (!v.ok) return res.status(400).json({ error: v.error });
    patch.motivatie_floor = v.value;
  }
  if (body.low_mid_threshold !== undefined) {
    const v = validateThreshold('low_mid_threshold', body.low_mid_threshold);
    if (!v.ok) return res.status(400).json({ error: v.error });
    patch.low_mid_threshold = v.value;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Geen velden om te updaten' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('assessment_questionnaires')
      .update(patch)
      .eq('id', id)
      .select('id, slug, name, is_active, gevorderd_threshold, motivatie_floor, low_mid_threshold, created_at, updated_at')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Vragenlijst niet gevonden' });
    return res.status(200).json({ item: data });
  } catch (e) {
    console.error('[assessment-questionnaires-update]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
