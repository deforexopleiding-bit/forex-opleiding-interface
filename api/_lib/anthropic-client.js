// api/_lib/anthropic-client.js
//
// Gedeelde Anthropic /v1/messages client + structured-output helper.
//
// Wordt gebruikt door Joost-integratie (E1) en kan later bestaande
// duplicate fetch-pattern callers (agent-chat, agent-meeting, generate-reply,
// email-agent, etc.) opvolgen — refactor-kans die al lang in de lucht hangt.
//
// Strategie:
//   1) Eén plek voor headers, auth, retry-policy en error-mapping.
//   2) Structured output via tool-use pattern (tool_choice forceren). Geen
//      response_format:json_schema — dat endpoint wordt niet gebruikt.
//   3) Errors hebben een `.code` property zodat callers ze kunnen mappen op
//      HTTP-statussen of fail-soft kunnen loggen.
//
// Error-codes:
//   - ANTHROPIC_KEY_MISSING     → ANTHROPIC_API_KEY niet in env
//   - ANTHROPIC_RATE_LIMIT      → 429 na 1 retry met backoff
//   - ANTHROPIC_API_ERROR       → 4xx/5xx (excl. 429-retry-pad)
//   - ANTHROPIC_NETWORK_ERROR   → fetch faalde (DNS/timeout/etc)
//   - ANTHROPIC_TOOL_USE_MISSING → forced tool_choice maar geen tool_use in
//                                  response (model deed alsnog tekst)
//   - ANTHROPIC_INVALID_INPUT   → ontbrekende verplichte options
//
// Geen permission-checks; callers moeten zelf authn/authz doen.

const ANTHROPIC_API_URL  = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION  = '2023-06-01';

const DEFAULT_MODEL      = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 2048;

const RATE_LIMIT_RETRY_MS = 2000;

// Lokaal Error-subclass zodat callers `err.code` + `err.status` + `err.parsed_error`
// betrouwbaar kunnen lezen zonder string-parsen.
class AnthropicClientError extends Error {
  constructor(message, { code, status = null, parsed_error = null } = {}) {
    super(message);
    this.name         = 'AnthropicClientError';
    this.code         = code;
    this.status       = status;
    this.parsed_error = parsed_error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Voer een /v1/messages call uit en return de raw response JSON.
 *
 * @param {object}   options
 * @param {string}   [options.system]         System prompt (optioneel).
 * @param {Array}    options.messages         Lijst van { role, content }.
 * @param {string}   [options.model]          Default: claude-sonnet-4-6.
 * @param {number}   [options.max_tokens]     Default: 2048.
 * @param {number}   [options.temperature]    0..1 (optioneel).
 * @param {Array}    [options.tools]          Tool-definities (optioneel).
 * @param {object|string} [options.tool_choice] Bijv. { type:'tool', name:'x' }.
 * @returns {Promise<object>}                 Raw API-response JSON.
 */
export async function anthropicMessages(options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[anthropic-client] ANTHROPIC_API_KEY ontbreekt in env');
    throw new AnthropicClientError(
      'ANTHROPIC_API_KEY niet geconfigureerd',
      { code: 'ANTHROPIC_KEY_MISSING' }
    );
  }

  const {
    system,
    messages,
    model       = DEFAULT_MODEL,
    max_tokens  = DEFAULT_MAX_TOKENS,
    temperature,
    tools,
    tool_choice,
  } = options;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AnthropicClientError(
      'messages is verplicht en moet een niet-lege array zijn',
      { code: 'ANTHROPIC_INVALID_INPUT' }
    );
  }

  const requestBody = { model, max_tokens, messages };
  if (system !== undefined && system !== null && system !== '') {
    requestBody.system = system;
  }
  if (typeof temperature === 'number') {
    requestBody.temperature = temperature;
  }
  if (Array.isArray(tools) && tools.length > 0) {
    requestBody.tools = tools;
  }
  if (tool_choice) {
    requestBody.tool_choice = tool_choice;
  }

  const headers = {
    'x-api-key':         apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type':      'application/json',
  };

  // ── Eerste poging ────────────────────────────────────────────────────────
  let resp;
  try {
    resp = await fetch(ANTHROPIC_API_URL, {
      method:  'POST',
      headers,
      body:    JSON.stringify(requestBody),
    });
  } catch (netErr) {
    console.error('[anthropic-client] network error op eerste poging:', netErr?.message || netErr);
    throw new AnthropicClientError(
      `Netwerk-fout bij Anthropic call: ${netErr?.message || 'onbekend'}`,
      { code: 'ANTHROPIC_NETWORK_ERROR' }
    );
  }

