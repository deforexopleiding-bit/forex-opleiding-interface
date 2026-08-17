// api/cron-leadsonderhoud-bulk-send.js
//
// FASE 3 leadsonderhoud-bulk — send-cron. Spiegel van cron-dunning-bulk-send:
// BATCH_SIZE 10 per 3-min tick, atomische claim pending→sending, fail-soft per
// recipient, maybeCompleteJob → completed + notify(manager/super_admin).
//
// SAFETY-SET (erft VOLLEDIG van cron-leadsonderhoud drip-motor):
//   1. LEADSONDERHOUD_UIT env → harde stop (returnt zonder claim).
//   2. LEADSONDERHOUD_LIVE !== '1' → droogloop (claim niks, verstuur niks —
//      bulk staat standaard veilig UIT tot je LIVE=1 zet).
//   3. Stille uren 21:00-08:00 Amsterdam → skip tick. Job blijft 'running',
//      recipients blijven pending, hervat automatisch de volgende ochtend.
//      Override via app_settings.leadsonderhoud_stille_uren = false.
//   4. Per recipient 24u-venster opnieuw checken vlak vóór send. needs_template
//      werd door -bulk-preview per recipient bepaald, maar we her-checken
//      omdat het venster in de tussentijd kan zijn verstreken.
//   5. phone_number_id via haalLijn() (module=leadsonderhoud, GEEN finance-
//      fallback — matcht drip-motor).
//   6. 1 retry bij fout (retry_count 0→1, dan naar 'failed').
//   7. Elke recipient logs naar berichten_log { lead_id, traject, soort:
//      'bulk-<template>', kanaal, naar, agent:'cron', status:'ok'|'fout',
//      verstuurd_op, meta_template }.
//   8. is_test guardrail: cron pickt alleen is_test=false jobs.
//
// Auth: Bearer $CRON_SECRET.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { sendTemplate, sendText, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { createNotification } from './_lib/notify.js';
import { haalLijn, mailAfzender, normNummer, binnenVenster } from './_lib/leadsonderhoud-gesprekken.js';

const BATCH_SIZE = 10;

