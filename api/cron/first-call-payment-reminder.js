// api/cron/first-call-payment-reminder.js
//
// Uur-cron — stuurt 24u vóór een in Bubble geplande 1-op-1 call een
// betaalherinnering (WhatsApp + e-mail) als de eerste factuur van de klant
// nog onbetaald is. Idempotent per call via tabel
// first_call_payment_reminders (unique op bubble_session_id).
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
//
// FLOW (per sessie, fail-soft):
//   1) Bubble 1-1-session waar starting_date_date ∈ (now, now+24u).
//   2) Per sessie:
//      - sessionId + member resolven; skip bij ontbrekend.
//      - Idempotentie-precheck: bestaat al een rij in
//        first_call_payment_reminders met deze bubble_session_id? → skip.
//      - student-email via bubbleGet('user', member) +
//        bubbleUserDisplay (mirror mentorStudents.js: genest pad
//        authentication.email.email + fallbacks; al lowercased).
//      - customer matchen op (case-insensitive) email; geen → skip.
//      - actieve onboarding van klant (status NOT IN gearchiveerd|afgerond
//        AND archived_at IS NULL); geen → skip.
//      - betaalcheck: invoices status='paid' bestaat → klant heeft betaald
//        → skip (geen reminder nodig).
//      - open factuur ophalen + ensureInvoicePaymentLink voor de e-mail
//        (WA-send doet dit intern via PR #479).
//      - WhatsApp via sendOnboardingTemplateGeneric (APPROVED-gate intern).
//      - E-mail via sendOnboardingMail (alleen als klant.email aanwezig).
//      - MARKEREN: alleen als ≥1 kanaal succesvol; NIET markeren als beide
//        falen zodat de volgende run opnieuw mag proberen.
//
// Return: { ok, checked, sent_wa, sent_email, skipped, errors }.

import { supabaseAdmin } from '../supabase.js';
import { bubbleList, bubbleGet, bubbleUserDisplay } from '../_lib/bubble.js';
import { sendOnboardingTemplateGeneric } from '../_lib/onboarding-template-send.js';
import { sendOnboardingMail } from '../mailer.js';
import { ensureInvoicePaymentLink } from '../_lib/invoice-payment-link.js';

const WA_TEMPLATE = 'betaalherinnering_eerste_call';
const FETCH_CAP   = 200;

