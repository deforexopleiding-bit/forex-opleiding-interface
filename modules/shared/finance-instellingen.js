/* modules/shared/finance-instellingen.js
 *
 * Finance Instellingen — beheer-paneel binnen Finance met 3 sub-secties:
 *   1. Joost AI (config / autonomy / decision log) — FULL extract uit
 *      modules/admin.html (Groep D)
 *   2. WhatsApp Templates — DEEP-LINK naar admin.html#whatsapp-templates
 *      (PARTIAL — volledige verhuis volgt in vervolg-PR)
 *   3. WhatsApp Connection / Afdeling-config — DEEP-LINK naar
 *      admin.html#whatsapp-connection (PARTIAL — volledige verhuis volgt
 *      in vervolg-PR)
 *
 * Public API: window.FinanceInstellingen.mount({
 *   host: HTMLElement,
 * })
 *
 * Mount is idempotent: tweede aanroep op dezelfde host doet niets dankzij
 * mount-guard. Sub-tab state via ?sub=joost|templates|connection URL-param.
 *
 * RBAC: respecteert admin.joost_config (Joost) / admin.whatsapp_templates
 * (Templates) / admin.arrangement_settings (Afdeling) — server-side
 * fail-fast op de onderliggende endpoints. UI rendert altijd (geen client
 * gate); 403's tonen we als load-error.
 *
 * Endpoints (server blijft op admin-* namespace in deze PR — geen rename):
 *   - GET /api/joost-config-get?module=finance
 *   - POST /api/joost-config-upsert
 *   - GET /api/joost-autonomy-decisions-list?limit=50
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

  const JOOST_INTENTS = [
    { key: 'payment_promise',     label: 'payment_promise',     hasMaxMsg: true  },
    { key: 'arrangement_request', label: 'arrangement_request', hasMaxMsg: true  },
    { key: 'dispute',             label: 'dispute',             hasMaxMsg: false },
    { key: 'question',            label: 'question',            hasMaxMsg: true  },
    { key: 'unsubscribe',         label: 'unsubscribe',         hasMaxMsg: false },
    { key: 'other',               label: 'other',               hasMaxMsg: true  },
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

      <!-- ─── Sub-tab: WhatsApp Templates (deep-link tijdelijk) ─── -->
      <div id="fiSubTemplates" hidden>
        <div class="fi-deeplink-card">
          <strong>WhatsApp Templates beheer</strong>
          <div style="margin-top:8px;color:var(--text-dim)">
            Beheer Meta-goedgekeurde message templates &eacute;n interne &laquo;snelle antwoorden&raquo;
            (free-form binnen 24u-window). Selecteer eerst de WhatsApp Business Account.
          </div>
          <div style="margin-top:10px;color:var(--text-faint);font-size:12px">
            <em>Tijdelijk via Admin &mdash; volledige verhuis naar Finance &gt; Instellingen
            volgt in een vervolg-PR (template-editor met variabelen-paneel is een complex
            sub-systeem van ~1400 regels code).</em>
          </div>
          <a class="btn btn-primary" href="/modules/admin.html#whatsapp-templates" target="_blank" rel="noopener">
            <i class="ti ti-external-link"></i> Open WhatsApp Templates (Admin)
          </a>
        </div>
      </div>

      <!-- ─── Sub-tab: WhatsApp Connection / Afdeling-config (deep-link tijdelijk) ─── -->
      <div id="fiSubConnection" hidden>
        <div class="fi-deeplink-card">
          <strong>Afdeling-configuratie &mdash; WhatsApp module-koppelingen</strong>
          <div style="margin-top:8px;color:var(--text-dim)">
            Koppel modules (Inbox, Finance, Sales, &hellip;) aan een specifiek WhatsApp Cloud
            API telefoonnummer. Per module bepaal je hier ook de contact-informatie van de
            afdeling: bel-nummer, WhatsApp-nummer, e-mail en ondertekenaar
            (gebruikt in templates via <code>{afdeling.*}</code> placeholders).
          </div>
          <div style="margin-top:10px;color:var(--text-faint);font-size:12px">
            <em>Tijdelijk via Admin &mdash; volledige verhuis naar Finance &gt; Instellingen
            volgt in een vervolg-PR.</em>
          </div>
          <a class="btn btn-primary" href="/modules/admin.html#whatsapp-connection" target="_blank" rel="noopener">
            <i class="ti ti-external-link"></i> Open WhatsApp Connection (Admin)
          </a>
        </div>
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
                      <input type="number" id="commMaxTotal" class="form-input" min="0" step="1" value="20" />
                    </div>
                    <div>
                      <label class="form-label" for="commMinSecondsBetween">min_seconds_between</label>
                      <input type="number" id="commMinSecondsBetween" class="form-input" min="0" step="1" value="30" />
                    </div>
                  </div>
                  <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:12px;align-items:end;margin-top:10px">
                    <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;padding-bottom:6px">
                      <input type="checkbox" id="commOfficeHoursOnly" />
                      <span style="font-size:13px;font-weight:600">office_hours_only</span>
                    </label>
                    <div>
                      <label class="form-label" for="commOfficeStart">office_start</label>
                      <input type="time" id="commOfficeStart" class="form-input" value="09:00" />
                    </div>
                    <div>
                      <label class="form-label" for="commOfficeEnd">office_end</label>
                      <input type="time" id="commOfficeEnd" class="form-input" value="17:00" />
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
                  <div style="margin-top:10px">
                    <div style="font-size:12px;font-weight:600;margin-bottom:6px">no_reply_days_per_step</div>
                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
                      <div>
                        <label class="form-label" for="outboundNoReplyStep1">stap 1</label>
                        <input type="number" id="outboundNoReplyStep1" class="form-input" min="0" step="1" value="3" />
                      </div>
                      <div>
                        <label class="form-label" for="outboundNoReplyStep2">stap 2</label>
                        <input type="number" id="outboundNoReplyStep2" class="form-input" min="0" step="1" value="7" />
                      </div>
                      <div>
                        <label class="form-label" for="outboundNoReplyStep3">stap 3</label>
                        <input type="number" id="outboundNoReplyStep3" class="form-input" min="0" step="1" value="14" />
                      </div>
                    </div>
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
      setVal('mandateMaxTermijnen',     mandate.max_termijnen,        6);
      setVal('mandateMinTermijnBedrag', mandate.min_termijn_bedrag,   25);
      setVal('mandateMaxUitstelDagen',  mandate.max_uitstel_dagen,    30);
      setVal('mandateMinToNegotiate',   mandate.min_to_negotiate,     50);
      setVal('mandateMaxAutoPropose',   mandate.max_auto_propose,     5);

      const comm = ac.communication_limits || {};
      setVal('commMaxPerDay',         comm.max_per_day,        3);
      setVal('commMaxTotal',          comm.max_total,          20);
      setVal('commMinSecondsBetween', comm.min_seconds_between,30);
      setChk('commOfficeHoursOnly',   !!comm.office_hours_only);
      setVal('commOfficeStart',       comm.office_start,       '09:00');
      setVal('commOfficeEnd',         comm.office_end,         '17:00');

      const pers = ac.personality || {};
      setVal('personalityMaxSentences', pers.max_sentences, 3);
      setChk('personalityUseEmojis', !!pers.use_emojis);

      const outb = ac.outbound || {};
      setVal('outboundMaxPerConvPerDay', outb.max_outbound_per_conv_per_day, 2);
      const steps = Array.isArray(outb.no_reply_days_per_step) ? outb.no_reply_days_per_step : [3, 7, 14];
      setVal('outboundNoReplyStep1', steps[0], 3);
      setVal('outboundNoReplyStep2', steps[1], 7);
      setVal('outboundNoReplyStep3', steps[2], 14);

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
    const arrangement_mandate = {
      allowed_types,
      max_termijnen:      numVal('mandateMaxTermijnen', 6),
      min_termijn_bedrag: numVal('mandateMinTermijnBedrag', 25),
      max_uitstel_dagen:  numVal('mandateMaxUitstelDagen', 30),
      min_to_negotiate:   numVal('mandateMinToNegotiate', 50),
      max_auto_propose:   numVal('mandateMaxAutoPropose', 5),
    };

    const communication_limits = {
      max_per_day:         numVal('commMaxPerDay', 3),
      max_total:           numVal('commMaxTotal', 20),
      min_seconds_between: numVal('commMinSecondsBetween', 30),
      office_hours_only:   getChk('commOfficeHoursOnly'),
      office_start:        (host.querySelector('#commOfficeStart')?.value || '09:00'),
      office_end:          (host.querySelector('#commOfficeEnd')?.value || '17:00'),
    };

    const personality = {
      max_sentences: numVal('personalityMaxSentences', 3),
      use_emojis:    getChk('personalityUseEmojis'),
    };

    const outbound = {
      max_outbound_per_conv_per_day: numVal('outboundMaxPerConvPerDay', 2),
      no_reply_days_per_step: [
        numVal('outboundNoReplyStep1', 3),
        numVal('outboundNoReplyStep2', 7),
        numVal('outboundNoReplyStep3', 14),
      ],
    };

    const autonomy_config = {
      intents,
      arrangement_mandate,
      communication_limits,
      personality,
      outbound,
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

  // ── Expose public API ──────────────────────────────────────────────────────
  window.FinanceInstellingen = {
    __loaded: true,
    mount,
    // Helpers exposed voor potentiele extern gebruik (Inbox-knop -> Joost
    // config direct openen, etc.). Niet nodig in deze PR maar future-proof.
    setActiveSub,
  };
})();
