// api/leadsonderhoud-gesprekken.js
// GET -> het gecombineerde postvak van leadsonderhoud: één regel per lead-in-een-
// traject die contact heeft gehad, met WhatsApp én mail samengevoegd.
//
// Waarom lead-gesleuteld (en niet per WhatsApp-gesprek): veel leads hebben (nog)
// geen telefoonnummer, en de afwijzings-/verlopen-mails nodigen uit tot antwoorden
// per mail. Zou het postvak op WhatsApp-gesprekken sleutelen, dan zouden die mail-
// only leads onzichtbaar zijn. Dubbele lead-rijen met hetzelfde e-mailadres worden
// tot één regel samengevoegd.
//
// Kanalen:
//   - WhatsApp: gesprek op de ingestelde lijn, gematcht op telefoonnummer.
//   - Mail:     inkomende mail in het motor-postvak (welkom@ -> mailbox 'welkom'),
//               gematcht op from_address == lead.email.
//
// Alleen lezen. Gate: leads.view (filter zit server-side).
//
// Response: { configured, wa_configured, module, label, postvak,
//   items:[{ lead_id, naam, phone_number, email, last_activity_at, last_preview,
//            unread, can_send_text, has_wa, has_mail }] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  haalLijn, leadsInTraject, normNummer, binnenVenster, postvakNaam, adresUit, mailAfzender,
} from './_lib/leadsonderhoud-gesprekken.js';

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

    // Index de leads op telefoonnummer (voor WhatsApp) en verzamel de e-mailadressen.
    const leadOpNummer = new Map();
    const emailSet = new Set();
    for (const l of leads) {
      if (l.telefoon_e164) leadOpNummer.set(normNummer(l.telefoon_e164), l);
      if (l.email) emailSet.add(l.email.toLowerCase());
    }

    // WhatsApp-gesprekken op de lijn, gekoppeld aan een lead via het nummer.
    const waOpLeadId = new Map();
    if (lijn.phoneNumberId && leadOpNummer.size) {
      const { data: convs } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, phone_number, last_message_at, last_message_preview, unread_count, last_inbound_at')
        .eq('phone_number_id', lijn.phoneNumberId)
        .limit(500);
      for (const c of convs || []) {
        if (!c.phone_number || c.phone_number.startsWith('+99999')) continue;
        const lead = leadOpNummer.get(normNummer(c.phone_number));
        if (lead) waOpLeadId.set(lead.id, c);
      }
    }

    // Inkomende mail in het motor-postvak, samengevat per afzenderadres.
    const mailOpEmail = new Map();
    if (emailSet.size) {
      const { data: mails } = await supabaseAdmin
        .from('email_messages')
        .select('from_address, date_received, is_read, snippet, subject')
        .eq('mailbox', postvak)
        .order('date_received', { ascending: false })
        .limit(3000);
      for (const m of mails || []) {
        const adres = adresUit(m.from_address);
        if (!emailSet.has(adres)) continue;
        let agg = mailOpEmail.get(adres);
        if (!agg) { agg = { count: 0, unread: 0, last_date: null, last_tekst: '' }; mailOpEmail.set(adres, agg); }
        agg.count++;
        if (!m.is_read) agg.unread++;
        if (!agg.last_date || new Date(m.date_received) > new Date(agg.last_date)) {
          agg.last_date = m.date_received;
          agg.last_tekst = m.snippet || m.subject || '';
        }
      }
    }

    // Groepeer de leads op identiteit (e-mail als die er is, anders nummer, anders
    // de lead-id) zodat dubbele lead-rijen tot één postvakregel samensmelten.
    const groepen = new Map();
    for (const l of leads) {
      const key = l.email ? 'mail:' + l.email.toLowerCase()
        : (l.telefoon_e164 ? 'tel:' + normNummer(l.telefoon_e164) : 'id:' + l.id);
      if (!groepen.has(key)) groepen.set(key, []);
      groepen.get(key).push(l);
    }

    const items = [];
    for (const rijen of groepen.values()) {
      // WhatsApp uit de eerste rij die een gesprek heeft; mail via het e-mailadres.
      let wa = null, waLead = null;
      for (const l of rijen) { const c = waOpLeadId.get(l.id); if (c) { wa = c; waLead = l; break; } }
      const email = (rijen.find((l) => l.email)?.email || '').toLowerCase() || null;
      const mail = email ? mailOpEmail.get(email) : null;
      if (!wa && !mail) continue;

      // Representatieve lead: liefst degene met het WhatsApp-nummer (die heeft in de
      // praktijk ook het e-mailadres), anders een rij met een naam.
      const rep = waLead || rijen.find((l) => l.voornaam || l.achternaam) || rijen[0];
      const waTijd = wa?.last_message_at ? new Date(wa.last_message_at).getTime() : 0;
      const mailTijd = mail?.last_date ? new Date(mail.last_date).getTime() : 0;
      const laatste = Math.max(waTijd, mailTijd);
      const preview = (mailTijd >= waTijd ? mail?.last_tekst : wa?.last_message_preview) || '';

      items.push({
        lead_id: rep.id,
        naam: [rep.voornaam, rep.achternaam].filter(Boolean).join(' ') || email || (wa ? wa.phone_number : '') || 'Onbekend',
        phone_number: rep.telefoon_e164 || (wa ? wa.phone_number : null),
        email: email,
        last_activity_at: laatste ? new Date(laatste).toISOString() : null,
        last_preview: preview,
        unread: (wa?.unread_count || 0) + (mail?.unread || 0),
        can_send_text: wa ? binnenVenster(wa.last_inbound_at) : false,
        has_wa: !!wa,
        has_mail: !!mail,
        _t: laatste,
      });
    }

    items.sort((a, b) => b._t - a._t);
    const schoon = items.map(({ _t, ...rest }) => rest);

    return res.status(200).json({
      configured: true,
      wa_configured: !!lijn.phoneNumberId,
      module: lijn.module,
      label: lijn.label,
      postvak,
      afzender: mailAfzender(),
      items: schoon,
    });
  } catch (e) {
    console.error('leadsonderhoud-gesprekken mislukt:', e.message);
    return res.status(500).json({ error: 'Gesprekken laden mislukt' });
  }
}
