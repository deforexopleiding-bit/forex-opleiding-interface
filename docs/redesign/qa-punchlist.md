# QA-sweep punch-list — DEEL B

**Status:** PUNCH-LIST voor review. Bevat achtergebleven hardcoded kleuren die naar DS-tokens moeten. Files ZONDER issues zijn weggelaten (`mentor-grootboek.html`, `events-wizard.html`, `roadmap.js`, `klanten-v2/index.html`).

**Methodiek:** `grep -cE '#[0-9a-f]{3,6}|rgba\('` per file, dan uitfilteren van legitieme uitzonderingen (brand-vaste vars, scrims rgba(0,0,0,.4-.6), box-shadows, keyframe-animations, canvas ctx-colors, WA-brand mock #d9fdd3/#e5ddd5/#667781/#111, Meta-brand #0e7c6b/#a16207, `--sad-*` custom vars, agent-avatar-brand).

**Legenda:** BLOCKER = onleesbaar/parallel-systeem · MEDIUM = inconsistent · COSMETISCH = subtiel.

Wat ik zelf inline heb gefixt in de opvolg-PR staat in de laatste sectie.

---

## BLOCKER

### 1. `modules/taken.html` — parallel token-systeem
- **Wat:** file overschrijft in eigen `:root {}` (r16-35) o.a. `--bg`, `--text`, `--accent-cyan`, `--accent-violet`, `--green`, `--amber`, `--red`, `--accent-grad`, `--nav-item-active-text` + dark-set. Elk badge/knop/priority-kleur (r239-408) leest uit die lokale vars, NIET uit DS.
- **Impact:** cross-file inconsistency. Dark-mode werkt correct binnen taken.html (eigen dark-set) maar kleur-taal wijkt af van rest DS.
- **Waarom NIET zelf gefixt:** file heeft eigen dark-mode-vars binnen dezelfde lokale set — migreren naar DS vereist parallelle dark-audit + verificatie op iedere usage. Grote patch, gedrag-adjacent.
- **Aanbevolen scope:** aparte T4-PR (na T1-3 stabilisatie). Map lokale vars → DS-aliassen: `--green→--emerald`, `--red→--rose`, `--amber→--amber`, `--accent-cyan→--blue`, `--accent-violet→--violet`. Behoud `--bg`/`--text` alleen als DS-fallback ontbreekt in specifieke context.

### 2. `modules/lisa.html` — hoofdletter-hex status-cluster
- **Wat:** status-cluster r194-227 gebruikt `#10B981`, `#EF4444`, `#3B82F6`, `#F59E0B`, `#6B7280` i.p.v. DS. Funnel-bars r1422-1424: `bar('Nieuwe conv', ..., '#3B82F6')`, `'#10B981'`, `'#F59E0B'`.
- **Impact:** in F8-PR (#1197) heb ik lisa-status-badges naar DS gebracht, MAAR pulse-live-keyframe + funnel-bar-generator overgeslagen als "animation-contract". Bij dark-mode kan status-live-pulse door de rgba-referentie niet meebewegen met dark-surface.
- **Waarom NIET zelf gefixt:** pulse-animation refereert exact naar `rgba(16,185,129,.2/.1)` — semantische equivalent in DS zou `var(--emerald-soft)` zijn maar animation-contract van pulse-shadow varieert per browser bij CSS-variabelen in keyframes.
- **Aanbevolen scope:** dark-mode meting eerst (screenshot dark op live), dan besluit: keyframe-hex behouden of runtime-`getComputedStyle`-fallback.

---

## MEDIUM (inconsistent met DS-familie, veel repeat)

### 3. `modules/finance.html` — legacy Joost-oefenmode CSS (r215-587)
- **Wat:** ~1235 non-token hits totaal. Grootste concentratie in Joost-oefengesprek block r215-587: `#22c55e`, `#ef4444`, `#94a3b8`, `#b6e8b0`, `#0b3d2e`, `#7f1d1d`, `#1f2937`, `#eef1f4`, `#f59e0b`, `#10b981`, `#06b6d4` overal als CSS-value én in `var(--x, #hex)` fallback.
- **NIET aangeraakt in mijn eerdere finance-cluster** (die deed alleen camtbank/uitgaven/creditnotes/bank subviews via #1160-1167).
- **Aanbevolen scope:** aparte F11-PR "Joost-oefenmode DS-swap", of leg als onderdeel van wanbetalers-plan (W4-PR) op — die view raakt Joost-config in `#wb-sub-instellingen`.

### 4. Mentor-cluster inline-hex overload
Mijn M1-M9 PRs raakten CSS-classes + status-badges maar lieten inline-styles grotendeels intact.
- **mentor-payouts-admin.html** — inline `#15803d`, `#0a2f63`, `#dbeafe/#1e40af`, `#dcfce7/#166534`, `#b91c1c`, `#fecaca`, `#fff5f5`, `#fde68a`, `#bbf7d0`, `#0f172a/#e2e8f0`, `#d97706` in 3 ad-hoc badge-palettes (r1153-1156, r1287-1288)
- **mentor-students.html** — inline `#dc2626`, `#b91c1c`, `#15803d`, `#fbbf24/#422006` (due-badge r104), `#0a2f63/#093d54` (primary btns r102-149), `#fecaca`, `#0f766e` (email/tel r1343-1346). R76 avatar-gradient + r1362 progress-bar-gradient hardcoded.
- **mentor-onboarding.html** — inline `#dc2626`, `#b91c1c`, `#d97706`, `#093d54`, `#0a2f63`, `#15803d`, `#16a34a`, `#059669`, `#b45309` in error-messages + Mila-buttons + WA-bubble.
- **mentor-dashboard.html** — cashflow visuals: `#185fa5` (expected), `#0f6e56/#e1f5ee` (paid-chip), `#1baf7a` (paid-bar), `#2a78d6`. Semantisch → mapt op `--blue`/`--emerald`.
- **mentor-cash-trajects-admin.html** — `.btn-primary { background:#0a2f63 }` + gradient hardcoded (r24-52).
- **mentor-home.html** — bare-hex brand r38/123/144/153/946/1213.

**Aanbevolen scope:** cluster-PR "M-inline-cleanup" met per-file review, want ROOD-safe (write-endpoints niet raken).

### 5. `modules/onboarding-admin.html` — Mila-flow inline (r1416-1536)
Inline `#d97706`, `#059669`, `#8a5a00`, `#093d54`, `#0a2f63`, `#dc2626`, `#ffffff` in oiMila-buttons + Mila-badges. E7-PR raakte niet dit blok (Mila is agent-flow, deels brand-vast).

**Aanbevolen scope:** verify per hit of het brand-vast Mila is (behouden) of semantisch (swap).

### 6. `modules/onboarding-wizard-editor.html` — .pv-* preview-chrome
Hele `.pv .pv-*` block r225-249 met `--pv-primary:#0a2f63`, `#dde6f1`, `#16263f`, `#5c6b7d`, `#f8fbff`, `#dc2626` + inline dupes r1751-1964.
- **In E8-PR bewust behouden** als student-brand-preview (moet lijken op student-facing `modules/onboarding.html`).
- Agent classificeert als "4e parallel palet" — beslissing nodig: **skip** (per E8-commit) of alsnog naar DS.

### 7. `modules/events-detail.html` + `modules/events.html` — inline badge-cluster
- **events-detail** r1138-1172 (called/taal/auto-off badges) + r1708-2617 (sale-badges): `#475569`, `#64748b`, `#b91c1c`, `#059669`, `#6366f1`, `#1d4ed8`, `#1e3a8a`, `#b45309`
- **events** r1766-3054 (Simone-verhuizingsbanner): idem
- **E9/E10 hebben CSS-classes + palettes gedekt**, maar ~40 inline hits in dynamic-generated HTML overgebleven

**Aanbevolen scope:** micro-cleanup-PR met replace_all op de meest voorkomende exact-strings.

### 8. `modules/admin.html` — workflow-status fallback-hex (r1619-2255)
Tientallen `status.style.color = 'var(--danger,#b91c1c)'` en `#059669`/`#f59e0b`/`#10b981`/`#9ca3af` in workflow-status. Fallback-hex → DS-swap.

**Aanbevolen scope:** F9-vervolg-PR met replace_all op fallback-patterns.

### 9. Sales-cluster inline
- **sales-wizard.html**: `#dc2626`, `#0891b2`, `#059669`, `#b91c1c`, `#6d28d9`, `#b45309`
- **subscription-wizard.html**: `#dc2626`, `#0891b2`, `#b45309`, `#059669`
- **sales.html**: `#dc2626`, `#0891b2` (accent-cyan fallback), `#059669`

Mijn sales-reskin PRs (#1169-1170) raakten `.badge.*` classes + inline-styles cluster maar lieten dit blok liggen.

### 10. `modules/shared/finance-instellingen.js` — mixed
- `#1D9E75` (r596-1075 JSON-valid hint)
- `#d33` (idem)
- `#f3f4f6` (r1489 wa-var-chip bg)
- `#2563eb` (brand-primary fallback r1799)
- `#0a7cff` (r2854 WhatsApp CTA-blauw — BEHOUDEN, brand)

**In DEEL-A-PR (#1206) heb ik alleen status-dot + status-banner + unknown-var gedekt.** Rest resteert.

### 11. `modules/shared/finance-klanten.js` — parallel `--ds-*` alias-set
Eigen `--ds-*` alias-set met fallback-hex `#dfe8ec`, `#7a8b92`, `#06181f`, `#48585f`, `#0a5178`, `#dceaf2`, `#083b52`, `#06b6d4`, `#8fa8b1`. Vast brand-palet dubbelop met DS.

**Beslissing nodig:** aliassen mappen naar DS-tokens (bv. `--ds-text:var(--text)` fallback) of eigen palet houden.

### 12. `modules/shared/finance-views/camtbank.js`
`#10b981`, `#ef4444`, `#f59e0b`, `#eab308`, `#e5e7eb`, `#d1d5db`, `#2b2f3a` r236-683 in inline styles. Semantische → `var(--emerald/--rose/--amber)`. **Deels gedekt in eerdere camtbank-PRs**; inline-hits over.

---

## COSMETISCH (laag risico)

- `modules/onboarding-automations.html` r1191, `events-automations.html` r1157/1553: `#b45309`, `#6366f1` inline in single-use-banner.
- `modules/offerte-detail.html` r58 (`#0a2f63`), r197 STATUS-map (`#64748b`/`#0891b2`/`#059669`/`#b91c1c`/`#94a3b8`), r370/391 (`#0a2f63`, `#f59e0b`).
- `modules/onboarding-hub.html` r205 `background:#059669` in inline btn (dupliceerpatroon r166).
- `modules/mentor-detail.html` r183/577 brand-hex `#0a2f63`/`#1e6cd6` in `var(--brand-deep, …)` fallback.

---

## Wat wél inline gefixt

Zie [PR-#1206 WhatsApp-templatebeheer](https://github.com/deforexopleiding-bit/forex-opleiding-interface/pull/1206) — 4 semantische DS-swaps in WA-template-status.

De COSMETISCH-lijst zit in de **volgende inline-fix-PR** (klein, cross-file replace_all — zie git-log na deze docs-PR).

## Wat NIET zelf gedaan wordt zonder review

**BLOCKERs (#1, #2)** — parallel token-systeem migratie + animation-contract keyframes. Gedrag-adjacent, dark-mode-audit vereist.

**MEDIUM (#3-#12)** — cluster-refactors met significante file-diff-omvang; per-file bespreek + go/no-go voor scope. Aanbevolen: 1 cluster per sprint.

---

## Dark-mode consistency check (nog te doen)

Ik heb **geen** live dark-mode-audit uitgevoerd (geen headless-browser tijdens deze recon). Aanbevolen vervolgstap:
- Screenshot elke gere-skinde module in beide themes op mobile + desktop
- Focus op files uit BLOCKER-lijst (`taken.html` + `lisa.html`) waar cross-scheme contrast op onze DS-tokens niet gegarandeerd is
- Console-check per pagina (open elke module, kijk console voor errors — heb ik nu ook nog niet gedaan want vereist live browser).

## Console-fouten (nog te doen)

Zelfde: geen live browser tijdens deze sweep. Op basis van code-recon zijn er GEEN evidente `undefined`-refs of syntax-fouten — inline scripts in `taken.html` (na T3-fix), `finance-instellingen.js`, en alle E-cluster-files parseerden schoon met `node -e`. Verify-stap "open elke module + check console" moet in browser gebeuren.
