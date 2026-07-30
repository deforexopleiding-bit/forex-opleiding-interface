// api/leadsonderhoud-gesprek-berichten.js
// GET ?conversation_id=<uuid>[&mark_as_read=true]
//   -> de berichten van één gesprek, oudste eerst.
//
// Alleen lezen. Gate: leads.view. Extra check: het gesprek moet op de ingestelde
// lijn staan én bij een lead-in-een-traject horen — anders zou een leads.view-
// gebruiker via een geraden conversation_id toch een onboarding-gesprek kunnen
// openen. Bij mark_as_read wordt de ongelezen-teller op 0 gezet (net als de
// gedeelde inbox doet bij openen).
//
// Response: { conversation:{ id, phone_number, display_name, last_message_at,
//             last_inbound_at, unread_count, can_send_text }, items:[…] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn, leadNummers, normNummer, binnenVenster } from './_lib/leadsonderhoud-gesprekken.js';

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

  const convId = String(req.query.conversation_id || '');
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id ontbreekt of ongeldig' });
  const markRead = String(req.query.mark_as_read || '') === 'true';

  try {
    const lijn = await haalLijn();
    if (!lijn.phoneNumberId) return res.status(409).json({ error: 'Geen WhatsApp-lijn ingesteld' });

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, display_name, last_message_at, last_inbound_at, unread_count')
      .eq('id', convId).maybeSingle();
    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Gesprek niet gevonden' });

    // Hoort dit gesprek wel bij leadsonderhoud? (juiste lijn + lead-met-traject)
    const toegestaan = await leadNummers();
    if (conv.phone_number_id !== lijn.phoneNumberId || !toegestaan.has(normNummer(conv.phone_number))) {
      return res.status(403).json({ error: 'Dit gesprek hoort niet bij leadsonderhoud' });
    }

    const { data: msgs, error: msgErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .select('id, direction, body, media_url, media_type, template_name, status, sent_at, delivered_at, read_at, failed_reason, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (msgErr) throw msgErr;

    if (markRead && (conv.unread_count || 0) > 0) {
      const { error: updErr } = await supabaseAdmin
        .from('whatsapp_conversations').update({ unread_count: 0 }).eq('id', convId);
      if (updErr) console.error('[leadsonderhoud-gesprek-berichten] mark_as_read faalde:', updErr.message);
      else conv.unread_count = 0;
    }

    return res.status(200).json({
      conversation: {
        id: conv.id,
        phone_number: conv.phone_number,
        display_name: conv.display_name,
        last_message_at: conv.last_message_at,
        last_inbound_at: conv.last_inbound_at,
        unread_count: conv.unread_count || 0,
        can_send_text: binnenVenster(conv.last_inbound_at),
      },
      items: msgs || [],
    });
  } catch (e) {
    console.error('leadsonderhoud-gesprek-berichten mislukt:', e.message);
    return res.status(500).json({ error: 'Berichten laden mislukt' });
  }
}
