// POST /api/dunning-test-edit-customer
//
// In-place edit van een test-klant in de cockpit. Twee onafhankelijke
// aspecten:
//   1. CONTACT-ONLY (naam / phone / email): update customers, laat runs +
//      facturen ongemoeid.
//   2. FACTUUR-EDIT (invoices meegegeven): teardown run-state +
//      upsert facturen naar de gewenste set (verwijderde weg, gewijzigde
//      bijwerken, nieuwe insert). NIET naar Teamleader.
//
// Body:
//   {
//     customer_id: uuid,
//     name?:  string,
//     phone?: string,
//     email?: string,
//     invoices?: [{ invoice_id?: uuid, amount: number, days_overdue: number }],
//   }
//
// start_ladder_step is BEWUST NIET onderdeel van dit endpoint. De UI moet
// ná de edit de bestaande fast-forward-knop/endpoint (met to_day) apart
// aanroepen. Redenen: (1) geen stille parameter die niets doet;
// (2) endpoint blijft focused op contact/facturen; (3) fast-forward is al
// beschikbaar via wanbetalers-sandbox-fast-forward.
//
// HARDE GRENDEL (fail-closed, VOOR elke write):
//   - customer.is_test !== true → throw + 400. Nul writes.
//   - Bij invoices-edit: elke bestaande invoice.invoice_id die we aanraken
//     wordt gecheckt op is_test=true EN customer_id=<gegeven>. Bij twijfel
//     → throw + 400. Nul writes.
//
// GEEN send-side-effects. Nooit een bericht triggeren.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import { teardownRunStateForCustomer } from './_lib/dunning-test-teardown-customer.js';

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function shortId() { return Math.random().toString(16).slice(2, 10); }

