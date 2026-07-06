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

  // Diagnose-object — puur observability, geen gedragswijziging. Wordt
  // meegegeven in zowel success- als fout-response zodat we in de UI/console
  // exact zien welke tak is gedraaid en waarom de mail kaal aankomt.
  const debug = {
    received_template_id:  email_template_id || null,
    resolved_template_id:  null,
    default_from_settings: null,
    used_template:         false,
    substitution_error:    null,
    subject_preview:       null,
    content_preview:       null,
    tl_send_status:        null,
    tl_send_body:          null,
  };

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
      .select('email, is_company, company_name, first_name, last_name').eq('id', deal.customer_id).maybeSingle();
    const recipientEmail = customer?.email;
    if (!recipientEmail) return res.status(409).json({ error: 'Klant heeft geen e-mailadres — offerte kan niet verstuurd worden' });

    // Template-keuze: expliciete param, anders default uit settings.
    let templateId = email_template_id || null;
    // Default altijd inlezen zodat debug 'default_from_settings' consistent
    // gezet wordt, ongeacht of er een expliciete template mee kwam.
    {
      const { data: setting } = await supabaseAdmin.from('teamleader_settings')
        .select('value').eq('key', 'default_email_template_id').maybeSingle();
      debug.default_from_settings = setting?.value || null;
      if (!templateId) templateId = debug.default_from_settings;
    }
    debug.resolved_template_id = templateId;

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
          contact_name:    customerDisplayName(customer),
          my_name:         profile?.full_name || '',
          department_name: departmentName,
          deal_title:      deal.quote_reference || 'Offerte',
        };
        const sub = await fetchAndSubstituteTemplate(templateId, ctx);
        if (sub?.content) { subject = sub.subject || subject; content = sub.content; usedTemplate = true; }
      } catch (e) {
        console.warn('[tl-send-quotation] template-substitutie mislukt, fallback inline:', e.message);
        debug.substitution_error = e?.message || String(e);
      }
    }
    debug.used_template    = usedTemplate;
    debug.subject_preview  = (subject || '').slice(0, 80);
    debug.content_preview  = (content || '').slice(0, 120);

    const r = await tlFetch('/quotations.send', {
      method: 'POST',
      body: JSON.stringify({ ...base, subject, content }),
    });
    debug.tl_send_status = r.status;
    if (!r.ok) {
      const txt = await r.text();
      debug.tl_send_body = (txt || '').slice(0, 300);
      throw new Error(`TL quotations.send HTTP ${r.status}: ${txt.slice(0, 200)}`);
    }

    await supabaseAdmin.from('deals').update({
      tl_quotation_status:        'sent',
      tl_quotation_email_sent_at: new Date().toISOString(),
      tl_quotation_sent_at:       deal.tl_quotation_sent_at || new Date().toISOString(),
    }).eq('id', deal_id);

    return res.status(200).json({ success: true, tl_quotation_status: 'sent', used_template: usedTemplate, debug });
  } catch (e) {
    console.error('[tl-send-quotation]', e.message);
    return res.status(500).json({ error: e.message, debug });
  }
}
