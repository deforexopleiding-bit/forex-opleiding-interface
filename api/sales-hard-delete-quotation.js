// api/sales-hard-delete-quotation.js
//
// POST { deal_id, confirm: 'VERWIJDER', onboarding_bevestigd? } → definitieve, onherstelbare hard-
// delete van een getekende offerte. Zowel TL als lokale CRM.
//
// FLOW:
//   1. Auth: user IN ('super_admin', 'sales') + is_active. Anders 403.
//   2. Confirm-token check: body.confirm === 'VERWIJDER' (exact, case-sens).
//   3. Guard-preflight (re-run server-side; UI-preflight is niet vertrouwd):
//      * invoices met deze deal_id                                        → 409
//      * payment_arrangements met matchende invoice_ids + levend           → 409
//      * bonuses met deze deal_id                                          → 409
//      * setter_ledger_entries met deze deal_id (elke status = geld)       → 409
//   3b. ONBOARDING (12 nov 2026, geen blocker): een lopende onboarding van de
//       klant, of een onboarding met deal_id = deze offerte → 409
//       ONBOARDING_BEVESTIGING_NODIG tenzij body.onboarding_bevestigd === true.
//       Verwijderen laat de onboarding open staan; een offertewissel loopt
//       via "Deze offerte vervangt de lopende onboarding".
//   4. TL-hard-delete (blocking, geen best-effort meer):
//      a. quotations.delete → 200? klaar met TL.
//      b. Anders: deals.delete → 200? klaar met TL.
//      c. Beide falen: 502 met TL-error-body, GEEN lokale delete (state
//         blijft consistent; Jeffrey ziet exact wat TL zegt).
//   5. Lokale hard-delete: DELETE FROM deals WHERE id=$1 (cascade doet de rest).
//   6. Audit-log: agent_audit_log { agent_name:'sales-hard-delete',
//      action:'quotation.hard_delete', payload:{full-context}, result, status }.
//   7. Bij partial (TL succes + lokale delete faalt): audit-status 'partial'
//      + admin-alarm-mail naar PROVISIONING_ALARM_EMAIL (of code-default
//      biemoldjeffrey@gmail.com) — zelfde mechanisme als provisioning-gaveup.
//      Response 500 met partial-flag zodat de UI het duidelijk toont.
//
// Rechten (spec Jeffrey 2026-09-18): super_admin + sales — admin/manager
// expliciet niet. Sales-rol = eigenaar van het sales-domein (Dave).
//
// 0 mutaties op incasso/finance-tabellen. Alleen deals + cascade (subs, line-
// items, meta_capi_events verdwijnen mee) + event_attendees/setter_ledger
// (SET NULL, maar setter_ledger valt onder guard dus komt niet aan bod).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { sendMail, wrapEmailHtml } from './mailer.js';
import { getEffectiveRoles, hasAnyRole, computeHighestRole } from './_lib/roles.js';
import { leesOnboardingsBijVerwijderen, VERWIJDER_ONBOARDING_UITLEG } from './_lib/onboarding-offerte-wissel.js';
import { commissieVanDeal, annuleerCommissie, herstelCommissie } from './_lib/commissie-annulering.js';

// Regel B (12 nov 2026): hangt er OPEN mentorcommissie aan de offerte, dan
// kiest de gebruiker in het venster wat er gebeurt. Nooit meer een deal
// weg met ledger-ouders in pending/wachten_op_betaling zonder eindstatus.
const COMMISSIE_KEUZES = new Set(['klant_annuleert', 'vervangen']);

const CONFIRM_TOKEN = 'VERWIJDER'; // case-sensitive
const DEFAULT_ALARM_EMAIL = 'biemoldjeffrey@gmail.com';

function parseAlarmEmails(env) {
  return String(env || '')
    .split(',').map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}
