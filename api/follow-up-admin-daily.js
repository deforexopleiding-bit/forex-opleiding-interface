// api/follow-up-admin-daily.js
//
// Cron: dagelijks 21:00 NL (19:00 UTC) — verstuurt KPI-dagrapport
// aan alle super_admin/manager profielen.
//
// Schedule: 0 19 * * *
// Auth: CRON_SECRET via Authorization header

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendMail, wrapEmailHtml, getAdminRecipients } from './mailer.js';
import { computeMetrics, labelBezwaar } from './follow-up-metrics.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  try {
    const recipients = await getAdminRecipients(supabaseAdmin);
    if (recipients.length === 0) {
      return res.status(200).json({ sent: 0, reason: 'Geen recipients gevonden' });
    }

    const metrics = await computeMetrics(supabaseAdmin, { period: 'today' });

    const today = new Date().toISOString().slice(0, 10);
    const { data: alreadySent } = await supabaseAdmin
      .from('follow_up_admin_report_log')
      .select('recipient')
      .eq('notification_type', 'admin_daily')
      .eq('reference_date', today);

    const sentSet = new Set((alreadySent || []).map(r => r.recipient));
    const toSend = recipients.filter(r => !sentSet.has(r.email));

    if (toSend.length === 0) {
      return res.status(200).json({ sent: 0, reason: 'Al verstuurd vandaag' });
    }

    const subject = `Follow-up dagrapport — ${new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' })}`;
    const htmlTemplate = buildDailyHtml(metrics, today);
    const text = buildDailyText(metrics, today);

    const results = [];
    for (const recipient of toSend) {
      const html = htmlTemplate.replace('{{name}}', recipient.full_name || recipient.email);

      const sendResult = await sendMail({ to: recipient.email, subject, text, html });

      if (sendResult.success) {
        await supabaseAdmin
          .from('follow_up_admin_report_log')
          .insert({
            notification_type: 'admin_daily',
            reference_date: today,
            recipient: recipient.email,
            meta: { messageId: sendResult.messageId },
          })
          .then(() => {})
          .catch(err => console.error('[admin-daily] dedup insert error:', err.message));
      }

      results.push({ email: recipient.email, success: sendResult.success, error: sendResult.error });
    }

    await supabaseAdmin
      .from('follow_up_events_log')
      .insert({
        source: 'cron',
        event_type: 'admin_daily_report',
        payload: { recipients: results, metrics_snapshot: { ...metrics, top_bezwaren: metrics.top_bezwaren } },
        processed: true,
      })
      .then(() => {})
      .catch(err => console.error('[admin-daily] audit log error:', err.message));

    return res.status(200).json({
      sent: results.filter(r => r.success).length,
      total: toSend.length,
      results,
    });

  } catch (err) {
    console.error('[admin-daily] exception:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function buildDailyHtml(m, today) {
  const dateStr = new Date(today).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });

  const bezwaarRows = (m.top_bezwaren || []).map(b =>
    `<tr>
      <td style="padding:6px 0; color:#374151;">${labelBezwaar(b.naam)}</td>
      <td style="padding:6px 0; text-align:right; font-weight:600;">${b.count}</td>
    </tr>`
  ).join('');

  const overdueColor = m.opvolgingen_overdue > 0 ? '#dc2626' : '#16a34a';
  const conversionColor = m.conversion_rate === null ? '#6b7280'
    : m.conversion_rate >= 50 ? '#16a34a'
    : m.conversion_rate < 30 ? '#dc2626'
    : '#6b7280';

  const body = `
    <p style="margin:0 0 16px; color:#374151; font-size:14px;">Hi {{name}},</p>
    <p style="margin:0 0 24px; color:#374151; font-size:14px;">Hier is het dagrapport voor <strong>${dateStr}</strong>.</p>

    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">📞 Afspraken vandaag</h2>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; font-size:14px;">
      <tr><td style="padding:6px 0; color:#374151;">Totaal gepland</td><td style="text-align:right; font-weight:600;">${m.appointments_total}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Afgerond</td><td style="text-align:right; font-weight:600; color:#16a34a;">${m.appointments_completed}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">No-shows</td><td style="text-align:right; font-weight:600; color:${m.appointments_no_show > 0 ? '#dc2626' : '#6b7280'};">${m.appointments_no_show}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Voicememo's verstuurd</td><td style="text-align:right; font-weight:600;">${m.voicememos_sent}</td></tr>
    </table>

    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">📝 Outcomes vandaag</h2>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; font-size:14px;">
      <tr><td style="padding:6px 0; color:#374151;">Totaal ingevuld</td><td style="text-align:right; font-weight:600;">${m.outcomes_total}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Klant geworden</td><td style="text-align:right; font-weight:600; color:#16a34a;">${m.outcomes_klant}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Geen klant</td><td style="text-align:right; font-weight:600;">${m.outcomes_geen_klant}</td></tr>
    </table>

    ${m.conversion_rate !== null ? `
    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">📈 Conversion vandaag</h2>
    <p style="margin:0; font-size:28px; font-weight:700; color:${conversionColor};">${m.conversion_rate}%</p>
    ` : ''}

    ${bezwaarRows ? `
    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">🚧 Top bezwaren vandaag</h2>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; font-size:14px;">
      ${bezwaarRows}
    </table>
    ` : ''}

    ${m.outcomes_missing_today > 0 ? `
    <div style="padding:12px 16px; background:#fef3c7; border-left:4px solid #d97706; border-radius:4px; margin:16px 0;">
      <p style="margin:0; font-size:14px; color:#92400e;"><strong>⚠ ${m.outcomes_missing_today} outcome${m.outcomes_missing_today > 1 ? 's' : ''} nog niet ingevuld vandaag.</strong></p>
      <p style="margin:4px 0 0; font-size:13px; color:#78350f;">Open de Follow-up Module om deze in te vullen voor het eind van de dag.</p>
    </div>
    ` : ''}

    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">⚠️ Achterstallig (totaal)</h2>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; font-size:14px;">
      <tr><td style="padding:6px 0; color:#374151;">Opvolgingen over tijd</td><td style="text-align:right; font-weight:600; color:${m.achterstallig_opvolgingen > 0 ? '#dc2626' : '#6b7280'};">${m.achterstallig_opvolgingen ?? m.opvolgingen_overdue}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Outcomes ontbrekend</td><td style="text-align:right; font-weight:600; color:${(m.achterstallig_outcomes ?? 0) > 0 ? '#dc2626' : '#6b7280'};">${m.achterstallig_outcomes ?? 0}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Voicememo's uitstaand</td><td style="text-align:right; font-weight:600; color:${(m.achterstallig_voicememos ?? 0) > 0 ? '#dc2626' : '#6b7280'};">${m.achterstallig_voicememos ?? 0}</td></tr>
    </table>
    <p style="margin:8px 0 0; font-size:28px; font-weight:700; color:${overdueColor};">${m.achterstallig_totaal ?? m.opvolgingen_overdue}</p>
    ${(m.achterstallig_totaal ?? m.opvolgingen_overdue) > 0 ? '<p style="margin:8px 0 0; color:#6b7280; font-size:13px;">Open de Follow-up Module om deze af te handelen.</p>' : ''}
  `;

  return wrapEmailHtml('Dagrapport Follow-up Module', body);
}

