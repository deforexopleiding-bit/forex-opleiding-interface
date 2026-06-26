// api/inbox-customer-search.js
// GET → typeahead-zoek voor het Inbox koppel-modal (state='unknown' in klant-paneel).
// Permission: finance.inbox.send (write-actie binnen dezelfde scope als
//   inbox-link-conversation-to-customer; iedereen die mag versturen moet ook kunnen
//   koppelen om de unknown→matched flow te voltooien).
//
// Bewust slank gehouden (vs. /api/customers): geen tags-join, geen status-filters,
// geen sort-opties — alleen wat de inbox-modal nodig heeft (naam + telefoon + email
// in een resultaatlijstje).
//
// Query params:
//   q       string  — zoektekst (case-insensitive ILIKE op first_name/last_name/
//                     company_name/email/phone). Multi-woord: AND-tussen-woorden,
//                     OR-tussen-kolommen. Minimaal 2 tekens (anders 200 met
//                     lege results).
//   limit   int     — max resultaten, default 10, clamp [1..25].
//
// Response 200:
//   { results: [{ id, name, email, phone, is_company }] }
//
// Error responses:
//   401  geen sessie
//   403  geen permission
//   500  database-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { isMentorOnly } from './_lib/onboardingScope.js';
import { customerDisplayName } from './_lib/customer-name.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth-gate — zelfde permission als de link-endpoint.
  // B1 — additieve OR-chain (finance/events/onboarding-send). Search hoort
  // bij de link-flow; alle 3 modules moeten een conv aan een klant kunnen
  // koppelen vanuit hun eigen inbox-UI.
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

  // Fase 2b: een view_own-only-mentor mag NIET door alle klanten zoeken
  // (dit endpoint is voor admins die conversaties handmatig willen koppelen).
  // Finance/events-gebruikers (zonder onboarding.view_own) blijven ongewijzigd.
  if (await isMentorOnly(req)) {
    return res.status(403).json({ error: 'Mentor mag niet door alle klanten zoeken' });
  }

  const q = String(req.query.q || '').trim();
  const rawLimit = parseInt(req.query.limit, 10) || 10;
  const limit = Math.min(25, Math.max(1, rawLimit));

  // Korte queries: lege results (geen DB-call voor 1-character noise).
  if (q.length < 2) {
    return res.status(200).json({ results: [] });
  }

  try {
    let query = supabaseAdmin
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone')
      .is('archived_at', null)
      .is('anonymized_at', null);

    // Multi-woord ILIKE-search (gelijk aan /api/customers pattern): elk woord
    // moet ergens in één van de 5 kolommen voorkomen. AND tussen woorden,
    // OR tussen kolommen.
    const words = q.split(/\s+/).filter(Boolean);
    for (const w of words) {
      const safeW = w.replace(/[,()]/g, ' ');
      const pat = `%${safeW}%`;
      query = query.or(
        `first_name.ilike.${pat},last_name.ilike.${pat},company_name.ilike.${pat},email.ilike.${pat},phone.ilike.${pat}`
      );
    }

    query = query.order('created_at', { ascending: false }).limit(limit);

    const { data, error } = await query;
    if (error) {
      console.error('[inbox-customer-search] query error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    const results = (data || []).map(c => ({
      id:         c.id,
      name:       customerDisplayName(c, '') || '(naamloos)',
      email:      c.email || null,
      phone:      c.phone || null,
      is_company: !!c.is_company,
    }));

    return res.status(200).json({ results });
  } catch (e) {
    console.error('[inbox-customer-search]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
