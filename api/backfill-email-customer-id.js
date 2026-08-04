// api/backfill-email-customer-id.js
//
// POST — backfill customer_id op email_messages-rijen die momenteel NULL zijn.
// Loopt door alle NULL-rijen in batches, gebruikt DEZELFDE match-logica als
// sync-emails.js (case-insensitief + deterministische tie-breaker via
// api/_lib/email-customer-match.js). Werkt vooruit met een offset-cursor;
// stopt bij eind van de tabel of bij bereiken van `max_batches`.
//
// AUTH: super_admin only (RBAC-permissie '*' via ensurePermissionsLoaded).
//       Backfill kan enorme aantallen mails aanraken en is niet-idempotent
//       in de zin dat de "gekozen candidate" bij ambiguity een aanname is —
//       daarom bewust achter super_admin.
//
// NIET-AUTOMATISCH: dit endpoint is BEWUST geen cron. Jeffrey triggert
// handmatig na een dry-run-inspectie.
//
// ── Request-body ────────────────────────────────────────────────────
// {
//   dry_run:     boolean (default true) — false schrijft daadwerkelijk
//   mailbox:     string? — 'administratie'|'onboarding'|'events'|'leads'|'info'|'partners'
//                          (null = alle mailboxen)
//   batch_size:  int (default 500, cap 1000)  — mails per batch
//   max_batches: int (default 5, cap 100)     — hoeveel batches per invocation
//                                                (Vercel 60s-guard: bij ambigue set
//                                                 kunnen 2 extra queries per batch nodig zijn)
//   cursor:      int (default 0) — start-offset in de NULL-rijen (voor multi-call)
// }
//
// ── Response 200 ────────────────────────────────────────────────────
// dry_run=true:
//   {
//     ok: true, dry_run: true, mailbox, batches_scanned, mails_scanned,
//     would_update_count, still_null_count,
//     by_customer: [                       // top 30 klanten die de meeste mails krijgen
//       { customer_id, email_hint, would_add: N }
//     ],
//     unresolved_top_addresses: [          // top 30 from-adressen die NIET matchen
//       { from_address, mail_count }
//     ],
//     next_cursor: int | null              // null = klaar
//   }
// dry_run=false:
//   {
//     ok: true, dry_run: false, mailbox, batches_scanned, mails_scanned,
//     updated_count, still_null_count,
//     by_customer: [ ... top 30 ],
//     next_cursor: int | null
//   }
//
// Failure (200 met warning): partial batches processed + warning-veld.
// 403: geen super_admin. 405: geen POST.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { resolveCustomerIdsForEmails } from './_lib/email-customer-match.js';

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE     = 1000;
const DEFAULT_MAX_BATCHES = 5;
const MAX_MAX_BATCHES     = 100;
const KNOWN_MAILBOXES     = new Set(['administratie', 'onboarding', 'events', 'leads', 'info', 'partners']);

async function isSuperAdmin(req) {
  try {
    const supabase = createUserClient(req);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', user.id)
      .maybeSingle();
    return !!(profile && profile.is_active && profile.role === 'super_admin');
  } catch (_) {
    return false;
  }
}

// Fetch één batch NULL-rijen. Retour: {rows: [{id, from_address}], nextCursor}.
// Cursor is een offset in de "email_messages WHERE customer_id IS NULL"-set.
// Bij offset-paginatie kan een concurrent update tijdens de run overlappen
// veroorzaken, maar dat is safe: elke mail wordt geüpdatet naar dezelfde
// customer_id door dezelfde helper (idempotent).
async function fetchNullBatch(mailbox, offset, size) {
  let q = supabaseAdmin
    .from('email_messages')
    .select('id, from_address', { count: 'exact' })
    .is('customer_id', null)
    .order('id', { ascending: true })
    .range(offset, offset + size - 1);
  if (mailbox) q = q.eq('mailbox', mailbox);
  const { data, error, count } = await q;
  if (error) throw new Error(`batch fetch fail: ${error.message}`);
  return { rows: data || [], totalNull: count || 0 };
}

// Voer één batch door de matcher, groepeer per resolved customer_id.
async function processBatch(rows) {
  const addrs = rows.map((r) => r.from_address).filter(Boolean);
  const idByAddr = await resolveCustomerIdsForEmails(supabaseAdmin, addrs);
  // Voor elke rij: bepaal target customer_id (of null).
  const updates = []; // [{ id, customer_id }]
  const perCustomer = new Map(); // customer_id -> { count, email_hint }
  const unresolved = new Map();  // from_address -> count
  for (const r of rows) {
    const key = String(r.from_address || '').trim().toLowerCase();
    const cid = key ? idByAddr.get(key) : null;
    if (cid) {
      updates.push({ id: r.id, customer_id: cid });
      const cur = perCustomer.get(cid) || { count: 0, email_hint: key };
      cur.count += 1;
      perCustomer.set(cid, cur);
    } else if (key) {
      unresolved.set(key, (unresolved.get(key) || 0) + 1);
    }
  }
  return { updates, perCustomer, unresolved };
}

