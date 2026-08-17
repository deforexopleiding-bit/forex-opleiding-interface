// api/leadsonderhoud-bulk-preview.js
//
// FASE 3 leadsonderhoud-bulk — bouwt een bulk-broadcast-JOB als DRAFT.
// VERSTUURT NIETS. Alleen: segment-query + skip/will_send breakdown +
// per-recipient row met resolved previews. Cron pikt approved+is_test=false
// jobs op (na test-send + approve).
//
// Gate: leads.update.
//
// Body:
//   segment: { traject:[], afspraak:'ja'|'nee'|null, score_min?, score_max?,
//              bron?, q? }
//   channel: 'whatsapp' | 'email' | 'both'
//   template_name?     — vereist bij whatsapp/both
//   template_language? — default 'nl'
//   email_subject?     — vereist bij email/both
//   email_body?        — vereist bij email/both
//
// Response 200:
//   { job_id, summary: { total, will_send, skipped, skipped_breakdown,
//     hard_cap, over_cap (bool) }, sample_previews: [...max 5] }
// Response 400: hard_cap exceeded (JOB NIET aangemaakt), validatie.
// Response 503: schema ontbreekt.
//
// Safety-set toegepast op skip:
//   - Geen phone → channel_whatsapp=false; als whatsapp-only → skip 'no_phone'
//   - Geen email → channel_email=false; als email-only → skip 'no_email'
//   - Geen toestemming_whatsapp=true → skip WA-kanaal (skip_reason 'no_consent'
//     als whatsapp-only)
//   - Drip vandaag al gestuurd naar deze lead (berichten_log) → skip 'drip_today'
//   - Buiten 24u-venster (last_inbound_at > 24h geleden of geen conv) → alleen
//     verzendbaar als approved template beschikbaar; needs_template=true
//     (cron enforced final check vlak vóór send)
//   - >hard_cap (500 default) → JOB NIET aangemaakt

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { queryLeadsBySegment } from './_lib/leadsonderhoud-bulk-segment.js';
import { haalLijn, normNummer, binnenVenster } from './_lib/leadsonderhoud-gesprekken.js';

const HARD_CAP = 500;
const VALID_CHANNELS = ['whatsapp', 'email', 'both'];

