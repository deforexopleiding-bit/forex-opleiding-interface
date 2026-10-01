// Welkomstbevestiging voor een (handmatig toegevoegde) lead.
//
// Kanaal-abstractie: nu alleen 'email' (hergebruikt de dfo-website welkom-mail
// via de interne endpoint /api/interne-welkom-mail met gedeeld secret). De
// WhatsApp-haak staat klaar voor later (wacht op het Meta-template): voeg
// 'whatsapp' toe aan `kanalen` en implementeer stuurWhatsappWelkom.
//
// ALLES fail-soft: een verzendfout mag de lead-opslag nooit breken — deze
// functies gooien nooit; ze retourneren een resultaat-object en loggen fouten.
//
// Env (CRM):
//   INTERNE_WELKOM_URL     volledige URL van de dfo-endpoint (/api/interne-welkom-mail)
//   INTERNE_WELKOM_SECRET  gedeeld secret; moet gelijk zijn aan die op dfo-website

const WELKOM_TIMEOUT_MS = 4500; // een trage dfo-kant mag de response niet ophouden

// LET OP `soort`: dfo-website /api/interne-welkom-mail kiest daarmee het
// mail-sjabloon (minicursus vs 7-daagse), MAAR doet bij een bekende soort óók
// geefProductToegang() — een upsert die het toegangsvenster van dat product op
// [nu, nu + duur_dagen] zet. Wie alleen een mail wil, moet dat venster dus zelf
// bewaken (zie lead-welkom-resend.js). Zonder soort: 7-daagse-sjabloon, geen grant.
async function stuurEmailWelkom({ email, voornaam, soort = null, timeoutMs = WELKOM_TIMEOUT_MS }) {
  const url = process.env.INTERNE_WELKOM_URL;
  const secret = process.env.INTERNE_WELKOM_SECRET;
  if (!url || !secret) {
    console.warn('[welkom] e-mail overgeslagen: INTERNE_WELKOM_URL/INTERNE_WELKOM_SECRET ontbreekt');
    return { kanaal: 'email', ok: false, reden: 'niet-geconfigureerd' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const payload = { email, voornaam };
    if (soort) payload.soort = soort;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': secret },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const tekst = await r.text().catch(() => '');
      console.error('[welkom] e-mail mislukt:', r.status, tekst.slice(0, 200));
      let fout = null;
      try { const j = JSON.parse(tekst); fout = j?.fout || j?.error || null; } catch (_) { /* geen json */ }
      return { kanaal: 'email', ok: false, status: r.status, ...(fout ? { reden: String(fout).slice(0, 120) } : {}) };
    }
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return {
      kanaal: 'email', ok: true,
      ...(body?.traject_gebruikt ? { traject: body.traject_gebruikt } : {}),
    };
  } catch (e) {
    const timeout = e?.name === 'AbortError';
    console.error('[welkom] e-mail exception:', timeout ? 'timeout' : (e?.message || e));
    return { kanaal: 'email', ok: false, ...(timeout ? { reden: 'timeout' } : {}), error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lees de uitkomst van stuurWelkom() voor één kanaal. stuurWelkom geeft een
 * ARRAY terug (één resultaat per kanaal) — `resultaten.ok` bestaat dus niet;
 * daar ging lead-toegang-verlenen op stuk (toast meldde altijd "MISLUKT").
 * @param {Array<{kanaal:string, ok:boolean}>|object|null} resultaten
 * @returns {{ ok: boolean, reden: string|null, resultaat: object|null }}
 */
export function welkomUitkomst(resultaten, kanaal = 'email') {
  const lijst = Array.isArray(resultaten) ? resultaten : (resultaten ? [resultaten] : []);
  const r = lijst.find((x) => x && x.kanaal === kanaal) || null;
  if (!r) return { ok: false, reden: 'geen-resultaat', resultaat: null };
  if (r.ok === true) return { ok: true, reden: null, resultaat: r };
  const reden = r.reden || (r.status ? 'HTTP ' + r.status : null) || r.error || 'onbekend';
  return { ok: false, reden: String(reden), resultaat: r };
}

// Placeholder voor later — geen WhatsApp tot het Meta-template rond is.
// async function stuurWhatsappWelkom({ email, voornaam, telefoon }) { ... }

/**
 * Stuur een welkomstbevestiging over de gevraagde kanalen. Gooit NOOIT (fail-soft).
 * @param {{ email: string, voornaam?: string|null, telefoon?: string|null, kanalen?: string[],
 *           soort?: '7-daagse'|'minicursus'|null, timeoutMs?: number }} opts
 * @returns {Promise<Array<{kanaal:string, ok:boolean}>>}  — gebruik welkomUitkomst() om te lezen
 */
export async function stuurWelkom({ email, voornaam = null, telefoon = null, kanalen = ['email'], soort = null, timeoutMs }) {
  const resultaten = [];
  for (const kanaal of kanalen) {
    try {
      if (kanaal === 'email') {
        resultaten.push(await stuurEmailWelkom({ email, voornaam, soort, ...(timeoutMs ? { timeoutMs } : {}) }));
      // } else if (kanaal === 'whatsapp') {
      //   resultaten.push(await stuurWhatsappWelkom({ email, voornaam, telefoon }));
      } else {
        resultaten.push({ kanaal, ok: false, reden: 'onbekend-kanaal' });
      }
    } catch (e) {
      // extra vangnet — de kanaal-functies zijn zelf al fail-soft
      console.error('[welkom] kanaal-fout', kanaal, e?.message || e);
      resultaten.push({ kanaal, ok: false, error: e?.message || String(e) });
    }
  }
  return resultaten;
}
