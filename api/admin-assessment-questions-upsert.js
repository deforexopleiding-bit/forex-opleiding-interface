// api/admin-assessment-questions-upsert.js
// POST  -> create nieuwe vraag (UNIQUE(key) afgedwongen in DB).
// PATCH -> update bestaande vraag (id via ?id=<uuid> of body.id).
//
// Permission: admin.joost_config (zie list-endpoint voor rationale).
//
// FORWARD-ONLY INVARIANT: edits aan vragen-config beïnvloeden GEEN bestaande
// assessment_responses. Antwoorden zijn verbatim opgeslagen in
// assessment_responses.answers; score-jsonb en routing_result zijn at-submit
// vastgelegd. Alleen NIEUWE inzendingen na deze edit gebruiken de nieuwe
// config. Hard-delete is bewust niet ondersteund -> deactiveren via
// active=false zodat referenties (en eventuele toekomstige join-views)
// gerespecteerd blijven.
//
// Body:
//   key             text     required bij POST; max 64; lowercase a-z0-9_-
//   section         text     required; max 64
//   order_index     integer  >= 0 (default 0 bij create)
//   page            integer  >= 1 (default 1 bij create); stap-/paginanummer voor multi-step
//   type            enum     required bij POST; in ('text','email','radio',
//                            'scale_1_5','scale_1_10','open_text')
//   label           text     required; max 500
//   help_text       text?    max 1000
//   required        boolean  (default true bij create)
//   options         jsonb?   verplicht voor type='radio'; array van
//                            { value:string, label:string }
//   min_words       int?     >= 0; alleen zinvol voor type='open_text'
//   is_routing      boolean  (default false)
//   routing_weights jsonb?   verplicht als is_routing=true; shape:
//                            object met string-keys per optie-value
//                            (radio) of '1'..'5'/'10' (scale) -> number
//   active          boolean  (default true)
//
// Response 200/201: { item: <row> }
// Response 400: validatie-fout (zie code)
// Response 409: UNIQUE(key) conflict (alleen bij POST)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getActiveQuestionnaire } from './_lib/assessment-questionnaires.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE   = /^[a-z0-9_-]{1,64}$/;
const TYPES    = new Set(['text', 'email', 'radio', 'scale_1_5', 'scale_1_10', 'open_text']);

const MAX_LABEL    = 500;
const MAX_HELP     = 1000;
const MAX_SECTION  = 64;

function validatePayload(payload, { isCreate }) {
  // type
  const type = payload.type;
  if (isCreate) {
    if (typeof type !== 'string' || !TYPES.has(type)) {
      return { ok: false, error: `type vereist en moet in ${Array.from(TYPES).join('|')} zitten` };
    }
  } else if (type !== undefined) {
    if (typeof type !== 'string' || !TYPES.has(type)) {
      return { ok: false, error: `type moet in ${Array.from(TYPES).join('|')} zitten` };
    }
  }

  // key (alleen create)
  if (isCreate) {
    if (typeof payload.key !== 'string' || !KEY_RE.test(payload.key)) {
      return { ok: false, error: 'key vereist, lowercase a-z0-9_- en max 64 chars' };
    }
  }
  // section
  if (isCreate || payload.section !== undefined) {
    if (typeof payload.section !== 'string' || !payload.section.trim() || payload.section.length > MAX_SECTION) {
      return { ok: false, error: `section vereist; max ${MAX_SECTION} chars` };
    }
  }
  // label
  if (isCreate || payload.label !== undefined) {
    if (typeof payload.label !== 'string' || !payload.label.trim() || payload.label.length > MAX_LABEL) {
      return { ok: false, error: `label vereist; max ${MAX_LABEL} chars` };
    }
  }
  if (payload.help_text !== undefined && payload.help_text !== null) {
    if (typeof payload.help_text !== 'string' || payload.help_text.length > MAX_HELP) {
      return { ok: false, error: `help_text max ${MAX_HELP} chars` };
    }
  }
  // order_index
  if (payload.order_index !== undefined && payload.order_index !== null) {
    const n = Number(payload.order_index);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: 'order_index moet een integer >= 0 zijn' };
    }
  }
  if (payload.page !== undefined && payload.page !== null) {
    const n = Number(payload.page);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'page moet een geheel getal >= 1 zijn' };
    }
  }
  // min_words
  if (payload.min_words !== undefined && payload.min_words !== null) {
    const n = Number(payload.min_words);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: 'min_words moet een integer >= 0 zijn' };
    }
  }
  // options: required voor radio
  const effectiveType = type !== undefined ? type : null;
  if (effectiveType === 'radio') {
    const opts = payload.options;
    if (!Array.isArray(opts) || opts.length === 0) {
      return { ok: false, error: 'options vereist voor type=radio (array van { value, label })' };
    }
    for (const o of opts) {
      if (!o || typeof o !== 'object' || typeof o.value !== 'string' || !o.value || typeof o.label !== 'string' || !o.label) {
        return { ok: false, error: 'elke option moet { value:string, label:string } zijn' };
      }
    }
  } else if (payload.options !== undefined && payload.options !== null) {
    if (!Array.isArray(payload.options)) {
      return { ok: false, error: 'options moet array of null zijn' };
    }
  }
  // is_routing + routing_weights
  if (payload.is_routing === true) {
    const rw = payload.routing_weights;
    if (!rw || typeof rw !== 'object' || Array.isArray(rw)) {
      return { ok: false, error: 'routing_weights vereist als is_routing=true (object {key->number})' };
    }
    for (const [k, v] of Object.entries(rw)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { ok: false, error: `routing_weights.${k} moet een geldig getal zijn` };
      }
    }
  } else if (payload.routing_weights !== undefined && payload.routing_weights !== null) {
    if (typeof payload.routing_weights !== 'object' || Array.isArray(payload.routing_weights)) {
      return { ok: false, error: 'routing_weights moet object of null zijn' };
    }
  }
  // booleans
  for (const k of ['required', 'is_routing', 'active']) {
    if (payload[k] !== undefined && typeof payload[k] !== 'boolean') {
      return { ok: false, error: `${k} moet boolean zijn` };
    }
  }
  // FEATURE C: optionele questionnaire_id moet een uuid zijn als gezet.
  if (payload.questionnaire_id !== undefined && payload.questionnaire_id !== null) {
    if (typeof payload.questionnaire_id !== 'string' || !UUID_RE.test(payload.questionnaire_id)) {
      return { ok: false, error: 'questionnaire_id moet een uuid zijn' };
    }
  }
  return { ok: true };
}

