// api/inbox-uitgesteld.js
//
// Een geparkeerd bericht nú versturen, of terughalen.
//
//   POST { id, actie: 'nu' }        → verstuur meteen
//   POST { id, actie: 'annuleer' }  → haal terug, en geef de tekst terug
//
// ── WIE ROEPT WAT AAN ────────────────────────────────────────────────────────
// 'nu' wordt door het scherm aangeroepen op twee momenten: als de dertig
// seconden om zijn (het normale geval — daarom is het venster exact dertig
// seconden en niet "ergens in de volgende minuut"), en als iemand op "Nu
// versturen" drukt omdat hij niet wil wachten.
//
// 'annuleer' is de knop "Toch niet". Die geeft de tekst terug, zodat het scherm
// hem terug in het veld kan zetten — je had hem net getypt, het zou raar zijn
// als hij verdwijnt omdat je je bedacht.
//
// ── WAT ER NOOIT GEBEURT ─────────────────────────────────────────────────────
// Twee keer versturen. Beide acties gaan via een claim die alleen slaagt als de
// rij nog op 'gepland' staat én nog van niemand is. Drukt het scherm op 'nu'
// terwijl de cron hem net oppakte, dan krijgt er één een rij en de ander niets —
// en die ander zegt eerlijk wat er aan de hand is.
//
// Annuleren ná de claim lukt niet, en dat is met opzet: op dat moment is het
// bericht ónderweg. Een knop die zegt dat hij het tegenhield terwijl de klant
// het al heeft, is erger dan een knop die zegt dat het te laat is.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { gesprekkenV2Aan } from './_lib/gesprekken-vlag.js';
import { UUID_RE } from './_lib/inbox-verzendopdracht.js';
import { verstuurInGesprek } from './_lib/inbox-verzenden.js';
import { claim, annuleer, uitWachtrij, markeerVerstuurd, markeerMislukt } from './_lib/inbox-uitgesteld.js';

const ACTIES = ['nu', 'annuleer'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
  }

  if (!gesprekkenV2Aan()) {
    return res.status(404).json({ error: 'Uitgesteld versturen staat uit (GESPREKKEN_V2)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id = String(body.id || '').trim();
  const actie = String(body.actie || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
  if (!ACTIES.includes(actie)) {
    return res.status(400).json({ error: `actie moet '${ACTIES.join("' of '")}' zijn` });
  }

  try {
    if (actie === 'annuleer') {
      const teruggehaald = await annuleer(id, `teruggehaald door ${user.id}`);
      if (!teruggehaald) {
        // Al geclaimd, al verstuurd, of al geannuleerd. In alle drie de
        // gevallen is "het is teruggehaald" een onwaarheid.
        return res.status(409).json({
          error: 'te_laat',
          message: 'Dit bericht is al onderweg of al afgehandeld — terughalen kan niet meer.',
        });
      }
      return res.status(200).json({
        ok: true,
        // De tekst terug, zodat het scherm 'm in het veld kan zetten.
        mode: teruggehaald.mode,
        body: teruggehaald.body || '',
        template_name: teruggehaald.template_name || null,
      });
    }

    // actie === 'nu'
    const rij = await claim(id);
    if (!rij) {
      return res.status(409).json({
        error: 'al_opgepakt',
        message: 'Dit bericht wordt al verstuurd of is al afgehandeld.',
      });
    }

    const uitkomst = await verstuurInGesprek(uitWachtrij(rij), {
      userId : rij.aangemaakt_door || user.id,
      ip     : getClientIp(req),
      rechten: { finance: hasFinanceSend, simone: hasSimoneUse, onboarding: hasOnboardingSend },
    });

    if (uitkomst.http === 200) {
      await markeerVerstuurd(id, uitkomst.payload?.meta_wamid || null);
      return res.status(200).json({ ok: true, ...uitkomst.payload });
    }

    // Niet gelukt. De reden komt in de rij te staan en daarmee in het gesprek:
    // een bericht dat niet vertrok, mag nooit stil blijven. Dat is precies het
    // gat dat deze hele bouw dicht.
    const reden = uitkomst.payload?.message || uitkomst.payload?.error || 'onbekende fout';
    await markeerMislukt(id, reden);
    return res.status(uitkomst.http).json(uitkomst.payload);
  } catch (e) {
    console.error('[inbox-uitgesteld]', e?.message || e);
    // Ook hier: liever een rij die zegt dat het misging dan een rij die blijft
    // hangen op 'gepland' met een claim erop.
    if (actie === 'nu') {
      try { await markeerMislukt(id, e?.message || 'onbekende fout'); } catch (_) { /* al gemeld */ }
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
