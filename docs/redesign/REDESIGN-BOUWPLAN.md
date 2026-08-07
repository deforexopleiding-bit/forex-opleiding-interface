# Redesign — Bouwplan (prototype → productie)

**Doel:** het volledige uiterlijk + de UX uit het prototype (`systeemprototype-v45.html` in deze map) uitvoeren in het bestaande systeem, gekoppeld aan echte Supabase-data en de bestaande integraties.
**Bronwaarheid voor uiterlijk & interactie:** het prototype-HTML-bestand. Alles hieronder beschrijft *wat* er per module moet gebeuren en *welke data* het nodig heeft; het *hoe het eruitziet* staat exact in het prototype.

- **Repo:** `github.com/deforexopleiding-bit/forex-opleiding-interface`
- **Supabase:** `nsjnsvlmdhunzqkdvagm` · **Vercel:** `forex-opleiding-interface.vercel.app`
- **Gebruiker/rollen:** super_admin, manager, sales, mentor, marketing
- **Bijlage-documenten**: [SYSTEEMKAART.md](SYSTEEMKAART.md) (Bijlage 3 = beschermde wanbetalers-zone; Bijlage 4 = softphone-extractie) · [INVENTARIS.md](INVENTARIS.md) (op branch `docs/redesign-inventaris-fase1`, PR #1111)

---

## 0. Werkwijze & harde regels (LEES EERST)

1. **Wanbetalers = beschermde zone.** Alleen het *uiterlijk* van de wanbetalers-schermen mag worden vervangen. NIETS aanraken aan: dunning-engine, crons, reminder-cirkel, Joost, workflows, verzendvenster, claim-locks, brieven, acties, endpoints. Elke wanbetalers-PR moet een **lege `git diff --stat`** tonen over de beschermde bestanden (zie Bijlage 3 van SYSTEEMKAART.md).
2. **Bouw voort op wat er is** — niet opnieuw vanaf nul. Bestaande klanten-v2 (skeleton + design-tokens + lijst), gemergede PR's en de zes automation-motoren blijven staan.
3. **Softphone** wordt geëxtraheerd naar `modules/shared/klx-softphone.js` met publieke API (zie Bijlage 4 SYSTEEMKAART). Zowel rij-actie in lijsten als knop in dossiers.
4. **Eén systeem, één zijbalk** die zich vult op basis van rol. Dashboard is rolspecifiek; werkschermen zijn gedeeld. Geen aparte mentor-omgeving.
5. **Volgorde:** eerst fundament (design-tokens → app-shell/sidebar → auth/rollen/RLS), dan module voor module. Zie §9.
6. Werk per module in aparte PR's, klein en reviewbaar.

---

## 1. Architectuur / app-shell

Eén app-shell met:
- **Zijbalk** (links, 228px) die modules toont op basis van rol + groep. Mobiel: uitschuifmenu.
- **Topbar**: kruimelpad, globale zoekbalk (⌘K), mobiele menuknop.
- **Tab-balk** per module (alleen tonen als >1 zichtbare tab).
- **Content** (scrollbaar).
- **Zijpaneel** (rechts, 520px) voor detail-weergaven — lijst blijft zichtbaar. ↑↓ bladert door de lijst, Esc sluit.
- **Modals** (van onderen op mobiel).
- **Donkere modus** met expliciete schakelaar (localStorage; géén systeemvoorkeur).

Navigatiepatronen (uit prototype): filters en scrollpositie bewaren per tab; zijpaneel voor details; volledige pagina voor dossiers; mobiel: tweeluiken gestapeld, tabellen horizontaal scrollbaar, `.optional`-kolommen verdwijnen, vensters komen van onderen.

**Technisch fundament (kritisch — moet vroeg staan):**
- Layout-hoogte op `100dvh` (niet `100vh`) zodat content niet achter de mobiele browserbalk valt; onderaan scroll `padding-bottom: calc(28px + env(safe-area-inset-bottom))`. Fix-gefixeerde balken (paneelvoet, belwidget, bulkbar) krijgen `env(safe-area-inset-bottom)`-clearance. (Dit was een concrete bug-fix in het prototype.)
- Custom inline grid-layouts stapelen op mobiel (≤760px). Zie prototype `@media`-blokken.

---

## 2. Rollen & rechten (autoritatief)

Vijf rollen: `super_admin`, `manager`, `sales`, `mentor`, `marketing`.

Afkortingen: **A** = allen · **SA** = super_admin · **SAM** = super_admin+manager · **SAMS** = +sales · **SAMSM** = +sales+mentor · **SAMMK** = super_admin+manager+marketing.

### 2.1 Zichtbare modules per rol (bron: prototype `MODS`)

| Groep | Module (id) | Rollen | Tabs |
|---|---|---|---|
| Overzicht | Dashboard (`dashboard`) | A | Vandaag (rolspecifiek) |
| Overzicht | Inbox (`inbox`) | SAMS | — (sales: **vergrendeld**, zie 2.3) |
| Overzicht | Takenbeheer (`taken`) | A | Mijn taken · Team · Afgerond |
| Klanten & comm. | Klanten (`klanten`) | SAMS | Overzicht (+ dossier) |
| Klanten & comm. | Studenten (`studenten`) | mentor | — (mentor-students) |
| Klanten & comm. | Wanbetalers (`wanbetalers`) | SAM | Gesprekken · Acties · Overzicht · Brieven — **BESCHERMD** |
| Klanten & comm. | E-mail (`email`) | SAMS | — (sales: **vergrendeld**) |
| Klanten & comm. | Tickets (`tickets`) | SAMSM | Open · Wacht op klant · Afgehandeld |
| Klanten & comm. | Follow-up (`followup`) | SAMS | Werklijst · Event-bellijst · Opvolglijst · Retenties · Afspraken · Sluimerpot · Statistieken · Afgeboekt |
| Verkoop & Fin. | Sales (`sales`) | SAMSM | Dashboard · Offertes · Retentie¹ · Verkoopprestaties¹ |
| Verkoop & Fin. | Finance (`finance`) | SAMS | Dashboard · Facturen · Abonnementen · Creditnota's · Bank² · Omzet & MRR² |
| Verkoop & Fin. | Mijn verdiensten (`verdiensten`) | mentor | Overzicht · Uitbetalingen · Reiskosten · Certificaten |
| Leren & Events | LMS (`lms`) | SA+manager+mentor | externe link |
| Leren & Events | Events (`events`) | SAMSM | Overzicht · Inbox³ · Inschrijvingen³ · Mentor-grootboek³ |
| Leren & Events | Onboarding (`onboarding`) | SAMSM | Actief · Inbox⁴ · Archief⁴ |
| Leren & Events | Mentoren (`mentoren`) | SAM | Overzicht · Grootboek · Uitbetalingen · Beoordelingen · Certificaten · Signalen |
| Groei | Leads (`leads`) | SAMMK+sales | Actief · Gearchiveerd |
| Groei | Nieuwsbrief (`nieuwsbrief`) | marketing | — |
| Groei | Leadsonderhoud (`leadsonderhoud`) | SAMS | Inbox · Contacten · Bulk versturen · Statistieken |
| Groei | Lisa — Instagram (`lisa`) | SAM | Dashboard · Gesprekken · Statistieken |
| Operatie | Automatiseringen (`automatiseringen`) | SAM | Overzicht · Events · Onboarding · Leadsonderhoud · Wanbetalers⁵ · Lisa |
| Operatie | AI Agents (`agents`) | SAM | Overzicht · Configuratie · Kennisbank · Prestaties |
| Operatie | Toegangslog (`logboek`) | SAM | Activiteit · Per gebruiker |
| Systeem | Instellingen (`instellingen`) | SAM | 9 categorieën |
| Systeem | Binnenkort (`binnenkort`) | SAM | Nieuwsbrief · Enquêtes · Meta Ads · Creative Studio · Kennisbank · Control Center · Secret Area · Vergaderruimte · Simon/Leon/Aron |

### 2.2 Rol-beperkte tabs (`TAB_RESTRICT` — verberg tab voor overige rollen)
- ¹ `sales/Retentie`, `sales/Verkoopprestaties` → alleen SAMS (mentor niet).
- ² `finance/Bank`, `finance/Omzet & MRR` → alleen SAM (sales niet).
- ³ `events/Inbox`, `events/Inschrijvingen`, `events/Mentor-grootboek` → alleen SAM (mentor ziet Events **read-only**, alleen Overzicht; geen aanmaak/afrond-acties).
- ⁴ `onboarding/Inbox`, `onboarding/Archief` → alleen SAMS (mentor ziet alleen Actief = eigen toegewezen studenten).
- ⁵ Wanbetalers-tab in Automatiseringen is **alleen-lezen**.

### 2.3 Vergrendelde modules (`MOD_LOCK` — zichtbaar maar "binnenkort beschikbaar")
- `inbox` en `email` zijn voor **sales** vergrendeld: staan in het menu (met slot-icoon, geen badge) maar tonen een "binnenkort beschikbaar"-scherm. Dit is bewust: sales moet nog niet bij alle e-mailadressen/centrale inbox.

### 2.4 Handhaving (belangrijk)
- **UI-gating** (welke modules/tabs render je) + **RLS in Supabase** (wat mag een rol echt lezen/schrijven). UI-gating alleen is niet genoeg.
- Rollen additief voorzien: architectuur moet toelaten dat iemand later een tweede rol krijgt (bv. mentor **én** marketing) en dan de modules van beide rollen ziet. Modelleer rollen als many-to-many (`user_roles`), niet als één kolom.
- Mentor-toewijzing gebeurt in **Onboarding**, niet in Mentoren.
- Toegangslog logt *wie welke handeling mocht uitvoeren* (RBAC-audit). Inhoudelijke wijzigingen staan in de dossiers zelf.

---

## 3. Design system

**Fonts:** IBM Plex Sans (tekst) + IBM Plex Mono (cijfers/bedragen/codes).
**Radii:** `--r:10px`, `--r-sm:7px`, `--r-lg:14px`. **Sidebar 228px, paneel 520px.**

**Kleur per module (accent `--m`):** Sales=violet, Finance=blauw, Wanbetalers=amber, Klanten=emerald, Events=roze, Lisa=violet, Leadsonderhoud=teal, Tickets=rose, Mentoren=violet, Onboarding=emerald, Dashboard=blauw, Verdiensten/Nieuwsbrief=teal/blauw.

**Tokens (light):** neem exact over uit prototype `:root` — o.a. `--blue #1B5FBF`, `--violet #6D3FD4`, `--amber #C2700A`, `--rose #C22B3E`, `--emerald #07835A`, `--teal #0A7490`, `--pink #B32B72`, `--slate #455367`, elk met `-soft` en `-line` varianten. **Dark** volledig gedefinieerd in `[data-theme="dark"]` — overnemen.

**Herbruikbare componenten (definities staan in prototype):**
- `kpi` / `kpi-grid` (KPI-tegels met icoon, waarde, trend, sparkline)
- `card` / `card-head` / `card-body`, `dashCard(title,dotColor,body)`
- `pill` (varianten ok/warn/danger/neutral/accent/violet/teal/pink)
- `table(cols,rows,onclick)` met `.optional`-kolommen (verbergen op mobiel) en `.r` (rechts uitlijnen)
- `toolbar`, `chips` (filters), `search`
- Zijpaneel: `openPanel(title,sub,body,foot)`, secties `.sect`/`.kv`/`.hero-amount`/`.timeline`
- Modals: `.mdl`/`.mdl-box`/`.mdl-head/body/foot`
- `switch` (toggle), `radio-b` (segmented), `progress`, `hbar`, `funnel`, `targetGauge`, `areaChart`, `dualChart`
- Bijlage-component (thumbnails, echte file-picker → afbeelding-preview / video-icoon)
- Softphone-bar / callbar

**Responsief:** class-gebaseerde grids stapelen via media-queries; custom inline-grids expliciet overschrijven ≤760px. Tabellen horizontaal scrollbaar. Zie prototype voor de exacte regels (die zijn getest, geen horizontale overflow op 360/390px).

---

## 4. Datamodel (Supabase — afgeleid uit prototype-data)

Kernentiteiten en belangrijkste velden. Gebruik de prototype-data-arrays als veld-referentie. FK = foreign key.

- **users** (auth.users gekoppeld) + **user_roles** (user_id, role) — many-to-many.
- **entiteiten**: DFO / DFO BE (naam, adres, rekeningnr, btw).
- **klanten**: naam, type(particulier/bedrijf), contact, mail, tel, btw, entity_id, mentor_id(FK users), risk, klant_sinds.
- **trajecten** (producten): naam, duur, prijs, termijnen, actief_count.
- **offertes**: nr, klant_id, traject_id, totaal, status(concept/verzonden/geaccepteerd/afgewezen), datum, verkoper_id(FK), is_abo.
- **abonnementen**: klant_id, plan/traject_id, mrr, start, termijn, status(actief/achterstand/gepauzeerd).
- **facturen**: nr, klant_id, entity_id, bedrag, open, datum, verval, dagen_te_laat, status(overdue/open/paid/partial/arrangement). *(Beschermde zone raakt aan aanmaningen — alléén lezen/uiterlijk.)*
- **creditnotas**, **betalingen** (Mollie: bedrag, datum, methode, factuur_id).
- **leads**: naam, bron(Meta/Event/Website/Instagram), datum, status(nieuw/in behandeling/gekwalificeerd/verloren), tel, traject, eigenaar_id.
- **tickets**: nr, klant_id, onderwerp, prio(hoog/midden/laag), status(open/wacht/afgehandeld), wachttijd, toegewezen_id, opgelost_op, oplostijd.
- **taken**: titel, omschrijving, bron(afdeling), klant_id?, deadline, prio, status(todo/bezig/klaar), eigenaar_id(FK), created_by. **taak_volgers** (taak_id, user_id) = CC/watchers. **taak_bijlagen** (taak_id, type(afbeelding/video), naam, storage_url).
- **events**: naam, datum, tijd, locatie, capaciteit, status(concept/gepubliceerd/afgerond/geannuleerd), niveau, kosten. **event_inschrijvingen** (event_id, klant/lead_id, status(aangemeld/aanwezig/no_show/afgemeld), vragenlijst_ingevuld, uitkomst(opvolgen/sale/geen_interesse), gekoppelde_offerte_id).
- **onboarding**: klant_id, traject, fase, betaald(bool), bedenktijd(loopt/verstreken+datum), lms_account(bool), mentor_id, beschikbaarheid, startdatum, pijplijn-status.
- **mentoren**: user_id, beschikbaar, status(actief/inactief), **reiskosten(bool)**, **dagbedrag(int, € per rijdag)**.
- **mentor_sessies**: mentor_id, student_id, datum, type(1-op-1/groep/intake), status.
- **mentor_uitbetalingen**: mentor_id, maand, sessies, sessievergoeding, bonus, **rijdagen(int, nullable)**, status(open/uitbetaald). Reiskosten = `rijdagen × mentoren.dagbedrag`.
- **mentor_certificaten**: mentor_id, naam, uitgever, datum, bestand_url, status(ingediend/goedgekeurd/afgewezen). Bonus = **€100 per goedgekeurd** certificaat.
- **student_voortgang**: student_id, lms_module_id, voortgang%. **lms_modules**: naam, lessen, gem_voortgang.
- **wa_templates**: naam, map/categorie(wanbetalers/onboarding/events/sales/lisa/algemeen), taal(NL/EN/FR), status(concept/in_review/goedgekeurd/afgewezen), tekst(met `{{variabelen}}`), gebruikt_count, waba_template_id.
- **gesprekken/berichten**: klant/lead_id, kanaal(WhatsApp/email/instagram), richting, tekst, tijd, ongelezen, bron-lijn.
- **campagnes** (marketing): naam, budget, besteed, leads, cpl, status.
- **nieuwsbrieven**: onderwerp, verzonden_op, ontvangers, open_rate, klik_rate, status.
- **social_stats**: kanaal, volgers, groei, bereik.
- **toegangslog**: user_id, actie, entiteit, tijd (RBAC-audit).
- **instellingen**: per categorie (zie §5 Instellingen).

RLS-principe: rij-eigenaarschap + rol. Bv. mentor ziet alleen eigen studenten/uitbetalingen/certificaten; sales ziet offertes/leads (eigen + team afhankelijk van beleid); finance-detail alleen SAM.

---

## 5. Modules — bouwnotities

Per module: doel · tabs/schermen · data · interacties. Uiterlijk = prototype.

- **Dashboard (rolspecifiek).** Vier varianten: manager/super_admin (bedrijfsbreed: leads per traject, AI Manager, omzet, "vereist actie", postvakken — actie/postvak-items **filteren op modules die de rol mag openen**), sales (persoonlijk), mentor (agenda, aandacht-leerlingen, voortgang, + **onboarding-sectie** met nieuw toegewezen studenten, + **reiskosten-herinnering** als rijdagen-aanvraag openstaat), marketing (kanaalstats + postplanner-preview). Sales krijgt het *brede* dashboard, sales-proof (dode links weggefilterd).
- **Takenbeheer (NIEUW t.o.v. oud).** Lijsten Mijn taken / Team / Afgerond met statuspill (Te doen/Bezig/Klaar), betrokkenen-avatarstack, klikbare rijen → **detailpaneel** (status-flow, betrokkenen, koppeling klant/bron, bijlagen, activiteit). **Nieuwe-taak-modal**: titel, omschrijving, verantwoordelijke, **CC-volgers**, deadline, prioriteit, bron, klant, **bijlagen (afbeelding/video, echte upload)**. Filter "Ik volg (CC)".
- **Klanten** + dossier (7 tabs: Overzicht/Facturen/Abonnementen/Offertes/Communicatie/Onboarding/Notities). Softphone-actie in rij en dossier.
- **Wanbetalers** — **BESCHERMD**. Alleen re-skin naar de prototype-look; engine/flows/endpoints onaangeroerd (lege diff-stat op beschermde bestanden).
- **E-mail** — 3-koloms (mappen · lijst · leesvenster). Sales: vergrendeld.
- **Tickets** — Open/Wacht op klant/Afgehandeld (KPI's, filters, lijst, statuspills). Mentor mag zien + aanmaken.
- **Follow-up** — cockpit met twee bewust níet-geconsolideerde outcome-motoren; werklijst, event-bellijst, retenties, sluimerpot, uitkomst-paneel.
- **Sales** — Dashboard (uniek: **verkooptrechter/funnel**, omzet-vs-target, conversie per bron, verkopers-leaderboard; rol-bewust: sales/mentor zien focus-versie), Offertes, Retentie, Verkoopprestaties.
- **Finance** — Dashboard (uniek: **MRR + churn**, cashflow, **openstaand ouderdomsanalyse (aging 0–30/30–60/60–90/90+)**, betaalstatus, actieve trajecten; sales ziet afgeschermde focus-versie zonder bank/cashflow/MRR), Facturen, Abonnementen, Creditnota's, Bank(SAM), Omzet & MRR(SAM).
- **Mijn verdiensten (mentor, NIEUW).** Overzicht (opbouw sessievergoeding/bonussen/reiskosten, volgende uitbetaling, grafiek). Uitbetalingen (historie). **Reiskosten (dag-model)**: mentor krijgt — als reiskosten voor hem aanstaat — rond de eerste vrijdag van de nieuwe maand automatisch de vraag *"hoeveel dagen heb je vorige maand gereden?"*; invoer × vast bedrag/dag → in uitbetaling. Certificaten (upload → €100 bonus per goedgekeurd).
- **Studenten (mentor, NIEUW = mentor-students).** Lijst met voortgang/sessies/status → detailpaneel (voortgang per module, sessies, contact, notitie).
- **Events** — Overzicht/Inbox/Inschrijvingen/Mentor-grootboek + eventdetail (Info/Aanwezigen/Mentoren/Audit + afrond-venster met aanwezigheid→opvolging→bonus/uitgaven). Twee inboxen (WhatsApp-gesprekken + inschrijvingen zonder match). Mentor: read-only Overzicht.
- **Onboarding** — Actief/Inbox/Archief; **mentor-toewijzing** gebeurt hier. Mentor ziet eigen toegewezen nieuwe studenten (Actief).
- **Mentoren (admin)** — Overzicht met **per-mentor reiskosten aan/uit + bedrag/dag toggle**, Grootboek, Uitbetalingen, Beoordelingen (maandelijks per leerling), **Certificaten** (bekijken/goedkeuren/**downloaden**), Signalen.
- **Leads / Leadsonderhoud** — let op: leadsonderhoud valt terug op de onboarding-WhatsApp-lijn; de cron doet dat niet → berichten falen stil (bekende bug om te fixen).
- **Lisa — Instagram** — Dashboard/Gesprekken/Statistieken + config (persona/fases/do's&don'ts/kennisbank/follow-ups/stopwoorden/instellingen/oefengesprek). Let op: `lisa_qualification`/`lisa_stats` worden nooit geschreven (dode tabellen — opruimen of vullen).
- **AI Agents** — Overzicht/Configuratie/Kennisbank/Prestaties incl. autonomie-standen, beslissingslogboek, concept/publiceer-flow. Joost = beschermd (wijzigen in Wanbetalers).
- **Automatiseringen** — verzamelplek/aggregator, geen nieuwe motor. Zes bestaande motoren blijven draaien; Wanbetalers-tab alleen-lezen.
- **Marketing (rolpagina, preview).** Dashboard met kanaalstats (YouTube/Meta/TikTok/Google/LinkedIn), postplanner-preview, creatives, campagnes + "in opbouw"-banner. **Nieuwsbrief**-module. Volledige postplanner/Creative Studio/live-stats = later.
- **Toegangslog** — Activiteit / Per gebruiker (RBAC-audit).
- **Instellingen** — 9 categorieën (Verkoop, Financieel, Wanbetalers, AI Agents, Events & Leren, **Communicatie**, Marketing, Team & toegang, Algemeen). Onder **Communicatie → WhatsApp**: het volledige **WhatsApp-templatebeheer** (mappen/categorieën, zoeken, statusfilter, WhatsApp-preview met gemarkeerde variabelen, template-editor met variabele-chips + live preview; nieuwe/gewijzigde templates → "ter goedkeuring naar Meta"/WABA). WhatsApp-templates + WABA-verbindingen verhuizen hierheen.
- **Binnenkort** — kaartenlijst: **Nieuwsbrief, Enquêtes**, Meta Ads, Creative Studio, Kennisbank, Control Center, Secret Area, Vergaderruimte, Simon/Leon/Aron.

---

## 6. Integraties (het meeste werk zit hier)
- **WhatsApp/WABA (Meta)** — templates (goedkeuringsstatus), verzending, inbox-gesprekken. Bekende bugs: WA template-variabelen tonen als `{{klant.voornaam}}` i.p.v. ingevuld; emoji-reactie als ruwe JSON (Muno).
- **Mollie** — betalingen/matching.
- **Teamleader** — B2B bedrijf + contactpersoon, BTW-normalisatie vóór push, klanten/offertes/facturen-sync.
- **Bubble-mirror** — mentor-toewijzing kent twee waarheden (`onboardings.mentor_user_id` + Bubble) → consolideren.
- **Voys** — telefonie/softphone.
- **Meta Ads / socials** — marketing (later).
- **E-mail** — accounts uitlezen, bijlagen-backfill (endpoint `/api/backfill-email-attachments` bestaat).

---

## 7. Nieuw of gewijzigd t.o.v. het oude systeem (bouwen)
1. Unified app-shell + rol-gestuurde zijbalk + design system + **dark mode** + **mobiel responsive** (100dvh, safe-area, grid-stacking).
2. Rol-bewuste dashboards (4 varianten) + sales-proof filtering.
3. Sales-rol afbakening; Inbox/E-mail vergrendeld ("binnenkort") voor sales; Finance actief voor sales **zonder** Bank/MRR.
4. Takenbeheer-overhaul: status-flow, **CC-volgers**, **bijlagen**, detailpaneel, aanmaakmodal.
5. Unieke Sales- en Finance-dashboards (rol-bewust).
6. Mentor-rol compleet: **Studenten**, **Mijn verdiensten** (dag-model reiskosten + per-mentor toggle, certificaten €100 bonus), mentor-onboarding, read-only Events, sales/offertes.
7. **Certificaten-flow** (mentor upload → €100 bonus; admin bekijken/goedkeuren/downloaden).
8. **WhatsApp-templatebeheer** onder Instellingen (mappen + editor + WABA-statuses).
9. Marketing-rolpagina + Nieuwsbrief; Binnenkort-items (Nieuwsbrief, Enquêtes).
10. Lisa hernoemd naar **Lisa — Instagram**.
11. Additief rollenmodel (`user_roles`) zodat marketing bovenop een bestaande rol kan.

---

## 8. Bekende bugs / open punten (uit overdracht — meenemen)
- Engine-fix: `dunning-engine.js` schrijft bij `paused_customer_replied` geen `paused_by_conversation_id`.
- 25 onzichtbare dunning-runs koppelen (2 bewust uitgesloten: Benjamin Vermeeren, Ingrid Van Den Eede).
- Reminder-cirkel bug (eigen reminder blokkeert volgende).
- Reactie-bug Muno (WhatsApp emoji-reactie als ruwe JSON); emoji-kiezer.
- E-mailbijlagen backfill.
- WA template-variabelen invullen in inbox.
- Intent-keys consolideren (canoniek = `joost-suggest-core.js DETECTED_INTENTS`).
- Dubbeltelling "Open acties" vs "Goedkeuringen" in centrale inbox.
- Leadsonderhoud-cron valt stil op onboarding-WhatsApp-lijn.
- Lisa dode tabellen (`lisa_qualification`, `lisa_stats`).

---

## 9. Gefaseerde uitrol (voorstel)

**Fase 0 — Fundament.** Design-tokens (klanten-v2 heeft die al) → app-shell + zijbalk + topbar + paneel + modal + dark mode + mobiel (100dvh/safe-area). Auth + `user_roles` + RLS-basis + UI-gating.
**Fase 1 — Klanten-v2 afmaken** (dossier + 7 tabs + modals) en Takenbeheer (nieuw model, CC, bijlagen). Beide zijn "veilige" nieuwe modules.
**Fase 2 — Sales & Finance** (offertes, facturen, dashboards) + rol-afbakening sales.
**Fase 3 — Mentor-rol** compleet (Studenten, Verdiensten/reiskosten dag-model, Certificaten, onboarding-view).
**Fase 4 — Events & Onboarding** (detail, afrond-venster, mentor-toewijzing) + Mentoren-admin (reiskosten-toggle, certificaten-download).
**Fase 5 — Wanbetalers RE-SKIN** (alleen uiterlijk, lege diff-stat op beschermde bestanden), Lisa/Agents, Automatiseringen-aggregator.
**Fase 6 — Instellingen** incl. WhatsApp-templatebeheer; Marketing-pagina + Nieuwsbrief; Toegangslog.
**Fase 7 — Integraties aanscherpen** + bekende bugs (§8).

**Per PR:** klein, met screenshots vóór/na, en voor wanbetalers-PR's een lege `git diff --stat` over de beschermde bestanden als bewijs.

---

## 10. Definition of done (per module)
- Uiterlijk matcht het prototype (licht + donker, desktop + mobiel; geen horizontale overflow op 360/390px).
- Echte Supabase-data i.p.v. mock; RLS afdwingt wat de rol mag.
- Rol-gating klopt met §2 (modules, tabs, vergrendelingen).
- Interacties werken (paneel ↑↓/Esc, modals, filters/scroll bewaard per tab).
- Geen regressie op beschermde zones (lege diff-stat waar vereist).
