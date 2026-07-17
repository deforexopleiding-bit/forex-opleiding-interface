/* modules/shared/finance-instellingen.js
 *
 * Finance Instellingen — beheer-paneel binnen Finance met 3 sub-secties:
 *   1. Joost AI (config / autonomy / decision log) — FULL extract uit
 *      modules/admin.html (Groep D)
 *   2. WhatsApp Templates — FULL extract uit modules/admin.html (PR-4):
 *      WABA-selector, sub-tabs Meta Templates + Snelle antwoorden,
 *      Meta-editor met variabelen-paneel + live preview + Meta-sync.
 *   3. WhatsApp Connection / Afdeling-config — FULL extract uit
 *      modules/admin.html (PR-4): module-koppelingen + edit-modal met
 *      contact-info afdeling sectie + webhook-subscribe.
 *
 * Public API: window.FinanceInstellingen.mount({
 *   host: HTMLElement,
 * })
 *
 * Mount is idempotent: tweede aanroep op dezelfde host doet niets dankzij
 * mount-guard. Sub-tab state via ?sub=joost|templates|connection URL-param.
 *
 * RBAC: respecteert admin.joost_config (Joost) / admin.whatsapp_templates
 * (Templates) / admin.whatsapp_config (Connection) — server-side fail-fast
 * op de onderliggende endpoints. UI rendert altijd (geen client gate);
 * 403's tonen we als load-error.
 *
 * Endpoints (server blijft op admin-* namespace in deze PR — geen rename):
 *   - GET  /api/joost-config-get?module=finance
 *   - POST /api/joost-config-upsert
 *   - GET  /api/joost-autonomy-decisions-list?limit=50
 *   - GET  /api/admin-whatsapp-modules-list
 *   - POST /api/admin-whatsapp-module-upsert
 *   - GET  /api/admin-whatsapp-numbers-available
 *   - POST /api/admin-whatsapp-webhook-subscribe
 *   - GET  /api/admin-whatsapp-wabas-list
 *   - GET  /api/admin-meta-templates-list?business_account_id=...
 *   - POST /api/admin-meta-templates-upsert (+ PATCH ?id=...)
 *   - DELETE /api/admin-meta-templates-delete?id=...
 *   - POST /api/admin-meta-templates-submit
 *   - POST /api/admin-meta-templates-sync
 *   - GET  /api/admin-quick-replies-list
 *   - POST /api/admin-quick-replies-upsert (+ PATCH ?id=...)
 *   - DELETE /api/admin-quick-replies-delete?id=...
 */
