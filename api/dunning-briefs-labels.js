// api/dunning-briefs-labels.js
//
// POST { brief_ids: [uuid, ...] } → PDF met adreslabels voor de labelprinter
// (rol 4×6 inch = 288 × 432 pt, zie api/_lib/adreslabels-pdf.js), 3 adressen per
// label, in EXACT dezelfde volgorde als de PDF-bundel van
// /api/dunning-briefs-bulk-print voor dezelfde input (gedeelde helper
// api/_lib/dunning-briefs-selectie.js).
//
// PUUR LEZEN: geen statuswijziging (downloaded_at / sent_at blijven), geen mail,
// geen dunning_log-regel.
//
// Overslaan = wat de bundel overslaat: brieven zonder pdf_path of waarvan de PDF
// niet in storage staat (één createSignedUrls-call als bestaanscheck; lukt die
// call zelf niet, dan nemen we aan dat de PDF's er zijn). Ook een brief zonder
// klant valt weg.
//
// Adres = exact het adresblok van de brief (gedeelde helper
// api/_lib/brief-adres.js), met de HUIDIGE klantgegevens en het land waarmee de
// brief gemaakt is (dunning_briefs.country); enige verschil: land in HOOFDLETTERS.
//
// Response:  200 application/pdf, inline, filename "Adreslabels brieven DD-MM-YYYY.pdf"
//            X-Labels-Count: <N>   X-Labels-Skipped: <N>
// Errors:    400 MISSING_BRIEF_IDS / TOO_MANY / INVALID_UUID
//            404 NO_BRIEFS_FOUND / NO_LABELS
// Permission: finance.incasso.manage (zelfde als de bundel).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { leesBriefIds, laadGeordendeBrieven } from './_lib/dunning-briefs-selectie.js';
import { labelAdresRegels } from './_lib/brief-adres.js';
import { maakAdreslabelsPdf } from './_lib/adreslabels-pdf.js';

const BUCKET = 'dunning-briefs';

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json(body);
}

// DD-MM-YYYY in Nederlandse tijd.
export function datumNL(d = new Date()) {
  const p = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(d).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return `${p.day}-${p.month}-${p.year}`;
}

// Welke pdf_paths staan echt in storage? null = niet te bepalen (dan niets uitsluiten).
async function bestaandePaden(paths) {
  if (!paths.length) return new Set();
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrls(paths, 60);
    if (error || !Array.isArray(data)) {
      console.warn('[dunning-briefs-labels] bestaanscheck faalde (niets uitgesloten):', error?.message);
      return null;
    }
    return new Set(data.filter((d) => d && !d.error && d.path).map((d) => d.path));
  } catch (e) {
    console.warn('[dunning-briefs-labels] bestaanscheck exception (niets uitgesloten):', e?.message || e);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json(res, 401, { error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return json(res, 403, { error: 'Geen rechten (finance.incasso.manage)' });
  }

  const sel = leesBriefIds(req.body, { maxLabel: 'labelbestand' });
  if (!sel.ok) return json(res, sel.status, { error: sel.error, code: sel.code });

  try {
    const ordered = await laadGeordendeBrieven(supabaseAdmin, sel.ids, 'id, customer_id, country, pdf_path');
    if (ordered.length === 0) {
      return json(res, 404, { error: 'Geen brieven gevonden voor de opgegeven IDs', code: 'NO_BRIEFS_FOUND' });
    }

    const metPdf = ordered.filter((r) => r.pdf_path);
    const bestaand = await bestaandePaden(metPdf.map((r) => r.pdf_path));
    const inBundel = bestaand ? metPdf.filter((r) => bestaand.has(r.pdf_path)) : metPdf;

    const custIds = Array.from(new Set(inBundel.map((r) => r.customer_id).filter(Boolean)));
    const custById = new Map();
    if (custIds.length) {
      const { data: custs, error: cErr } = await supabaseAdmin
        .from('customers')
        .select('id, first_name, last_name, company_name, is_company, address_street, address_number, address_postal, address_city, address_country')
        .in('id', custIds);
      if (cErr) throw new Error('customers select failed: ' + cErr.message);
      for (const c of custs || []) custById.set(c.id, c);
    }

    const adressen = [];
    const skippedIds = ordered.filter((r) => !inBundel.includes(r)).map((r) => r.id);
    for (const r of inBundel) {
      const cust = custById.get(r.customer_id);
      if (!cust) { skippedIds.push(r.id); continue; }
      adressen.push(labelAdresRegels(cust, r.country));
    }
    if (adressen.length === 0) {
      return json(res, 404, { error: 'Geen enkele brief heeft een printbare PDF of klant.', code: 'NO_LABELS', skipped_ids: skippedIds });
    }

    const datum = datumNL();
    const filename = `Adreslabels brieven ${datum}.pdf`;
    const bytes = await maakAdreslabelsPdf(adressen, { titel: `Adreslabels brieven ${datum}` });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('X-Labels-Count', String(adressen.length));
    res.setHeader('X-Labels-Skipped', String(skippedIds.length));
    return res.status(200).send(Buffer.from(bytes));
  } catch (e) {
    console.error('[dunning-briefs-labels]', e?.message || e);
    return json(res, 500, { error: e?.message || 'Interne fout' });
  }
}