// Mirror van noshow-detect: defensieve readers voor Bubble's suffix-conventie.
function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) if (u[k] !== undefined) return u[k];
  return undefined;
}
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmailHtml(voornaam, betaallink) {
  const naam = escHtml(voornaam || 'daar');
  const link = betaallink || '';
  const cta = link
    ? `<p><a href="${escHtml(link)}" style="display:inline-block;background:#1e6cd6;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Betaal nu</a></p>`
    : `<p>Neem gerust contact met ons op voor de betaallink.</p>`;
  return (
    `<p>Hoi ${naam},</p>` +
    `<p>Je eerste 1-op-1 call bij De Forex Opleiding staat binnenkort gepland. We zien dat je eerste factuur nog openstaat.</p>` +
    `<p>Wil je deze graag <strong>vóór de call</strong> voldoen?</p>` +
    cta +
    `<p>Vragen? Stuur ons gerust een bericht.</p>` +
    `<p>— De Forex Opleiding</p>`
  );
}
function buildEmailText(voornaam, betaallink) {
  const naam = voornaam || 'daar';
  const linkLine = betaallink
    ? `Betaal direct: ${betaallink}\n`
    : `Neem gerust contact met ons op voor de betaallink.\n`;
  return (
    `Hoi ${naam},\n\n` +
    `Je eerste 1-op-1 call bij De Forex Opleiding staat binnenkort gepland. We zien dat je eerste factuur nog openstaat.\n\n` +
    `Wil je deze graag vóór de call voldoen?\n\n` +
    linkLine +
    `\nVragen? Stuur ons gerust een bericht.\n\n— De Forex Opleiding`
  );
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // AUTH — identiek aan future-call-reminder.js / noshow-detect.js.
  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = {
    ok: true,
    checked: 0,
    sent_wa: 0,
    sent_email: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const now   = new Date();
    const in24h = new Date(now.getTime() + 24 * 3_600_000);

    let sessions = [];
    try {
      const { results } = await bubbleList('1-1-session', [
        { key: 'starting_date_date', constraint_type: 'greater than', value: now.toISOString() },
        { key: 'starting_date_date', constraint_type: 'less than',    value: in24h.toISOString() },
      ], { limit: FETCH_CAP });
      sessions = Array.isArray(results) ? results : [];
    } catch (e) {
      console.error('[first-call-payment-reminder] bubble fetch failed:', e?.message || e);
      return res.status(502).json({ ok: false, error: 'bubble fetch failed: ' + (e?.message || e), result });
    }
    result.checked = sessions.length;

    for (const s of sessions) {
      try {
        const sessionId = String(s?._id || '').trim();
        const memberRaw = readFirst(s, ['member_user']);
        const callAt    = readFirst(s, ['starting_date_date', 'starting date']) || null;

        // Bubble-list kan member als array of string teruggeven.
        let memberId = null;
        if (Array.isArray(memberRaw)) memberId = String(memberRaw[0] || '').trim();
        else if (memberRaw)            memberId = String(memberRaw).trim();

        if (!sessionId || !memberId) { result.skipped++; continue; }

        // Idempotentie-precheck.
        const { data: existing, error: exErr } = await supabaseAdmin
          .from('first_call_payment_reminders')
          .select('id')
          .eq('bubble_session_id', sessionId)
          .maybeSingle();
        if (exErr) {
          console.error('[first-call-payment-reminder] precheck:', exErr.message);
          result.errors.push({ session_id: sessionId, stage: 'precheck', error: exErr.message });
          continue;
        }
        if (existing) { result.skipped++; continue; }

        // Student e-mail via Bubble.
        let studentEmail = '';
        try {
          const stu = await bubbleGet('user', memberId);
          if (stu) {
            const disp = bubbleUserDisplay(stu);
            studentEmail = disp.email ? String(disp.email).trim().toLowerCase() : '';
          }
        } catch (e) {
          console.warn('[first-call-payment-reminder] bubble user fetch failed for', memberId, ':', e?.message || e);
        }
        if (!studentEmail) { result.skipped++; continue; }

        // Customer matchen (case-insensitive exact).
        const { data: cust, error: custErr } = await supabaseAdmin
          .from('customers')
          .select('id, first_name, email, phone')
          .ilike('email', studentEmail)
          .limit(1)
          .maybeSingle();
        if (custErr) {
          console.error('[first-call-payment-reminder] customer lookup:', custErr.message);
          result.errors.push({ session_id: sessionId, stage: 'customer', error: custErr.message });
          continue;
        }
        if (!cust?.id) { result.skipped++; continue; }

        // Actieve onboarding.
        const { data: onboarding, error: obErr } = await supabaseAdmin
          .from('onboardings')
          .select('id, status, archived_at')
          .eq('customer_id', cust.id)
          .not('status', 'in', '("gearchiveerd","afgerond")')
          .is('archived_at', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (obErr) {
          console.error('[first-call-payment-reminder] onboarding lookup:', obErr.message);
          result.errors.push({ session_id: sessionId, stage: 'onboarding', error: obErr.message });
          continue;
        }
        if (!onboarding?.id) { result.skipped++; continue; }

        // Betaalcheck: bestaat er een betaalde factuur? → klant heeft betaald → niets sturen.
        const { data: paidInv, error: paidErr } = await supabaseAdmin
          .from('invoices')
          .select('id')
          .eq('customer_id', cust.id)
          .eq('status', 'paid')
          .limit(1)
          .maybeSingle();
        if (paidErr) {
          console.error('[first-call-payment-reminder] paid-check:', paidErr.message);
          result.errors.push({ session_id: sessionId, stage: 'paid-check', error: paidErr.message });
          continue;
        }
        if (paidInv) { result.skipped++; continue; }

        // Open factuur + betaallink (voor de e-mail; WA-send haalt 'm intern).
        let betaallink = '';
        try {
          const { data: openInvs } = await supabaseAdmin
            .from('invoices')
            .select('id, invoice_number, status, amount_total, amount_paid, credited_amount, due_date, payment_url')
            .eq('customer_id', cust.id)
            .in('status', ['open', 'partially_paid', 'overdue'])
            .order('due_date', { ascending: true })
            .limit(1);
          const inv = (openInvs && openInvs[0]) || null;
          if (inv?.id) {
            try {
              const linkRes = await ensureInvoicePaymentLink(inv.id);
              betaallink = (linkRes && linkRes.payment_url) || inv.payment_url || '';
            } catch (e) {
              console.warn('[first-call-payment-reminder] payment-link:', e?.message || e);
              betaallink = inv.payment_url || '';
            }
          }
        } catch (e) {
          console.warn('[first-call-payment-reminder] open-invoice fetch:', e?.message || e);
        }

        // VERZENDEN — beide kanalen onafhankelijk, fail-soft.
        let waSent = false, emailSent = false;
        try {
          const wa = await sendOnboardingTemplateGeneric({
            onboardingId: onboarding.id,
            templateName: WA_TEMPLATE,
            source:       'first-call-payment-reminder',
            auditAction:  'onboarding.payment_reminder.sent',
          });
          waSent = !!(wa && wa.sent === true);
        } catch (e) {
          console.error('[first-call-payment-reminder] WA send:', e?.message || e);
          result.errors.push({ session_id: sessionId, stage: 'wa-send', error: e?.message || String(e) });
        }

        if (cust.email) {
          try {
            const subject = 'Betaalherinnering — vóór je eerste call bij De Forex Opleiding';
            const mailRes = await sendOnboardingMail({
              to:      cust.email,
              subject,
              html:    buildEmailHtml(cust.first_name || '', betaallink),
              text:    buildEmailText(cust.first_name || '', betaallink),
            });
            emailSent = !!(mailRes && mailRes.success === true);
          } catch (e) {
            console.error('[first-call-payment-reminder] mail send:', e?.message || e);
            result.errors.push({ session_id: sessionId, stage: 'mail-send', error: e?.message || String(e) });
          }
        }

        if (waSent)    result.sent_wa++;
        if (emailSent) result.sent_email++;

        // MARKEREN: alleen als ≥1 kanaal succesvol verstuurd. Anders niet —
        // dan probeert de volgende run opnieuw.
        if (waSent || emailSent) {
          const { error: insErr } = await supabaseAdmin
            .from('first_call_payment_reminders')
            .insert({
              bubble_session_id: sessionId,
              onboarding_id:     onboarding.id,
              customer_id:       cust.id,
              call_at:           callAt,
              wa_sent:           waSent,
              email_sent:        emailSent,
            });
          if (insErr) {
            // 23505 = race-condition (parallelle run heeft 'm al gemarkeerd);
            // negeren is correct: de send is wel afgerond.
            if (insErr.code !== '23505') {
              console.error('[first-call-payment-reminder] marker insert:', insErr.message);
              result.errors.push({ session_id: sessionId, stage: 'marker', error: insErr.message });
            }
          }
        } else {
          result.skipped++;
        }
      } catch (e) {
        const sid = String(s?._id || '');
        console.error('[first-call-payment-reminder] row fail', sid, e?.message || e);
        result.errors.push({ session_id: sid, stage: 'exception', error: e?.message || String(e) });
      }
    }

    console.log(`[first-call-payment-reminder] checked=${result.checked} wa=${result.sent_wa} email=${result.sent_email} skipped=${result.skipped} errors=${result.errors.length}`);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[first-call-payment-reminder]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout', result });
  }
}
