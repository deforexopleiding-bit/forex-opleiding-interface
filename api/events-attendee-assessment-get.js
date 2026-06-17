// api/events-attendee-assessment-get.js
// POST { attendee_id } → leesbare weergave van de door een aanwezige
// ingevulde assessment-vragenlijst.
//
// Permission: events.attendee.assessment_view (één key; Jeffrey beheert
// wie 'm heeft via /modules/admin.html → RBAC-matrix). Geen hardcoded
// rollen.
//
// Flow:
//   1. attendee_id → event_attendees-rij → assessment_response_id.
//      404 als assessment_response_id leeg is (geen vragenlijst ingevuld).
//   2. assessment_responses-rij ophalen (answers jsonb + routing_result +
//      score jsonb + questionnaire_id).
//   3. Vragen ophalen: filter op response.questionnaire_id; fall-back op
//      de actieve vragenlijst als response.questionnaire_id NULL is
//      (legacy/pre-FEATURE-C inzendingen).
//   4. Map naar leesbare paren { question_key, question_label,
//      answer_value, answer_label }. Voor radio: answer_label = optie-label
//      bij die value. Voor scale/text/open_text/email: answer_label = de
//      waarde zelf (string).
//   5. Skill_score afgeleid uit score.skill_score (FEATURE C scoring-shape).
//
// Response 200: { ok:true, items:[...], routing_result, skill_score }
// Response 404: { error } — attendee niet gevonden / geen vragenlijst ingevuld
// Response 403/400/500: standaard.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getActiveQuestionnaire } from './_lib/assessment-questionnaires.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valueToLabel(question, raw) {
  if (raw == null || raw === '') return '';
  const t = question.type;
  if (t === 'radio') {
    const opts = Array.isArray(question.options) ? question.options : [];
    const match = opts.find((o) => String(o.value) === String(raw));
    return match && match.label ? String(match.label) : String(raw);
  }
  // scale_1_5 / scale_1_10 / text / email / open_text → raw waarde.
  return String(raw);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.assessment_view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.assessment_view)' });
  }

  const body = req.body || {};
  const attendeeId = String(body.attendee_id || '').trim();
  if (!attendeeId) return res.status(400).json({ error: 'attendee_id vereist' });
  if (!UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id moet geldige uuid zijn' });
  }

  try {
    // 1) Attendee → assessment_response_id.
    const { data: att, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, assessment_response_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee-lookup: ' + attErr.message);
    if (!att) return res.status(404).json({ error: 'Deelnemer niet gevonden' });
    if (!att.assessment_response_id) {
      return res.status(404).json({
        error: 'Geen ingevulde vragenlijst voor deze deelnemer.',
        code : 'NO_ASSESSMENT',
      });
    }

    // 2) Assessment-response ophalen.
    const { data: resp, error: respErr } = await supabaseAdmin
      .from('assessment_responses')
      .select('id, answers, routing_result, score, questionnaire_id, submitted_at')
      .eq('id', att.assessment_response_id)
      .maybeSingle();
    if (respErr) throw new Error('response-lookup: ' + respErr.message);
    if (!resp) {
      return res.status(404).json({
        error: 'Vragenlijst-record niet gevonden.',
        code : 'NO_ASSESSMENT',
      });
    }

    // 3) Vragen ophalen — bij voorkeur de questionnaire die op de response
    //    staat; legacy (NULL) → fall-back op de actieve vragenlijst zodat
    //    pre-FEATURE-C inzendingen ook getoond worden.
    let questionnaireId = resp.questionnaire_id || null;
    if (!questionnaireId) {
      const active = await getActiveQuestionnaire();
      questionnaireId = active?.id || null;
    }

    let qQuery = supabaseAdmin
      .from('assessment_questions')
      .select('id, key, label, type, options, order_index, section, page')
      .order('page', { ascending: true })
      .order('order_index', { ascending: true });
    if (questionnaireId) qQuery = qQuery.eq('questionnaire_id', questionnaireId);
    const { data: questions, error: qErr } = await qQuery;
    if (qErr) throw new Error('questions-lookup: ' + qErr.message);

    // 4) Map naar leesbare paren. Antwoorden zonder bekende vraag worden
    //    overgeslagen (forward-compat — als een vraag is verwijderd na
    //    submit, tonen we 'm niet). Vragen zonder antwoord laten we ook
    //    weg om de output schoon te houden.
    const ans = (resp.answers && typeof resp.answers === 'object') ? resp.answers : {};
    const items = [];
    for (const q of (questions || [])) {
      const raw = ans[q.key];
      if (raw == null || raw === '') continue;
      items.push({
        question_key  : q.key,
        question_label: q.label || q.key,
        answer_value  : (typeof raw === 'object') ? raw : String(raw),
        answer_label  : valueToLabel(q, raw),
      });
    }

    // 5) Context-velden.
    const skillScore = (resp.score && typeof resp.score === 'object'
                        && typeof resp.score.skill_score === 'number')
      ? resp.score.skill_score
      : null;

    return res.status(200).json({
      ok            : true,
      items,
      routing_result: resp.routing_result || null,
      skill_score   : skillScore,
      submitted_at  : resp.submitted_at || null,
    });
  } catch (e) {
    console.error('[events-attendee-assessment-get]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
