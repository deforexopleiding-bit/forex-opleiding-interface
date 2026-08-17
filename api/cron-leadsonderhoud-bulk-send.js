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

      const nowIso = new Date().toISOString();
      let waResult = null, mailResult = null;
      let sentAny = false, failedAny = false, failReason = null;

      // 3b) WA-branch.
      if (rec.channel_whatsapp && (job.channel === 'whatsapp' || job.channel === 'both') && rec.phone) {
        const conv = convByPhoneKey.get(normNummer(rec.phone));
        const insideWindow = !!(conv && binnenVenster(conv.last_inbound_at));
        // Buiten venster → template verplicht. Als job geen template heeft: skip.
        const useTemplate = !insideWindow || !!job.template_name;
        try {
          if (useTemplate && job.template_name) {
            waResult = await sendTemplate({
              to: rec.phone,
              templateName: job.template_name,
              languageCode: job.template_language || 'nl',
              variables: [],
              phoneNumberId: lijn.phoneNumberId,
            });
          } else if (insideWindow) {
            // Binnen venster + geen template = niet ondersteund in bulk (bulk zonder
            // template is te generiek voor consent-context).
            throw new Error('bulk zonder template niet toegestaan');
          } else {
            throw new Error('buiten 24u-venster + geen template');
          }
          sentAny = true;
          // berichten_log audit.
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
        await supabaseAdmin.rpc('increment_bulk_sent', {}).catch(() => {}); // no-op als rpc niet bestaat
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
        // Geen kanaal actief voor deze recipient → skip.
        summary.skipped++;
        await supabaseAdmin.from('leadsonderhoud_bulk_recipients').update({
          status: 'skipped', skip_reason: 'no_active_channel',
        }).eq('id', rec.id);
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