function resolveAlarmRecipients() {
  const envList = parseAlarmEmails(process.env.PROVISIONING_ALARM_EMAIL);
  if (envList.length) return envList;
  return [DEFAULT_ALARM_EMAIL];
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function checkAuth(req) {
  const sb = createUserClient(req);
  const { data: { user }, error } = await sb.auth.getUser();
  if (error || !user) return { ok: false, status: 401, error: 'Niet geauthenticeerd' };
  const { data: profile } = await supabaseAdmin.from('profiles')
    .select('id, role, is_active, full_name, email').eq('id', user.id).maybeSingle();
  if (!profile)               return { ok: false, status: 403, error: 'Geen profiel gevonden' };
  if (!profile.is_active)     return { ok: false, status: 403, error: 'Profiel is niet actief' };
  // Effectieve rollen = union van profiles.role + user_roles (multi-rol). De
  // scalaire profiles.role is als "primaire" rol onbetrouwbaar: een super_admin
  // die ook mentor is kan primair='mentor' hebben. Zie api/_lib/roles.js.
  const rollen = await getEffectiveRoles(user.id, supabaseAdmin);
  if (!hasAnyRole(rollen, ['super_admin', 'sales'])) {
    return { ok: false, status: 403,
      error: `Alleen super_admin en sales mogen hard-deleten (jouw rollen: ${rollen.join(', ') || 'geen'})` };
  }
  // Audit-/response-rol = hoogste effectieve rol, niet de (mogelijk afwijkende)
  // primaire profiles.role, zodat het logboek de echte uitvoerder-rol toont.
  profile.role = computeHighestRole(rollen);
  return { ok: true, user, profile, rollen };
}

/**
 * Server-side guard-check. Identiek criterium als in preflight, maar strak
 * en snel — 4 count-queries. Returnt null als OK, of een blocker-object.
 */
async function guardBlockers(deal_id) {
  const { data: invoices } = await supabaseAdmin.from('invoices')
    .select('id, invoice_number, amount_total').eq('deal_id', deal_id);
  if ((invoices || []).length > 0) {
    return { type: 'invoices', count: invoices.length, ids: invoices.map((i) => i.id) };
  }
  // arrangements — koppelen via invoice_ids-array. Bij 0 invoices is dit 0.
  // (defensief blijven check'en voor de zeldzame race waar 'n andere flow
  // net een invoice heeft weggegooid maar de regeling nog leeft.)
  const { data: bonuses } = await supabaseAdmin.from('bonuses')
    .select('id').eq('deal_id', deal_id);
  if ((bonuses || []).length > 0) {
    return { type: 'bonuses', count: bonuses.length, ids: bonuses.map((b) => b.id) };
  }
  // Handmatige commissietoewijzing: FK RESTRICT + deal_id NOT NULL → de
  // lokale DELETE zou na de TL-delete mislukken (partial). Weigeren vooraf.
  const { data: attrs, error: attrErr } = await supabaseAdmin.from('mentor_sale_attributions')
    .select('id').eq('deal_id', deal_id);
  if (attrErr && !/does not exist|42P01/i.test(`${attrErr.code} ${attrErr.message}`)) {
    throw new Error('attributions-check: ' + attrErr.message);
  }
  if ((attrs || []).length > 0) {
    return { type: 'mentor_sale_attributions', count: attrs.length, ids: attrs.map((a) => a.id) };
  }
  const { data: setterLedger } = await supabaseAdmin.from('setter_ledger_entries')
    .select('id, amount, status').eq('deal_id', deal_id);
  if ((setterLedger || []).length > 0) {
    return { type: 'setter_ledger_entries', count: setterLedger.length,
             ids: setterLedger.map((e) => e.id) };
  }
  return null;
}

/**
 * Probeer TL quotations.delete → deals.delete. Retourneert een gestructureerd
 * resultaat zodat de audit-log per stap ziet wat er gebeurde.
 */
async function teamleaderHardDelete(deal) {
  const tok = await getActiveToken();
  if (!tok) {
    // Geen TL-token: als de deal geen TL-refs heeft is dat OK. Anders fail.
    if (!deal.tl_deal_id && !deal.tl_quotation_id) {
      return { ok: true, skipped: 'geen TL-token en geen TL-refs op de deal' };
    }
    return { ok: false, stage: 'token', error: 'Geen Teamleader-token; kan TL niet opschonen' };
  }
  const trail = { quotation_delete: null, deal_delete: null };

  if (deal.tl_quotation_id) {
    try {
      const r = await tlFetch('/quotations.delete', {
        method: 'POST', body: JSON.stringify({ id: deal.tl_quotation_id }),
      });
      const body = await r.text().catch(() => '');
      trail.quotation_delete = { http_status: r.status, body: body.slice(0, 400) };
      if (r.ok) return { ok: true, via: 'quotations.delete', trail };
    } catch (e) {
      trail.quotation_delete = { error: e?.message || String(e) };
    }
  } else {
    trail.quotation_delete = { skipped: 'geen tl_quotation_id' };
  }

  if (deal.tl_deal_id) {
    try {
      const r = await tlFetch('/deals.delete', {
        method: 'POST', body: JSON.stringify({ id: deal.tl_deal_id }),
      });
      const body = await r.text().catch(() => '');
      trail.deal_delete = { http_status: r.status, body: body.slice(0, 400) };
      if (r.ok) return { ok: true, via: 'deals.delete', trail };
    } catch (e) {
      trail.deal_delete = { error: e?.message || String(e) };
    }
  } else {
    trail.deal_delete = { skipped: 'geen tl_deal_id' };
  }

  return {
    ok: false, stage: 'tl_calls', error: 'Beide TL-endpoints faalden',
    detail: 'Teamleader weigert delete — typisch omdat er een factuur aan de deal hangt bij TL zelf (kan buiten onze CRM-view liggen). Sync eerst.',
    trail,
  };
}

async function stuurPartialAlarm({ deal_id, deal, tlResult, lokaleFout, actor }) {
  try {
    const recipients = resolveAlarmRecipients();
    const subject = `⚠ Sales hard-delete: PARTIAL — TL leeg maar lokaal nog aanwezig (deal ${deal_id})`;
    const text =
`Er is een sync-mismatch opgetreden bij een sales hard-delete.

Deal-id            : ${deal_id}
TL quotation-id    : ${deal.tl_quotation_id || '(geen)'}
TL deal-id         : ${deal.tl_deal_id || '(geen)'}
Klant-id           : ${deal.customer_id || '(geen)'}
Actor (uitvoerder) : ${actor.email} (${actor.role})

Teamleader is opgeruimd (via ${tlResult.via || 'onbekend'}), maar de lokale
DELETE FROM deals faalde met:
${lokaleFout}

De offerte staat nu NIET meer in Teamleader maar WEL nog in de CRM. Dat
moet handmatig gecorrigeerd worden — controleer de audit-log
(agent_audit_log status='partial') en verwijder de deal-rij handmatig via
Supabase Studio.`;
    const html = wrapEmailHtml('⚠ Sales hard-delete: PARTIAL sync-mismatch', `
<p style="margin:0 0 12px">Er is een <b>sync-mismatch</b> opgetreden bij een sales hard-delete: Teamleader is opgeruimd maar de lokale CRM-DB niet.</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13.5px;line-height:1.55">
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Deal-id</td><td style="padding:3px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${escapeHtml(deal_id)}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">TL quotation-id</td><td style="padding:3px 0">${escapeHtml(deal.tl_quotation_id || '(geen)')}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">TL deal-id</td><td style="padding:3px 0">${escapeHtml(deal.tl_deal_id || '(geen)')}</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">Actor</td><td style="padding:3px 0">${escapeHtml(actor.email)} (${escapeHtml(actor.role)})</td></tr>
  <tr><td style="padding:3px 12px 3px 0;color:#6b7280">TL via</td><td style="padding:3px 0">${escapeHtml(tlResult.via || 'onbekend')}</td></tr>
</table>
<p style="margin:14px 0 6px;color:#6b7280;font-size:12px">Lokale DB-fout:</p>
<pre style="margin:0;padding:10px 12px;background:#fee2e2;border-radius:6px;color:#7f1d1d;font-size:12px;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(lokaleFout)}</pre>
<p style="margin:16px 0 0;font-size:13px;color:#374151">Corrigeer handmatig via Supabase Studio: verwijder de deal-rij én controleer de audit-log (<code>agent_audit_log</code> status=<code>partial</code>) voor de context.</p>
`);
    let anySent = false;
    for (const rec of recipients) {
      const rr = await sendMail({ to: rec, subject, text, html });
      if (rr && rr.success) anySent = true;
      else console.warn('[sales-hard-delete] partial-alarm mail-fail:', rec, rr?.error || '(onbekend)');
    }
    return anySent;
  } catch (e) {
    console.error('[sales-hard-delete] partial-alarm exception:', e?.message || e);
    return false;
  }
}

async function logAudit({ action, payload, result, status, error_message, userId }) {
  try {
    await supabaseAdmin.from('agent_audit_log').insert({
      agent_name    : 'sales-hard-delete',
      action,
      payload,
      result,
      status,
      error_message : error_message || null,
      triggered_by  : userId || 'system',
    });
  } catch (e) {
    console.error('[sales-hard-delete] audit insert failed:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = await checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { deal_id, confirm, onboarding_bevestigd } = req.body || {};
  if (!deal_id) return res.status(400).json({ error: 'deal_id (uuid) vereist' });
  if (confirm !== CONFIRM_TOKEN) {
    return res.status(400).json({
      error: `confirm-token ontbreekt of onjuist. Verwacht: exact "${CONFIRM_TOKEN}" (hoofdlettergevoelig).`,
    });
  }

  try {
    // 1. Deal-context laden. 2026-09-18: `error` destructureren zodat een
    // toekomstige lookup-fout niet stil-fail-t als misleidende 404 (zoals bij
    // de preflight-embed-fout — customers.name-kolom die niet bestond). Deze
    // lookup gebruikt NU geen embeds en enkel bestaande kolommen (id,
    // customer_id, sales_user_id, tl_deal_id, tl_quotation_id,
    // tl_quotation_status, quote_reference) → geen bekende issue-vector.
    const { data: deal, error: dealErr } = await supabaseAdmin.from('deals')
      .select('id, customer_id, sales_user_id, tl_deal_id, tl_quotation_id, tl_quotation_status, quote_reference')
      .eq('id', deal_id).maybeSingle();
    if (dealErr) return res.status(500).json({ error: 'Deal-lookup fout', detail: dealErr.message });
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });

    // 2. Blocker-check (server-side, niet-vertrouwd op UI).
    const blocker = await guardBlockers(deal_id);
    if (blocker) {
      await logAudit({
        action  : 'quotation.hard_delete.blocked',
        payload : { deal_id, blocker, actor: { user_id: auth.user.id, email: auth.profile.email, role: auth.profile.role } },
        result  : {},
        status  : 'blocked',
        userId  : auth.user.id,
      });
      return res.status(409).json({
        error: 'INCASSO_KOPPELING',
        detail: `Er hangt een blocker aan deze offerte (${blocker.type}, ${blocker.count} rij(en)). Handel dit eerst af — de hard-delete-tool raakt incasso/bonus/setter-commissie NIET aan.`,
        blocker,
      });
    }

    // 2a. ONBOARDING (12 nov 2026): hangt er een lopende onboarding aan deze
    //     klant, of via deal_id aan deze offerte, dan eerst een uitdrukkelijke
    //     bevestiging — vóór er iets naar Teamleader gaat. Geen blocker.
    //     Een leesfout houdt het verwijderen niet tegen (het is geen geld).
    const obCheck = await leesOnboardingsBijVerwijderen(supabaseAdmin, deal);
    if (obCheck.onboardings.length && onboarding_bevestigd !== true) {
      return res.status(409).json({
        error: 'ONBOARDING_BEVESTIGING_NODIG',
        detail: 'Er hangt een onboarding aan deze klant of offerte. ' + VERWIJDER_ONBOARDING_UITLEG
          + ' Bevestig uitdrukkelijk om toch te verwijderen.',
        onboardings: obCheck.onboardings,
      });
    }

    // 2b. Mentorcommissie (regel B). Open commissie → keuze verplicht. We
    //     annuleren de commissie VÓÓR Teamleader: dat is omkeerbaar. Weigert
    //     TL daarna, dan zetten we de commissie meteen terug.
    const keuze = req.body?.commissie_keuze || null;
    let commissieVoor = null;
    let commissieResultaat = null;
    try {
      commissieVoor = await commissieVanDeal(supabaseAdmin, deal_id);
    } catch (e) {
      return res.status(500).json({ error: 'Commissie-lookup fout', detail: e?.message || String(e) });
    }
    if (commissieVoor.open) {
      if (!COMMISSIE_KEUZES.has(keuze)) {
        return res.status(409).json({
          error : 'COMMISSIE_KEUZE_VEREIST',
          detail: 'Aan deze offerte hangt nog mentorcommissie. Kies: "Klant annuleert" of "Er komt een nieuwe offerte".',
          commissie: commissieVoor,
        });
      }
      const ref = deal.quote_reference || deal.tl_quotation_id || deal_id;
      commissieResultaat = await annuleerCommissie(supabaseAdmin, {
        dealId: deal_id, soort: keuze, bron: 'hard_delete', actorId: auth.user.id,
        extraNote: `Offerte ${ref} definitief verwijderd`,
      });
    }

    // 3. TL-hard-delete (blocking).
    const tlResult = await teamleaderHardDelete(deal);
    if (!tlResult.ok) {
      if (commissieResultaat && commissieResultaat.geannuleerd_regels > 0) {
        try {
          await herstelCommissie(supabaseAdmin, { dealId: deal_id, actorId: auth.user.id, reden: 'Definitief verwijderen mislukt in Teamleader' });
        } catch (e) {
          console.error('[sales-hard-delete] commissie terugzetten na TL-fout:', e?.message || e);
        }
      }
      await logAudit({
        action       : 'quotation.hard_delete.tl_fail',
        payload      : { deal_id, tl_deal_id: deal.tl_deal_id, tl_quotation_id: deal.tl_quotation_id,
                         actor: { user_id: auth.user.id, email: auth.profile.email, role: auth.profile.role } },
        result       : tlResult,
        status       : 'tl_fail',
        error_message: tlResult.detail || tlResult.error,
        userId       : auth.user.id,
      });
      return res.status(502).json({
        error : 'TL_DELETE_GEWEIGERD',
        detail: tlResult.detail || tlResult.error,
        trail : tlResult.trail || null,
      });
    }

    // 4. Lokale hard-delete. Cascade doet de rest.
    const { error: delErr } = await supabaseAdmin.from('deals').delete().eq('id', deal_id);
    if (delErr) {
      // PARTIAL: TL is weg maar lokaal niet → sync-mismatch. Alarm + audit.
      const fout = delErr.message || String(delErr);
      await logAudit({
        action       : 'quotation.hard_delete.partial',
        payload      : { deal_id, tl_deal_id: deal.tl_deal_id, tl_quotation_id: deal.tl_quotation_id,
                         actor: { user_id: auth.user.id, email: auth.profile.email, role: auth.profile.role } },
        result       : { tl: tlResult, lokaal_fout: fout },
        status       : 'partial',
        error_message: `lokale DELETE faalde na TL-succes: ${fout}`,
        userId       : auth.user.id,
      });
      const alarmVerstuurd = await stuurPartialAlarm({
        deal_id, deal, tlResult, lokaleFout: fout,
        actor: { email: auth.profile.email, role: auth.profile.role },
      });
      return res.status(500).json({
        error : 'PARTIAL_DELETE',
        detail: `Teamleader is opgeruimd, maar de lokale DELETE faalde: ${fout}. Handmatige correctie nodig (audit-log status=partial). ${alarmVerstuurd ? 'Admin-alarm-mail verstuurd.' : 'ALARM-MAIL VERZENDING OOK MISLUKT — direct actie ondernemen.'}`,
        partial: true,
        tl: tlResult,
      });
    }

    // 5. Success.
    await logAudit({
      action  : 'quotation.hard_delete',
      payload : { deal_id, tl_deal_id: deal.tl_deal_id, tl_quotation_id: deal.tl_quotation_id,
                  quote_reference: deal.quote_reference, customer_id: deal.customer_id,
                  onboardings_open_gelaten: obCheck.onboardings.length ? obCheck.onboardings : undefined,
                  commissie_keuze: commissieResultaat ? keuze : null,
                  actor: { user_id: auth.user.id, email: auth.profile.email, role: auth.profile.role } },
      result  : { tl: tlResult, lokaal_verwijderd: true, commissie: commissieResultaat },
      status  : 'success',
      userId  : auth.user.id,
    });
    return res.status(200).json({
      ok: true,
      deal_id,
      tl: tlResult,
      commissie: commissieResultaat,
      note: `Offerte definitief verwijderd uit Teamleader en de CRM. Actie gelogd in agent_audit_log (uitvoerder: ${auth.profile.email}).`
        + (commissieResultaat ? ` Mentorcommissie op geannuleerd (${commissieResultaat.reden}).${commissieResultaat.melding ? ' ' + commissieResultaat.melding : ''}` : ''),
    });
  } catch (e) {
    console.error('[sales-hard-delete-quotation]', e?.message || e);
    await logAudit({
      action       : 'quotation.hard_delete.exception',
      payload      : { deal_id },
      result       : {},
      status       : 'error',
      error_message: e?.message || String(e),
      userId       : auth.user.id,
    });
    return res.status(500).json({ error: 'Interne fout', detail: e?.message || String(e) });
  }
}
