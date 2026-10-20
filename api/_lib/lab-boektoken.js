// api/_lib/lab-boektoken.js
//
// BOEKTOKEN voor de bedankpagina van de Lab-funnels (deforexopleiding.nl/
// the-lab-v1|v2/bedankt). Na een aanmelding kan de lead daar meteen zijn
// strategiesessie boeken zonder iets opnieuw te typen — maar hij is (nog) niet
// ingelogd in het LMS, dus de gewone LMS-sessie (api/lab-sessie.js) kan niet.
// Daarom geeft /api/lab-aanmelding een kortlevend, ondertekend token mee dat
// alleen naar DIE aanmelding wijst. api/lab-sessie.js aanvaardt het als
// `Authorization: LabBoek <token>` en volgt dan exact hetzelfde boekpad.
//
// Waarom veilig genoeg:
//   - het token bevat alleen het aanmeldings-id (een random uuid), de funnel en
//     een vervaldatum — geen e-mail of naam; ondertekend met HMAC-SHA256;
//   - elke aanmelding krijgt er één, ook een bestaande student: het antwoord
//     van /api/lab-aanmelding blijft voor elk adres gelijk (geen orakel);
//   - het kan niets anders dan momenten lezen en ÉÉN sessie boeken voor de
//     persoon van die aanmelding (zelfde als de publieke agendalink).
//
// Sleutel: env LAB_BOEK_TOKEN_SECRET, anders afgeleid uit
// SUPABASE_SERVICE_ROLE_KEY (zelfde aanpak als _lib/attachment-token.js) —
// geen nieuwe configuratie nodig, en de service-role key wordt nooit zelf
// als HMAC-sleutel gebruikt.

import crypto from 'node:crypto';

export const BOEKTOKEN_VERSIE = 'lb1';
export const BOEKTOKEN_GELDIG_MS = 48 * 3600 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FUNNEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function sleutel() {
  const eigen = process.env.LAB_BOEK_TOKEN_SECRET;
  if (eigen) return Buffer.from(eigen, 'utf8');
  const basis = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!basis) return null;
  return crypto.createHmac('sha256', basis).update('lab-boektoken-v1').digest();
}

const handtekening = (k, payload) => crypto.createHmac('sha256', k).update(payload).digest('base64url');

/**
 * Token voor één aanmelding. Null als er geen sleutel is (dan toont de
 * bedankpagina "plan via de link in je mail").
 */
export function maakBoektoken({ aanmeldingId, funnel = null, nu = Date.now(), geldigMs = BOEKTOKEN_GELDIG_MS }) {
  const k = sleutel();
  if (!k || !UUID_RE.test(String(aanmeldingId || ''))) return null;
  const f = funnel && FUNNEL_RE.test(funnel) ? funnel : '';
  const payload = [BOEKTOKEN_VERSIE, aanmeldingId.toLowerCase(), f, String(nu + geldigMs)].join('.');
  return payload + '.' + handtekening(k, payload);
}

/**
 * @returns {{ ok: true, aanmeldingId: string, funnel: string|null } | { ok: false, reden: string }}
 */
export function leesBoektoken(token, nu = Date.now()) {
  const k = sleutel();
  if (!k) return { ok: false, reden: 'geen_sleutel' };
  const delen = String(token || '').split('.');
  if (delen.length !== 5 || delen[0] !== BOEKTOKEN_VERSIE) return { ok: false, reden: 'vorm' };
  const [versie, id, funnel, exp, sig] = delen;
  const verwacht = Buffer.from(handtekening(k, [versie, id, funnel, exp].join('.')));
  const gekregen = Buffer.from(sig);
  if (gekregen.length !== verwacht.length || !crypto.timingSafeEqual(gekregen, verwacht)) return { ok: false, reden: 'handtekening' };
  if (!UUID_RE.test(id)) return { ok: false, reden: 'vorm' };
  if (!(Number(exp) > nu)) return { ok: false, reden: 'verlopen' };
  return { ok: true, aanmeldingId: id, funnel: funnel || null };
}

/** `Authorization: LabBoek <token>` → token of null. PURE. */
export function boektokenUitHeader(req) {
  const h = String(req?.headers?.authorization || '');
  return /^labboek\s+/i.test(h) ? h.replace(/^labboek\s+/i, '').trim() : null;
}
