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
import { fetchAndSubstituteTemplate } from './_lib/teamleader-mail-substitution.js';

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
      .select('id, customer_id, tl_quotation_id, tl_quotation_status, tl_quotation_sent_at, tl_department_id, quote_reference')
      .eq('id', deal_id).maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });
    if (!deal.tl_quotation_id) return res.status(409).json({ error: 'Deal heeft nog geen TL-offerte (eerst pushen)' });
    if (!['draft', 'sent'].includes(deal.tl_quotation_status)) {
      return res.status(409).json({ error: `Offerte-status '${deal.tl_quotation_status}' kan niet (her)verstuurd worden` });
    }

    // Ontvanger-email (verplicht voor quotations.send).
    const { data: customer } = await supabaseAdmin.from('customers')
      .select('email, first_name, last_name').eq('id', deal.customer_id).maybeSingle();
    const recipientEmail = customer?.email;
    if (!recipientEmail) return res.status(409).json({ error: 'Klant heeft geen e-mailadres — offerte kan niet verstuurd worden' });

    // Template-keuze: expliciete param, anders default uit settings.
    let templateId = email_template_id || null;
    if (!templateId) {
      const { data: setting } = await supabaseAdmin.from('teamleader_settings')
        .select('value').eq('key', 'default_email_template_id').maybeSingle();
      templateId = setting?.value || null;
    }

    // Verplichte velden.
    const base = {
      quotations: [deal.tl_quotation_id],
      recipients: { to: [{ email_address: recipientEmail }] },
      language: 'nl',
    };
    // Vaste inline-tekst (fallback). #LINK wordt door TL gerenderd.
    let subject = 'Uw offerte van De Forex Opleiding';
    let content = 'Beste,\n\nBekijk en onderteken uw offerte via de onderstaande link:\n\n#LINK\n\nMet vriendelijke groet,\nDe Forex Opleiding';

    // PAD 2B: TL kent geen mail_template_id voor quotations.send. We halen de
    // gekozen template-content zelf op en substitueren placeholders server-side.
    let usedTemplate = false;
    if (templateId) {
      try {
        // Context voor placeholder-substitutie.
        const { data: profile } = await supabaseAdmin.from('profiles')
          .select('full_name').eq('id', user.id).maybeSingle();
        let departmentName = 'De Forex Opleiding';
        if (deal.tl_department_id) {
          const { data: ent } = await supabaseAdmin.from('company_entities')
            .select('label').eq('tl_department_id', deal.tl_department_id).maybeSingle();
          if (ent?.label) departmentName = ent.label;
        }
        const ctx = {
          contact_name:    `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          my_name:         profile?.full_name || '',
          department_name: departmentName,
          deal_title:      deal.quote_reference || 'Offerte',
        };
        const sub = await fetchAndSubstituteTemplate(templateId, ctx);
        if (sub?.content) { subject = sub.subject || subject; content = sub.content; usedTemplate = true; }
      } catch (e) {
        console.warn('[tl-send-quotation] template-substitutie mislukt, fallback inline:', e.message);
      }
    }

    const r = await tlFetch('/quotations.send', {
      method: 'POST',
      body: JSON.stringify({ ...base, subject, content }),
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`TL quotations.send HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }

    await supabaseAdmin.from('deals').update({
      tl_quotation_status:        'sent',
      tl_quotation_email_sent_at: new Date().toISOString(),
      tl_quotation_sent_at:       deal.tl_quotation_sent_at || new Date().toISOString(),
    }).eq('id', deal_id);

    return res.status(200).json({ success: true, tl_quotation_status: 'sent', used_template: usedTemplate });
  } catch (e) {
    console.error('[tl-send-quotation]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
