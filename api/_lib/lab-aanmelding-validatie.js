// api/_lib/lab-aanmelding-validatie.js
//
// Validatie van een Lab-aanmelding. PURE: geen DB, geen netwerk — zodat het
// contract (zie docs/the-lab-aanmelding-api.md) los te testen is.

import { normaliseerNlBe } from './phone-e164.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HOOK_RE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;

/** Naam van het honeypot-veld. Moet LEEG blijven; mensen zien het niet. */
export const HONEYPOT_VELD = 'website';

const kort = (v, max) => {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** 'h01', ' H01 ' → 'H01'. Onbruikbaar → null. */
export function normaliseerHook(v) {
  const s = kort(v, 40);
  if (!s) return null;
  const h = s.toUpperCase().replace(/\s+/g, '-');
  return HOOK_RE.test(h) ? h : null;
}

/**
 * Alleen origin + pad bewaren: een querystring kan fbclid of (bij een slordige
 * landingspagina) persoonsgegevens bevatten. Die horen niet in onze database.
 */
export function schoneLandingspagina(v) {
  const s = kort(v, 500);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return (u.origin + u.pathname).slice(0, 300);
  } catch {
    return null;
  }
}

/**
 * fbc volgens het Meta-formaat `fb.1.<ms>.<fbclid>`. Een meegestuurde fbc
 * (cookie _fbc) wint; anders bouwen we hem uit fbclid.
 */
export function bepaalFbc({ fbc, fbclid, nu = Date.now() }) {
  const c = kort(fbc, 300);
  if (c && /^fb\.\d\.\d+\..+/.test(c)) return c;
  const id = kort(fbclid, 250);
  if (id && /^[A-Za-z0-9_-]+$/.test(id)) return `fb.1.${nu}.${id}`;
  return null;
}

/**
 * @param {object} body  ruwe JSON-body
 * @param {{ nu?: number }} [opts]
 * @returns {{ ok: true, bot: boolean, data: object } | { ok: false, veld: string, fout: string }}
 */
export function valideerLabAanmelding(body, { nu = Date.now() } = {}) {
  const b = body && typeof body === 'object' ? body : {};

  // Honeypot: ingevuld = bot. We antwoorden alsof alles goed ging (een bot
  // die "fout" hoort, probeert het anders), maar doen niets.
  const hp = b[HONEYPOT_VELD];
  if (hp != null && String(hp).trim() !== '') return { ok: true, bot: true, data: null };

  const voornaam = kort(b.voornaam, 60);
  if (!voornaam) return { ok: false, veld: 'voornaam', fout: 'Vul je voornaam in.' };

  const email = (kort(b.email, 200) || '').toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, veld: 'email', fout: 'Vul een geldig e-mailadres in.' };

  const ruwTel = kort(b.gsm ?? b.telefoon, 40);
  if (!ruwTel) return { ok: false, veld: 'gsm', fout: 'Vul je gsm-nummer in.' };
  const land = ['BE', 'NL'].includes(String(b.land || '').toUpperCase()) ? String(b.land).toUpperCase() : null;
  const tel = normaliseerNlBe(ruwTel, { land });
  if (!tel.e164) {
    return { ok: false, veld: 'gsm', fout: 'Dat gsm-nummer herkennen we niet. Probeer het met landcode, bv. +32 4… of +31 6….' };
  }

  // Toestemming: verplicht voor WhatsApp en opvolging, NIET voor de loginmail
  // zelf — daar vroeg de lead om. Alleen een echte true telt.
  const toestemming = b.toestemming === true || b.toestemming === 'true' || b.toestemming === 'on' || b.toestemming === 1 || b.toestemming === '1';

  const utm = {
    utm_source:   kort(b.utm_source, 120),
    utm_medium:   kort(b.utm_medium, 120),
    utm_campaign: kort(b.utm_campaign, 200),
    utm_content:  kort(b.utm_content, 200),
    utm_term:     kort(b.utm_term, 200),
  };
  // De hook: expliciet veld, anders utm_content (zo staat het in de ads).
  const hook = normaliseerHook(b.hook) || normaliseerHook(utm.utm_content);

  return {
    ok: true,
    bot: false,
    data: {
      voornaam,
      achternaam: kort(b.achternaam, 80),
      email,
      telefoon_e164: tel.e164,
      toestemming,
      hook,
      ...utm,
      landingspagina: schoneLandingspagina(b.landingspagina || b.landing_url),
      fbclid: kort(b.fbclid, 250),
      fbc: bepaalFbc({ fbc: b.fbc, fbclid: b.fbclid, nu }),
      fbp: kort(b.fbp, 300),
      // Alleen het eigen testadres van Maxim/het team markeert als test.
      is_test: /\+labtest/i.test(email) || String(hook || '') === 'TEST',
    },
  };
}
