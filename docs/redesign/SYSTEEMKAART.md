# SYSTEEMKAART — Fase 3 blauwdruk

Bron: read-only inventarisatie van `modules/*.html`, `api/*.js`, `modules/shared/sidebar.js` (MODULE_FEATURE_MAP), `modules/admin.html` (FEATURE_REGISTRY), migraties in `docs/sql-migrations/` en `migrations/`. Peildatum 2026-08-06, branch `main`.

Doel: één samenhangende kaart van wat er nu is — modules, verstopte instellingen, rollen — en op basis daarvan een voorstel voor een nieuwe zijbalk-indeling waarin we per module tegen kunnen bouwen. Elk deel hieronder is **beschrijving, geen beslissing** — deel D is een **voorstel** dat je kunt bijstellen.

---

## Deel A — Alle modules

Elke sub-lijst is een cluster. Legenda **Zichtbaarheid**:
- **sidebar** — link staat in `sidebar.js`
- **sub-view** — deep-link vanuit een grotere module (geen sidebar-entry)
- **rol-landing** — direct target na login voor een specifieke rol (`ROLE_LANDING` in `supabase-client.js`)
- **student-facing** — publieke pagina, token-link, geen login
- **archief/legacy** — nog bereikbaar, niet meer in gebruik

### A1. Dashboard-cluster (rol-landing)

| Bestand | Tabs / sub-views | Doel | Zichtbaarheid |
|---|---|---|---|
| `index.html` | Periode Vandaag/Week/Maand | Bento-dashboard voor admin/manager/marketing/administratie/viewer | sidebar (Dashboard) |
| `modules/super-admin-dashboard.html` | geen (charts + KPI-tiles) | Prototype super-admin-dashboard | rol-landing (super_admin) |
| `modules/mentor-home.html` | Periode Dag/Week/Maand/Aangepast | Mentor-landing: verdiensten + actieve studenten + komende events | rol-landing (mentor) |
| `modules/sales-dashboard.html` | geen (redirect) | Thin redirect → `sales.html?tab=dashboard` | rol-landing (sales) |
| `modules/dashboard-v1-archive.html` | Periode Vandaag/Week/Maand | Oud v1-dashboard | archief |

**Echte per-rol landing.** Vier verschillende schermen na login (super_admin / manager+viewer / sales / mentor).

### A2. Leads-cluster

| Bestand | Tabs / sub-views | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/leads.html` | Filter-strip Herkomst/Traject/Kwalificatie/Bron/Status | Inkomende leads uit website/vragenlijst/handmatig | sidebar (Leads) |
| `modules/leads-detail.html` | geen (2-koloms) | Detailkaart voor één lead met score + acties | sub-view |
| `modules/leadsonderhoud.html` | Overzicht / Wachtrij / Gesprekken / Trajecten / Berichten / Vragenlijst | Auto mail/WhatsApp-opvolging leads met warmtescore | sidebar (Leadsonderhoud) |

### A3. Follow-up-cluster

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/follow-up.html` | Werklijst / Event-bellijst / Opvolglijst / Retenties · via "Zie meer": Afspraken / Sluimerpot / Statistieken / Afgeboekt | Cockpit voor Dave's sales-afspraken, voicememo's, no-shows | sidebar (Follow-up) |
| `modules/follow-up-lead.html` | Calls / WhatsApp / Outcome / Notities | Lead-detail voor één afspraak | sub-view |
| `modules/follow-up-admin.html` | geen | Admin-queue voor screenshot-reviews (voice-memo attestations) | sub-view (admin) |

### A4. Communicatie-cluster

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/email.html` | Te beantwoorden / Leads / Klanten / Finance / Reclame / Overig / Alle mails / Verzonden | Gedeelde inbox (IMAP Strato, 4 mailboxen) | sidebar (E-mail) |
| `modules/lisa.html` | Live / Stats / Sandbox / Logs · agent-strip Instagram/WhatsApp/No-show | Appointment-setting AI-agents voor lead-kwalificatie | sidebar (Appointment setting) |
| `modules/agents.html` | Overview / Chat | Overzicht + chat-shell voor Simon/Leon/Aron | sidebar (AI Agents) |
| `modules/agent-center.html` | Agents / Kanalen | Config-hub voor joost_config-agents + WhatsApp-templates + verbindingen | sidebar (Agent center) |
| `modules/meetings.html` | Geschiedenis / Taken / Standups / Beslissingen | Vergaderruimte-tool met transcripts | sidebar (Vergaderruimte) |
| `modules/control-center.html` | geen (KPI + approval-inbox + audit-log) | Super_admin-controle over agent-approvals + audit | sidebar (Control Center) |

### A5. Kennisbank & taken

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/kennisbank.html` | geen (3-koloms buckets: Alle items / Bedrijfsprofiel / Simon / Lisa / …) | Gedeelde kennisbank per AI-agent (markdown-items) | sidebar (Kennisbank) |
| `modules/kennisbank-v1-archive.html` | ? | v1-versie | archief |
| `modules/taken.html` | Mijn taken / Toegewezen door mij | Kanban-takenbord | sidebar (Takenbeheer) |

### A6. Sales-cluster

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/sales.html` | Dashboard / Klanten / Offertes / Abonnementen / Retentie / Aanbod / Rapporten | Operationele klant-aanmaak + productcatalogus + Dave's offertepijplijn | sidebar (Sales) |
| `modules/sales-wizard.html` | 3-stappen (Bedrijf → Klant → Offerte) | Wizard nieuwe klant + offerte | sub-view |
| `modules/subscription-wizard.html` | 3-stappen (Klant → Abonnementen → Bonus) | Wizard nieuw abonnement | sub-view |
| `modules/offerte-detail.html` | geen | Detail van één offerte + TL-sync + acties | sub-view |
| `modules/klanten.html` | Profiel / Communicatie / Offertes / Abonnementen / Facturen / Wanbetalers / Audit | Klant-detailpagina (aangeroepen vanuit Sales > Klanten) | sub-view (sidebar-link verwijderd) |
| `modules/klanten-v2/index.html` | Lijst (detail volgt in PR-B) | Redesign-preview op nieuw design-system | preview (deep-link, niet in sidebar) |

### A7. Events-cluster

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/events.html` | Overzicht / Inbox / Inschrijvingen-inbox / Mentor-grootboek · Instellingen: Vragenlijst / Simone / Automations / Signup-deadline / Niveau-foto's | Workshops, live trainingen, mentor-sessies beheren | sidebar (Events) |
| `modules/events-detail.html` | Info / Aanwezigen / Mentoren / Audit | Detailpagina één event | sub-view |
| `modules/events-wizard.html` | 3-stappen (Basis → Niveau → Review) | Wizard nieuw event | sub-view |
| `modules/events-automations.html` | geen (ook `?embed=1`) | Automations-editor event-lifecycle | sub-view |
| `modules/admin-historical-events.html` | geen | Historisch event + kosten + deals invoeren | sub-view (super_admin) |
| `modules/event-keuze.html` | geen (kaart-picker) | Student kiest event-datum na intake | student-facing |
| `modules/assessment.html` | geen | Publieke intake-vragenlijst masterclass | student-facing |

### A8. Meta Ads-cluster

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/meta-ads.html` | Modus Meta-cijfers/Tot en met sale · range Vandaag/7d/30d/Maand | Meta Ads-dashboard met funnel + drill-down | sidebar (Meta Ads) |
| `modules/meta-ads-studio.html` | geen (3-koloms studio) | Browser-tool foto → ad-creative | sidebar (Creative Studio) |

### A9. Mentor-cluster (self-service, mentor-rol)

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/mentor-dashboard.html` | Dashboard / Verdiensten | Mentor-financiën (bonussen + uitbetalingen) | sidebar (Financiën, mentor-only) |
| `modules/mentor-students.html` | Mijn studenten / 1-op-1 sessies / No shows | Mentor-hub toegewezen studenten | sidebar (Studenten, mentor-only) |
| `modules/mentor-onboarding.html` | Studenten / Inbox · filter-chips per status | Mentor-instroom-pijplijn | sidebar (Onboarding, mentor-only) |
| LMS (externe URL) | – | Extern LMS-prototype | sidebar (LMS, mentor-only) |

### A10. Mentoren-admin-cluster (manager+)

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/mentoren-beheer.html` | Mentor-overzicht / Payout-rapporten / Certificaten / Beoordelingen / Handmatige trajecten | Hub (iframe-per-tab) voor alle mentor-admin | sidebar (Mentoren beheer) |
| `modules/mentor-detail.html` | geen (picker + KPI + wrap) | Admin-inspectie per mentor | sub-view |
| `modules/mentor-payouts-admin.html` | geen | Payout-rapporten genereren per mentor+maand | sub-view |
| `modules/funded-certificates-admin.html` | geen | Funded-certificaten (€100 mentor+student) | sub-view |
| `modules/student-assessments-admin.html` | geen | Read-only maandelijkse assessments | sub-view |
| `modules/mentor-cash-trajects-admin.html` | geen | Handmatige mentor-bonus-trajecten | sub-view |
| `modules/mentor-grootboek.html` | geen (redirect-card) | Redirect naar Events > Mentor-grootboek | archief |
| `modules/students-overview.html` | Studenten / Aandachtspunten / Archief | Org-brede studentenlijst | sidebar (Alle studenten, manager+) |

### A11. Onboarding-cluster

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/onboarding-hub.html` | Overzicht / Wizard / Automations | Admin-hub onboarding-traject (Fase 1-3 merge) | sidebar (Onboarding) |
| `modules/onboarding-admin.html` | Actief / Archief / Inbox | Oude standalone lijst | sub-view (dormant) |
| `modules/onboarding-wizard-editor.html` | Flow 1-op-1 / Membership | Editor publieke vragenlijst | sub-view (dormant) |
| `modules/onboarding-automations.html` | geen | Lifecycle-automations-editor | sub-view (dormant) |
| `modules/onboarding.html` | geen (multi-stap client-flow) | Publieke wizard voor student na aankoop | student-facing |