(function () {
  if (window.FinanceInstellingen && window.FinanceInstellingen.__loaded) return;

  // ── esc(): HTML-escape (fallback als AgentShared niet geladen is). ─────────
  function esc(s) {
    if (s == null) return '';
    try {
      if (window.AgentShared && typeof window.AgentShared.esc === 'function') {
        return window.AgentShared.esc(s);
      }
    } catch (_) { /* fallthrough */ }
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(msg, kind) {
    try { window.AgentShared?.showToast(msg, kind); } catch (_) { /* fail-soft */ }
  }

  // Module-scope state.
  const _state = {
    hostMounted: null,        // mount-guard
    activeSub: 'joost',       // joost | templates | connection
  };

  // Joost-specific state (mirrored uit admin.html).
  const _joost = {
    cfgWired: false,
    cfgLoadedOnce: false,
    autonomyLoadedOnce: false,
    decisionsLoadedOnce: false,
    decisionsTimer: null,
  };

  // KEY-CONTRACT: intent-keys komen 1-op-1 uit joost-suggest-core.js
  // DETECTED_INTENTS (het tool-schema van het LLM). Zowel de evaluator
  // (api/joost-autonomy-evaluate.js) als de config-blob (autonomy_config.
  // intents.<key>) gebruiken exact deze set. Nederlandse LABELS voor Jeffrey,
  // Engelse KEYS onder de motorkap.
  const JOOST_INTENTS = [
    { key: 'payment_promise',     label: 'Betaal-belofte',         hasMaxMsg: true  },
    { key: 'verify_payment',      label: 'Al betaald / verificatie', hasMaxMsg: true },
    { key: 'arrangement_request', label: 'Regeling / uitstel',     hasMaxMsg: true  },
    { key: 'general_question',    label: 'Vraag',                  hasMaxMsg: true  },
    { key: 'escalation_needed',   label: 'Escalatie',              hasMaxMsg: false },
    { key: 'other',               label: 'Anders',                 hasMaxMsg: true  },
  ];

  // ── Public API: mount() ────────────────────────────────────────────────────
  function mount(opts) {
    const host = (opts && opts.host) || null;
    if (!host) {
      console.warn('[FinanceInstellingen] mount: host element ontbreekt');
      return;
    }
    if (_state.hostMounted === host) return;  // idempotent
    _state.hostMounted = host;

    // Initial sub uit ?sub= URL-param.
    try {
      const url = new URL(location.href);
      const sub = url.searchParams.get('sub');
      if (sub && ['joost', 'templates', 'connection'].includes(sub)) {
        _state.activeSub = sub;
      }
    } catch (_) { /* fail-soft */ }

    host.innerHTML = renderShell();
    wireShellOnce(host);
    setActiveSub(_state.activeSub);
  }

  // ── Shell ─────────────────────────────────────────────────────────────────
  function renderShell() {
    return `
      <style>
        .fi-tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); margin-bottom:20px; }
        .fi-tab {
          background:transparent; border:none; padding:10px 16px; font-size:14px; font-weight:500;
          color:var(--text-dim); cursor:pointer; border-bottom:2px solid transparent;
          transition:color .15s, border-color .15s;
        }
        .fi-tab:hover { color:var(--text); }
        .fi-tab.active { color:var(--accent-cyan, #06b6d4); border-bottom-color:var(--accent-cyan, #06b6d4); }
        .fi-section-card {
          background:var(--surface, rgba(255,255,255,0.03));
          border:1px solid var(--border);
          border-radius:10px;
          padding:18px;
          margin-bottom:14px;
        }
        .fi-section-header {
          display:flex; justify-content:space-between; align-items:center;
          margin-bottom:14px; border-bottom:1px solid var(--border); padding-bottom:10px;
        }
        .fi-deeplink-card {
          padding:24px; border:1px dashed var(--border); border-radius:10px;
          background:rgba(255,255,255,0.02);
          font-size:13px; line-height:1.5;
        }
        .fi-deeplink-card strong { font-size:14px; }
        .fi-deeplink-card a.btn { margin-top:14px; display:inline-block; }
        .form-group { margin-bottom:14px; }
        .form-label { display:block; font-size:12.5px; font-weight:600; color:var(--text-dim); margin-bottom:6px; }
        .form-input {
          width:100%; padding:8px 10px; font-size:13.5px;
          background:var(--bg-soft, rgba(255,255,255,0.04));
          border:1px solid var(--border); border-radius:6px; color:var(--text);
        }
      </style>

      <div class="fi-tabs" id="fiTabs">
        <button class="fi-tab" data-fi-sub="joost"      type="button">Joost (AI)</button>
        <button class="fi-tab" data-fi-sub="templates"  type="button">WhatsApp Templates</button>
        <button class="fi-tab" data-fi-sub="connection" type="button">Afdeling (WhatsApp Connection)</button>
      </div>

      <!-- ─── Sub-tab: Joost AI (volledig porteerde uit admin.html) ─── -->
      <div id="fiSubJoost" hidden>
        ${renderJoostMarkup()}
      </div>

      <!-- ─── Sub-tab: WhatsApp Templates (PR-4 full extract) ─── -->
      <div id="fiSubTemplates" hidden>
        ${renderTemplatesMarkup()}
      </div>

      <!-- ─── Sub-tab: WhatsApp Connection / Afdeling-config (PR-4 full extract) ─── -->
      <div id="fiSubConnection" hidden>
        ${renderConnectionMarkup()}
      </div>
    `;
  }

  function wireShellOnce(host) {
    const tabs = host.querySelectorAll('#fiTabs .fi-tab');
    tabs.forEach(b => b.addEventListener('click', () => setActiveSub(b.dataset.fiSub)));
  }

  function setActiveSub(sub) {
    if (!['joost', 'templates', 'connection'].includes(sub)) sub = 'joost';
    _state.activeSub = sub;
    const host = _state.hostMounted;
    if (!host) return;

    host.querySelectorAll('#fiTabs .fi-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.fiSub === sub);
    });
    host.querySelector('#fiSubJoost').hidden      = sub !== 'joost';
    host.querySelector('#fiSubTemplates').hidden  = sub !== 'templates';
    host.querySelector('#fiSubConnection').hidden = sub !== 'connection';

    // URL-sync (?sub=...) zonder reload.
    try {
      const url = new URL(location.href);
      url.searchParams.set('sub', sub);
      history.replaceState(null, '', url.toString());
    } catch (_) { /* fail-soft */ }

    // Auto-load Joost bij eerste activatie.
    if (sub === 'joost') {
      wireJoostOnce();
      if (!_joost.cfgLoadedOnce) loadJoostConfig();
      switchJoostSubTab('algemeen');
    } else {
      // Stop decisions-poll wanneer we Joost verlaten.
      if (_joost.decisionsTimer) {
        clearInterval(_joost.decisionsTimer);
        _joost.decisionsTimer = null;
      }
    }

    // Templates sub-tab: wire en laad WABAs (lazy).
    if (sub === 'templates') {
      wireWaTplOnce();
      if (!_waTpl.loadedOnce) loadWaTplWabas();
    }

    // Connection sub-tab: wire en laad module-lijst.
    if (sub === 'connection') {
      wireWaConfOnce();
      loadWaConfList();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //   JOOST AI sectie — full extract uit admin.html (lines 517-840 HTML,
  //   4982-5486 JS). Element-IDs blijven 1-op-1 zodat de logica letterlijk
  //   gekopieerd kan worden. Sub-tab strip + 3 sub-views (algemeen/autonomy/
  //   decisions).
  // ─────────────────────────────────────────────────────────────────────────

  function renderJoostMarkup() {
    return `
      <div id="view-joost-config">
        <!-- Joost sub-tab strip (E2.x) -->
        <div class="fi-tabs" style="margin-bottom:14px">
          <button class="fi-tab active" data-joost-sub="algemeen"  type="button">Algemeen</button>
          <button class="fi-tab"        data-joost-sub="autonomy"  type="button">Autonomy</button>
          <button class="fi-tab"        data-joost-sub="decisions" type="button">Decision Log</button>
        </div>

        <!-- Sub-tab: Algemeen -->
        <div id="view-joost-algemeen">
          <div class="fi-section-card" style="max-width:920px">
            <div class="fi-section-header">
              <div>
                <div style="font-size:15px;font-weight:700">Joost &mdash; AI antwoord-suggesties</div>
                <div style="font-size:12px;color:var(--text-faint);font-weight:400;margin-top:4px;max-width:720px">
                  Configureer persona, tone, system prompt, kennisbank en model voor Joost.
                  In E1.0 alleen voor de Finance-inbox (WhatsApp). Toggle &laquo;Actief&raquo; om
                  het suggesties-paneel zichtbaar te maken voor finance-gebruikers.
                </div>
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-sm" type="button" id="joostCfgReloadBtn" title="Herladen"><i class="ti ti-refresh"></i></button>
              </div>
            </div>

            <div id="joostCfgBody" style="padding:8px 4px 18px 4px">
              <div id="joostCfgLoading" style="color:var(--text-faint);font-size:13px;padding:14px 4px">Laden&hellip;</div>

              <div id="joostCfgForm" style="display:none">
                <div class="form-group">
                  <label class="form-label" for="joostCfgModule">Module</label>
                  <select id="joostCfgModule" class="form-input" style="max-width:280px">
                    <option value="finance">Finance (WhatsApp inbox)</option>
                  </select>
                  <div style="font-size:11px;color:var(--text-faint);margin-top:4px">In E1.0 alleen finance. Andere modules volgen in latere fasen.</div>
                </div>

                <div class="form-group">
                  <label class="form-label" for="joostCfgPersonaName">Persona-naam</label>
                  <input type="text" id="joostCfgPersonaName" class="form-input" style="max-width:360px" placeholder="bv. Joost" />
                  <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Naam waarmee Joost zichzelf intern aanduidt (niet de ondertekenaar voor klanten).</div>
                </div>

                <div class="form-group">
                  <label class="form-label" for="joostCfgTone">Tone</label>
                  <textarea id="joostCfgTone" class="form-input" rows="3" placeholder="bv. Vriendelijk, professioneel, kort en duidelijk. Geen overdreven beleefdheidsfrases."></textarea>
                  <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Korte beschrijving van de stijl. Wordt mee-geinjecteerd in het system prompt.</div>
                </div>

                <div class="form-group">
                  <label class="form-label" for="joostCfgSystemPrompt">System prompt</label>
                  <textarea id="joostCfgSystemPrompt" class="form-input" rows="12" placeholder="Je bent Joost, een AI-assistent voor de Finance-inbox..." style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:12.5px;line-height:1.5"></textarea>
                  <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Ondersteunt named placeholders zoals <code>{klant.naam}</code>, <code>{facturen.totaal_open_bedrag}</code>, <code>{afspraak.samenvatting}</code>, <code>{afdeling.ondertekenaar}</code>, <code>{bedrijf.naam}</code>.</div>
                </div>

                <div class="form-group">
                  <label class="form-label" for="joostCfgKnowledgeBase">Kennisbank (JSON)</label>
                  <textarea id="joostCfgKnowledgeBase" class="form-input" rows="10" placeholder='{ "facturen": { "betaaltermijn_dagen": 14 }, "regelingen": { "max_termijnen": 6 } }' style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:12.5px;line-height:1.5"></textarea>
                  <div id="joostCfgKbHint" style="font-size:11px;color:var(--text-faint);margin-top:4px">Vrije JSON-blob met feiten/regels die Joost mag aannemen. Wordt als referentie meegestuurd naar het model.</div>
                </div>

                <div class="form-group" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                  <div>
                    <label class="form-label" for="joostCfgModel">Model</label>
                    <select id="joostCfgModel" class="form-input">
                      <option value="claude-sonnet-4-6">claude-sonnet-4-6 (default)</option>
                      <option value="claude-opus-4-7">claude-opus-4-7 (krachtigst)</option>
                      <option value="claude-haiku-4-5">claude-haiku-4-5 (snel)</option>
                    </select>
                  </div>
                  <div>
                    <label class="form-label" for="joostCfgTemperature">Temperature <span id="joostCfgTemperatureVal" style="color:var(--text-faint);font-weight:400">0.30</span></label>
                    <input type="range" id="joostCfgTemperature" min="0" max="1" step="0.05" value="0.3" style="width:100%" />
                    <div style="font-size:11px;color:var(--text-faint);margin-top:4px">0.0 = strikt feitelijk, 1.0 = creatief. Aanbevolen 0.3&ndash;0.6 voor finance.</div>
                  </div>
                </div>

                <div class="form-group" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                  <div>
                    <label class="form-label" for="joostCfgContextCount">Context message count</label>
                    <input type="number" id="joostCfgContextCount" class="form-input" min="5" max="50" step="1" value="20" />
                    <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Aantal recente WhatsApp-berichten dat Joost mag inlezen als history (5&ndash;50).</div>
                  </div>
                  <div style="display:flex;align-items:flex-end">
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:6px">
                      <input type="checkbox" id="joostCfgEnabled" checked />
                      <span style="font-size:13px;font-weight:600">Actief (suggesties-paneel zichtbaar)</span>
                    </label>
                  </div>
                </div>

                <div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border);padding-top:14px;margin-top:6px">
                  <button class="btn btn-primary" type="button" id="joostCfgSaveBtn">Opslaan</button>
                </div>
              </div>
            </div>
          </div>
        </div><!-- /view-joost-algemeen -->

        <!-- Sub-tab: Autonomy -->
        <div id="view-joost-autonomy" style="display:none">
          <div class="fi-section-card" style="max-width:1040px">
            <div class="fi-section-header">
              <div>
                <div style="font-size:15px;font-weight:700">Autonomy &mdash; feature flags &amp; mandaat</div>
                <div style="font-size:12px;color:var(--text-faint);font-weight:400;margin-top:4px;max-width:780px">
                  Beheer feature flags voor E2.x (decision engine, reactive autonomy, arrangement-negotiation,
                  outbound executor). Stel per intent het gedrag in (disabled / draft / autonomous), definieer
                  het arrangement-mandaat en de communicatie-limieten.
                </div>
              </div>
              <div style="display:flex;gap:8px">
                <button class="btn btn-sm" type="button" id="joostAutoReloadBtn" title="Herladen"><i class="ti ti-refresh"></i></button>
              </div>
            </div>

            <div id="joostAutoBody" style="padding:8px 4px 18px 4px">
              <div id="joostAutoLoading" style="color:var(--text-faint);font-size:13px;padding:14px 4px">Laden&hellip;</div>

              <div id="joostAutoForm" style="display:none">
                <!-- (a) Feature flags -->
                <div class="form-group" style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px">
                  <div style="font-weight:700;font-size:13px;margin-bottom:10px">Feature flags</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                      <input type="checkbox" id="ffDecisionEngineLogs" />
                      <span style="font-size:13px"><code>e2_decision_engine_logs</code> (default aan)</span>
                    </label>
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                      <input type="checkbox" id="ffReactiveAutonomy" />
                      <span style="font-size:13px"><code>e2_reactive_autonomy</code></span>
                    </label>
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                      <input type="checkbox" id="ffArrangementNegotiation" />
                      <span style="font-size:13px"><code>e2_arrangement_negotiation</code></span>
                    </label>
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                      <input type="checkbox" id="ffOutboundExecutor" />
                      <span style="font-size:13px"><code>e2_outbound_executor</code></span>
                    </label>
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                      <input type="checkbox" id="ffOutboundCron" />
                      <span style="font-size:13px"><code>e2_outbound_cron</code></span>
                    </label>
                  </div>
                </div>

                <!-- (b) Intent config (6 cards) -->
                <div class="form-group" style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px">
                  <div style="font-weight:700;font-size:13px;margin-bottom:10px">Intents &mdash; modus per intent</div>
                  <div style="font-size:11px;color:var(--text-faint);margin-bottom:12px">
                    Per intent: <code>disabled</code> = niet uitvoeren, <code>draft</code> = suggestie voor medewerker,
                    <code>autonomous</code> = Joost handelt zelf (binnen mandaat + limieten).
                  </div>
                  <div id="joostIntentCards" style="display:grid;grid-template-columns:1fr 1fr;gap:12px"></div>
                </div>

                <!-- (c) Arrangement mandate -->
                <div class="form-group" style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px">
                  <div style="font-weight:700;font-size:13px;margin-bottom:10px">Arrangement-mandaat</div>
                  <div style="font-size:11px;color:var(--text-faint);margin-bottom:12px">
                    Grenzen waarbinnen Joost arrangementen zelfstandig mag voorstellen / aanvaarden.
                  </div>
                  <div style="margin-bottom:12px">
                    <div style="font-size:12px;font-weight:600;margin-bottom:6px">Toegestane types</div>
                    <div id="joostMandateAllowedTypes" style="display:flex;flex-wrap:wrap;gap:10px">
                      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-mandate-type="UITSTEL" /> <span style="font-size:12px">UITSTEL</span></label>
                      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-mandate-type="SPLITSING" /> <span style="font-size:12px">SPLITSING</span></label>
                      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-mandate-type="ABONNEMENT_PAUZE" /> <span style="font-size:12px">ABONNEMENT_PAUZE</span></label>
                      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-mandate-type="ABONNEMENT_STOP" /> <span style="font-size:12px">ABONNEMENT_STOP</span></label>
                      <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-mandate-type="KWIJTSCHELDING" /> <span style="font-size:12px">KWIJTSCHELDING</span></label>
                    </div>
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                    <div>
                      <label class="form-label" for="mandateMaxTermijnen">max_termijnen</label>
                      <input type="number" id="mandateMaxTermijnen" class="form-input" min="1" max="24" step="1" value="6" />
                    </div>
                    <div>
                      <label class="form-label" for="mandateMinTermijnBedrag">min_termijn_bedrag (&euro;)</label>
                      <input type="number" id="mandateMinTermijnBedrag" class="form-input" min="0" step="0.01" value="25" />
                    </div>
                    <div>
                      <label class="form-label" for="mandateMaxUitstelDagen">max_uitstel_dagen</label>
                      <input type="number" id="mandateMaxUitstelDagen" class="form-input" min="0" step="1" value="30" />
                    </div>
                    <div>
                      <label class="form-label" for="mandateMinToNegotiate">min_to_negotiate (&euro;)</label>
                      <input type="number" id="mandateMinToNegotiate" class="form-input" min="0" step="0.01" value="50" />
                    </div>
                    <div>
                      <label class="form-label" for="mandateMaxAutoPropose">max_auto_propose / dag</label>
                      <input type="number" id="mandateMaxAutoPropose" class="form-input" min="0" step="1" value="5" />
                    </div>
                  </div>
                </div>

                <!-- (d) Communication limits -->
                <div class="form-group" style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px">
                  <div style="font-weight:700;font-size:13px;margin-bottom:10px">Communicatie-limieten</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                    <div>
                      <label class="form-label" for="commMaxPerDay">max_per_day</label>
                      <input type="number" id="commMaxPerDay" class="form-input" min="0" step="1" value="3" />
                    </div>
                    <div>
                      <label class="form-label" for="commMaxTotal">max_total (per conv)</label>
                      <input type="number" id="commMaxTotal" class="form-input" min="0" step="1" value="10" title="max_messages_per_conversation_total — maximum aantal berichten dat Joost in één conversatie mag sturen; bij bereiken volgt een taak in Open Acties" />
                    </div>
                    <div>
                      <label class="form-label" for="commMinSecondsBetween">cooldown (seconden)</label>
                      <input type="number" id="commMinSecondsBetween" class="form-input" min="0" step="1" value="3600" title="cooldown_after_outbound_seconds — minimaal aantal seconden tussen twee opeenvolgende outbound-berichten in dezelfde conversatie (no-drift default = 3600 = 1 uur; finance zit op 30s via de canoniseren-migratie)" />
                    </div>
                  </div>
                  <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:12px;align-items:end;margin-top:10px">
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:6px">
                      <input type="checkbox" id="commOfficeHoursOnly" />
                      <span style="font-size:13px;font-weight:600">office_hours_only</span>
                    </label>
                    <div>
                      <label class="form-label" for="commOfficeStart">office_start</label>
                      <input type="time" id="commOfficeStart" class="form-input" value="08:30" />
                    </div>
                    <div>
                      <label class="form-label" for="commOfficeEnd">office_end</label>
                      <input type="time" id="commOfficeEnd" class="form-input" value="18:00" />
                    </div>
                  </div>
                </div>

                <!-- (e) Personality -->
                <div class="form-group" style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px">
                  <div style="font-weight:700;font-size:13px;margin-bottom:10px">Persoonlijkheid</div>
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:end">
                    <div>
                      <label class="form-label" for="personalityMaxSentences">max_sentences</label>
                      <input type="number" id="personalityMaxSentences" class="form-input" min="1" max="10" step="1" value="3" />
                    </div>
                    <div>
                      <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:6px">
                        <input type="checkbox" id="personalityUseEmojis" />
                        <span style="font-size:13px;font-weight:600">use_emojis</span>
                      </label>
                    </div>
                  </div>
                </div>

                <!-- (f) Outbound -->
                <div class="form-group" style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px">
                  <div style="font-weight:700;font-size:13px;margin-bottom:10px">Outbound</div>
                  <div style="display:grid;grid-template-columns:1fr;gap:12px">
                    <div>
                      <label class="form-label" for="outboundMaxPerConvPerDay">max_outbound_per_conv_per_day</label>
                      <input type="number" id="outboundMaxPerConvPerDay" class="form-input" style="max-width:240px" min="0" step="1" value="2" />
                    </div>
                  </div>
                </div>

                <!-- (g) No-reply reminders (Joost fase 2) -->
                <div class="form-group" style="border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:14px">
                  <div style="font-weight:700;font-size:13px;margin-bottom:10px">Gesprek pauzeert de aanmaningen (no_reply)</div>
                  <div style="font-size:11px;color:var(--text-faint);margin-bottom:12px">
                    Zodra een klant reageert, pauzeert de aanmaningsflow. Blijft de klant stil, dan volgen 2 reminders en daarna hervat de flow.
                  </div>
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                    <div>
                      <label class="form-label" for="noReplyReminder1Hours">reminder_1_hours</label>
                      <input type="number" id="noReplyReminder1Hours" class="form-input" min="0" step="1" value="20" title="Uren na laatste klant-inbound → reminder 1 (vrij bericht, mits venster open)" />
                    </div>
                    <div>
                      <label class="form-label" for="noReplyReminder2Hours">reminder_2_hours</label>
                      <input type="number" id="noReplyReminder2Hours" class="form-input" min="0" step="1" value="24" title="Uren na reminder 1 → reminder 2 (Meta-template)" />
                    </div>
                    <div>
                      <label class="form-label" for="noReplyResumeAfterHours">resume_after_hours</label>
                      <input type="number" id="noReplyResumeAfterHours" class="form-input" min="0" step="1" value="24" title="Uren na reminder 2 → aanmaningsflow hervat (mits geen actief arrangement)" />
                    </div>
                  </div>
                  <div style="margin-top:10px">
                    <label class="form-label" for="noReplyReminder2TemplateName">reminder_2_template_name (Meta approved)</label>
                    <input type="text" id="noReplyReminder2TemplateName" class="form-input" placeholder="joost_reminder_2_nl" title="Naam van de goedgekeurde Meta-template. Zonder deze naam wordt reminder 2 overgeslagen." />
                  </div>
                </div>

                <div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border);padding-top:14px;margin-top:6px">
                  <button class="btn btn-primary" type="button" id="joostAutoSaveBtn">Opslaan</button>
                </div>
              </div>
            </div>
          </div>
        </div><!-- /view-joost-autonomy -->

        <!-- Sub-tab: Decision Log -->
        <div id="view-joost-decisions" style="display:none">
          <div class="fi-section-card" style="max-width:1200px">
            <div class="fi-section-header">
              <div>
                <div style="font-size:15px;font-weight:700">Decision Log</div>
                <div style="font-size:12px;color:var(--text-faint);font-weight:400;margin-top:4px;max-width:780px">
                  Laatste 50 autonomy-decisions van Joost. Auto-refresh elke 30s. Klik op een rij om het
                  volledige <code>decision_log</code>-blob uit te klappen.
                </div>
              </div>
              <div style="display:flex;gap:8px;align-items:center">
                <span id="joostDecisionsRefreshNote" style="font-size:11px;color:var(--text-faint)"></span>
                <button class="btn btn-sm" type="button" id="joostDecisionsReloadBtn" title="Herladen"><i class="ti ti-refresh"></i></button>
              </div>
            </div>
            <div id="joostDecisionsBody" style="padding:8px 4px 18px 4px">
              <div id="joostDecisionsLoading" style="color:var(--text-faint);font-size:13px;padding:14px 4px">Laden&hellip;</div>
              <div id="joostDecisionsTableWrap" style="display:none;overflow-x:auto">
                <table class="data-table" style="width:100%;font-size:12.5px">
                  <thead>
                    <tr>
                      <th style="text-align:left">Tijd</th>
                      <th style="text-align:left">Conv</th>
                      <th style="text-align:left">Suggestion</th>
                      <th style="text-align:left">Intent</th>
                      <th style="text-align:left">Decision</th>
                      <th style="text-align:left">Reden</th>
                    </tr>
                  </thead>
                  <tbody id="joostDecisionsTbody"></tbody>
                </table>
              </div>
              <div id="joostDecisionsEmpty" style="display:none;color:var(--text-faint);font-size:13px;padding:14px 4px">Nog geen autonomy-decisions geregistreerd.</div>
            </div>
          </div>
        </div><!-- /view-joost-decisions -->
      </div>
    `;
  }

  // ── Joost wiring ──────────────────────────────────────────────────────────
  function wireJoostOnce() {
    if (_joost.cfgWired) return;
    _joost.cfgWired = true;
    const host = _state.hostMounted;

    // Temperature slider sync.
    const slider = host.querySelector('#joostCfgTemperature');
    const out = host.querySelector('#joostCfgTemperatureVal');
    if (slider && out) {
      const sync = () => { out.textContent = Number(slider.value).toFixed(2); };
      slider.addEventListener('input', sync);
      sync();
    }

    // KB JSON-validate.
    const kb = host.querySelector('#joostCfgKnowledgeBase');
    const hint = host.querySelector('#joostCfgKbHint');
    if (kb && hint) {
      kb.addEventListener('input', () => {
        const v = kb.value.trim();
        if (!v) { hint.textContent = 'Vrije JSON-blob met feiten/regels die Joost mag aannemen. Wordt als referentie meegestuurd naar het model.'; hint.style.color = ''; return; }
        try { JSON.parse(v); hint.textContent = 'JSON is geldig.'; hint.style.color = 'var(--success, #1D9E75)'; }
        catch (e) { hint.textContent = 'JSON ongeldig: ' + e.message; hint.style.color = 'var(--danger, #d33)'; }
      });
    }

    // Sub-tab strip click handlers.
    host.querySelectorAll('[data-joost-sub]').forEach(b => {
      b.addEventListener('click', () => switchJoostSubTab(b.dataset.joostSub));
    });

    // Reload + Save knoppen.
    host.querySelector('#joostCfgReloadBtn')?.addEventListener('click', loadJoostConfig);
    host.querySelector('#joostCfgSaveBtn')?.addEventListener('click', saveJoostConfig);
    host.querySelector('#joostAutoReloadBtn')?.addEventListener('click', loadJoostAutonomyConfig);
    host.querySelector('#joostAutoSaveBtn')?.addEventListener('click', saveJoostAutonomyConfig);
    host.querySelector('#joostDecisionsReloadBtn')?.addEventListener('click', loadDecisionLog);
  }

  function switchJoostSubTab(sub) {
    const host = _state.hostMounted;
    if (!host) return;
    host.querySelectorAll('[data-joost-sub]').forEach(b => {
      b.classList.toggle('active', b.dataset.joostSub === sub);
    });
    const algemeen  = host.querySelector('#view-joost-algemeen');
    const autonomy  = host.querySelector('#view-joost-autonomy');
    const decisions = host.querySelector('#view-joost-decisions');
    if (algemeen)  algemeen.style.display  = sub === 'algemeen'  ? '' : 'none';
    if (autonomy)  autonomy.style.display  = sub === 'autonomy'  ? '' : 'none';
    if (decisions) decisions.style.display = sub === 'decisions' ? '' : 'none';

    // Auto-load + auto-refresh management.
    if (_joost.decisionsTimer) { clearInterval(_joost.decisionsTimer); _joost.decisionsTimer = null; }
    if (sub === 'autonomy') {
      if (!_joost.autonomyLoadedOnce) loadJoostAutonomyConfig();
    } else if (sub === 'decisions') {
      loadDecisionLog();
      _joost.decisionsTimer = setInterval(() => { loadDecisionLog(); }, 30000);
    }
  }

  // ─── Joost: Algemeen load/save ───────────────────────────────────────────
  async function loadJoostConfig() {
    const host = _state.hostMounted; if (!host) return;
    const loading = host.querySelector('#joostCfgLoading');
    const form = host.querySelector('#joostCfgForm');
    if (loading) loading.style.display = '';
    if (form) form.style.display = 'none';
    const moduleKey = (host.querySelector('#joostCfgModule')?.value) || 'finance';
    try {
      const r = await window.AgentShared.apiFetch('/api/joost-config-get?module=' + encodeURIComponent(moduleKey));
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast('Laden mislukt: ' + (data.error || r.status), 'error');
        if (loading) loading.textContent = 'Fout bij laden: ' + (data.error || r.status);
        return;
      }
      const cfg = data.config || data || {};
      setVal('joostCfgModule', cfg.module || moduleKey);
      setVal('joostCfgPersonaName', cfg.persona_name || 'Joost');
      setVal('joostCfgTone', cfg.persona_tone || '');
      setVal('joostCfgSystemPrompt', cfg.system_prompt_template || '');
      setVal('joostCfgKnowledgeBase', cfg.knowledge_base ? JSON.stringify(cfg.knowledge_base, null, 2) : '');
      setVal('joostCfgModel', cfg.model || 'claude-sonnet-4-6');
      const temp = (typeof cfg.temperature === 'number') ? Number(cfg.temperature) : 0.3;
      setVal('joostCfgTemperature', String(temp));
      const tempOut = host.querySelector('#joostCfgTemperatureVal');
      if (tempOut) tempOut.textContent = Number(temp).toFixed(2);
      const ctxCount = (typeof cfg.context_message_count === 'number' && cfg.context_message_count > 0)
        ? cfg.context_message_count : 20;
      setVal('joostCfgContextCount', String(ctxCount));
      const en = host.querySelector('#joostCfgEnabled');
      if (en) en.checked = (cfg.is_enabled === false) ? false : true;
      if (loading) loading.style.display = 'none';
      if (form) form.style.display = '';
      _joost.cfgLoadedOnce = true;
    } catch (e) {
      toast('Laden mislukt: ' + e.message, 'error');
      if (loading) loading.textContent = 'Fout bij laden: ' + e.message;
    }
    function setVal(id, v) {
      const el = host.querySelector('#' + id);
      if (el) el.value = v == null ? '' : v;
    }
  }

  async function saveJoostConfig() {
    const host = _state.hostMounted; if (!host) return;
    const moduleKey = (host.querySelector('#joostCfgModule')?.value || 'finance').trim();
    const personaName = (host.querySelector('#joostCfgPersonaName')?.value || '').trim();
    // BELANGRIJK: server verwacht persona_tone + system_prompt_template (zie
    // api/joost-config-upsert.js), niet tone/system_prompt.
    const personaTone = (host.querySelector('#joostCfgTone')?.value || '').trim();
    const systemPromptTemplate = (host.querySelector('#joostCfgSystemPrompt')?.value || '').trim();
    const kbRaw = (host.querySelector('#joostCfgKnowledgeBase')?.value || '').trim();
    const model = (host.querySelector('#joostCfgModel')?.value || 'claude-sonnet-4-6').trim();
    const temperature = Number(host.querySelector('#joostCfgTemperature')?.value || '0.3');
    const contextCount = Math.max(5, Math.min(50, parseInt(host.querySelector('#joostCfgContextCount')?.value || '20', 10) || 20));
    const isEnabled = !!host.querySelector('#joostCfgEnabled')?.checked;

    if (!personaName) { toast('Persona-naam is verplicht', 'error'); return; }
    if (!systemPromptTemplate) { toast('System prompt is verplicht', 'error'); return; }

    let knowledgeBase = null;
    if (kbRaw) {
      try { knowledgeBase = JSON.parse(kbRaw); }
      catch (e) {
        toast('Kennisbank JSON ongeldig: ' + e.message, 'error');
        return;
      }
    }

    const btn = host.querySelector('#joostCfgSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Opslaan…'; }
    try {
      const payload = {
        module: moduleKey,
        persona_name: personaName,
        persona_tone: personaTone,
        system_prompt_template: systemPromptTemplate,
        model,
        temperature,
        context_message_count: contextCount,
        is_enabled: isEnabled,
      };
      if (knowledgeBase && typeof knowledgeBase === 'object' && !Array.isArray(knowledgeBase)) {
        payload.knowledge_base = knowledgeBase;
      }
      const r = await window.AgentShared.apiFetch('/api/joost-config-upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast('Opslaan mislukt: ' + (data.error || r.status), 'error');
        return;
      }
      toast('Configuratie opgeslagen', 'success');
      try { await loadJoostConfig(); } catch (_) { /* fail-soft */ }
    } catch (e) {
      toast('Opslaan mislukt: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Opslaan'; }
    }
  }

  // ─── Joost: Autonomy ─────────────────────────────────────────────────────
  function _renderJoostIntentCards(intentCfg) {
    const host = _state.hostMounted; if (!host) return;
    const wrap = host.querySelector('#joostIntentCards');
    if (!wrap) return;
    const cfg = (intentCfg && typeof intentCfg === 'object') ? intentCfg : {};
    wrap.innerHTML = JOOST_INTENTS.map(i => {
      const row = cfg[i.key] || {};
      const mode = row.mode || 'disabled';
      const conf = (typeof row.confidence_threshold === 'number') ? row.confidence_threshold : 0.75;
      const maxMsg = (typeof row.max_messages_per_conv === 'number') ? row.max_messages_per_conv : 5;
      const maxMsgBlock = i.hasMaxMsg
        ? `<div style="margin-top:6px"><label class="form-label" style="font-size:11px" for="intent_${i.key}_maxmsg">max_messages_per_conv</label>
           <input type="number" id="intent_${i.key}_maxmsg" class="form-input" min="0" step="1" value="${maxMsg}" data-intent="${i.key}" data-field="max_messages_per_conv" /></div>`
        : '';
      return `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--bg-soft, transparent)">
          <div style="font-weight:700;font-size:12.5px;margin-bottom:8px"><code>${i.label}</code></div>
          <div style="margin-bottom:6px">
            <label class="form-label" style="font-size:11px" for="intent_${i.key}_mode">mode</label>
            <select id="intent_${i.key}_mode" class="form-input" data-intent="${i.key}" data-field="mode">
              <option value="disabled" ${mode==='disabled'?'selected':''}>disabled</option>
              <option value="draft" ${mode==='draft'?'selected':''}>draft</option>
              <option value="autonomous" ${mode==='autonomous'?'selected':''}>autonomous</option>
            </select>
          </div>
          <div>
            <label class="form-label" style="font-size:11px" for="intent_${i.key}_conf">confidence_threshold</label>
            <input type="number" id="intent_${i.key}_conf" class="form-input" min="0" max="1" step="0.01" value="${conf}" data-intent="${i.key}" data-field="confidence_threshold" />
          </div>
          ${maxMsgBlock}
        </div>`;
    }).join('');
  }

  function _collectIntentCfg() {
    const host = _state.hostMounted; if (!host) return {};
    const out = {};
    JOOST_INTENTS.forEach(i => {
      const mode = host.querySelector('#intent_' + i.key + '_mode')?.value || 'disabled';
      const conf = Number(host.querySelector('#intent_' + i.key + '_conf')?.value || '0.75');
      const row = { mode, confidence_threshold: isFinite(conf) ? conf : 0.75 };
      if (i.hasMaxMsg) {
        const mx = parseInt(host.querySelector('#intent_' + i.key + '_maxmsg')?.value || '5', 10);
        row.max_messages_per_conv = isFinite(mx) ? mx : 5;
      }
      out[i.key] = row;
    });
    return out;
  }

  // KEY-CONTRACT voor autonomy_config: zie de header van
  // api/joost-autonomy-evaluate.js. UI, seeds en migraties gebruiken EXACT
  // dezelfde keys als de decision-engine leest. Dit blok (load + save)
  // implementeert dat contract voor Joost/finance; fallback-ladders zijn
  // uitsluitend voor rijen die nog niet door de canoniseren-migratie zijn.
  async function loadJoostAutonomyConfig() {
    const host = _state.hostMounted; if (!host) return;
    const loading = host.querySelector('#joostAutoLoading');
    const form = host.querySelector('#joostAutoForm');
    if (loading) loading.style.display = '';
    if (form) form.style.display = 'none';
    const moduleKey = (host.querySelector('#joostCfgModule')?.value) || 'finance';
    try {
      const r = await window.AgentShared.apiFetch('/api/joost-config-get?module=' + encodeURIComponent(moduleKey));
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast('Laden autonomy mislukt: ' + (data.error || r.status), 'error');
        if (loading) loading.textContent = 'Fout bij laden: ' + (data.error || r.status);
        return;
      }
      const cfg = data.config || data || {};
      const ff = (cfg.feature_flags && typeof cfg.feature_flags === 'object') ? cfg.feature_flags : {};
      const ac = (cfg.autonomy_config && typeof cfg.autonomy_config === 'object') ? cfg.autonomy_config : {};
      // Bewaar snapshot zodat save de sub-keys kan behouden die de UI niet
      // rendert (zoals uitstel.auto_approve_if_within, splitsing.enabled,
      // office_hours_tz, office_hours_days). Zonder deze snapshot zou een
      // save die sub-keys weggooien -> engine valt terug op code-defaults.
      _joost.lastAutonomyConfig = ac;

      const setChk = (id, val) => { const el = host.querySelector('#' + id); if (el) el.checked = !!val; };
      setChk('ffDecisionEngineLogs',     ff.e2_decision_engine_logs === undefined ? true : !!ff.e2_decision_engine_logs);
      setChk('ffReactiveAutonomy',       !!ff.e2_reactive_autonomy);
      setChk('ffArrangementNegotiation', !!ff.e2_arrangement_negotiation);
      setChk('ffOutboundExecutor',       !!ff.e2_outbound_executor);
      setChk('ffOutboundCron',           !!ff.e2_outbound_cron);

      _renderJoostIntentCards(ac.intents || {});

      const mandate = ac.arrangement_mandate || {};
      const allowed = Array.isArray(mandate.allowed_types) ? mandate.allowed_types : [];
      host.querySelectorAll('#joostMandateAllowedTypes input[data-mandate-type]').forEach(cb => {
        cb.checked = allowed.includes(cb.dataset.mandateType);
      });
      const setVal = (id, v, def) => { const el = host.querySelector('#' + id); if (el) el.value = (v == null || v === '') ? def : v; };
      // NB: canonical keys sinds fix/joost-config-key-mismatch — de UI schreef
      // voorheen naar keys die de decision-engine (joost-autonomy-evaluate)
      // niet las. `max_termijnen` en `max_uitstel_dagen` zitten canonical
      // GENESTE onder splitsing.* / uitstel.*. Fallback op de oude (foute)
      // keys blijft voor legacy-rijen die nog niet door de migratie gegaan
      // zijn — dan zien we tenminste iets zinnigs i.p.v. de default.
      const _splitsing = mandate.splitsing || {};
      const _uitstel   = mandate.uitstel   || {};
      setVal('mandateMaxTermijnen',     _splitsing.max_termijnen_total ?? mandate.max_termijnen,        6);
      setVal('mandateMinTermijnBedrag', mandate.min_termijn_bedrag,   25);  // geen canonical equivalent — informatief veld
      setVal('mandateMaxUitstelDagen',  _uitstel.max_dagen_total ?? mandate.max_uitstel_dagen,    30);
      setVal('mandateMinToNegotiate',   mandate.min_total_amount_to_negotiate_eur ?? mandate.min_to_negotiate,     50);
      setVal('mandateMaxAutoPropose',   mandate.max_total_amount_to_auto_propose_eur ?? mandate.max_auto_propose,   5);

      const comm = ac.communication_limits || {};
      // KEY-CONTRACT: zie api/joost-autonomy-evaluate.js. Fallback-ladder voor
      // rijen die nog niet gemigreerd zijn (2026-07-15-joost-config-keys-canoniseren):
      //   per_day  : max_messages_per_conversation_per_day > max_messages_per_conv_per_day > max_per_day
      //   total    : max_messages_per_conversation_total   > max_messages_per_conv_total   > max_total
      //   cooldown : cooldown_after_outbound_seconds > cooldown_after_outbound_minutes*60
      //              > min_seconds_between > min_seconds_between_messages
      setVal('commMaxPerDay', comm.max_messages_per_conversation_per_day
                              ?? comm.max_messages_per_conv_per_day
                              ?? comm.max_per_day, 3);
      setVal('commMaxTotal',  comm.max_messages_per_conversation_total
                              ?? comm.max_messages_per_conv_total
                              ?? comm.max_total, 10);
      const _cooldownSec = (typeof comm.cooldown_after_outbound_seconds === 'number')
        ? comm.cooldown_after_outbound_seconds
        : (typeof comm.cooldown_after_outbound_minutes === 'number')
          ? comm.cooldown_after_outbound_minutes * 60
          : (typeof comm.min_seconds_between === 'number')
            ? comm.min_seconds_between
            : (typeof comm.min_seconds_between_messages === 'number')
              ? comm.min_seconds_between_messages
              : null;
      // No-drift defaults: matchen evaluateAutonomy fallback (3600s cooldown,
      // 08:30-18:00 office-hours). Finance's productie-waarden zitten in de
      // DB en overrulen deze defaults; overige modules zien hier de code-
      // default terug.
      setVal('commMinSecondsBetween', _cooldownSec, 3600);
      setChk('commOfficeHoursOnly',   comm.office_hours_only !== false);
      setVal('commOfficeStart',       comm.office_hours_start ?? comm.office_start, '08:30');
      setVal('commOfficeEnd',         comm.office_hours_end   ?? comm.office_end,   '18:00');

      const pers = ac.personality || {};
      setVal('personalityMaxSentences', pers.max_sentences, 3);
      setChk('personalityUseEmojis', !!pers.use_emojis);

      const outb = ac.outbound || {};
      setVal('outboundMaxPerConvPerDay', outb.max_outbound_per_conv_per_day, 2);

      // Joost fase 2 — no_reply reminders. Canonical keys volgens KEY-CONTRACT.
      const noReply = ac.no_reply || {};
      setVal('noReplyReminder1Hours',   noReply.reminder_1_hours,   20);
      setVal('noReplyReminder2Hours',   noReply.reminder_2_hours,   24);
      setVal('noReplyResumeAfterHours', noReply.resume_after_hours, 24);
      const tmplName = noReply.reminder_2_template_name;
      const tmplInput = host.querySelector('#noReplyReminder2TemplateName');
      if (tmplInput) tmplInput.value = (tmplName == null || tmplName === '') ? '' : String(tmplName);

      if (loading) loading.style.display = 'none';
      if (form) form.style.display = '';
      _joost.autonomyLoadedOnce = true;
    } catch (e) {
      toast('Laden autonomy mislukt: ' + e.message, 'error');
      if (loading) loading.textContent = 'Fout bij laden: ' + e.message;
    }
  }

  async function saveJoostAutonomyConfig() {
    const host = _state.hostMounted; if (!host) return;
    const moduleKey = (host.querySelector('#joostCfgModule')?.value || 'finance').trim();

    const getChk = id => !!host.querySelector('#' + id)?.checked;
    const feature_flags = {
      e2_decision_engine_logs:    getChk('ffDecisionEngineLogs'),
      e2_reactive_autonomy:       getChk('ffReactiveAutonomy'),
      e2_arrangement_negotiation: getChk('ffArrangementNegotiation'),
      e2_outbound_executor:       getChk('ffOutboundExecutor'),
      e2_outbound_cron:           getChk('ffOutboundCron'),
    };

    const intents = _collectIntentCfg();

    const allowed_types = Array.from(host.querySelectorAll('#joostMandateAllowedTypes input[data-mandate-type]'))
      .filter(cb => cb.checked).map(cb => cb.dataset.mandateType);
    const numVal = (id, def) => {
      const n = Number(host.querySelector('#' + id)?.value);
      return isFinite(n) ? n : def;
    };
    // ── SAVE: canonical keys (fix/joost-config-key-mismatch) ──────────────
    // De decision-engine (api/joost-autonomy-evaluate.js) leest deze keys:
    //   arrangement_mandate.min_total_amount_to_negotiate_eur
    //   arrangement_mandate.max_total_amount_to_auto_propose_eur
    //   arrangement_mandate.uitstel.max_dagen_total
    //   arrangement_mandate.splitsing.max_termijnen_total
    //   communication_limits.max_messages_per_conversation_per_day
    //   communication_limits.max_messages_per_conversation_total
    //   communication_limits.cooldown_after_outbound_minutes
    //   communication_limits.office_hours_start / _end (en _tz / _days)
    //
    // Behoud van seed-nested velden (auto_approve_if_within, enabled etc):
    // we mergen ONZE waarden in bestaande sub-objecten zodat een save via de
    // UI de andere sub-keys niet weggooit. `_currentAutonomyCfg` is de
    // laatst geladen snapshot (loadJoostAutonomyConfig zet 'm impliciet
    // door setVal — we lezen 't uit de sub-objecten die op _joost hangen).
    const _currentAc = (_joost && _joost.lastAutonomyConfig && typeof _joost.lastAutonomyConfig === 'object')
      ? _joost.lastAutonomyConfig : {};
    const _currentMandate = _currentAc.arrangement_mandate || {};
    const _currentComm    = _currentAc.communication_limits || {};

    const arrangement_mandate = {
      ..._currentMandate,
      allowed_types,
      min_total_amount_to_negotiate_eur:  numVal('mandateMinToNegotiate', 50),
      max_total_amount_to_auto_propose_eur: numVal('mandateMaxAutoPropose', 5),
      // Genesteld: behoud eventuele bestaande sub-keys (auto_approve_if_within etc).
      uitstel: {
        ...(_currentMandate.uitstel || {}),
        max_dagen_total: numVal('mandateMaxUitstelDagen', 30),
      },
      splitsing: {
        ...(_currentMandate.splitsing || {}),
        max_termijnen_total: numVal('mandateMaxTermijnen', 6),
      },
      // Informatief veld dat geen canonical-tegenhanger heeft (semantiek:
      // absoluut bedrag, canonical splitsing.min_eerste_termijn_pct is percentage).
      // Blijft in de blob staan voor UI-continuïteit maar wordt door engine
      // niet gebruikt. TODO in separate PR: verbergen of omzetten naar pct.
      min_termijn_bedrag: numVal('mandateMinTermijnBedrag', 25),
    };

    // KEY-CONTRACT: zie api/joost-autonomy-evaluate.js. Canonical eenheid
    // voor cooldown = SECONDEN (was tijdelijk minutes in eerdere iteratie,
    // toen bleek onnodig grof). Sub-object merge (`..._currentComm`) zorgt
    // dat andere seed-sub-keys (office_hours_tz / _days / no_reply_pause_*)
    // niet wegvallen bij een UI-save.
    // No-drift-defaults: fallback-values matchen evaluateAutonomy's defaults
    // zodat een form-save met leeg input identiek gedrag oplevert als "geen
    // key in DB". Sub-object merge (`..._currentComm`) zorgt dat andere
    // seed-sub-keys (office_hours_tz / _days / no_reply_pause_*) niet
    // wegvallen bij een UI-save.
    const communication_limits = {
      ..._currentComm,
      max_messages_per_conversation_per_day: numVal('commMaxPerDay', 3),
      max_messages_per_conversation_total:   numVal('commMaxTotal', 20),
      cooldown_after_outbound_seconds:       numVal('commMinSecondsBetween', 3600),
      office_hours_only:                     getChk('commOfficeHoursOnly'),
      office_hours_start:                    (host.querySelector('#commOfficeStart')?.value || '08:30'),
      office_hours_end:                      (host.querySelector('#commOfficeEnd')?.value   || '18:00'),
    };

    const personality = {
      max_sentences: numVal('personalityMaxSentences', 3),
      use_emojis:    getChk('personalityUseEmojis'),
    };

    // Outbound: no_reply_days_per_step is opgeruimd (dood — nergens gelezen).
    // Behoud eventuele andere sub-keys (enabled, allowed_templates, etc) via
    // spread van de bestaande waarde uit de snapshot.
    const outbound = {
      ...(_currentAc.outbound || {}),
      max_outbound_per_conv_per_day: numVal('outboundMaxPerConvPerDay', 2),
    };
    // Verwijder expliciet de dode key als 'ie nog uit een oude save meekomt.
    delete outbound.no_reply_days_per_step;

    // Joost fase 2 — no_reply reminders (canonical keys).
    const _tmplRaw = (host.querySelector('#noReplyReminder2TemplateName')?.value || '').trim();
    const no_reply = {
      ...(_currentAc.no_reply || {}),
      reminder_1_hours:         numVal('noReplyReminder1Hours', 20),
      reminder_2_hours:         numVal('noReplyReminder2Hours', 24),
      resume_after_hours:       numVal('noReplyResumeAfterHours', 24),
      reminder_2_template_name: _tmplRaw ? _tmplRaw : null,
    };

    const autonomy_config = {
      ..._currentAc,
      intents,
      arrangement_mandate,
      communication_limits,
      personality,
      outbound,
      no_reply,
    };

    const btn = host.querySelector('#joostAutoSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Opslaan…'; }
    try {
      const payload = {
        module: moduleKey,
        autonomy_config,
        feature_flags,
      };
      const r = await window.AgentShared.apiFetch('/api/joost-config-upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast('Opslaan autonomy mislukt: ' + (data.error || r.status), 'error');
        return;
      }
      toast('Autonomy-config opgeslagen', 'success');
      try { await loadJoostAutonomyConfig(); } catch (_) { /* fail-soft */ }
    } catch (e) {
      toast('Opslaan autonomy mislukt: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Opslaan'; }
    }
  }

  // ─── Joost: Decision Log ─────────────────────────────────────────────────
  function _fmtDecisionTs(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      const pad = n => String(n).padStart(2, '0');
      return pad(d.getDate()) + '-' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    } catch (_) { return String(ts); }
  }

  function _truncId(id) {
    if (!id) return '';
    const s = String(id);
    return s.length > 8 ? s.slice(0, 8) + '…' : s;
  }

  function renderDecisionRow(row) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    const decision = String(row.decision || '').toLowerCase();
    const color = decision === 'allow' ? 'var(--success, #1D9E75)'
                : decision === 'block' ? 'var(--danger, #d33)'
                : 'var(--text-faint)';
    const convShort = _truncId(row.conversation_id || row.conv_id);
    const sugShort = _truncId(row.suggestion_id);
    const intent = row.intent || '';
    const reason = row.reason || '';
    const reasonShort = reason.length > 80 ? reason.slice(0, 80) + '…' : reason;

    tr.innerHTML = `
      <td style="white-space:nowrap;font-family:'SFMono-Regular',Consolas,monospace;font-size:11.5px">${esc(_fmtDecisionTs(row.created_at || row.ts))}</td>
      <td style="font-family:'SFMono-Regular',Consolas,monospace;font-size:11.5px" title="${esc(row.conversation_id || row.conv_id || '')}">${esc(convShort)}</td>
      <td style="font-family:'SFMono-Regular',Consolas,monospace;font-size:11.5px" title="${esc(row.suggestion_id || '')}">${esc(sugShort)}</td>
      <td><code style="font-size:11.5px">${esc(intent)}</code></td>
      <td><span style="font-weight:700;color:${color};text-transform:uppercase">${esc(decision)}</span></td>
      <td style="font-size:12px">${esc(reasonShort)}</td>
    `;
    const detailTr = document.createElement('tr');
    detailTr.style.display = 'none';
    const detailTd = document.createElement('td');
    detailTd.colSpan = 6;
    detailTd.style.background = 'var(--bg-soft, transparent)';
    detailTd.style.padding = '10px 12px';
    const log = row.decision_log != null ? row.decision_log : { reason: row.reason };
    let pretty = '';
    try { pretty = JSON.stringify(log, null, 2); }
    catch (_) { pretty = String(log); }
    detailTd.innerHTML = `<pre style="margin:0;font-family:'SFMono-Regular',Consolas,monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-word">${esc(pretty)}</pre>`;
    detailTr.appendChild(detailTd);

    tr.addEventListener('click', () => {
      detailTr.style.display = (detailTr.style.display === 'none') ? '' : 'none';
    });

    return [tr, detailTr];
  }

  async function loadDecisionLog() {
    const host = _state.hostMounted; if (!host) return;
    const loading = host.querySelector('#joostDecisionsLoading');
    const wrap = host.querySelector('#joostDecisionsTableWrap');
    const empty = host.querySelector('#joostDecisionsEmpty');
    const tbody = host.querySelector('#joostDecisionsTbody');
    const note = host.querySelector('#joostDecisionsRefreshNote');
    if (!tbody) return;
    const initial = !_joost.decisionsLoadedOnce;
    if (initial) {
      if (loading) { loading.style.display = ''; loading.textContent = 'Laden…'; }
      if (wrap) wrap.style.display = 'none';
      if (empty) empty.style.display = 'none';
    }
    try {
      const r = await window.AgentShared.apiFetch('/api/joost-autonomy-decisions-list?limit=50');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (loading) { loading.style.display = ''; loading.textContent = 'Fout bij laden: ' + (data.error || r.status); }
        return;
      }
      const rows = Array.isArray(data.decisions) ? data.decisions
                 : Array.isArray(data.rows)      ? data.rows
                 : Array.isArray(data)           ? data
                 : [];
      tbody.innerHTML = '';
      if (!rows.length) {
        if (loading) loading.style.display = 'none';
        if (wrap) wrap.style.display = 'none';
        if (empty) empty.style.display = '';
      } else {
        rows.forEach(rr => {
          const [main, detail] = renderDecisionRow(rr);
          tbody.appendChild(main);
          tbody.appendChild(detail);
        });
        if (loading) loading.style.display = 'none';
        if (empty) empty.style.display = 'none';
        if (wrap) wrap.style.display = '';
      }
      _joost.decisionsLoadedOnce = true;
      if (note) {
        const pad = n => String(n).padStart(2, '0');
        const d = new Date();
        note.textContent = 'Laatste refresh ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      }
    } catch (e) {
      if (initial && loading) { loading.style.display = ''; loading.textContent = 'Fout bij laden: ' + e.message; }
    }
  }

  // Stop decisions-poll bij page unload (Lesson 20: badge/poll-cleanup).
  window.addEventListener('beforeunload', () => {
    if (_joost.decisionsTimer) { clearInterval(_joost.decisionsTimer); _joost.decisionsTimer = null; }
  });

  // ═════════════════════════════════════════════════════════════════════════
  //   WHATSAPP CONNECTION — module-koppelingen + edit-modal + webhook-sub.
  //   Full extract uit modules/admin.html (PR-4). Element-IDs blijven 1-op-1
  //   ('waConf*') zodat de gekopieerde logica letterlijk werkt. Modals worden
  //   in document.body geinjecteerd bij mount (eenmalig).
  // ═════════════════════════════════════════════════════════════════════════

  // Module-scope state (mirrored uit admin.html L1931-1934).
  const _waConf = {
    items: [],
    phones: [],
    editingId: null,
    wired: false,
    modalsInjected: false,
  };

  function renderConnectionMarkup() {
    return `
      <div class="section-card">
        <div class="section-header" style="justify-content:space-between">
          <div>
            <div style="font-size:15px;font-weight:700">WhatsApp Module Connections</div>
            <div style="font-size:12px;color:var(--text-faint);font-weight:400;margin-top:4px;max-width:680px">
              Koppel modules (Inbox, Finance, Sales, ...) aan een specifiek WhatsApp Cloud API telefoonnummer.
              Per module bepaalt deze tabel met welke afzendlijn berichten verstuurd worden en welke binnenkomende
              berichten in welke inbox terechtkomen.
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" id="waConfReloadBtn" type="button" title="Lijst opnieuw laden"><i class="ti ti-refresh"></i></button>
            <button class="btn btn-sm btn-primary" id="waConfAddBtn" type="button"><i class="ti ti-plus"></i> Module toevoegen</button>
          </div>
        </div>
        <div style="overflow-x:auto">
          <table class="users-table" id="waConfTable">
            <thead>
              <tr>
                <th>Module</th>
                <th>Telefoonnummer</th>
                <th>Display label</th>
                <th>Status</th>
                <th>Acties</th>
              </tr>
            </thead>
            <tbody id="waConfTbody">
              <tr><td colspan="5" style="color:var(--text-faint);padding:20px">Laden&hellip;</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // Modals + editor-modal styles geinjecteerd in document.body bij mount (1x).
  function ensureConnectionModalInjected() {
    if (_waConf.modalsInjected) return;
    if (document.getElementById('waConfEditModal')) {
      // Reeds aanwezig (bv. via hot reload).
      _waConf.modalsInjected = true;
      return;
    }
    // Style injectie (eenmalig) voor classes die niet in agent-shared.css of
    // finance.html staan maar wel door de gekopieerde admin.html-modals worden
    // gebruikt. .modal-overlay / .modal-card zijn al in finance.html — alleen
    // de modal-* sub-classes + form-* + tables + helpers ontbreken.
    ensureSharedModalStylesInjected();
    const wrap = document.createElement('div');
    wrap.id = 'fiWaConfModalsRoot';
    wrap.innerHTML = `
      <style>
        /* WhatsApp Connection edit modal — Contact-informatie afdeling sectie (C4.6) */
        #waConfEditModal .wa-conf-afdeling-section { margin-top:12px; border-top:1px solid var(--border); padding-top:10px; }
        #waConfEditModal .wa-conf-afdeling-section > summary { cursor:pointer; font-size:13px; font-weight:600; color:var(--text-dim); padding:4px 0; user-select:none; }
        #waConfEditModal .wa-conf-afdeling-section > summary:hover { color:var(--text); }
        #waConfEditModal .wa-conf-afdeling-form { display:grid; grid-template-columns:1fr; gap:8px; padding:8px 0; }
        #waConfEditModal .wa-conf-afdeling-form .form-label { font-size:12px; color:var(--text-dim); margin-bottom:2px; display:block; }
      </style>
      <!-- WhatsApp Module Connection edit modal -->
      <div class="modal-overlay hidden" id="waConfEditModal">
        <div class="modal-card">
          <div class="modal-header">
            <div class="modal-title" id="waConfModalTitle">Module bewerken</div>
            <button class="modal-close" type="button" data-fi-close="waConfEditModal">&#x2715;</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label">Module key</label>
              <input type="text" id="waConfModuleInput" class="form-input" placeholder="bv. inbox, finance, sales" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Unieke identifier. Niet wijzigen bij bestaande koppelingen.</div>
            </div>
            <div class="form-group">
              <label class="form-label">Display label</label>
              <input type="text" id="waConfLabelInput" class="form-input" placeholder="bv. Inbox / Finance / Sales" />
            </div>
            <div class="form-group">
              <label class="form-label">Telefoonnummer (Meta WABA)</label>
              <select id="waConfPhoneSelect" class="form-input">
                <option value="">Laden&hellip;</option>
              </select>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Gevuld vanuit /api/admin-whatsapp-numbers-available.</div>
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="waConfActiveInput" checked style="width:16px;height:16px" />
              <label for="waConfActiveInput" style="font-size:13px;cursor:pointer">Actief (gebruikt voor send/ontvangen)</label>
            </div>
            <details class="wa-conf-afdeling-section">
              <summary>Contact-informatie afdeling</summary>
              <div class="wa-conf-afdeling-form">
                <div class="form-group">
                  <label class="form-label" for="waConfAfdelingTelefoon">Telefoon (bel-nummer)</label>
                  <input type="text" id="waConfAfdelingTelefoon" class="form-input" placeholder="+31 85 130 83 62" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="waConfAfdelingWhatsapp">WhatsApp-nummer</label>
                  <input type="text" id="waConfAfdelingWhatsapp" class="form-input" placeholder="+31 6 51031673" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="waConfAfdelingEmail">E-mail</label>
                  <input type="email" id="waConfAfdelingEmail" class="form-input" placeholder="administratie@deforexopleiding.nl" />
                </div>
                <div class="form-group">
                  <label class="form-label" for="waConfAfdelingOndertekenaar">Ondertekenaar (naam)</label>
                  <input type="text" id="waConfAfdelingOndertekenaar" class="form-input" placeholder="De Forex Opleiding" />
                </div>
              </div>
            </details>
            <div class="form-error hidden" id="waConfError"></div>
          </div>
          <div class="modal-footer">
            <button class="btn" type="button" data-fi-close="waConfEditModal">Annuleren</button>
            <button class="btn btn-primary" id="waConfSaveBtn" type="button">Opslaan</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    // Close-buttons + backdrop wiring.
    wrap.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-fi-close]');
      if (closeBtn) { closeWaConfEdit(); return; }
      const overlay = e.target.closest('#waConfEditModal');
      if (overlay && e.target === overlay) closeWaConfEdit();
    });
    document.getElementById('waConfSaveBtn')?.addEventListener('click', saveWaConfRow);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const m = document.getElementById('waConfEditModal');
      if (m && !m.classList.contains('hidden')) closeWaConfEdit();
    });

    _waConf.modalsInjected = true;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   WHATSAPP TEMPLATES — Meta-templates + Quick replies + editor-modal.
  //   Full extract uit modules/admin.html (PR-4). Element-IDs blijven 1-op-1
  //   ('waTpl*' / 'waMeta*' / 'waQr*') zodat de gekopieerde logica letterlijk
  //   werkt. Modals + variable registry geinjecteerd in document.body.
  // ═════════════════════════════════════════════════════════════════════════

  const _waTpl = {
    loadedOnce: false,
    activeSub: 'meta',       // meta | quick
    wired: false,
    wabas: [],
    activeWaba: null,
    metaItems: [],
    metaFolders: [],
    metaEditingId: null,
    metaButtonsDraft: [],
    metaCurrentExamples: {},
    metaLastFocusedFieldId: 'waMetaBodyText',
    qrItems: [],
    qrEditingId: null,
    modalsInjected: false,
  };
  // Read-only state op window (used by render-helpers).
  window._waMetaReadOnly = false;

  function renderTemplatesMarkup() {
    return `
      <div class="section-card">
        <div class="section-header" style="justify-content:space-between">
          <div>
            <div style="font-size:15px;font-weight:700">WhatsApp Templates</div>
            <div style="font-size:12px;color:var(--text-faint);font-weight:400;margin-top:4px;max-width:720px">
              Beheer Meta-goedgekeurde message templates (vereist voor 24u+ outbound)
              &eacute;n interne &laquo;snelle antwoorden&raquo; (free-form, binnen 24u-window).
              Selecteer eerst de WhatsApp Business Account.
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" id="waTplReloadBtn" type="button" title="Lijst opnieuw laden"><i class="ti ti-refresh"></i></button>
          </div>
        </div>

        <!-- WABA-selector strip -->
        <div style="display:flex;align-items:center;gap:10px;padding:8px 4px 14px 4px;flex-wrap:wrap">
          <label for="waTplWabaSelect" style="font-size:12.5px;color:var(--text-dim);font-weight:600">WABA</label>
          <select id="waTplWabaSelect" class="form-input" style="max-width:340px">
            <option value="">Laden&hellip;</option>
          </select>
          <button class="btn btn-sm" id="waTplWabaRefreshBtn" type="button" title="WABA-lijst opnieuw laden"><i class="ti ti-refresh"></i></button>
          <span id="waTplWabaHint" style="font-size:11px;color:var(--text-faint)"></span>
        </div>

        <!-- Sub-tab strip -->
        <div class="sr-segments" id="waTplSubTabs" role="tablist" style="display:inline-flex;gap:4px;border:1px solid var(--border);border-radius:8px;padding:3px;margin-bottom:14px">
          <button type="button" class="sr-segment active" data-wa-tpl-sub="meta" role="tab" aria-selected="true">Meta Templates</button>
          <button type="button" class="sr-segment" data-wa-tpl-sub="quick" role="tab" aria-selected="false">Snelle antwoorden</button>
        </div>

        <!-- META TEMPLATES sub-view -->
        <div id="waTplSubMeta">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
            <div>
              <div style="font-size:14px;font-weight:700">Meta Templates</div>
              <div style="font-size:11.5px;color:var(--text-faint)">Server-side goedgekeurd door Meta. Status: APPROVED / PENDING / REJECTED.</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm" id="waMetaSyncBtn" type="button" title="Haal templates op uit Meta en update statussen"><i class="ti ti-refresh"></i> Sync met Meta</button>
              <button class="btn btn-sm" id="waMetaNewFolderBtn" type="button" title="Nieuwe map om templates in te groeperen"><i class="ti ti-folder-plus"></i> Nieuwe map</button>
              <button class="btn btn-sm btn-primary" id="waMetaNewBtn" type="button"><i class="ti ti-plus"></i> Nieuwe template</button>
            </div>
          </div>
          <div style="overflow-x:auto">
            <table class="users-table" id="waMetaTable">
              <thead>
                <tr>
                  <th>Naam</th>
                  <th>Taal</th>
                  <th>Categorie</th>
                  <th>Status</th>
                  <th>Acties</th>
                </tr>
              </thead>
              <tbody id="waMetaTbody">
                <tr><td colspan="5" style="color:var(--text-faint);padding:20px">Laden&hellip;</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- QUICK REPLIES sub-view -->
        <div id="waTplSubQuick" hidden>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
            <div>
              <div style="font-size:14px;font-weight:700">Snelle antwoorden</div>
              <div style="font-size:11.5px;color:var(--text-faint)">Interne shortcuts voor agents binnen het 24-uurs antwoordvenster. Geen Meta-approval nodig.</div>
            </div>
            <button class="btn btn-sm btn-primary" id="waQrNewBtn" type="button"><i class="ti ti-plus"></i> Nieuwe snel antwoord</button>
          </div>
          <div style="overflow-x:auto">
            <table class="users-table" id="waQrTable">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Body preview</th>
                  <th>Sort</th>
                  <th>Actief</th>
                  <th>Acties</th>
                </tr>
              </thead>
              <tbody id="waQrTbody">
                <tr><td colspan="5" style="color:var(--text-faint);padding:20px">Laden&hellip;</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function ensureTemplatesModalsInjected() {
    if (_waTpl.modalsInjected) return;
    if (document.getElementById('waMetaEditModal')) {
      _waTpl.modalsInjected = true;
      return;
    }
    ensureSharedModalStylesInjected();
    const wrap = document.createElement('div');
    wrap.id = 'fiWaTplModalsRoot';
    wrap.innerHTML = `
      <style>
        /* WhatsApp Meta template editor: scrollable layout zodat modal binnen viewport blijft. */
        #waMetaEditModal .modal-card {
          max-width: min(1100px, 95vw);
          max-height: 90vh;
          display: flex;
          flex-direction: column;
        }
        #waMetaEditModal .modal-header { flex-shrink: 0; }
        #waMetaEditModal .modal-body {
          flex: 1;
          overflow-y: auto;
          min-height: 0;
        }
        #waMetaEditModal .modal-footer {
          flex-shrink: 0;
          position: sticky;
          bottom: 0;
          background: var(--bg-elev);
          border-top: 1px solid var(--border);
        }
        @media (max-width: 800px) {
          #waMetaEditModal .modal-card { width: 95vw; max-height: 90vh; }
          #waMetaEditModal .modal-body > div[style*="grid-template-columns:1fr 380px"] {
            grid-template-columns: 1fr !important;
          }
        }
        /* WhatsApp Meta template variabelen-paneel (C4) */
        #waMetaVarsPanel { max-width:300px; padding:8px 12px; max-height:320px; overflow:auto; border:1px solid var(--border); border-radius:8px; background:var(--bg-elev-2); }
        #waMetaVarsPanel details { margin-bottom:6px; }
        #waMetaVarsPanel details > summary { cursor:pointer; font-size:12px; font-weight:600; color:var(--text-dim); padding:4px 0; user-select:none; }
        #waMetaVarsPanel details > summary:hover { color:var(--text); }
        #waMetaVarsPanel .wa-var-chip-row { display:flex; flex-wrap:wrap; gap:4px; padding:4px 0 8px 0; }
        /* Groep-koppen boven categorie-secties (afdelings-structuur) */
        #waMetaVarsPanel .wa-var-group { margin-bottom:10px; }
        #waMetaVarsPanel .wa-var-group + .wa-var-group { margin-top:6px; }
        #waMetaVarsPanel .wa-var-group-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--text-faint); padding:2px 0 4px 0; margin:0 0 4px 0; border-bottom:1px solid var(--border); }
        #waMetaVarsPanel .wa-var-group details { margin-left:2px; }
        .wa-var-chip { padding:4px 10px; background:#f3f4f6; border:1px solid var(--border); border-radius:999px; font-size:12px; cursor:pointer; color:var(--text); font-family:inherit; line-height:1.3; }
        .wa-var-chip:hover { background:#e5e7eb; }
        .wa-var-chip[disabled] { opacity:.5; cursor:not-allowed; }
        #waMetaVarsBlock.wa-vars-named { background:rgba(34,197,94,0.06); border-style:solid; border-color:rgba(34,197,94,0.4); }
        #waMetaVarsBlock .wa-var-readonly-row { display:grid; grid-template-columns:auto 1fr; gap:8px; align-items:center; padding:3px 0; font-size:12px; }
        #waMetaVarsBlock .wa-var-readonly-key { font-family:monospace; font-size:11.5px; color:var(--text); background:rgba(34,197,94,0.12); padding:2px 6px; border-radius:4px; }
        #waMetaVarsBlock .wa-var-readonly-example { color:var(--text-faint); font-size:11.5px; }
        /* Preview body */
        #waMetaPreviewBody .wa-preview-placeholder { color:#888; font-style:italic; }
        #waMetaPreviewBody .wa-preview-unknown { color:#b91c1c; background:rgba(239,68,68,0.10); padding:0 4px; border-radius:3px; font-family:monospace; font-size:12.5px; display:inline-flex; align-items:center; gap:4px; }
        #waMetaPreviewBody .wa-preview-unknown-dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#ef4444; box-shadow:0 0 0 2px rgba(239,68,68,0.20); }
      </style>

      <!-- WhatsApp Meta Template full editor modal -->
      <div class="modal-overlay hidden" id="waMetaEditModal">
        <div class="modal-card" style="max-width:1100px;width:96vw">
          <div class="modal-header">
            <div class="modal-title" id="waMetaModalTitle">Nieuwe Meta template</div>
            <button class="modal-close" type="button" data-fi-close="waMetaEditModal">&#x2715;</button>
          </div>
          <div class="modal-body">
            <div id="waMetaStatusBanner" hidden style="margin-bottom:14px;padding:10px 14px;border-radius:8px;font-size:13px;font-weight:500;border:1px solid transparent"></div>
            <div style="display:grid;grid-template-columns:1fr 380px;gap:20px;align-items:start">

              <!-- LINKS: form -->
              <div>
                <div class="form-group">
                  <label class="form-label" for="waMetaNameInput">Naam</label>
                  <input type="text" id="waMetaNameInput" class="form-input" placeholder="bv. order_confirmation_v1" maxlength="512" />
                  <div style="font-size:11px;color:var(--text-faint);margin-top:4px">lowercase_snake_case, alleen a-z 0-9 _</div>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
                  <div class="form-group">
                    <label class="form-label" for="waMetaLangSelect">Taal</label>
                    <select id="waMetaLangSelect" class="form-input">
                      <option value="nl">Nederlands (nl)</option>
                      <option value="en_US">English US (en_US)</option>
                      <option value="en">English (en)</option>
                      <option value="de">Deutsch (de)</option>
                      <option value="fr">Fran&ccedil;ais (fr)</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label class="form-label" for="waMetaCatSelect">Categorie</label>
                    <select id="waMetaCatSelect" class="form-input">
                      <option value="UTILITY">UTILITY</option>
                      <option value="MARKETING">MARKETING</option>
                      <option value="AUTHENTICATION">AUTHENTICATION</option>
                    </select>
                  </div>
                </div>

                <!-- HEADER -->
                <details class="form-group" id="waMetaHeaderDetails" style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">
                  <summary style="cursor:pointer;font-weight:600;font-size:13px">Header</summary>
                  <div style="margin-top:10px">
                    <div class="form-group">
                      <label class="form-label" for="waMetaHeaderType">Type</label>
                      <select id="waMetaHeaderType" class="form-input">
                        <option value="NONE">Geen</option>
                        <option value="TEXT">Tekst</option>
                        <option value="IMAGE">Afbeelding</option>
                        <option value="VIDEO">Video</option>
                        <option value="DOCUMENT">Document</option>
                      </select>
                    </div>
                    <div class="form-group" id="waMetaHeaderTextGroup" hidden>
                      <label class="form-label" for="waMetaHeaderText">Header tekst</label>
                      <input type="text" id="waMetaHeaderText" class="form-input" maxlength="60" placeholder="Max 60 tekens" />
                      <div style="font-size:11px;color:var(--text-faint);margin-top:4px"><span id="waMetaHeaderTextCount">0</span> / 60</div>
                    </div>
                    <div class="form-group" id="waMetaHeaderUrlGroup" style="display:none">
                      <label class="form-label">Sample-bestand</label>
                      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
                        <input type="file" id="waMetaHeaderFileInput" class="form-input" style="flex:1;min-width:0;font-size:12px" />
                        <button class="btn btn-sm" type="button" id="waMetaHeaderFileClearBtn" hidden>Wissen</button>
                      </div>
                      <div id="waMetaHeaderFileStatus" style="font-size:11px;color:var(--text-faint);margin-bottom:8px">Geen bestand gekozen (max ~3 MB).</div>
                      <label class="form-label" for="waMetaHeaderUrl" style="font-size:11px;color:var(--text-dim)">Of plak een publieke URL</label>
                      <input type="url" id="waMetaHeaderUrl" class="form-input" placeholder="https://&hellip;" />
                      <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Meta haalt dit sample op tijdens approval (kan uren/dagen duren) — moet publiek bereikbaar zijn.</div>
                    </div>
                  </div>
                </details>

                <!-- BODY -->
                <div class="form-group">
                  <label class="form-label" for="waMetaBodyText">Body</label>
                  <!-- Fase B: opmaak-toolbar (WhatsApp markdown bold/italic/strike/mono). -->
                  <div id="waMetaFormatToolbar" style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap">
                    <button type="button" class="btn btn-sm" data-wa-fmt="bold"   title="Vetgedrukt — *tekst*" style="font-weight:700;min-width:32px">B</button>
                    <button type="button" class="btn btn-sm" data-wa-fmt="italic" title="Cursief — _tekst_" style="font-style:italic;min-width:32px">I</button>
                    <button type="button" class="btn btn-sm" data-wa-fmt="strike" title="Doorgehaald — ~tekst~" style="text-decoration:line-through;min-width:32px">S</button>
                    <button type="button" class="btn btn-sm" data-wa-fmt="code"   title="Monospace (code-stijl)" style="font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;min-width:32px">&lt;/&gt;</button>
                  </div>
                  <textarea id="waMetaBodyText" class="form-input" rows="6" maxlength="1024" placeholder="Hi {{klant.naam}}, je factuur {{factuur.nummer}} staat open."></textarea>
                  <div style="font-size:11px;color:var(--text-faint);margin-top:4px">
                    <span id="waMetaBodyCount">0</span> / 1024 &middot; klik op een chip hieronder om een variabele in te voegen op de cursor, of typ direct <code>{{klant.naam}}</code> (named) of <code>{{1}}</code> (positioneel, legacy).
                  </div>
                  <!-- Auto-mapping live-warning: getoond als body positional placeholders bevat
                       zonder dat er een mapping is — Meta weigert die bij submit (#132000). -->
                  <div id="waMetaBodyMappingWarn" style="display:none;margin-top:6px;padding:8px 10px;border-radius:6px;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.35);font-size:12px;color:#92400e">
                    <strong>Let op:</strong> deze template gebruikt positionele plaatshouders <code>{{1}}</code>, <code>{{2}}</code>… die geen auto-mapping krijgen. Meta weigert de template bij submit (error #132000). Vervang ze door named variabelen via de chips hieronder, of stel <code>meta_param_mapping</code> handmatig in.
                  </div>

                  <!-- C4: Variabelen-paneel (named-style insert) -->
                  <div id="waMetaVarsPanel" style="margin-top:10px">
                    <div style="font-size:11px;font-weight:600;color:var(--text-faint);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Variabelen invoegen</div>
                    <div id="waMetaVarsPanelBody"></div>
                  </div>

                  <div id="waMetaVarsBlock" style="margin-top:10px;padding:10px;border:1px dashed var(--border);border-radius:8px;display:none">
                    <div style="font-size:12px;font-weight:600;margin-bottom:6px"><span id="waMetaVarsBlockLabel">Variabelen gevonden:</span> <span id="waMetaVarsList"></span></div>
                    <div id="waMetaVarsInputs" style="display:grid;grid-template-columns:1fr 1fr;gap:8px"></div>
                    <div id="waMetaVarsHelp" style="font-size:11px;color:var(--text-faint);margin-top:6px">Voorbeeldwaarden &mdash; gebruikt voor preview &eacute;n als Meta sample bij submit.</div>
                  </div>
                </div>

                <!-- FOOTER -->
                <details class="form-group" id="waMetaFooterDetails" style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">
                  <summary style="cursor:pointer;font-weight:600;font-size:13px">Footer</summary>
                  <div style="margin-top:10px">
                    <label class="form-label" for="waMetaFooterInput">Footer tekst</label>
                    <input type="text" id="waMetaFooterInput" class="form-input" maxlength="60" placeholder="bv. De Forex Opleiding" />
                    <div style="font-size:11px;color:var(--text-faint);margin-top:4px"><span id="waMetaFooterCount">0</span> / 60</div>
                  </div>
                </details>

                <!-- BUTTONS -->
                <details class="form-group" id="waMetaButtonsDetails" style="border:1px solid var(--border);border-radius:8px;padding:10px 12px">
                  <summary style="cursor:pointer;font-weight:600;font-size:13px">Knoppen (max 10)</summary>
                  <div style="margin-top:10px">
                    <div id="waMetaButtonsList" style="display:flex;flex-direction:column;gap:8px"></div>
                    <button type="button" class="btn btn-sm" id="waMetaBtnAddBtn" style="margin-top:8px"><i class="ti ti-plus"></i> Knop toevoegen</button>
                    <div id="waMetaButtonsLimitHint" style="font-size:11px;color:var(--text-faint);margin-top:8px">
                      Meta-limieten: max 3 quick-reply, max 2 CTA (URL + telefoon), hybride combineren tot 10 totaal. Buiten deze limieten weigert Meta de template.
                    </div>
                    <div id="waMetaButtonsLimitWarn" style="font-size:11px;color:#dc2626;margin-top:4px;display:none"></div>
                  </div>
                </details>
              </div>

              <!-- RECHTS: preview -->
              <div>
                <div id="waMetaPreviewCard" style="position:sticky;top:10px;border:1px solid var(--border);border-radius:10px;padding:14px;background:var(--bg-soft, #f7f7f5)">
                  <div style="font-size:11px;color:var(--text-faint);font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Preview</div>
                  <div id="waMetaPreviewWallpaper" style="background:#e5ddd5;background-image:repeating-linear-gradient(45deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 6px);border-radius:8px;padding:14px;min-height:220px">
                    <div id="waMetaPreviewBubble" style="background:#d9fdd3;border-radius:8px;padding:10px 14px;max-width:280px;box-shadow:0 1px 1px rgba(0,0,0,0.08);font-size:13.5px;line-height:1.45;color:#111">
                      <div id="waMetaPreviewHeader" style="font-weight:700;margin-bottom:6px;display:none"></div>
                      <div id="waMetaPreviewBody" style="white-space:pre-wrap;word-break:break-word">Je bericht verschijnt hier&hellip;</div>
                      <div id="waMetaPreviewFooter" style="font-size:11px;color:#667781;margin-top:6px;display:none"></div>
                    </div>
                    <div id="waMetaPreviewButtons" style="margin-top:8px;display:flex;flex-direction:column;gap:4px;max-width:280px"></div>
                  </div>
                </div>
              </div>

            </div>

            <div class="form-error hidden" id="waMetaError" style="margin-top:12px"></div>
          </div>
          <div class="modal-footer">
            <button class="btn" type="button" data-fi-close="waMetaEditModal">Annuleren</button>
            <button class="btn btn-primary" id="waMetaSaveBtn" type="button">Opslaan</button>
          </div>
        </div>
      </div>

      <!-- WhatsApp Quick Reply edit modal -->
      <div class="modal-overlay hidden" id="waQrEditModal">
        <div class="modal-card" style="max-width:560px">
          <div class="modal-header">
            <div class="modal-title" id="waQrModalTitle">Nieuwe snel antwoord</div>
            <button class="modal-close" type="button" data-fi-close="waQrEditModal">&#x2715;</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label class="form-label" for="waQrTitleInput">Titel</label>
              <input type="text" id="waQrTitleInput" class="form-input" maxlength="100" placeholder="bv. Bedankt voor je bericht" />
            </div>
            <div class="form-group">
              <label class="form-label" for="waQrBodyInput">Body</label>
              <textarea id="waQrBodyInput" class="form-input" rows="5" maxlength="1024" placeholder="Tekst die ingevoegd wordt in het antwoordveld&hellip;"></textarea>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px"><span id="waQrBodyCount">0</span> / 1024</div>
            </div>
            <div style="display:grid;grid-template-columns:140px 1fr;gap:14px;align-items:center">
              <div class="form-group" style="margin-bottom:0">
                <label class="form-label" for="waQrSortInput">Sorteervolgorde</label>
                <input type="number" id="waQrSortInput" class="form-input" value="0" step="1" />
              </div>
              <div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0">
                <input type="checkbox" id="waQrActiveInput" checked style="width:16px;height:16px" />
                <label for="waQrActiveInput" style="font-size:13px;cursor:pointer">Actief (zichtbaar voor agents)</label>
              </div>
            </div>
            <div class="form-error hidden" id="waQrError" style="margin-top:12px"></div>
          </div>
          <div class="modal-footer">
            <button class="btn" type="button" data-fi-close="waQrEditModal">Annuleren</button>
            <button class="btn btn-primary" id="waQrSaveBtn" type="button">Opslaan</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    // Close-buttons + backdrop wiring.
    wrap.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-fi-close]');
      if (closeBtn) {
        const id = closeBtn.getAttribute('data-fi-close');
        if (id === 'waMetaEditModal') closeWaMetaEdit();
        else if (id === 'waQrEditModal') closeWaQrEdit();
        return;
      }
      const metaOverlay = e.target.closest('#waMetaEditModal');
      if (metaOverlay && e.target === metaOverlay) closeWaMetaEdit();
      const qrOverlay = e.target.closest('#waQrEditModal');
      if (qrOverlay && e.target === qrOverlay) closeWaQrEdit();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const meta = document.getElementById('waMetaEditModal');
      const qr = document.getElementById('waQrEditModal');
      if (meta && !meta.classList.contains('hidden')) closeWaMetaEdit();
      else if (qr && !qr.classList.contains('hidden')) closeWaQrEdit();
    });

    _waTpl.modalsInjected = true;
  }

  // ─── Shared modal/table/form styles (eenmalige injectie) ───────────────────
  // Deze classes ('.modal-header / .modal-body / .modal-footer / .modal-title /
  // .modal-close / .users-table / .action-btn / .active-dot / .form-error /
  // .sr-segments / .sr-segment / .section-header / .hidden') waren in admin.html
  // inline gedefinieerd. Bij verhuis naar Finance > Instellingen (PR-4) zijn ze
  // niet in agent-shared.css of finance.html beschikbaar — we injecteren ze
  // eenmalig in document.head bij eerste modal-open zodat de gekopieerde HTML
  // (1-op-1 uit admin.html) er hetzelfde uitziet als voorheen.
  let _sharedModalStylesInjected = false;
  function ensureSharedModalStylesInjected() {
    if (_sharedModalStylesInjected) return;
    if (document.getElementById('fiSharedModalStyles')) {
      _sharedModalStylesInjected = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'fiSharedModalStyles';
    style.textContent = `
      /* PR-4 shared modal/table/form styles (eens een admin.html-inline-block;
         nu hostable in Finance > Instellingen). */
      .modal-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--border); }
      .modal-title { font-size:15px; font-weight:600; }
      .modal-close { background:transparent; border:none; color:var(--text-faint); font-size:16px; cursor:pointer; padding:4px; line-height:1; }
      .modal-body { padding:20px; }
      .modal-footer { display:flex; justify-content:flex-end; gap:8px; padding:14px 20px; border-top:1px solid var(--border); }
      /* ID-gescoopte overlay + card-basis voor onze 3 modals.
         Finance.html bevat .modal-overlay/.modal-card al; daar zijn deze
         ID-regels redundant (gelijke specificiteit, identieke waarden -> no-op
         visueel). Op host-pagina's ZONDER die basis-CSS (bv. agent-center.html)
         zorgen ze dat de modal toch fixed-overlay + gecentreerd rendert i.p.v.
         in document-flow onderaan vallen.
         .hidden moet hier hogere specificiteit hebben dan de ID-only regel
         hierboven, anders blijft de modal altijd zichtbaar; ID+class wint van
         ID-only en !important is extra dichtgetimmerd. */
      #waConfEditModal,
      #waMetaEditModal,
      #waQrEditModal {
        position:fixed; inset:0; z-index:600;
        display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.6);
        backdrop-filter:blur(4px);
        padding:20px;
      }
      #waConfEditModal.hidden,
      #waMetaEditModal.hidden,
      #waQrEditModal.hidden { display:none !important; }
      #waConfEditModal .modal-card,
      #waMetaEditModal .modal-card,
      #waQrEditModal .modal-card {
        background:var(--bg-elev);
        border:1px solid var(--border);
        border-radius:14px;
        max-width:520px;
        width:100%;
      }
      /* Scope-specifiek: onze 3 modals laten hun header/body/footer hun eigen
         padding bepalen ipv de generic modal-card padding van finance.html.
         Scope-specifieke max-width-overrides per modal (zie ensureMeta… etc)
         worden later geinjecteerd en winnen op cascade-volgorde — die regels
         blijven intact. */
      #waConfEditModal .modal-card,
      #waMetaEditModal .modal-card,
      #waQrEditModal .modal-card { padding:0; }
      .users-table { width:100%; border-collapse:collapse; }
      .users-table th { text-align:left; padding:10px 12px; font-size:10px; text-transform:uppercase; color:var(--text-faint); font-weight:600; letter-spacing:.5px; border-bottom:1px solid var(--border); }
      .users-table td { padding:12px; border-bottom:0.5px solid var(--border-subtle, var(--border)); font-size:13px; vertical-align:middle; }
      .users-table tr:last-child td { border-bottom:none; }
      .users-table tr:hover td { background:var(--surface-card, transparent); }
      .action-btn { background:transparent; border:none; padding:5px 8px; border-radius:6px; color:var(--text-faint); cursor:pointer; font-size:12px; font-family:inherit; }
      .action-btn:hover { background:var(--surface-card-hover, var(--bg-elev-2)); color:var(--text); }
      .active-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--color-success, #22c55e); }
      .active-dot.inactive-dot { background:var(--text-faint, #9ca3af); }
      .form-error { margin-top:10px; padding:8px 12px; background:var(--color-danger-soft, rgba(220,38,38,0.08)); border:1px solid var(--color-danger, #dc2626); border-radius:8px; font-size:12px; color:var(--color-danger-text, #b91c1c); }
      .form-error.hidden { display:none; }
      /* sr-segments + sr-segment (sub-tabs binnen WhatsApp Templates) */
      .sr-segments { display:inline-flex; }
      .sr-segment { background:transparent; border:none; padding:6px 12px; font-size:12.5px; font-weight:500; color:var(--text-dim); cursor:pointer; border-radius:6px; font-family:inherit; }
      .sr-segment:hover { color:var(--text); }
      .sr-segment.active { background:var(--brand-primary-soft, rgba(59,130,246,0.1)); color:var(--brand-primary, #2563eb); }
      /* section-header (gebruikt in renderTemplatesMarkup en renderConnectionMarkup) */
      .section-header { display:flex; align-items:center; gap:10px; margin-bottom:16px; font-size:14px; font-weight:600; }
      /* hidden utility (geldt alleen op modal-overlay als hidden class). */
      .modal-overlay.hidden { display:none !important; }
    `;
    document.head.appendChild(style);
    _sharedModalStylesInjected = true;
  }

  // ─── apiRequest helper (mirror van admin.html) ────────────────────────────
  // Gebruikt window.AgentShared.apiFetch onder de motorkap zodat we
  // automatisch de Bearer-token meekrijgen. Returnt parsed JSON ipv Response.
  async function apiRequest(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await window.AgentShared.apiFetch(path, opts);
    let data = null;
    try { data = await res.json(); }
    catch (_) { data = {}; }
    // Mirror van admin.html-stijl: bij niet-OK response zonder .error, voeg
    // een synthetic error toe zodat callers downstream dezelfde shape zien.
    if (!res.ok && !(data && data.error)) {
      data = data || {};
      data.error = data.error || ('HTTP ' + res.status);
    }
    return data;
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   WHATSAPP CONNECTION — handlers (extract uit admin.html L1936-2193)
  // ═════════════════════════════════════════════════════════════════════════

  async function loadWaConfList() {
    const tbody = document.getElementById('waConfTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);padding:20px">Laden&hellip;</td></tr>';
    try {
      const [modulesData] = await Promise.all([
        apiRequest('GET', '/api/admin-whatsapp-modules-list'),
        loadWaConfPhones().catch(e => {
          console.warn('[waConf] phones-cache laden mislukt:', e.message);
          return null;
        }),
      ]);
      if (modulesData && modulesData.error) throw new Error(modulesData.error);
      _waConf.items = (modulesData && modulesData.items) || (modulesData && modulesData.modules) || [];
      renderWaConfRows();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red);padding:20px">Fout: ${esc(e.message)}</td></tr>`;
    }
  }

  function waConfPhoneDisplay(phoneId) {
    if (!phoneId) return '—';
    const phone = (_waConf.phones || []).find(p =>
      (p.id || p.phone_number_id) === phoneId
    );
    if (!phone) return String(phoneId);
    const disp = phone.display_phone_number || phone.phone_number || phoneId;
    const name = phone.verified_name ? ` (${phone.verified_name})` : '';
    return disp + name;
  }

  function renderWaConfRows() {
    const tbody = document.getElementById('waConfTbody');
    if (!tbody) return;
    if (!_waConf.items.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);padding:20px">Nog geen module-koppelingen. Klik op + Module toevoegen.</td></tr>';
      return;
    }
    tbody.innerHTML = _waConf.items.map(it => {
      const moduleKey  = esc(it.module || it.module_key || '');
      const phoneId    = it.phone_number_id || it.phone_number || '';
      const phone      = esc(waConfPhoneDisplay(phoneId));
      const label      = esc(it.display_label || it.label || '—');
      const active     = it.is_active !== false;
      const statusDot  = active ? '<span class="active-dot"></span> Actief' : '<span class="active-dot inactive-dot"></span> Inactief';
      const rowId      = esc(it.id || it.module || '');
      const wabaId       = it.business_account_id || '';
      const moduleRaw    = it.module || it.module_key || '';
      const subscribeDisabled = wabaId ? '' : ' disabled';
      const subscribeTitle    = wabaId
        ? 'Eenmalig per WABA: koppelt webhook events aan onze app. Idempotent.'
        : 'Eerst business_account_id koppelen via Edit';
      const subscribeBtn = `<button class="action-btn wa-conf-subscribe-btn" type="button"`
        + ` data-waba-subscribe="${esc(wabaId)}"`
        + ` data-module="${esc(moduleRaw)}"`
        + ` title="${esc(subscribeTitle)}"${subscribeDisabled}>`
        + `<i class="ti ti-webhook"></i> Webhook subscriben</button>`;
      return `<tr>
        <td><strong>${moduleKey}</strong></td>
        <td>${phone}</td>
        <td>${label}</td>
        <td>${statusDot}</td>
        <td>
          <button class="action-btn" type="button" data-wa-edit="${rowId}"><i class="ti ti-edit"></i> Bewerken</button>
          ${subscribeBtn}
        </td>
      </tr>`;
    }).join('');
  }

  async function loadWaConfPhones() {
    try {
      const data = await apiRequest('GET', '/api/admin-whatsapp-numbers-available');
      if (data && data.error) throw new Error(data.error);
      _waConf.phones = (data && data.items) || (data && data.phones)
                    || (data && data.numbers) || (data && data.data) || [];
      return _waConf.phones;
    } catch (e) {
      _waConf.phones = [];
      throw e;
    }
  }

  function fillWaConfPhoneSelect(selectedValue) {
    const sel = document.getElementById('waConfPhoneSelect');
    if (!sel) return;
    if (!_waConf.phones.length) {
      sel.innerHTML = '<option value="">(geen nummers beschikbaar)</option>';
      return;
    }
    sel.innerHTML = '<option value="">— kies een nummer —</option>' + _waConf.phones.map(p => {
      const id    = p.id || p.phone_number_id || p.value || '';
      const disp  = p.display_phone_number || p.phone_number || p.label || id;
      const name  = p.verified_name ? ` (${p.verified_name})` : '';
      const sel2  = id === selectedValue ? ' selected' : '';
      return `<option value="${esc(id)}"${sel2}>${esc(disp)}${esc(name)}</option>`;
    }).join('');
  }

  async function openWaConfEdit(item) {
    ensureConnectionModalInjected();
    _waConf.editingId = item ? (item.id || item.module || null) : null;
    const isEdit = !!item;
    document.getElementById('waConfModalTitle').textContent = isEdit ? 'Module bewerken' : 'Module toevoegen';
    const moduleInput = document.getElementById('waConfModuleInput');
    const labelInput  = document.getElementById('waConfLabelInput');
    const activeInput = document.getElementById('waConfActiveInput');
    const errEl       = document.getElementById('waConfError');
    errEl.classList.add('hidden'); errEl.textContent = '';
    moduleInput.value = item ? (item.module || item.module_key || '') : '';
    moduleInput.disabled = isEdit;
    labelInput.value  = item ? (item.display_label || item.label || '') : '';
    activeInput.checked = item ? (item.is_active !== false) : true;
    const afdTel  = document.getElementById('waConfAfdelingTelefoon');
    const afdWa   = document.getElementById('waConfAfdelingWhatsapp');
    const afdMail = document.getElementById('waConfAfdelingEmail');
    const afdOnd  = document.getElementById('waConfAfdelingOndertekenaar');
    if (afdTel)  afdTel.value  = item ? (item.afdeling_telefoon     || '') : '';
    if (afdWa)   afdWa.value   = item ? (item.afdeling_whatsapp     || '') : '';
    if (afdMail) afdMail.value = item ? (item.afdeling_email        || '') : '';
    if (afdOnd)  afdOnd.value  = item ? (item.afdeling_ondertekenaar || '') : '';
    fillWaConfPhoneSelect('');
    document.getElementById('waConfEditModal').classList.remove('hidden');
    try {
      await loadWaConfPhones();
      const currentPhoneId = item ? (item.phone_number_id || item.phone_id || '') : '';
      fillWaConfPhoneSelect(currentPhoneId);
    } catch (e) {
      errEl.textContent = 'Nummers laden mislukt: ' + e.message;
      errEl.classList.remove('hidden');
    }
  }

  function closeWaConfEdit() {
    const m = document.getElementById('waConfEditModal');
    if (m) m.classList.add('hidden');
    _waConf.editingId = null;
  }

  async function saveWaConfRow() {
    const moduleKey = document.getElementById('waConfModuleInput').value.trim();
    const label     = document.getElementById('waConfLabelInput').value.trim();
    const phoneId   = document.getElementById('waConfPhoneSelect').value;
    const isActive  = document.getElementById('waConfActiveInput').checked;
    const errEl     = document.getElementById('waConfError');
    const btn       = document.getElementById('waConfSaveBtn');

    if (!moduleKey)  { errEl.textContent = 'Module key is verplicht'; errEl.classList.remove('hidden'); return; }
    if (!phoneId)    { errEl.textContent = 'Telefoonnummer is verplicht'; errEl.classList.remove('hidden'); return; }

    errEl.classList.add('hidden');
    btn.disabled = true; btn.textContent = 'Opslaan…';

    try {
      const afdTel  = (document.getElementById('waConfAfdelingTelefoon')?.value || '').trim();
      const afdWa   = (document.getElementById('waConfAfdelingWhatsapp')?.value || '').trim();
      const afdMail = (document.getElementById('waConfAfdelingEmail')?.value || '').trim();
      const afdOnd  = (document.getElementById('waConfAfdelingOndertekenaar')?.value || '').trim();
      const body = {
        module: moduleKey,
        display_label: label,
        phone_number_id: phoneId,
        is_active: isActive,
        afdeling_telefoon: afdTel,
        afdeling_whatsapp: afdWa,
        afdeling_email: afdMail,
        afdeling_ondertekenaar: afdOnd,
      };
      const method = _waConf.editingId ? 'PATCH' : 'POST';
      const path   = '/api/admin-whatsapp-module-upsert' + (_waConf.editingId ? `?id=${encodeURIComponent(_waConf.editingId)}` : '');
      const data   = await apiRequest(method, path, body);
      if (data && data.error) throw new Error(data.error);
      toast('Module-koppeling opgeslagen', 'success');
      closeWaConfEdit();
      loadWaConfList();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = 'Opslaan';
    }
  }

  function wireWaConfOnce() {
    if (_waConf.wired) return;
    _waConf.wired = true;
    const host = _state.hostMounted;
    if (!host) return;
    const reloadBtn = host.querySelector('#waConfReloadBtn');
    if (reloadBtn) reloadBtn.addEventListener('click', () => loadWaConfList());
    const addBtn = host.querySelector('#waConfAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => { ensureConnectionModalInjected(); openWaConfEdit(null); });
    const tbody = host.querySelector('#waConfTbody');
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const editBtn = e.target.closest('[data-wa-edit]');
        if (editBtn) {
          const rowId = editBtn.getAttribute('data-wa-edit');
          const item = _waConf.items.find(it => String(it.id || it.module) === rowId);
          if (item) openWaConfEdit(item);
          return;
        }
        const subBtn = e.target.closest('.wa-conf-subscribe-btn');
        if (subBtn) {
          if (subBtn.disabled) return;
          const wabaId = subBtn.getAttribute('data-waba-subscribe') || '';
          const moduleKey = subBtn.getAttribute('data-module') || '';
          doWaConfWebhookSubscribe(subBtn, wabaId, moduleKey);
        }
      });
    }
  }

  // C2: Webhook subscribe per WABA — idempotente POST.
  async function doWaConfWebhookSubscribe(btn, wabaId, moduleKey) {
    if (!wabaId) return;
    const confirmMsg = `Webhook subscriben voor module ${moduleKey} (WABA ${wabaId})? Idempotent. OK om door te gaan.`;
    if (!confirm(confirmMsg)) return;

    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="ti ti-loader"></i> Bezig...';
    try {
      const data = await apiRequest('POST', '/api/admin-whatsapp-webhook-subscribe', {
        business_account_id: wabaId,
      });
      if (data && data.error) {
        const msg = formatMetaError(data);
        toast('Subscribe mislukt: ' + msg, 'error');
        btn.innerHTML = origHtml;
        return;
      }
      toast(`Webhook subscribed voor ${moduleKey}`, 'success');
      btn.innerHTML = '<i class="ti ti-refresh"></i> Subscribed (Hertrigger?)';
    } catch (e) {
      const msg = formatMetaError(e);
      toast('Subscribe mislukt: ' + msg, 'error');
      btn.innerHTML = origHtml;
    } finally {
      btn.disabled = false;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  //   WHATSAPP TEMPLATES — handlers (extract uit admin.html L2199-3559).
  //   Variable registry (frontend-only, mirror van api/_lib/template-variables.js).
  // ═════════════════════════════════════════════════════════════════════════

  const WA_VAR_REGISTRY = [
    // customer
    { key: 'klant.naam',          label: 'Volledige naam',      category: 'customer', example: 'Jeffrey Biemold' },
    { key: 'klant.voornaam',      label: 'Voornaam',            category: 'customer', example: 'Jeffrey' },
    { key: 'klant.email',         label: 'E-mailadres',         category: 'customer', example: 'klant@example.com' },
    { key: 'klant.telefoon',      label: 'Telefoonnummer',      category: 'customer', example: '+31612345678' },
    { key: 'klant.bedrijf',       label: 'Bedrijfsnaam',        category: 'customer', example: 'Voorbeeld B.V.' },
    // invoice
    { key: 'factuur.nummer',         label: 'Factuurnummer',           category: 'invoice', example: '2026-0001' },
    { key: 'factuur.bedrag',         label: 'Factuurbedrag (totaal)',  category: 'invoice', example: 'EUR 1.234,56' },
    { key: 'factuur.bedrag_open',    label: 'Openstaand bedrag',       category: 'invoice', example: 'EUR 80,00' },
    { key: 'factuur.vervaldatum',    label: 'Vervaldatum',             category: 'invoice', example: '15-06-2026' },
    { key: 'factuur.dagen_overdue',  label: 'Dagen te laat',           category: 'invoice', example: '12' },
    { key: 'factuur.factuur_datum',  label: 'Factuurdatum',            category: 'invoice', example: '01-06-2026' },
    { key: 'factuur.betaal_link',    label: 'Betaal-link',             category: 'invoice', example: 'https://focus.teamleader.eu/...' },
    // klant (aggregaties)
    { key: 'klant.factuur_lijst', label: 'Lijst openstaande facturen', category: 'klant', example: '- 2026-0001 (EUR 80,00)' },
    { key: 'klant.totaal_open',   label: 'Totaal openstaand',          category: 'klant', example: 'EUR 200,00' },
    { key: 'klant.aantal_open',   label: 'Aantal open facturen',       category: 'klant', example: '2' },
    // afdeling
    { key: 'afdeling.telefoon',      label: 'Telefoon',      category: 'afdeling', example: '+31 85 130 83 62' },
    { key: 'afdeling.whatsapp',      label: 'WhatsApp',      category: 'afdeling', example: '+31 6 51031673' },
    { key: 'afdeling.email',         label: 'Email',         category: 'afdeling', example: 'administratie@deforexopleiding.nl' },
    { key: 'afdeling.ondertekenaar', label: 'Ondertekenaar', category: 'afdeling', example: 'De Forex Opleiding' },
    // bedrijf
    { key: 'bedrijf.naam',     label: 'Bedrijfsnaam',     category: 'bedrijf', example: 'De Forex Opleiding NL B.V.' },
    { key: 'bedrijf.adres',    label: 'Bedrijfsadres',    category: 'bedrijf', example: 'Voorbeeldstraat 1, 1234 AB Plaats' },
    { key: 'bedrijf.kvk',      label: 'KvK-nummer',       category: 'bedrijf', example: '12345678' },
    { key: 'bedrijf.btw',      label: 'BTW-nummer',       category: 'bedrijf', example: 'NL123456789B01' },
    { key: 'bedrijf.telefoon', label: 'Bedrijfstelefoon', category: 'bedrijf', example: '+31201234567' },
    { key: 'bedrijf.email',    label: 'Bedrijfse-mail',   category: 'bedrijf', example: 'info@deforexopleiding.nl' },
    // event (Fase 4 / Fase 3a) — Events-module
    { key: 'event.titel',      label: 'Event-titel', category: 'event', example: 'Forex Masterclass' },
    { key: 'event.datum',      label: 'Datum',       category: 'event', example: 'zaterdag 20 juni 2026' },
    { key: 'event.starttijd',  label: 'Starttijd',   category: 'event', example: '10:00' },
    { key: 'event.eindtijd',   label: 'Eindtijd',    category: 'event', example: '13:00' },
    { key: 'event.locatie',    label: 'Locatie',     category: 'event', example: 'Van der Valk, Gent' },
    { key: 'event.niveau',     label: 'Niveau',      category: 'event', example: 'Basis' },
    // attendee (Fase 3a / 3a-extra) — Events-module deelnemer
    { key: 'attendee.voornaam',   label: 'Voornaam',       category: 'attendee', example: 'Jeffrey' },
    { key: 'attendee.achternaam', label: 'Achternaam',     category: 'attendee', example: 'Biemold' },
    { key: 'attendee.naam',       label: 'Volledige naam', category: 'attendee', example: 'Jeffrey Biemold' },
    { key: 'attendee.email',      label: 'E-mail',         category: 'attendee', example: 'naam@voorbeeld.nl' },
    { key: 'attendee.telefoon',   label: 'Telefoon',       category: 'attendee', example: '+31 6 12345678' },
    { key: 'attendee.keuze_link',      label: 'Keuze-link',      category: 'attendee', example: 'https://forex-opleiding-interface.vercel.app/modules/event-keuze.html?t=...' },
    { key: 'attendee.vragenlijst_link', label: 'Vragenlijst-link', category: 'attendee', example: 'https://forex-opleiding-interface.vercel.app/modules/assessment.html?t=...' },
    // onboarding — server-side resolved op basis van meest recente onboardings-rij
    // voor de klant (server doet de DB-lookup; preview toont placeholder).
    { key: 'onboarding.persoonlijke_link', label: 'Persoonlijke onboarding-link', category: 'onboarding', example: 'https://forex-opleiding-interface.vercel.app/modules/onboarding.html?t=...' },
    { key: 'onboarding.startdatum',        label: 'Startdatum',                    category: 'onboarding', example: '20-06-2026' },
    { key: 'onboarding.traject',           label: 'Traject',                       category: 'onboarding', example: 'Forex Masterclass 1-op-1' },
    { key: 'onboarding.mentor',            label: 'Toegewezen mentor',             category: 'onboarding', example: 'Dave de Jong' },
    { key: 'onboarding.status',            label: 'Onboarding-status',             category: 'onboarding', example: 'aangemeld' },
    { key: 'onboarding.bubble_gebruikersnaam', label: 'Bubble gebruikersnaam (klant-email)', category: 'onboarding', example: 'klant@example.com' },
    // datum
    { key: 'datum.vandaag',     label: 'Datum vandaag', category: 'datum', example: '09-06-2026' },
    { key: 'datum.deze_maand',  label: 'Deze maand',    category: 'datum', example: 'juni 2026' },
    { key: 'datum.dit_jaar',    label: 'Dit jaar',      category: 'datum', example: '2026' },
  ];

  const WA_VAR_CATEGORY_LABELS = {
    customer:   'Klantgegevens',
    invoice:    'Factuur',
    klant:      'Klant (aggregaties)',
    afdeling:   'Afdeling (contact-info)',
    bedrijf:    'Bedrijfsgegevens',
    event:      'Event',
    attendee:   'Deelnemer',
    onboarding: 'Onboarding',
    datum:      'Datum',
  };
  // Voorkeursvolgorde voor bekende categorieën. Onbekende categorieën uit
  // WA_VAR_REGISTRY worden bij render automatisch achter de bekende geplakt
  // (in volgorde van eerste verschijning), zodat toekomstige categorieën
  // direct in de picker verschijnen zonder code-wijziging.
  const WA_VAR_CATEGORY_ORDER = ['customer', 'invoice', 'klant', 'afdeling', 'bedrijf', 'event', 'attendee', 'onboarding', 'datum'];
  // Groep-structuur (afdelings-koppen) boven de categorie-secties. Elke
  // groep heeft een title (NL-label, getoond als kop) en categories[]
  // (welke categorie-keys eronder vallen). Een categorie die in geen groep
  // staat valt automatisch in de "Overig"-fallback-groep onderaan — zo
  // verdwijnen toekomstige categorieën uit WA_VAR_REGISTRY nooit uit beeld,
  // ook als ze hier nog niet aan een groep zijn toegewezen.
  const WA_VAR_CATEGORY_GROUPS = [
    { title: 'Klant & facturatie', categories: ['customer', 'invoice', 'klant'] },
    { title: 'Events',             categories: ['event', 'attendee'] },
    { title: 'Onboarding',         categories: ['onboarding'] },
    { title: 'Algemeen',           categories: ['afdeling', 'bedrijf', 'datum'] },
  ];
  const WA_VAR_GROUPS_FALLBACK_TITLE = 'Overig';
  const WA_VAR_BY_KEY = (() => {
    const m = new Map();
    WA_VAR_REGISTRY.forEach(v => m.set(v.key, v));
    return m;
  })();

  const WA_VAR_NAMED_RE = /\{\{([a-z_]+\.[a-z_]+)\}\}/g;
  const WA_VAR_POSITIONAL_RE = /\{\{(\d+)\}\}/g;

  // Debounce helper.
  function _waTplDebounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  }

  // ─── WABA-list ──────────────────────────────────────────────────────────
  async function loadWaTplWabas() {
    const sel = document.getElementById('waTplWabaSelect');
    const hint = document.getElementById('waTplWabaHint');
    if (!sel) return;
    if (hint) hint.textContent = 'Laden…';
    try {
      const data = await apiRequest('GET', '/api/admin-whatsapp-wabas-list');
      if (data && data.error) throw new Error(data.error);
      _waTpl.wabas = (data && data.items) || [];
      if (!_waTpl.wabas.length) {
        sel.innerHTML = '<option value="">(geen WABA gekoppeld)</option>';
        if (hint) hint.textContent = 'Koppel eerst een module aan een phone_number_id met een business_account_id.';
        _waTpl.activeWaba = null;
        _waTpl.metaItems = []; renderWaMetaRows();
        _waTpl.qrItems = [];   renderWaQrRows();
        return;
      }
      sel.innerHTML = _waTpl.wabas.map(w => {
        const id = esc(w.business_account_id);
        const lbl = esc(w.display_label || w.module || w.business_account_id);
        return `<option value="${id}">${lbl} &middot; ${id}</option>`;
      }).join('');
      const stillPresent = _waTpl.activeWaba && _waTpl.wabas.some(w => w.business_account_id === _waTpl.activeWaba);
      if (!stillPresent) _waTpl.activeWaba = _waTpl.wabas[0].business_account_id;
      sel.value = _waTpl.activeWaba;
      if (hint) hint.textContent = '';
      if (_waTpl.activeSub === 'meta') loadWaMetaList();
      else loadWaQrList();
      _waTpl.loadedOnce = true;
    } catch (e) {
      sel.innerHTML = '<option value="">(fout bij laden)</option>';
      if (hint) hint.textContent = 'Fout: ' + e.message;
      console.warn('[waTpl] WABA-list laden mislukt:', e.message);
    }
  }

  // ─── Meta Templates list ────────────────────────────────────────────────
  async function loadWaMetaList() {
    const tbody = document.getElementById('waMetaTbody');
    if (!tbody) return;
    if (!_waTpl.activeWaba) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);padding:20px">Selecteer eerst een WABA.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);padding:20px">Laden&hellip;</td></tr>';
    try {
      // Parallel: templates + folders zodat de UI in 1 round-trip kan renderen.
      const [items, folders] = await Promise.all([
        apiRequest('GET', '/api/admin-meta-templates-list?business_account_id=' + encodeURIComponent(_waTpl.activeWaba)),
        apiRequest('GET', '/api/admin-template-folders-list?business_account_id=' + encodeURIComponent(_waTpl.activeWaba)).catch(() => ({ folders: [] })),
      ]);
      if (items && items.error) throw new Error(items.error);
      _waTpl.metaItems   = (items && items.items) || [];
      _waTpl.metaFolders = (folders && folders.folders) || [];
      renderWaMetaRows();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red);padding:20px">Fout: ${esc(e.message)}</td></tr>`;
    }
  }

  function waMetaStatusBadge(status, rejectionReason) {
    const map = {
      LOCAL:     { bg: '#e5e7eb', fg: '#374151' },
      SUBMITTED: { bg: '#fef3c7', fg: '#92400e' },
      APPROVED:  { bg: '#d1fae5', fg: '#065f46' },
      REJECTED:  { bg: '#fee2e2', fg: '#991b1b' },
      PAUSED:    { bg: '#ede9fe', fg: '#5b21b6' },
      DISABLED:  { bg: '#f3f4f6', fg: '#4b5563' },
    };
    const c = map[status] || { bg: '#f3f4f6', fg: '#374151' };
    let titleAttr = '';
    if (status === 'REJECTED' && rejectionReason) {
      const safe = esc(String(rejectionReason)).replace(/"/g, '&quot;');
      titleAttr = ` title="Rejection: ${safe}"`;
    }
    return `<span${titleAttr} style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11.5px;font-weight:600;background:${c.bg};color:${c.fg}">${esc(status || 'UNKNOWN')}</span>`;
  }

  function renderWaMetaTemplateRow(it) {
    const id        = esc(it.id || '');
    const name      = esc(it.name || '');
    const lang      = esc(it.language || '');
    const cat       = esc(it.category || '');
    const status    = it.status || 'LOCAL';
    const badge     = waMetaStatusBadge(status, it.rejection_reason);
    let actions = '';
    if (status === 'LOCAL') {
      actions = `
        <button class="action-btn" type="button" data-wa-meta-edit="${id}"><i class="ti ti-edit"></i> Bewerken</button>
        <button class="action-btn" type="button" data-wa-meta-del="${id}"><i class="ti ti-trash"></i> Verwijderen</button>
        <button class="action-btn" type="button" data-wa-meta-submit="${id}" style="background:#2563eb;color:#fff;border-color:#2563eb"><i class="ti ti-send"></i> Naar Meta sturen</button>
      `;
    } else if (status === 'SUBMITTED') {
      actions = `<button class="action-btn" type="button" data-wa-meta-view="${id}"><i class="ti ti-eye"></i> Bekijken</button>`;
    } else if (status === 'REJECTED') {
      actions = `
        <button class="action-btn" type="button" data-wa-meta-edit="${id}"><i class="ti ti-edit"></i> Bewerken</button>
        <button class="action-btn" type="button" data-wa-meta-del="${id}"><i class="ti ti-trash"></i> Verwijderen</button>
        <button class="action-btn" type="button" data-wa-meta-resubmit="${id}" style="background:#f97316;color:#fff;border-color:#f97316"><i class="ti ti-refresh"></i> Opnieuw insturen</button>
      `;
    } else if (status === 'APPROVED') {
      actions = `
        <button class="action-btn" type="button" data-wa-meta-view="${id}"><i class="ti ti-eye"></i> Bekijken</button>
        <button class="action-btn" type="button" data-wa-meta-dupliceer="${id}"><i class="ti ti-copy"></i> Dupliceer</button>
        <button class="action-btn" type="button" data-wa-meta-del="${id}" title="Verwijderen (ook bij Meta)" style="color:var(--red,#dc2626)"><i class="ti ti-trash"></i> Verwijderen</button>
      `;
    } else if (status === 'PAUSED' || status === 'DISABLED') {
      actions = `
        <button class="action-btn" type="button" data-wa-meta-view="${id}"><i class="ti ti-eye"></i> Bekijken</button>
        <button class="action-btn" type="button" data-wa-meta-del="${id}" title="Verwijderen (ook bij Meta)" style="color:var(--red,#dc2626)"><i class="ti ti-trash"></i> Verwijderen</button>
      `;
    } else {
      actions = `<button class="action-btn" type="button" data-wa-meta-view="${id}"><i class="ti ti-eye"></i> Bekijken</button>`;
    }
    // Drag-handle + draggable rij. cursor=grab voor visuele hint.
    return `<tr class="wa-meta-row" data-template-id="${id}" draggable="true" style="cursor:grab">
      <td><i class="ti ti-grip-vertical" style="color:var(--text-faint);margin-right:6px"></i><strong>${name}</strong></td>
      <td>${lang}</td>
      <td>${cat}</td>
      <td>${badge}</td>
      <td>${actions}</td>
    </tr>`;
  }

  function renderWaMetaFolderHeader(folder) {
    const id    = esc(folder.id || '');
    const name  = esc(folder.name || '');
    const count = Number(folder.template_count) || 0;
    return `<tr class="wa-folder-row" data-folder-id="${id}" style="background:rgba(99,102,241,0.06)">
      <td colspan="5" style="padding:10px 14px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:10px">
          <i class="ti ti-folder" style="color:var(--accent,#6366f1)"></i>
          <strong class="wa-folder-name" style="cursor:pointer" title="Dubbelklik om te hernoemen">${name}</strong>
          <span style="font-size:11.5px;color:var(--text-faint)">(${count})</span>
          <span style="flex:1"></span>
          <button class="action-btn" type="button" data-wa-folder-rename="${id}" title="Hernoemen"><i class="ti ti-pencil"></i></button>
          <button class="action-btn" type="button" data-wa-folder-del="${id}" title="Map verwijderen" style="color:var(--red,#dc2626)"><i class="ti ti-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }

  function renderWaMetaUngroupedHeader(count) {
    return `<tr class="wa-folder-row wa-folder-ungrouped" data-folder-id="" style="background:rgba(100,116,139,0.06)">
      <td colspan="5" style="padding:10px 14px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:10px">
          <i class="ti ti-inbox" style="color:var(--text-faint)"></i>
          <strong>Ongegroepeerd</strong>
          <span style="font-size:11.5px;color:var(--text-faint)">(${count})</span>
        </div>
      </td>
    </tr>`;
  }

  function renderWaMetaRows() {
    const tbody = document.getElementById('waMetaTbody');
    if (!tbody) return;
    if (!_waTpl.metaItems.length && !_waTpl.metaFolders.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);padding:20px">Nog geen templates. Klik op + Nieuwe template.</td></tr>';
      return;
    }
    const byFolder = new Map();
    const ungrouped = [];
    for (const it of _waTpl.metaItems) {
      if (it.folder_id) {
        if (!byFolder.has(it.folder_id)) byFolder.set(it.folder_id, []);
        byFolder.get(it.folder_id).push(it);
      } else {
        ungrouped.push(it);
      }
    }
    const parts = [];
    for (const f of _waTpl.metaFolders) {
      const inFolder = byFolder.get(f.id) || [];
      parts.push(renderWaMetaFolderHeader({ ...f, template_count: inFolder.length }));
      for (const it of inFolder) parts.push(renderWaMetaTemplateRow(it));
    }
    // Altijd "Ongegroepeerd"-zone tonen zodra er folders zijn (zodat er een drop-target
    // is om templates UIT een map te slepen). Zonder folders: alleen tonen bij content.
    if (ungrouped.length > 0 || _waTpl.metaFolders.length > 0) {
      parts.push(renderWaMetaUngroupedHeader(ungrouped.length));
      for (const it of ungrouped) parts.push(renderWaMetaTemplateRow(it));
    }
    tbody.innerHTML = parts.join('');
  }

  // ─── Quick Replies list ─────────────────────────────────────────────────
  async function loadWaQrList() {
    const tbody = document.getElementById('waQrTbody');
    if (!tbody) return;
    if (!_waTpl.activeWaba) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);padding:20px">Selecteer eerst een WABA.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);padding:20px">Laden&hellip;</td></tr>';
    try {
      const data = await apiRequest('GET', '/api/admin-quick-replies-list?business_account_id=' + encodeURIComponent(_waTpl.activeWaba));
      if (data && data.error) throw new Error(data.error);
      _waTpl.qrItems = (data && data.items) || [];
      renderWaQrRows();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--red);padding:20px">Fout: ${esc(e.message)}</td></tr>`;
    }
  }

  function renderWaQrRows() {
    const tbody = document.getElementById('waQrTbody');
    if (!tbody) return;
    if (!_waTpl.qrItems.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-faint);padding:20px">Nog geen snelle antwoorden. Klik op + Nieuwe snel antwoord.</td></tr>';
      return;
    }
    tbody.innerHTML = _waTpl.qrItems.map(it => {
      const id      = esc(it.id || '');
      const title   = esc(it.title || '');
      const body    = String(it.body_text || '');
      const trunc   = body.length > 80 ? body.slice(0, 80) + '…' : body;
      const sort    = Number.isFinite(it.sort_order) ? it.sort_order : 0;
      const active  = it.is_active !== false;
      const dot     = active
        ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px"></span>Actief'
        : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#9ca3af;margin-right:6px"></span>Inactief';
      return `<tr>
        <td><strong>${title}</strong></td>
        <td style="color:var(--text-dim)">${esc(trunc)}</td>
        <td>${sort}</td>
        <td>${dot}</td>
        <td>
          <button class="action-btn" type="button" data-wa-qr-edit="${id}"><i class="ti ti-edit"></i> Bewerken</button>
          <button class="action-btn" type="button" data-wa-qr-del="${id}"><i class="ti ti-trash"></i> Verwijderen</button>
        </td>
      </tr>`;
    }).join('');
  }

  // ─── Sub-tab switching ───────────────────────────────────────────────────
  function switchWaTplSub(sub) {
    if (sub !== 'meta' && sub !== 'quick') return;
    _waTpl.activeSub = sub;
    const metaPanel = document.getElementById('waTplSubMeta');
    const quickPanel = document.getElementById('waTplSubQuick');
    if (metaPanel)  metaPanel.hidden  = sub !== 'meta';
    if (quickPanel) quickPanel.hidden = sub !== 'quick';
    document.querySelectorAll('#waTplSubTabs [data-wa-tpl-sub]').forEach(btn => {
      const isActive = btn.getAttribute('data-wa-tpl-sub') === sub;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    if (sub === 'meta')  loadWaMetaList();
    else                 loadWaQrList();
  }

  // ─── Variable parsing + preview ─────────────────────────────────────────
  function parseTemplateVariables(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return [];
    const re = new RegExp(WA_VAR_POSITIONAL_RE.source, 'g');
    const seen = new Set();
    let m;
    while ((m = re.exec(bodyText)) !== null) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) seen.add(n);
    }
    return [...seen].sort((a, b) => a - b);
  }

  function parseTemplateNamedVariables(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return [];
    const re = new RegExp(WA_VAR_NAMED_RE.source, 'g');
    const seen = new Set();
    const result = [];
    let m;
    while ((m = re.exec(bodyText)) !== null) {
      const key = m[1];
      if (!seen.has(key)) { seen.add(key); result.push(key); }
    }
    return result;
  }

  function isMixedTemplateBody(bodyText) {
    return parseTemplateNamedVariables(bodyText).length > 0
      && parseTemplateVariables(bodyText).length > 0;
  }

  function renderWaMetaVarsPanel() {
    const host = document.getElementById('waMetaVarsPanelBody');
    if (!host) return;
    const byCat = new Map();
    WA_VAR_REGISTRY.forEach(v => {
      if (!byCat.has(v.category)) byCat.set(v.category, []);
      byCat.get(v.category).push(v);
    });

    // Render-volgorde binnen elke groep: ORDER-volgorde behouden, dan
    // categorieën uit de registry die niet in ORDER zitten erachter (in
    // registry-verschijningsvolgorde). Zo verschijnt een nieuwe categorie
    // automatisch — zowel binnen een toegewezen groep als in de
    // fallback-"Overig"-groep — zonder code-wijziging hier.
    const orderRank = new Map(WA_VAR_CATEGORY_ORDER.map((c, i) => [c, i]));
    function sortCats(cats) {
      // Bekende ORDER eerst (op ORDER-index), daarna onbekende in
      // registry-verschijningsvolgorde (zelfde als renderOrder-fallback in
      // de pre-groepen-versie).
      const known    = cats.filter(c => orderRank.has(c)).sort((a, b) => orderRank.get(a) - orderRank.get(b));
      const unknown  = [];
      const knownSet = new Set(known);
      WA_VAR_REGISTRY.forEach(v => {
        if (cats.includes(v.category) && !knownSet.has(v.category) && !unknown.includes(v.category)) {
          unknown.push(v.category);
        }
      });
      return [...known, ...unknown];
    }

    // Bepaal welke categorieën in een expliciete groep zitten.
    const assigned = new Set();
    WA_VAR_CATEGORY_GROUPS.forEach(g => g.categories.forEach(c => assigned.add(c)));

    // Onbekende categorieën uit de registry die in geen groep zitten →
    // fallback-groep "Overig" aan het eind (forward-compat: nieuwe
    // categorie toevoegen aan WA_VAR_REGISTRY zonder groep-mapping laat de
    // chips alsnog renderen).
    const fallbackCats = [];
    WA_VAR_REGISTRY.forEach(v => {
      if (!assigned.has(v.category) && !fallbackCats.includes(v.category) && byCat.has(v.category)) {
        fallbackCats.push(v.category);
      }
    });

    const groupsToRender = [...WA_VAR_CATEGORY_GROUPS];
    if (fallbackCats.length > 0) {
      groupsToRender.push({ title: WA_VAR_GROUPS_FALLBACK_TITLE, categories: fallbackCats });
    }

    let catIdx = 0;
    const html = groupsToRender.map(g => {
      const cats = sortCats(g.categories).filter(c => byCat.has(c));
      if (cats.length === 0) return '';
      const sections = cats.map(cat => {
        const open  = catIdx === 0 ? ' open' : '';
        catIdx++;
        const items = byCat.get(cat);
        const label = WA_VAR_CATEGORY_LABELS[cat] || cat;
        const chips = items.map(v => {
          const t = `{{${v.key}}}\n${v.label}\nVoorbeeld: ${v.example}`;
          return `<button type="button" class="wa-var-chip" data-wa-var-key="${esc(v.key)}" data-wa-var-example="${esc(v.example)}" title="${esc(t)}" aria-label="${esc(v.label)} (voorbeeld: ${esc(v.example)})">${esc(v.label)}</button>`;
        }).join('');
        return `<details${open}>
          <summary>${esc(label)}</summary>
          <div class="wa-var-chip-row">${chips}</div>
        </details>`;
      }).join('');
      return `<div class="wa-var-group">
        <h4 class="wa-var-group-title">${esc(g.title)}</h4>
        ${sections}
      </div>`;
    }).join('');
    host.innerHTML = html;
  }

  function _waMetaTrackFocus(id) {
    if (!id) return;
    _waTpl.metaLastFocusedFieldId = id;
  }
  function insertVariableAtCursor(key) {
    if (!key) return;
    const targetId = ['waMetaBodyText', 'waMetaFooterInput', 'waMetaHeaderText']
      .includes(_waTpl.metaLastFocusedFieldId) ? _waTpl.metaLastFocusedFieldId : 'waMetaBodyText';
    const el = document.getElementById(targetId);
    if (!el || el.disabled) return;
    const insertStr = '{{' + key + '}}';
    const start = (typeof el.selectionStart === 'number') ? el.selectionStart : (el.value || '').length;
    const end   = (typeof el.selectionEnd   === 'number') ? el.selectionEnd   : start;
    const value = el.value || '';
    el.value = value.slice(0, start) + insertStr + value.slice(end);
    const newPos = start + insertStr.length;
    try { el.setSelectionRange(newPos, newPos); } catch (_) { /* ignore */ }
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function validateWaMetaNamedKeys(bodyText) {
    const keys = parseTemplateNamedVariables(bodyText);
    return keys.filter(k => !WA_VAR_BY_KEY.has(k));
  }

  function renderWaMetaVarsBlock() {
    const bodyEl   = document.getElementById('waMetaBodyText');
    const block    = document.getElementById('waMetaVarsBlock');
    const labelEl  = document.getElementById('waMetaVarsBlockLabel');
    const listEl   = document.getElementById('waMetaVarsList');
    const inputsEl = document.getElementById('waMetaVarsInputs');
    const helpEl   = document.getElementById('waMetaVarsHelp');
    if (!bodyEl || !block || !inputsEl) return;
    const body = bodyEl.value || '';
    const named = parseTemplateNamedVariables(body);
    const positional = parseTemplateVariables(body);

    if (!named.length && !positional.length) {
      block.style.display = 'none';
      block.classList.remove('wa-vars-named');
      inputsEl.innerHTML = '';
      if (listEl) listEl.textContent = '';
      return;
    }

    if (named.length > 0 && positional.length === 0) {
      block.style.display = '';
      block.classList.add('wa-vars-named');
      if (labelEl) labelEl.textContent = 'Variabelen gevonden (named):';
      if (listEl) listEl.textContent = named.map(k => `{{${k}}}`).join(', ');
      if (helpEl) helpEl.textContent = 'Voorbeeldwaarden komen uit de registry — geen handmatige invoer nodig.';
      inputsEl.style.gridTemplateColumns = '1fr';
      inputsEl.innerHTML = named.map(k => {
        const v = WA_VAR_BY_KEY.get(k);
        if (!v) {
          return `<div class="wa-var-readonly-row">
            <span class="wa-var-readonly-key" style="background:rgba(239,68,68,0.15)">{{${esc(k)}}}</span>
            <span class="wa-var-readonly-example" style="color:#dc2626">onbekende variabele</span>
          </div>`;
        }
        return `<div class="wa-var-readonly-row">
          <span class="wa-var-readonly-key">{{${esc(k)}}}</span>
          <span class="wa-var-readonly-example">${esc(v.label)} &middot; voorbeeld: ${esc(v.example)}</span>
        </div>`;
      }).join('');
      if (window._waMetaReadOnly) applyWaMetaReadOnly(true);
      return;
    }

    // Positional (legacy)
    block.style.display = '';
    block.classList.remove('wa-vars-named');
    if (labelEl) labelEl.textContent = 'Variabelen gevonden:';
    if (helpEl) helpEl.textContent = 'Voorbeeldwaarden — gebruikt voor preview én als Meta sample bij submit.';
    inputsEl.style.gridTemplateColumns = '1fr 1fr';
    if (listEl) listEl.textContent = positional.map(n => `{{${n}}}`).join(', ');
    inputsEl.innerHTML = positional.map(n => {
      const cur = esc(_waTpl.metaCurrentExamples[String(n)] || '');
      return `<div>
        <label style="display:block;font-size:11.5px;font-weight:600;margin-bottom:3px">{{${n}}}</label>
        <input type="text" class="form-input" data-wa-meta-var="${n}" value="${cur}" placeholder="Voorbeeldwaarde voor {{${n}}}" />
      </div>`;
    }).join('');
    inputsEl.querySelectorAll('[data-wa-meta-var]').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.getAttribute('data-wa-meta-var');
        _waTpl.metaCurrentExamples[k] = inp.value;
        computeWaMetaPreview();
      });
    });
    if (window._waMetaReadOnly) applyWaMetaReadOnly(true);
  }

  function renderWaMetaButtons() {
    const list = document.getElementById('waMetaButtonsList');
    const addBtn = document.getElementById('waMetaBtnAddBtn');
    if (!list) return;
    if (addBtn) addBtn.disabled = _waTpl.metaButtonsDraft.length >= 10;
    // Per-type warnings: quick-reply max 3, CTA (URL+PHONE) max 2.
    const limitWarn = document.getElementById('waMetaButtonsLimitWarn');
    const counts = { QUICK_REPLY: 0, URL: 0, PHONE_NUMBER: 0 };
    for (const b of _waTpl.metaButtonsDraft) {
      const t = (b && b.type) || 'URL';
      if (counts[t] != null) counts[t]++;
    }
    const warns = [];
    if (counts.QUICK_REPLY > 3) warns.push('Max 3 quick-reply-knoppen');
    if (counts.URL + counts.PHONE_NUMBER > 2) warns.push('Max 2 CTA-knoppen (URL + telefoon)');
    if (_waTpl.metaButtonsDraft.length > 10) warns.push('Max 10 knoppen totaal');
    if (limitWarn) {
      if (warns.length) {
        limitWarn.style.display = '';
        limitWarn.textContent = '⚠ ' + warns.join('. ') + '.';
      } else {
        limitWarn.style.display = 'none';
      }
    }
    if (!_waTpl.metaButtonsDraft.length) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-faint)">Nog geen knoppen. Klik op + Knop toevoegen (max 10).</div>';
      return;
    }
    list.innerHTML = _waTpl.metaButtonsDraft.map((b, idx) => {
      const type     = b.type || 'URL';
      const text     = esc(b.text || '');
      const url      = esc(b.url || '');
      const phone    = esc(b.phone_number || '');
      const showUrl  = type === 'URL';
      const showPh   = type === 'PHONE_NUMBER';
      return `<div data-wa-meta-btn-row="${idx}" style="display:grid;grid-template-columns:140px 1fr 1fr auto;gap:6px;align-items:center;border:1px solid var(--border);border-radius:6px;padding:6px 8px">
        <select class="form-input" data-wa-meta-btn-type="${idx}" style="font-size:12px">
          <option value="URL"${type==='URL'?' selected':''}>URL</option>
          <option value="PHONE_NUMBER"${type==='PHONE_NUMBER'?' selected':''}>Telefoon</option>
          <option value="QUICK_REPLY"${type==='QUICK_REPLY'?' selected':''}>Snel antwoord</option>
        </select>
        <input type="text" class="form-input" data-wa-meta-btn-text="${idx}" value="${text}" placeholder="Knoptekst (max 25)" maxlength="25" style="font-size:12px" />
        <input type="text" class="form-input" data-wa-meta-btn-extra="${idx}"
          value="${showUrl ? url : (showPh ? phone : '')}"
          placeholder="${showUrl ? 'https://…' : (showPh ? '+31612345678' : '(geen extra veld)')}"
          ${type==='QUICK_REPLY' ? 'disabled' : ''}
          style="font-size:12px" />
        <button class="btn btn-sm" type="button" data-wa-meta-btn-del="${idx}" title="Knop verwijderen" style="padding:2px 8px"><i class="ti ti-trash"></i></button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-wa-meta-btn-type]').forEach(el => {
      el.addEventListener('change', () => {
        const idx = parseInt(el.getAttribute('data-wa-meta-btn-type'), 10);
        if (!_waTpl.metaButtonsDraft[idx]) return;
        _waTpl.metaButtonsDraft[idx].type = el.value;
        if (el.value === 'URL')          { _waTpl.metaButtonsDraft[idx].phone_number = ''; }
        if (el.value === 'PHONE_NUMBER') { _waTpl.metaButtonsDraft[idx].url = ''; }
        if (el.value === 'QUICK_REPLY')  { _waTpl.metaButtonsDraft[idx].url = ''; _waTpl.metaButtonsDraft[idx].phone_number = ''; }
        renderWaMetaButtons();
        computeWaMetaPreview();
      });
    });
    list.querySelectorAll('[data-wa-meta-btn-text]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = parseInt(el.getAttribute('data-wa-meta-btn-text'), 10);
        if (!_waTpl.metaButtonsDraft[idx]) return;
        _waTpl.metaButtonsDraft[idx].text = el.value;
        _waTplPreviewDebounced();
      });
    });
    list.querySelectorAll('[data-wa-meta-btn-extra]').forEach(el => {
      el.addEventListener('input', () => {
        const idx = parseInt(el.getAttribute('data-wa-meta-btn-extra'), 10);
        if (!_waTpl.metaButtonsDraft[idx]) return;
        const type = _waTpl.metaButtonsDraft[idx].type;
        if (type === 'URL') _waTpl.metaButtonsDraft[idx].url = el.value;
        else if (type === 'PHONE_NUMBER') _waTpl.metaButtonsDraft[idx].phone_number = el.value;
        _waTplPreviewDebounced();
      });
    });
    list.querySelectorAll('[data-wa-meta-btn-del]').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-wa-meta-btn-del'), 10);
        deleteWaMetaButton(idx);
      });
    });
    if (window._waMetaReadOnly) applyWaMetaReadOnly(true);
  }

  function addWaMetaButton() {
    if (_waTpl.metaButtonsDraft.length >= 10) return;
    _waTpl.metaButtonsDraft.push({ type: 'URL', text: '', url: '' });
    renderWaMetaButtons();
    computeWaMetaPreview();
  }

  function deleteWaMetaButton(idx) {
    if (idx < 0 || idx >= _waTpl.metaButtonsDraft.length) return;
    _waTpl.metaButtonsDraft.splice(idx, 1);
    renderWaMetaButtons();
    computeWaMetaPreview();
  }

  function computeWaMetaPreview() {
    const headerType    = (document.getElementById('waMetaHeaderType')?.value || 'NONE');
    const headerTextEl  = document.getElementById('waMetaHeaderText');
    const footerInput   = document.getElementById('waMetaFooterInput');
    const bodyEl        = document.getElementById('waMetaBodyText');
    const previewHeader = document.getElementById('waMetaPreviewHeader');
    const previewBody   = document.getElementById('waMetaPreviewBody');
    const previewFooter = document.getElementById('waMetaPreviewFooter');
    const previewBtns   = document.getElementById('waMetaPreviewButtons');
    if (!previewBody) return;

    if (previewHeader) {
      const headerUrlEl = document.getElementById('waMetaHeaderUrl');
      const headerUrl = (headerUrlEl?.value || '').trim();
      if (headerType === 'TEXT') {
        const txt = (headerTextEl?.value || '').trim();
        previewHeader.textContent = txt;
        previewHeader.style.display = txt ? '' : 'none';
      } else if (headerType === 'NONE') {
        previewHeader.textContent = '';
        previewHeader.style.display = 'none';
      } else if (headerType === 'IMAGE' && /^https?:\/\//i.test(headerUrl)) {
        // Fase B: toon thumbnail van het sample-image (na upload of na URL-plak).
        previewHeader.innerHTML = `<img src="${esc(headerUrl)}" alt="" style="display:block;max-width:240px;max-height:140px;border-radius:6px;object-fit:cover" />`;
        previewHeader.style.display = '';
      } else if (headerType === 'VIDEO' && /^https?:\/\//i.test(headerUrl)) {
        previewHeader.innerHTML = `<div style="display:flex;align-items:center;gap:8px;font-size:13px"><i class="ti ti-video" style="font-size:20px"></i><span>Video bijgevoegd</span></div>`;
        previewHeader.style.display = '';
      } else if (headerType === 'DOCUMENT' && /^https?:\/\//i.test(headerUrl)) {
        previewHeader.innerHTML = `<div style="display:flex;align-items:center;gap:8px;font-size:13px"><i class="ti ti-file-text" style="font-size:20px"></i><span>Document bijgevoegd</span></div>`;
        previewHeader.style.display = '';
      } else {
        // Geen sample beschikbaar nog -> placeholder.
        previewHeader.textContent = `[${headerType}]`;
        previewHeader.style.display = '';
      }
    }

    const rawBody = bodyEl?.value || '';
    const segments = [];
    const combinedRe = new RegExp(`(${WA_VAR_NAMED_RE.source}|${WA_VAR_POSITIONAL_RE.source})`, 'g');
    let lastIdx = 0;
    let m;
    while ((m = combinedRe.exec(rawBody)) !== null) {
      if (m.index > lastIdx) segments.push({ type: 'text', text: rawBody.slice(lastIdx, m.index) });
      const token = m[0];
      const inner = token.slice(2, -2);
      if (/^\d+$/.test(inner)) {
        const v = _waTpl.metaCurrentExamples[inner];
        segments.push({ type: (v && v.length) ? 'text' : 'placeholder', text: (v && v.length) ? v : token });
      } else {
        const reg = WA_VAR_BY_KEY.get(inner);
        if (reg) {
          segments.push({ type: 'text', text: reg.example });
        } else {
          segments.push({ type: 'unknown', text: token, key: inner });
        }
      }
      lastIdx = m.index + token.length;
    }
    if (lastIdx < rawBody.length) segments.push({ type: 'text', text: rawBody.slice(lastIdx) });
    if (!segments.length) {
      previewBody.textContent = 'Je bericht verschijnt hier…';
    } else {
      previewBody.innerHTML = segments.map(s => {
        if (s.type === 'unknown') {
          return `<span class="wa-preview-unknown" title="Onbekende variabele: ${esc(s.key)}"><span class="wa-preview-unknown-dot" aria-hidden="true"></span>${esc(s.text)}</span>`;
        }
        if (s.type === 'placeholder') {
          return `<span class="wa-preview-placeholder">${esc(s.text)}</span>`;
        }
        // Fase B: WhatsApp markdown render in tekst-segmenten.
        return _waApplyMarkdown(esc(s.text));
      }).join('') || 'Je bericht verschijnt hier…';
    }

    if (previewFooter) {
      const ft = (footerInput?.value || '').trim();
      previewFooter.textContent = ft;
      previewFooter.style.display = ft ? '' : 'none';
    }

    if (previewBtns) {
      if (!_waTpl.metaButtonsDraft.length) {
        previewBtns.innerHTML = '';
      } else {
        previewBtns.innerHTML = _waTpl.metaButtonsDraft.map(b => {
          const lbl = esc((b.text || '').trim() || '(knop)');
          const icon = b.type === 'URL' ? 'ti-external-link'
                     : b.type === 'PHONE_NUMBER' ? 'ti-phone'
                     : 'ti-message-circle';
          return `<div style="background:#fff;border-radius:8px;padding:8px 10px;text-align:center;color:#0a7cff;font-weight:600;font-size:13px;box-shadow:0 1px 1px rgba(0,0,0,0.06)"><i class="ti ${icon}" style="margin-right:6px"></i>${lbl}</div>`;
        }).join('');
      }
    }
  }
  function renderWaMetaBodyMappingWarn() {
    const bodyEl = document.getElementById('waMetaBodyText');
    const warnEl = document.getElementById('waMetaBodyMappingWarn');
    if (!bodyEl || !warnEl) return;
    const body = bodyEl.value || '';
    const named      = parseTemplateNamedVariables(body);
    const positional = parseTemplateVariables(body);
    // Warning alleen als er positionele placeholders zijn die niet auto-mapbaar
    // zijn (mengsel met named is óók problematisch). Pure named krijgt mapping
    // automatisch via upsert — dus geen warn nodig.
    warnEl.style.display = (positional.length > 0) ? '' : 'none';
    if (positional.length > 0 && named.length > 0) {
      warnEl.innerHTML = '<strong>Let op:</strong> deze body mengt named en positionele plaatshouders. Dat is ambigu voor auto-mapping; upsert laat <code>meta_param_mapping</code> ongemoeid. Splits in puur named of puur positioneel + handmatige mapping.';
    } else if (positional.length > 0) {
      warnEl.innerHTML = '<strong>Let op:</strong> deze template gebruikt positionele plaatshouders <code>{{1}}</code>, <code>{{2}}</code>&hellip; die geen auto-mapping krijgen. Meta weigert de template bij submit (error #132000). Vervang ze door named variabelen via de chips hieronder, of stel <code>meta_param_mapping</code> handmatig in.';
    }
  }

  const _waTplPreviewDebounced = _waTplDebounce(computeWaMetaPreview, 100);
  const _waTplVarsAndPreviewDebounced = _waTplDebounce(() => {
    renderWaMetaVarsBlock();
    renderWaMetaBodyMappingWarn();
    computeWaMetaPreview();
  }, 200);

  function applyWaMetaReadOnly(disabled) {
    const ids = [
      'waMetaNameInput', 'waMetaLangSelect', 'waMetaCatSelect',
      'waMetaHeaderType', 'waMetaHeaderText', 'waMetaHeaderUrl',
      'waMetaBodyText', 'waMetaFooterInput'
    ];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !!disabled;
    });
    const addBtn = document.getElementById('waMetaBtnAddBtn');
    if (addBtn) addBtn.disabled = !!disabled;
    const btnList = document.getElementById('waMetaButtonsList');
    if (btnList) {
      btnList.querySelectorAll('select, input, button').forEach(el => {
        if (disabled) el.disabled = true;
        else el.disabled = el.hasAttribute('data-original-disabled');
      });
    }
    const varsBlock = document.getElementById('waMetaVarsBlock');
    if (varsBlock) {
      varsBlock.querySelectorAll('input').forEach(el => { el.disabled = !!disabled; });
    }
    const varsPanel = document.getElementById('waMetaVarsPanel');
    if (varsPanel) {
      varsPanel.querySelectorAll('.wa-var-chip').forEach(el => { el.disabled = !!disabled; });
    }
    const saveBtn = document.getElementById('waMetaSaveBtn');
    if (saveBtn) {
      if (disabled) {
        saveBtn.textContent = 'Sluiten';
        saveBtn.onclick = closeWaMetaEdit;
        saveBtn.classList.remove('btn-primary');
      } else {
        saveBtn.textContent = 'Opslaan';
        saveBtn.onclick = saveWaMetaTemplate;
        saveBtn.classList.add('btn-primary');
      }
    }
  }

  function renderWaMetaStatusBanner(item) {
    const banner = document.getElementById('waMetaStatusBanner');
    if (!banner) return;
    const status = (item && item.status) || 'LOCAL';
    let bg = '', fg = '', border = '', html = '';
    if (status === 'SUBMITTED') {
      bg = '#f3f4f6'; fg = '#374151'; border = '#d1d5db';
      html = '<i class="ti ti-clock" style="margin-right:6px"></i>Wacht op Meta-review';
    } else if (status === 'APPROVED') {
      bg = '#d1fae5'; fg = '#065f46'; border = '#6ee7b7';
      let dateStr = '';
      if (item && item.approved_at) {
        try {
          const d = new Date(item.approved_at);
          if (!isNaN(d.getTime())) dateStr = d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch (_) { /* ignore */ }
      }
      html = '<i class="ti ti-circle-check" style="margin-right:6px"></i>Goedgekeurd door Meta'
        + (dateStr ? ' op ' + esc(dateStr) : '');
    } else if (status === 'REJECTED') {
      bg = '#fee2e2'; fg = '#991b1b'; border = '#fca5a5';
      const reason = (item && item.rejection_reason) ? esc(String(item.rejection_reason)) : 'onbekende reden';
      html = '<i class="ti ti-alert-triangle" style="margin-right:6px"></i>Afgewezen door Meta: '
        + reason
        + '<div style="font-weight:400;font-size:11.5px;margin-top:4px;opacity:0.85">Pas de content aan en stuur opnieuw in voor review.</div>';
    } else if (status === 'PAUSED' || status === 'DISABLED') {
      bg = '#fee2e2'; fg = '#991b1b'; border = '#fca5a5';
      html = '<i class="ti ti-player-pause" style="margin-right:6px"></i>Pause/Disable door Meta';
    } else {
      banner.hidden = true;
      banner.innerHTML = '';
      return;
    }
    banner.style.background = bg;
    banner.style.color = fg;
    banner.style.borderColor = border;
    banner.innerHTML = html;
    banner.hidden = false;
  }

  // ─── Meta Templates modal: open / save / delete ─────────────────────────
  function openWaMetaNew() {
    if (!_waTpl.activeWaba) {
      toast('Selecteer eerst een WABA', 'error');
      return;
    }
    ensureTemplatesModalsInjected();
    _waTpl.metaEditingId = null;
    _waTpl.metaButtonsDraft = [];
    _waTpl.metaCurrentExamples = {};
    window._waMetaReadOnly = false;
    renderWaMetaStatusBanner(null);
    document.getElementById('waMetaModalTitle').textContent = 'Nieuwe Meta template';
    const nameEl   = document.getElementById('waMetaNameInput');
    const langEl   = document.getElementById('waMetaLangSelect');
    const catEl    = document.getElementById('waMetaCatSelect');
    const htEl     = document.getElementById('waMetaHeaderType');
    const htTxtEl  = document.getElementById('waMetaHeaderText');
    const htUrlEl  = document.getElementById('waMetaHeaderUrl');
    const bodyEl   = document.getElementById('waMetaBodyText');
    const footerEl = document.getElementById('waMetaFooterInput');
    if (nameEl)   { nameEl.value = ''; nameEl.disabled = false; }
    if (langEl)   langEl.value = 'nl';
    if (catEl)    catEl.value = 'UTILITY';
    if (htEl)     htEl.value = 'NONE';
    if (htTxtEl)  htTxtEl.value = '';
    if (htUrlEl)  htUrlEl.value = '';
    if (bodyEl)   bodyEl.value = '';
    if (footerEl) footerEl.value = '';
    _waTpl.metaLastFocusedFieldId = 'waMetaBodyText';
    _updateWaMetaHeaderVisibility();
    renderWaMetaButtons();
    renderWaMetaVarsPanel();
    renderWaMetaVarsBlock();
    computeWaMetaPreview();
    applyWaMetaReadOnly(false);
    wireWaMetaModalOnce();
    const err = document.getElementById('waMetaError');
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    document.getElementById('waMetaEditModal').classList.remove('hidden');
  }

  function openWaMetaEdit(item) {
    if (!item) return;
    ensureTemplatesModalsInjected();
    _waTpl.metaEditingId = item.id;
    _waTpl.metaButtonsDraft = Array.isArray(item.buttons) ? item.buttons.map(b => ({ ...b })) : [];
    _waTpl.metaCurrentExamples = (item.body_examples && typeof item.body_examples === 'object') ? { ...item.body_examples } : {};
    const status = item.status || 'LOCAL';
    const readOnly = ['SUBMITTED', 'APPROVED', 'PAUSED', 'DISABLED'].includes(status);
    window._waMetaReadOnly = readOnly;
    const titleEl = document.getElementById('waMetaModalTitle');
    if (titleEl) {
      titleEl.textContent = readOnly
        ? ('Bekijk Meta template: ' + (item.name || ''))
        : ('Bewerk Meta template: ' + (item.name || ''));
    }
    renderWaMetaStatusBanner(item);
    const nameEl   = document.getElementById('waMetaNameInput');
    const langEl   = document.getElementById('waMetaLangSelect');
    const catEl    = document.getElementById('waMetaCatSelect');
    const htEl     = document.getElementById('waMetaHeaderType');
    const htTxtEl  = document.getElementById('waMetaHeaderText');
    const htUrlEl  = document.getElementById('waMetaHeaderUrl');
    const bodyEl   = document.getElementById('waMetaBodyText');
    const footerEl = document.getElementById('waMetaFooterInput');
    if (nameEl)   { nameEl.value = item.name || ''; nameEl.disabled = false; }
    if (langEl)   langEl.value = item.language || 'nl';
    if (catEl)    catEl.value = item.category || 'UTILITY';
    if (htEl)     htEl.value = item.header_type || 'NONE';
    if (htTxtEl)  htTxtEl.value = (item.header_content && item.header_content.text) || '';
    if (htUrlEl)  htUrlEl.value = (item.header_content && item.header_content.example_url) || '';
    if (bodyEl)   bodyEl.value = item.body_text || '';
    if (footerEl) footerEl.value = item.footer_text || '';
    _waTpl.metaLastFocusedFieldId = 'waMetaBodyText';
    _updateWaMetaHeaderVisibility();
    renderWaMetaButtons();
    renderWaMetaVarsPanel();
    renderWaMetaVarsBlock();
    computeWaMetaPreview();
    applyWaMetaReadOnly(readOnly);
    wireWaMetaModalOnce();
    const err = document.getElementById('waMetaError');
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    document.getElementById('waMetaEditModal').classList.remove('hidden');
  }

  function closeWaMetaEdit() {
    const m = document.getElementById('waMetaEditModal');
    if (m) m.classList.add('hidden');
    _waTpl.metaEditingId = null;
    _waTpl.metaButtonsDraft = [];
    _waTpl.metaCurrentExamples = {};
    window._waMetaReadOnly = false;
    const banner = document.getElementById('waMetaStatusBanner');
    if (banner) { banner.hidden = true; banner.innerHTML = ''; }
  }

  function _updateWaMetaHeaderVisibility() {
    const ht       = (document.getElementById('waMetaHeaderType')?.value || 'NONE');
    const txtGroup = document.getElementById('waMetaHeaderTextGroup');
    const urlGroup = document.getElementById('waMetaHeaderUrlGroup');
    if (txtGroup) txtGroup.hidden = ht !== 'TEXT';
    // urlGroup heeft inline style="display:none" als default (CSS-specificity
    // override van 'hidden'-attribute - lesson learned uit Fase A smoke). We
    // schakelen daarom via style.display autoritatief.
    if (urlGroup) {
      const showMedia = (ht === 'IMAGE' || ht === 'VIDEO' || ht === 'DOCUMENT');
      urlGroup.style.display = showMedia ? '' : 'none';
      if (showMedia) _waMetaSyncFileAccept();
    }
  }

  async function saveWaMetaTemplate() {
    const errEl = document.getElementById('waMetaError');
    const btn   = document.getElementById('waMetaSaveBtn');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
    const hideErr = () => { if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; } };
    hideErr();

    if (!_waTpl.activeWaba) { showErr('Geen actieve WABA — herlaad de pagina.'); return; }

    const name      = (document.getElementById('waMetaNameInput')?.value || '').trim();
    const language  = (document.getElementById('waMetaLangSelect')?.value || 'nl').trim();
    const category  = (document.getElementById('waMetaCatSelect')?.value || 'UTILITY').trim();
    const headerType = (document.getElementById('waMetaHeaderType')?.value || 'NONE').trim();
    const headerTxt = (document.getElementById('waMetaHeaderText')?.value || '').trim();
    const headerUrl = (document.getElementById('waMetaHeaderUrl')?.value || '').trim();
    const bodyText  = (document.getElementById('waMetaBodyText')?.value || '').trim();
    const footerTxt = (document.getElementById('waMetaFooterInput')?.value || '').trim();

    if (!name) { showErr('Naam is verplicht'); return; }
    if (!/^[a-z0-9_]+$/.test(name)) { showErr('Naam: alleen lowercase a-z, 0-9 en _'); return; }
    if (!bodyText) { showErr('Body is verplicht'); return; }

    if (isMixedTemplateBody(bodyText)) {
      showErr('Body bevat zowel named ({{klant.naam}}) als positionele ({{1}}) placeholders. Kies één stijl.');
      return;
    }
    const unknownKeys = validateWaMetaNamedKeys(bodyText);
    if (unknownKeys.length) {
      const list = unknownKeys.map(k => '{{' + k + '}}').join(', ');
      const plural = unknownKeys.length === 1 ? 'variabele' : 'variabelen';
      showErr(
        'Onbekende ' + plural + ' in body: ' + list +
        '. Controleer de spelling — geldige keys staan als chips in het variabelen-paneel onder de body.'
      );
      return;
    }

    let headerContent = null;
    if (headerType === 'TEXT') headerContent = { text: headerTxt };
    else if (headerType === 'IMAGE' || headerType === 'VIDEO' || headerType === 'DOCUMENT') {
      headerContent = headerUrl ? { example_url: headerUrl } : null;
    }

    const vars = parseTemplateVariables(bodyText);
    const examples = {};
    vars.forEach(n => {
      const v = _waTpl.metaCurrentExamples[String(n)];
      if (v != null && String(v).length) examples[String(n)] = String(v);
    });

    const buttons = _waTpl.metaButtonsDraft
      .filter(b => b && b.type && (b.text || '').trim())
      .map(b => {
        const out = { type: b.type, text: String(b.text).trim() };
        if (b.type === 'URL') out.url = String(b.url || '').trim();
        if (b.type === 'PHONE_NUMBER') out.phone_number = String(b.phone_number || '').trim();
        return out;
      });

    const payload = {
      business_account_id: _waTpl.activeWaba,
      name,
      language,
      category,
      header_type:    headerType,
      header_content: headerContent,
      body_text:      bodyText,
      body_examples:  Object.keys(examples).length ? examples : null,
      footer_text:    footerTxt || null,
      buttons:        buttons.length ? buttons : null,
    };

    if (btn) { btn.disabled = true; btn.textContent = 'Opslaan…'; }
    try {
      const method = _waTpl.metaEditingId ? 'PATCH' : 'POST';
      const path   = '/api/admin-meta-templates-upsert' + (_waTpl.metaEditingId ? `?id=${encodeURIComponent(_waTpl.metaEditingId)}` : '');
      const data   = await apiRequest(method, path, payload);
      if (data && data.error) {
        showErr(data.error);
        return;
      }
      toast('Template opgeslagen', 'success');
      closeWaMetaEdit();
      loadWaMetaList();
    } catch (e) {
      showErr(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Opslaan'; }
    }
  }

  async function deleteWaMetaTemplate(item) {
    if (!item) return;
    const status = item.status || 'LOCAL';
    const needsMeta = (status === 'APPROVED' || status === 'PAUSED' || status === 'DISABLED' || status === 'SUBMITTED');
    const msg = needsMeta
      ? `Template "${item.name}" verwijderen?\n\nDit verwijdert 'm OOK bij Meta (definitief). Doorgaan?`
      : `Template "${item.name}" verwijderen?`;
    if (!confirm(msg)) return;
    try {
      const data = await apiRequest('DELETE', '/api/admin-meta-templates-delete?id=' + encodeURIComponent(item.id));
      if (data && data.error) {
        alert('Verwijderen mislukt: ' + data.error);
        return;
      }
      let tail = '';
      if (data && data.meta_already_gone) tail = ' (Meta wist hem al)';
      else if (data && data.meta_deleted)  tail = ' (incl. Meta)';
      toast('Template verwijderd' + tail, 'success');
      loadWaMetaList();
    } catch (e) {
      alert('Verwijderen mislukt: ' + e.message);
    }
  }

  // ─── Folder-CRUD + drag-drop move ─────────────────────────────────────────
  async function doWaFolderCreate() {
    if (!_waTpl.activeWaba) { toast('Selecteer eerst een WABA', 'error'); return; }
    const name = window.prompt('Naam voor de nieuwe map:');
    if (!name) return;
    const trimmed = String(name).trim();
    if (!trimmed) return;
    try {
      const data = await apiRequest('POST', '/api/admin-template-folders-create', {
        business_account_id: _waTpl.activeWaba,
        name: trimmed,
      });
      if (data && data.error) { alert('Aanmaken mislukt: ' + data.error); return; }
      toast('Map aangemaakt', 'success');
      loadWaMetaList();
    } catch (e) {
      alert('Aanmaken mislukt: ' + e.message);
    }
  }

  async function doWaFolderRename(folder) {
    if (!folder) return;
    const name = window.prompt('Nieuwe naam voor map:', folder.name || '');
    if (!name) return;
    const trimmed = String(name).trim();
    if (!trimmed || trimmed === folder.name) return;
    try {
      const data = await apiRequest('PATCH', '/api/admin-template-folders-rename?id=' + encodeURIComponent(folder.id), { name: trimmed });
      if (data && data.error) { alert('Hernoemen mislukt: ' + data.error); return; }
      toast('Map hernoemd', 'success');
      loadWaMetaList();
    } catch (e) {
      alert('Hernoemen mislukt: ' + e.message);
    }
  }

  async function doWaFolderDelete(folder) {
    if (!folder) return;
    if (!confirm(`Map '${folder.name}' verwijderen? Templates blijven behouden maar verliezen folder-toewijzing.`)) return;
    try {
      const data = await apiRequest('DELETE', '/api/admin-template-folders-delete?id=' + encodeURIComponent(folder.id));
      if (data && data.error) { alert('Verwijderen mislukt: ' + data.error); return; }
      toast('Map verwijderd', 'success');
      loadWaMetaList();
    } catch (e) {
      alert('Verwijderen mislukt: ' + e.message);
    }
  }

  async function moveTemplateToFolder(templateId, folderId) {
    try {
      const data = await apiRequest('POST', '/api/admin-template-folder-move', {
        template_id: templateId,
        folder_id  : folderId,
      });
      if (data && data.error) { alert('Verplaatsen mislukt: ' + data.error); return; }
      loadWaMetaList();
    } catch (e) {
      alert('Verplaatsen mislukt: ' + e.message);
    }
  }

  // ─── Meta sync / submit / resubmit / duplicate ────────────────────────────
  function formatMetaError(err) {
    const me = err?.meta_error || err?.data?.meta_error || null;
    if (me && (me.error_user_title || me.error_user_msg)) {
      const title = me.error_user_title || 'Meta-fout';
      const msg = me.error_user_msg || '';
      const trace = me.fbtrace_id ? ` (trace: ${me.fbtrace_id})` : '';
      return msg ? `${title}\n${msg}${trace}` : `${title}${trace}`;
    }
    return err?.error || err?.message || 'Onbekende fout';
  }

  async function doWaMetaSync() {
    if (!_waTpl.activeWaba) {
      toast('Selecteer eerst een WABA', 'error');
      return;
    }
    const btn = document.getElementById('waMetaSyncBtn');
    const orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Bezig…'; }
    try {
      const data = await apiRequest('POST', '/api/admin-meta-templates-sync', { business_account_id: _waTpl.activeWaba });
      if (data && data.error) {
        toast('Sync mislukt: ' + formatMetaError(data), 'error');
        return;
      }
      const scanned = (data && (data.scanned ?? data.synced)) ?? 0;
      const updated = (data && data.updated) ?? 0;
      const created = (data && data.created) ?? 0;
      const parts = [`${scanned} gesynchroniseerd`];
      if (updated) parts.push(`${updated} status-wijziging${updated === 1 ? '' : 'en'}`);
      if (created) parts.push(`${created} nieuw`);
      toast(parts.join(', '), 'success');
      await loadWaMetaList();
    } catch (e) {
      toast('Sync mislukt: ' + (e?.message || 'Onbekende fout'), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
  }

  async function doWaMetaSubmit(item) {
    if (!item) return;
    if (!confirm(`Template '${item.name}' naar Meta sturen voor goedkeuring? Daarna is bewerken alleen mogelijk na rejection.`)) return;
    try {
      const data = await apiRequest('POST', '/api/admin-meta-templates-submit', { template_id: item.id });
      if (data && data.error) {
        toast('Submit mislukt: ' + formatMetaError(data), 'error');
        return;
      }
      toast('Template ingestuurd bij Meta', 'success');
      await loadWaMetaList();
    } catch (e) {
      toast('Submit mislukt: ' + (e?.message || 'Onbekende fout'), 'error');
    }
  }

  async function doWaMetaResubmit(item) {
    if (!item) return;
    if (!confirm(`Template '${item.name}' opnieuw insturen na rejection?`)) return;
    try {
      const data = await apiRequest('POST', '/api/admin-meta-templates-submit', { template_id: item.id });
      if (data && data.error) {
        toast('Opnieuw insturen mislukt: ' + formatMetaError(data), 'error');
        return;
      }
      toast('Template opnieuw ingestuurd', 'success');
      await loadWaMetaList();
    } catch (e) {
      toast('Opnieuw insturen mislukt: ' + (e?.message || 'Onbekende fout'), 'error');
    }
  }

  async function doWaMetaDuplicate(item) {
    if (!item) return;
    if (!_waTpl.activeWaba) {
      toast('Geen actieve WABA', 'error');
      return;
    }
    const base = String(item.name || '').replace(/_v\d+$/, '');
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_v(\\d+)$');
    let maxN = 1;
    for (const it of _waTpl.metaItems) {
      if (it.name === base) maxN = Math.max(maxN, 1);
      const m = re.exec(it.name || '');
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    const newName = `${base}_v${maxN + 1}`;

    const payload = {
      business_account_id: _waTpl.activeWaba,
      name:           newName,
      language:       item.language || 'nl',
      category:       item.category || 'UTILITY',
      header_type:    item.header_type || 'NONE',
      header_content: item.header_content || null,
      body_text:      item.body_text || '',
      body_examples:  item.body_examples || null,
      footer_text:    item.footer_text || null,
      buttons:        Array.isArray(item.buttons) && item.buttons.length ? item.buttons.map(b => ({ ...b })) : null,
    };
    try {
      const data = await apiRequest('POST', '/api/admin-meta-templates-upsert', payload);
      if (data && data.error) {
        toast('Dupliceer mislukt: ' + data.error, 'error');
        return;
      }
      toast('Dupliceer aangemaakt: ' + newName, 'success');
      await loadWaMetaList();
    } catch (e) {
      toast('Dupliceer mislukt: ' + e.message, 'error');
    }
  }

  // ─── Quick Replies modal ──────────────────────────────────────────────────
  function openWaQrNew() {
    if (!_waTpl.activeWaba) {
      toast('Selecteer eerst een WABA', 'error');
      return;
    }
    ensureTemplatesModalsInjected();
    _waTpl.qrEditingId = null;
    document.getElementById('waQrModalTitle').textContent = 'Nieuwe snel antwoord';
    const titleEl  = document.getElementById('waQrTitleInput');
    const bodyEl   = document.getElementById('waQrBodyInput');
    const sortEl   = document.getElementById('waQrSortInput');
    const activeEl = document.getElementById('waQrActiveInput');
    if (titleEl)  titleEl.value = '';
    if (bodyEl)   bodyEl.value = '';
    if (sortEl)   sortEl.value = '0';
    if (activeEl) activeEl.checked = true;
    wireWaQrModalOnce();
    const err = document.getElementById('waQrError');
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    document.getElementById('waQrEditModal').classList.remove('hidden');
  }

  function openWaQrEdit(item) {
    if (!item) return;
    ensureTemplatesModalsInjected();
    _waTpl.qrEditingId = item.id;
    document.getElementById('waQrModalTitle').textContent = 'Snel antwoord bewerken';
    const titleEl  = document.getElementById('waQrTitleInput');
    const bodyEl   = document.getElementById('waQrBodyInput');
    const sortEl   = document.getElementById('waQrSortInput');
    const activeEl = document.getElementById('waQrActiveInput');
    if (titleEl)  titleEl.value = item.title || '';
    if (bodyEl)   bodyEl.value = item.body_text || '';
    if (sortEl)   sortEl.value = String(Number.isFinite(item.sort_order) ? item.sort_order : 0);
    if (activeEl) activeEl.checked = item.is_active !== false;
    wireWaQrModalOnce();
    const err = document.getElementById('waQrError');
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    document.getElementById('waQrEditModal').classList.remove('hidden');
  }

  function closeWaQrEdit() {
    const m = document.getElementById('waQrEditModal');
    if (m) m.classList.add('hidden');
    _waTpl.qrEditingId = null;
  }

  async function saveWaQuickReply() {
    const errEl = document.getElementById('waQrError');
    const btn   = document.getElementById('waQrSaveBtn');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
    const hideErr = () => { if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; } };
    hideErr();

    if (!_waTpl.activeWaba) { showErr('Geen actieve WABA — herlaad de pagina.'); return; }

    const title    = (document.getElementById('waQrTitleInput')?.value || '').trim();
    const bodyText = (document.getElementById('waQrBodyInput')?.value || '').trim();
    const sortRaw  = (document.getElementById('waQrSortInput')?.value || '0').trim();
    const isActive = !!document.getElementById('waQrActiveInput')?.checked;

    if (!title)    { showErr('Titel is verplicht'); return; }
    if (!bodyText) { showErr('Body is verplicht'); return; }
    const sort = parseInt(sortRaw, 10);
    if (!Number.isFinite(sort)) { showErr('Sorteervolgorde moet een geheel getal zijn'); return; }

    const payload = {
      business_account_id: _waTpl.activeWaba,
      title,
      body_text:  bodyText,
      sort_order: sort,
      is_active:  isActive,
    };

    if (btn) { btn.disabled = true; btn.textContent = 'Opslaan…'; }
    try {
      const method = _waTpl.qrEditingId ? 'PATCH' : 'POST';
      const path   = '/api/admin-quick-replies-upsert' + (_waTpl.qrEditingId ? `?id=${encodeURIComponent(_waTpl.qrEditingId)}` : '');
      const data   = await apiRequest(method, path, payload);
      if (data && data.error) { showErr(data.error); return; }
      toast('Snel antwoord opgeslagen', 'success');
      closeWaQrEdit();
      loadWaQrList();
    } catch (e) {
      showErr(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Opslaan'; }
    }
  }

  async function deleteWaQuickReply(item) {
    if (!item) return;
    if (!confirm(`Snel antwoord '${item.title}' verwijderen?`)) return;
    try {
      const data = await apiRequest('DELETE', '/api/admin-quick-replies-delete?id=' + encodeURIComponent(item.id));
      if (data && data.error) { alert('Verwijderen mislukt: ' + data.error); return; }
      toast('Snel antwoord verwijderd', 'success');
      loadWaQrList();
    } catch (e) {
      alert('Verwijderen mislukt: ' + e.message);
    }
  }

  // ─── Master wiring (one-time per host) ──────────────────────────────────
  function wireWaTplOnce() {
    if (_waTpl.wired) return;
    _waTpl.wired = true;
    ensureTemplatesModalsInjected();
    const host = _state.hostMounted;
    if (!host) return;

    const wabaSel = host.querySelector('#waTplWabaSelect');
    if (wabaSel) {
      wabaSel.addEventListener('change', () => {
        _waTpl.activeWaba = wabaSel.value || null;
        if (_waTpl.activeSub === 'meta') loadWaMetaList();
        else loadWaQrList();
      });
    }
    const wabaRefreshBtn = host.querySelector('#waTplWabaRefreshBtn');
    if (wabaRefreshBtn) wabaRefreshBtn.addEventListener('click', () => loadWaTplWabas());

    host.querySelectorAll('#waTplSubTabs [data-wa-tpl-sub]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sub = btn.getAttribute('data-wa-tpl-sub');
        switchWaTplSub(sub);
      });
    });

    const reloadBtn = host.querySelector('#waTplReloadBtn');
    if (reloadBtn) reloadBtn.addEventListener('click', () => {
      if (_waTpl.activeSub === 'meta') loadWaMetaList();
      else loadWaQrList();
    });

    const metaNewBtn = host.querySelector('#waMetaNewBtn');
    if (metaNewBtn) metaNewBtn.addEventListener('click', () => openWaMetaNew());
    const qrNewBtn = host.querySelector('#waQrNewBtn');
    if (qrNewBtn) qrNewBtn.addEventListener('click', () => openWaQrNew());

    const metaTbody = host.querySelector('#waMetaTbody');
    if (metaTbody) {
      metaTbody.addEventListener('click', (e) => {
        const editBtn     = e.target.closest('[data-wa-meta-edit]');
        const delBtn      = e.target.closest('[data-wa-meta-del]');
        const viewBtn     = e.target.closest('[data-wa-meta-view]');
        const submitBtn   = e.target.closest('[data-wa-meta-submit]');
        const resubmitBtn = e.target.closest('[data-wa-meta-resubmit]');
        const dupBtn      = e.target.closest('[data-wa-meta-dupliceer]');
        const findItem = (btn, attr) => {
          const id = btn.getAttribute(attr);
          return _waTpl.metaItems.find(it => String(it.id) === id);
        };
        if (editBtn && !editBtn.disabled) {
          const item = findItem(editBtn, 'data-wa-meta-edit');
          if (item) openWaMetaEdit(item);
        } else if (delBtn && !delBtn.disabled) {
          const item = findItem(delBtn, 'data-wa-meta-del');
          if (item) deleteWaMetaTemplate(item);
        } else if (viewBtn && !viewBtn.disabled) {
          const item = findItem(viewBtn, 'data-wa-meta-view');
          if (item) openWaMetaEdit(item);
        } else if (submitBtn && !submitBtn.disabled) {
          const item = findItem(submitBtn, 'data-wa-meta-submit');
          if (item) doWaMetaSubmit(item);
        } else if (resubmitBtn && !resubmitBtn.disabled) {
          const item = findItem(resubmitBtn, 'data-wa-meta-resubmit');
          if (item) doWaMetaResubmit(item);
        } else if (dupBtn && !dupBtn.disabled) {
          const item = findItem(dupBtn, 'data-wa-meta-dupliceer');
          if (item) doWaMetaDuplicate(item);
        }
        // Folder-acties.
        const fRenameBtn = e.target.closest('[data-wa-folder-rename]');
        const fDelBtn    = e.target.closest('[data-wa-folder-del]');
        if (fRenameBtn) {
          const id = fRenameBtn.getAttribute('data-wa-folder-rename');
          const f  = _waTpl.metaFolders.find(x => String(x.id) === id);
          if (f) doWaFolderRename(f);
        } else if (fDelBtn) {
          const id = fDelBtn.getAttribute('data-wa-folder-del');
          const f  = _waTpl.metaFolders.find(x => String(x.id) === id);
          if (f) doWaFolderDelete(f);
        }
      });
      // Dubbelklik op folder-naam → inline rename (matched de pencil-knop hierboven).
      metaTbody.addEventListener('dblclick', (e) => {
        const nameEl = e.target.closest('.wa-folder-name');
        if (!nameEl) return;
        const row = nameEl.closest('.wa-folder-row');
        if (!row) return;
        const id  = row.getAttribute('data-folder-id');
        if (!id) return;
        const f = _waTpl.metaFolders.find(x => String(x.id) === id);
        if (f) doWaFolderRename(f);
      });
      // Drag-and-drop: HTML5 native API, geen library.
      metaTbody.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.wa-meta-row[data-template-id]');
        if (!row) return;
        const id = row.getAttribute('data-template-id') || '';
        try {
          e.dataTransfer.setData('text/wa-template-id', id);
          e.dataTransfer.effectAllowed = 'move';
        } catch {}
        row.style.opacity = '0.55';
      });
      metaTbody.addEventListener('dragend', (e) => {
        const row = e.target.closest('.wa-meta-row[data-template-id]');
        if (row) row.style.opacity = '';
        metaTbody.querySelectorAll('.wa-folder-row.drop-target')
          .forEach((el) => el.classList.remove('drop-target'));
      });
      metaTbody.addEventListener('dragover', (e) => {
        const target = e.target.closest('.wa-folder-row');
        if (!target) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch {}
        target.classList.add('drop-target');
        target.style.background = 'rgba(99,102,241,0.18)';
      });
      metaTbody.addEventListener('dragleave', (e) => {
        const target = e.target.closest('.wa-folder-row');
        if (!target) return;
        target.classList.remove('drop-target');
        // Reset alleen als we echt uit de rij bewegen (relatedTarget buiten rij).
        if (!target.contains(e.relatedTarget)) {
          target.style.background = target.classList.contains('wa-folder-ungrouped')
            ? 'rgba(100,116,139,0.06)'
            : 'rgba(99,102,241,0.06)';
        }
      });
      metaTbody.addEventListener('drop', async (e) => {
        const target = e.target.closest('.wa-folder-row');
        if (!target) return;
        e.preventDefault();
        target.classList.remove('drop-target');
        let templateId = '';
        try { templateId = e.dataTransfer.getData('text/wa-template-id') || ''; } catch {}
        if (!templateId) return;
        const folderIdRaw = target.getAttribute('data-folder-id');
        const folderId = folderIdRaw ? folderIdRaw : null;
        await moveTemplateToFolder(templateId, folderId);
      });
    }
    const metaNewFolderBtn = host.querySelector('#waMetaNewFolderBtn');
    if (metaNewFolderBtn) metaNewFolderBtn.addEventListener('click', () => doWaFolderCreate());
    const metaSyncBtn = host.querySelector('#waMetaSyncBtn');
    if (metaSyncBtn) metaSyncBtn.addEventListener('click', () => doWaMetaSync());
    const qrTbody = host.querySelector('#waQrTbody');
    if (qrTbody) {
      qrTbody.addEventListener('click', (e) => {
        const editBtn = e.target.closest('[data-wa-qr-edit]');
        const delBtn  = e.target.closest('[data-wa-qr-del]');
        if (editBtn) {
          const id = editBtn.getAttribute('data-wa-qr-edit');
          const item = _waTpl.qrItems.find(it => String(it.id) === id);
          if (item) openWaQrEdit(item);
        } else if (delBtn) {
          const id = delBtn.getAttribute('data-wa-qr-del');
          const item = _waTpl.qrItems.find(it => String(it.id) === id);
          if (item) deleteWaQuickReply(item);
        }
      });
    }
  }

  // Modal-level wiring: event-binding op velden in de modal. Idempotent
  // via flag (omdat we open meermalig kunnen aanroepen). Hangs on document
  // ── Fase B helpers ────────────────────────────────────────────────────────

  // WhatsApp-markdown renderer voor preview. Krijgt al-geëscapete text als
  // input en wrapt *bold*, _italic_, ~strike~, `mono` in HTML-tags. Werkt
  // alleen op single-line spans (geen \n in de groep) zodat we niet
  // ongewenst over regelbreaken matchen.
  function _waApplyMarkdown(escaped) {
    if (!escaped || typeof escaped !== 'string') return '';
    let out = escaped;
    // Code eerst (zo blijft markup binnen `…` letterlijk).
    out = out.replace(/`([^`\n]+?)`/g, '<code style="font-family:ui-monospace,Menlo,Monaco,Consolas,monospace;background:rgba(0,0,0,0.08);padding:0 3px;border-radius:3px">$1</code>');
    out = out.replace(/\*([^*\n]+?)\*/g, '<b>$1</b>');
    out = out.replace(/_([^_\n]+?)_/g, '<i>$1</i>');
    out = out.replace(/~([^~\n]+?)~/g, '<s>$1</s>');
    return out;
  }

  // Wrap-selectie in body-textarea voor opmaak-toolbar. fmt ∈
  // 'bold'|'italic'|'strike'|'code'. Bij lege selectie: cursor tussen
  // de wrappers plaatsen zodat gebruiker direct kan typen.
  function _waMetaApplyFormat(fmt) {
    const ta = document.getElementById('waMetaBodyText');
    if (!ta) return;
    const wrap = fmt === 'bold' ? '*' : fmt === 'italic' ? '_' : fmt === 'strike' ? '~' : '`';
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    const value = ta.value;
    const before = value.slice(0, start);
    const middle = value.slice(start, end);
    const after  = value.slice(end);
    ta.value = before + wrap + middle + wrap + after;
    const cursorStart = before.length + wrap.length;
    const cursorEnd   = cursorStart + middle.length;
    ta.focus();
    try { ta.setSelectionRange(cursorStart, cursorEnd); } catch {}
    // Trigger input-events zodat preview + vars-panel updaten.
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Upload-helpers voor header-file-picker. Reuse /api/whatsapp-media-upload
  // uit Fase A; output-URL wordt in waMetaHeaderUrl-input geschreven en als
  // example_url naar de submit-payload meegestuurd door bestaande logica.
  const _WA_META_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
  const _WA_META_UPLOAD_ACCEPT = {
    IMAGE   : 'image/jpeg,image/png',
    VIDEO   : 'video/mp4,video/3gpp',
    DOCUMENT: 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain',
  };

  function _waMetaSyncFileAccept() {
    const fileEl = document.getElementById('waMetaHeaderFileInput');
    const ht = (document.getElementById('waMetaHeaderType')?.value || 'NONE');
    if (!fileEl) return;
    if (_WA_META_UPLOAD_ACCEPT[ht]) fileEl.accept = _WA_META_UPLOAD_ACCEPT[ht];
    else fileEl.accept = '';
  }

  function _waMetaClearHeaderFile() {
    const fileEl   = document.getElementById('waMetaHeaderFileInput');
    const status   = document.getElementById('waMetaHeaderFileStatus');
    const clearBtn = document.getElementById('waMetaHeaderFileClearBtn');
    if (fileEl) fileEl.value = '';
    if (status) { status.style.color = 'var(--text-faint)'; status.textContent = 'Geen bestand gekozen (max ~3 MB).'; }
    if (clearBtn) clearBtn.hidden = true;
  }

  function _waMetaFileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(file);
    });
  }

  async function _waMetaHandleHeaderFilePick() {
    const ht = (document.getElementById('waMetaHeaderType')?.value || 'NONE');
    if (ht !== 'IMAGE' && ht !== 'VIDEO' && ht !== 'DOCUMENT') {
      return; // veiligheidsklep
    }
    const fileEl   = document.getElementById('waMetaHeaderFileInput');
    const urlEl    = document.getElementById('waMetaHeaderUrl');
    const status   = document.getElementById('waMetaHeaderFileStatus');
    const clearBtn = document.getElementById('waMetaHeaderFileClearBtn');
    const file = fileEl && fileEl.files && fileEl.files[0] ? fileEl.files[0] : null;
    if (!file) return;
    if (file.size > _WA_META_UPLOAD_MAX_BYTES) {
      if (status) { status.style.color = '#dc2626'; status.textContent = 'Bestand te groot (' + (file.size / 1024 / 1024).toFixed(1) + ' MB > 3 MB). Splits het op of gebruik Fase C (komt later).'; }
      if (clearBtn) clearBtn.hidden = false;
      return;
    }
    if (status) { status.style.color = 'var(--text-dim)'; status.textContent = 'Uploaden naar storage…'; }
    try {
      const b64 = await _waMetaFileToBase64(file);
      const kind = ht.toLowerCase();
      const resp = await window.AgentShared.apiFetch('/api/whatsapp-media-upload', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({
          filename     : file.name,
          content_type : file.type || 'application/octet-stream',
          kind,
          data_base64  : b64,
        }),
      });
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok || !r || !r.ok) {
        if (status) { status.style.color = '#dc2626'; status.textContent = 'Upload mislukt: ' + ((r && r.error) || ('HTTP ' + resp.status)); }
        if (clearBtn) clearBtn.hidden = false;
        return;
      }
      if (urlEl) urlEl.value = r.url;
      if (status) {
        status.style.color = '#16a34a';
        const sizeTxt = (typeof r.size_bytes === 'number') ? r.size_bytes.toLocaleString() : String(file.size);
        status.textContent = '✓ ' + file.name + ' (' + sizeTxt + ' bytes) — URL in veld hieronder.';
      }
      if (clearBtn) clearBtn.hidden = false;
      _waTplPreviewDebounced();
    } catch (e) {
      if (status) { status.style.color = '#dc2626'; status.textContent = 'Upload exception: ' + (e && e.message || e); }
      if (clearBtn) clearBtn.hidden = false;
    }
  }

  // (modal lives in body) — not on the host.
  let _waMetaModalWired = false;
  function wireWaMetaModalOnce() {
    if (_waMetaModalWired) return;
    _waMetaModalWired = true;
    const htEl = document.getElementById('waMetaHeaderType');
    if (htEl) htEl.addEventListener('change', () => {
      _updateWaMetaHeaderVisibility();
      _waMetaSyncFileAccept();
      // Bij wisselen van header-kind: file-keuze terug naar leeg (anders
      // mismatch tussen sample-bestand en het nieuwe kind).
      _waMetaClearHeaderFile();
      _waTplPreviewDebounced();
    });
    const htTxtEl = document.getElementById('waMetaHeaderText');
    if (htTxtEl) {
      htTxtEl.addEventListener('input', () => _waTplPreviewDebounced());
      htTxtEl.addEventListener('focus', () => _waMetaTrackFocus('waMetaHeaderText'));
    }
    const bodyEl = document.getElementById('waMetaBodyText');
    if (bodyEl) {
      bodyEl.addEventListener('input', () => _waTplVarsAndPreviewDebounced());
      bodyEl.addEventListener('focus', () => _waMetaTrackFocus('waMetaBodyText'));
    }
    const footerEl = document.getElementById('waMetaFooterInput');
    if (footerEl) {
      footerEl.addEventListener('input', () => _waTplPreviewDebounced());
      footerEl.addEventListener('focus', () => _waMetaTrackFocus('waMetaFooterInput'));
    }
    const btnAdd = document.getElementById('waMetaBtnAddBtn');
    if (btnAdd) btnAdd.addEventListener('click', () => addWaMetaButton());

    // Fase B: header URL-input handmatig + file-upload wiring.
    const urlEl = document.getElementById('waMetaHeaderUrl');
    if (urlEl) urlEl.addEventListener('input', () => _waTplPreviewDebounced());
    const fileEl = document.getElementById('waMetaHeaderFileInput');
    if (fileEl) fileEl.addEventListener('change', () => _waMetaHandleHeaderFilePick());
    const fileClearEl = document.getElementById('waMetaHeaderFileClearBtn');
    if (fileClearEl) fileClearEl.addEventListener('click', () => _waMetaClearHeaderFile());

    // Fase B: opmaak-toolbar (B / I / S / </>) — wrap-selectie in WhatsApp-markdown.
    const toolbar = document.getElementById('waMetaFormatToolbar');
    if (toolbar) {
      toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-wa-fmt]');
        if (!btn) return;
        e.preventDefault();
        _waMetaApplyFormat(btn.getAttribute('data-wa-fmt'));
      });
    }

    // Variabelen-paneel chip-click delegation.
    const varsPanel = document.getElementById('waMetaVarsPanel');
    if (varsPanel) {
      varsPanel.addEventListener('click', (e) => {
        const chip = e.target.closest('.wa-var-chip');
        if (!chip) return;
        const key = chip.getAttribute('data-wa-var-key');
        if (!key) return;
        insertVariableAtCursor(key);
      });
    }

    // Save-knop: default → saveWaMetaTemplate (kan door applyWaMetaReadOnly
    // ge-overridden worden naar closeWaMetaEdit in read-only).
    const saveBtn = document.getElementById('waMetaSaveBtn');
    if (saveBtn) saveBtn.onclick = saveWaMetaTemplate;
  }

  let _waQrModalWired = false;
  function wireWaQrModalOnce() {
    if (_waQrModalWired) return;
    _waQrModalWired = true;
    const saveBtn = document.getElementById('waQrSaveBtn');
    if (saveBtn) saveBtn.onclick = saveWaQuickReply;
  }

  // ── Expose public API ──────────────────────────────────────────────────────
  window.FinanceInstellingen = {
    __loaded: true,
    mount,
    // Helpers exposed voor potentiele extern gebruik (Inbox-knop -> Joost
    // config direct openen, etc.). Niet nodig in deze PR maar future-proof.
    setActiveSub,
  };
})();
