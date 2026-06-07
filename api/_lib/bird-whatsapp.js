// api/_lib/bird-whatsapp.js
// Skeleton voor Bird (ex-MessageBird) WhatsApp Channels API integratie.
//
// PR A1 SCOPE: alleen interface + fetch-wrapper. Geen echte calls naar Bird
// tenzij env vars zijn gezet. Volgende PR (A2) implementeert sendText echt,
// plus webhook receiver en UI.
//
// Bird API recon (juni 2026 docs.bird.com):
//   Base URL  : https://api.bird.com
//   Auth      : Authorization: AccessKey <BIRD_API_KEY>
//   Send msg  : POST /workspaces/{workspace-id}/channels/{channel-id}/messages
//   Webhook   : Notifications API met X-Signature / MessageBird-Signature-JWT
//               (HMAC-SHA256 — verificatie via shared secret)
//
// Body voor template-message (recon-vondst):
//   {
//     "receiver": { "contacts": [{"identifierValue": "+316..."}] },
//     "template": {
//       "projectId": "<uuid>",
//       "version":   "<uuid>",
//       "locale":    "nl",
//       "variables": { "name": "Jeffrey", ... }
//     }
//   }
//
// Body voor free-form tekst (Customer Service Window <24h):
//   {
//     "receiver": { "contacts": [{"identifierValue": "+316..."}] },
//     "body": { "type": "text", "text": { "text": "Hoi!" } }
//   }
//
// Bird-doc-referenties (zie sitemap.md voor volledige lijst):
//   - /api/channels-api/supported-channels/programmable-whatsapp/sending-whatsapp-messages.md
//   - /api/channels-api/supported-channels/programmable-whatsapp/customer-service-window.md
//   - /api/channels-api/supported-channels/programmable-whatsapp/receiving-messages.md
//   - /api/notifications-api/api-reference/webhook-subscriptions/verifying-a-webhook-subscription.md

const BIRD_BASE_URL = 'https://api.bird.com';

class BirdNotConfiguredError extends Error {
  constructor(missing) {
    super(`Bird API niet geconfigureerd (ontbrekend: ${missing.join(', ')})`);
    this.name = 'BirdNotConfiguredError';
    this.missing = missing;
  }
}

/**
 * Lees Bird config uit env vars + valideer aanwezigheid van vereiste keys.
 * Throws BirdNotConfiguredError bij ontbrekende vars zodat callers fail-fast
 * kunnen reageren (UI: "Bird-integratie nog niet geactiveerd").
 *
 * @param {string[]} required keys die deze caller nodig heeft (subset van vier)
 */
function getConfig(required = ['BIRD_API_KEY', 'BIRD_WORKSPACE_ID', 'BIRD_CHANNEL_ID']) {
  const env = process.env;
  const missing = required.filter(k => !env[k]);
  if (missing.length) throw new BirdNotConfiguredError(missing);
  return {
    apiKey:        env.BIRD_API_KEY,
    workspaceId:   env.BIRD_WORKSPACE_ID,
    channelId:     env.BIRD_CHANNEL_ID,
    webhookSecret: env.BIRD_WEBHOOK_SECRET || null,
  };
}

/**
 * Wrapper rond fetch met Bird's AccessKey-auth + JSON content-type.
 * Verwacht een opts.body als plain object (wordt gestringified).
 */