function aanUit(v) { return ['1', 'true', 'aan', 'on', 'ja'].includes(String(v || '').trim().toLowerCase()); }
function amsUur() {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(new Date()));
}
// v=CommitA-patch: Amsterdam-day-start als ISO. Zorgt dat "vandaag" voor
// drip-today-check consistent is met stille-uren-boundary (beide Amsterdam).
// UTC-start zou 22:00-24:00 UTC = 00:00-02:00 CEST kunnen missen.
function amsterdamStartOfTodayIso() {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }); // YYYY-MM-DD
  const dateStr = dtf.format(now); // '2026-08-17'
  // Bouw midnight-Amsterdam als UTC-ISO. Amsterdam-offset op deze dag via Intl.
  const [Y, M, D] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(Y, M - 1, D, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMidnight));
  const mp = {}; for (const p of parts) mp[p.type] = p.value;
  const asUtc = Date.UTC(+mp.year, +mp.month - 1, +mp.day, +mp.hour, +mp.minute, +mp.second);
  const offMin = Math.round((asUtc - utcMidnight) / 60000);
  return new Date(utcMidnight - offMin * 60000).toISOString();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const started = Date.now();
  const summary = { processed: 0, sent: 0, failed: 0, skipped: 0, jobs_touched: 0, jobs_completed: 0, dry_run: false, reason: null, duration_ms: 0 };

  // Safety 1: UIT.
  if (aanUit(process.env.LEADSONDERHOUD_UIT)) {
    summary.reason = 'LEADSONDERHOUD_UIT'; summary.duration_ms = Date.now() - started;
    return res.status(200).json({ ok: true, ...summary });
  }
  // Safety 2: LIVE-gate.
  const live = String(process.env.LEADSONDERHOUD_LIVE || '').trim() === '1';
  if (!live) {
    summary.dry_run = true; summary.reason = 'LEADSONDERHOUD_LIVE!=1';
    summary.duration_ms = Date.now() - started;
    return res.status(200).json({ ok: true, ...summary });
  }
  // Safety 3: stille uren.
  let stilleUren = true;
  try {
    const { data } = await supabaseAdmin.from('app_settings').select('value').eq('key', 'leadsonderhoud_stille_uren').maybeSingle();
    if (data && data.value === false) stilleUren = false;
  } catch (_) {}
  const uur = amsUur();
  if (stilleUren && (uur >= 21 || uur < 8)) {
    summary.reason = 'stille_uren'; summary.duration_ms = Date.now() - started;
    return res.status(200).json({ ok: true, ...summary });
  }

  try {
    // 1) Approved+running jobs (FIFO), is_test=false guardrail.
    const { data: jobs, error: jErr } = await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .select('id, channel, template_name, template_language, email_subject, email_body, status, total_recipients, sent_count, failed_count, skipped_count, is_test')
      .in('status', ['approved', 'running'])
      .eq('is_test', false)
      .order('created_at', { ascending: true })
      .limit(20);
    if (jErr) throw new Error('jobs fetch: ' + jErr.message);
    if (!jobs || jobs.length === 0) {
      summary.duration_ms = Date.now() - started;
      return res.status(200).json({ ok: true, ...summary });
    }

    // 2) Pending recipients FIFO, cap BATCH_SIZE.
    const jobIds = jobs.map(j => j.id);
    const { data: pending, error: rErr } = await supabaseAdmin
      .from('leadsonderhoud_bulk_recipients')
      .select('id, job_id, lead_id, lead_naam, traject, phone, email, channel_whatsapp, channel_email, needs_template, retry_count')
      .in('job_id', jobIds)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);
    if (rErr) throw new Error('recipients fetch: ' + rErr.message);

    if (!pending || pending.length === 0) {
      for (const job of jobs) await maybeCompleteJob(job, summary);
      summary.duration_ms = Date.now() - started;
      return res.status(200).json({ ok: true, ...summary });
    }

    // 3) Touched jobs approved → running.
    const touched = new Set(pending.map(r => r.job_id));
    summary.jobs_touched = touched.size;
    for (const jid of touched) {
      await supabaseAdmin.from('leadsonderhoud_bulk_jobs')
        .update({ status: 'running' }).eq('id', jid).eq('status', 'approved');
    }

    const lijn = await haalLijn(); // GEEN finance-fallback (spiegel drip-motor).
    const jobById = new Map(jobs.map(j => [j.id, j]));

    // Pre-load WA-convs voor batch (voor per-recipient 24u-check vlak vóór send).
    let convByPhoneKey = new Map();
    if (lijn.phoneNumberId) {
      const phoneKeys = pending.map(r => normNummer(r.phone)).filter(Boolean);
      if (phoneKeys.length) {
        const { data: convs } = await supabaseAdmin
          .from('whatsapp_conversations')
          .select('phone_number, last_inbound_at')
          .eq('phone_number_id', lijn.phoneNumberId);
        for (const c of (convs || [])) if (c.phone_number) convByPhoneKey.set(normNummer(c.phone_number), c);
      }
    }

    // v=CommitA-patch (a) — consent re-check vlak vóór send. Batch-lookup op
    // leads.toestemming_whatsapp voor deze batch; als consent inmiddels
    // is ingetrokken → skip 'consent_revoked' (geen retry, deterministisch).
    const consentByLeadId = new Map();
    const leadIdsForBatch = pending.map(r => r.lead_id).filter(Boolean);
    if (leadIdsForBatch.length) {
      try {
        const { data: leadRows } = await supabaseAdmin
          .from('leads')
          .select('id, toestemming_whatsapp')
          .in('id', leadIdsForBatch);
        for (const l of (leadRows || [])) consentByLeadId.set(l.id, l.toestemming_whatsapp === true);
      } catch (e) {
        console.warn('[cron-ls-bulk] consent-lookup soft-fail:', e?.message || e);
        // Fail-safe: bij lookup-fout → defaulten alle recipients op false-consent
        // (skip WA-tak; mail-only recipients gaan door). Beter niks sturen dan
        // per ongeluk naar iemand die z'n consent introk.
        for (const id of leadIdsForBatch) consentByLeadId.set(id, false);
      }
    }

    // v=CommitA-patch (b+d) — drip-today re-check vlak vóór send. Batch-lookup
    // op berichten_log voor de Amsterdam-vandaag-boundary (consistent met
    // preview én stille-uren-check). Als drip diezelfde dag al iets stuurde
    // naar deze lead → skip 'drip_today' (geen retry).
    const dripTodaySet = new Set();
    if (leadIdsForBatch.length) {
      try {
        const amsStart = amsterdamStartOfTodayIso();
        const { data: dripLogs } = await supabaseAdmin
          .from('berichten_log')
          .select('lead_id, verstuurd_op, agent')
          .in('lead_id', leadIdsForBatch)
          .gte('verstuurd_op', amsStart)
          .limit(2000);
        for (const b of (dripLogs || [])) {
          if (!b.lead_id) continue;
          // Skip alleen als DRIP zelf (niet onze bulk of handmatige antwoorden).
          // 'cron-bulk' agent = onze eigen tick; die telt niet mee als drip.
          if (b.agent === 'cron-bulk') continue;
          dripTodaySet.add(b.lead_id);
        }
      } catch (e) {
        console.warn('[cron-ls-bulk] drip-today lookup soft-fail:', e?.message || e);
        // Bij lookup-fout: gaan we door zonder skip (open policy — anders zou
        // een DB-hikje de hele bulk stilleggen).
      }
    }

    // Helper: recipient markeren als skipped + skipped_count++ + telemetrie.
    async function markSkip(rec, job, reason) {
      summary.skipped++;
      await supabaseAdmin.from('leadsonderhoud_bulk_recipients').update({
        status: 'skipped', skip_reason: reason,
      }).eq('id', rec.id);
      await supabaseAdmin.from('leadsonderhoud_bulk_jobs').update({
        skipped_count: (job.skipped_count || 0) + 1,
      }).eq('id', job.id);
      job.skipped_count = (job.skipped_count || 0) + 1;
    }

    for (const rec of pending) {
      summary.processed++;
      const job = jobById.get(rec.job_id);
      if (!job) continue;
      // 3a) Atomische claim.
      const { data: claim } = await supabaseAdmin
        .from('leadsonderhoud_bulk_recipients')
        .update({ status: 'sending' })
        .eq('id', rec.id).eq('status', 'pending')
        .select('id');
      if (!claim || claim.length === 0) continue; // andere worker heeft 'em al.

      // v=CommitA-patch (b) — drip-today re-check (per recipient). Skip als
      // drip diezelfde dag al stuurde. Geen retry, deterministisch.
      if (dripTodaySet.has(rec.lead_id)) {
        await markSkip(rec, job, 'drip_today');
        continue;
      }

      const nowIso = new Date().toISOString();
      let waResult = null, mailResult = null;
      let sentAny = false, failedAny = false, failReason = null;
      let waSkipped = false; // WA werd bewust overgeslagen (consent/no-template), NIET een fout

      // 3b) WA-branch — met patch (a) consent re-check + patch (c) skip-
      //     semantiek buiten venster zonder template.
      let waSkipReason = null; // 'consent_revoked' | 'no_template_out_of_window' | 'wa_no_template'
      if (rec.channel_whatsapp && (job.channel === 'whatsapp' || job.channel === 'both') && rec.phone) {
        const hasConsent = consentByLeadId.get(rec.lead_id) === true;
        if (!hasConsent) {
          waSkipped = true;
          waSkipReason = 'consent_revoked';
        } else {
          const conv = convByPhoneKey.get(normNummer(rec.phone));
          const insideWindow = !!(conv && binnenVenster(conv.last_inbound_at));
          if (!job.template_name) {
            // Bulk zonder template mag niet — deterministische skip (geen retry).
            waSkipped = true;
            waSkipReason = insideWindow ? 'wa_no_template' : 'no_template_out_of_window';
          } else {
            try {
              waResult = await sendTemplate({
                to: rec.phone,
                templateName: job.template_name,
                languageCode: job.template_language || 'nl',
                variables: [],
                phoneNumberId: lijn.phoneNumberId,
              });
              sentAny = true;
              try {
                await supabaseAdmin.from('berichten_log').insert({
                  lead_id: rec.lead_id, traject: rec.traject || null,
                  soort: 'bulk-' + (job.template_name || 'wa'),
                  kanaal: 'whatsapp', naar: rec.phone, agent: 'cron-bulk',
                  status: 'ok', verstuurd_op: nowIso, meta_template: job.template_name,
                });
              } catch (_) {}
            } catch (e) {
              if (e instanceof MetaNotConfiguredError) { failedAny = true; failReason = 'META_NOT_CONFIGURED'; }
              else { failedAny = true; failReason = (e?.message || 'WA-send fail').slice(0, 300); }
              console.warn('[cron-ls-bulk] WA fail', rec.id, failReason);
              try {
                await supabaseAdmin.from('berichten_log').insert({
                  lead_id: rec.lead_id, traject: rec.traject || null,
                  soort: 'bulk-' + (job.template_name || 'wa'),
                  kanaal: 'whatsapp', naar: rec.phone, agent: 'cron-bulk',
                  status: 'fout', verstuurd_op: nowIso, meta_template: job.template_name,
                });
              } catch (_) {}
            }
          }
        }
      }
      // 3c) Mail-branch.
      if (rec.channel_email && (job.channel === 'email' || job.channel === 'both') && rec.email && job.email_subject && job.email_body) {
        try {
          mailResult = await sendEmailViaSmtp({
            from: mailAfzender(),
            to: rec.email,
            subject: job.email_subject,
            text: job.email_body,
          });
          sentAny = true;
          try {
            await supabaseAdmin.from('berichten_log').insert({
              lead_id: rec.lead_id, traject: rec.traject || null,
              soort: 'bulk-mail', kanaal: 'mail', naar: rec.email,
              agent: 'cron-bulk', status: 'verstuurd', verstuurd_op: nowIso,
            });
          } catch (_) {}
        } catch (e) {
          failedAny = true; failReason = (failReason ? failReason + '; ' : '') + ('mail: ' + (e?.message || 'fail')).slice(0, 200);
          console.warn('[cron-ls-bulk] mail fail', rec.id, e?.message || e);
        }
      }

      // 3d) Recipient-status update.
      if (sentAny && !failedAny) {
        summary.sent++;
        await supabaseAdmin.from('leadsonderhoud_bulk_recipients').update({
          status: 'sent', sent_at: nowIso,
          wamid: (waResult && waResult.wamid) || null,
        }).eq('id', rec.id);
        await supabaseAdmin.from('leadsonderhoud_bulk_jobs').update({
          sent_count: (job.sent_count || 0) + 1,
        }).eq('id', job.id);
        job.sent_count = (job.sent_count || 0) + 1;
      } else if (failedAny) {
        // 1 retry: retry_count 0 → 1 + status terug naar 'pending' voor volgende tick.
        if ((rec.retry_count || 0) < 1) {
          await supabaseAdmin.from('leadsonderhoud_bulk_recipients').update({
            status: 'pending', retry_count: (rec.retry_count || 0) + 1,
            failed_reason: failReason,
          }).eq('id', rec.id);
        } else {
          summary.failed++;
          await supabaseAdmin.from('leadsonderhoud_bulk_recipients').update({
            status: 'failed', failed_reason: failReason,
          }).eq('id', rec.id);
          await supabaseAdmin.from('leadsonderhoud_bulk_jobs').update({
            failed_count: (job.failed_count || 0) + 1,
          }).eq('id', job.id);
          job.failed_count = (job.failed_count || 0) + 1;
        }
      } else {
        // Niets verstuurd + geen fout → skip. v=CommitA-patch: gebruik de
        // specifieke skip_reason als WA werd geskipt (consent_revoked /
        // no_template_out_of_window / wa_no_template) i.p.v. generiek
        // 'no_active_channel'. skipped_count wordt via markSkip bijgewerkt.
        const reason = waSkipReason || 'no_active_channel';
        await markSkip(rec, job, reason);
      }
    }

    // 4) Complete-check per touched job.
    for (const jid of touched) {
      const j = jobById.get(jid);
      await maybeCompleteJob(j, summary);
    }

    summary.duration_ms = Date.now() - started;
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    console.error('[cron-ls-bulk] fatal:', e?.message || e);
    summary.duration_ms = Date.now() - started;
    return res.status(500).json({ ok: false, error: e?.message || 'fatal', ...summary });
  }
}

async function maybeCompleteJob(job, summary) {
  if (!job) return;
  const { count } = await supabaseAdmin
    .from('leadsonderhoud_bulk_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', job.id).eq('status', 'pending');
  if ((count || 0) > 0) return; // nog werk te doen
  const { data: updated } = await supabaseAdmin
    .from('leadsonderhoud_bulk_jobs')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', job.id).in('status', ['approved', 'running'])
    .select('id, sent_count, failed_count, skipped_count, total_recipients');
  if (!updated || updated.length === 0) return;
  summary.jobs_completed++;
  try {
    const u = updated[0];
    await createNotification({
      toRole: ['manager', 'super_admin'],
      type: 'leadsonderhoud_bulk.completed',
      title: 'Leadsonderhoud bulk-broadcast voltooid',
      body: `Verstuurd: ${u.sent_count || 0} · Mislukt: ${u.failed_count || 0} · Overgeslagen: ${u.skipped_count || 0} (van ${u.total_recipients || 0})`,
      entityType: 'leadsonderhoud_bulk_job',
      entityId: u.id,
      priority: 'normal',
    });
  } catch (e) { console.warn('[cron-ls-bulk] notify soft-fail:', e?.message || e); }
}
