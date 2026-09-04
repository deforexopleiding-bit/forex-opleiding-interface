// api/admin-afspraak-testsend.js
//
// Afgeschermde admin "test-send": stuurt de afspraak-berichten (mail + WhatsApp)
// voor één BESTAANDE afspraak uitsluitend naar een opgegeven override-telefoon
// + override-e-mail — nooit naar de lead. Voor Jeffrey om de berichten aan
// zichzelf te tonen, los van de cron.
//
// Gebruikt EXACT dezelfde builders als cron-afspraak-reminders:
//   - MOMENTEN[].mail(appt, ctx)  → subject/text/html via de branded mailshell
//   - MOMENTEN[].waTemplate + waVars(appt, ctx) → sendTemplate op de welkom-lijn
// De afspraak-data (naam, tijd, zoom-link, self-service-token) komt uit de echte
// rij voor realistische output; alleen telefoon/e-mail worden overschreven.
//
// Raakt GEEN guard-kolommen, wijzigt de afspraak niet, negeert
// AFSPRAAK_REMINDERS_LIVE, en logt niet naar whatsapp_messages (test).
// Niet-approved WA-template → mail gaat wel, WA geeft "nog niet approved" terug.
//
// POST { appointment_id, override_phone, override_email, moment? }
//   moment: 'all' (default) of één van bevestiging|r24|r2|r30|zoom5
// RBAC: admin.meta_templates.manage (zelfde niveau als het WA-templatebeheer).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { MOMENTEN, bouwContext, resolveWelkomPhoneId } from './_lib/afspraak-berichten.js';
import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';

const MAIL_FROM = 'onboarding@deforexopleiding.nl';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[1-9]\d{7,14}$/;
const UUID_RE  = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // RBAC — zelfde niveau als admin-meta-templates-*.
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await requirePermission(req, 'admin.meta_templates.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage)' });
  }

  const body = req.body || {};
  const appointmentId = (body.appointment_id || '').toString().trim();
  let overridePhone   = (body.override_phone || '').toString().trim();
  const overrideEmail = (body.override_email || '').toString().trim();
  const momentKeuze   = (body.moment || 'all').toString().trim();

  // Validatie — beide overrides VERPLICHT (geen fallback naar lead-gegevens).
  if (!UUID_RE.test(appointmentId)) return res.status(400).json({ error: 'appointment_id ongeldig (uuid vereist)' });
  if (!EMAIL_RE.test(overrideEmail)) return res.status(400).json({ error: 'override_email ongeldig/ontbreekt' });
  if (!PHONE_RE.test(overridePhone)) return res.status(400).json({ error: 'override_phone ongeldig/ontbreekt (E.164, bv. +316…)' });
  if (!overridePhone.startsWith('+')) overridePhone = '+' + overridePhone.replace(/^0+/, '');

  const gekozenMomenten = momentKeuze === 'all'
    ? MOMENTEN
    : MOMENTEN.filter((m) => m.key === momentKeuze);
  if (gekozenMomenten.length === 0) {
    return res.status(400).json({ error: `moment ongeldig; kies 'all' of één van: ${MOMENTEN.map((m) => m.key).join(', ')}` });
  }

  // Echte afspraak laden (voor realistische data). Alleen lezen.
  const { data: appt, error: apptErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, scheduled_at, duration_minutes, zoom_join_url, afspraak_token')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptErr) return res.status(500).json({ error: 'afspraak-lookup: ' + apptErr.message });
  if (!appt)   return res.status(404).json({ error: 'Afspraak niet gevonden' });

  // Test-afspraak: echte data + overschreven contactgegevens.
  const testAppt = { ...appt, lead_phone: overridePhone, lead_email: overrideEmail };
  const ctx = bouwContext(testAppt);

  // Welkom-lijn + approved-status van de WA-templates (registry-check zodat een
  // niet-ingediende/niet-goedgekeurde template netjes wordt overgeslagen).
  const welkomPhoneId = await resolveWelkomPhoneId();
  const namen = gekozenMomenten.map((m) => m.waTemplate);
  const { data: trows } = await supabaseAdmin
    .from('whatsapp_meta_templates')
    .select('name, status')
    .in('name', namen);
  const approved = new Set((trows || []).filter((r) => String(r.status).toUpperCase() === 'APPROVED').map((r) => r.name));

  const resultaten = [];
  for (const moment of gekozenMomenten) {
    const uit = { moment: moment.key, template: moment.waTemplate, mail: null, wa: null };

    // ── Mail (altijd) → override_email ──
    try {
      const { subject, text, html } = moment.mail(testAppt, ctx);
      const r = await sendEmailViaSmtp({ fromMailbox: MAIL_FROM, to: overrideEmail, subject, text, html });
      uit.mail = r?.ok ? { ok: true, messageId: r.messageId || null } : { ok: false, error: r?.reason || 'onbekend', code: r?.code };
    } catch (e) {
      uit.mail = { ok: false, error: e?.message || String(e) };
    }

    // ── WhatsApp → override_phone (alleen als template approved + lijn ok) ──
    if (!welkomPhoneId) {
      uit.wa = { ok: false, skipped: 'welkom-phone-ontbreekt' };
    } else if (!approved.has(moment.waTemplate)) {
      uit.wa = { ok: false, skipped: 'nog-niet-approved' };
    } else {
      const variables = moment.waVars(testAppt, ctx).map((v) => String(v ?? ''));
      try {
        const { wamid } = await sendTemplate({
          to: overridePhone,
          templateName: moment.waTemplate,
          languageCode: 'nl',
          variables,
          phoneNumberId: welkomPhoneId,
        });
        uit.wa = { ok: true, wamid };
      } catch (e) {
        if (e instanceof MetaNotConfiguredError) uit.wa = { ok: false, skipped: 'meta-niet-geconfigureerd' };
        else uit.wa = { ok: false, error: e?.message || String(e), http_status: e?.httpStatus ?? null };
      }
    }

    resultaten.push(uit);
  }

  return res.status(200).json({
    ok: true,
    afspraak: { naam: appt.lead_name, scheduled_at: appt.scheduled_at },
    verstuurd_naar: { telefoon: overridePhone, email: overrideEmail },
    resultaten,
  });
}
