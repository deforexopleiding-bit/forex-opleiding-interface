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

Peildatum: `role_permissions`-seeds mig 014-016 + `docs/sql-migrations/2026-06-*` + `2026-07-*`. In `admin.html RBAC_ROLES` staan óók `admin`, `marketing`, `administratie`, `viewer` — in de praktijk niet uitgegeven. Voorstel Deel D: opruimen naar 4.

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

## Deel D — Voorstel nieuwe indeling

Kern-principes:
1. **Twee soorten items in de zijbalk**: **Werken** (dagelijkse operatie) en **Instellingen** (samengetrokken). Alles wat geen dagelijkse operatie is verhuist naar de Instellingen-boom.
2. **Groepen boven-elkaar** in de zijbalk met dunne kop-labels, niet meer dan 5–6 zichtbare items per groep zonder scrollen.
3. **Rol filtert de zijbalk**, niet de groep-structuur — alle rollen zien dezelfde groep-namen, ze zien alleen andere items eronder.
4. **Mentor-rol krijgt een compleet eigen mini-app-shell** — geen "verkleinde manager-view".
5. **"Binnenkort"-groep** onderaan voor niet-actieve modules die we niet weggooien: Secret Area, Kennisbank, Vergaderruimte, plus 3–4 kandidaten hieronder.

### D1. Voorstel zijbalk voor **super_admin / manager**

```
── OVERZICHT ─────────────────
  🏠  Dashboard
  📋  Vandaag  (⋯verzameltaak: 'Open acties' badge — was open-acties.html)

── GROEI ─────────────────────
  🎯  Leads
  🌱  Leadsonderhoud
  📞  Follow-up
  📊  Meta Ads
  ✂️  Creative Studio

── KLANTEN & COMMUNICATIE ────
  👥  Klanten            (nieuwe klanten-v2 — vervangt klanten.html)
  📥  E-mail
  💬  Inbox              (WhatsApp — Finance+Events+Onboarding samen)

── VERKOOP & FINANCIËN ────────
  🛒  Sales
  💰  Finance            (incl. Wanbetalers / Bank / Uitgaven)

── LEREN & EVENTS ────────────
  🎓  Events
  🧑‍🏫  Mentoren beheer   (admin-hub voor manager+)
  📚  Alle studenten     (manager+)
  🚀  Onboarding

── OPERATIE ──────────────────
  ✅  Taken
  🎫  Tickets
  📜  Logboek

── AI ────────────────────────
  🤖  AI Agents (Joost / Simone / Mila / Simon / Lisa)
                          (samengetrokken: agents.html + agent-center.html + lisa.html)

── INSTELLINGEN ──────────────
  ⚙️  Instellingen        (gebundelde settings-boom — zie D3)
  🛡️  Admin              (link naar user-mgmt + RBAC-matrix)

── BINNENKORT ────────────────
  🔬  Vergaderruimte
  📖  Kennisbank
  🔐  Secret Area         (SA-only, hidden by default)
```

**Verschillen manager vs. super_admin**: alles wat SA extra ziet zijn:
- Agent center (via `admin.joost_config`) — kan onder AI-groep
- Secret Area (server-check)
- Rechten-tab-schrijven in Instellingen > Gebruikers & rollen
- Alle super_admin-only sub-tools (wanbetalers-diagnose/test, admin-tl-import, admin-historical-events)

### D2. Voorstel zijbalk voor **sales**

```
── OVERZICHT ─────────────────
  🏠  Dashboard           (sales-dashboard)
  📋  Vandaag

── GROEI ─────────────────────
  🎯  Leads
  🌱  Leadsonderhoud
  📞  Follow-up
  📊  Meta Ads (optioneel via matrix)

── KLANTEN & COMMUNICATIE ────
  👥  Klanten
  📥  E-mail
  💬  Inbox

── VERKOOP ───────────────────
  🛒  Sales
  💰  Finance             (beperkte tabs: Facturen + Abonnementen)
  🚀  Onboarding          (na-verkoop toewijzen — sinds mig 2026-07-06)

── LEREN & EVENTS ────────────
  🎓  Events

── OPERATIE ──────────────────
  ✅  Taken
  🎫  Tickets

── AI ────────────────────────
  📖  Kennisbank (read-only)  ← optioneel; anders in Binnenkort

── INSTELLINGEN ──────────────
  ⚙️  Instellingen         (alleen sales-scope: eigen aanbod, sales-bonus,
                             follow-up-sluimer — géén finance/wanbetalers)
```

### D3. Voorstel zijbalk voor **mentor** (eigen mini-app)

```
── OVERZICHT ─────────────────
  🏠  Home                 (mentor-home)
  💰  Financiën            (mentor-dashboard)

── STUDENTEN ─────────────────
  👥  Mijn studenten       (mentor-students)
  🚀  Onboarding           (mentor-onboarding)
  🎓  Events (self)        (agenda + attendees voor eigen events)
  🌐  LMS (extern)

── OPERATIE ──────────────────
  ✅  Taken
  🎫  Tickets
  🎯  Leads (view-only)
```

