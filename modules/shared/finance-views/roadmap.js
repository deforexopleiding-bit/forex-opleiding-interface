/* modules/shared/finance-views/roadmap.js
 *
 * Finance Roadmap-view — pure statische HTML met phase-cards (Voltooid /
 * Volgende mogelijke uitbreidingen / Toekomstige modules / Bekende
 * beperkingen). Eerste view die uit modules/finance.html geëxtraheerd
 * wordt als aanzet voor finance-views modularisatie.
 *
 * Public API: window.FinanceViewRoadmap.mount({
 *   host:  HTMLElement,  // verplichte mount-container (#view-roadmap-host)
 * })
 *
 * Mount is idempotent: tweede aanroep op zelfde host doet niets (early
 * return). Pattern komt overeen met finance-klanten.js / finance-tasks.js /
 * finance-dashboard.js.
 *
 * Geen RBAC-check hier — de roadmap-tab is leesbaar voor iedere finance-
 * gebruiker en bevat enkel statische copy. Wrapper finance.html toggelt
 * view-zichtbaarheid op nav-niveau.
 *
 * Geen extra CSS: hergebruikt `phase-card` / `phase-num` / `phase-title` /
 * `phase-desc` / `phase-tag` / `phases-grid` klassen die elders in
 * finance.html zijn gedefinieerd. Wanneer roadmap.js eerder zou laden dan
 * de globale styles is dat geen probleem — DOM blijft renderbaar zonder
 * styling.
 */
