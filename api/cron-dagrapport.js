// api/cron-dagrapport.js
//
// Dagelijks dagrapport om 21:30 NL (Europe/Amsterdam): bouwt de cijfers (alle 7
// blokken, read-only), rendert de PDF en bezorgt 'm via WhatsApp (goedgekeurd
// 360dialog-template met URL-knop) en/of e-mail (PDF-bijlage). Schakelaars staan
// in app_settings.
//
// DST-proof: Vercel-crons draaien in UTC, dus dit endpoint staat ingepland rond
// beide kandidaat-tijden (19:30 en 20:30 UTC) en verstuurt alleen als het in NL
// 21:3x is, met dag-dedupe. Zo valt er precies één verzending, zomer en winter.
//
//   GET/POST  /api/cron-dagrapport            → geplande run (NL-tijd-gate + dedupe)
//   ...?force=1                               → nu versturen, gate overslaan (test)
//   ...?preview=1                             → PDF teruggeven, NIET versturen
//   ...?preview=1&format=json                 → de ruwe cijfers teruggeven
//
// Auth: CRON_SECRET via Authorization: Bearer <secret> (ook voor preview).

import { supabaseAdmin, checkCronAuth, verifyAdmin } from './supabase.js';
import { verzamelDagrapport } from './_lib/dagrapport-data.js';
import { buildDagrapportPdf } from './_lib/dagrapport-pdf.js';
import { leesConfig, uploadEnToken, verzendWhatsapp, verzendEmail } from './_lib/dagrapport-verzend.js';

const NOTIF_TYPE = 'dagrapport_2130';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const q = req.query || {};
  const preview = truthy(q.preview);
  const force = truthy(q.force);

  // Auth: de cron gebruikt CRON_SECRET. Een ingelogde admin mag de PREVIEW ook
  // starten (zodat het zonder secret in de browser kan); de echte verzend-run
  // blijft bewust cron-only.
  const cronAuth = checkCronAuth(req);
  if (preview) {
    const magPreview = cronAuth.ok || !!(await verifyAdmin(req));
    if (!magPreview) return res.status(403).json({ error: 'Admin of CRON_SECRET vereist voor preview' });
  } else if (!cronAuth.ok) {
    return res.status(cronAuth.status).json(cronAuth.body);
  }

  try {
    // ── Preview: bouwen + PDF, niets versturen ──────────────────────────────
    if (preview) {
      const data = await verzamelDagrapport({ supabaseAdmin });
      if (String(q.format || '').toLowerCase() === 'json') {
        return res.status(200).json(data);
      }
      const pdf = await buildDagrapportPdf(data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="dagrapport-${data.datumIso}.pdf"`);
      return res.status(200).end(pdf);
    }

    // ── Geplande run: NL-tijd-gate (tenzij force) ───────────────────────────
    if (!force) {
      const { hour, minute } = nlHourMinute(new Date());
      if (!(hour === 21 && minute >= 30 && minute <= 44)) {
        return res.status(200).json({ sent: 0, reason: `buiten venster (NL ${hour}:${String(minute).padStart(2, '0')}, verwacht 21:30)` });
      }
    }

    // ── Dag-dedupe ──────────────────────────────────────────────────────────
    const data = await verzamelDagrapport({ supabaseAdmin });
    const refDate = data.datumIso;
    const { data: al } = await supabaseAdmin
      .from('follow_up_admin_report_log')
      .select('recipient')
      .eq('notification_type', NOTIF_TYPE)
      .eq('reference_date', refDate);
    if ((al || []).length > 0 && !force) {
      return res.status(200).json({ sent: 0, reason: 'al verstuurd vandaag' });
    }

    const cfg = await leesConfig(supabaseAdmin);
    const pdf = await buildDagrapportPdf(data);

    // Upload + token (nodig voor de WhatsApp-knop).
    let token = null;
    try {
      ({ token } = await uploadEnToken(supabaseAdmin, pdf, data.datumIso));
    } catch (e) {
      console.error('[cron-dagrapport] upload/token mislukt:', e?.message || e);
    }

    // WhatsApp (fail-soft).
    let whatsapp = { ok: false };
    if (truthyCfg(cfg.dagrapport_whatsapp_enabled)) {
      if (!token) {
        whatsapp = { ok: false, error: 'geen token (upload mislukt)' };
      } else {
        try {
          const { wamid } = await verzendWhatsapp(cfg, { datumLabel: data.datumLabel, token });
          whatsapp = { ok: true, wamid };
        } catch (e) {
          whatsapp = { ok: false, error: e?.message || String(e) };
          console.error('[cron-dagrapport] WhatsApp mislukt:', whatsapp.error);
        }
      }
    } else {
      whatsapp = { ok: false, skipped: true, reason: 'uitgeschakeld' };
    }

    // E-mail (fail-soft, onafhankelijk).
    let email = { ok: false };
    if (truthyCfg(cfg.dagrapport_email_enabled)) {
      try {
        const r = await verzendEmail(supabaseAdmin, pdf, data);
        email = { ok: (r.sent || 0) > 0, ...r };
      } catch (e) {
        email = { ok: false, error: e?.message || String(e) };
        console.error('[cron-dagrapport] e-mail mislukt:', email.error);
      }
    } else {
      email = { ok: false, skipped: true, reason: 'uitgeschakeld' };
    }

    // Dedupe-log (alleen als minstens één kanaal lukte).
    if (whatsapp.ok || email.ok) {
      await supabaseAdmin.from('follow_up_admin_report_log').insert({
        notification_type: NOTIF_TYPE,
        reference_date: refDate,
        recipient: 'dagrapport',
        meta: { whatsapp, email: { sent: email.sent, total: email.total }, waarschuwingen: data.waarschuwingen },
      }).then(() => {}).catch((e) => console.error('[cron-dagrapport] dedup-log:', e.message));
    }

    return res.status(200).json({
      ok: whatsapp.ok || email.ok,
      datum: refDate,
      whatsapp,
      email: { ok: email.ok, sent: email.sent, total: email.total, skipped: email.skipped },
      waarschuwingen: data.waarschuwingen,
    });
  } catch (err) {
    console.error('[cron-dagrapport] exception:', err?.message || err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}

function truthy(v) {
  return v === '1' || v === 'true' || v === true || v === 'ja';
}
// app_settings-waarde kan een echte bool (jsonb) of een string zijn.
function truthyCfg(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'ja';
}
function nlHourMinute(d) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { hour: get('hour'), minute: get('minute') };
}
