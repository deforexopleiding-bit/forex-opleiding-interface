// api/onboarding-wizard-get.js
//
// PUBLIEK read-only GET. Input: ?t=<token (uuid)>.
// Geen createUserClient — de student is niet ingelogd. Token = auth.
//
// Onbekend/ongeldig token → 404 met generieke shape (geen enumeratie-leak).
//
// Privacy:
//   - GEEN email, telefoon, last_name in de response. Alleen first_name
//     voor "Hoi, X"-tekst in de wizard-UI.
//   - Token zelf wordt niet teruggegeven (caller heeft 'm al in de URL).
//   - file_download-blokken krijgen SIGNED URLs (TTL ~3600s) op basis van
//     het storage-pad; rauwe paths verlaten de server nooit.
//
// Response 200:
//   {
//     customer_first_name : string|null,
//     status              : 'aangemeld'|'bezig'|'afgerond'|'gearchiveerd',
//     current_step        : int|null,
//     answers             : object (jsonb; key→value),
//     pages               : [...]   // gepubliceerde wizard-structuur,
//                                   //  met file_download.files[] = {name,url}
//   }

import { supabaseAdmin } from './supabase.js';
import { DEFAULT_WIZARD_STRUCTURE } from './_lib/onboarding-wizard-default.js';

const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_BUCKET = 'onboarding-files';
const SIGNED_TTL_S   = 3600;

// Wrappt alle file_download-blokken: vervangt files[] { path, name } door
// { name, url } met een per-pad signed URL. Bij ontbrekende of falende
// signed URL wordt het bestand uit de lijst gedropt — UI toont dan een
// empty-state. Geen rauwe paths in de response.
async function attachSignedFileUrls(pages) {
  const out = JSON.parse(JSON.stringify(pages || []));
  const tasks = [];
  for (const page of out) {
    for (const b of (page?.blocks || [])) {
      if (!b || b.type !== 'file_download' || !Array.isArray(b.files)) continue;
      const signedFiles = [];
      for (const f of b.files) {
        if (!f || typeof f.path !== 'string' || !f.path) continue;
        tasks.push(
          (async () => {
            try {
              const { data: signed, error } = await supabaseAdmin
                .storage
                .from(STORAGE_BUCKET)
                .createSignedUrl(f.path, SIGNED_TTL_S);
              if (error) {
                console.warn('[onboarding-wizard-get] signed url:', f.path, error.message);
                return;
              }
              if (signed?.signedUrl) {
                signedFiles.push({
                  name: f.name || f.path.split('/').pop() || 'download',
                  url : signed.signedUrl,
                });
              }
            } catch (e) {
              console.warn('[onboarding-wizard-get] signed url exception:', f.path, e?.message || e);
            }
          })()
        );
      }
      // Vervang files[] door de output van bovenstaande tasks (geresolved
      // ná Promise.allSettled hieronder). signedFiles is een gedeelde
      // referentie die door de tasks wordt gevuld.
      b.files = signedFiles;
    }
  }
  await Promise.allSettled(tasks);
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const token = req.query?.t ? String(req.query.t).trim() : null;
  if (!token || !UUID_RE.test(token)) {
    // 400 is bewust: ongeldig formaat lekt geen bestaan/-niet-bestaan.
    return res.status(400).json({ error: 'Link niet geldig.' });
  }

  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, status, current_step, answers')
      .eq('token', token)
      .maybeSingle();
    if (obErr) {
      console.error('[onboarding-wizard-get] onboarding lookup:', obErr.message);
      return res.status(500).json({ error: 'Kon link niet ophalen.' });
    }
    if (!ob) {
      // Generieke 404; geen onderscheid tussen "bestaat niet" en "expired".
      return res.status(404).json({ error: 'Link niet geldig.' });
    }

    // First_name ophalen — minimale PII; geen overige customer-velden.
    let firstName = null;
    if (ob.customer_id) {
      const { data: cust, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('first_name')
        .eq('id', ob.customer_id)
        .maybeSingle();
      if (custErr) {
        console.error('[onboarding-wizard-get] customer lookup:', custErr.message);
      } else {
        firstName = cust?.first_name || null;
      }
    }

    // Wizard-structuur: gepubliceerde versie wint, met fallback op default.
    // Lees fail-soft — bij DB-glitch valt 'ie terug op de hardcoded default.
    let publishedPages = null;
    try {
      const { data: wiz, error: wizErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('published_structure')
        .eq('id', 1)
        .maybeSingle();
      if (wizErr) {
        console.warn('[onboarding-wizard-get] wizard config fetch:', wizErr.message);
      } else if (wiz?.published_structure?.pages) {
        publishedPages = wiz.published_structure.pages;
      }
    } catch (e) {
      console.warn('[onboarding-wizard-get] wizard config exception:', e?.message || e);
    }
    const pagesIn = publishedPages || DEFAULT_WIZARD_STRUCTURE.pages;

    // Signed URLs voor file_download.files[]. Mutatie is op een diepe kopie
    // zodat we het in-memory default-object niet vervuilen tussen requests.
    const pagesOut = await attachSignedFileUrls(pagesIn);

    return res.status(200).json({
      customer_first_name : firstName,
      status              : ob.status,
      current_step        : (ob.current_step == null) ? null : Number(ob.current_step),
      answers             : (ob.answers && typeof ob.answers === 'object') ? ob.answers : {},
      pages               : pagesOut,
    });
  } catch (e) {
    console.error('[onboarding-wizard-get] fatal:', e?.message || e);
    return res.status(500).json({ error: 'Kon link niet ophalen.' });
  }
}
