// api/teamleader-send-quotation.js
// POST { deal_id, email_template_id? } → verstuurt de offerte via TL.
// Permission: sales.deal.create.
//
// Bron: TL quotations.send (bevestigd aanwezig in apiary). De exacte body-vorm
// kon niet live geverifieerd worden (TL nog niet verbonden) → minimale body
// { id } + optioneel template; pas zo nodig 1 plek aan na de eerste echte send.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.create)' });
  }

  const { deal_id, email_template_id } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: 'deal_id vereist' });

  try {
    const tok = await getActiveToken();
    if (!tok) return res.status(503).json({ error: 'Geen TL-token actief' });

    const { data: deal } = await supabaseAdmin.from('deals')
      .select('id, customer_id, tl_quotation_id, tl_quotation_status, tl_quotation_sent_at').eq('id', deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });
    if (!deal.tl_quotation_id) return res.status(409).json({ error: 'Deal heeft nog geen TL-offerte (eerst pushen)' });
    if (!['draft', 'sent'].includes(deal.tl_quotation_status)) {
      return res.status(409).json({ error: `Offerte-status '${deal.tl_quotation_status}' kan niet (her)verstuurd worden` });
    }

    // Ontvanger-email (verplicht voor quotations.send).
    const { data: customer } = await supabaseAdmin.from('customers')
      .select('email').eq('id', deal.customer_id).maybeSingle();
    const recipientEmail = customer?.email;
    if (!recipientEmail) return res.status(409).json({ error: 'Klant heeft geen e-mailadres — offerte kan niet verstuurd worden' });

    // quotations.send body volgens TL-spec:
    //   quotations: string[] van UUIDs
    //   recipients: { to: [{ email_address }] }
    //   subject / content / language: verplicht
    // TL kent GEEN mail_template_id voor quotations.send → subject/content inline.
    // TODO: subject/content configureerbaar maken via teamleader_settings, en
    //       eventueel onze eigen template-substitutie (TL heeft geen native id).
    const sendBody = {
      quotations: [deal.tl_quotation_id],
      recipients: { to: [{ email_address: recipientEmail }] },
      subject: 'Uw offerte van De Forex Opleiding',
      content: 'Beste,\n\nBekijk en onderteken uw offerte via de onderstaande link:\n\n#LINK\n\nMet vriendelijke groet,\nDe Forex Opleiding',
      language: 'nl',
    };
    const r = await tlFetch('/quotations.send', { method: 'POST', body: JSON.stringify(sendBody) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`TL quotations.send HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }

    await supabaseAdmin.from('deals').update({
      tl_quotation_status:        'sent',
      tl_quotation_email_sent_at: new Date().toISOString(),
      tl_quotation_sent_at:       deal.tl_quotation_sent_at || new Date().toISOString(),
    }).eq('id', deal_id);

    return res.status(200).json({ success: true, tl_quotation_status: 'sent' });
  } catch (e) {
    console.error('[tl-send-quotation]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
