// api/sales-subscription-delete.js
// POST { subscription_id }  (of DELETE ?id=) → zet abonnement lokaal op
// 'cancelled' (soft-delete) en schakelt het uit in Teamleader (best-effort).
// Permission: sales.deal.edit.
//
// TL-DISCOVERY (apiary): er is GEEN subscriptions.delete endpoint.
// Wel subscriptions.deactivate { id } → abonnement wordt gestopt (geen nieuwe
// facturen meer). Reeds geboekte/openstaande facturen blijven bestaan in TL —
// deactivate raakt die niet. Daarom: lokaal soft-delete (status='cancelled'),
// niet hard verwijderen, zodat de historie bewaard blijft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';
import { commissieVraagBijStop, annuleerCommissie } from './_lib/commissie-annulering.js';

// Regel C (12 nov 2026): stopt het LAATSTE actieve abonnement van een sale met
// open mentorcommissie (geen ander actief abonnement op deal_id of
// sale_deal_id), dan kiest de gebruiker: klant annuleert (commissie →
// geannuleerd) of er komt een nieuwe regeling (commissie blijft; link het
// nieuwe abonnement via Soort → Aanpassing). Een gelinkte aanpassing houdt
// de sale actief, dus vraagt niets.
const COMMISSIE_KEUZES = new Set(['klant_annuleert', 'nieuwe_regeling']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'DELETE') return res.status(405).json({ error: 'POST/DELETE only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.edit)' });
  }

  const subscriptionId = req.body?.subscription_id || req.query?.id;
  const force = req.body?.force === true; // 'Alleen lokaal stopzetten' bij TL-fout
  if (!subscriptionId) return res.status(400).json({ error: 'subscription_id vereist' });

  try {
    const { data: sub } = await supabaseAdmin.from('subscriptions').select('*').eq('id', subscriptionId).maybeSingle();
    if (!sub) return res.status(404).json({ error: 'Abonnement niet gevonden' });

    let commissieVraag = { vraag: false, sales: [] };
    try {
      commissieVraag = await commissieVraagBijStop(supabaseAdmin, { subscriptionId });
    } catch (e) {
      // Faalzacht: de commissie blijft dan gewoon open staan (niets verloren).
      console.error('[sub-delete] commissie-vraag:', e.message);
    }
    const commissieKeuze = req.body?.commissie_keuze || null;
    if (commissieVraag.vraag && sub.status !== 'cancelled' && !COMMISSIE_KEUZES.has(commissieKeuze)) {
      return res.status(409).json({
        error: 'Dit is het laatste actieve abonnement van een sale met mentorcommissie. Kies: klant annuleert of er komt een nieuwe regeling.',
        code: 'COMMISSIE_KEUZE_VEREIST',
        commissie: commissieVraag.sales,
      });
    }

    // TL-FIRST (Issue 2): deactiveer eerst in TL. Faalt dat én geen force →
    // 502 zonder lokale wijziging (geen out-of-sync state). Met force=true of
    // zonder TL-koppeling → lokaal stopzetten.
    // Init met skipped-signaal zodat frontend "was er niets in TL" kan
    // onderscheiden van "TL-call faalde".
    let tl = { deactivated: false, skipped: 'geen TL-koppeling' };
    if (sub.teamleader_subscription_id) {
      try {
        const tok = await getActiveToken();
        if (!tok) { tl = { deactivated: false, error: 'Geen TL-token actief' }; }
        else {
          const r = await tlFetch('/subscriptions.deactivate', { method: 'POST', body: JSON.stringify({ id: sub.teamleader_subscription_id }) });
          if (r.ok) tl = { deactivated: true };
          else { tl = { deactivated: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }; console.warn('[sub-delete] TL deactivate', tl.error); }
        }
      } catch (e) { tl = { deactivated: false, error: e.message }; console.warn('[sub-delete] TL exception:', e.message); }
      // Audit de TL-poging (traceability).
      try { await supabaseAdmin.from('audit_log').insert({ user_id: user.id, action: 'subscription.tl_deactivate_attempt', entity_type: 'subscription', entity_id: subscriptionId, after_json: tl, ip_address: getClientIp(req) }); } catch {}
      if (!tl.deactivated && !force) {
        return res.status(502).json({ error: 'Teamleader-deactivatie mislukt: ' + (tl.error || 'onbekend') + '. Probeer opnieuw of kies \'Alleen lokaal stopzetten\'.', tl_failed: true, tl });
      }
    }

    // Lokaal soft-delete: status='cancelled' (historie blijft). NIET slikken:
    // de TL-push is hierboven al geslaagd, dus als deze write faalt of 0 rijen
    // raakt zou het endpoint anders "success" teruggeven terwijl lokaal nog
    // 'active' staat (TL uit / lokaal aan = inconsistent). Surface dat expliciet.
    const { data: upRows, error: upErr } = await supabaseAdmin.from('subscriptions')
      .update({ status: 'cancelled' }).eq('id', subscriptionId).select('id');
    if (upErr) {
      console.error('[sub-delete] lokale status-update mislukt (TL al gedeactiveerd):', upErr.message);
      return res.status(500).json({
        error: 'Abonnement is in TeamLeader gedeactiveerd, maar de lokale status-update mislukte: ' + upErr.message,
        code: 'LOCAL_UPDATE_FAIL', tl, local_updated: false,
      });
    }
    if (!upRows || upRows.length === 0) {
      console.error('[sub-delete] lokale status-update raakte 0 rijen, id=', subscriptionId);
      return res.status(500).json({
        error: 'Abonnement is in TeamLeader gedeactiveerd, maar de lokale status-update raakte geen enkele rij (id niet gevonden).',
        code: 'LOCAL_UPDATE_NOMATCH', tl, local_updated: false,
      });
    }

    // Audit (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id, action: 'subscription.cancelled', entity_type: 'subscription', entity_id: subscriptionId,
        before_json: { status: sub.status }, after_json: { status: 'cancelled' },
        reason_text: tl.deactivated ? 'Verwijderd + TL gedeactiveerd' : 'Verwijderd (TL niet gesynct)', ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[sub-delete] audit:', e.message); }

    // Mentorcommissie volgens de keuze (fail-soft: het abonnement is gestopt).
    let commissie = null;
    if (commissieVraag.vraag && commissieKeuze === 'klant_annuleert') {
      commissie = [];
      for (const c of commissieVraag.sales) {
        try {
          const r = await annuleerCommissie(supabaseAdmin, {
            dealId: c.deal_id, soort: 'klant_annuleert', reden: 'laatste abonnement gestopt',
            extraNote: `Abonnement ${sub.description || subscriptionId} gestopt`, bron: 'abonnement', actorId: user.id,
          });
          commissie.push({ deal_id: c.deal_id, ok: true, geannuleerd_regels: r.geannuleerd_regels, al_vrijgegeven: r.al_vrijgegeven });
        } catch (e) {
          console.error('[sub-delete] commissie annuleren:', e.message);
          commissie.push({ deal_id: c.deal_id, ok: false, error: e.message });
        }
      }
    } else if (commissieVraag.vraag && commissieKeuze === 'nieuwe_regeling') {
      commissie = commissieVraag.sales.map((c) => ({ deal_id: c.deal_id, ok: true, blijft: true }));
      try {
        await supabaseAdmin.from('audit_log').insert({
          user_id: user.id, action: 'commissie.blijft_nieuwe_regeling', entity_type: 'subscription', entity_id: subscriptionId,
          after_json: { sales: commissieVraag.sales.map((c) => c.deal_id) },
          reason_text: 'Laatste abonnement gestopt; er komt een nieuwe regeling (commissie blijft, link via Soort → Aanpassing)',
          ip_address: getClientIp(req),
        });
      } catch (e) { console.error('[sub-delete] audit commissie:', e.message); }
    }

    return res.status(200).json({ success: true, tl, local_updated: true, commissie, commissie_keuze: commissieVraag.vraag ? commissieKeuze : null });
  } catch (e) {
    console.error('[sales-subscription-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
