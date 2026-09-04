// api/_lib/whatsapp-brug-client.js
//
// De kant van het CRM die met de brug praat. Eén plek voor de omgevings-
// variabelen, het gedeelde geheim en de foutvertaling, zodat de vier endpoints
// daar niet elk hun eigen versie van hoeven te hebben.
//
// De browser praat NOOIT rechtstreeks met de VPS: het geheim zou dan in de
// front-end moeten staan, en het adres van de brug zou publiek zijn. Alles
// loopt via deze twee proxy-endpoints.

const TIMEOUT_MS = 20000;

/**
 * De brug-configuratie, of een leesbare uitleg waarom hij er niet is.
 * Bewust geen exception: de aanroepende endpoints willen een nette 503 met een
 * zin die vertelt wát er ontbreekt, niet een stacktrace.
 */
export function brugConfig() {
  const basis  = (process.env.WHATSAPP_BRUG_URL || '').trim().replace(/\/+$/, '');
  const secret = (process.env.WHATSAPP_BRUG_SECRET || '').trim();
  const mist = [];
  if (!basis)  mist.push('WHATSAPP_BRUG_URL');
  if (!secret) mist.push('WHATSAPP_BRUG_SECRET');
  if (mist.length) {
    return {
      ok: false,
      melding: `De WhatsApp-brug is niet geconfigureerd op de server (${mist.join(' en ')} ontbreekt).`,
    };
  }
  if (!/^https?:\/\//.test(basis)) {
    return { ok: false, melding: 'WHATSAPP_BRUG_URL moet met http:// of https:// beginnen.' };
  }
  return { ok: true, basis, secret };
}

/**
 * Controleert het gedeelde geheim op een binnenkomende aanvraag ván de brug.
 * Zelfde header als de brug zelf gebruikt, zodat er maar één naam in omloop is.
 */
export function brugGeheimKlopt(req) {
  const verwacht = (process.env.WHATSAPP_BRUG_SECRET || '').trim();
  if (!verwacht) return false;
  const aangeboden = req.headers['x-brug-secret'];
  if (typeof aangeboden !== 'string' || aangeboden.length !== verwacht.length) return false;
  // Vergelijken zonder vroegtijdig te stoppen. Node's timingSafeEqual kan hier
  // ook, maar dit houdt de helper vrij van imports en doet hetzelfde werk.
  let verschil = 0;
  for (let i = 0; i < verwacht.length; i++) verschil |= verwacht.charCodeAt(i) ^ aangeboden.charCodeAt(i);
  return verschil === 0;
}

/** Eén aanvraag naar de brug. Gooit met .code zodat de caller kan vertalen. */
export async function brugFetch(pad, { method = 'GET', body = null } = {}) {
  const cfg = brugConfig();
  if (!cfg.ok) { const e = new Error(cfg.melding); e.code = 'GEEN_CONFIG'; throw e; }

  let res;
  try {
    res = await fetch(cfg.basis + pad, {
      method,
      headers: { 'X-Brug-Secret': cfg.secret, Accept: 'application/json',
                 ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // Netwerk of time-out: de VPS staat uit, is onbereikbaar of antwoordt niet.
    const err = new Error('De WhatsApp-brug is niet bereikbaar.');
    err.code = 'ONBEREIKBAAR';
    err.oorzaak = e?.message || String(e);
    throw err;
  }

  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const err = new Error(data?.error || data?.melding || `De brug antwoordde met ${res.status}.`);
    err.code = 'BRUG_FOUT';
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Vertaalt een fout uit brugFetch naar een HTTP-status plus een leesbare zin. */
export function brugFoutNaarHttp(e) {
  if (e?.code === 'GEEN_CONFIG')   return { status: 503, body: { error: e.message, code: 'GEEN_CONFIG' } };
  if (e?.code === 'ONBEREIKBAAR')  return { status: 503, body: { error: e.message, code: 'ONBEREIKBAAR' } };
  if (e?.code === 'BRUG_FOUT')     return { status: e.status === 503 ? 503 : 502, body: { error: e.message, code: 'BRUG_FOUT' } };
  return { status: 500, body: { error: 'Onbekende fout bij de WhatsApp-brug.' } };
}
