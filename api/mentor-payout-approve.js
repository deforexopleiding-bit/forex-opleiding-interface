// api/mentor-payout-approve.js
//
// Fase 2 — Akkoord-knop. Markeert een concept als 'goedgekeurd' en stuurt een
// notificatie-mail naar de mentor. RAAKT DE LEDGER NIET AAN (uitbetaald +
// payout_id koppeling komt pas in fase 3).
//
// Permission: mentor.payout.manage.
//
// Body: { payout_id: uuid }
//
// Flow:
//   1) Laad payout (status moet 'concept' of 'open' zijn — 'goedgekeurd' /
//      'uitbetaald' → 409 zonder side-effects).
//   2) HERBEREKEN het concept eerst (computeAndUpsertConcept). Dit garandeert
//      dat we niet op stale snapshot-cijfers goedkeuren (bv. als finance
//      vlak ervoor een handmatige post heeft toegevoegd). Faalt het
//      herberekenen → 500 zonder status te wijzigen.
//   3) UPDATE mentor_payouts: status='goedgekeurd', approved_at=now(),
//      approved_by=auth.uid().
//   4) Lees mentor-email (team_members.email WHERE user_id=mentor_user_id)
//      + verse totalen voor de mail.
//   5) sendMail naar de mentor (fail-soft: emailSent kan false zijn maar de
//      status-wijziging blijft staan).
//
// Response 200: { ok:true, status, approved_at, emailSent:boolean,
//                 emailReason?:string, total, total_excl, btw_amount, period_month }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeAndUpsertConcept } from './_lib/payout-generate-core.js';
import { createNotification } from './_lib/notify.js';
import { sendMail } from './_lib/email.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NL_MONTHS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

function fmtMonthNL(periodMonth) {
  // periodMonth = 'YYYY-MM-DD' (1e v/d maand)
  if (typeof periodMonth !== 'string') return '';
  const m = periodMonth.match(/^(\d{4})-(\d{2})/);
  if (!m) return periodMonth;
  const y = m[1];
  const mo = parseInt(m[2], 10);
  return `${NL_MONTHS[mo - 1] || mo} ${y}`;
}