// Batch-update via kleine PATCH-chunks (max 100 rijen per call om URL-limits
// te respecteren). Retour: aantal succesvolle updates.
async function persistUpdates(updates) {
  if (updates.length === 0) return 0;
  const CHUNK = 100;
  let ok = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    // Groepeer per customer_id → 1 UPDATE per unique target (efficiënter dan
    // per rij een UPDATE, en atomisch op DB-laag).
    const byCid = new Map();
    for (const u of chunk) {
      if (!byCid.has(u.customer_id)) byCid.set(u.customer_id, []);
      byCid.get(u.customer_id).push(u.id);
    }
    for (const [cid, ids] of byCid) {
      const { error, count } = await supabaseAdmin
        .from('email_messages')
        .update({ customer_id: cid }, { count: 'exact' })
        .in('id', ids)
        .is('customer_id', null); // safety: alleen NULL overschrijven
      if (error) {
        console.warn('[backfill-email-customer-id] update chunk fail:', error.message);
        continue;
      }
      ok += count || 0;
    }
  }
  return ok;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  if (!(await isSuperAdmin(req))) {
    return res.status(403).json({ error: 'super_admin vereist' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const dryRun     = body.dry_run !== false; // default TRUE
  const mailboxRaw = typeof body.mailbox === 'string' ? body.mailbox.trim().toLowerCase() : null;
  const mailbox    = mailboxRaw && KNOWN_MAILBOXES.has(mailboxRaw) ? mailboxRaw : null;
  if (mailboxRaw && !mailbox) {
    return res.status(400).json({ error: `mailbox moet ${[...KNOWN_MAILBOXES].join('|')} zijn` });
  }
  const batchSize  = Math.min(MAX_BATCH_SIZE, Math.max(50, parseInt(body.batch_size || DEFAULT_BATCH_SIZE, 10) || DEFAULT_BATCH_SIZE));
  const maxBatches = Math.min(MAX_MAX_BATCHES, Math.max(1, parseInt(body.max_batches || DEFAULT_MAX_BATCHES, 10) || DEFAULT_MAX_BATCHES));
  const startCursor = Math.max(0, parseInt(body.cursor || 0, 10) || 0);

  const perCustomerTotal = new Map();
  const unresolvedTotal  = new Map();
  let mailsScanned  = 0;
  let updatedCount  = 0;
  let wouldUpdateCount = 0;
  let batchesScanned = 0;
  let cursor = startCursor;
  let lastTotalNull = null;
  let warning = null;

  try {
    for (let i = 0; i < maxBatches; i++) {
      const { rows, totalNull } = await fetchNullBatch(mailbox, cursor, batchSize);
      lastTotalNull = totalNull;
      if (rows.length === 0) break;
      batchesScanned += 1;
      mailsScanned   += rows.length;

      const { updates, perCustomer, unresolved } = await processBatch(rows);

      // Aggregeer over batches heen.
      for (const [cid, agg] of perCustomer) {
        const cur = perCustomerTotal.get(cid) || { count: 0, email_hint: agg.email_hint };
        cur.count += agg.count;
        perCustomerTotal.set(cid, cur);
      }
      for (const [addr, n] of unresolved) {
        unresolvedTotal.set(addr, (unresolvedTotal.get(addr) || 0) + n);
      }

      if (dryRun) {
        wouldUpdateCount += updates.length;
        // Bij dry-run advanceren we de cursor met batchSize (want we hebben
        // NIETS gemuteerd, dus NULL-rijen blijven staan en offset moet mee).
        cursor += rows.length;
      } else {
        const persisted = await persistUpdates(updates);
        updatedCount += persisted;
        // Bij live-run schuiven NULL-rijen naar links (updates zijn er niet
        // meer). Cursor NIET advanceren want de "restant NULL"-set is nu
        // kleiner — de volgende range(0, batchSize) pakt de volgende N.
        cursor = 0;
      }

      if (rows.length < batchSize) break; // klaar met scannen
    }
  } catch (e) {
    warning = e?.message || String(e);
    console.error('[backfill-email-customer-id] fatal:', warning);
  }

  const byCustomerTop = [...perCustomerTotal.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 30)
    .map(([customer_id, v]) => ({
      customer_id,
      email_hint: v.email_hint,
      [dryRun ? 'would_add' : 'added']: v.count,
    }));
  const unresolvedTop = [...unresolvedTotal.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([from_address, mail_count]) => ({ from_address, mail_count }));

  // next_cursor: null als we niks meer te scannen hebben, anders volgende
  // startpunt zodat caller kan resumen met multi-invocation.
  const stillNull = Math.max(0, (lastTotalNull || 0) - (dryRun ? 0 : updatedCount));
  const nextCursor = (batchesScanned === 0 || stillNull === 0)
    ? null
    : (dryRun ? cursor : 0);

  return res.status(200).json({
    ok: !warning,
    dry_run: dryRun,
    mailbox: mailbox || 'alle',
    batches_scanned: batchesScanned,
    mails_scanned:   mailsScanned,
    ...(dryRun ? { would_update_count: wouldUpdateCount } : { updated_count: updatedCount }),
    still_null_count: stillNull,
    by_customer: byCustomerTop,
    unresolved_top_addresses: unresolvedTop,
    next_cursor: nextCursor,
    ...(warning ? { warning } : {}),
  });
}
