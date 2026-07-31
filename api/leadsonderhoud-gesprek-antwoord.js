// api/leadsonderhoud-gesprek-antwoord.js
// POST { lead_id, body } -> stuur een vrij-tekst WhatsApp-antwoord aan de lead.
//
// Gate: leads.view. De lead moet in een traject zitten. Vrije tekst mag alleen
// binnen het 24-uurs venster; daarbuiten hoort een goedgekeurde template (die knop
// wacht op Meta). Mail-antwoorden lopen niet via dit endpoint — die stuur je vanuit
// de e-mailmodule vanaf welkom@.
//
// Response: 200 { ok:true, wamid }
//           409 { error } als er geen WhatsApp-lijn/gesprek is
//           422 { error:'24u-venster verlopen' } buiten venster

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn, trajectSlugs, normNummer, binnenVenster } from './_lib/leadsonderhoud-gesprekken.js';
import { sendText, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 4096;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const body = req.body || {};
  const leadId = String(body.lead_id || '');
  const tekst = String(body.body || '').trim();
  if (!UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
  if (!tekst) return res.status(400).json({ error: 'Bericht is leeg' });
  if (tekst.length > MAX_BODY) return res.status(400).json({ error: 'Bericht te lang' });

  try {
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads').select('id, telefoon_e164, soort').eq('id', leadId).maybeSingle();
    if (leadErr) throw leadErr;
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });

    const slugs = await trajectSlugs();
    if (!slugs.has(lead.soort)) return res.status(403).json({ error: 'Deze lead zit niet in een traject' });

    const lijn = await haalLijn();
    if (!lijn.phoneNumberId) return res.status(409).json({ error: 'Geen WhatsApp-lijn ingesteld' });
    if (!lead.telefoon_e164) return res.status(409).json({ error: 'Deze lead heeft geen telefoonnummer' });

    // Het gesprek van deze lead op de lijn.
    const { data: convs } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, last_inbound_at')
      .eq('phone_number_id', lijn.phoneNumberId)
      .limit(500);
    const doel = normNummer(lead.telefoon_e164);
    const conv = (convs || []).find((c) => normNummer(c.phone_number) === doel) || null;
    if (!conv) return res.status(409).json({ error: 'Nog geen WhatsApp-gesprek met deze lead' });

    if (!binnenVenster(conv.last_inbound_at)) {
      return res.status(422).json({
        error: '24u-venster verlopen',
        message: 'Buiten het 24-uurs venster kun je geen vrije tekst sturen. Gebruik een goedgekeurde template (komt zodra Meta ze goedkeurt).',
      });
    }

    let metaResult;
    try {
      metaResult = await sendText({ to: conv.phone_number, body: tekst, phoneNumberId: conv.phone_number_id || lijn.phoneNumberId });
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({ error: 'Meta WhatsApp niet geconfigureerd', missing: metaErr.missing });
      }
      const code = Number(metaErr && metaErr.metaCode);
      if (code === 131047 || code === 131051 || code === 131026) {
        return res.status(422).json({ error: '24u-venster verlopen', source: 'meta',
          message: 'Meta meldt dat het 24-uurs venster verlopen is. Gebruik een goedgekeurde template.' });
      }
      console.error('[leadsonderhoud-gesprek-antwoord] Meta-fout:', metaErr.message);
      return res.status(502).json({ error: 'Meta API fout', meta_error: metaErr.message });
    }

    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nu = new Date().toISOString();

    const { error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert({
        conversation_id: conv.id,
        direction: 'out',
        meta_wamid: wamid,
        body: tekst,
        status: 'queued',
        sent_at: nu,
        sent_by_user_id: user.id,
      });
    if (insErr) throw new Error('bericht opslaan: ' + insErr.message);

    const { error: updErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: nu, last_message_preview: tekst.slice(0, 120) })
      .eq('id', conv.id);
    if (updErr) console.error('[leadsonderhoud-gesprek-antwoord] conv-update faalde:', updErr.message);

    return res.status(200).json({ ok: true, wamid });
  } catch (e) {
    console.error('leadsonderhoud-gesprek-antwoord mislukt:', e.message);
    return res.status(500).json({ error: 'Versturen mislukt' });
  }
}
