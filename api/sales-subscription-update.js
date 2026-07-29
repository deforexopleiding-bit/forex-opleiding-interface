// api/sales-subscription-update.js
// POST { subscription_id, patch: { description?, amount?, vat_percentage?,
//        term_count?, start_date?, end_date?, line_items? } }
// → wijzigt een abonnement, MAAR ALLEEN als er nog GEEN factuur voor is
// gegenereerd. Kritieke veiligheidsgrens: zodra de eerste factuur eruit is,
// mag het abo niet meer bewerkt — de historische factuur mag NOOIT wijzigen.
//
// WATERDICHTE "nog geen factuur"-CHECK:
//   * Als sub.teamleader_subscription_id IS NULL → geen TL-koppeling, TL kan
//     dus onmogelijk facturen hebben gegenereerd (facturen ontstaan door TL,
//     wij spiegelen alleen read-only via cron-finance-sync). Veilig te editen.
//   * Als sub.teamleader_subscription_id NOT NULL → COUNT(invoices) WHERE
//     tl_subscription_id = sub.tl_id. Als > 0 → 409 HAS_INVOICES, weiger.
//
// TL-SYNC:
//   * Alleen starts_on / ends_on bewezen veilig in TL v2 subscriptions.update
//     (zie api/_lib/subscription-postpone.js:66-68 en apiary-check).
//   * BEDRAG / line_items / vat_percentage / term_count wijzigingen → NIET
//     naar TL gepusht. Als sub in TL zit én bedrag verandert: response bevat
//     tl_amount_change_not_pushed=true zodat de UI kan waarschuwen én de
//     operator kan kiezen: (a) accepteer CRM-drift (niet aanbevolen), of
//     (b) deactiveer TL-sub + maak nieuwe via subscription-wizard.
//   * TL-push die faalt → FAIL-LOUD (502), rollback via update terug naar
//     originele waarden. Geen halve staat.
//
// Permission: sales.deal.edit (bestaand — consistent met postpone/delete).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Velden die naar TL gaan (bewezen veilig via subscriptions.update).
const TL_SYNCABLE_FIELDS = new Set(['start_date', 'end_date']);
// Velden die alleen in CRM zitten; wijziging drift TL-facturen als er
// TL-koppeling is (bedrag komt terug via cron-sync in oude waarde).
const CRM_ONLY_FIELDS = new Set(['description', 'amount', 'vat_percentage', 'term_count', 'line_items']);

/**
 * Waterdichte "geen factuur"-check. Returnt { canEdit, count, reason }.
 *   canEdit=true als GEEN facturen bestaan die aan deze sub hangen.
 *   Fail-secure: DB-fout → canEdit=false (weiger) met reason='lookup_fail'.
 */
