// api/follow-up-admin-weekly.js
//
// Cron: zondag 10:00 NL (08:00 UTC) — verstuurt week-KPI-rapport
// aan alle super_admin/manager profielen.
//
// Schedule: 0 8 * * 0
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

    const metrics = await computeMetrics(supabaseAdmin, { period: 'week' });

    const today = new Date().toISOString().slice(0, 10);
    const { data: alreadySent } = await supabaseAdmin
      .from('follow_up_admin_report_log')
      .select('recipient')
      .eq('notification_type', 'admin_weekly')
      .eq('reference_date', today);

    const sentSet = new Set((alreadySent || []).map(r => r.recipient));
    const toSend = recipients.filter(r => !sentSet.has(r.email));

    if (toSend.length === 0) {
      return res.status(200).json({ sent: 0, reason: 'Al verstuurd deze week' });
    }

    const weekNum = getISOWeek(new Date());
    const subject = `Follow-up weekrapport — week ${weekNum}`;
    const htmlTemplate = buildWeeklyHtml(metrics, weekNum);
    const text = buildWeeklyText(metrics, weekNum);

    const results = [];
    for (const recipient of toSend) {
      const html = htmlTemplate.replace('{{name}}', recipient.full_name || recipient.email);

      const sendResult = await sendMail({ to: recipient.email, subject, text, html });

      if (sendResult.success) {
        await supabaseAdmin
          .from('follow_up_admin_report_log')
          .insert({
            notification_type: 'admin_weekly',
            reference_date: today,
            recipient: recipient.email,
            meta: { messageId: sendResult.messageId, week: weekNum },
          })
          .then(() => {})
          .catch(err => console.error('[admin-weekly] dedup insert error:', err.message));
      }

      results.push({ email: recipient.email, success: sendResult.success, error: sendResult.error });
    }

    await supabaseAdmin
      .from('follow_up_events_log')
      .insert({
        source: 'cron',
        event_type: 'admin_weekly_report',
        payload: { recipients: results, week: weekNum },
        processed: true,
      })
      .then(() => {})
      .catch(err => console.error('[admin-weekly] audit log error:', err.message));

    return res.status(200).json({
      sent: results.filter(r => r.success).length,
      total: toSend.length,
      results,
    });

  } catch (err) {
    console.error('[admin-weekly] exception:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function buildWeeklyHtml(m, weekNum) {
  const bezwaarRows = (m.top_bezwaren || []).map(b =>
    `<tr>
      <td style="padding:6px 0; color:#374151;">${labelBezwaar(b.naam)}</td>
      <td style="padding:6px 0; text-align:right; font-weight:600;">${b.count}</td>
    </tr>`
  ).join('');

  const conversionColor = m.conversion_rate === null ? '#6b7280'
    : m.conversion_rate >= 50 ? '#16a34a'
    : m.conversion_rate < 30 ? '#dc2626'
    : '#6b7280';
  const noShowColor = m.no_show_rate === null ? '#6b7280'
    : m.no_show_rate <= 10 ? '#16a34a'
    : m.no_show_rate > 25 ? '#dc2626'
    : '#6b7280';

  const body = `
    <p style="margin:0 0 16px; color:#374151; font-size:14px;">Hi {{name}},</p>
    <p style="margin:0 0 24px; color:#374151; font-size:14px;">Hier is het weekrapport voor <strong>week ${weekNum}</strong>.</p>

    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">📊 Volume deze week</h2>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; font-size:14px;">
      <tr><td style="padding:6px 0; color:#374151;">Totaal afspraken</td><td style="text-align:right; font-weight:600;">${m.appointments_total}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Afgerond</td><td style="text-align:right; font-weight:600;">${m.appointments_completed}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Outcomes ingevuld</td><td style="text-align:right; font-weight:600;">${m.outcomes_total}</td></tr>
      <tr><td style="padding:6px 0; color:#374151;">Klant geworden</td><td style="text-align:right; font-weight:600; color:#16a34a;">${m.outcomes_klant}</td></tr>
    </table>

    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">📈 KPI's week ${weekNum}</h2>
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td width="48%" valign="top" style="padding:12px; background:#f8f9fa; border-radius:6px;">
          <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Conversion rate</div>
          <div style="font-size:28px; font-weight:700; color:${conversionColor}; margin-top:4px;">${m.conversion_rate !== null ? m.conversion_rate + '%' : '—'}</div>
        </td>
        <td width="4%"></td>
        <td width="48%" valign="top" style="padding:12px; background:#f8f9fa; border-radius:6px;">
          <div style="color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">No-show rate</div>
          <div style="font-size:28px; font-weight:700; color:${noShowColor}; margin-top:4px;">${m.no_show_rate !== null ? m.no_show_rate + '%' : '—'}</div>
        </td>
      </tr>
    </table>

    ${bezwaarRows ? `
    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">🚧 Top bezwaren deze week</h2>
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse; font-size:14px;">
      ${bezwaarRows}
    </table>
    ` : ''}

    <h2 style="color:#093d54; font-size:16px; margin:24px 0 12px;">⚠️ Achterstallige opvolgingen</h2>
    <p style="margin:0; font-size:28px; font-weight:700; color:${m.opvolgingen_overdue > 0 ? '#dc2626' : '#16a34a'};">${m.opvolgingen_overdue}</p>
  `;

  return wrapEmailHtml(`Weekrapport — week ${weekNum}`, body);
}

function buildWeeklyText(m, weekNum) {
  return `Follow-up weekrapport — week ${weekNum}

VOLUME
  Totaal afspraken: ${m.appointments_total}
  Afgerond: ${m.appointments_completed}
  Outcomes ingevuld: ${m.outcomes_total}
  Klant geworden: ${m.outcomes_klant}

KPI'S
  Conversion rate: ${m.conversion_rate !== null ? m.conversion_rate + '%' : '—'}
  No-show rate: ${m.no_show_rate !== null ? m.no_show_rate + '%' : '—'}

ACHTERSTALLIGE OPVOLGINGEN: ${m.opvolgingen_overdue}

---
Agency Command Center — Follow-up Module
De Forex Opleiding NL B.V.`;
}
