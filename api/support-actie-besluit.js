// api/support-actie-besluit.js
//
// POST — keur een voorgestelde actie goed of af.
//
// ── FASE S1: GOEDKEUREN IS NOG GEEN UITVOEREN ───────────────────────────────
// Een goedgekeurde actie krijgt status 'goedgekeurd' en blijft daar staan.
// Er draait in deze fase géén uitvoerder; een collega doet de handeling zelf
// en zet 'm daarna op uitgevoerd. Dat is met opzet: de handelingen waar het
// om gaat (een uitnodiging opnieuw sturen, een abonnement pauzeren, een
// factuur crediteren) hebben allemaal een grendel of een onomkeerbaar
// gevolg, en die automatiseren we pas als dit pad in de praktijk klopt.
//
// De belangrijkste grendel om te kennen: een LMS-uitnodiging opnieuw sturen
// mag NIET zomaar. Bij UITNODIGING_MAIL_MISLUKT werkt het oude wachtwoord
// nog en breekt een tweede mail dat. Alleen bij
// UITNODIGING_WACHTWOORD_NIET_GEZET is opnieuw sturen noodzaak. Die reden
// staat in payload.lms_reden zodat wie goedkeurt het ziet.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { schrijfBericht } from './_lib/support-sessie.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BESLUITEN = { goedkeuren: 'goedgekeurd', afwijzen: 'afgewezen', uitgevoerd: 'uitgevoerd' };

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'POST')) return;

  const staff = await staffUit(req, res, 'support.actie.besluit');
  if (!staff) return;

  const id = String(req.body?.actie_id || '');
  const besluit = BESLUITEN[String(req.body?.besluit || '')];
  const reden = String(req.body?.reden || '').trim().slice(0, 500);

  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig actie_id' });
  if (!besluit) return res.status(400).json({ error: 'besluit moet goedkeuren, afwijzen of uitgevoerd zijn' });

  try {
    const { data: actie } = await supabaseAdmin
      .from('support_acties').select('*').eq('id', id).maybeSingle();
    if (!actie) return res.status(404).json({ error: 'Actie niet gevonden' });

    // Alleen vooruit. Een afgewezen actie weer goedkeuren zou de
    // beslisgeschiedenis onleesbaar maken; maak dan een nieuwe aan.
    if (besluit !== 'uitgevoerd' && actie.status !== 'voorgesteld') {
      return res.status(409).json({ error: `Deze actie staat al op ${actie.status}.` });
    }
    if (besluit === 'uitgevoerd' && actie.status !== 'goedgekeurd') {
      return res.status(409).json({ error: 'Alleen een goedgekeurde actie kan op uitgevoerd.' });
    }

    const patch = { status: besluit, besluit_reden: reden || null };
    if (besluit === 'uitgevoerd') {
      patch.uitgevoerd_op = new Date().toISOString();
    } else {
      patch.besloten_door = staff.user.id;
      patch.besloten_op = new Date().toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from('support_acties').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw new Error(error.message);

    // Bij uitvoering mag de bezoeker dat weten — dat is tenslotte waar 'ie
    // op zat te wachten. Bij goedkeuren nog niet: er is dan nog niets
    // gebeurd, en "het is goedgekeurd" leest als "het is geregeld".
    if (besluit === 'uitgevoerd') {
      await schrijfBericht({
        gesprekId: actie.gesprek_id,
        afzender: 'systeem',
        tekst: `We hebben dit voor je gedaan: ${actie.omschrijving}`,
        meta: { soort: 'actie_uitgevoerd', actie_id: id },
      });
    }

    return res.status(200).json({ actie: data });
  } catch (e) {
    console.error('[support-actie-besluit] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon het besluit niet opslaan.' });
  }
}
