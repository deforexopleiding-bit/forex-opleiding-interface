# Ontwerp: mini-cursus-rollensysteem (gebruiker↔product, many-to-many)

Status: **ontwerp / ter review — nog niets gebouwd of gedraaid.**
Fase 0 als concrete migratie-SQL: `docs/sql-migrations/2026-08-01-lms-producten-fase0.sql`.

## Bevestigde uitgangspunten
- **Many-to-many:** meerdere producten per gebruiker (bv. 7-daagse + mini-cursus tegelijk).
- **Eigen funnel** per product. Vragenlijst mini-cursus = **kopie van de 7-daagse** onder eigen slug `minicursus`, met **vraag 2 herschreven** naar de mini-cursus, **drempel 13**, afwijzers gelijk (zie §5).
- **Tijdelijke toegang met vervaldatum.** Mini-cursus = **14 dagen** (`grant.toegang_tot = toegang_van + 14d`).
- **Eigen berichtenreeks** per product (welkom + herinneringen).
- **Product-bewuste sidebar:** een "Mini cursus"-link die alleen verschijnt bij een actieve mini-cursus-grant.
- **Eigen desk-pagina** voor de mini-cursus in de stijl van de bestaande studydesk (layout hergebruiken, eigen content-pool).
- **Default landing** afhankelijk van hoeveel producten iemand heeft (zie §5).

## Uitgangssituatie (recon)
- **Content = één pool:** `lms_modules` → `lms_videos` (`module_id`, `soort`, `gratis`) + `lms_documenten`. De 7-daagse ziet de `gratis`-subset binnen het toegangsvenster; niet-gratis → slotscherm.
- **Toegang nu:** `lms_gebruikers.toegang_van/toegang_tot` (tijdvenster) + `gratis`-vlag. **Geen** product/traject-veld, **geen** gebruiker↔product-koppeling.
- **Slugs** (`7-daagse`, `minicursus`, `student`, `webinar`, `event`) leven in de funnel + motor (`onderhoud_trajecten`, `onderhoud_sjablonen.traject_slug`, `leads.traject/soort`, `website_quizzes.slug`), **niet** in de LMS-gating.
- **Quiz-laag** is al per slug (`website_quizzes` + `website_quiz_questions` + `website_quiz_publicaties`), dus per-product quizzes zijn haalbaar zonder nieuwe infra.
- **Motor** joint enkelvoudig op `leads.traject`; "dag"/dedup/één-per-dag gaan uit van één reeks per persoon.

---

## 1. Schema

### 1.1 `lms_producten`
| kolom | type | rol |
|---|---|---|
| id | uuid PK | |
| slug | text UNIQUE | `7-daagse`, `minicursus` |
| naam | text | "Mini cursus" |
| omschrijving | text | |
| is_trial | boolean | 7-daagse = true |
| duur_dagen | integer | 7 / 14 / NULL(onbeperkt) |
| quiz_slug | text | → `website_quizzes.slug` (geen FK) |
| desk_pad | text | eigen desk-route |
| nav_label | text | sidebar-label (NULL = geen aparte link) |
| volgorde | integer | ook default-landing-prioriteit |
| actief | boolean | |
| aangemaakt | timestamptz | |

### 1.2 `lms_toegang` — many-to-many grant (tijdelijk)
- FK's: `gebruiker_id` → `lms_gebruikers(id)` ON DELETE CASCADE; `product_id` → `lms_producten(id)` ON DELETE RESTRICT.
- `toegang_van`, `toegang_tot` (mini-cursus = van + 14d; NULL = onbeperkt), `bron`.
- **UNIQUE (gebruiker_id, product_id)** → `geefToegang` wordt een schone UPSERT (venster verversen, geen dubbele rijen).
- "Actief" = `toegang_van ≤ now() AND (toegang_tot IS NULL OR toegang_tot ≥ now())`.

