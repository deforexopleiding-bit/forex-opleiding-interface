// api/onboarding-wizard-get.js
//
// PUBLIEK read-only GET. Input: ?t=<token (uuid)>.
// Geen createUserClient — de student is niet ingelogd. Token = auth.
//
// Onbekend/ongeldig token → 404 met generieke shape (geen enumeratie-leak).
//
// Privacy:
//   - GEEN email, telefoon, last_name in de response. Alleen first_name
//     voor "Hoi, X"-tekst in de wizard-UI.
//   - Token zelf wordt niet teruggegeven (caller heeft 'm al in de URL).
//
// Response 200:
//   {
//     customer_first_name : string|null,
//     status              : 'aangemeld'|'bezig'|'afgerond'|'gearchiveerd',
//     current_step        : int|null,
//     answers             : object (jsonb; key→value),
//     pages               : [...]   // uit DEFAULT_WIZARD_STRUCTURE
//   }

import { supabaseAdmin } from './supabase.js';
import { DEFAULT_WIZARD_STRUCTURE } from './_lib/onboarding-wizard-default.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const token = req.query?.t ? String(req.query.t).trim() : null;
  if (!token || !UUID_RE.test(token)) {
    // 400 is bewust: ongeldig formaat lekt geen bestaan/-niet-bestaan.
    return res.status(400).json({ error: 'Link niet geldig.' });
  }

  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, status, current_step, answers')
      .eq('token', token)
      .maybeSingle();
    if (obErr) {
      console.error('[onboarding-wizard-get] onboarding lookup:', obErr.message);
      return res.status(500).json({ error: 'Kon link niet ophalen.' });
    }
    if (!ob) {
      // Generieke 404; geen onderscheid tussen "bestaat niet" en "expired".
      return res.status(404).json({ error: 'Link niet geldig.' });
    }

    // First_name ophalen — minimale PII; geen overige customer-velden.
    let firstName = null;
    if (ob.customer_id) {
      const { data: cust, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('first_name')
        .eq('id', ob.customer_id)
        .maybeSingle();
      if (custErr) {
        console.error('[onboarding-wizard-get] customer lookup:', custErr.message);
      } else {
        firstName = cust?.first_name || null;
      }
    }

    return res.status(200).json({
      customer_first_name : firstName,
      status              : ob.status,
      current_step        : (ob.current_step == null) ? null : Number(ob.current_step),
      answers             : (ob.answers && typeof ob.answers === 'object') ? ob.answers : {},
      pages               : DEFAULT_WIZARD_STRUCTURE.pages,
    });
  } catch (e) {
    console.error('[onboarding-wizard-get] fatal:', e?.message || e);
    return res.status(500).json({ error: 'Kon link niet ophalen.' });
  }
}