### A12. Finance-cluster

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/finance.html` | Dashboard / Facturen / Creditnota's / Klanten / Wanbetalers / Bank / Uitgaven / Roadmap · Wanbetalers-sub: Gesprekken / Acties / Overzicht / Instellingen (+ legacy sub-tabs) | Mega-module: facturen, klanten, wanbetalers, bank, uitgaven | sidebar (Finance) |
| `modules/open-acties.html` | geen (2s-redirect) | Redirect → Finance > Wanbetalers > Open Acties | archief (redirector) |
| `modules/wanbetalers.html` | geen | Oude standalone wanbetalers-lijst | archief |
| `modules/wanbetalers-diagnose.html` | Iedereen / Actieve-gepauzeerde flow / Probleemgevallen | Super_admin-diagnose + AI-batch-analyse | sub-view (super_admin) |
| `modules/wanbetalers-test.html` | geen (DRY-RUN sandbox) | Super_admin-sandbox wanbetalers-flow-tests | sub-view (super_admin) |

### A13. Admin / Tickets / Logging

| Bestand | Tabs | Doel | Zichtbaarheid |
|---|---|---|---|
| `modules/admin.html` | Gebruikers / Rechten / Integraties / Approval-queue / Menu beheer | Users + RBAC + approval-queue + menu-config | sidebar (Admin, manager+) |
| `modules/admin-tl-import.html` | geen | TL-import abonnementen + deals | sub-view (super_admin) |
| `modules/tickets.html` | Open / In behandeling / Opgelost / Gesloten · type-chips Bug/Feature/Vraag | Interne bug/feature/vraag-tracker per module | sidebar (Tickets) |
| `modules/tickets-detail.html` | geen | Ticket-detail | sub-view |
| `modules/activity-log.html` | Activiteit / Per gebruiker | Audit-logboek "wie deed wat" (90-daagse retentie) | sidebar (Logboek) |
| `modules/secret-area.html` | Home / Dashboard / 1-6 tabs · Chart/Backtest/Analyse/Trainer/Detectie/Trades | Jeffrey's persoonlijke strategie-trainer (server-PIN-gated) | sidebar (verborgen tot server allowed:true) |

### A14. Actief-gebruik-status (indicatief)

| Cluster | Signaal |
|---|---|
| Sales / Klanten / Finance / Events / Onboarding-hub / Follow-up / Leads / Tickets / Admin / Email / Lisa | **actief** — recente commits, live cron-jobs of live sync-flows |
| Mentor-cluster (self-service + admin-hub) | **actief** — recente feature-migrations (mig 016, 2026-07-31) |
| Kennisbank | **actief** — bots halen items op |
| Agents (Simon/Leon/Aron) + Vergaderruimte + Control Center | **beperkt** — feature bestaat, dagelijks gebruik onduidelijk; user gaf aan dat deze naar "Binnenkort" mogen |
| Meta Ads / Creative Studio | actief maar niche (Jeffrey persoonlijk) |
| Meetings / Secret Area | Jeffrey-only |
| dashboard-v1-archive / kennisbank-v1-archive / open-acties / wanbetalers / wanbetalers-\* / mentor-grootboek / sales-dashboard / onboarding-\*.html (los) | **archief** — mag weg zodra alle deep-links opgeruimd zijn |

---

## Deel B — Verstopte instellingen (Settings-consolidatie)

Alles wat "instellen" is in plaats van "werken", uit alle modules bij elkaar. Categorieën aan het eind komen 1-op-1 terug in de nieuwe **Instellingen**-module.

### B1. Gebruikers & rollen
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/admin.html` — tab **Gebruikers** | Uitnodigen, rol wisselen, activeren/deactiveren (super_admin, manager, sales, mentor via `user_roles`). Backend: `api/admin-users.js`, `admin-generate-link.js`, `admin-seed-users.js`. | Instellingen > Gebruikers & rollen > Accounts |
| `modules/admin.html` — tab **Rechten** (FEATURE_REGISTRY r.955-1271, ~170 keys × 4 rollen) | Rechten-matrix RBAC. Backend: `role_permissions`-tabel + `admin-rbac-backfill-roles.js`. | Instellingen > Gebruikers & rollen > Rechten-matrix |
| `modules/admin.html` — tab **Menu beheer** | Volgorde/zichtbaarheid sidebar-items. `admin.sidebar` key + `api/sidebar-layout-save.js`. | Instellingen > Gebruikers & rollen > Menu-indeling |

### B2. Integraties
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/admin.html` — tab **Integraties** | Verbindingen TL/GHL/Meta/Zoom/Discord/Trustpilot (deels nog placeholder). Backend: `api/teamleader-oauth-*.js`, `api/lisa-ghl-*.js`, `zoom-webhook.js`. | Instellingen > Integraties |
| `modules/agent-center.html` — view **Kanalen** | WhatsApp Templates + verbindingen (Meta Cloud API). | Instellingen > Integraties > WhatsApp (Meta) |
| `modules/admin-tl-import.html` | Bulk-import TL-abonnementen/deals (eenmalig / super_admin). | Instellingen > Integraties > TeamLeader (sub: Import) |
| `api/test-smtp.js` + env-vars `SMTP_*`, `IMAP_*` | SMTP + IMAP (4 mailboxen: leads/info/partners/administratie). | Instellingen > Integraties > Mailboxen / SMTP |

### B3. Sales
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/sales.html` — tab **Aanbod** | Productcatalogus (`sales_products`, TL-Product-ID, BTW, looptijd). | Instellingen > Sales > Productcatalogus |
| Feature `sales.reservation_fee.bypass` (admin.html PERMISSION_CATALOG) | Per rol: bypass-recht op reservering-verplichting. Nu alleen via RBAC-matrix. | Instellingen > Sales > Reservering-regels |
| Feature `finance.bonus.config_manage` (via Sales-context) | Bonus-configs voor sales (opslag: nog te bouwen). | Instellingen > Sales > Bonus-regels |

### B4. Finance & Wanbetalers
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/finance.html` — Wanbetalers > **Instellingen** > Templates | Bewerkbare aanmaan-templates (`dunning_templates` — WhatsApp/brief/email). | Instellingen > Wanbetalers > Aanmaan-templates |
| `modules/finance.html` — Wanbetalers > **Instellingen** > Workflows | Stapworkflow-regels (`dunning_engine`-driehoek). | Instellingen > Wanbetalers > Workflow-regels |
| `modules/finance.html` — Wanbetalers > **Instellingen** > Geschiedenis | Audit-log van engine-runs. | Instellingen > Wanbetalers > Engine-log (read-only) |
| `app_settings.dunning_cooldown_days` (default 7) | Minimale wachttijd tussen aanmaan-runs per klant. | Instellingen > Wanbetalers > Engine-parameters |
| `app_settings.dunning_pipeline_auto` (4 booleans) | Auto-fase-triggers (on_overdue / on_bulk_sent / on_inbound / on_paid). | Instellingen > Wanbetalers > Pipeline-triggers |
| Kantooruren-venster wanbetalers (08-20 EU/Amsterdam, code-gate) | Wanneer engine sms/bellen mag. | Instellingen > Wanbetalers > Verzendvenster |
| `modules/finance.html` — Uitgaven tab-sub | Uitgaven-categorieën (`finance.bank.category_manage`). | Instellingen > Finance > Uitgaven-categorieën |
| `modules/finance.html` — Bank tab | Bank-auto-match toggle (`finance.bank.match_auto_toggle`). | Instellingen > Finance > Bank auto-match |
| Features `finance.reports.distribution_manage / forecast.scenarios_manage / settings.alerts` | Rapportage-distributielijst + forecast-scenarios + alert-drempels (nog te bouwen). | Instellingen > Finance > Rapportage / Forecast / Alerts |
| ENV-vars `COMPANY_NAME/ADDRESS/KVK/BTW/PHONE/EMAIL` (C4 template-vars) | Bedrijfsgegevens voor templates + facturen. | Instellingen > Algemeen > Bedrijfsgegevens |

### B5. Events
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/events.html` — Instellingen > **Vragenlijst** | Publieke intake-vragen assessment. | Instellingen > Events > Vragenlijst |
| `modules/events.html` — Instellingen > **Simone testen** | Sandbox voor Simone AI (events-reactieve-suggesties). | Instellingen > Events > Simone (test + config) |
| `modules/events-automations.html` (+ Instellingen > Automations) | Automation-triggers + email/WA-teksten voor event-lifecycle (T-24u, T-1u, na-event, feedback). | Instellingen > Events > Automations |
| `modules/events.html` — Instellingen > **Signup-deadline** | Global deadline-defaults per event-type. | Instellingen > Events > Deadlines |
| `modules/events.html` — Instellingen > **Niveau-foto's** | Beeld-assets voor de niveau-selectie in de wizard. | Instellingen > Events > Assets |
| `modules/events.html` — tab **Mentor-grootboek** (mentor-bonus-regels via `event_bonuses`) | Bonus-berekening (functie + coach + travel-days). | Instellingen > Events > Bonus-regels |
| `feature_flags.events_reactive_autonomy` | Master-toggle Simone-autonomie. | Instellingen > AI-agents > Simone > Autonomie |

