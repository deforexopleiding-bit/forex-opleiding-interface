// api/lab-nieuwe-link.js
//
// POST /api/lab-nieuwe-link { email } — "stuur me een nieuwe link" op het
// inlogscherm van het LMS en op de verlopen-pagina.
//
// Het antwoord is ALTIJD hetzelfde, of het adres nu een lab-lead is of niet
// (geen orakel). Is het er een, dan krijgt hij een verse loginlink; zijn
// toegang voorbij, dan wijst die link naar de boekingspagina.
//
// Begrensd per IP (rate-limit.js) én per adres: hoogstens drie links per tien
// minuten, zodat dit geen mailkanon wordt.

import { supabaseAdmin } from './supabase.js';
import { applyLabCors, labPreflight } from './_lib/lab-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { vindLabLead, maakLoginSleutel } from './_lib/dfo-lms-lab-account.js';
import { mailNieuweLink, stuurLabMail } from './_lib/lab-berichten.js';
import { labLoginLink } from './_lib/lab-config.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const ANTWOORD = 'Als dit adres bij ons bekend is, staat er binnen een minuut een nieuwe link in je mailbox.';

export default async function handler(req, res) {
  applyLabCors(req, res, 'POST, OPTIONS');
  if (labPreflight(req, res, 'POST')) return;

  const { limited } = await checkRateLimit({ req, bucket: 'lab-nieuwe-link', maxHits: 8, withinSeconds: 600 });
  if (limited) return res.status(429).json({ ok: false, code: 'te_veel', fout: 'Even geduld — probeer het over een paar minuten opnieuw.' });

  const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, code: 'ongeldig', fout: 'Vul een geldig e-mailadres in.' });

  try {
    const lead = await vindLabLead(email);
    if (lead) {
      const sinds = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { count } = await supabaseAdmin.from('berichten_log')
        .select('id', { count: 'exact', head: true })
        .eq('naar', email).eq('soort', 'lab-nieuwe-link').gte('verstuurd_op', sinds);
      if ((count || 0) < 3) {
        const verlopen = !!lead.toegang_tot && Date.parse(lead.toegang_tot) < Date.now();
        const link = labLoginLink(await maakLoginSleutel(lead.id), verlopen ? 'sessie' : 'start');
        await stuurLabMail({ leadId: lead.crm_lead_id || null, email, soort: 'lab-nieuwe-link', ...mailNieuweLink({ voornaam: lead.voornaam, link, verlopen }) });
      }
    }
  } catch (e) {
    // Ook bij een storing hetzelfde antwoord naar buiten; de fout staat in de log.
    console.error('[lab-nieuwe-link] mislukt:', e?.message || e);
  }
  return res.status(200).json({ ok: true, bericht: ANTWOORD });
}
