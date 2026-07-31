// api/leadsonderhoud-gesprek-berichten.js
// GET ?lead_id=<uuid>[&mark_as_read=true]
//   -> de samengevoegde draad van één lead: WhatsApp-berichten én inkomende mail,
//      op tijd gesorteerd, met per bericht het kanaal.
//
// Alleen lezen. Gate: leads.view. De lead moet in een traject zitten (anders 403).
// Bij mark_as_read wordt alleen de WhatsApp-ongelezenteller op 0 gezet; de
// gelezen-status van de mail laten we met rust (dat is de gedeelde e-mailmodule).
//
// Item-vorm (voor de frontend): { id, channel:'whatsapp'|'mail',
//   direction:'in'|'out', body, subject?, ts, is_read? }
//
// Response: { conversation:{ lead_id, naam, phone_number, email, can_send_text,
//             has_wa }, items:[…] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  haalLijn, trajectSlugs, normNummer, binnenVenster, postvakNaam, adresUit,
} from './_lib/leadsonderhoud-gesprekken.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const leadId = String(req.query.lead_id || '');
  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
  const markRead = String(req.query.mark_as_read || '') === 'true';

  try {
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads')
      .select('id, voornaam, achternaam, email, telefoon_e164, soort')
      .eq('id', leadId).maybeSingle();
    if (leadErr) throw leadErr;
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });

    const slugs = await trajectSlugs();
    if (!slugs.has(lead.soort)) {
      return res.status(403).json({ error: 'Deze lead zit niet in een traject' });
    }

    const lijn = await haalLijn();
    const items = [];

    // ── WhatsApp ──────────────────────────────────────────────────────────
    let conv = null;
    if (lijn.phoneNumberId && lead.telefoon_e164) {
      const { data: convs } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, phone_number, last_inbound_at, unread_count')
        .eq('phone_number_id', lijn.phoneNumberId)
        .limit(500);
      const doel = normNummer(lead.telefoon_e164);
      conv = (convs || []).find((c) => normNummer(c.phone_number) === doel) || null;
    }
    if (conv) {
      const { data: waMsgs } = await supabaseAdmin
        .from('whatsapp_messages')
        .select('id, direction, body, media_type, template_name, created_at')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: true })
        .limit(200);
      for (const m of waMsgs || []) {
        const tekst = m.body || (m.template_name ? '[sjabloon] ' + m.template_name : '')
          || (m.media_type ? '[' + m.media_type + ']' : '') || '';
        items.push({
          id: 'wa:' + m.id,
          channel: 'whatsapp',
          direction: m.direction === 'out' ? 'out' : 'in',
          body: tekst,
          ts: m.created_at,
        });
      }
      if (markRead && (conv.unread_count || 0) > 0) {
        const { error: updErr } = await supabaseAdmin
          .from('whatsapp_conversations').update({ unread_count: 0 }).eq('id', conv.id);
        if (updErr) console.error('[leadsonderhoud-gesprek-berichten] mark_as_read faalde:', updErr.message);
      }
    }

    // ── Mail (inkomende antwoorden in het motor-postvak) ──────────────────
    if (lead.email) {
      const email = lead.email.toLowerCase();
      const { data: mails } = await supabaseAdmin
        .from('email_messages')
        .select('id, from_address, subject, snippet, body_text, date_received, is_read')
        .eq('mailbox', postvakNaam())
        .ilike('from_address', '%' + email + '%')
        .order('date_received', { ascending: true })
        .limit(200);
      for (const m of mails || []) {
        if (adresUit(m.from_address) !== email) continue; // precieze match
        items.push({
          id: 'mail:' + m.id,
          channel: 'mail',
          direction: 'in', // alleen inkomende antwoorden staan in dit postvak
          body: m.body_text || m.snippet || '',
          subject: m.subject || null,
          ts: m.date_received,
          is_read: !!m.is_read,
        });
      }
    }

    // Samenvoegen op tijd (oudste eerst).
    items.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    return res.status(200).json({
      conversation: {
        lead_id: lead.id,
        naam: [lead.voornaam, lead.achternaam].filter(Boolean).join(' ') || lead.email || 'Onbekend',
        phone_number: lead.telefoon_e164 || (conv ? conv.phone_number : null),
        email: lead.email || null,
        can_send_text: conv ? binnenVenster(conv.last_inbound_at) : false,
        has_wa: !!conv,
      },
      items,
    });
  } catch (e) {
    console.error('leadsonderhoud-gesprek-berichten mislukt:', e.message);
    return res.status(500).json({ error: 'Berichten laden mislukt' });
  }
}
