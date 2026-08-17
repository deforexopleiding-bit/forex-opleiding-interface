// api/leadsonderhoud-bulk-test-send.js
//
// FASE 3 — VERPLICHTE test-send vóór approve mag. Stuurt ÉÉN bericht (WA of
// email of beide, matcht job.channel) naar test_number/test_email — DE ENIGE
// send buiten de cron. Update job.test_sent_at + test_target zodat -approve
// weet dat de test-eis vervuld is.
//
// Gate: leads.update.
//
// Body:
//   job_id       uuid   required
//   test_number? text   default env TEST_SEND_TARGET_NUMBER (WA)
//   test_email?  text   default env TEST_SEND_TARGET_EMAIL  (mail)
//
// Response 200: { ok:true, sent:{ wa:bool, email:bool }, test_target }
// Response 400/422/500 met nette errors.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn, mailAfzender } from './_lib/leadsonderhoud-gesprekken.js';
import { sendTemplate, sendText, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { fetchTemplateMeta, analyzeTemplate, resolveVariables } from './_lib/leadsonderhoud-bulk-template.js';
import { queryLeadsBySegment } from './_lib/leadsonderhoud-bulk-segment.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  try { return await _handleImpl(req, res); }
  catch (e) {
    console.error('[ls-bulk-test-send] TOP-LEVEL CRASH:', e && e.stack || e?.message || e);
    if (!res.headersSent) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: 'Test-send kon niet worden uitgevoerd.', detail: e?.message || String(e), stack_first_line: (e?.stack || '').split('\n')[1] || null });
    }
  }
}
async function _handleImpl(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const jobId = String(body.job_id || '').trim();
  const testNumber = String(body.test_number || process.env.TEST_SEND_TARGET_NUMBER || '').trim();
  const testEmail  = String(body.test_email  || process.env.TEST_SEND_TARGET_EMAIL  || '').trim();
  if (!UUID_RE.test(jobId)) return res.status(400).json({ error: 'job_id ontbreekt of ongeldig' });

  try {
    const { data: job, error: jErr } = await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .select('id, channel, template_name, template_language, email_subject, email_body, status, is_test')
      .eq('id', jobId).maybeSingle();
    if (jErr) throw jErr;
    if (!job) return res.status(404).json({ error: 'Job niet gevonden' });
    if (job.status !== 'draft') return res.status(422).json({ error: `Job status is '${job.status}' — test-send alleen op draft` });

    const sent = { wa: false, email: false };
    // WA-test (template) — blocker 2e: resolve lead.*-tokens tegen sample-lead
    // (eerste segment-recipient) zodat de test ECHTE parameters meestuurt.
    if ((job.channel === 'whatsapp' || job.channel === 'both') && job.template_name) {
      if (!testNumber) return res.status(400).json({ error: 'Vul een test-nummer in (of stel env TEST_SEND_TARGET_NUMBER in).' });
      const lijn = await haalLijn();
      if (!lijn.phoneNumberId) return res.status(409).json({ error: 'Geen WhatsApp-lijn ingesteld voor leadsonderhoud (whatsapp_module_config module=leadsonderhoud ontbreekt).' });

      // Sample-lead ophalen uit segment (eerste treffer).
      let sampleLead = null;
      try {
        const seg = job.segment || {};
        const { rows } = await queryLeadsBySegment(seg, { limit: 1 });
        sampleLead = (rows && rows[0]) || null;
      } catch (_) {}
      const tplMeta = await fetchTemplateMeta(job.template_name);
      const analysis = tplMeta ? analyzeTemplate(job.template_name, tplMeta.meta_param_mapping, tplMeta.body_text) : { positions: [] };
      const staticVars = (job.segment && job.segment.static_vars) || {};
      const variables = analysis.positions.length ? resolveVariables(analysis.positions, sampleLead || {}, staticVars) : [];

      try {
        await sendTemplate({
          to: testNumber,
          templateName: job.template_name,
          languageCode: job.template_language || 'nl',
          variables,
          phoneNumberId: lijn.phoneNumberId,
        });
        sent.wa = true;
      } catch (e) {
        if (e instanceof MetaNotConfiguredError) return res.status(503).json({ error: 'Meta WA niet geconfigureerd op de server.', missing: e.missing });
        // Blocker 3: geef Meta-error-detail terug zodat UI het kan tonen.
        const metaCode = e && e.metaCode ? String(e.metaCode) : null;
        const detail = (e?.message || 'onbekende fout') + (metaCode ? ' (Meta code ' + metaCode + ')' : '');
        return res.status(502).json({
          error: 'WhatsApp-test mislukt: ' + detail,
          meta_error: e?.message || null,
          meta_code: metaCode,
          variables_used: variables,
          positions: analysis.positions,
        });
      }
    }
    // Mail-test.
    if ((job.channel === 'email' || job.channel === 'both') && job.email_subject && job.email_body) {
      if (!testEmail) return res.status(400).json({ error: 'Vul een test-e-mailadres in (of stel env TEST_SEND_TARGET_EMAIL in).' });
      try {
        await sendEmailViaSmtp({
          from: mailAfzender(),
          to: testEmail,
          subject: '[TEST] ' + job.email_subject,
          text: job.email_body,
        });
        sent.email = true;
      } catch (e) {
        return res.status(502).json({ error: 'E-mail-test mislukt: ' + (e?.message || 'onbekende fout') });
      }
    }

    if (!sent.wa && !sent.email) {
      return res.status(400).json({ error: 'Geen test verstuurd — kanaal- of template-configuratie ontbreekt.' });
    }

    const testTarget = [sent.wa ? testNumber : null, sent.email ? testEmail : null].filter(Boolean).join(' | ');
    await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .update({ test_sent_at: new Date().toISOString(), test_target: testTarget })
      .eq('id', jobId);

    return res.status(200).json({ ok: true, sent, test_target: testTarget });
  } catch (e) {
    console.error('[ls-bulk-test-send] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Test-send mislukt' });
  }
}