### 1.3 Content ↔ product — junctions (op video/document-niveau)
De 7-daagse is een lessen-subset binnen gedeelde modules; de mini-cursus heeft z'n eigen pool → koppeling op item-niveau met echte FK's:
- `lms_product_videos (product_id, video_id)` PK(product_id, video_id)
- `lms_product_documenten (product_id, document_id)` PK(product_id, document_id)

7-daagse-product = de huidige `gratis`-videos; minicursus-product = z'n eigen (nieuwe) videos.

### 1.4 RLS
Alle 4 tabellen RLS aan, **geen anon-policy** (server leest via de service role, consistent met `lms_gebruikers`/`lms_videos`). Optioneel later een `anon SELECT`-policy op `lms_producten` voor een publieke productlijst.

---

## 2. LMS-gating: "gratis + venster" → "actieve grant"
Ontgrendelde items per gebruiker =
```
video's waarvoor EXISTS lms_toegang t
  JOIN lms_product_videos pv ON pv.product_id = t.product_id
 WHERE t.gebruiker_id = :g
   AND t.toegang_van ≤ now() AND (t.toegang_tot IS NULL OR t.toegang_tot ≥ now())
   AND pv.video_id = video.id
```
`lib/lms-brug.ts`/`lib/lms-data.ts` ontgrendelen (vimeo_id) exact die set. **Brug (fase 2):** geen grants → val terug op de oude `gratis + toegang_tot`-check (dual-path; 7-daagse blijft werken tot de backfill klaar is).

## 3. Navigatie, desk & default landing
- **Product-bewuste sidebar:** één nav-item per actief product met een grant (`nav_label` → `desk_pad`). "Mini cursus" verschijnt dus alleen bij een actieve mini-cursus-grant.
- **Eigen desk:** `/lms/minicursus` hergebruikt de studydesk-layout, gevuld met de content-pool van het product (via `lms_product_videos`). Eén generieke desk-render die op `product.slug`/`desk_pad` de juiste pool laadt — geen duplicaatcode.
- **Default landing bij meerdere producten (voorstel):**
  1. **0 actieve producten** → huidige "geen toegang/verlopen"-scherm.
  2. **1 actief product** → direct naar die desk.
  3. **≥2 actieve producten** → een lichte **product-kiezer/overzicht** (kaart per product, studydesk-stijl) als landing, plus **"onthoud mijn laatste keuze"** (bv. `lms_gebruikers.laatste_product_id`) zodat terugkerende gebruikers meteen naar hun laatst bezochte desk gaan. Een product-switcher blijft in de sidebar.
  - **Simpeler alternatief:** default = hoogste `lms_producten.volgorde` (geen extra scherm, minder flexibel).
  - **Aanbeveling:** kiezer + onthoud-laatste (schaalt bij meer producten).

## 4. Funnel + `geefToegang` als UPSERT
- Nieuwe mini-cursus-funnel op de website → `POST /api/lead` met expliciete **`product`/`slug`** (nu impliciet `body.soort`). Mapping `7-daagse→7-daagse`, `minicursus→minicursus`.
- `geefToegang` doet een **UPSERT op `lms_toegang (gebruiker_id, product_id)`**: bestaand → `toegang_tot` verversen (nieuwe 14 dagen); nieuw → aanmaken. **Product erbij, nooit het venster van een ander product overschrijven.**
- Backward-compat (fase 3): blijft voorlopig óók `lms_gebruikers.toegang_van/tot` schrijven (dual-write).

## 5. Quiz — mini-cursus-vragenlijst (BESLIST)
**Besluit:** de mini-cursus **neemt de 7-daagse-vragenlijst over** — een eigen kopie onder een **nieuwe slug `minicursus`**, met:
- **Vraag 2 herschreven naar de mini-cursus-context** (bv. "Waarom wil je de **mini-cursus** volgen?" i.p.v. "…de 7-daagse aanvragen?"), met dezelfde punten (3/2/1/0) en dezelfde afwijzer op de laatste optie. Exacte formulering wordt bij het bouwen vastgezet.
- **Drempel = 13** (gelijk aan de 7-daagse).
- **Afwijzers identiek** aan de 7-daagse (vraag 2 "snel geld…", vraag 3 "bijna geen tijd", vraag 4 "alleen gratis dingen", vraag 6 "snel en gegarandeerd geld").
- De overige 6 vragen + opties + punten worden **ongewijzigd** overgenomen.

