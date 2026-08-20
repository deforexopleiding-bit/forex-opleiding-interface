// api/leadsonderhoud-open-count.js
// GET → aantal open gesprekken in het Leadsonderhoud-postvak.
// Definitie 'open': lead-in-traject met ≥1 unread bericht op de motor-lijn
//   (WhatsApp: whatsapp_conversations.unread_count > 0) OF ≥1 unread inbound
//   in het motor-mailbox (email_messages.is_read = false, mailbox = postvak,
//   from_address matcht een lead-e-mail).
// Deduplicatie per lead-id — dezelfde lead met unread WA én mail telt 1x.
//
// Response:
//   { open_count: N, wa_unread_leads: N, mail_unread_leads: N }
//
// Permission: leads.view.
// Read-only. Geen writes.
//
// Waarom eigen endpoint (en niet leadsonderhoud-gesprekken?): dat endpoint
// laadt >3000 mails + email_replies + berichten_log per call om items[] te
// bouwen. Dashboard heeft alleen een count nodig — deze endpoint doet dat
// zonder de zware payload op te bouwen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn, leadsInTraject, normNummer, postvakNaam, adresUit } from './_lib/leadsonderhoud-gesprekken.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    const lijn = await haalLijn();
    const leads = await leadsInTraject();
    const postvak = postvakNaam();

    // Index de leads op telefoon en e-mail.
    const leadOpNummer = new Map();
    const leadIdByEmail = new Map();
    const emailSet = new Set();
    for (const l of leads) {
      if (l.telefoon_e164) leadOpNummer.set(normNummer(l.telefoon_e164), l);
      if (l.email) {
        const em = l.email.toLowerCase();
        leadIdByEmail.set(em, l.id);
        emailSet.add(em);
      }
    }

    const unreadLeadIds = new Set();
    let waUnreadLeads = 0;
    let mailUnreadLeads = 0;

    // 1) WhatsApp unread op de lijn.
    if (lijn.phoneNumberId && leadOpNummer.size) {
      const { data: convs, error: cErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('phone_number, unread_count')
        .eq('phone_number_id', lijn.phoneNumberId)
        .gt('unread_count', 0)
        .limit(2000);
      if (cErr) throw new Error('wa_convs: ' + cErr.message);
      const seenWa = new Set();
      for (const c of convs || []) {
        if (!c.phone_number) continue;
        const lead = leadOpNummer.get(normNummer(c.phone_number));
        if (!lead) continue;
        if (!seenWa.has(lead.id)) { seenWa.add(lead.id); waUnreadLeads++; }
        unreadLeadIds.add(lead.id);
      }
    }

    // 2) Mail unread in motor-postvak (from_address = lead-email).
    if (emailSet.size && postvak) {
      const emails = Array.from(emailSet);
      // In-filter met alle lead-emails; alleen inbound (mailbox=postvak) en unread.
      const { data: mails, error: mErr } = await supabaseAdmin
        .from('email_messages')
        .select('from_address')
        .eq('mailbox', postvak)
        .eq('is_read', false)
        .in('from_address', emails)
        .limit(5000);
      if (mErr) throw new Error('mail_unread: ' + mErr.message);
      const seenMail = new Set();
      for (const m of mails || []) {
        const adr = adresUit(m.from_address);
        const leadId = leadIdByEmail.get(adr);
        if (!leadId) continue;
        if (!seenMail.has(leadId)) { seenMail.add(leadId); mailUnreadLeads++; }
        unreadLeadIds.add(leadId);
      }
    }

    return res.status(200).json({
      open_count:        unreadLeadIds.size,
      wa_unread_leads:   waUnreadLeads,
      mail_unread_leads: mailUnreadLeads,
    });
  } catch (e) {
    console.error('[leadsonderhoud-open-count]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