function buildDailyText(m, today) {
  const dateStr = new Date(today).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
  return `Follow-up dagrapport — ${dateStr}

AFSPRAKEN VANDAAG
  Totaal gepland: ${m.appointments_total}
  Afgerond: ${m.appointments_completed}
  No-shows: ${m.appointments_no_show}
  Voicememo's verstuurd: ${m.voicememos_sent}

OUTCOMES
  Totaal ingevuld: ${m.outcomes_total}
  Klant geworden: ${m.outcomes_klant}
  Geen klant: ${m.outcomes_geen_klant}
${m.conversion_rate !== null ? `  Conversion: ${m.conversion_rate}%` : ''}

${m.outcomes_missing_today > 0 ? `⚠ OUTCOMES ONTBREKEND VANDAAG: ${m.outcomes_missing_today}\n` : ''}
ACHTERSTALLIG TOTAAL: ${m.achterstallig_totaal ?? m.opvolgingen_overdue}
  Opvolgingen: ${m.achterstallig_opvolgingen ?? m.opvolgingen_overdue}
  Outcomes ontbrekend: ${m.achterstallig_outcomes ?? 0}
  Voicememo's uitstaand: ${m.achterstallig_voicememos ?? 0}

---
Agency Command Center — Follow-up Module
De Forex Opleiding NL B.V.`;
}
