// api/leadsonderhoud-test.js
// POST { to, sjabloon_id?, formaat? } -> stuurt een testmail naar een eigen
// adres via de mailserver (Strato), zodat je de echte opmaak ziet zonder een
// klant te raken. Met sjabloon_id wordt dat sjabloon met NEPPE gegevens ingevuld
// (voornaam, lessen, trades, dagen over, agendalink); formaat 'html' of 'plat'
// bepaalt wat je te zien krijgt. Zonder sjabloon_id: een kale controlemail.
//
// Verstuurt ook als de motor op droogloop staat — het is een handmatige test.
// Gate: leads.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { vulSjabloon } from './_lib/leadsonderhoud-sjabloon.js';

const MAIL_AFZENDER = 'onboarding@deforexopleiding.nl';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Neppe gegevens voor de test, zodat je de aanhef, cijfers en knoppen ziet.
const NEP_LEAD = { voornaam: 'Sanne', lessen_gezien: 5, trades: 3, dagen_over: 2, score: 20, agenda_link: 'https://deforexopleiding.nl/gesprek' };
const NEP_EXTRA = { agendalink: 'https://deforexopleiding.nl/gesprek', inloglink: 'https://deforexopleiding.nl/lms/voorbeeld', datum: 'zaterdag 2 augustus', tijd: '14:00' };

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

  const b = req.body || {};
  const to = String(b.to || '').trim();
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'Vul een geldig e-mailadres in' });
  const formaat = b.formaat === 'plat' ? 'plat' : 'html';

  let onderwerp = 'Test — leadsonderhoud';
  let tekst = 'Dit is een kale controlemail vanuit de leadsonderhoud-module. Kies een sjabloon om de echte opmaak te zien.';
  let html = '<p>Dit is een kale controlemail. Kies een sjabloon om de echte opmaak te zien.</p>';

  if (b.sjabloon_id) {
    const { data: sjabloon, error } = await supabaseAdmin
      .from('onderhoud_sjablonen').select('*').eq('id', b.sjabloon_id).maybeSingle();
    if (error || !sjabloon) return res.status(404).json({ error: 'Sjabloon niet gevonden' });
    if (sjabloon.kanaal !== 'mail') return res.status(400).json({ error: 'Alleen mail-sjablonen kun je als testmail sturen (WhatsApp bekijk je via Voorbeeld)' });
    const ingevuld = vulSjabloon(sjabloon, NEP_LEAD, NEP_EXTRA);
    onderwerp = ingevuld.onderwerp || onderwerp;
    tekst = ingevuld.tekst || tekst;
    html = ingevuld.html || null;
  }

  const resultaat = await sendEmailViaSmtp({
    fromMailbox: MAIL_AFZENDER,
    to,
    subject: '[TEST] ' + onderwerp,
    text: tekst,
    // Bij 'plat' geen html meesturen, zodat je de platte variant te zien krijgt.
    html: formaat === 'plat' ? null : html,
  });

  if (!resultaat.ok) {
    console.error('testmail mislukt:', resultaat.reason);
    return res.status(502).json({ error: 'Versturen mislukt: ' + (resultaat.reason || 'onbekend') });
  }
  return res.status(200).json({ ok: true, messageId: resultaat.messageId || null });
}