Geen Instellingen-groep voor mentor (behalve eventueel eigen thema + notificatie-voorkeuren onder een klein "Mijn profiel"-blok in de footer).

### D4. Voorstel voor de **Instellingen-module** (deep-tree)

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

### D5. "Binnenkort" — wat mag naar de wachtkamer

Zoals user aangaf: Secret Area, Kennisbank, Vergaderruimte. Uit de A-inventaris zou ik daaraan willen toevoegen:
- **AI Agents (Simon/Leon/Aron chat)** — Joost/Simone/Mila zijn actief; Simon/Leon/Aron zijn oude generieke chat-agents die feitelijk niet dagelijks gebruikt worden. Voorstel: chatten met Simon/Leon/Aron naar Binnenkort; Joost/Simone/Mila-config wél in "AI"-groep (Instellingen) actief.
- **Meetings/Vergaderruimte** — zoals user zei.
- **Control Center** — approval-inbox is deels overgenomen door de Wanbetalers-Instellingen-tab. Voorstel: naar Binnenkort tenzij je hem daadwerkelijk nog gebruikt voor agent-approvals.
- **Meta Ads / Creative Studio** — houden in "Groei" want dagelijks door Jeffrey.
- **Kennisbank** naar Binnenkort? Kennisbank voedt Lisa/Joost/Simone — de KB-items zelf zijn wél in gebruik. Voorstel: **niet naar Binnenkort**, maar wél opnemen onder "AI" met een simpelere UI ("Bedrijfsprofiel + agent-specifieke tags" — dat is wat je feitelijk beheert).

### D6. Archief-batch — verwijderkandidaten (na alle deep-links opgeruimd)

- `modules/dashboard-v1-archive.html`
- `modules/kennisbank-v1-archive.html`
- `modules/wanbetalers.html`
- `modules/open-acties.html` (redirector — kan weg als geen bookmarks meer)
- `modules/mentor-grootboek.html` (redirect-stub)
- `modules/sales-dashboard.html` (redirect-stub — als sales-landing direct naar sales.html?tab=dashboard mag)
- `modules/onboarding-admin.html`, `onboarding-wizard-editor.html`, `onboarding-automations.html` (dormant standalones — hub is primair)
- `modules/wanbetalers-test.html`, `wanbetalers-diagnose.html` (super_admin-only, houden of naar Instellingen > Wanbetalers > Diagnose als sub-tool)
- `modules/klanten.html` (**pas** na klanten-v2 PR-C compleet + Sales-Klanten-tab overzet)

### D7. Bouw-volgorde (voorstel — kan bijgesteld)

Als we het redesign per module aanpakken zoals bij Klanten-v2 (PR-A/B/C):

1. **Klanten-v2** (bezig — PR-A live).
2. **Instellingen-module** (skelet + gebruikers/rollen + integraties eerst; de content-tabs komen mee met de module-redesigns hieronder).
3. **Sales-v2** (blue-accent) — grootste module, veel data-sharing met Klanten-v2.
4. **Finance-v2** (amber-accent) — inclusief Wanbetalers als sub-view.
5. **Events-v2** (violet-accent) — event-shell + automations verhuizen naar Instellingen.
6. **Onboarding-v2 + Mentor-cluster** (samen — delen veel data).
7. **Leads/Follow-up/Meta Ads/Communicatie** (laatste ronde — kleinere modules op nieuwe design-system-baseline).

Elke module krijgt eigen PR-A/B/C-structuur (skelet → detail → modals) en per PR een INVENTARIS-afvinklijst.

---

## Bijlage — Aannames & open vragen

- **Aanname**: mentor-rol krijgt in nieuwe indeling écht eigen mini-app-shell (blijft huidige gedrag). Als je liever één shell wilt met rol-verbergen, is dat ander pad.
- **Aanname**: `admin`, `marketing`, `administratie`, `viewer` mogen uit `RBAC_ROLES` verwijderd. Bevestig.
- **Aanname**: `super_admin`-only tools (wanbetalers-diagnose/test, admin-tl-import, admin-historical-events) mogen onder Instellingen > … > Diagnose / Import. Als je ze liever op eigen zij-tab houdt is dat prima.
- **Open vraag**: Meta Ads + Creative Studio — houden in "Groei"-groep of ook naar Binnenkort? Voorstel: houden (dagelijks Jeffrey).
- **Open vraag**: Simon/Leon/Aron chat-agents (`modules/agents.html`) — verwijderen of alleen chat-shell naar Binnenkort? Config-in-code (agents-tabel + FALLBACK_PROMPTS) blijft in AI-instellingen.
- **Open vraag**: Klanten-v2 hoort straks bij de Klanten-groep; wanneer switchen we `modules/klanten.html`-links (sales, finance-tasks, finance-crediteer) naar `klanten-v2`? Dat is een aparte upgrade-batch nadat PR-C live is.
