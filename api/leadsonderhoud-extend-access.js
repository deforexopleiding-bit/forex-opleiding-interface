// api/leadsonderhoud-extend-access.js
//
// POST /api/leadsonderhoud-extend-access
// Body: { lead_id: uuid, days?: 7|14|30, to_date?: 'YYYY-MM-DD' }
//
// Bulk-verleng ALLE actieve grants van de lead's lms-gebruiker.
// Semantiek: nieuwe_tot = max(vandaag, huidige toegang_tot) + N dagen
//            of expliciet to_date als absolute einddatum.
// Verstuurt e-mail (SMTP Strato) + WhatsApp-template `toegang_verlengd_nl`
// als notificatie. Beide fail-soft — access-verleng slaagt sowieso.
//
// Auth: RBAC-permission `leads.update` (bestaand voor leadsonderhoud-mutaties).
// 0 incasso-writes. QA-only op testleads/nummers.

import nodemailer from 'nodemailer';
import { supabaseAdmin } from './supabase.js';
import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { zetGrant, vanIso, totIso } from './_lib/lms-provisioning.js';
import { sendTemplate } from './_lib/meta-whatsapp.js';
import { haalLijn } from './_lib/leadsonderhoud-gesprekken.js';

const FROM_ADDRESS = 'info@deforexopleiding.nl';
const WA_TEMPLATE  = 'toegang_verlengd_nl';   // fire-ready; als Meta 't nog niet kent → soft-fail