export default async function handler(req, res) {
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
  const segment = body.segment && typeof body.segment === 'object' ? body.segment : {};
  const channel = String(body.channel || '').toLowerCase();
  if (!VALID_CHANNELS.includes(channel)) return res.status(400).json({ error: `channel vereist (${VALID_CHANNELS.join('|')})` });
  const templateName = body.template_name ? String(body.template_name).trim() : null;
  const templateLang = body.template_language ? String(body.template_language).trim() : 'nl';
  const emailSubject = body.email_subject ? String(body.email_subject).trim() : null;
  const emailBody    = body.email_body    ? String(body.email_body).trim()    : null;

  if ((channel === 'whatsapp' || channel === 'both') && !templateName) {
    return res.status(400).json({ error: 'template_name vereist voor WhatsApp-kanaal' });
  }
  if ((channel === 'email' || channel === 'both') && (!emailSubject || !emailBody)) {
    return res.status(400).json({ error: 'email_subject + email_body vereist voor mail-kanaal' });
  }

  try {
    const { rows, total } = await queryLeadsBySegment(segment, { limit: HARD_CAP + 1 });
    // Hard cap: als segment groter is dan HARD_CAP → JOB NIET aanmaken.
    if (total > HARD_CAP) {
      return res.status(400).json({
        error: `Segment overschrijdt hard cap (${total} > ${HARD_CAP} leads). Verfijn de filters.`,
        summary: { total, hard_cap: HARD_CAP, over_cap: true },
      });
    }

    // WA-lijn + WA-conv-lookup voor 24u-venster (needs_template) — batch op nummers.
    const lijn = await haalLijn();
    const waConvByPhoneKey = new Map();
    if (lijn.phoneNumberId) {
      const phoneKeys = rows.map(r => normNummer(r.telefoon_e164)).filter(Boolean);
      if (phoneKeys.length) {
        const { data: convs } = await supabaseAdmin
          .from('whatsapp_conversations')
          .select('phone_number, last_inbound_at')
          .eq('phone_number_id', lijn.phoneNumberId)
          .limit(2000);
        for (const c of convs || []) {
          if (!c.phone_number) continue;
          waConvByPhoneKey.set(normNummer(c.phone_number), c);
        }
      }
    }

    // Drip-vandaag lookup: berichten_log entries voor deze leads met verstuurd_op vandaag.
    const dripTodaySet = new Set();
    try {
      const leadIds = rows.map(r => r.id);
      if (leadIds.length) {
        const startOfDayIso = new Date(new Date().toISOString().slice(0, 10)).toISOString();
        const { data: dripLogs } = await supabaseAdmin
          .from('berichten_log')
          .select('lead_id, verstuurd_op')
          .in('lead_id', leadIds)
          .gte('verstuurd_op', startOfDayIso)
          .limit(2000);
        for (const b of dripLogs || []) if (b.lead_id) dripTodaySet.add(b.lead_id);
      }
    } catch (e) {
      console.warn('[ls-bulk-preview] drip-vandaag lookup soft-fail:', e?.message || e);
    }

    // Per lead → recipient shape + skip-logica.
    const skipBreakdown = { no_phone: 0, no_email: 0, no_consent: 0, drip_today: 0 };
    let willSend = 0;
    const recipients = [];
    const samples = [];
    for (const l of rows) {
      const hasPhone = !!l.telefoon_e164;
      const hasEmail = !!l.email;
      const hasConsentWA = !!l.toestemming_whatsapp;
      const dripToday = dripTodaySet.has(l.id);
      // Per-kanaal-eligibility
      let channelWa = false, channelEmail = false;
      let skipReason = null;
      if (dripToday) {
        skipReason = 'drip_today';
        skipBreakdown.drip_today++;
      } else {
        if (channel === 'whatsapp' || channel === 'both') channelWa = hasPhone && hasConsentWA;
        if (channel === 'email'    || channel === 'both') channelEmail = hasEmail;
        // Skip als beide kanalen dicht.
        if (!channelWa && !channelEmail) {
          if (channel === 'whatsapp') {
            if (!hasPhone) { skipReason = 'no_phone'; skipBreakdown.no_phone++; }
            else if (!hasConsentWA) { skipReason = 'no_consent'; skipBreakdown.no_consent++; }
          } else if (channel === 'email') {
            skipReason = 'no_email'; skipBreakdown.no_email++;
          } else { // both
            if (!hasPhone && !hasEmail) { skipReason = 'no_phone'; skipBreakdown.no_phone++; }
            else if (!hasEmail) { skipReason = 'no_email'; skipBreakdown.no_email++; }
            else if (!hasConsentWA) { skipReason = 'no_consent'; skipBreakdown.no_consent++; }
          }
        }
      }
      // 24u-venster / needs_template per recipient (voor WA).
      let needsTemplate = false;
      if (channelWa) {
        const conv = waConvByPhoneKey.get(normNummer(l.telefoon_e164));
        needsTemplate = !(conv && binnenVenster(conv.last_inbound_at));
      }
      // Preview-bodies (simpel: template_name of first-160-chars-tekst).
      const previewWa    = channelWa    ? (templateName ? ('[template] ' + templateName) : '(vrije tekst)') : null;
      const previewESub  = channelEmail ? (emailSubject || '(geen onderwerp)') : null;
      const previewEBody = channelEmail ? (emailBody || '').slice(0, 500) : null;
      const status = skipReason ? 'skipped' : 'pending';
      if (status === 'pending') willSend++;
      recipients.push({
        lead_id: l.id, lead_naam: l.naam || l.email || 'Onbekend', traject: l.traject || null,
        phone: l.telefoon_e164 || null, email: l.email || null,
        channel_whatsapp: channelWa, channel_email: channelEmail,
        needs_template: needsTemplate,
        resolved_preview_wa: previewWa,
        resolved_preview_email_subject: previewESub,
        resolved_preview_email_body: previewEBody,
        status, skip_reason: skipReason,
      });
      if (samples.length < 5 && status === 'pending') {
        samples.push({ lead_naam: l.naam || l.email, traject: l.traject, needs_template: needsTemplate, preview_wa: previewWa, preview_email_subject: previewESub });
      }
    }

    // JOB insert (status='draft'). Bij schema-fout: 503 (tabel nog niet gemigreerd).
    let job;
    try {
      const { data, error } = await supabaseAdmin
        .from('leadsonderhoud_bulk_jobs')
        .insert({
          created_by_user_id: user.id,
          channel,
          template_name: templateName,
          template_language: templateLang,
          email_subject: emailSubject,
          email_body: emailBody,
          segment,
          status: 'draft',
          total_recipients: recipients.length,
          skipped_count: recipients.length - willSend,
          hard_cap: HARD_CAP,
        })
        .select('id')
        .single();
      if (error) throw error;
      job = data;
    } catch (e) {
      const msg = String(e?.message || e);
      if (/does not exist|relation.*bulk/i.test(msg)) {
        return res.status(503).json({ error: 'Schema ontbreekt: draai 2026-08-17-leadsonderhoud-bulk-schema.sql eerst', detail: msg });
      }
      console.error('[ls-bulk-preview] job insert:', msg);
      return res.status(500).json({ error: 'Job aanmaken mislukt: ' + msg });
    }

    // Recipients batched.
    const CHUNK = 100;
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const slice = recipients.slice(i, i + CHUNK).map(r => ({ job_id: job.id, ...r }));
      const { error: rErr } = await supabaseAdmin.from('leadsonderhoud_bulk_recipients').insert(slice);
      if (rErr) {
        // Rollback: verwijder de job zodat er geen half-lege draft blijft.
        try { await supabaseAdmin.from('leadsonderhoud_bulk_jobs').delete().eq('id', job.id); } catch (_) {}
        console.error('[ls-bulk-preview] recipients insert:', rErr.message);
        return res.status(500).json({ error: 'Recipients aanmaken mislukt: ' + rErr.message });
      }
    }

    return res.status(200).json({
      job_id: job.id,
      summary: {
        total: recipients.length,
        will_send: willSend,
        skipped: recipients.length - willSend,
        skipped_breakdown: skipBreakdown,
        hard_cap: HARD_CAP,
        over_cap: false,
      },
      sample_previews: samples,
    });
  } catch (e) {
    console.error('[ls-bulk-preview] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Preview mislukt' });
  }
}