### B6. Onboarding
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/onboarding-hub.html` — sectie **Wizard** (was `onboarding-wizard-editor.html`) | Publieke onboarding-vragenlijst editor (concept vs live). | Instellingen > Onboarding > Wizard-vragen |
| `modules/onboarding-hub.html` — sectie **Automations** (was `onboarding-automations.html`) | Lifecycle-automations (welkom-mail, herinner-mails, koppel-mentor). | Instellingen > Onboarding > Automations |
| `feature_flags.mila_use` + Mila-config | Mila AI voor onboarding-inbox (auto-suggest antwoorden). | Instellingen > AI-agents > Mila |
| Signup-flow-defaults (1-op-1 vs Membership) | Welke flow bij welk product. | Instellingen > Onboarding > Flow-toewijzing |

### B7. AI-agents (Joost / Simone / Mila / Lisa / Simon / Leon / Aron)
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/agent-center.html` — view **Agents** (per-module `joost_config`) | Persona, prompt, KB-toegang, model-keuze, autonomie-flags per agent. Tabel: `joost_config`. | Instellingen > AI-agents > Joost / Simone / Mila > Config |
| `joost_config.feature_flags` (E2.0-2.4) | 5 feature-flags voor autonomie-uitbouw (shadow/reactive/outbound/negotiate/context). | Instellingen > AI-agents > Joost > Autonomie |
| `joost_config.autonomy_config.mandate` (5 arrangement-types × enabled + caps) | Wat Joost autonoom mag voorstellen (max dagen uitstel, max termijnen, etc.). | Instellingen > AI-agents > Joost > Mandaat |
| `joost_config.autonomy_config.communication_limits` | Max berichten/dag, cooldown, office-hours. | Instellingen > AI-agents > Joost > Communicatie-limits |
| `feature_flags.e2_autonomous_intake` | Joost mag klant zelfstandig om e-mail vragen bij onbekende inbound. | Instellingen > AI-agents > Joost > Intake |
| `modules/lisa.html` — tab **Config** (sub-tabs Algemeen/Persona/Do's/Fases/Knowledge/Follow-up) | Compleet Lisa-config-scherm (response-delay, persona, sequence, kb-tag-filter). Tabel: `lisa_config` + `lisa_settings`. | Instellingen > AI-agents > Lisa |
| `lisa_settings.live_mode_enabled` + `office_hours_start/end` | Runtime-toggle Lisa OFFLINE ↔ LIVE + kantooruren. | Instellingen > AI-agents > Lisa > Runtime |
| `modules/agents.html` — Simon/Leon/Aron personality (uit `agents`-tabel) | System-prompt per agent. Nu alleen via SQL. | Instellingen > AI-agents > Simon / Leon / Aron |
| `modules/kennisbank.html` — knop **Tags beheren** (`kennisbank.tag.manage`) | Tag-catalogus KB-items. | Instellingen > AI-agents > Kennisbank-tags |
| `modules/kennisbank.html` — bucket **Bedrijfsprofiel** (`is_profile=true`) | Items die altijd in system-prompt voor alle agents. | Instellingen > AI-agents > Gedeeld bedrijfsprofiel |
| `modules/agent-center.html` — view **Kanalen** > WhatsApp Templates | Meta-templates + `meta_param_mapping` (named vars). | Instellingen > Communicatie > WhatsApp-templates |

### B8. Leads & follow-up
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/leadsonderhoud.html` — tabs **Trajecten / Berichten / Vragenlijst** | Traject-definities + mail-/WhatsApp-templates + intake-vragen. | Instellingen > Leads & follow-up > Trajecten & sequences |
| Warmtescore-regels (in `api/leadsonderhoud-*`) | Score-formule op basis van antwoorden. | Instellingen > Leads & follow-up > Warmtescore |
| `modules/follow-up.html` — Sluimerpot (via "Zie meer") | Sluimer-timers voor calls die later terug moeten komen. | Instellingen > Leads & follow-up > Sluimerpot-regels |
| `feature_flags.lisa_live_mode` + Lisa follow-up sequence | (Zie B7 — Lisa) — deze is ook Leads & follow-up. | **Duplicate** — kies één plek in navigatie (voorstel: onder AI-agents > Lisa, mét see-also link vanuit Leads-instellingen). |

### B9. Klanten
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `api/customer-tag-definitions.js` (GET-only) + feature `customer.tag_definitions_manage` (nog geen UI) | Tag-catalogus klanten (slug/label/color/is_system). | Instellingen > Klanten > Tag-catalogus |
| `feature_flags.customer.avg.export / anonymize` | AVG-actie-drempels. | Instellingen > Klanten > AVG-regels |

### B10. Tickets
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `api/tickets.js` r.20-25 — `VALID_STATUSES/TYPES/PRIORITIES` (hardcoded) | Ticket-types/prioriteiten/statussen. Nu code. | Instellingen > Tickets > Types & prioriteiten (indien beheerbaar) |

### B11. Communicatie
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/email.html` — modal **Handtekening** (`SIGNATURE_KEY` localStorage, per user) | E-mail-handtekening (naam/functie/logo/socials). | Instellingen > Communicatie > E-mail-handtekening |
| `modules/email.html` — hardcoded categorisatie-regels (`applyHardRuleCategories` r.1910) + trainingmodus-toggle | Welke afzenders in welke categorie. | Instellingen > Communicatie > E-mail > Categorie-regels & training |
| `modules/email.html` — `AI_CATS_KEY` cache + `email_training_mode` toggle | AI-training modus voor e-mail-classificatie. | Instellingen > Communicatie > E-mail > AI-classificatie |
| WhatsApp Meta-templates (`whatsapp_meta_templates` + `meta_param_mapping`) | Named-var templates + Meta-approval. | Instellingen > Communicatie > WhatsApp-templates |

### B12. Algemeen
| Locatie nu | Wat | Nieuwe plek |
|---|---|---|
| `modules/shared/theme-shared.js` (`agency-cc-theme` localStorage) + nieuwe klanten-v2 `dfo-crm-theme` | Light/dark thema per user. | Instellingen > Algemeen > Uiterlijk |
| `vercel.json` (10 crons) + `api/sync-status.js` | Cron-schedules (sync-emails, dunning-engine, dunning-bulk, no-show-detect, etc.). Read-only monitor. | Instellingen > Algemeen > Cron-status (read-only) |
| ENV-vars `INTERNAL_API_TOKEN` / `ANTHROPIC_API_KEY` / `CRON_SECRET` / TL-OAuth-secrets | Server-side secrets. Nu Vercel-dashboard + 1Password. | Instellingen > Algemeen > Secrets (**alleen status-check, geen edit** — Vercel blijft bron) |
| ENV-vars `COMPANY_*` (bedrijfsgegevens templates) | Zie B4. | Instellingen > Algemeen > Bedrijfsgegevens |
| Feature-flag `feature_flags.*` (jsonb) | Master-toggles per experimenteel feature. | Instellingen > Algemeen > Feature-flags |

### B13. Duplicates die één plek moeten krijgen
1. **Lisa runtime-settings** — `lisa.html > Config > Algemeen` vs. `api/lisa-settings.js` schrijven allebei `lisa_settings`. → één UI-locatie (`Instellingen > AI-agents > Lisa > Runtime`).
2. **Bedrijfsprofiel** — Kennisbank-item `is_profile=true` is functioneel een AI-prompt-instelling. → Voorstel: onder AI-agents > Gedeeld bedrijfsprofiel, met see-also uit Kennisbank.
3. **Lisa follow-up sequence** — is zowel AI-config als Leads-instelling. → onder AI-agents > Lisa > Follow-up, met see-also uit Leads-instellingen.
4. **RBAC-matrix vs. per-module features** — matrix somt keys die verwijzen naar UI-schermen elders (bv. `sales.product.manage`). → Matrix blijft in Gebruikers & rollen, met deep-link vanaf de betreffende sub-instelling.
5. **E-mail categorisatie** — deels client-side hard-rules (localStorage), deels server-side (`api/categorize.js`). → Alleen serverside in Instellingen; client-cache blijft impliciet.
6. **Menu-indeling** — bestaat nu als `admin.sidebar`-feature, maar Menu-manager-tab en Rechten-matrix bepalen allebei zichtbaarheid. → Menu-tab kiest **volgorde + hard-verberg**, Rechten-matrix kiest **wie mag** — samenspel documenteren.

---

## Deel C — Rollen en rechten

Peildatum: `role_permissions`-seeds mig 014-016 + `docs/sql-migrations/2026-06-*` + `2026-07-*`.

**Beslissing 2026-08-06**: rollen-lijst wordt teruggebracht naar **5**: `super_admin`, `manager`, `sales`, `mentor`, `marketing` (marketing wordt later ingericht, nu alvast bewaard). Op te ruimen: `admin` (praktisch synoniem met manager), `administratie`, `viewer`. Concreet plan staat in **Bijlage 2 — Rol-cleanup-plan** onderaan dit document.

Legenda per feature-tabel: `SA`=super_admin (`*`-wildcard), `M`=manager, `S`=sales, `Mt`=mentor. `✓` = expliciete grant in productie-seed; `–` = geen grant (per-user via matrix mogelijk).

### C1. Sidebar-zichtbaarheid per rol

| Module (sidebar-label) | SA | M | S | Mt | Gate-key |
|---|---|---|---|---|---|
| Dashboard | eigen SA-dashboard | ✓ (`/index.html`) | ✓ (redirect sales-dashboard) | ✓ (mentor-home) | `dashboard.module.access` |
| Leads | ✓ | ✓ | ✓ | ✓ (view) | `leads.view` |
| Leadsonderhoud | ✓ | ✓ | ✓ | ✓ (view) | `leads.view` |
| E-mail | ✓ | ✓ | ✓ | – | `email.module.access` |
| Appointment setting (Lisa) | ✓ | ✓ | – | – | `lisa.module.access` |
| Takenbeheer | ✓ | ✓ | ✓ | ✓ | `taken.module.access` |
| Kennisbank | ✓ | ✓ | ✓ (read) | ✓ (read) | `kennisbank.module.access` |
| AI Agents | ✓ | ✓ | – | – | `agents.module.access` |
| Agent center | ✓ | – | – | – | `admin.joost_config` |
| Vergaderruimte | ✓ | ✓ | ✓ | ✓ | `meetings.module.access` |
| Control Center | ✓ | ✓ | – | – | `controlcenter.module.access` |
| Follow-up | ✓ | ✓ | ✓ | – | `followup.module.access` |
| Sales | ✓ | ✓ | ✓ | ✓ (beperkt: alleen tabs `customers`+`quotations`) | `sales.module.access` |
| Events | ✓ | ✓ | ✓ | ✓ (view + attendee-mutaties) | `events.module.access` |
| Meta Ads / Creative Studio | ✓ | matrix | matrix | matrix | `ads.module.access` / `ads.studio.access` |
| Financiën (mentor-self) | ✓ | via `mentor-detail` | – | ✓ | `mentor.module.access` |
| Studenten (mentor-self) | ✓ | – | – | ✓ | `mentor.module.access` |
| LMS (extern) | ✓ | – | – | ✓ | `mentor.module.access` |
| Onboarding (mentor-self) | ✓ | – | – | ✓ | `mentor.module.access` |
| Mentoren beheer | ✓ | ✓ | – | – | ANY van 4: `mentor.admin.view / payout.manage / funded.admin / assessments.admin` |
| Alle studenten | ✓ | ✓ | – | – | `students.all.view` |
| Onboarding (admin-hub) | ✓ | ✓ | ✓ | – | `onboarding.admin` |
| Finance | ✓ | ✓ (full) | ✓ (beperkt) | – | `finance.module.access` |
| Tickets | ✓ | ✓ (assign) | ✓ | ✓ | `tickets.module.access` |
| Admin | ✓ | ✓ (limited) | – | – | `admin.module.access` + `ADMIN_ROLES` filter |
| Logboek | ✓ | matrix | matrix | matrix | `audit.log.view` |
| Secret Area | server-check | – | – | – | `applySecretAreaGating()` |

### C2. Belangrijke feature-keys per cluster (samenvatting)

Complete lijst zit in `modules/admin.html` FEATURE_REGISTRY (r.955-1271). Hieronder de keys waar rol-scheidingen "echt" zijn.

**Sales-tabs (mig 015)** — per rol wélke van de 7 tabs
| Tab | SA | M | S | Mt |
|---|---|---|---|---|
| Dashboard | ✓ | ✓ | ✓ | – |
| Klanten | ✓ | ✓ | ✓ | ✓ |
| Offertes | ✓ | ✓ | ✓ | ✓ |
| Abonnementen | ✓ | ✓ | ✓ | – |
| Retentie | ✓ | ✓ | ✓ | – |
| Aanbod | ✓ | ✓ | ✓ | – |
| Rapporten | ✓ | ✓ | ✓ | – |

**Finance** — sales heeft *beperkte* Finance-toegang (invoice create/update/send + subscription.push) maar NIET wanbetalers/bank/expenses/joost/incasso.

**Events** — mentor mag attendees zien + aanwezigheid muteren + `attendee.assessment_view`; mag GEEN `publish`/`delete`/`mentor.assign`/`simone.use`.

**Onboarding** — sales kreeg mig 2026-07-06 `onboarding.admin` én mig 2026-07-31 `onboarding.assign_mentor` (voor na-verkoop mentor toewijzen). Wizard-editor + Automations blijven manager-only.

**Follow-up** — screenshot-review-audit (`follow-up-admin.html` gate `audit.approve/reject`) alleen manager+; operationele cockpit sales+mentor niet.

**Leads** — alle rollen zien; `delete` alleen SA; `update/promote` SA+M+S.

**Mentor** — twee-poten-model: mentor krijgt `mentor.module.access` + `ledger.view` (self-scope in endpoints via dual-gate); manager krijgt `mentor.admin.view` + `payout.manage/revert` + `funded.admin` + `assessments.admin`.

### C3. Waar rollen ECHT andere schermen zien (niet alleen minder knoppen)

Dit zijn plekken waar het redesign per rol een aparte flow moet blijven ondersteunen.

1. **Landing na login** — vier verschillende bestanden:
   - super_admin → `super-admin-dashboard.html`
   - manager+viewer+administratie → `/index.html`
   - sales → `sales-dashboard.html` → `sales.html?tab=dashboard`
   - mentor → `mentor-home.html`
2. **Mentor-cluster (self-service)** — mentor krijgt zijn eigen mini-app:
   - `mentor-home.html` (landing)
   - `mentor-dashboard.html` = "Financiën" (bonussen + payouts)
   - `mentor-students.html` (self-scope studenten)
   - `mentor-onboarding.html` (self-scope pijplijn)
   - Manager ziet dit via **`mentor-detail.html?id=<uuid>`** (spiegel-scherm) + admin-hub `mentoren-beheer.html`.
3. **Onboarding-splitsing**:
   - Klant: `onboarding.html` (token-link, geen login)
   - Admin/sales: `onboarding-hub.html`
   - Mentor: `mentor-onboarding.html` (self-scope)
4. **Follow-up-splitsing**:
   - Operationeel: `follow-up.html` + `follow-up-lead.html` (sales+manager+mentor)
   - Audit: `follow-up-admin.html` (manager+ only, aparte knop)
5. **Finance rol-verschil** — sales ziet Finance-tabblad, maar de banking / wanbetalers / incasso / expenses / joost sub-tabs zijn hard verborgen. Wel: invoice create/update/send + subscription.push. Dit is dus **hetzelfde scherm met andere tabs**, niet een aparte pagina.
6. **Sales tab-scheiding voor mentor** — mentor komt Sales binnen maar ziet alleen `Klanten` + `Offertes`. Ook "hetzelfde scherm, andere tabs".

Voor de overige rollen zit het verschil in ontbrekende actie-knoppen / verborgen tabs binnen hetzelfde scherm. Die zijn matrix-driven.

### C4. Opruimwerk in RBAC (gevonden discrepanties)

Deze niet-blokkerend voor Fase 3 redesign, wel op takenlijst:
- **Keys in `FEATURE_REGISTRY` zonder endpoint-check** — matrix-only (frontend-gate volstaat): 4 Sales-detail keys (`bonus.view_own / dashboard.view / retention.view / first_call.view`), alle Follow-up tab-keys, Klanten-widget-tabs, WhatsApp legacy top-level (7 keys), Brieven (2 keys). Kandidaten voor verwijderen.
- **Keys in endpoints/UI zónder `FEATURE_REGISTRY`-entry** — moeten toegevoegd worden: `finance.incasso.manage` (17 endpoints), `admin.sidebar`, `mentor.payout.manage/revert`, `mentor.funded.admin`, `mentor.assessments.admin`, `events.publish`, `events.mentor.remove`, `events.attendee.tag_add/remove`, `onboarding.view_own`, `onboarding.create`, `onboarding.automation.edit`.
- **RBAC_ROLES-uitwas** — `admin.html RBAC_ROLES` bevat `admin/marketing/administratie/viewer` die geen grants krijgen. Voorstel: opschonen naar 4 (SA/M/S/Mt).
- **Landing-map deviatie** — mig 014 header-comment claimt `manager → control-center.html`, maar `supabase-client.js:54` mapt manager → `/index.html`. Code is autoritatief; comment updaten.

---

## Deel D — Definitieve indeling

Vastgelegd 2026-08-06. Onderstaande beslissingen zijn contractueel voor elke bouw-PR — deel E hieronder is de per-module afvinklijst die daar tegen getoetst wordt.

### D0. Architectuur-principes (gefixed)

1. **Eén systeem, één shell, één zijbalk** — geen aparte mentor-mini-app en geen aparte sales-mini-app. Elke rol werkt in dezelfde codebase; de zijbalk vult zich op basis van rechten (rechten-check verbergt items die je niet mag zien).
2. **Dashboard is per rol anders, werkschermen zijn gedeeld** — het `/index.html`-Dashboard rendert rolspecifieke inhoud (mentor: eigen studenten & sessies; sales: pijplijn & op te volgen; manager+super_admin: totaalbeeld). Modules zoals Sales/Finance/Events zijn hetzelfde scherm voor iedereen; rechten verbergen tabs en knoppen. Één keer bouwen, één keer onderhouden.
3. **Geen duplicatie meer** — de mentor-cluster (`mentor-home.html`, `mentor-dashboard.html`, `mentor-students.html`, `mentor-onboarding.html`, `mentor-detail.html`) wordt vervangen door: rol-specifiek Dashboard + scope-filters ("Mijn / Alle") binnen de gedeelde modules. De losse mentor-*-files gaan naar archief zodra hun opvolger in de gedeelde module bestaat.
4. **Zijbalk-groepen zijn identiek voor iedereen** — mentor ziet dezelfde groep-namen als manager (Overzicht / Groei / Klanten & communicatie / …). Alleen de items eronder variëren. Dat maakt onboarding van nieuwe medewerkers voorspelbaar en support-instructies rol-onafhankelijk.
5. **Rollen (5)**: `super_admin`, `manager`, `sales`, `mentor`, `marketing`. `marketing` blijft leeg tot Fase X. `admin`/`administratie`/`viewer` worden opgeruimd — zie Bijlage 2.
6. **Instellingen samengetrokken** — alle verspreide config-schermen verhuizen naar één Instellingen-module (10 categorieën, zie D4). Oude locaties blijven werken tot de betreffende module is herbouwd, dan wordt de oude view uit-gelinkt.
7. **Binnenkort-pagina** — kaartenraster (zelfde opzet als Instellingen) waar niet-actieve modules onder blijven leven: Secret Area, Vergaderruimte, Kennisbank, Control Center, Simon/Leon/Aron-chat. Niks wordt verwijderd, alleen uit de hoofdnavigatie gehaald.

### D1. Unified zijbalk (identiek voor iedereen; rechten verbergen items)

Alle 5 rollen zien onderstaande boom. Per item is er een gate-key; heeft de rol die niet dan is het item verborgen (`display:none`). Op deze manier krijgt niemand een "kaal" scherm; wie iets niet mag, ziet het gewoon niet.

```
── OVERZICHT ─────────────────
  🏠  Dashboard              iedereen — inhoud rolspecifiek (zie D2)
  ✅  Taken                  iedereen
  🎯  Leads                  iedereen (mentor read-only)
  🌱  Leadsonderhoud         SA / manager / sales / marketing

── KLANTEN & COMMUNICATIE ────
  👥  Klanten                SA / manager / sales / mentor (mentor: scope Mijn)
  📥  E-mail                 SA / manager / sales
  💬  Inbox                  SA / manager / sales (WhatsApp — Finance+Events+Onboarding samen)
  📞  Follow-up              SA / manager / sales

── VERKOOP & FINANCIËN ────────
  🛒  Sales                  SA / manager / sales / mentor (mentor: alleen tabs Klanten + Offertes)
  💰  Finance                SA / manager / sales (sales: alleen tabs Facturen + Abonnementen)
  🚀  Onboarding             SA / manager / sales / mentor (mentor: scope Mijn)

── LEREN & EVENTS ────────────
  🎓  Events                 SA / manager / sales / mentor (mentor: scope Mijn)
  🧑‍🏫  Mentoren beheer      SA / manager
  📚  Alle studenten         SA / manager

── GROEI ─────────────────────
  📊  Meta Ads               SA / marketing (matrix voor overige)
  ✂️  Creative Studio        SA / marketing (matrix voor overige)

── OPERATIE ──────────────────
  🎫  Tickets                iedereen
  📜  Logboek                SA (matrix voor overige)

── SYSTEEM ───────────────────
  ⚙️  Instellingen           iedereen (inhoud rolspecifiek — zie D3)
  🧭  Binnenkort             iedereen (kaartenraster met naar-de-wachtkamer-modules — zie D4)
```

**Toelichting op de rol-verschillen** (zonder eigen shell te bouwen):
- Elke module met een "Mijn / Alle"-scope-schakelaar bovenaan (Sales/Klanten/Onboarding/Events) toont voor mentor **default Mijn** en verbergt de "Alle"-optie via de gate-key.
- Sales-tabs Dashboard/Abonnementen/Retentie/Aanbod/Rapporten zijn voor mentor verborgen (bestaande grants uit mig 015).
- Finance-tabs Wanbetalers/Bank/Uitgaven zijn voor sales verborgen (bestaande grants).
- Mentoren beheer + Alle studenten + Logboek + Rechten-matrix in Instellingen zijn manager+ only.
- Marketing krijgt in Fase X eigen Meta Ads-gate; nu leeg totdat we die rol inrichten.

### D2. Rolspecifiek Dashboard (`/index.html`)

Één bestand, één shell, één set componenten. De inhoud wordt bepaald door de rol van de ingelogde user — geen redirect meer naar aparte HTML-pagina's. Bestaande componenten (KPI-card, activity-feed, taken-widget) worden hergebruikt en gevuld met rolspecifieke data.

#### Dashboard voor **mentor**
Doel: mentor ziet direct waar zijn dag om draait — eigen studenten, sessies, verdiensten.

**Blokken (in deze volgorde):**
1. **Welkomst-hero** — naam + huidige uitbetalings-cyclus + link naar Financiën-detail.
2. **KPI-strip** (4 tegels): Actieve studenten (mijn) · 1-op-1 sessies deze week · Bonus deze maand (€) · Openstaande no-shows.
3. **Vandaag & morgen** — eigen kalender-slice (event-attendances + 1-op-1-slots) — 2-koloms tijdlijn.
4. **Onboarding-inbox** — mijn intake-pijplijn (top 5 openstaande met filter-chips Te behandelen / Wil niet / No-show).
5. **Mijn studenten met aandachtspunt** — top 5 uit `student-signals` (bv. inactief, missed session).
6. **Snelle links** — LMS · Nieuwe 1-op-1 · Ticket melden.

**Bron-endpoints**: `mentor-my-events`, `mentor-1on1-sessions`, `mentor-my-students`, `mentor-future-students-self`, `mentor-coaching-earnings`, bestaande `student-signals`.

#### Dashboard voor **sales**
Doel: sales ziet zijn call-pijplijn en direct opvolgwerk.

**Blokken:**
1. **Welkomst-hero** — naam + omzet-tegel deze maand (`super-admin-omzet` sales-scoped) + team-target-progressbar.
2. **KPI-strip** (4 tegels): Nieuwe leads vandaag · Geplande calls · Openstaande offertes · Retentie-signalen (klanten die afhaken).
3. **Vandaag's call-lijst** — top 10 uit follow-up.werklijst met snelknop "Open" en outcome-registratie inline.
4. **Openstaande offertes** — top 5 uit sales.offertes (status Verzonden > 7 dagen zonder response).
5. **Nieuwe leads** — top 10 uit leads.list met warmtescore.
6. **Snelle links** — Nieuwe offerte · Nieuwe klant · Ticket melden.

**Bron-endpoints**: bestaande `leads-list`, `sales-*`, `follow-up-appointments`, `super-admin-omzet` (rol-scoped).

#### Dashboard voor **manager + super_admin**
Doel: totaalbeeld — waar loopt het vast, wat moet ik zien.

**Blokken:**
1. **Welkomst-hero** — naam + totaal-omzet deze maand + KPI-overrides (bv. wanbetaler-alerts).
2. **KPI-strip** (6 tegels): Omzet MTD · Nieuwe klanten MTD · Openstaand debiteur (€) · Openstaande approvals · Actieve leads · Actieve wanbetaler-cases.
3. **Ops-alerts** — banner met bv. cron-failures (uit `sync-status`), gefaalde approvals, wanbetalers > 60 dagen.
4. **Open acties** — pending_actions top 10 (was open-acties.html) + link naar volledige lijst.
5. **Team-activiteit** — activity-log laatste 20 (was control-center kpi-bar).
6. **Financiële mini-grafiek** — omzet vs. target laatste 30 dagen.
7. **Snelle links** — Rechten-matrix · Cron-status · Historische events (SA-only).

**Bron-endpoints**: `super-admin-*`, `dashboard-stats`, `pending-actions-list`, `activity-log-list`, `sync-status`.

#### Dashboard voor **marketing** (placeholder tot Fase X)
Blokken skeleton: Meta Ads-cijfers · nieuwe leads per bron · funnel-conversie. Nu leeg-state ("Marketing-dashboard komt in Fase X").

### D3. Instellingen-module (deep-tree — ongewijzigd van vorige versie)

```
Instellingen
├── Gebruikers & rollen
│   ├── Accounts             (uit admin.html tab Gebruikers)
│   ├── Rechten-matrix       (uit admin.html tab Rechten)
│   └── Menu-indeling        (uit admin.html tab Menu beheer)
│
├── Sales
│   ├── Productcatalogus     (uit sales.html Aanbod-tab)
│   ├── Reservering-regels
│   └── Bonus-regels
│
├── Finance
│   ├── Bedrijfsgegevens     (COMPANY_* env-vars)
│   ├── Uitgaven-categorieën
│   ├── Bank auto-match
│   ├── Rapportage-distributie
│   ├── Forecast-scenario's
│   └── Alerts
│
├── Wanbetalers
│   ├── Aanmaan-templates    (WhatsApp/brief/email)
│   ├── Workflow-regels
│   ├── Engine-parameters    (cooldown-days, kantooruren)
│   ├── Pipeline-triggers    (4 booleans)
│   └── Engine-log (read-only)
│
├── Events
│   ├── Vragenlijst
│   ├── Automations
│   ├── Deadlines
│   ├── Bonus-regels         (mentor-bonus per event-type)
│   ├── Assets (niveau-foto's)
│   └── Simone (test + config)
│
├── Onboarding
│   ├── Wizard-vragen
│   ├── Automations
│   └── Flow-toewijzing      (1-op-1 vs Membership per product)
│
├── AI-agents
│   ├── Joost
│   │   ├── Config (persona/KB/model)
│   │   ├── Autonomie (5 feature-flags)
│   │   ├── Mandaat (5 arrangement-types + caps)
│   │   ├── Communicatie-limits
│   │   └── Intake
│   ├── Simone
│   ├── Mila
│   ├── Lisa
│   │   ├── Config (persona/fases/KB)
│   │   ├── Runtime (live-mode, kantooruren)
│   │   └── Follow-up-sequence
│   ├── Simon / Leon / Aron
│   ├── Kennisbank-tags
│   └── Gedeeld bedrijfsprofiel
│
├── Klanten
│   ├── Tag-catalogus
│   └── AVG-regels
│
├── Leads & follow-up
│   ├── Trajecten & sequences
│   ├── Warmtescore
│   └── Sluimerpot-regels
│
├── Communicatie
│   ├── E-mail-handtekening (per user)
│   ├── E-mail categorie-regels + training
│   ├── WhatsApp-templates
│   └── Nummers & mailboxen
│
├── Integraties
│   ├── TeamLeader           (OAuth + Import)
│   ├── GoHighLevel
│   ├── Meta (WhatsApp + Ads)
│   ├── Zoom
│   ├── Mollie
│   └── SMTP / IMAP
│
├── Tickets
│   └── Types & prioriteiten
│
└── Algemeen
    ├── Uiterlijk (light/dark)
    ├── Feature-flags
    ├── Cron-status (read-only monitor)
    └── Secrets-status (read-only)
```

### D4. Binnenkort-pagina (kaartenraster)

Nieuwe module `/modules/binnenkort.html` (Fase 2 na klanten-v2). Zelfde look-and-feel als Instellingen: een raster met kaarten, per kaart een titel + korte beschrijving + status-badge + "Openen"-knop naar het bestaande scherm. Niks verdwijnt; alles blijft bereikbaar.

**Kaarten in Binnenkort:**

| Kaart | Bestand | Status-badge | Waarom hier |
|---|---|---|---|
| Vergaderruimte | `modules/meetings.html` | 🚧 Beperkt gebruik | Zelden gebruikt in dagelijkse operatie |
| Kennisbank | `modules/kennisbank.html` | 📚 Actief maar niche | Content voedt Lisa/Joost/Simone; content-beheer verhuist naar Instellingen > AI-agents > Kennisbank-tags + bedrijfsprofiel |
| Control Center | `modules/control-center.html` | 🚧 Beperkt gebruik | Approval-inbox verhuist naar Instellingen > Wanbetalers > Engine-log; audit-log leeft in eigen Logboek-module |
| Simon / Leon / Aron chat | `modules/agents.html` | 💤 Sluimert | Joost/Simone/Mila zijn actieve agents; deze drie generieke chat-agents zijn oud |
| Secret Area | `modules/secret-area.html` | 🔐 Persoonlijk (SA) | Alleen voor super_admin zichtbaar; blijft server-PIN-gated |

Binnenkort-kaart voor Secret Area is voor iedereen behalve super_admin verborgen (dezelfde `applySecretAreaGating`-check).

### D5. Archief-batch — verwijderkandidaten (na alle deep-links opgeruimd)

Zijn niet in Binnenkort; kunnen daadwerkelijk weg zodra links opgeruimd zijn.

- `modules/dashboard-v1-archive.html`
- `modules/kennisbank-v1-archive.html`
- `modules/wanbetalers.html` (legacy standalone — Finance-module heeft alles)
- `modules/open-acties.html` (redirector — kan weg als geen bookmarks meer)
- `modules/mentor-grootboek.html` (redirect-stub)
- `modules/sales-dashboard.html` (redirect-stub — vervalt zodra `/index.html` het rolspecifieke sales-dashboard rendert)
- `modules/onboarding-admin.html`, `onboarding-wizard-editor.html`, `onboarding-automations.html` (dormant standalones — hub is primair, editor+automations verhuizen naar Instellingen)
- `modules/wanbetalers-test.html`, `wanbetalers-diagnose.html` — verhuizen naar Instellingen > Wanbetalers > Diagnose (SA-only)
- `modules/mentor-home.html`, `mentor-dashboard.html`, `mentor-students.html`, `mentor-onboarding.html`, `mentor-detail.html`, `mentor-payouts-admin.html`, `funded-certificates-admin.html`, `student-assessments-admin.html`, `mentor-cash-trajects-admin.html`, `mentoren-beheer.html`, `students-overview.html` — vervangen door rolspecifieke Dashboard + scope-filters "Mijn / Alle" op Klanten-v2, Sales-v2, Events-v2, Onboarding-v2. Verhuizen naar archief **pas** nadat elk stuk functionaliteit in de gedeelde modules bestaat.
- `modules/klanten.html` — **pas** na klanten-v2 PR-C compleet + Sales-Klanten-tab overzet.

### D6. Bouwvolgorde (bevestigd 2026-08-06)

1. **Klanten-v2** (bezig — PR-A live). PR-B (7 detail-tabs) + PR-C (6 modals) volgen.
2. **Instellingen-module** — skelet + de 3 hoofdgroepen die het meest verspreid zitten (Gebruikers & rollen, Integraties, AI-agents). Overige categorie-sub-schermen komen mee met hun module in stappen 3-7.
3. **Sales-v2** (blue-accent) — grootste module, hergebruikt Klanten-v2 componenten. Instellingen > Sales > Productcatalogus komt hier mee.
4. **Finance-v2** (amber-accent) — inclusief Wanbetalers als sub-view. Instellingen > Finance + Wanbetalers komen mee.
5. **Events-v2** (violet-accent) — event-shell + Simone-config + automations verhuizen naar Instellingen.
6. **Onboarding-v2 + Mentor-integratie** — Onboarding-hub-v2 + mentor-scope-filters op Sales/Klanten/Events. Losse mentor-*.html-files verhuizen naar archief.
7. **Leads / Follow-up / Meta Ads / Communicatie / E-mail / Taken / Tickets / Logboek** — laatste ronde, kleinere modules op nieuwe design-system-baseline.
8. **Rol-cleanup** (kan parallel met stap 2+) — zie Bijlage 2.
9. **Binnenkort-pagina** — bouwen wanneer Instellingen-skelet staat (deelt veel componenten).

Elke module krijgt eigen PR-A/B/C-structuur (skelet → detail → modals) en per PR een INVENTARIS-afvinklijst plus een verwijzing naar deel E hieronder voor rol-verschillen.

---

## Deel E — Per module: wat verandert voor welke rol

Contractueel voor elke bouw-PR. Voor elke module: 1 tabel met per rol wat er verandert t.o.v. het huidige scherm. `→` betekent "wordt in v2". Als er niks verandert staat er "gelijk aan nu".

### E1. Dashboard (`/index.html`)

| Rol | Nu | v2 (deze redesign) |
|---|---|---|
| super_admin | Redirect naar `super-admin-dashboard.html` | Blijft op `/index.html`; ziet manager+SA-dashboard (zie D2, incl. SA-only historische events + rechten-shortcut) |
| manager | `/index.html` bento | `/index.html` met totaalbeeld-dashboard (zie D2) |
| sales | Redirect naar `sales-dashboard.html` → `sales.html?tab=dashboard` | Blijft op `/index.html`; ziet sales-dashboard (zie D2) |
| mentor | Redirect naar `mentor-home.html` | Blijft op `/index.html`; ziet mentor-dashboard (zie D2) |
| marketing | (rol ongebruikt) | Placeholder-dashboard met "komt in Fase X" |

**Cross-rol wijziging**: `ROLE_LANDING` in `supabase-client.js` wordt vereenvoudigd — iedereen naar `/index.html`; `super-admin-dashboard.html`, `mentor-home.html`, `sales-dashboard.html` gaan naar archief.

### E2. Klanten (v2 — bezig)

| Rol | Nu | v2 |
|---|---|---|
| super_admin | `klanten.html` deep-link vanaf Sales | `/modules/klanten-v2/` als eigen sidebar-item; alle klanten zichtbaar |
| manager | Idem | Idem; extra: AVG-acties (anonymize/export) knop zichtbaar |
| sales | Idem | Idem; `customer.hard_delete` verborgen |
| mentor | Niet zichtbaar in sidebar | Wél in sidebar; scope-filter default **Mijn** (alleen klanten van eigen studenten); "Alle"-optie verborgen |
| marketing | (ongebruikt) | Read-only lijst; geen bewerkacties |

### E3. Sales (`modules/sales.html` → `sales-v2`)

| Rol | Nu | v2 |
|---|---|---|
| super_admin / manager | Alle 7 tabs (Dashboard/Klanten/Offertes/Abonnementen/Retentie/Aanbod/Rapporten) | Idem; Aanbod-tab verhuist naar Instellingen > Sales > Productcatalogus (deep-link blijft werken) |
| sales | Alle 7 tabs | Alle 7 tabs; Aanbod-tab: read-only view + link naar Instellingen |
| mentor | Alleen tabs Klanten + Offertes | Idem, plus scope-filter default **Mijn** op Klanten + Offertes |
| marketing | (ongebruikt) | Alleen Dashboard + Retentie (read-only) |

### E4. Finance (`modules/finance.html` → `finance-v2`)

| Rol | Nu | v2 |
|---|---|---|
| super_admin / manager | Alle tabs (Dashboard/Facturen/Creditnota/Klanten/Wanbetalers/Bank/Uitgaven/Roadmap) | Alle tabs behalve Roadmap (die verdwijnt) + Instellingen-sub-tabs verhuizen naar Instellingen > Finance + Wanbetalers |
| sales | Alleen invoice.create/update/send + subscription.push | Ziet alleen tabs Facturen + Abonnementen |
| mentor | Niet zichtbaar | Niet zichtbaar |
| marketing | (ongebruikt) | Niet zichtbaar |

### E5. Events (`modules/events.html` + wizard + detail + automations → `events-v2`)

| Rol | Nu | v2 |
|---|---|---|
| super_admin / manager / sales | Alle events + Instellingen-sub-tabs (Vragenlijst/Simone/Automations/Deadline/Niveau-foto's) | Alle events; Instellingen-sub-tabs verhuizen naar Instellingen > Events (deep-link blijft werken) |
| mentor | View + attendee.mutaties op eigen events | Scope-filter default **Mijn events**; kan status wijzigen op eigen attendees; geen publish/delete/mentor.assign |
| marketing | (ongebruikt) | Read-only overzicht |

### E6. Onboarding (`modules/onboarding-hub.html` + wizard-editor + automations → `onboarding-v2`)

| Rol | Nu | v2 |
|---|---|---|
| super_admin / manager | Hub met Overzicht/Wizard/Automations | Overzicht in Onboarding-module; Wizard-editor + Automations verhuizen naar Instellingen > Onboarding |
| sales | Overzicht + `assign_mentor` (sinds mig 2026-07-06) | Idem; kan onboarding starten + mentor toewijzen |
| mentor | Eigen `mentor-onboarding.html` scherm | Zelfde Onboarding-module met scope-filter **Mijn** (default); ziet eigen intake-pijplijn |
| marketing | (ongebruikt) | Niet zichtbaar |

### E7. Mentoren beheer + Alle studenten (verdwijnt als losse modules)

De hele mentor-admin-hub (`mentoren-beheer.html` + `mentor-detail.html` + `mentor-payouts-admin.html` + `funded-certificates-admin.html` + `student-assessments-admin.html` + `mentor-cash-trajects-admin.html` + `students-overview.html`) wordt vervangen door:

| Functie | Nieuwe plek |
|---|---|
| Per-mentor overzicht (`mentor-detail`) | Scope-filter "Alle mentors" op Sales-v2 Klanten-tab + eigen mentor-drill-down via klant-dossier |
| Alle studenten (`students-overview`) | Scope-filter "Alle" op Klanten-v2 (standaard voor manager+) |
| Payout-rapporten | Instellingen > Sales > Bonus-regels + eigen Payout-module onder Finance |
| Funded-certificaten | Instellingen > Events > Bonus-regels (rijenlijst als sub-tab) |
| Beoordelingen | Kaart in Klant-dossier > Beoordelingen-tab (Klanten-v2 PR-B) |
| Handmatige trajecten | Instellingen > Sales > Bonus-regels > Handmatig |

Manager+ ziet dus geen aparte "Mentoren beheer"-module meer — alles zit in de gedeelde modules met de juiste scope-filter. Mentor ziet ook geen aparte hub — die deed hij toch al niet.

### E8. Instellingen (nieuwe module)

| Rol | Zichtbaar |
|---|---|
| super_admin | Alle 12 categorieën uit D3 |
| manager | Alle categorieën behalve Rechten-matrix-write, Secrets-status, Feature-flags-write |
| sales | Alleen: Sales (Productcatalogus, Bonus-regels), Communicatie (E-mail-handtekening — persoonlijk), Algemeen (Uiterlijk) |
| mentor | Alleen: Algemeen (Uiterlijk) + "Mijn profiel" |
| marketing | Alleen: Communicatie (E-mail-handtekening), Algemeen (Uiterlijk) + later Meta Ads-config |

### E9. Leads / Leadsonderhoud / Follow-up

| Rol | Nu | v2 |
|---|---|---|
| super_admin / manager / sales | Volledig | Gelijk; kleinere UI-refresh op nieuwe design-system |
| mentor | Read-only (leads.view alleen) | Idem — in sidebar zichtbaar maar geen bewerkacties |
| marketing | Volledig (na Fase X) | Marketing-scope: eigen bron-metrics + lead-quality-alerts |

### E10. E-mail / Inbox

| Rol | Nu | v2 |
|---|---|---|
| super_admin / manager | Alle 8 tabs | Gelijk; handtekening-modal verhuist naar Instellingen > Communicatie |
| sales | Alle tabs zichtbaar (matrix per tab) | Gelijk |
| mentor | Niet zichtbaar | Niet zichtbaar |
| marketing | (ongebruikt) | Alleen Reclame-tab standaard |

### E11. Taken / Tickets

| Rol | Nu | v2 |
|---|---|---|
| Alle rollen | Zichtbaar | Gelijk; kleinere UI-refresh. Ticket-types/prioriteiten verhuizen naar Instellingen > Tickets zodra beheerbaar |

### E12. Meta Ads + Creative Studio

| Rol | Nu | v2 |
|---|---|---|
| super_admin | Zichtbaar | Gelijk; verhuist naar "Groei"-groep in de nieuwe sidebar |
| manager / sales / mentor | Matrix (default niet zichtbaar) | Gelijk |
| marketing | (ongebruikt) | Default zichtbaar zodra rol wordt uitgedeeld |

### E13. Logboek

| Rol | Nu | v2 |
|---|---|---|
| super_admin | Zichtbaar | Gelijk |
| manager / sales / mentor / marketing | Matrix (default niet zichtbaar) | Gelijk; manager krijgt default `audit.log.view` in nieuwe seed |

### E14. Binnenkort-pagina (Vergaderruimte / Kennisbank / Control Center / Simon-Leon-Aron chat / Secret Area)

| Rol | Nu | v2 |
|---|---|---|
| super_admin | Alle 5 modules in eigen sidebar-items | Alle 5 kaarten op /modules/binnenkort.html (incl. Secret Area) |
| manager | 4 modules zichtbaar (geen Secret Area) | 4 kaarten (geen Secret Area) |
| sales | 3 modules zichtbaar (Vergaderruimte, Kennisbank read, geen Control Center / Secret Area / AI-chat) | 2 kaarten (Vergaderruimte, Kennisbank read) |
| mentor | 2 modules zichtbaar (Vergaderruimte, Kennisbank read) | 2 kaarten |
| marketing | Nog leeg | 1-2 kaarten (Vergaderruimte, Kennisbank read) |

---

## Bijlage 1 — Aannames & open vragen

- **Bevestigd**: één shell, geen mentor-mini-app; mentor krijgt rolspecifiek Dashboard + scope-filters "Mijn/Alle" op gedeelde modules.
- **Bevestigd**: 5 rollen (super_admin, manager, sales, mentor, marketing). Cleanup van admin/administratie/viewer in Bijlage 2.
- **Bevestigd**: Binnenkort-pagina met 5 kaarten (Vergaderruimte, Kennisbank, Control Center, Simon/Leon/Aron chat, Secret Area).
- **Bevestigd**: Instellingen samengetrokken (10 categorieën uit D3); oude locaties werken door tot module herbouwd is.
- **Bevestigd**: bouwvolgorde 1-9 uit D6.
- **Aanname**: `super_admin`-only tools (wanbetalers-diagnose/test, admin-tl-import, admin-historical-events) worden sub-tools onder Instellingen > Wanbetalers > Diagnose respectievelijk Instellingen > Integraties > TeamLeader > Import. Bevestig als dat anders moet.
- **Aanname**: Marketing-rol krijgt in Fase X de sidebar-items Meta Ads + Creative Studio + Leadsonderhoud-scope, plus placeholder-dashboard. Concrete inhoud komt zodra we die rol uitrollen.
- **Open vraag**: Kennisbank-content-beheer (KB-items zelf) — blijft dat een eigen kaart in Binnenkort of gaat het volledig op in Instellingen > AI-agents > Kennisbank-tags? Voorstel: kaart blijft in Binnenkort voor item-beheer; tag-catalogus verhuist naar Instellingen.

---

## Bijlage 2 — Rol-cleanup-plan (admin / administratie / viewer)

Doel: van 8 naar 5 rollen. Behouden: `super_admin`, `manager`, `sales`, `mentor`, `marketing` (leeg tot Fase X). Op te ruimen: `admin`, `administratie`, `viewer`.

### B2.1 Waarom deze 3 rollen

- **`admin`** — praktisch synoniem met manager (in `ADMIN_ROLES = ['super_admin','admin','manager']` en overal in `ALLOWED_ROLES`-arrays). In `admin-seed-users.js` staat biemold met rol `admin`; verifyAdmin() behandelt admin identiek aan manager. Consolideren: iedereen met `admin` → `manager`.
- **`administratie`** — enkel gedefinieerd, geen role_permissions-grants. In `email.html` en `agent-tools.js` verwart met de administratie-**mailbox** (`administratie@deforexopleiding.nl`). Rol wordt in productie niet uitgedeeld. Veilig te verwijderen.
- **`viewer`** — fallback in `admin-users.js` (regel 14: "als er geen rol is → viewer"). Geen actieve rechten. Kan vervangen worden door "no role" of door manager-read-only. Voorstel: verwijderen, fallback wordt "geen rol → geen toegang tot dashboard, wel login".

### B2.2 Code-plekken die aanpassing vereisen

Deze locaties bevatten hardcoded rol-lijsten of role-checks; elke moet aangepast worden bij de cleanup:

**Backend-constanten (single-source-of-truth):**
- `api/supabase.js` — `ADMIN_ROLES = ['super_admin','admin','manager']` → wordt `['super_admin','manager']`.
- `api/admin-users.js:8` — `VALID_ROLES = ['super_admin','admin','manager','sales','mentor','marketing','administratie','viewer']` → wordt `['super_admin','manager','sales','mentor','marketing']`.
- `api/admin-users.js:14` — `ROLE_PRIORITY = [...]` — trim + fallback-rol wijzigen (bv. eerste geldige rol of null).
- `api/admin-rbac-backfill-roles.js:9` — zelfde `ROLE_PRIORITY`; alignen.
- `api/admin-impersonate.js:42+60` — `VALID_ROLES` trim + strikte impersonate-check (nu al `super_admin` OR `manager`) blijft.
- `api/admin-seed-users.js:17` — biemold-seed: `role: 'admin'` → `role: 'manager'`.

**Backend endpoint-arrays (ALLOWED_ROLES):**
- `api/follow-up-afgeboekt.js`, `follow-up-annuleer.js`, `follow-up-appointment-outcome.js`, `follow-up-appointments.js`, `follow-up-dashboard-metrics.js`, `follow-up-ghl-*.js` — alle bevatten `['super_admin','admin','manager', …]`. Vervang `admin` → weglaten (manager blijft).
- Grep-check: `grep -rn "'admin'" api/` en `grep -rn "'administratie'" api/ | grep -v mailbox | grep -v backfill` voor overige refs.

**Frontend:**
- `modules/admin.html:1274` — `RBAC_ROLES = [{key:'super_admin',...},{key:'admin',...},...]` → verwijder entries voor admin/administratie/viewer/marketing (marketing tijdelijk verbergen achter feature-flag tot Fase X).
- `modules/admin.html` — PERMISSION_CATALOG rol-defaults: filter rol-kolommen naar 5.
- `modules/email.html:6062` — `ADMIN_ROLES = ['super_admin','admin','manager']` → `['super_admin','manager']`.
- `modules/finance.html:8454` — `ADMIN_ROLES` — idem.
- `modules/shared/sidebar.js` — check op `ADMIN_ROLES` bij sidebar-admin-link (regel ~414).
- `modules/shared/supabase-client.js:48-60` — `ROLE_LANDING` — verwijder `admin`-entry (zoals in stap E1).
- Alle andere `modules/*.html` — grep `'admin'` als string, alleen dan waar het rol is (niet mailbox).

**Database:**
- `migrations/001-auth-foundation.sql:14` — `CHECK (role IN ('admin', 'sales', 'mentor', 'administratie', 'viewer'))` — is `super_admin`/`manager`/`marketing` niet in de oorspronkelijke CHECK. Er moet een migratie zijn die dat later toevoegt. Nieuwe migratie: `ALTER TABLE profiles DROP CONSTRAINT profiles_role_check; ALTER TABLE profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('super_admin','manager','sales','mentor','marketing'));`.
- `role_permissions`-tabel — rows waar `role IN ('admin','administratie','viewer')` → DELETE. (De grants zijn deels overlappend met manager; admin-grants worden veilig weggegooid want manager heeft alles al.)
- `user_roles`-tabel (indien in gebruik) — idem: rows met verwijderde rollen weghalen.

### B2.3 Stappenplan (safe migration)

**Stap 1 — Pre-flight audit (read-only)**
```sql
-- Hoeveel users hebben welke rol?
SELECT role, COUNT(*) FROM profiles GROUP BY role ORDER BY 2 DESC;
-- Als user_roles gebruikt wordt:
SELECT role, COUNT(*) FROM user_roles GROUP BY role ORDER BY 2 DESC;
-- Welke email-adressen hebben de te-verwijderen rollen?
SELECT email, role, is_active FROM profiles WHERE role IN ('admin','administratie','viewer');
```
Rapporteer output aan Jeffrey; per gebruiker beslissen naar welke rol.

**Stap 2 — Migreer users**
```sql
-- Iedereen met rol 'admin' → 'manager' (functionele equivalent).
UPDATE profiles SET role = 'manager', updated_at = now() WHERE role = 'admin';
-- 'administratie' en 'viewer' per user besluiten (default: 'manager' voor actieve users,
-- of deactiveren voor slapende accounts).
-- Doe dit expliciet per user, geen bulk-UPDATE.
```

**Stap 3 — Trim role_permissions**
```sql
DELETE FROM role_permissions WHERE role IN ('admin','administratie','viewer');
```

**Stap 4 — DB-CHECK-constraint aanpassen**
```sql
ALTER TABLE profiles DROP CONSTRAINT profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('super_admin','manager','sales','mentor','marketing'));
-- Idem voor user_roles indien aanwezig.
```

**Stap 5 — Code refactor (grote maar mechanische PR)**
Alle plekken uit B2.2 aanpassen, één PR. Test: login als elke rol werkt nog, sidebar filtert correct, admin-endpoints geven nog steeds 200 voor manager-users.

**Stap 6 — Backend seed-file aanpassen**
`api/admin-seed-users.js` — `role: 'manager'` voor biemold; nieuwe seed-runs geven de juiste rol.

**Stap 7 — Deploy + verifieer**
- Login als manager: mag alle admin-schermen zien.
- Login als sales/mentor: sidebar filter correct.
- Impersonate-flow werkt nog (super_admin → manager/sales/mentor).
- `sync-status`-endpoint teruggeeft geen 500 (validatiescore).

### B2.4 Risico's

- **Users met rol=admin verliezen toegang** als de code-refactor eerder deployt dan de DB-UPDATE. **Volgorde is dus**: eerst DB-UPDATE (stap 2), dán code-PR mergen (stap 5). Beide backwards-compatible in de tussenperiode want manager heeft alles wat admin had.
- **RLS-policies** die op `role = 'admin'` filteren moeten mee-aangepast. Grep alle `docs/sql-migrations/*.sql` en `migrations/*.sql` op `'admin'` als literal in policy-body. Vervang naar `'manager'`.
- **CHECK-constraint** blokkeert INSERTs met oude rollen; als er 3rd-party integraties zijn die profiles aanmaken met `role='admin'` (bv. SSO-provisioning), moet dat ook meegemigreerd.

### B2.5 Marketing-rol vooralsnog leeg

Marketing wordt bewaard maar krijgt geen grants tot Fase X. In `RBAC_ROLES` blijft de entry staan (zodat de matrix-tab de kolom kan tonen als beheerder daar rechten aanvinkt). In DB-CHECK-constraint zit hij al vanaf de nieuwe versie. Users kunnen dus wél de rol krijgen; ze zien alleen een dashboard met "Marketing-dashboard komt in Fase X" totdat we die rol inrichten.

- **Open vraag**: Klanten-v2 hoort straks bij de Klanten-groep; wanneer switchen we `modules/klanten.html`-links (sales, finance-tasks, finance-crediteer) naar `klanten-v2`? Dat is een aparte upgrade-batch nadat PR-C live is.
