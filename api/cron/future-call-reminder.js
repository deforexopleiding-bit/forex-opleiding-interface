// api/cron/future-call-reminder.js
//
// Dagelijkse cron — maakt voor elke onboarding waarvan de student binnen
// 14 dagen start een "Plan eerste call met <klant>" taak voor de mentor.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
//
// SCOPE:
//   onboardings WHERE
//     start_date IS NOT NULL
//     AND start_date BETWEEN today AND today + 14d
//     AND first_call_reminder_task_at IS NULL  (idempotente marker — voorkomt dubbele taken)
//     AND mentor_user_id IS NOT NULL
//     AND status != 'gearchiveerd'.
//
// Per rij (fail-soft):
//   1) INSERT taken_items met titel/omschrijving/categorie/prioriteit/
//      deadline=start_date/assigned_to_id=mentor_user_id/created_by=mentor_user_id/
//      created_by_agent=true/status='todo'.
//   2) UPDATE onboardings.first_call_reminder_task_at = now() — markeert
//      'reminder al gemaakt' zodat een herhaalde run géén tweede taak
//      aanmaakt. Bij update-fout: log + skip naar volgende rij (taak is
//      al gemaakt — volgende cron zou hem dan opnieuw kunnen aanmaken,
//      vandaar een waarschuwing).
//
// Return: { ok:true, candidates:N, created:M, errors: [...] }.

import { supabaseAdmin } from '../supabase.js';

function todayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function plusDaysIso(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmtDateNl(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return String(iso || ''); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // AUTH — identiek aan noshow-detect.
  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = {
    ok: true,
    candidates: 0,
    created: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const from = todayIso();
    const to   = plusDaysIso(14);

    const { data: rows, error: qErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_name, mentor_user_id, start_date, traject_label, status')
      .gte('start_date', from)
      .lte('start_date', to)
      .is('first_call_reminder_task_at', null)
      .not('mentor_user_id', 'is', null)
      .neq('status', 'gearchiveerd')
      .limit(500);
    if (qErr) {
      console.error('[future-call-reminder] onboardings query:', qErr.message);
      return res.status(500).json({ ok: false, error: qErr.message, result });
    }
    result.candidates = (rows || []).length;

    if (!rows || rows.length === 0) {
      return res.status(200).json(result);
    }

    for (const r of rows) {
      try {
        const customerName = String(r.customer_name || '').trim() || 'student';
        const mentorUserId = r.mentor_user_id;
        const startDate    = r.start_date; // 'YYYY-MM-DD' (DATE-kolom)
        const trajectLabel = String(r.traject_label || '').trim();
        const trajectSuffix = trajectLabel ? ` (${trajectLabel})` : '';

        const nowIso = new Date().toISOString();
        const taskRow = {
          titel:           `Plan eerste call met ${customerName}${trajectSuffix}`,
          omschrijving:    `Start ${fmtDateNl(startDate)} — neem contact op met de student om de eerste call in te plannen (check betaling vóór de call).`,
          prioriteit:      'Normaal',
          categorie:       'Mentoring',
          assigned_to_id:  mentorUserId,
          deadline:        startDate,
          status:          'todo',
          notities:        '',
          aangemaakt:      nowIso,
          updated_at:      nowIso,
          created_by:      mentorUserId,         // mentor bezit z'n eigen reminder
          owner_id:        mentorUserId,         // legacy mirror (zelfde pattern als api/taken.js)
          created_by_id:   mentorUserId,         // legacy mirror
          created_by_agent: true,                // markeert als systeem-gegenereerd
        };

        const { data: ins, error: insErr } = await supabaseAdmin
          .from('taken_items')
          .insert(taskRow)
          .select('id')
          .single();
        if (insErr) {
          result.errors.push({ onboarding_id: r.id, stage: 'insert', error: insErr.message });
          continue;
        }

        // Idempotente marker. Eén-rij update; bij fout log + skip (taak is al
        // aangemaakt, dus volgende cron-tick kan deze rij opnieuw oppakken —
        // dat is niet ideaal maar veiliger dan een gefaalde insert te verbergen).
        const { error: upErr } = await supabaseAdmin
          .from('onboardings')
          .update({ first_call_reminder_task_at: nowIso })
          .eq('id', r.id);
        if (upErr) {
          console.warn('[future-call-reminder] marker update failed for', r.id, ':', upErr.message, ' (task_id:', ins?.id, ')');
          result.errors.push({ onboarding_id: r.id, stage: 'marker', task_id: ins?.id || null, error: upErr.message });
          // Tellen wel als created — taak is succesvol weggeschreven.
        }
        result.created++;
      } catch (e) {
        console.error('[future-call-reminder] row fail', r?.id, e?.message || e);
        result.errors.push({ onboarding_id: r?.id || null, stage: 'exception', error: e?.message || String(e) });
      }
    }

    console.log(`[future-call-reminder] candidates=${result.candidates} created=${result.created} errors=${result.errors.length}`);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[future-call-reminder]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout', result });
  }
}
