// api/onboarding-automation-test.js
//
// POST → trigger een echte onboarding-automation-run met een synthetische
// test-klant + test-onboarding. Port van api/events-automation-test.js.
//
// Use-case: een mail/WhatsApp-flow end-to-end testen zonder een echte
// klant te raken of de admin-lijst te vervuilen. Workflow:
//   1. INSERT customers-rij (is_test=true, naam/email/phone uit body).
//   2. INSERT onboardings-rij (is_test=true, customer_name='TEST · '+name,
//      status='aangemeld', token=randomUUID, traject_id uit body,
//      automation_enabled=true). De `is_test`-onboarding wordt door de
//      cron-poll geskipt (loadCandidatesForAutomation filtert .eq('is_test',
//      false)) zodat andere automations geen sends naar dit contact doen.
//   3. INSERT onboarding_automation_runs-rij (is_test=true, status='active',
//      current_step_index=0, next_run_at=now, steps_snapshot=automation.steps).
//      De cron-stepper pikt 'm bij de eerstvolgende tick op en versnelt
//      elke wait naar 15s (engine TEST_WAIT_MS).
//
// Permission: onboarding.automation.edit.
//
// Body:
//   {
//     automation_id: uuid (verplicht),
//     traject_id   : uuid (verplicht),
//     name         : string (vereist; geheel; wordt naar first_name geschreven),
//     email        : string (vereist; valide e-mail),
//     phone        : string (vereist; E.164 met +, bv. +31612345678),
//   }
//
// Response 200: { ok:true, run_id, onboarding_id, customer_id }
// Response 400: validatie-fout
// Response 401/403/404/500: standard.

import crypto from 'node:crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[0-9]{8,15}$/;
const NAME_MAX = 80;

// Naam splitsen op eerste spatie. Geen spatie → alleen first_name; achternaam
// blijft leeg. We bewaren de hele opgegeven naam ook in onboardings.customer_name
// met TEST·-prefix zodat de UI 'm visueel direct herkent.
function splitName(full) {
  const s = String(full || '').trim();
  if (!s) return { first: '', last: '' };
  const i = s.indexOf(' ');
  if (i < 0) return { first: s, last: '' };
  return { first: s.slice(0, i).trim(), last: s.slice(i + 1).trim() };
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
  if (!(await requirePermission(req, 'onboarding.automation.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.automation.edit)' });
  }

  const body = req.body || {};
  const automationId = typeof body.automation_id === 'string' ? body.automation_id.trim() : '';
  const trajectId    = typeof body.traject_id    === 'string' ? body.traject_id.trim()    : '';
  const name         = typeof body.name          === 'string' ? body.name.trim()          : '';
  const email        = typeof body.email         === 'string' ? body.email.trim()         : '';
  const phone        = typeof body.phone         === 'string' ? body.phone.trim()         : '';

  if (!automationId || !UUID_RE.test(automationId)) {
    return res.status(400).json({ error: 'automation_id (uuid) vereist' });
  }
  if (!trajectId || !UUID_RE.test(trajectId)) {
    return res.status(400).json({ error: 'traject_id (uuid) vereist' });
  }
  if (!name || name.length > NAME_MAX) {
    return res.status(400).json({ error: `name vereist (max ${NAME_MAX} chars)` });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'email ongeldig' });
  }
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'phone moet E.164-formaat hebben (bv. +31612345678)' });
  }

  try {
    // Automation + traject bestaan-check (404 → duidelijker dan een 500 op FK).
    const { data: autom, error: autErr } = await supabaseAdmin
      .from('onboarding_automations')
      .select('id, name, enabled, steps')
      .eq('id', automationId)
      .maybeSingle();
    if (autErr) throw new Error('automation-lookup: ' + autErr.message);
    if (!autom)  return res.status(404).json({ error: 'Automation niet gevonden' });
    if (!autom.enabled) {
      return res.status(400).json({ error: 'Automation staat uit — zet \'m eerst aan' });
    }

    const { data: traj, error: trajErr } = await supabaseAdmin
      .from('onboarding_trajecten')
      .select('id')
      .eq('id', trajectId)
      .maybeSingle();
    if (trajErr) throw new Error('traject-lookup: ' + trajErr.message);
    if (!traj)   return res.status(404).json({ error: 'Traject niet gevonden' });

    const { first, last } = splitName(name);
    const nowIso = new Date().toISOString();

    // 1) INSERT test-customer. is_company=false default; is_test=true.
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .insert({
        first_name:  first,
        last_name:   last,
        email,
        phone,
        is_company:  false,
        company_name: null,
        is_test:     true,
      })
      .select('id')
      .single();
    if (custErr) throw new Error('test-customer insert: ' + custErr.message);

    // 2) INSERT test-onboarding. customer_name geprefixt met "TEST · " zodat
    //    UI's die de filter (per ongeluk) niet toepassen visueel direct
    //    onderscheid zien. token = nieuwe random uuid (zoals onboarding-create).
    let onbId = null;
    try {
      const { data: ob, error: obErr } = await supabaseAdmin
        .from('onboardings')
        .insert({
          customer_id:    cust.id,
          customer_name:  'TEST · ' + name,
          traject_id:     trajectId,
          token:          crypto.randomUUID(),
          status:         'aangemeld',
          created_by:     user.id,
          is_test:        true,
          // automation_enabled blijft default true; we willen dat de test-
          // run wel kan stappen (de cron filter op is_test=false skipt
          // ALLEEN candidate-enrollment voor andere automations, de stepper
          // pakt onze direct ingeschoten run gewoon op).
        })
        .select('id')
        .single();
      if (obErr) throw new Error('test-onboarding insert: ' + obErr.message);
      onbId = ob.id;
    } catch (e) {
      // Cleanup customer zodat we geen orphan TEST-rij achterlaten.
      try { await supabaseAdmin.from('customers').delete().eq('id', cust.id); }
      catch (cErr) { console.error('[onboarding-automation-test] cleanup orphan customer fail:', cErr?.message || cErr); }
      throw e;
    }

    // 3) INSERT automation-run. status='active' + current_step_index=0 +
    //    next_run_at=now → engine pikt 'm bij eerstvolgende tick op.
    //    steps_snapshot = de automation.steps op moment van test (zelfde
    //    copy-on-enroll patroon als de cron-enroll).
    let runId = null;
    try {
      const { data: run, error: runErr } = await supabaseAdmin
        .from('onboarding_automation_runs')
        .insert({
          automation_id:      automationId,
          onboarding_id:      onbId,
          status:             'active',
          current_step_index: 0,
          next_run_at:        nowIso,
          steps_snapshot:     Array.isArray(autom.steps) ? autom.steps : [],
          context:            {},
          is_test:            true,
        })
        .select('id')
        .single();
      if (runErr) throw new Error('automation-run insert: ' + runErr.message);
      runId = run.id;
    } catch (e) {
      // Cleanup onboarding + customer zodat we geen orphan TEST-rijen achterlaten.
      try { await supabaseAdmin.from('onboardings').delete().eq('id', onbId); }
      catch (oErr) { console.error('[onboarding-automation-test] cleanup orphan onboarding fail:', oErr?.message || oErr); }
      try { await supabaseAdmin.from('customers').delete().eq('id', cust.id); }
      catch (cErr) { console.error('[onboarding-automation-test] cleanup orphan customer fail:', cErr?.message || cErr); }
      throw e;
    }

    return res.status(200).json({
      ok:             true,
      run_id:         runId,
      onboarding_id:  onbId,
      customer_id:    cust.id,
    });
  } catch (e) {
    console.error('[onboarding-automation-test]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
