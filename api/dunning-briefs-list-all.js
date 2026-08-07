// api/dunning-briefs-list-all.js
//
// GET → lijst van ALLE dunning_briefs (platform-breed) met klant-naam,
// status-derivation en filter. Voor de overzichtspagina in
// Wanbetalers → Instellingen → Brieven.
//
// Verschil met dunning-briefs-list.js:
//   - dunning-briefs-list.js         → 1 klant OF 1 brief (voor case-sheet)
//   - dunning-briefs-list-all.js     → alle brieven (multi-klant), voor
//                                       overzichts-tabel met bulk-select
//
// Query:
//   ?status=all|aangemaakt|gedownload|verstuurd   default: all
//   ?limit=<int>                                   default: 200, max: 500
//   ?search=<string>                               free-text over klant-naam
//
// Response 200:
//   {
//     items: [{
//       id, customer_id, customer_name,
//       template_code, country,
//       generated_at, generated_by_user_id, generated_by_name?,
//       sent_via, sent_at, sent_to_email,
//       downloaded_at, downloaded_by,
//       pdf_size_bytes,
//       download_url,        // signed URL 1 uur (voor per-stuk download)
//       status               // 'aangemaakt' | 'gedownload' | 'verstuurd'
//     }],
//     count,
//     counts: { all, aangemaakt, gedownload, verstuurd }
//   }
//
// Permission: finance.dunning.view (lezen genoeg).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const BUCKET = 'dunning-briefs';
const SIGNED_URL_TTL_SECONDS = 3600;
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

