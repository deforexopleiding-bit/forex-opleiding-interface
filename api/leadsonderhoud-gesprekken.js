// api/leadsonderhoud-gesprekken.js
// GET -> de WhatsApp-gesprekken die bij leadsonderhoud horen: op de ingestelde
// lijn (leadsonderhoud_wa_module) én alleen van nummers die bij een lead-in-een-
// traject horen. Onboarding-eigen gesprekken vallen dus weg.
//
// Alleen lezen. Gate: leads.view (net als de rest van de module). Het filter zit
// server-side, zodat een leads.view-gebruiker niet de hele onboarding-inbox ziet.
//
// Response: { configured, module, label, items:[{ id, phone_number, display_name,
//             last_message_at, last_message_preview, unread_count, can_send_text }] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn, leadNummers, normNummer, binnenVenster } from './_lib/leadsonderhoud-gesprekken.js';

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
    if (!lijn.phoneNumberId) {
      // De ingestelde module heeft (nog) geen actieve lijn in
      // whatsapp_module_config. De UI toont dan een uitleg-banner.
      return res.status(200).json({ configured: false, module: lijn.module, label: null, items: [] });
    }

    const toegestaan = await leadNummers();

    const { data: convs, error } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, display_name, last_message_at, last_message_preview, unread_count, last_inbound_at')
      .eq('phone_number_id', lijn.phoneNumberId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(300);
    if (error) throw error;

    const items = (convs || [])
      .filter((c) => c.phone_number
        && !c.phone_number.startsWith('+99999')       // Simone-dummy uitsluiten
        && toegestaan.has(normNummer(c.phone_number)))
      .map((c) => ({
        id: c.id,
        phone_number: c.phone_number,
        display_name: c.display_name,
        last_message_at: c.last_message_at,
        last_message_preview: c.last_message_preview,
        unread_count: c.unread_count || 0,
        can_send_text: binnenVenster(c.last_inbound_at),
      }));

    return res.status(200).json({ configured: true, module: lijn.module, label: lijn.label, items });
  } catch (e) {
    console.error('leadsonderhoud-gesprekken mislukt:', e.message);
    return res.status(500).json({ error: 'Gesprekken laden mislukt' });
  }
}
