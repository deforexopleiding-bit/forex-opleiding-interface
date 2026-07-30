// api/leadsonderhoud-test.js
// POST { to } -> stuurt een testmail naar een eigen adres via de bestaande
// mailserver (Strato), zodat je kunt controleren dat verzenden werkt zonder een
// echte klant te raken. Verstuurt ook als de motor op droogloop staat — het is
// een handmatige test, geen wachtrij-bericht.
//
// Gate: leads.view. Response: { ok, messageId } of { error }.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';

const MAIL_AFZENDER = 'onboarding@deforexopleiding.nl';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const to = String((req.body || {}).to || '').trim();
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Vul een geldig e-mailadres in' });

  const resultaat = await sendEmailViaSmtp({
    fromMailbox: MAIL_AFZENDER,
    to,
    subject: 'Test — leadsonderhoud',
    text: 'Dit is een testmail vanuit de leadsonderhoud-module. Als je dit leest, werkt het verzenden via de mailserver.',
    html: '<p>Dit is een testmail vanuit de <strong>leadsonderhoud</strong>-module.</p>'
        + '<p>Als je dit leest, werkt het verzenden via de mailserver.</p>',
  });

  if (!resultaat.ok) {
    console.error('testmail mislukt:', resultaat.reason);
    return res.status(502).json({ error: 'Versturen mislukt: ' + (resultaat.reason || 'onbekend') });
  }
  return res.status(200).json({ ok: true, messageId: resultaat.messageId || null });
}
