// api/leadsonderhoud-gesprek-antwoord.js
// POST { conversation_id, body } -> stuur een vrij-tekst antwoord in een lopend
// gesprek, via de Meta Cloud API.
//
// Gate: leads.view. Extra check: het gesprek moet op de ingestelde lijn staan én
// bij een lead-in-een-traject horen (zelfde filter als de lijst). Vrije tekst mag
// alleen binnen het 24-uurs venster; daarbuiten hoort een goedgekeurde template —
// die knop komt zodra Meta de sjablonen goedkeurt.
//
// Response: 200 { ok:true, wamid }
//           422 { error:'24u-venster verlopen' } buiten venster
//           502 { error } bij Meta-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn, leadNummers, normNummer, binnenVenster } from './_lib/leadsonderhoud-gesprekken.js';
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
  const convId = String(body.conversation_id || '');
  const tekst = String(body.body || '').trim();
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id ontbreekt of ongeldig' });
  if (!tekst) return res.status(400).json({ error: 'Bericht is leeg' });
  if (tekst.length > MAX_BODY) return res.status(400).json({ error: 'Bericht te lang' });

  try {
    const lijn = await haalLijn();
    if (!lijn.phoneNumberId) return res.status(409).json({ error: 'Geen WhatsApp-lijn ingesteld' });

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, last_inbound_at')
      .eq('id', convId).maybeSingle();
    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Gesprek niet gevonden' });

    const toegestaan = await leadNummers();
    if (conv.phone_number_id !== lijn.phoneNumberId || !toegestaan.has(normNummer(conv.phone_number))) {
      return res.status(403).json({ error: 'Dit gesprek hoort niet bij leadsonderhoud' });
    }

    // Vrije tekst mag alleen binnen 24u sinds het laatste inkomende bericht.
    if (!binnenVenster(conv.last_inbound_at)) {
      return res.status(422).json({
        error: '24u-venster verlopen',
        message: 'Buiten het 24-uurs venster kun je geen vrije tekst sturen. Gebruik een goedgekeurde template (komt zodra Meta ze goedkeurt).',
      });
    }

    // Verstuur via de lijn waarop het gesprek binnenkwam.
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

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert({
        conversation_id: convId,
        direction: 'out',
        meta_wamid: wamid,
        body: tekst,
        status: 'queued',
        sent_at: nu,
        sent_by_user_id: user.id,
      })
      .select('id, meta_wamid, status, sent_at, created_at, direction, body')
      .single();
    if (insErr) throw new Error('bericht opslaan: ' + insErr.message);

    const { error: updErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: nu, last_message_preview: tekst.slice(0, 120) })
      .eq('id', convId);
    if (updErr) console.error('[leadsonderhoud-gesprek-antwoord] conv-update faalde:', updErr.message);

    return res.status(200).json({ ok: true, wamid, message: inserted });
  } catch (e) {
    console.error('leadsonderhoud-gesprek-antwoord mislukt:', e.message);
    return res.status(500).json({ error: 'Versturen mislukt' });
  }
}
