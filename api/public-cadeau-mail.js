// api/public-cadeau-mail.js
//
// POST — mail bij een cadeaupagina van de website (/checklist, …), 2026-11-25.
// Server-to-server: x-internal-token == OPSTARTSESSIE_SECRET (zelfde geheim als
// public-opstartsessie-book; de website-route /api/cadeau-mail roept dit aan).
//
// Body: { cadeau: 'checklist', email, score }
// Antwoord:
//   200 { ok: true, verstuurd: true }               mail is weg
//   200 { ok: true, verstuurd: true, al: true }     er ging al een mail weg (niets opnieuw)
//   404 { ok: false, code: 'GEEN_LEAD' }            geen lead met dit adres voor dit cadeau
//   429 { ok: false, code: 'TE_VEEL_POGINGEN' }
//   502 { ok: false, code: 'MAIL_MISLUKT' }         versturen lukte niet (gelogd)
//
// Inhoud: api/_lib/cadeau-mail.js (vast per cadeau; voornaam uit de lead).
// Logboek bij de lead: berichten_log (soort 'cadeau-<cadeau>', kanaal 'mail',
// status 'verstuurd' | 'mislukt'), en bij succes ook email_replies (de draad in
// Leadsonderhoud), zoals de afspraakmails. Geen schemawijziging.

import { supabaseAdmin } from './supabase.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { MAIL_VAN, LOG_SOORT, bouwCadeauMail, magCadeauMailWeg, valideerCadeauMailVerzoek } from './_lib/cadeau-mail.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const verwacht = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ ok: false, error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if (req.headers['x-internal-token'] !== verwacht) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const v = valideerCadeauMailVerzoek(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.fout });
  const { cadeau, email, score } = v;

  // De lead: zelfde adres én dit cadeau als campagne (gezet door de poort op de website).
  const { data: leads, error: lErr } = await supabaseAdmin.from('leads')
    .select('id, voornaam, email, traject, campagne, aangemaakt')
    .ilike('email', email).eq('campagne', cadeau).is('verwijderd_op', null)
    .order('aangemaakt', { ascending: false }).limit(1);
  if (lErr) {
    console.error('[public-cadeau-mail] lead lezen mislukt', { cadeau, fout: lErr.message });
    return res.status(503).json({ ok: false, error: 'lead lezen mislukt' });
  }
  const lead = leads?.[0];
  if (!lead) return res.status(404).json({ ok: false, code: 'GEEN_LEAD' });

  const soort = LOG_SOORT(cadeau);
  const { data: log, error: gErr } = await supabaseAdmin.from('berichten_log')
    .select('status, verstuurd_op').eq('lead_id', lead.id).eq('soort', soort).limit(50);
  if (gErr) {
    console.error('[public-cadeau-mail] logboek lezen mislukt', { leadId: lead.id, fout: gErr.message });
    return res.status(503).json({ ok: false, error: 'logboek lezen mislukt' });
  }
  const besluit = magCadeauMailWeg(log || []);
  if (!besluit.mag && besluit.reden === 'al_verstuurd') return res.status(200).json({ ok: true, verstuurd: true, al: true });
  if (!besluit.mag) return res.status(429).json({ ok: false, code: 'TE_VEEL_POGINGEN' });

  const mail = bouwCadeauMail(cadeau, { voornaam: lead.voornaam, score });
  let r;
  try {
    r = await sendEmailViaSmtp({ fromMailbox: MAIL_VAN, to: lead.email, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (e) {
    r = { ok: false, reason: e?.message || String(e) };
  }
  const nu = new Date().toISOString();
  const { error: blErr } = await supabaseAdmin.from('berichten_log').insert({
    lead_id: lead.id, soort, kanaal: 'mail', naar: lead.email, traject: lead.traject || null,
    agent: 'cadeau', status: r?.ok ? 'verstuurd' : 'mislukt', fout: r?.ok ? null : String(r?.reason || r?.code || 'onbekend').slice(0, 500),
    verstuurd_op: nu, extern_id: r?.messageId || null,
  });
  if (blErr) console.error('[public-cadeau-mail] berichten_log mislukt', { leadId: lead.id, fout: blErr.message });

  if (!r?.ok) {
    console.error('[public-cadeau-mail] mail mislukt', { leadId: lead.id, cadeau, reden: r?.reason, code: r?.code });
    return res.status(502).json({ ok: false, code: 'MAIL_MISLUKT' });
  }
  // De draad in Leadsonderhoud (zoals de afspraakmails).
  const { error: erErr } = await supabaseAdmin.from('email_replies').insert({
    email_id: null, email_subject: mail.subject, final_reply: mail.text,
    from_address: MAIL_VAN, to_address: lead.email, sent_at: nu, sent_by_id: null,
  });
  if (erErr) console.warn('[public-cadeau-mail] email_replies (soft):', erErr.message);
  return res.status(200).json({ ok: true, verstuurd: true });
}
