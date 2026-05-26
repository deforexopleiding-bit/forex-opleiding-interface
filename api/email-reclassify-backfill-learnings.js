// /api/email-reclassify-backfill-learnings
// Eenmalige retroactieve conversie: email_messages die gereclassificeerd zijn
// op 2026-05-22 worden via applyLearning() omgezet naar learn_examples +
// email_patterns leerdata (Fase email-classifier-fix commit 4).
//
// Reden: het oude reclassify-endpoint schreef alleen email_messages, niet
// learn_examples/email_patterns. Resultaat: ~2100 historische correcties
// hadden geen invloed op de classifier. Vanaf commit 3 doet reclassify wel
// learn-calls, maar de historische set moet handmatig nagereden worden.
//
// Methods:
//   GET    ?preview=true  → aggregatie-rapport (geen DB-writes)
//   POST   body { execute: true, offset?, limit? }
//                          → chunked uitvoer van applyLearning per
//                            unieke (sender_email, category)-pair
//
// Auth: verifyAdmin (super_admin/admin/manager).
//
// Aggregatie-strategie:
//   - SELECT email_messages WHERE category_reason ILIKE '%MARKER%'
//   - JS-side groupBy op (from_address, category) → ~100-300 unieke pairs
//     (i.p.v. 2100 redundante calls)
//   - Per pair: één representative mail (eerste/oudste) levert subject+snippet
//   - applyLearning is idempotent door confidence-cap (geen schade bij rerun)
//
// Idempotent: zelfde sender+category opnieuw aanroepen = no-op via
//   confidence-cap (100) in applyLearning. Marker reason='backfill-2026-05-26'
//   onderscheidt deze entries van live Train Agent + reclassify input.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { applyLearning } from './_lib/email-learn.js';

const SOURCE_MARKER = 'reclassify-2026-05-22';      // marker in category_reason
const BACKFILL_REASON = 'backfill-2026-05-26';     // marker voor learn_examples.reason
const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }

  if (req.method === 'GET')  return handlePreview(req, res);
  if (req.method === 'POST') return handleExecute(req, res);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}

// ── GET — Preview/aggregatie-rapport (geen DB-writes) ────────────────────────

async function handlePreview(req, res) {
  try {
    const pairs = await fetchAndGroupPairs();
    const totalRecords = pairs.reduce((sum, p) => sum + p.count, 0);

    // Aggregatie per category
    const byCategory = {};
    for (const p of pairs) {
      byCategory[p.category] = (byCategory[p.category] || 0) + p.count;
    }

    // Top senders (top 10 by count)
    const topSenders = [...pairs]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((p) => ({
        sender: p.from_address,
        category: p.category,
        count: p.count,
      }));

    return res.status(200).json({
      mode: 'preview',
      source_marker: SOURCE_MARKER,
      total_records: totalRecords,
      unique_pairs: pairs.length,
      by_category: byCategory,
      top_senders: topSenders,
      note: 'Geen DB-writes uitgevoerd. POST met body { execute: true } om backfill te starten (chunked).',
    });
  } catch (err) {
    console.error('[backfill-learnings] preview error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── POST — Chunked execute (DB-writes via applyLearning) ─────────────────────

async function handleExecute(req, res) {
  const body = req.body || {};
  const execute = body.execute === true;
  if (!execute) {
    return res.status(400).json({
      error: 'Veiligheidscheck: stuur expliciet { execute: true } in body om backfill uit te voeren.',
    });
  }

  const offset = Math.max(0, parseInt(body.offset, 10) || 0);
  const rawLimit = parseInt(body.limit, 10) || DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));

  try {
    const pairs = await fetchAndGroupPairs();
    const total = pairs.length;
    const slice = pairs.slice(offset, offset + limit);
    const done = (offset + slice.length) >= total;

    let succeeded = 0;
    let failed = 0;
    const failures = [];

    for (const p of slice) {
      try {
        await applyLearning({
          supabase:        supabaseAdmin,
          email_id:        p.representative_id ? String(p.representative_id) : null,
          sender:          p.from_address,
          subject:         p.representative_subject || '(backfill)',
          body_snippet:    p.representative_snippet || '',
          old_category:    null, // origineel is overschreven door reclassify op 2026-05-22
          new_category:    p.category,
          corrected_by:    'backfill',
          correction_type: 'bulk_reclassify',
          reason:          BACKFILL_REASON,
          email_list:      [], // bulk = geen propagatie nodig
        });
        succeeded++;
      } catch (err) {
        console.warn(`[backfill-learnings] applyLearning fout voor ${p.from_address} → ${p.category}:`, err.message);
        failed++;
        failures.push({ sender: p.from_address, category: p.category, error: err.message });
      }
    }

    const remainingOffset = done ? null : (offset + slice.length);

    return res.status(200).json({
      mode:               'execute',
      offset,
      limit,
      processed:          slice.length,
      total_pairs:        total,
      succeeded,
      failed,
      failures:           failures.slice(0, 20), // cap voor response-size
      remaining_offset:   remainingOffset,
      done,
      note: done
        ? 'Backfill compleet.'
        : `Roep opnieuw aan met offset=${remainingOffset} voor volgende chunk.`,
    });
  } catch (err) {
    console.error('[backfill-learnings] execute error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch alle email_messages met de SOURCE_MARKER en groepeer JS-side
 * op (from_address, category). Returnt array van { from_address, category,
 * count, representative_id, representative_subject, representative_snippet }.
 *
 * NB: PostgREST heeft geen native GROUP BY, dus we fetchen alle matches
 * en groeperen client-side. Voor 2100 records is dit een paar honderd kB,
 * geen issue.
 */
async function fetchAndGroupPairs() {
  // Fetch in chunks van 1000 (Supabase default limit) tot we alles hebben.
  // Voor 2100 records = 3 chunks.
  const allRows = [];
  const CHUNK = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('email_messages')
      .select('id, from_address, category, subject, snippet, date_received')
      .ilike('category_reason', `%${SOURCE_MARKER}%`)
      .order('date_received', { ascending: true })
      .range(from, from + CHUNK - 1);
    if (error) throw new Error('fetch markers: ' + error.message);
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < CHUNK) break;
    from += CHUNK;
  }

  // Groepeer
  const map = new Map();
  for (const row of allRows) {
    const fromAddress = (row.from_address || '').trim().toLowerCase();
    const category = row.category;
    if (!fromAddress || !category) continue;
    const key = `${fromAddress}::${category}`;
    if (!map.has(key)) {
      // Eerste row is representative (oudste, want sort ASC)
      map.set(key, {
        from_address:           fromAddress,
        category,
        count:                  1,
        representative_id:      row.id,
        representative_subject: row.subject || '',
        representative_snippet: row.snippet || '',
      });
    } else {
      map.get(key).count++;
    }
  }

  return [...map.values()];
}
