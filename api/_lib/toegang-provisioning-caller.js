// api/_lib/toegang-provisioning-caller.js
//
// Helper voor DEEL D — roept dfo-website's provisioning-endpoint aan
// nadat een lead op WhatsApp heeft gereageerd. Server-to-server met een
// gedeeld secret (zelfde patroon als INTERNE_WELKOM_SECRET). Fail-soft:
// gooit nooit, retourneert { ok, status, error } zodat caller de idempotency
// (provisioned_at) kan zetten en één retry-loop kan draaien.
//
// Env:
//   TOEGANG_PROVISIONING_URL     bv. https://deforexopleiding.nl/api/interne-welkom
//   TOEGANG_PROVISIONING_SECRET  gedeeld secret (Sensitive, gelijk aan
//                                dezelfde var op dfo-website)
//
// Body naar dfo-website:
//   { email, voornaam, soort, force_login_mail: true }
//     soort            '7-daagse' | 'minicursus'
//     force_login_mail v=2 (2026-08-29): expliciete opdracht aan dfo-website
//                      om ALTIJD een verse inloglink (maakInloglink) + de
//                      'toelating'-mail te sturen, óók als het account al
//                      bestaat. Reden: sommige leads komen met een
//                      partners@/al-bekend adres door de gate, en de oude
//                      "alleen bij nieuw account"-guard aan dfo-website-kant
//                      skipt de mail dan → lead strandt zonder inlog.
//                      De 1×-per-aanvraag-garantie zit al aan CRM-kant via
//                      toegang_aanvragen.provisioned_at (guard in
//                      follow-up-ghl-conversation-webhook + inbox-webhook).
//                      Dfo-website moet deze flag respecteren; bij ontbreken
//                      van implementatie negeert dfo-website 'em stil
//                      (backward-compat) — dan blijft de oude bug.
//
// Verwachte response:
//   200 { ok:true, ... }         provisioning geslaagd (of idempotent al-gedaan)
//   4xx/5xx                       fail — CRM retryt niet automatisch; komt in
//                                 provisioned_error terecht + admin ziet 'em
//                                 in de Toegang-aanvragen-tab

// 2026-09-15 — verhoogd van 8000 naar 20000. De dfo-website provisioning-
// cascade (Bubble LMS + Strato SMTP + Webflow member-invite) is regelmatig
// 8-12s; op 8s brachten legitieme succesvolle calls het niet en belandden
// leads op status='gereageerd' + provisioned_error='timeout' zonder
// automatische retry. 20s past ruim binnen Vercel's 30s webhook-limit én
// binnen de cron-tick van 2 minuten. Retry-branch in cron-toegang-aanvragen.js
// vangt alsnog restanten op mocht 't 20s ook overschrijden.
import { supabaseAdmin } from '../supabase.js';
import { productUitBron, leesBestemming } from './trial-product.js';

const PROVISIONING_TIMEOUT_MS = 20000;

// ── 26 okt 2026: "Eén login voor alle funnels" ──────────────────────────────
// Staat de schakelaar voor dit product op 'lab' (standaard, app_settings
// 'trial_bestemming'), dan provisionen we NIET meer in het oude trial-LMS via
// dfo-website, maar maken we een lab-lead in het echte LMS (lab-trial.js).
// Zelfde antwoordvorm, dus de drie aanroepers (inbox-webhook, GHL-webhook,
// cron-toegang-aanvragen) en hun provisioned_at-guard blijven ongewijzigd.

/** De aanvraag-rij erbij (bron, telefoon). Fail-soft: null. */
async function leesAanvraag(id) {
  if (!id) return null;
  const { data, error } = await supabaseAdmin.from('toegang_aanvragen')
    .select('id, voornaam, email, telefoon, soort, bron').eq('id', id).maybeSingle();
  if (error) console.warn('[toegang-provisioning-caller] aanvraag lezen (soft):', error.message);
  return data || null;
}

async function provisionLab(lead, aanvraag) {
  // Lazy: de Lab-keten (LMS, mail, WhatsApp) alleen laden als ze nodig is.
  const { geefLabTrial } = await import('./lab-trial.js');
  const r = await geefLabTrial({
    email: lead.email, voornaam: lead.voornaam || aanvraag?.voornaam || null,
    telefoon: aanvraag?.telefoon || lead.telefoon || null,
    bron: aanvraag?.bron || lead.bron || null, soort: lead.soort,
    toegangAanvraagId: aanvraag?.id || lead.aanvraagId || null,
    waAlBevestigd: true,
  });
  const body = { ok: r.ok, bestemming: 'lab', product: r.product, resultaat: r.resultaat, mail_sent: r.mail_status === 'verstuurd', aanmelding_id: r.aanmeldingId };
  if (!r.ok) return { ok: false, status: 502, error: 'lab: ' + (r.fout || 'lms_fout'), body };
  return { ok: true, status: 200, body };
}

/**
 * @param {{ email:string, voornaam:string|null, soort:'7-daagse'|'minicursus', aanvraagId?:string, bron?:string }} lead
 *   aanvraagId = toegang_aanvragen.id (voor bron/telefoon en één trial per aanvraag)
 * @returns {Promise<{ ok:boolean, status?:number, error?:string, body?:any }>}
 */
export async function belProvisioning(lead) {
  if (lead?.email && lead?.soort) {
    const aanvraag = await leesAanvraag(lead.aanvraagId);
    const product = productUitBron(aanvraag?.bron || lead.bron, lead.soort);
    if (await leesBestemming(supabaseAdmin, product) === 'lab') {
      try { return await provisionLab(lead, aanvraag); } catch (e) {
        console.error('[toegang-provisioning-caller] lab-provisioning exception:', e?.message || e);
        return { ok: false, error: 'lab: ' + (e?.message || String(e)) };
      }
    }
  }
  const url    = process.env.TOEGANG_PROVISIONING_URL;
  const secret = process.env.TOEGANG_PROVISIONING_SECRET;
  if (!url || !secret) {
    return { ok: false, error: 'TOEGANG_PROVISIONING_URL/SECRET ontbreekt in env' };
  }
  if (!lead?.email || !lead?.soort) {
    return { ok: false, error: 'email + soort vereist' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROVISIONING_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-internal-token': secret,
      },
      body: JSON.stringify({
        email:            lead.email,
        voornaam:         lead.voornaam || null,
        soort:            lead.soort,
        force_login_mail: true,   // v=2: altijd verse inloglink (zie header)
      }),
      signal: ctrl.signal,
    });
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    if (!r.ok) {
      const errText = body?.error || `HTTP ${r.status}`;
      console.error('[toegang-provisioning-caller]', r.status, errText);
      return { ok: false, status: r.status, error: errText, body };
    }
    return { ok: true, status: r.status, body };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e));
    console.error('[toegang-provisioning-caller] exception:', msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
