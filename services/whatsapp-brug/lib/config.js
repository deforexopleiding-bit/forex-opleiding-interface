// services/whatsapp-brug/lib/config.js
//
// Alles uit de omgeving op één plek, één keer gecontroleerd. Ontbreekt er iets
// essentieels, dan stopt de service bij het opstarten met een leesbare regel —
// niet halverwege de eerste echte gebeurtenis.

function lees(naam, standaard = '') {
  const v = process.env[naam];
  return v == null || v === '' ? standaard : String(v).trim();
}

export function laadConfig() {
  const fouten = [];

  const secret = lees('BRUG_SECRET');
  if (!secret) fouten.push('BRUG_SECRET ontbreekt — zonder gedeeld geheim staat de brug open.');
  else if (secret.length < 24) fouten.push('BRUG_SECRET is te kort; gebruik `openssl rand -hex 32`.');

  const crmBase = lees('CRM_BASE_URL');
  if (!crmBase) fouten.push('CRM_BASE_URL ontbreekt — de brug weet dan niet waar het CRM staat.');
  else if (!/^https?:\/\//.test(crmBase)) fouten.push('CRM_BASE_URL moet met http:// of https:// beginnen.');

  const cfg = {
    port           : Number(lees('PORT', '8088')) || 8088,
    bind           : lees('BIND', '127.0.0.1'),
    secret,
    // Lege lijst = geen IP-check. Bewuste keuze: op een VPS achter een
    // reverse proxy is het IP vaak niet betrouwbaar, en dan is een verkeerd
    // ingestelde allowlist erger dan geen.
    toegestaneIps  : lees('ALLOWED_IPS').split(',').map((s) => s.trim()).filter(Boolean),
    crmBase        : crmBase.replace(/\/+$/, ''),
    webhookPad     : lees('CRM_WEBHOOK_PATH', '/api/opvolging-whatsapp-webhook'),
    nummersPad     : lees('CRM_NUMMERS_PATH', '/api/opvolging-whatsapp-nummers'),
    nummersIntervalMs: Math.max(60, Number(lees('NUMMERS_INTERVAL_SEC', '300')) || 300) * 1000,
    sessiePad      : lees('SESSIE_PAD', './.wwebjs_auth'),
    chromiumPad    : lees('CHROMIUM_PAD') || null,
  };

  if (fouten.length) {
    console.error('[brug] kan niet starten:');
    for (const f of fouten) console.error('  · ' + f);
    console.error('  Zie services/whatsapp-brug/.env.example.');
    process.exit(1);
  }
  return cfg;
}