// YYYY-MM-DD helper (NL-tz agnostisch — grants zijn dag-precisie via vanIso/totIso).
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(dt.getTime()) ? null : dt;
}
function fmtNlDate(ymdStr) {
  const dt = parseYmd(ymdStr);
  if (!dt) return ymdStr;
  return dt.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildEmailOpts({ toEmail, voornaam, einddatumNl }) {
  const html = `<!DOCTYPE html><html lang="nl"><body style="margin:0;padding:0;background:#f4f6f8;font-family:'Inter',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
<tr><td style="background:#093d54;padding:24px 40px;text-align:center;color:#fff;font-weight:600">De Forex Opleiding</td></tr>
<tr><td style="padding:32px 40px;color:#1a2333;font-size:14px;line-height:1.6">
<p style="margin:0 0 14px;font-weight:600">Hoi ${voornaam},</p>
<p style="margin:0 0 14px">Goed nieuws — je toegang tot de cursus is verlengd tot <strong>${einddatumNl}</strong>. Je kunt gewoon verder waar je gebleven was.</p>
<p style="margin:0">Vragen? Reageer gerust op deze mail.</p>
</td></tr>
<tr><td style="padding:16px 40px;border-top:1px solid #edf2f7;text-align:center;color:#9ca3af;font-size:11px">De Forex Opleiding</td></tr>
</table></td></tr></table></body></html>`;
  const text = `Hoi ${voornaam},\n\nGoed nieuws — je toegang tot de cursus is verlengd tot ${einddatumNl}. Je kunt gewoon verder waar je gebleven was.\n\nVragen? Reageer gerust op deze mail.\n\nDe Forex Opleiding`;
  return {
    from:    `"De Forex Opleiding" <${FROM_ADDRESS}>`,
    to:      toEmail,
    subject: 'Je toegang is verlengd',
    text, html,
  };
}

async function sendEmailFailSoft({ toEmail, voornaam, einddatumNl }) {
  try {
    const password = process.env.IMAP_PASS_INFO;
    if (!password) throw new Error('IMAP_PASS_INFO ontbreekt');
    if (!toEmail)  throw new Error('email ontbreekt op lead');
    const transporter = nodemailer.createTransport({
      host: 'smtp.strato.com', port: 465, secure: true,
      auth: { user: FROM_ADDRESS, pass: password },
    });
    await transporter.sendMail(buildEmailOpts({ toEmail, voornaam, einddatumNl }));
    return { ok: true };
  } catch (e) {
    console.warn('[extend-access] email soft-fail:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function sendWaFailSoft({ toPhone, voornaam, einddatumNl }) {
  try {
    if (!toPhone) throw new Error('telefoon ontbreekt op lead');
    // haalLijn() geeft de leadsonderhoud-WA-module (phoneNumberId).
    const lijn = await haalLijn();
    if (!lijn?.phoneNumberId) throw new Error('leadsonderhoud-WA-lijn niet geconfigureerd');
    const digitsOnly = String(toPhone).replace(/\D/g, '');
    if (!digitsOnly) throw new Error('telefoon-normalisatie faalde');
    const { wamid } = await sendTemplate({
      to:            digitsOnly,
      templateName:  WA_TEMPLATE,
      languageCode:  'nl',
      variables:     [String(voornaam || ''), String(einddatumNl || '')],
      phoneNumberId: lijn.phoneNumberId,
    });
    return { ok: true, wamid };
  } catch (e) {
    console.warn('[extend-access] WA soft-fail (template ' + WA_TEMPLATE + ' evt nog niet approved):', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const { lead_id, days, to_date } = req.body || {};
  if (!lead_id) return res.status(400).json({ error: 'lead_id verplicht' });
  if (!days && !to_date) return res.status(400).json({ error: 'days OF to_date vereist' });
  const daysNum = days ? Number(days) : null;
  if (days && (!Number.isFinite(daysNum) || daysNum < 1 || daysNum > 365)) {
    return res.status(400).json({ error: 'days moet 1..365 zijn' });
  }

  try {
    // 1. Lead ophalen (voor naam + email + telefoon).
    const { data: lead, error: lErr } = await supabaseAdmin
      .from('leads')
      .select('id, voornaam, achternaam, email, telefoon_e164')
      .eq('id', lead_id)
      .maybeSingle();
    if (lErr || !lead) return res.status(404).json({ error: 'Lead niet gevonden' });

    // v=2 (2026-08-25) — LOOKUP via trial_warmte i.p.v. fragiele lead_id/email-
    // chain op lms_gebruikers. trial_warmte heeft `lead_id → gebruiker_id`
    // rechtstreeks; werkt voor 7-daagse/minicursus-trials. Fallback: bestaande
    // lms_gebruikers.lead_id / email-match voor niet-trial LMS-accounts.
    let lmsUserId = null;
    let currentTotYmd = null;
    {
      const { data: warm } = await supabaseAdmin
        .from('trial_warmte')
        .select('gebruiker_id, toegang_tot')
        .eq('lead_id', lead_id)
        .maybeSingle();
      if (warm && warm.gebruiker_id) {
        lmsUserId = warm.gebruiker_id;
        currentTotYmd = warm.toegang_tot ? String(warm.toegang_tot).slice(0, 10) : null;
      }
    }
    if (!lmsUserId) {
      let { data: lmsUser } = await supabaseAdmin
        .from('lms_gebruikers')
        .select('id, email, toegang_tot')
        .eq('lead_id', lead_id).maybeSingle();
      if (!lmsUser && lead.email) {
        const { data: byEmail } = await supabaseAdmin
          .from('lms_gebruikers')
          .select('id, email, toegang_tot')
          .eq('email', String(lead.email).toLowerCase()).maybeSingle();
        lmsUser = byEmail || null;
      }
      if (lmsUser) {
        lmsUserId = lmsUser.id;
        currentTotYmd = lmsUser.toegang_tot ? String(lmsUser.toegang_tot).slice(0, 10) : null;
      }
    }
    if (!lmsUserId) {
      return res.status(404).json({ error: 'Deze lead heeft geen LMS-account.' });
    }

    // Nieuwe toegang_tot bepalen. days = max(today, current) + N.
    //   to_date = absolute waarde (overschrijft).
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayYmd = ymd(today);
    let finalYmd = null;

    if (to_date) {
      const dt = parseYmd(to_date);
      if (!dt) return res.status(400).json({ error: 'to_date moet YYYY-MM-DD zijn' });
      finalYmd = ymd(dt);
    } else {
      const base = (currentTotYmd && currentTotYmd > todayYmd) ? parseYmd(currentTotYmd) : today;
      const next = new Date(base);
      next.setDate(next.getDate() + daysNum);
      finalYmd = ymd(next);
    }

    // Primaire write: lms_gebruikers.toegang_tot (bron van trial_warmte.toegang_tot).
    const { error: uErr } = await supabaseAdmin
      .from('lms_gebruikers')
      .update({ toegang_tot: totIso(finalYmd) })
      .eq('id', lmsUserId);
    if (uErr) return res.status(500).json({ error: 'lms_gebruikers update: ' + uErr.message });

    // Secundaire write (best-effort, consistent met per-product grants):
    // update alle bijbehorende lms_toegang-rijen naar dezelfde einddatum.
    // Fail-soft: hoofdupdate is al binnen, dit is voor consistentie in het
    // per-product-overzicht.
    let grantsUpdated = 0;
    try {
      const { data: grants } = await supabaseAdmin
        .from('lms_toegang')
        .select('product_id, toegang_van')
        .eq('gebruiker_id', lmsUserId);
      for (const g of (grants || [])) {
        try {
          await zetGrant({
            gebruikerId: lmsUserId,
            productId:   g.product_id,
            van:         String(g.toegang_van || todayYmd).slice(0, 10),
            tot:         finalYmd,
          });
          grantsUpdated++;
        } catch (e) {
          console.warn('[extend-access] grant-sync soft-fail:', g.product_id, e?.message || e);
        }
      }
    } catch (e) {
      console.warn('[extend-access] grant-fetch soft-fail:', e?.message || e);
    }
    const einddatumNl = fmtNlDate(finalYmd);
    const voornaam = String(lead.voornaam || '').trim() || (lead.email || 'daar');

    // Meldingen fail-soft (email + WA parallel).
    const [mailRes, waRes] = await Promise.all([
      sendEmailFailSoft({ toEmail: lead.email, voornaam, einddatumNl }),
      sendWaFailSoft({ toPhone: lead.telefoon_e164, voornaam, einddatumNl }),
    ]);

    return res.status(200).json({
      ok:                true,
      lead_id,
      lms_gebruiker_id:  lmsUserId,
      grants_updated:    grantsUpdated,
      new_toegang_tot:   finalYmd,
      einddatum_nl:      einddatumNl,
      email_sent:        mailRes.ok,
      email_error:       mailRes.ok ? null : mailRes.error,
      wa_sent:           waRes.ok,
      wa_error:          waRes.ok ? null : waRes.error,
      wa_template:       WA_TEMPLATE,
    });
  } catch (e) {
    console.error('[extend-access] fatal:', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
