// api/cron/first-call-payment-reminder.js
//
// Uur-cron — stuurt 24u vóór een geplande 1-op-1 call een betaalherinnering
// (WhatsApp + e-mail) als de eerste factuur van de klant nog onbetaald is.
//
// ── BRON: hlms_sessie in dfo-lms (NIET meer Bubble) ──────────────────────
// De mentoren werken sinds augustus 2026 in het nieuwe LMS. Deze cron keek
// nog naar Bubble-'1-1-session', vond daar niets, en meldde elk uur netjes
// `checked: 0` — wat las als "er stond niets gepland". Gevolg: klanten met
// een openstaande eerste factuur kregen géén herinnering meer, en niemand
// zag dat, want de cron zag er kerngezond uit.
//
// Daarom geeft de uitkomst nu ALTIJD `bron_status` mee. Een mislukte
// bevraging eindigt met ok:false en een 502; alleen bij `bron_status:
// 'gelezen'` betekent `checked: 0` echt dat er niets gepland stond.
// Zie api/_lib/dfo-lms-sessies.js.
//
// ── LET OP DE KOLOMNAAM `bubble_session_id` ──────────────────────────────
// De idempotentie-marker staat in first_call_payment_reminders, uniek op
// `bubble_session_id`. Daar gaat nu een hlms_sessie-uuid in. De NAAM klopt
// dus niet meer, de WERKING wel: een uuid en een Bubble-id kunnen nooit
// botsen, dus oude en nieuwe markers staan elkaar niet in de weg en geen
// enkele klant krijgt een dubbele herinnering.
//
// Bewust niet hernoemd: dat is een migratie op een productietabel voor
// alleen een naam, en migraties lopen hier via een mens. Wil je 'm alsnog
// hernoemen, doe dat dan samen met de andere Bubble-restanten in één keer.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
//
// FLOW (per sessie, fail-soft):
//   1) hlms_sessie waar start_tijd ∈ (now, now+24u), afgehandelde sessies
//      (status 'afgerond' / 'no_show') eruit, student-e-mail erbij.
//   2) Per sessie:
//      - sessionId + member resolven; skip bij ontbrekend.
//      - Idempotentie-precheck: bestaat al een rij in
//        first_call_payment_reminders met dit sessie-id? → skip.
//      - student-e-mail komt uit hlms_student via sessie.student_id,
//        al genormaliseerd naar kleine letters door de bron.
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
import { haalSessiesInVenster, BRON_GELEZEN } from '../_lib/dfo-lms-sessies.js';
import { sendOnboardingTemplateGeneric } from '../_lib/onboarding-template-send.js';
import { sendOnboardingMail } from '../mailer.js';
import { ensureInvoicePaymentLink } from '../_lib/invoice-payment-link.js';

const WA_TEMPLATE = 'betaalherinnering_eerste_call';
const FETCH_CAP   = 200;

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
    // De BRON expliciet in de uitkomst. Zonder dit is 'checked: 0' niet te
    // onderscheiden van een mislukte bevraging — precies de verwarring die
    // deze cron maandenlang stil hield toen Bubble leegliep.
    bron: 'hlms_sessie',
    bron_status: null,
    venster: null,
    totaal_in_venster: 0,
    overgeslagen_afgehandeld: 0,
    zonder_student: 0,
    zonder_email: 0,
    checked: 0,
    sent_wa: 0,
    sent_email: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const now   = new Date();
    const in24h = new Date(now.getTime() + 24 * 3_600_000);

    result.venster = { van: now.toISOString(), tot: in24h.toISOString() };

    const bron = await haalSessiesInVenster({
      vanIso: now.toISOString(),
      totIso: in24h.toISOString(),
      limiet: FETCH_CAP,
    });

    result.bron_status              = bron.bron_status;
    result.totaal_in_venster        = bron.totaal_in_venster;
    result.overgeslagen_afgehandeld = bron.overgeslagen_afgehandeld;
    result.zonder_student           = bron.zonder_student;
    result.zonder_email             = bron.zonder_email;

    // MISLUKTE BEVRAGING IS GEEN LEGE UITKOMST. Stoppen met een duidelijke
    // fout, zodat een storing niet als 'er stond niets gepland' voorbijgaat.
    if (bron.bron_status !== BRON_GELEZEN) {
      result.ok = false;
      result.error = 'sessies niet gelezen (' + bron.bron_status + '): '
        + (bron.fout || 'reden onbekend');
      console.error('[first-call-payment-reminder]', result.error);
      return res.status(502).json(result);
    }

    const sessions = bron.sessies;
    result.checked = sessions.length;

    // Vanaf hier is 'checked: 0' een FEIT: de bron is gelezen en er stonden
    // geen open sessies in het venster van 24 uur.
    if (sessions.length === 0) {
      console.log('[first-call-payment-reminder] bron gelezen, geen open sessies in venster'
        + ' (totaal ' + bron.totaal_in_venster + ', afgehandeld ' + bron.overgeslagen_afgehandeld + ')');
    }

    for (const s of sessions) {
      try {
        const sessionId    = s.id;
        const callAt       = s.start_tijd || null;
        const studentEmail = s.email;   // komt al genormaliseerd uit de bron

        // Idempotentie-precheck.
        const { data: existing, error: exErr } = await supabaseAdmin
          .from('first_call_payment_reminders')
          .select('id')
          // Kolomnaam is historisch: hier gaat sinds de LMS-overgang een
          // hlms_sessie-uuid in. Zie de toelichting in de kop.
          .eq('bubble_session_id', sessionId)
          .maybeSingle();
        if (exErr) {
          console.error('[first-call-payment-reminder] precheck:', exErr.message);
          result.errors.push({ session_id: sessionId, stage: 'precheck', error: exErr.message });
          continue;
        }
        if (existing) { result.skipped++; continue; }

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

        // Betaalcheck: heeft de klant ERGENS een betaling gedaan (volledig óf
        // aanbetaling/deelbetaling)? → dan starten ze gewoon → geen reminder.
        // Aanbetalingen zetten een factuur op status='partially_paid' met
        // amount_paid > 0; alleen .eq('status','paid') zou die missen.
        const { data: paidInv, error: paidErr } = await supabaseAdmin
          .from('invoices')
          .select('id')
          .eq('customer_id', cust.id)
          .gt('amount_paid', 0)
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
              // Historische naam, zie kop: dit is nu een hlms_sessie-uuid.
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
