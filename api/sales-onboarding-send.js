// api/sales-onboarding-send.js
// POST { customer_id } → genereert onboarding-token, verstuurt welkomstmail
// (best-effort), zet onboarding_status='sent'. Permission: sales.customer.edit
// (valt terug op sales.customer.view-niveau via sales.deal.create indien nodig).

import crypto from 'crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendMail, wrapEmailHtml } from './mailer.js';

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.create'))) {
    return res.status(403).json({ error: 'Geen rechten' });
  }

  const { customer_id } = req.body || {};
  if (!customer_id) return res.status(400).json({ error: 'customer_id vereist' });

  try {
    const { data: c } = await supabaseAdmin.from('customers')
      .select('id, first_name, last_name, email, onboarding_token').eq('id', customer_id).maybeSingle();
    if (!c) return res.status(404).json({ error: 'Klant niet gevonden' });

    // Bepaal entiteit-label via laatste deal (voor mailtekst).
    const { data: deal } = await supabaseAdmin.from('deals')
      .select('tl_department_id').eq('customer_id', customer_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    let entiteit = 'De Forex Opleiding';
    if (deal?.tl_department_id) {
      const { data: ent } = await supabaseAdmin.from('company_entities').select('label').eq('tl_department_id', deal.tl_department_id).maybeSingle();
      if (ent?.label) entiteit = ent.label;
    }

    const token = c.onboarding_token || crypto.randomBytes(24).toString('hex');
    const link = `${BASE_URL}/modules/onboarding.html?token=${token}`;

    // Welkomstmail (best-effort).
    let mailSent = false, mailError = null;
    if (c.email) {
      try {
        const body = `<p>Beste ${c.first_name || ''},</p>
          <p>Welkom bij <strong>${entiteit}</strong>! We zijn blij je aan boord te hebben.</p>
          <p>Om je onboarding af te ronden, vul je het korte formulier in via onderstaande link. Daarna plannen we je eerste call.</p>
          <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#093d54;color:#fff;border-radius:8px;text-decoration:none">Start je onboarding</a></p>
          <p>Of kopieer deze link: <br>${link}</p>
          <p>Met vriendelijke groet,<br>De Forex Opleiding</p>`;
        await sendMail({ to: c.email, subject: `Welkom bij ${entiteit} — start je onboarding`, html: wrapEmailHtml('Welkom', body), text: `Welkom bij ${entiteit}! Start je onboarding: ${link}` });
        mailSent = true;
      } catch (e) { mailError = e.message; console.warn('[onboarding-send] mail mislukt:', e.message); }
    }

    await supabaseAdmin.from('customers').update({
      onboarding_status: 'sent', onboarding_sent_at: new Date().toISOString(), onboarding_token: token,
    }).eq('id', customer_id);

    return res.status(200).json({ success: true, mail_sent: mailSent, mail_error: mailError, link });
  } catch (e) {
    console.error('[sales-onboarding-send]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