(function () {
  if (window.FinanceViewRoadmap && window.FinanceViewRoadmap.__loaded) return;

  let _mountedHost = null;

  function renderHTML() {
    return `
    <!-- Sectie 1: Voltooid -->
    <div style="margin-top:24px;margin-bottom:8px">
      <h2 style="font-size:16px;font-weight:700;margin:0 0 4px;color:var(--text)">Voltooid</h2>
      <div style="font-size:12.5px;color:var(--text-dim)">Live in productie en in dagelijks gebruik.</div>
    </div>
    <div class="phases-grid" style="margin-top:12px">
      <div class="phase-card done">
        <div class="phase-num">1</div>
        <div class="phase-title">Fundament</div>
        <div class="phase-desc">DB-schema klanten, facturen en payments. RLS-policies, indexes en RBAC-keys gedeeld met Sales-module.</div>
        <span class="phase-tag">AFGEROND</span>
      </div>
      <div class="phase-card done">
        <div class="phase-num">2</div>
        <div class="phase-title">Facturen + creditnota + betaalregistratie</div>
        <div class="phase-desc">Sync vanuit Teamleader, deep-link naar TL-detail, manuele betaalregistratie en partial payments.</div>
        <span class="phase-tag">AFGEROND</span>
      </div>
      <div class="phase-card done">
        <div class="phase-num">3</div>
        <div class="phase-title">CAMT.053 bank-import + payment-matching</div>
        <div class="phase-desc">XML-upload van ING-statements, matching-engine (handmatig + autopilot + handmatige koppeling) inclusief partial-payment matches.</div>
        <span class="phase-tag">AFGEROND</span>
      </div>
      <div class="phase-card done">
        <div class="phase-num">4</div>
        <div class="phase-title">Klant-CRUD bidirectional TL-sync</div>
        <div class="phase-desc">Klantgegevens lokaal aanmaken en bewerken, automatische tweezijdige sync met Teamleader.</div>
        <span class="phase-tag">AFGEROND</span>
      </div>
      <div class="phase-card done">
        <div class="phase-num">A</div>
        <div class="phase-title">Module A - WhatsApp Inbox (Meta Cloud API)</div>
        <div class="phase-desc">Directe Meta Cloud API koppeling, webhook-handler, conversation-list, thread-view, reply en 24h customer-service-window.</div>
        <span class="phase-tag">AFGEROND</span>
      </div>
      <div class="phase-card done">
        <div class="phase-num">B</div>
        <div class="phase-title">Module B - Wanbetalers-workflow</div>
        <div class="phase-desc">Templates, workflows met step-builder, engine-cron op 09:00, dashboard met probleemklanten en run-control.</div>
        <span class="phase-tag">AFGEROND</span>
      </div>
    </div>

    <!-- Sectie 2: Volgende mogelijke uitbreidingen -->
    <div style="margin-top:32px;margin-bottom:8px">
      <h2 style="font-size:16px;font-weight:700;margin:0 0 4px;color:var(--text)">Volgende mogelijke uitbreidingen</h2>
      <div style="font-size:12.5px;color:var(--text-dim)">Kandidaten voor de volgende sprints, prioriteit nog te bepalen.</div>
    </div>
    <div class="phases-grid" style="margin-top:12px">
      <div class="phase-card" style="border-color:rgba(245,158,11,0.35);background:rgba(245,158,11,0.04)">
        <div class="phase-num" style="background:rgba(245,158,11,0.15);color:#f59e0b">+</div>
        <div class="phase-title">Bulk-acties op facturen</div>
        <div class="phase-desc">Meerdere facturen tegelijk selecteren en versturen, crediteren of als betaald markeren.</div>
        <span class="phase-tag" style="background:rgba(245,158,11,0.15);color:#f59e0b">PRIORITEIT TBD</span>
      </div>
      <div class="phase-card" style="border-color:rgba(245,158,11,0.35);background:rgba(245,158,11,0.04)">
        <div class="phase-num" style="background:rgba(245,158,11,0.15);color:#f59e0b">+</div>
        <div class="phase-title">Excel-export voor facturen + rapportage</div>
        <div class="phase-desc">Download van filterresultaten en rapportages naar .xlsx voor verdere analyse en boekhouding.</div>
        <span class="phase-tag" style="background:rgba(245,158,11,0.15);color:#f59e0b">PRIORITEIT TBD</span>
      </div>
      <div class="phase-card" style="border-color:rgba(245,158,11,0.35);background:rgba(245,158,11,0.04)">
        <div class="phase-num" style="background:rgba(245,158,11,0.15);color:#f59e0b">+</div>
        <div class="phase-title">Cashflow forecast</div>
        <div class="phase-desc">Voorspelling op basis van invoice-history en lopende abonnementen, met scenario- en what-if-knoppen.</div>
        <span class="phase-tag" style="background:rgba(245,158,11,0.15);color:#f59e0b">PRIORITEIT TBD</span>
      </div>
      <div class="phase-card" style="border-color:rgba(245,158,11,0.35);background:rgba(245,158,11,0.04)">
        <div class="phase-num" style="background:rgba(245,158,11,0.15);color:#f59e0b">+</div>
        <div class="phase-title">Finance dashboard / management rapportage</div>
        <div class="phase-desc">KPI-banner, omzet per periode, MRR en openstaand-debiteurensaldo in een overzichtelijke management-view.</div>
        <span class="phase-tag" style="background:rgba(245,158,11,0.15);color:#f59e0b">PRIORITEIT TBD</span>
      </div>
      <div class="phase-card" style="border-color:rgba(245,158,11,0.35);background:rgba(245,158,11,0.04)">
        <div class="phase-num" style="background:rgba(245,158,11,0.15);color:#f59e0b">+</div>
        <div class="phase-title">Wanbetaler-uitbreidingen</div>
        <div class="phase-desc">Conditional branching in workflows (bv. respons-afhankelijk pad) en A/B testing van templates op response-rates.</div>
        <span class="phase-tag" style="background:rgba(245,158,11,0.15);color:#f59e0b">PRIORITEIT TBD</span>
      </div>
    </div>

    <!-- Sectie 3: Toekomstige modules -->
    <div style="margin-top:32px;margin-bottom:8px">
      <h2 style="font-size:16px;font-weight:700;margin:0 0 4px;color:var(--text)">Toekomstige modules</h2>
      <div style="font-size:12.5px;color:var(--text-dim)">Nog niet ingepland - eerst onderzoek of business-case nodig.</div>
    </div>
    <div class="phases-grid" style="margin-top:12px">
      <div class="phase-card" style="border-color:rgba(148,163,184,0.35);background:rgba(148,163,184,0.04)">
        <div class="phase-num" style="background:rgba(148,163,184,0.15);color:#94a3b8">?</div>
        <div class="phase-title">Abonnementen-module</div>
        <div class="phase-desc">Beheer van Teamleader-subscriptions met tracking van recurring invoices en MRR-overzicht.</div>
        <span class="phase-tag" style="background:rgba(148,163,184,0.15);color:#94a3b8">TE PLANNEN</span>
      </div>
      <div class="phase-card" style="border-color:rgba(148,163,184,0.35);background:rgba(148,163,184,0.04)">
        <div class="phase-num" style="background:rgba(148,163,184,0.15);color:#94a3b8">?</div>
        <div class="phase-title">Bonus-configs + executive dashboard</div>
        <div class="phase-desc">Sales-bonus-configs beheren, all-bonus-view en KPI-banner voor management-rapportage.</div>
        <span class="phase-tag" style="background:rgba(148,163,184,0.15);color:#94a3b8">TE PLANNEN</span>
      </div>
      <div class="phase-card" style="border-color:rgba(148,163,184,0.35);background:rgba(148,163,184,0.04)">
        <div class="phase-num" style="background:rgba(148,163,184,0.15);color:#94a3b8">?</div>
        <div class="phase-title">PostNL brieven-integratie</div>
        <div class="phase-desc">Formele brieven voor late-stadium incasso via PostNL-API met letter-templates en bezorgbevestiging.</div>
        <span class="phase-tag" style="background:rgba(148,163,184,0.15);color:#94a3b8">TE PLANNEN</span>
      </div>
      <div class="phase-card" style="border-color:rgba(148,163,184,0.35);background:rgba(148,163,184,0.04)">
        <div class="phase-num" style="background:rgba(148,163,184,0.15);color:#94a3b8">?</div>
        <div class="phase-title">PSD2 AISP-traject</div>
        <div class="phase-desc">Automatische bank-feed via een AISP-licentiehouder, als vervanger van handmatige CAMT-uploads.</div>
        <span class="phase-tag" style="background:rgba(148,163,184,0.15);color:#94a3b8">TE PLANNEN</span>
      </div>
    </div>

    <!-- Sectie 4: Bekende beperkingen / cleanup-items -->
    <div style="margin-top:32px;margin-bottom:8px">
      <h2 style="font-size:16px;font-weight:700;margin:0 0 4px;color:var(--text)">Bekende beperkingen + cleanup-items</h2>
      <div style="font-size:12.5px;color:var(--text-dim)">Tijdelijke situaties en opruimwerk dat nog gepland moet worden.</div>
    </div>
    <div class="phases-grid" style="margin-top:12px">
      <div class="phase-card" style="border-color:rgba(6,182,212,0.35);background:rgba(6,182,212,0.04)">
        <div class="phase-num" style="background:rgba(6,182,212,0.15);color:#06b6d4">i</div>
        <div class="phase-title">"Bank (oud)" + e-Boekhouden cron blijven draaien</div>
        <div class="phase-desc">Worden pas uitgezet als CAMT-flow 100% comfortabel draait. Tot die tijd dubbele instroom als veiligheidsnet.</div>
        <span class="phase-tag" style="background:rgba(6,182,212,0.15);color:#06b6d4">INFO</span>
      </div>
      <div class="phase-card" style="border-color:rgba(6,182,212,0.35);background:rgba(6,182,212,0.04)">
        <div class="phase-num" style="background:rgba(6,182,212,0.15);color:#06b6d4">i</div>
        <div class="phase-title">WhatsApp Inbox app unpublished</div>
        <div class="phase-desc">Alleen test-recipients (max 5 destinations) tot Meta-review is afgerond. Daarna pas brede uitrol mogelijk.</div>
        <span class="phase-tag" style="background:rgba(6,182,212,0.15);color:#06b6d4">INFO</span>
      </div>
      <div class="phase-card" style="border-color:rgba(6,182,212,0.35);background:rgba(6,182,212,0.04)">
        <div class="phase-num" style="background:rgba(6,182,212,0.15);color:#06b6d4">i</div>
        <div class="phase-title">Oude paper-only tabellen kunnen opgeruimd</div>
        <div class="phase-desc">dunning_phases + dunning_trajectories zijn vervangen door de nieuwe workflow-engine en mogen weg na schema-audit.</div>
        <span class="phase-tag" style="background:rgba(6,182,212,0.15);color:#06b6d4">INFO</span>
      </div>
    </div>
    `;
  }

  function mount(opts) {
    const o = opts || {};
    if (!o.host) {
      console.warn('[FinanceViewRoadmap] mount() requires {host}');
      return;
    }
    // Idempotent: zelfde host = niets doen.
    if (_mountedHost === o.host) return;
    _mountedHost = o.host;
    o.host.innerHTML = renderHTML();
  }

  window.FinanceViewRoadmap = {
    __loaded: true,
    mount,
  };
})();
