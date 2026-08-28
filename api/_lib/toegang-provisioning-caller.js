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
//   { email, voornaam, soort }   ('7-daagse' | 'minicursus')
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
        email:    lead.email,
        voornaam: lead.voornaam || null,
        soort:    lead.soort,
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
