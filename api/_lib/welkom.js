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

async function stuurEmailWelkom({ email, voornaam }) {
  const url = process.env.INTERNE_WELKOM_URL;
  const secret = process.env.INTERNE_WELKOM_SECRET;
  if (!url || !secret) {
    console.warn('[welkom] e-mail overgeslagen: INTERNE_WELKOM_URL/INTERNE_WELKOM_SECRET ontbreekt');
    return { kanaal: 'email', ok: false, reden: 'niet-geconfigureerd' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WELKOM_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': secret },
      body: JSON.stringify({ email, voornaam }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const tekst = await r.text().catch(() => '');
      console.error('[welkom] e-mail mislukt:', r.status, tekst.slice(0, 200));
      return { kanaal: 'email', ok: false, status: r.status };
    }
    return { kanaal: 'email', ok: true };
  } catch (e) {
    console.error('[welkom] e-mail exception:', e?.message || e);
    return { kanaal: 'email', ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Placeholder voor later — geen WhatsApp tot het Meta-template rond is.
// async function stuurWhatsappWelkom({ email, voornaam, telefoon }) { ... }

/**
 * Stuur een welkomstbevestiging over de gevraagde kanalen. Gooit NOOIT (fail-soft).
 * @param {{ email: string, voornaam?: string|null, telefoon?: string|null, kanalen?: string[] }} opts
 * @returns {Promise<Array<{kanaal:string, ok:boolean}>>}
 */
export async function stuurWelkom({ email, voornaam = null, telefoon = null, kanalen = ['email'] }) {
  const resultaten = [];
  for (const kanaal of kanalen) {
    try {
      if (kanaal === 'email') {
        resultaten.push(await stuurEmailWelkom({ email, voornaam }));
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