function pickInsertRow(payload, questionnaireId) {
  return {
    key             : payload.key.trim(),
    section         : payload.section.trim(),
    order_index     : payload.order_index !== undefined && payload.order_index !== null
                        ? Number(payload.order_index) : 0,
    page            : payload.page != null ? Number(payload.page) : 1,
    type            : payload.type,
    label           : payload.label.trim(),
    help_text       : payload.help_text != null ? String(payload.help_text) : null,
    required        : payload.required !== undefined ? !!payload.required : true,
    options         : payload.options != null ? payload.options : null,
    min_words       : payload.min_words != null ? Number(payload.min_words) : null,
    is_routing      : payload.is_routing === true,
    routing_weights : payload.routing_weights != null ? payload.routing_weights : null,
    active          : payload.active !== undefined ? !!payload.active : true,
    // FEATURE C: vragen horen bij een vragenlijst. Default = actief, optioneel
    // override via payload.questionnaire_id (bv. tijdens hernoemen / kopiëren).
    questionnaire_id: questionnaireId,
  };
}

function pickUpdatePatch(payload) {
  const patch = {};
  if (payload.section !== undefined)         patch.section         = payload.section.trim();
  if (payload.order_index !== undefined)     patch.order_index     = Number(payload.order_index);
  if (payload.page !== undefined)            patch.page            = Number(payload.page);
  if (payload.type !== undefined)            patch.type            = payload.type;
  if (payload.label !== undefined)           patch.label           = payload.label.trim();
  if (payload.help_text !== undefined)       patch.help_text       = payload.help_text;
  if (payload.required !== undefined)        patch.required        = !!payload.required;
  if (payload.options !== undefined)         patch.options         = payload.options;
  if (payload.min_words !== undefined)       patch.min_words       = payload.min_words === null ? null : Number(payload.min_words);
  if (payload.is_routing !== undefined)      patch.is_routing      = !!payload.is_routing;
  if (payload.routing_weights !== undefined) patch.routing_weights = payload.routing_weights;
  if (payload.active !== undefined)          patch.active          = !!payload.active;
  // FEATURE C: verhuizen van een vraag naar een andere vragenlijst is mogelijk.
  if (payload.questionnaire_id !== undefined) patch.questionnaire_id = payload.questionnaire_id;
  return patch;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'POST, PATCH');
    return res.status(405).json({ error: 'POST of PATCH only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  if (req.method === 'POST') {
    const validation = validatePayload(body, { isCreate: true });
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    // FEATURE C: questionnaire_id bepalen (default = actieve vragenlijst).
    let questionnaireId = (typeof body.questionnaire_id === 'string' && body.questionnaire_id)
      ? body.questionnaire_id
      : null;
    if (!questionnaireId) {
      const active = await getActiveQuestionnaire();
      questionnaireId = active?.id || null;
    }
    if (!questionnaireId) {
      return res.status(400).json({
        error: 'Geen actieve vragenlijst; geef expliciet een questionnaire_id mee.',
      });
    }

    const insertRow = pickInsertRow(body, questionnaireId);
    try {
      const { data, error } = await supabaseAdmin
        .from('assessment_questions')
        .insert(insertRow)
        .select('*')
        .maybeSingle();
      if (error) {
        if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
          return res.status(409).json({ error: `key '${insertRow.key}' bestaat al`, code: 'KEY_EXISTS' });
        }
        if (error.code === '23514' || /check constraint/i.test(error.message || '')) {
          return res.status(400).json({ error: 'CHECK-constraint geweigerd: ' + error.message });
        }
        throw new Error(error.message);
      }
      if (!data) throw new Error('insert returnde geen rij');
      return res.status(201).json({ item: data });
    } catch (e) {
      console.error('[admin-assessment-questions-upsert POST]', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  // PATCH
  const id = (req.query?.id ? String(req.query.id) : null) || (typeof body.id === 'string' ? body.id : null);
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id (uuid) vereist via ?id of body.id' });
  }
  const validation = validatePayload(body, { isCreate: false });
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  const patch = pickUpdatePatch(body);
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Geen velden om te updaten' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('assessment_questions')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) {
      if (error.code === '23514' || /check constraint/i.test(error.message || '')) {
        return res.status(400).json({ error: 'CHECK-constraint geweigerd: ' + error.message });
      }
      throw new Error(error.message);
    }
    if (!data) return res.status(404).json({ error: 'Vraag niet gevonden' });
    return res.status(200).json({ item: data });
  } catch (e) {
    console.error('[admin-assessment-questions-upsert PATCH]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
