// api/_lib/bubble.js
// Dunne helper voor bubble.io Data API (Object endpoints).
//
// Auth: Authorization: Bearer <BUBBLE_API_TOKEN>.
// Root: BUBBLE_API_ROOT, bv. https://dashboard.deforexopleiding.nl/api/1.1/obj
//
// Functies:
//   bubbleList(type, constraints[], { limit?, cursor? }) — paginatie-bestendig.
//     - constraints: array van { key, constraint_type, value }; urlencoded JSON.
//     - response: { results: [...], cursor, remaining, count } (alles uit bubble).
//   bubbleGet(type, id) — één object; null als 404.
//
// Gooi een Error met .code='BUBBLE_CONFIG_MISSING' als env-vars ontbreken zodat
// callers er een nette 500/503 van kunnen maken zonder geheime details te lekken.

function readConfig() {
  const token = process.env.BUBBLE_API_TOKEN || null;
  const root  = process.env.BUBBLE_API_ROOT  || null;
  if (!token || !root) {
    const err = new Error('Bubble API niet geconfigureerd (BUBBLE_API_TOKEN of BUBBLE_API_ROOT ontbreekt)');
    err.code = 'BUBBLE_CONFIG_MISSING';
    throw err;
  }
  return { token, root: root.replace(/\/+$/, '') };
}

function authHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept':        'application/json',
  };
}

async function bubbleRequest(url, { token }) {
  let resp;
  try {
    resp = await fetch(url, { method: 'GET', headers: authHeaders(token) });
  } catch (e) {
    const err = new Error('bubble fetch netwerk-fout: ' + (e?.message || e));
    err.code = 'BUBBLE_NETWORK';
    throw err;
  }
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (resp.status === 404) {
    return { status: 404, json };
  }
  if (!resp.ok) {
    const err = new Error('bubble API ' + resp.status + ': ' + (json?.body?.message || json?.statusMessage || text.slice(0, 200)));
    err.code = 'BUBBLE_HTTP_' + resp.status;
    err.status = resp.status;
    throw err;
  }
  return { status: resp.status, json };
}

// Lijst-call met paginatie. Bubble levert pagina's van max 100 per response.
// Caller kan via opts.limit het totaal cappen.
export async function bubbleList(type, constraints = [], opts = {}) {
  const { token, root } = readConfig();
  const cap = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.min(2000, Number(opts.limit))) : 500;
  let cursor = Number.isFinite(Number(opts.cursor)) ? Math.max(0, Number(opts.cursor)) : 0;
  const results = [];

  while (results.length < cap) {
    const params = new URLSearchParams();
    if (Array.isArray(constraints) && constraints.length > 0) {
      params.set('constraints', JSON.stringify(constraints));
    }
    params.set('limit', String(Math.min(100, cap - results.length)));
    if (cursor > 0) params.set('cursor', String(cursor));

    const url = `${root}/${encodeURIComponent(type)}?${params.toString()}`;
    const { json } = await bubbleRequest(url, { token });
    const page = json?.response?.results || [];
    results.push(...page);
    const remaining = Number(json?.response?.remaining || 0);
    if (page.length === 0 || remaining <= 0) break;
    cursor += page.length;
  }

  return { results };
}

// Robuuste display-helper voor Bubble User-objecten. Bubble's veld-keys
// variëren tussen apps ('first name' vs 'first_name' vs 'Voornaam'); email
// staat vaak genest onder authentication.email.email. Deze helper pakt de
// eerste niet-lege variant en geeft { name, email } terug. Herbruikt in
// bubble-mentors-list + (straks) de studenten-proxy.
function pick(u, keys) {
  if (!u || typeof u !== 'object') return null;
  for (const k of keys) {
    const v = u[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}
export function bubbleUserDisplay(u) {
  if (!u || typeof u !== 'object') return { name: '', email: null };
  // Bubble Data API suffix-conventie: <field>_<type>. Voornaam staat onder
  // 'name_text' en achternaam onder 'last_name_text'. We zetten die bovenaan
  // de pick-lijst; bare-name varianten blijven als fallback.
  const firstName = pick(u, ['name_text', 'first name', 'first_name', 'First Name', 'firstname', 'voornaam', 'Voornaam']);
  const lastName  = pick(u, ['last_name_text', 'last name',  'last_name',  'Last Name',  'lastname',  'achternaam','Achternaam']);
  let name = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (!name) {
    name = pick(u, ['name', 'Name', 'full_name', 'Full Name', 'volledige naam']) || '';
  }
  // Email zit bij authenticated users meestal genest:
  //   u.authentication.email.email = 'foo@bar.nl'
  // Custom-velden komen onder verschillende keys.
  const nestedEmail = u && u.authentication && u.authentication.email && u.authentication.email.email;
  const rawEmail = (typeof nestedEmail === 'string' && nestedEmail.trim())
    ? nestedEmail.trim()
    : pick(u, ['email', 'Email', 'e-mail', 'E-mail']);
  const email = rawEmail ? String(rawEmail).toLowerCase() : null;
  return { name, email };
}

// Eén object ophalen; null bij 404 (zodat callers expliciet "niet gevonden"
// kunnen onderscheiden van een echte fout).
export async function bubbleGet(type, id) {
  const { token, root } = readConfig();
  const safeId = encodeURIComponent(String(id));
  const url = `${root}/${encodeURIComponent(type)}/${safeId}`;
  const { status, json } = await bubbleRequest(url, { token });
  if (status === 404) return null;
  return json?.response || null;
}