function fmtEUR(n) {
  const v = Number(n) || 0;
  // €1.234,56 — nl-NL.
  return v.toLocaleString('nl-NL', {
    style                : 'currency',
    currency             : 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtml({ mentorName, monthNL, total, totalExcl, btw }) {
  const safeName  = esc(mentorName || 'mentor');
  const safeMonth = esc(monthNL);
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Inter,system-ui,sans-serif;color:#0f172a">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
        <tr><td style="padding:24px 28px;background:#0a2f63;color:#ffffff">
          <div style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;opacity:0.7">De Forex Opleiding</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">Je uitbetalingsrapport</div>
        </td></tr>
        <tr><td style="padding:28px">
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px">Hoi ${safeName},</p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px">
            Je uitbetalingsrapport voor <strong>${safeMonth}</strong> is goedgekeurd en staat klaar in je mentordashboard.
          </p>

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
            <tr>
              <td style="padding:14px 16px;font-size:13px;color:#475569;background:#f8fafc;border-bottom:1px solid #e2e8f0">Totaal incl. btw</td>
              <td style="padding:14px 16px;font-size:18px;font-weight:700;text-align:right;background:#f8fafc;border-bottom:1px solid #e2e8f0">${esc(fmtEUR(total))}</td>
            </tr>
            <tr>
              <td style="padding:10px 16px;font-size:13px;color:#64748b">Excl. btw</td>
              <td style="padding:10px 16px;font-size:13px;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums">${esc(fmtEUR(totalExcl))}</td>
            </tr>
            <tr>
              <td style="padding:10px 16px 14px;font-size:13px;color:#64748b">Btw (21%)</td>
              <td style="padding:10px 16px 14px;font-size:13px;color:#0f172a;text-align:right;font-variant-numeric:tabular-nums">${esc(fmtEUR(btw))}</td>
            </tr>
          </table>

          <p style="font-size:15px;line-height:1.55;margin:0 0 14px">
            Log in op het <strong>mentordashboard → Uitbetalingen</strong> voor de details
            en stuur je factuur voor dit bedrag.
          </p>
          <p style="font-size:13px;line-height:1.55;color:#64748b;margin:20px 0 0">
            Vragen? Reageer op deze mail en we kijken het samen na.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11.5px;color:#64748b">
          Deze mail is automatisch verstuurd vanuit het mentor-platform.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
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
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const payoutId = typeof body.payout_id === 'string' ? body.payout_id.trim() : '';
  if (!payoutId || !UUID_RE.test(payoutId)) {
    return res.status(400).json({ error: 'payout_id (uuid) vereist' });
  }

  try {
    // 1) Payout laden + status-check (geen side-effects bij definitief).
    const { data: payout, error: loadErr } = await supabaseAdmin
      .from('mentor_payouts')
      .select('id, mentor_user_id, period_month, status')
      .eq('id', payoutId)
      .maybeSingle();
    if (loadErr) throw new Error('payout load: ' + loadErr.message);
    if (!payout) return res.status(404).json({ error: 'Rapport niet gevonden' });

    if (payout.status === 'goedgekeurd' || payout.status === 'uitbetaald') {
      return res.status(409).json({
        error  : `al ${payout.status}`,
        code   : payout.status === 'uitbetaald' ? 'ALREADY_PAID' : 'ALREADY_APPROVED',
        status : payout.status,
      });
    }

    // 2) Herberekenen vóór de status-wijziging — geen goedkeuring op stale cijfers.
    try {
      const r = await computeAndUpsertConcept({
        mentorUserId: payout.mentor_user_id,
        monthStart  : payout.period_month,
        actorId     : user.id,
      });
      if (r?.skipped) {
        // Core skipt alleen bij definitief — hier kan dat eigenlijk niet meer
        // gebeuren door de check hierboven, maar defensief afvangen.
        return res.status(409).json({
          error : 'rapport is reeds definitief geworden tijdens herrekening',
          code  : 'REFRESH_RACE',
        });
      }
    } catch (e) {
      console.error('[mentor-payout-approve] recompute faalde:', e?.message || e);
      return res.status(500).json({ error: 'kon niet herberekenen, probeer opnieuw' });
    }

    // 3) Status → goedgekeurd. Atomair update + meteen verse totalen ophalen.
    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('mentor_payouts')
      .update({
        status      : 'goedgekeurd',
        approved_at : nowIso,
        approved_by : user.id,
      })
      .eq('id', payoutId)
      .select('mentor_user_id, period_month, status, approved_at, total, total_excl, btw_amount')
      .single();
    if (updErr) throw new Error('payout update: ' + updErr.message);

    // 4) Mentor-email ophalen (fail-soft op niet-gevonden → mail wordt skipped).
    let mentorEmail = null;
    let mentorName  = null;
    try {
      const { data: tm, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('email, name')
        .eq('user_id', updated.mentor_user_id)
        .maybeSingle();
      if (tmErr) throw new Error(tmErr.message);
      mentorEmail = tm?.email || null;
      mentorName  = tm?.name  || null;
    } catch (e) {
      console.warn('[mentor-payout-approve] team_members lookup faalde:', e?.message || e);
    }

    // 5) Mail versturen (fail-soft). Geen mail-adres → markeer als niet-verzonden.
    let emailSent   = false;
    let emailReason = null;
    if (!mentorEmail) {
      emailReason = 'mentor heeft geen e-mailadres in team_members';
    } else {
      const monthNL = fmtMonthNL(updated.period_month);
      const html = buildHtml({
        mentorName,
        monthNL,
        total    : updated.total,
        totalExcl: updated.total_excl,
        btw      : updated.btw_amount,
      });
      const result = await sendMail({
        to     : mentorEmail,
        subject: `Je uitbetalingsrapport voor ${monthNL} staat klaar`,
        html,
      });
      emailSent   = !!result.sent;
      emailReason = result.sent ? null : (result.reason || 'onbekende reden');
    }

    // Fail-soft dual-write naar unified notifications-tabel: fan-out
    // naar management-rollen (helper dedupt user_ids).
    const monthNLBody = fmtMonthNL(updated.period_month);
    createNotification({
      toRole:     ['manager', 'super_admin'],
      type:       'payout.approved',
      title:      'Payout goedgekeurd · ' + (mentorName || 'Mentor') + (monthNLBody ? (' (' + monthNLBody + ')') : ''),
      body:       (mentorName || 'Mentor') + ' — ' + monthNLBody,
      linkUrl:    '/modules/mentor-payouts-admin.html',
      entityType: 'payout',
      entityId:   payoutId,
      createdBy:  user.id,
    }).catch(() => {});

    return res.status(200).json({
      ok          : true,
      status      : updated.status,
      approved_at : updated.approved_at,
      total       : Number(updated.total)      || 0,
      total_excl  : Number(updated.total_excl) || 0,
      btw_amount  : Number(updated.btw_amount) || 0,
      period_month: updated.period_month,
      mentor_email: mentorEmail,
      emailSent,
      emailReason,
    });
  } catch (e) {
    console.error('[mentor-payout-approve]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