  // ── 429: 1 retry met backoff ─────────────────────────────────────────────
  if (resp.status === 429) {
    console.error(`[anthropic-client] 429 rate-limit, retry over ${RATE_LIMIT_RETRY_MS}ms`);
    await sleep(RATE_LIMIT_RETRY_MS);
    try {
      resp = await fetch(ANTHROPIC_API_URL, {
        method:  'POST',
        headers,
        body:    JSON.stringify(requestBody),
      });
    } catch (netErr) {
      console.error('[anthropic-client] network error op retry:', netErr?.message || netErr);
      throw new AnthropicClientError(
        `Netwerk-fout bij Anthropic retry: ${netErr?.message || 'onbekend'}`,
        { code: 'ANTHROPIC_NETWORK_ERROR' }
      );
    }
    if (resp.status === 429) {
      const parsed = await safeJson(resp);
      console.error('[anthropic-client] 429 na retry, geef op:', parsed);
      throw new AnthropicClientError(
        'Anthropic rate-limit (429) ook na retry',
        { code: 'ANTHROPIC_RATE_LIMIT', status: 429, parsed_error: parsed }
      );
    }
  }

  if (!resp.ok) {
    const parsed = await safeJson(resp);
    console.error(
      `[anthropic-client] API-fout ${resp.status}:`,
      parsed?.error?.message || parsed || '(geen body)'
    );
    throw new AnthropicClientError(
      `Anthropic API-fout (${resp.status}): ${parsed?.error?.message || 'onbekend'}`,
      { code: 'ANTHROPIC_API_ERROR', status: resp.status, parsed_error: parsed }
    );
  }

  let data;
  try {
    data = await resp.json();
  } catch (parseErr) {
    console.error('[anthropic-client] kon response JSON niet parsen:', parseErr?.message);
    throw new AnthropicClientError(
      `Anthropic response niet-JSON: ${parseErr?.message || 'onbekend'}`,
      { code: 'ANTHROPIC_API_ERROR', status: resp.status }
    );
  }

  return data;
}

/**
 * Forceert structured JSON-output door 1 tool te definieren + tool_choice te
 * pinnen. Returnt het geparste `input`-object van het tool_use-block.
 *
 * @param {object} options
 * @param {string} [options.system]
 * @param {Array}  options.messages
 * @param {string} options.tool_name           Naam van de forced tool.
 * @param {object} options.tool_input_schema   JSONSchema voor de output-shape.
 * @param {string} [options.model]
 * @param {number} [options.temperature]
 * @param {number} [options.max_tokens]
 * @returns {Promise<object>}                  Parsed structured output.
 */
export async function anthropicStructuredOutput(options = {}) {
  const {
    system,
    messages,
    tool_name,
    tool_input_schema,
    model,
    temperature,
    max_tokens,
  } = options;

  if (!tool_name || typeof tool_name !== 'string') {
    throw new AnthropicClientError(
      'tool_name is verplicht (string)',
      { code: 'ANTHROPIC_INVALID_INPUT' }
    );
  }
  if (!tool_input_schema || typeof tool_input_schema !== 'object') {
    throw new AnthropicClientError(
      'tool_input_schema is verplicht (object)',
      { code: 'ANTHROPIC_INVALID_INPUT' }
    );
  }

  const tools = [
    {
      name:         tool_name,
      description:  'Returns structured result',
      input_schema: tool_input_schema,
    },
  ];

  const data = await anthropicMessages({
    system,
    messages,
    model,
    max_tokens,
    temperature,
    tools,
    tool_choice: { type: 'tool', name: tool_name },
  });

  const blocks = Array.isArray(data?.content) ? data.content : [];
  const toolUseBlock = blocks.find(
    (b) => b && b.type === 'tool_use' && b.name === tool_name
  );

  if (!toolUseBlock || !toolUseBlock.input || typeof toolUseBlock.input !== 'object') {
    console.error(
      '[anthropic-client] verwachtte tool_use block niet gevonden in response.',
      'stop_reason:', data?.stop_reason,
      'content-types:', blocks.map((b) => b?.type).join(',')
    );
    throw new AnthropicClientError(
      `Geen tool_use block voor "${tool_name}" in response`,
      { code: 'ANTHROPIC_TOOL_USE_MISSING', parsed_error: data }
    );
  }

  return toolUseBlock.input;
}

export { AnthropicClientError };