function statusOf(r) {
  if (r.sent_at)       return 'verstuurd';
  if (r.downloaded_at) return 'gedownload';
  return 'aangemaakt';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const q = req.query || {};
  const statusRaw = typeof q.status === 'string' ? q.status.trim().toLowerCase() : 'all';
  const status = ['all', 'aangemaakt', 'gedownload', 'verstuurd'].includes(statusRaw) ? statusRaw : 'all';
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  const search = typeof q.search === 'string' ? q.search.trim().toLowerCase() : '';

  try {
    // 1) Alle brieven ophalen (server-side status-filter kan niet direct op
    // afgeleide veld; we filteren in JS na fetch). Order op nieuwste-eerst.
    // Voor tellingen halen we vóór limit alle rows op — bij >MAX_LIMIT
    // knippen we af (uiterst zeldzaam: 500+ brieven aan één stuk in overzicht
    // is niet realistisch, dan filter je verder).
    const { data: rows, error } = await supabaseAdmin
      .from('dunning_briefs')
      .select('id, customer_id, invoice_id, template_code, country, pdf_path, pdf_size_bytes, generated_at, generated_by_user_id, sent_via, sent_at, sent_to_email, sent_by_user_id, send_error, downloaded_at, downloaded_by')
      .order('generated_at', { ascending: false })
      .limit(MAX_LIMIT);
    if (error) throw new Error(error.message);

    const allRows = rows || [];

    // 2) Klant-namen join (1 query voor alle unieke customer_ids).
    const custIds = Array.from(new Set(allRows.map((r) => r.customer_id).filter(Boolean)));
    let custById = new Map();
    if (custIds.length > 0) {
      const { data: custs } = await supabaseAdmin
        .from('customers')
        .select('id, first_name, last_name, company_name, is_company, email')
        .in('id', custIds);
      for (const c of (custs || [])) custById.set(c.id, c);
    }

    // 3) Aanmakers-namen join (fail-soft).
    const userIds = Array.from(new Set(allRows.map((r) => r.generated_by_user_id).filter(Boolean)));
    let userById = new Map();
    if (userIds.length > 0) {
      try {
        const { data: profs } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name, email')
          .in('id', userIds);
        for (const p of (profs || [])) userById.set(p.id, p);
      } catch (_) { /* fail-soft, name blijft null */ }
    }

    // 4) Counts platform-breed (vóór search-filter — bij status-pill toont
    // gebruiker altijd het totaal per status).
    const counts = { all: allRows.length, aangemaakt: 0, gedownload: 0, verstuurd: 0 };
    for (const r of allRows) counts[statusOf(r)]++;

    // 5) Filter → search + status.
    let filtered = allRows;
    if (status !== 'all') filtered = filtered.filter((r) => statusOf(r) === status);
    if (search) {
      filtered = filtered.filter((r) => {
        const c = custById.get(r.customer_id);
        const name = c ? customerDisplayName(c, '').toLowerCase() : '';
        const email = (c?.email || '').toLowerCase();
        return name.includes(search) || email.includes(search);
      });
    }

    // 6) Signed URLs per rij (na filter — geen wasted work voor rows die uitvallen).
    const capped = filtered.slice(0, limit);
    const items = [];
    for (const r of capped) {
      const c = custById.get(r.customer_id);
      const customerName = c ? customerDisplayName(c, '(onbekend)') : '(onbekend)';

      let downloadUrl = null;
      try {
        const { data: signed } = await supabaseAdmin.storage
          .from(BUCKET)
          .createSignedUrl(r.pdf_path, SIGNED_URL_TTL_SECONDS);
        if (signed?.signedUrl) downloadUrl = signed.signedUrl;
      } catch (_) { /* fail-soft */ }

      const u = r.generated_by_user_id ? userById.get(r.generated_by_user_id) : null;
      items.push({
        id                : r.id,
        customer_id       : r.customer_id,
        customer_name     : customerName,
        template_code     : r.template_code,
        country           : r.country,
        generated_at      : r.generated_at,
        generated_by_user_id : r.generated_by_user_id,
        generated_by_name : u ? (u.full_name || u.email || null) : null,
        sent_via          : r.sent_via,
        sent_at           : r.sent_at,
        sent_to_email     : r.sent_to_email,
        downloaded_at     : r.downloaded_at,
        downloaded_by     : r.downloaded_by,
        pdf_size_bytes    : r.pdf_size_bytes,
        download_url      : downloadUrl,
        status            : statusOf(r),
      });
    }

    // 7) Adres-gap-signalen: klanten waarvoor de engine de auto-WIK-brief
    // oversloeg wegens onvolledig adres én waarvoor nog géén brief bestaat (dus
    // nog onopgelost). Voedt de waarschuwingsbanner in het Brieven-overzicht,
    // zodat het team het adres kan aanvullen. Volledig fail-soft.
    let addressGapSignals = [];
    try {
      const { data: skipLogs } = await supabaseAdmin
        .from('dunning_log')
        .select('run_id, payload, created_at')
        .eq('event_type', 'brief_auto_skipped_no_address')
        .order('created_at', { ascending: false })
        .limit(500);
      const gapRunIds = Array.from(new Set((skipLogs || []).map((l) => l.run_id).filter(Boolean)));
      // Opgelost = er bestaat inmiddels een brief voor die run.
      const resolvedRuns = new Set();
      if (gapRunIds.length > 0) {
        const { data: briefsForRuns } = await supabaseAdmin
          .from('dunning_briefs').select('run_id').in('run_id', gapRunIds);
        for (const b of (briefsForRuns || [])) if (b.run_id) resolvedRuns.add(b.run_id);
      }
      // Run → customer (voor naam + dossierlink).
      const runCustomer = new Map();
      if (gapRunIds.length > 0) {
        const { data: runsRows } = await supabaseAdmin
          .from('dunning_workflow_runs').select('id, customer_id').in('id', gapRunIds);
        for (const r of (runsRows || [])) runCustomer.set(r.id, r.customer_id);
      }
      // Klant-namen die nog niet in custById zitten alsnog laden.
      const gapCustIds = Array.from(new Set(Array.from(runCustomer.values()).filter(Boolean)));
      const missingCustIds = gapCustIds.filter((id) => !custById.has(id));
      if (missingCustIds.length > 0) {
        const { data: gapCusts } = await supabaseAdmin
          .from('customers').select('id, first_name, last_name, company_name, is_company, email').in('id', missingCustIds);
        for (const c of (gapCusts || [])) custById.set(c.id, c);
      }
      const seenRun = new Set();
      for (const l of (skipLogs || [])) {
        if (!l.run_id || seenRun.has(l.run_id)) continue; // desc-order → latest per run wint
        seenRun.add(l.run_id);
        if (resolvedRuns.has(l.run_id)) continue;         // brief bestaat inmiddels → opgelost
        const custId = runCustomer.get(l.run_id) || null;
        const c = custId ? custById.get(custId) : null;
        addressGapSignals.push({
          run_id        : l.run_id,
          customer_id   : custId,
          customer_name : c ? customerDisplayName(c, '(onbekend)') : '(onbekend)',
          missing_fields: Array.isArray(l.payload?.missing_fields) ? l.payload.missing_fields : [],
          at            : l.created_at,
        });
      }
    } catch (e) {
      console.warn('[dunning-briefs-list-all] address_gap_signals fail-soft:', e?.message || e);
    }

    return res.status(200).json({
      items,
      count: items.length,
      total_before_search: filtered.length,
      capped: filtered.length > capped.length,
      counts,
      address_gap_signals: addressGapSignals,
    });
  } catch (e) {
    console.error('[dunning-briefs-list-all]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