Praktisch (fase 3): kopieer de actuele `website_quiz_publicaties`-inhoud van slug `7-daagse` naar een nieuwe `website_quizzes`-rij (slug `minicursus`, drempel 13) + `website_quiz_questions`, pas alleen de tekst van vraag 2 aan, en publiceer via de bestaande `website_quiz_publicaties`-laag. `lms_producten.quiz_slug = 'minicursus'` koppelt product→quiz. **Geen nieuwe quiz-infra.**

## 6. Motor: enkelvoudig traject → per-inschrijving (VOORZICHTIGSTE, LAATSTE fase)
- `onderhoud_trajecten` heeft al een `minicursus`-slug; voeg `onderhoud_stappen` toe voor de eigen reeks (welkom `na_start`=0 + herinneringen op dag N).
- Nieuwe `onderhoud_wachtrij`: **FROM `lms_toegang` JOIN `onderhoud_trajecten` ON slug = product.slug** i.p.v. `leads.traject`:
  - **Eigen dag-teller per inschrijving:** `dag = now() − lms_toegang.toegang_van`.
  - **Dedup per gebruiker×product×soort:** `berichten_log` krijgt een nullable **`product_id`**-kolom; dedup keyt op `(gebruiker_id, product_id, soort)`.
  - **Één-per-dag:** per (gebruiker, product); optioneel een zachte globale dagcap per persoon.
- Draait **achter een vlag, eerst in droogloop naast de oude view** (rollback = vlag uit).

---

## 7. Gefaseerd, backward-compatible migratieplan
Elke fase additief; de live 7-daagse blijft na elke fase werken; de motor-ombouw is laatst.

| Fase | Wat | 7-daagse werkt? | Risico |
|---|---|---|---|
| **0 — tabellen (leeg)** | `lms_producten` + `lms_toegang` + 2 junctions; seed `7-daagse`(trial,7d) + `minicursus`(14d). Niets leest ze. → **deze migratie-SQL** | ja | nihil |
| **1 — backfill** | Per `lms_gebruikers` → grant `7-daagse` uit huidige `toegang_van/tot`; junction vullen uit `gratis`. | ja | laag (data) |
| **2 — LMS leest grants (dual-path)** | `haalBron`/`lms-data` op grants, fallback op `gratis+venster`. Pariteit trial verifiëren. | ja | middel |
| **3 — minicursus-content + funnel + desk + nav** | Minicursus-content + junction; website-funnel + eigen quiz; `geefToegang` UPSERT (dual-write); product-bewuste sidebar + `/lms/minicursus`-desk + default-landing. | ja | middel |
| **4 — motor per-inschrijving** | `berichten_log.product_id`; wachtrij op `lms_toegang`; dedup per gebruiker×product×soort; minicursus-stappen. Achter vlag, eerst droogloop. | ja | hoog → laatst |
| **5 — opschonen** | Pas als alles op grants draait: `lms_videos.gratis` + `lms_gebruikers.toegang_van/tot` uitfaseren. | — | laag |

**Rollback:** fase 0-1 puur additief. Fase 2/3 hebben fallback/dual-write. Fase 4 draait naast de oude view achter een vlag. Niets destructief tot fase 5.

## Openstaande keuzes (voor review vóór latere fasen)
1. Default landing bij ≥2 producten: kiezer + "onthoud laatste" (voorstel) vs. `volgorde`-prioriteit.
2. `membership` nu al als product, of alleen `7-daagse` + `minicursus`.
3. Mini-cursus-content: eigen nieuwe pool (aangenomen) vs. gedeeld met de hoofdcursus.
4. Motor één-per-dag: per (gebruiker,product) vs. harde globale dagcap per persoon.
