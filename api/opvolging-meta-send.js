// api/opvolging-meta-send.js
//
// POST { taak_id?, nummer, tekst } → vrij antwoord op de Meta-lijn, BINNEN het
// 24u-venster.
//
// Na 'Agenda doorsturen' via de Meta-template kan de lead antwoorden. Zolang
// zijn laatste bericht minder dan 24 uur oud is, mag Dave vrij terugschrijven
// — op dezelfde lijn als waarop het gesprek loopt. Buiten het venster weigert
// dit endpoint (409 VENSTER_DICHT): dan kan alleen de herinnering-template.
//
// Hergebruikt sendText (_lib/meta-whatsapp.js) en logOutboundWa, zodat het
// bericht ook in de bestaande gesprekkenschermen staat. Eigen endpoint en
// niet /api/inbox-send, omdat dat laatste op finance/events/onboarding-rechten
// poort en Dave (sales) die niet heeft; de verzendlogica zelf is gedeeld.
//
// Recht: opvolging.whatsapp.sturen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendText, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { logOutboundWa } from './_lib/wa-outbound-log.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';
import { leesMetaGesprek, META_SLEUTEL } from './_lib/opvolging-meta.js';

const MAX_TEKST = 4000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'opvolging.whatsapp.sturen'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.whatsapp.sturen)' });
  }

  const b = req.body || {};
  const nummer = normaliseerNummer(b.nummer);
  const tekst = typeof b.tekst === 'string' ? b.tekst.trim() : '';
  if (!nummer) return res.status(400).json({ error: 'nummer ontbreekt' });
  if (!tekst) return res.status(400).json({ error: 'tekst ontbreekt' });
  if (tekst.length > MAX_TEKST) return res.status(400).json({ error: `tekst is langer dan ${MAX_TEKST} tekens` });

  try {
    const g = await leesMetaGesprek(supabaseAdmin, nummer);
    if (!g.stand || !g.stand.venster_open || !g.stand.phone_number_id) {
      return res.status(409).json({
        code: 'VENSTER_DICHT',
        error: 'Het 24u-venster op de Meta-lijn is dicht (geen antwoord van de lead in de laatste 24 uur). Stuur de herinnering-template.',
      });
    }
    let wamid;
    try {
      ({ wamid } = await sendText({ to: '+' + nummer, body: tekst, phoneNumberId: g.stand.phone_number_id }));
    } catch (e) {
      const nietGeconf = e instanceof MetaNotConfiguredError;
      console.error('[opvolging-meta-send]', e?.message || e);
      return res.status(nietGeconf ? 503 : 502).json({
        code: nietGeconf ? 'META_NIET_GECONFIGUREERD' : 'META_FOUT',
        error: 'Versturen via de Meta-lijn mislukte' + (e?.metaMessage ? ': ' + String(e.metaMessage).slice(0, 160) : '') + '.',
      });
    }

    await logOutboundWa(supabaseAdmin, {
      toPhone: '+' + nummer, phoneNumberId: g.stand.phone_number_id, body: tekst, wamid,
      source: 'opvolging-gesprek',
    });

    // Moeite van Dave op de kaart. Fail-soft: het bericht is de hoofdzaak.
    if (b.taak_id) {
      try {
        const { error } = await supabaseAdmin.from('opvolging_pogingen').insert({
          taak_id: b.taak_id, soort: 'whatsapp', richting: 'uit', automatisch: true,
          resultaat: 'WhatsApp verstuurd (Meta): ' + tekst.slice(0, 300),
          call_log_id: META_SLEUTEL + wamid,
        });
        if (error) throw new Error(error.message);
      } catch (e) {
        console.warn('[opvolging-meta-send] poging (soft):', e?.message || e);
      }
    }
    return res.status(200).json({ ok: true, wamid, kanaal: 'meta' });
  } catch (e) {
    console.error('[opvolging-meta-send]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
