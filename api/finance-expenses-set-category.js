// api/finance-expenses-set-category.js
// POST → losse categorie-override op ÉÉN transactie (source='manual').
// Voor uitzonderingen binnen een tegenpartij: bv. 1 Meta-uitgave is
// eigenlijk 'Reis & verblijf' i.p.v. het counterparty-brede
// 'Marketing & advertenties'.
// Permission: finance.expenses.category.edit.
//
// Body:
//   { camt_transaction_id: uuid,
//     category_id: uuid | null }  // null → verwijder categorisatie
//                                    (val terug op counterparty-rule als die
//                                     bestaat — via 1 nieuwe UPSERT bij
//                                     volgende auto-categorize; voor nu:
//                                     delete = leeg)
//
// Response:
//   { action: 'created'|'updated'|'deleted', category_id }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.expenses.category.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.expenses.category.edit)' });
  }

  const { camt_transaction_id, category_id } = req.body || {};
  if (!camt_transaction_id || !/^[0-9a-f-]{36}$/i.test(camt_transaction_id)) {
    return res.status(400).json({ error: 'camt_transaction_id vereist (UUID)' });
  }
  if (category_id !== null && (typeof category_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(category_id))) {
    return res.status(400).json({ error: 'category_id moet UUID zijn of null' });
  }

  try {
    // Valideer tx bestaat.
    const { data: tx, error: txErr } = await supabaseAdmin
      .from('camt_transactions').select('id').eq('id', camt_transaction_id).maybeSingle();
    if (txErr) throw new Error('tx check: ' + txErr.message);
    if (!tx) return res.status(404).json({ error: 'Onbekende camt_transaction_id' });

    // Fetch bestaande categorisatie (indien).
    const { data: existing } = await supabaseAdmin
      .from('transaction_categorizations')
      .select('id, category_id, source')
      .eq('camt_transaction_id', camt_transaction_id)
      .maybeSingle();

    if (category_id === null) {
      // ── Verwijder pad ──
      if (existing) {
        const { error: delErr } = await supabaseAdmin
          .from('transaction_categorizations').delete().eq('id', existing.id);
        if (delErr) throw new Error('cat delete: ' + delErr.message);
      }
      return res.status(200).json({ action: 'deleted', category_id: null });
    }

    // Valideer category bestaat.
    const { data: cat, error: catErr } = await supabaseAdmin
      .from('expense_categories').select('id').eq('id', category_id).maybeSingle();
    if (catErr) throw new Error('category check: ' + catErr.message);
    if (!cat) return res.status(400).json({ error: 'Onbekende category_id' });

    // UPSERT (UNIQUE op camt_transaction_id → conflict update).
    const { error: upsErr } = await supabaseAdmin
      .from('transaction_categorizations')
      .upsert({
        camt_transaction_id,
        category_id,
        source: 'manual',
        rule_id: null,             // manual override zet rule-link uit
        set_by_user_id: user.id,
        set_at: new Date().toISOString(),
      }, { onConflict: 'camt_transaction_id' });
    if (upsErr) throw new Error('cat upsert: ' + upsErr.message);

    return res.status(200).json({
      action: existing ? 'updated' : 'created',
      category_id,
    });
  } catch (e) {
    console.error('[finance-expenses-set-category]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