async function audit({ actor, target, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'edit_customer',
      scope:        'test',
      target: target || {}, payload: payload || {}, result: result || {},
      status, error_message: error || null,
    });
  } catch (e) { console.error('[dunning-test-edit-customer] audit fail:', e?.message || e); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;
  const actor = { userId: admin.user.id, email: admin.profile.email };

  const body = req.body || {};
  const customerId = body.customer_id;
  const newName    = body.name  !== undefined ? String(body.name).trim() : undefined;
  const newPhone   = body.phone !== undefined ? String(body.phone).trim() : undefined;
  const newEmail   = body.email !== undefined ? String(body.email).trim() : undefined;
  const invoicesRequested = Array.isArray(body.invoices) ? body.invoices : null;
  // start_ladder_step is bewust uit het contract — zie header-comment.

  if (!customerId) return res.status(400).json({ error: 'customer_id is verplicht.' });

  // ── HARDE GRENDEL 1: is_test-guard op customer ────────────────────────
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers').select('id, is_test, first_name, last_name, phone, email')
    .eq('id', customerId).maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!cust) return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (cust.is_test !== true) {
    await audit({ actor, target: { customer_id: customerId }, status: 'error', error: 'non-test customer' });
    return res.status(400).json({ error: 'Customer is geen is_test-klant. Weigering — nul writes.' });
  }

  // ── HARDE GRENDEL 2: bij invoices-edit → check bestaande factuur-IDs ──
  let existingInvoicesById = new Map();
  if (invoicesRequested) {
    const { data: existing, error: eErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, is_test, invoice_number, amount_total, amount_paid, due_date, test_metadata')
      .eq('customer_id', customerId).eq('is_test', true);
    if (eErr) return res.status(500).json({ error: 'invoices fetch: ' + eErr.message });
    for (const inv of (existing || [])) existingInvoicesById.set(inv.id, inv);

    // Elke door caller genoemde invoice_id moet in de is_test-set van deze
    // customer zitten. Onbekend id = tripwire.
    for (const [i, iv] of invoicesRequested.entries()) {
      if (iv?.invoice_id) {
        const known = existingInvoicesById.get(iv.invoice_id);
        if (!known) {
          const msg = `invoices[${i}].invoice_id '${iv.invoice_id}' hoort niet bij deze is_test-customer.`;
          await audit({ actor, target: { customer_id: customerId }, payload: { i, invoice_id: iv.invoice_id }, status: 'error', error: msg });
          return res.status(400).json({ error: msg + ' Weigering — nul writes.' });
        }
      }
      if (!Number.isFinite(Number(iv?.amount)) || Number(iv.amount) <= 0) {
        return res.status(400).json({ error: `invoices[${i}].amount ongeldig.` });
      }
      if (!Number.isFinite(Number(iv?.days_overdue)) || Number(iv.days_overdue) < 0) {
        return res.status(400).json({ error: `invoices[${i}].days_overdue ongeldig.` });
      }
    }
  }

  // ── 1. Contact-only wijziging ─────────────────────────────────────────
  const contactPatch = {};
  if (newName !== undefined && newName) {
    // Split naam simpel op eerste spatie; behoud TEST-prefix in first_name als aanwezig.
    const parts = newName.split(/\s+/);
    const firstIn = parts[0] || '';
    const lastIn  = parts.slice(1).join(' ');
    const prefix = (cust.first_name || '').startsWith('🧪 TEST — ') ? '🧪 TEST — ' : '';
    contactPatch.first_name = prefix + firstIn.replace(/^🧪 TEST — /, '');
    contactPatch.last_name  = lastIn;
  }
  if (newPhone !== undefined) contactPatch.phone = newPhone || null;
  if (newEmail !== undefined) contactPatch.email = newEmail || null;

  let contactChanged = false;
  if (Object.keys(contactPatch).length > 0) {
    const { error: uErr } = await supabaseAdmin
      .from('customers').update(contactPatch)
      .eq('id', customerId).eq('is_test', true);   // ← 2e is_test-guard in de UPDATE zelf
    if (uErr) {
      await audit({ actor, target: { customer_id: customerId }, payload: { contact_fields: Object.keys(contactPatch) }, status: 'error', error: uErr.message });
      return res.status(500).json({ error: 'contact update: ' + uErr.message });
    }
    contactChanged = true;
  }

  // ── 2. Factuur-wijziging (alleen als invoices meegegeven) ────────────
  const result = { contact_changed: contactChanged };

  if (invoicesRequested) {
    // 2a. Teardown alle run-state (helper heeft eigen is_test-tripwire).
    const teardown = await teardownRunStateForCustomer(customerId, { supabaseAdmin });
    result.teardown_counts = teardown.counts;

    // 2b. Upsert facturen naar de gewenste set.
    const requestedIds = new Set(invoicesRequested.map(iv => iv.invoice_id).filter(Boolean));
    const toDelete = Array.from(existingInvoicesById.values()).filter(x => !requestedIds.has(x.id));
    const toUpdate = invoicesRequested.filter(iv => iv.invoice_id);
    const toInsert = invoicesRequested.filter(iv => !iv.invoice_id);

    // DELETE
    let deletedCount = 0;
    if (toDelete.length > 0) {
      const delIds = toDelete.map(x => x.id);
      const { data, error } = await supabaseAdmin
        .from('invoices').delete()
        .in('id', delIds).eq('is_test', true).eq('customer_id', customerId)   // ← triple-guard
        .select('id');
      if (error) return res.status(500).json({ error: 'invoices delete: ' + error.message });
      deletedCount = (data || []).length;
    }
    // UPDATE
    let updatedCount = 0;
    for (const iv of toUpdate) {
      const known = existingInvoicesById.get(iv.invoice_id);
      const meta = { ...(known?.test_metadata || {}) };
      meta.edited_at = new Date().toISOString();
      meta.edited_by = actor.email;
      meta.days_overdue = Number(iv.days_overdue);
      const { error } = await supabaseAdmin
        .from('invoices').update({
          amount_total:  Number(iv.amount),
          due_date:      isoDaysAgo(iv.days_overdue),
          test_metadata: meta,
        })
        .eq('id', iv.invoice_id).eq('is_test', true).eq('customer_id', customerId);
      if (error) return res.status(500).json({ error: `invoices update (${iv.invoice_id}): ` + error.message });
      updatedCount++;
    }
    // INSERT
    let insertedCount = 0;
    if (toInsert.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const rows = toInsert.map(iv => ({
        customer_id:    customerId,
        invoice_number: 'TEST-' + shortId(),
        amount_total:   Number(iv.amount),
        amount_paid:    0,
        status:         'open',
        issue_date:     today,
        due_date:       isoDaysAgo(iv.days_overdue),
        is_test:        true,
        test_metadata: {
          created_via: 'edit',
          days_overdue_at_creation: Number(iv.days_overdue),
          created_by: actor.email,
        },
      }));
      const { data, error } = await supabaseAdmin.from('invoices').insert(rows).select('id');
      if (error) return res.status(500).json({ error: 'invoices insert: ' + error.message });
      insertedCount = (data || []).length;
    }
    result.invoices = {
      requested: invoicesRequested.length,
      deleted:   deletedCount,
      updated:   updatedCount,
      inserted:  insertedCount,
    };

    // 2c. Re-seed = engine draaien. Cockpit-scenario's roepen zelf engine
    //     na customer/invoice-create; we volgen datzelfde patroon zodat
    //     runs deterministisch worden opgezet zonder dubbele seed-logica.
    //     runEngine respecteert dunning_dry_run.enabled (default TRUE) —
    //     step-executors checken isDryRunEnabled() vóór elke echte send
    //     (dunning-step-executors.js:179 email, :524 whatsapp), dus deze
    //     edit-flow kan nooit per ongeluk echt versturen.
    //     Fail-soft: als engine faalt komt de melding in de result;
    //     de edit-endpoint retourneert 200 want data-writes zijn al gedaan.
    try {
      const { runEngine } = await import('./_lib/dunning-engine.js');
      const engineSummary = await runEngine({ mode: 'manual', scope: 'test' });
      result.engine = { ok: true, summary_keys: Object.keys(engineSummary || {}) };
    } catch (e) {
      result.engine = { ok: false, error: e?.message || String(e) };
    }
  }

  await audit({
    actor,
    target: { customer_id: customerId },
    payload: {
      contact_fields: Object.keys(contactPatch),
      invoices_present: !!invoicesRequested,
    },
    result,
    status: 'ok',
  });

  return res.status(200).json({ ok: true, ...result });
}
