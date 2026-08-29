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

const PROVISIONING_TIMEOUT_MS = 8000;

/**
 * @param {{ email:string, voornaam:string|null, soort:'7-daagse'|'minicursus' }} lead
 * @returns {Promise<{ ok:boolean, status?:number, error?:string, body?:any }>}
 */
export async function belProvisioning(lead) {
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