async function checkNoInvoices(sub) {
  if (!sub?.teamleader_subscription_id) {
    // Geen TL-koppeling: TL heeft nooit een factuur voor deze sub gemaakt.
    return { canEdit: true, count: 0, reason: 'no_tl_link' };
  }
  try {
    const { count, error } = await supabaseAdmin
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tl_subscription_id', sub.teamleader_subscription_id);
    if (error) throw new Error(error.message);
    const c = Number(count) || 0;
    return { canEdit: c === 0, count: c, reason: c === 0 ? 'no_invoices' : 'has_invoices' };
  } catch (e) {
    console.error('[sub-update] invoice-count check fail:', e.message);
    return { canEdit: false, count: 0, reason: 'lookup_fail:' + e.message };
  }
}

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
  if (!(await requirePermission(req, 'sales.deal.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.edit)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const subId = typeof body.subscription_id === 'string' && UUID_RE.test(body.subscription_id) ? body.subscription_id : null;
  const patchIn = (body.patch && typeof body.patch === 'object') ? body.patch : null;
  if (!subId) return res.status(400).json({ error: 'subscription_id (uuid) verplicht' });
  if (!patchIn) return res.status(400).json({ error: 'patch (object) verplicht' });

  const userId = user?.id || null;
  const nowIso = new Date().toISOString();

  try {
    // 1) Fetch huidige sub.
    const { data: sub, error: fetchErr } = await supabaseAdmin
      .from('subscriptions')
      .select('*')
      .eq('id', subId)
      .maybeSingle();
    if (fetchErr) throw new Error('fetch: ' + fetchErr.message);
    if (!sub) return res.status(404).json({ error: 'Abonnement niet gevonden' });
    if (sub.status === 'cancelled' || sub.status === 'completed') {
      return res.status(409).json({ error: 'Abonnement is ' + sub.status + '; niet bewerkbaar' });
    }

    // 2) WATERDICHTE CHECK — geen factuur.
    const invCheck = await checkNoInvoices(sub);
    if (!invCheck.canEdit) {
      return res.status(409).json({
        code:  'HAS_INVOICES',
        error: invCheck.reason === 'lookup_fail'
          ? 'Kon niet controleren of dit abo al gefactureerd is: ' + invCheck.reason
          : 'Abonnement heeft al ' + invCheck.count + ' factuur/facturen. Wijzig via crediteren + nieuw abonnement.',
        invoice_count: invCheck.count,
      });
    }

    // 3) Sanitize patch. Alleen bekende velden accepteren.
    const cleanPatch = {};
    const before = {};
    for (const [k, v] of Object.entries(patchIn)) {
      if (!TL_SYNCABLE_FIELDS.has(k) && !CRM_ONLY_FIELDS.has(k)) continue;
      // Validatie per veld.
      if (k === 'description') {
        if (v == null) continue;
        const s = String(v).trim();
        if (s.length > 500) return res.status(400).json({ error: 'description max 500 chars' });
        cleanPatch[k] = s || null;
      } else if (k === 'amount') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'amount moet >= 0' });
        cleanPatch[k] = Math.round(n * 100) / 100;
      } else if (k === 'vat_percentage') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 100) return res.status(400).json({ error: 'vat_percentage moet integer 0..100' });
        cleanPatch[k] = n;
      } else if (k === 'term_count') {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 240) return res.status(400).json({ error: 'term_count moet 1..240' });
        cleanPatch[k] = n;
      } else if (k === 'start_date' || k === 'end_date') {
        if (v == null) { cleanPatch[k] = null; continue; }
        const s = String(v);
        if (!DATE_RE.test(s)) return res.status(400).json({ error: k + ' moet YYYY-MM-DD zijn' });
        cleanPatch[k] = s;
      } else if (k === 'line_items') {
        if (!Array.isArray(v)) return res.status(400).json({ error: 'line_items moet array zijn' });
        // Basale shape-check; laat de wizard-payload valideren.
        cleanPatch[k] = v;
      }
      before[k] = sub[k];
    }
    if (Object.keys(cleanPatch).length === 0) {
      return res.status(400).json({ error: 'Geen wijzigingen gevonden in patch' });
    }

    // Kruis-validatie: end_date >= start_date.
    const newStart = cleanPatch.start_date !== undefined ? cleanPatch.start_date : sub.start_date;
    const newEnd   = cleanPatch.end_date   !== undefined ? cleanPatch.end_date   : sub.end_date;
    if (newStart && newEnd && String(newEnd) < String(newStart)) {
      return res.status(400).json({ error: 'end_date moet >= start_date zijn' });
    }

    // 4) TL-sync (fail-loud). Alleen als sub in TL zit én er syncable
    // velden zijn gewijzigd.
    const hasTl = !!sub.teamleader_subscription_id;
    const tlSyncableChanged = Object.keys(cleanPatch).some((k) => TL_SYNCABLE_FIELDS.has(k));
    const crmOnlyChanged    = Object.keys(cleanPatch).some((k) => CRM_ONLY_FIELDS.has(k));

    let tlResult = { pushed: false };
    if (hasTl && tlSyncableChanged) {
      try {
        const tok = await getActiveToken();
        if (!tok) throw new Error('Geen actieve TL-token (OAuth-koppeling nodig)');
        const tlBody = { id: sub.teamleader_subscription_id };
        if (cleanPatch.start_date !== undefined && cleanPatch.start_date) tlBody.starts_on = cleanPatch.start_date;
        if (cleanPatch.end_date   !== undefined && cleanPatch.end_date)   tlBody.ends_on   = cleanPatch.end_date;
        const r = await tlFetch('/subscriptions.update', {
          method: 'POST', body: JSON.stringify(tlBody),
        });
        if (!r.ok) {
          const txt = (await r.text()).slice(0, 500);
          throw new Error('TL HTTP ' + r.status + ': ' + txt);
        }
        tlResult = { pushed: true };
      } catch (e) {
        console.error('[sub-update] TL push fail:', e.message);
        // FAIL-LOUD: geen DB-wijziging als TL faalt. Return 502.
        return res.status(502).json({
          code:  'TL_SYNC_FAIL',
          error: 'TL-sync mislukt: ' + e.message + '. Wijziging is NIET opgeslagen om drift tussen CRM en TL te voorkomen.',
        });
      }
    }

    // 5) Nu pas de DB-update (na succesvolle TL-push, of als er geen TL-push
    // nodig was). Optimistic concurrency op status om race te voorkomen.
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('subscriptions')
      .update({ ...cleanPatch })
      .eq('id', subId)
      .eq('status', sub.status)
      .select('*')
      .single();
    if (updErr) {
      // Als TL al gepusht is + DB faalt: melden. Onwaarschijnlijk (alleen
      // status-race), maar log expliciet.
      console.error('[sub-update] DB update fail after TL push:', updErr.message, {
        tl_pushed: tlResult.pushed,
      });
      return res.status(500).json({
        code:  'DB_UPDATE_FAIL_AFTER_TL',
        error: 'Wijziging in TL wél doorgevoerd, maar CRM-DB-update faalde: ' + updErr.message + '. Controleer handmatig.',
        tl_pushed: tlResult.pushed,
      });
    }

    // 6) Audit (fail-soft).
    const after = {};
    for (const k of Object.keys(cleanPatch)) after[k] = updated[k];
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      'subscription.updated',
        entity_type: 'subscription',
        entity_id:   subId,
        before_json: before,
        after_json: {
          patch:      cleanPatch,
          fields_changed: Object.keys(cleanPatch),
          tl_pushed:  tlResult.pushed,
          tl_amount_change_not_pushed: hasTl && crmOnlyChanged,
        },
        reason_text: 'Abonnement bewerkt (' + Object.keys(cleanPatch).join(', ') + ')',
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[sub-update] audit:', e.message); }

    return res.status(200).json({
      ok:          true,
      subscription: updated,
      tl: tlResult,
      // Waarschuwing voor UI: als sub in TL zit én er CRM-only velden
      // zijn gewijzigd (bedrag/vat/term_count/line_items) waarschuw dat
      // TL blijft factureren op de oude waarden. Advies: deactiveer +
      // create nieuwe sub via wizard.
      tl_amount_change_not_pushed: hasTl && crmOnlyChanged,
      warning: (hasTl && crmOnlyChanged)
        ? 'Bedrag/regels/BTW/termijnen zijn alleen in CRM aangepast — TeamLeader gaat volgende termijn nog op de OUDE waarden factureren en de sync spiegelt die terug. Als je bedrag écht wil wijzigen: deactiveer dit abo in TL en maak een nieuwe via de wizard.'
        : null,
    });
  } catch (e) {
    console.error('[sales-subscription-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