async function birdFetch(path, opts = {}) {
  const cfg = getConfig();
  const url = path.startsWith('http') ? path : `${BIRD_BASE_URL}${path}`;
  const res = await fetch(url, {
    method:  opts.method || 'GET',
    headers: {
      'Authorization':  `AccessKey ${cfg.apiKey}`,
      'Content-Type':   'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

// ── Send: free-form tekst (binnen 24h customer-service window) ─────────────
/**
 * Stuur een platte tekst-message. Werkt alleen binnen 24h sinds laatste
 * inbound message van de klant (Bird's "customer service window"). Buiten
 * 24h: gebruik sendTemplate met een approved WhatsApp-template.
 *
 * NIET-GEÏMPLEMENTEERD in PR A1: gooit BirdNotConfiguredError zolang
 * env vars ontbreken. PR A2 voltooit implementatie incl. response-parsing
 * + persist naar whatsapp_messages.
 *
 * @param {object}  opts
 * @param {string}  opts.to              E.164-nummer (+316…)
 * @param {string}  opts.body            tekst
 * @returns {Promise<{ bird_message_id: string, status: string }>}
 */
export async function sendText({ to, body }) {
  if (!to || !body) throw new Error('sendText: to + body vereist');
  const cfg = getConfig();
  const requestBody = {
    receiver: { contacts: [{ identifierValue: to }] },
    body: { type: 'text', text: { text: body } },
  };
  const path = `/workspaces/${cfg.workspaceId}/channels/${cfg.channelId}/messages`;
  // PR A1: alleen body-shape opbouwen, geen request. Activeer in A2.
  return Promise.reject(new Error(`Not implemented in PR A1 (path=${path}, body keys=${Object.keys(requestBody).join(',')})`));
}

// ── Send: template (buiten 24h window) ─────────────────────────────────────
/**
 * Stuur een approved template. Vereist een ge-approved template in Bird's
 * dashboard met projectId + version + locale.
 *
 * NIET-GEÏMPLEMENTEERD in PR A1.
 *
 * @param {object} opts
 * @param {string} opts.to              E.164-nummer
 * @param {string} opts.templateName    (informatief — Bird gebruikt projectId)
 * @param {string} opts.projectId       Bird template projectId (uuid)
 * @param {string} opts.version         template version (uuid)
 * @param {string} opts.locale          bv. 'nl'
 * @param {object} opts.variables       template-variabelen { naam: 'Jeffrey', ... }
 */
export async function sendTemplate({ to, templateName, projectId, version, locale = 'nl', variables = {} }) {
  if (!to || !projectId || !version) throw new Error('sendTemplate: to + projectId + version vereist');
  return Promise.reject(new Error(`Not implemented in PR A1 (template=${templateName})`));
}

// ── List: conversations ─────────────────────────────────────────────────────
/**
 * Haal recente conversations op uit Bird voor onze channel. Voor bootstrap /
 * back-fill (anders krijgen we alles via webhooks).
 *
 * NIET-GEÏMPLEMENTEERD in PR A1.
 */
export async function listConversations({ cursor = null, limit = 50 } = {}) {
  return Promise.reject(new Error('Not implemented in PR A1'));
}

// ── List: messages binnen één conversation ─────────────────────────────────
/**
 * NIET-GEÏMPLEMENTEERD in PR A1.
 */
export async function listMessages({ conversationId, cursor = null, limit = 50 }) {
  if (!conversationId) throw new Error('listMessages: conversationId vereist');
  return Promise.reject(new Error('Not implemented in PR A1'));
}

// ── Webhook signature verificatie ──────────────────────────────────────────
/**
 * Verifieer Bird's MessageBird-Signature-JWT header.
 *
 * Bird's mechaniek (per docs.bird.com notifications-api):
 *   - Header: 'MessageBird-Signature-JWT' (kan op nieuwe Bird-CRM ook
 *     'X-Bird-Signature' heten — final variant in PR A2).
 *   - Algo: HMAC-SHA256, payload = request URL + raw body.
 *   - Signing key: BIRD_WEBHOOK_SECRET.
 *
 * NIET-GEÏMPLEMENTEERD in PR A1. PR A2 voegt jsonwebtoken-style
 * verificatie toe (jsonwebtoken package is geen runtime-dep nu).
 *
 * @param {object} req    Vercel request object met headers + rawBody
 * @returns {Promise<boolean>}
 */
export async function verifyWebhookSignature(req) {
  const cfg = getConfig(['BIRD_API_KEY', 'BIRD_WEBHOOK_SECRET']);
  const sigHeader = req?.headers?.['messagebird-signature-jwt'] || req?.headers?.['x-bird-signature'] || null;
  if (!sigHeader) return false;
  // TODO PR A2: HMAC-SHA256(url + raw body) tegen cfg.webhookSecret en check tegen sig.
  return Promise.reject(new Error('Not implemented in PR A1'));
}

// ── Diagnostics ─────────────────────────────────────────────────────────────
/**
 * Lees status (zonder Bird-call): bestaan de vier env vars? Voor UI-banner
 * "Bird-integratie nog niet geactiveerd".
 *
 * @returns {{ configured: boolean, missing: string[] }}
 */
export function getConfigStatus() {
  const required = ['BIRD_API_KEY', 'BIRD_WORKSPACE_ID', 'BIRD_CHANNEL_ID', 'BIRD_WEBHOOK_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  return { configured: missing.length === 0, missing };
}

export { BirdNotConfiguredError, BIRD_BASE_URL };
