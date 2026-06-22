// api/_lib/onboarding-wizard-default.js
//
// Default (en momenteel: enige) wizard-structuur voor de publieke
// onboarding-flow. Wordt geserveerd door /api/onboarding-wizard-get en
// gevalideerd door /api/onboarding-complete.
//
// Block-schema:
//   - Elk blok heeft een stabiele id (string) en type.
//   - Info-blokken (paragraph / heading) hebben geen `key` en worden
//     genegeerd door de required-validatie.
//   - Veld-blokken hebben minstens { key, label, required(bool), help? }
//     plus type-specifieke config:
//       single_choice / multi_choice / select → options:[{value,label}]
//       scale                                  → { min, max }   (default 1..10)
//       number                                 → { min?, max? }
//       consent                                → { label, required }
//       file_download                          → { label, files:[{name,url}],
//                                                  requires_consent:bool,
//                                                  consent_label?, consent_key? }
//
// Validatie-helper `validateRequired(answers)` returnt { ok, missing[] }.
// missing[] bevat de answer-keys die ontbreken — voor consent op
// file_download is dat `consent_key`, voor overige veld-blokken `key`.

export const DEFAULT_WIZARD_STRUCTURE = {
  version: 1,
  pages: [
    // ───────────────────────────── 1. Welkom
    {
      id: 'welkom',
      title: 'Welkom',
      blocks: [
        { id: 'wlk_p1', type: 'heading',   text: 'Welkom bij De Forex Opleiding' },
        { id: 'wlk_p2', type: 'paragraph', text: 'Fijn dat je erbij bent. We helpen je in de komende periode stap voor stap een professionele trader te worden — met persoonlijke begeleiding, een community en een vast curriculum.' },
        { id: 'wlk_p3', type: 'paragraph', text: 'Deze korte vragenlijst (ca. 5 minuten) helpt je mentor je traject persoonlijk te maken. Je kunt tussendoor stoppen en later verder gaan via dezelfde link.' },
      ],
    },

    // ───────────────────────────── 2. Intake
    {
      id: 'intake',
      title: 'Intake',
      blocks: [
        { id: 'int_p1', type: 'paragraph', text: 'Vertel ons wat over jezelf zodat je mentor je traject kan afstemmen.' },
        {
          id: 'int_b1',
          type: 'select',
          key: 'ervaring_trading',
          label: 'Hoeveel ervaring heb je met trading?',
          required: true,
          options: [
            { value: 'geen',       label: 'Geen ervaring' },
            { value: 'beginner',   label: 'Beginner (minder dan 1 jaar)' },
            { value: 'middelbaar', label: 'Middelbaar (1 – 3 jaar)' },
            { value: 'gevorderd',  label: 'Gevorderd (meer dan 3 jaar)' },
          ],
        },
        {
          id: 'int_b2',
          type: 'single_choice',
          key: 'motivatie_primair',
          label: 'Wat is je belangrijkste motivatie om aan deze opleiding te beginnen?',
          required: true,
          options: [
            { value: 'extra_inkomen',    label: 'Een extra inkomen opbouwen' },
            { value: 'fulltime_trader',  label: 'Op termijn fulltime trader worden' },
            { value: 'vermogen_groeien', label: 'Mijn vermogen laten groeien' },
            { value: 'leren_voor_jezelf',label: 'Het leerproces zelf — kennis opbouwen' },
            { value: 'anders',           label: 'Anders' },
          ],
        },
        {
          id: 'int_b3',
          type: 'scale',
          key: 'commitment_uren_per_week',
          label: 'Hoeveel uur per week kun je vrijmaken voor de opleiding?',
          required: true,
          min: 1,
          max: 10,
          help: '1 = nauwelijks tijd; 10 = volle inzet.',
        },
        {
          id: 'int_b4',
          type: 'number',
          key: 'startbudget_euro',
          label: 'Wat is het bedrag waar je ongeveer mee wilt starten te traden (in euro)?',
          required: false,
          min: 0,
          max: 1000000,
          help: 'Dit is ter indicatie — er is geen verplicht startbedrag.',
        },
      ],
    },

    // ───────────────────────────── 3. Digitale producten
    {
      id: 'digitale_producten',
      title: 'Digitale producten',
      blocks: [
        { id: 'dp_p1', type: 'heading',   text: 'Cursusmateriaal als digitale download' },
        { id: 'dp_p2', type: 'paragraph', text: 'Hieronder krijg je toegang tot het cursusmateriaal. Lees onderstaande voorwaarden zorgvuldig voordat je downloadt.' },
        { id: 'dp_p3', type: 'paragraph', text: 'Wettelijke bedenktijd-waiver: bij digitale producten geldt normaal een herroepingsrecht van 14 dagen. Door het materiaal te downloaden verklaar je uitdrukkelijk afstand te doen van die 14 dagen bedenktijd. Vanaf het moment dat je downloadt vervalt je herroepingsrecht voor dit digitale product.' },
        {
          id: 'dp_fd1',
          type: 'file_download',
          label: 'Cursusmateriaal & startbestanden',
          files: [],                        // wordt later door admin gevuld
          requires_consent: true,
          is_waiver: true,                  // gemarkeerd als 14-dagen-bedenktijd-waiver
          consent_label: 'Ik verklaar uitdrukkelijk afstand te doen van mijn wettelijke bedenktijd van 14 dagen. Ik begrijp dat ik na het downloaden van het digitale cursusmateriaal geen herroepingsrecht meer heb.',
          consent_key: 'waiver_bedenktijd_digitaal',
        },
      ],
    },

    // ───────────────────────────── 4. Trading-robot
    {
      id: 'trading_robot',
      title: 'Trading-robot',
      blocks: [
        { id: 'tr_h1', type: 'heading',   text: 'Onze trading-robot' },
        { id: 'tr_p1', type: 'paragraph', text: 'Naast de mentor-begeleiding bieden we een eigen trading-robot aan. Hij draait al ruim 3 jaar live op echte markten en behaalt gemiddeld 3–7% per maand. Instap is mogelijk vanaf €500. Volledig optioneel — kies wat bij jou past.' },
        {
          id: 'tr_st1',
          type: 'stats',
          items: [
            { value: '3–7%',     label: 'Gemiddeld rendement per maand', sub: 'Bewezen op live capital' },
            { value: '±3 jaar',  label: 'Live track record',             sub: 'Sinds 2023 onafgebroken actief' },
            { value: 'vanaf €500', label: 'Instapbedrag',                sub: 'Geen verborgen kosten' },
          ],
        },
        // Screenshots van performance/dashboard — admin voegt de afbeelding later toe.
        { id: 'tr_img1', type: 'image', src: '', alt: 'Performance-screenshot van de trading-robot' },
        // GoHighLevel-agenda voor een korte intro-call — admin plakt de booking-URL.
        { id: 'tr_emb1', type: 'embed', url: '', height: 720, title: 'Plan een korte robot-intro (optioneel)' },
        {
          id: 'tr_b1',
          type: 'single_choice',
          key: 'robot_interesse',
          label: 'Heb je interesse in onze trading-robot?',
          required: true,
          options: [
            { value: 'ja_interesse', label: 'Ja, ik heb interesse (vanaf €500)' },
            { value: 'nee',          label: 'Nee, geen interesse' },
          ],
        },
      ],
    },

    // ───────────────────────────── 5. Beschikbaarheid
    {
      id: 'beschikbaarheid',
      title: 'Beschikbaarheid',
      blocks: [
        { id: 'bs_p1', type: 'paragraph', text: 'Tik aan in welke dagdelen je doorgaans beschikbaar bent voor 1-op-1 calls met je mentor. Hoe meer momenten, hoe makkelijker we een vast ritme inplannen.' },
        {
          id: 'bs_av1',
          type: 'availability',
          key: 'beschikbaarheid',
          label: 'Wanneer kun je meestal?',
          required: true,
          // days + dayparts blijven leeg → normalizeStructure vult ze met
          // de NL-defaults (ma..zo / ochtend/middag/avond).
        },
      ],
    },

    // ───────────────────────────── 6. Discord
    {
      id: 'discord',
      title: 'Discord-community',
      blocks: [
        { id: 'dc_p1', type: 'heading',   text: 'Onze community draait op Discord' },
        { id: 'dc_p2', type: 'paragraph', text: 'Op Discord deel je live setups, stel je vragen aan je mentor en spar je met medestudenten. Daar gebeurt het echte werk tussen de calls door.' },
        { id: 'dc_p3', type: 'paragraph', text: 'De persoonlijke join-link ontvang je per e-mail nadat je deze onboarding hebt afgerond. Heb je hem nog niet ontvangen? Vraag het je mentor.' },
      ],
    },

    // ───────────────────────────── 7. Afronding
    {
      id: 'afronding',
      title: 'Afronding',
      blocks: [
        { id: 'af_p1', type: 'paragraph', text: 'Bedankt voor het invullen! Klik hieronder om je antwoorden vast te leggen. Je mentor ontvangt automatisch een melding en neemt zo snel mogelijk contact op om je eerste call in te plannen.' },
        {
          id: 'af_c1',
          type: 'consent',
          key: 'akkoord_afronding',
          label: 'Ik bevestig dat mijn antwoorden naar waarheid zijn ingevuld.',
          required: true,
        },
      ],
    },
  ],
};

// Helpers ────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

// Block-types die door normalizeStructure toegestaan zijn. Onbekende types
// worden tijdens normalisatie gedropt (geen crash). Houd in sync met de
// renderer in modules/onboarding.html.
const ALLOWED_BLOCK_TYPES = new Set([
  // Info-only
  'heading', 'paragraph', 'image', 'divider',
  // Rich content
  'embed',             // https-iframe (bv. GoHighLevel-agenda/booking)
  'stats',             // kaarten-grid met value/label/sub
  // Tekst-invoer
  'short_text', 'long_text', 'email', 'tel',
  // Numeriek
  'number',
  // Keuzes
  'single_choice', 'multi_choice', 'select',
  'scale',
  // Beschikbaarheid (per-dag dagdelen matrix)
  'availability',
  // Akkoord + downloads
  'consent', 'file_download',
]);
// Veld-blokken hebben een answer-key (en validate-logica).
const FIELD_BLOCK_TYPES = new Set([
  'short_text', 'long_text', 'email', 'tel',
  'number', 'single_choice', 'multi_choice', 'select',
  'scale', 'availability', 'consent', 'file_download',
]);

// Defaults voor availability — 7 dagen + 3 dagdelen. Wanneer normalize
// een availability-blok zonder days/dayparts ontvangt vult 'ie deze
// arrays automatisch in zodat de editor en wizard meteen werken.
const AVAILABILITY_DEFAULT_DAYS = [
  { value: 'ma', label: 'Maandag'   },
  { value: 'di', label: 'Dinsdag'   },
  { value: 'wo', label: 'Woensdag'  },
  { value: 'do', label: 'Donderdag' },
  { value: 'vr', label: 'Vrijdag'   },
  { value: 'za', label: 'Zaterdag'  },
  { value: 'zo', label: 'Zondag'    },
];
const AVAILABILITY_DEFAULT_DAYPARTS = [
  { value: 'ochtend', label: 'Ochtend' },
  { value: 'middag',  label: 'Middag'  },
  { value: 'avond',   label: 'Avond'   },
];

function _isEmptyAnswer(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') return val.trim() === '';
  if (Array.isArray(val))      return val.length === 0;
  if (typeof val === 'number') return !Number.isFinite(val);
  return false;
}

function _newId(prefix) {
  return (prefix || 'b') + '_' + crypto.randomUUID().slice(0, 8);
}

function _str(v, max) {
  if (v == null) return '';
  const s = String(v);
  return (typeof max === 'number') ? s.slice(0, max) : s;
}

function _normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const value = _str(o.value, 120).trim();
    const label = _str(o.label, 240).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: label || value });
  }
  return out;
}

function _normalizeFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seenPaths = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const path = _str(f.path, 512).trim();
    const name = _str(f.name, 240).trim();
    if (!path) continue;            // path is required
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    out.push({ path, name: name || path.split('/').pop() || 'download' });
  }
  return out;
}

/**
 * Valideert + saneert een ingebrachte wizard-structuur. Genereert ontbrekende
 * ids, whitelist't block-types, dropt onbekende types, garandeert stabiele
 * answer-keys voor veld-blokken. Idempotent — een al-genormaliseerde struct
 * komt ongewijzigd terug.
 *
 * Gooit Error('STRUCTURE_INVALID: <reden>') bij grof-ongeldige input
 * (geen object, geen pages-array, etc).
 *
 * @param {object} input — { pages:[{ id?, title?, blocks:[...] }] }
 * @returns {object} — { version, pages:[...] }
 */
export function normalizeStructure(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('STRUCTURE_INVALID: structure moet een object zijn');
  }
  const rawPages = input.pages;
  if (!Array.isArray(rawPages)) {
    throw new Error('STRUCTURE_INVALID: pages[] ontbreekt');
  }
  const usedPageIds  = new Set();
  const usedBlockIds = new Set();
  const usedKeys     = new Set();

  const pages = [];
  for (const rawPage of rawPages) {
    if (!rawPage || typeof rawPage !== 'object') continue;
    let pageId = _str(rawPage.id, 64).trim();
    if (!pageId || usedPageIds.has(pageId)) pageId = _newId('p');
    while (usedPageIds.has(pageId)) pageId = _newId('p');
    usedPageIds.add(pageId);

    const page = {
      id     : pageId,
      title  : _str(rawPage.title, 240).trim() || null,
      blocks : [],
    };

    const rawBlocks = Array.isArray(rawPage.blocks) ? rawPage.blocks : [];
    for (const rawBlock of rawBlocks) {
      if (!rawBlock || typeof rawBlock !== 'object') continue;
      const type = _str(rawBlock.type, 32).trim();
      if (!ALLOWED_BLOCK_TYPES.has(type)) continue;     // drop unknown

      let blockId = _str(rawBlock.id, 64).trim();
      if (!blockId || usedBlockIds.has(blockId)) blockId = _newId('b');
      while (usedBlockIds.has(blockId)) blockId = _newId('b');
      usedBlockIds.add(blockId);

      const out = { id: blockId, type };

      // Info-only blocks
      if (type === 'paragraph' || type === 'heading') {
        out.text = _str(rawBlock.text, 4000);
        page.blocks.push(out);
        continue;
      }
      if (type === 'image') {
        out.src = _str(rawBlock.src, 1024).trim();
        out.alt = _str(rawBlock.alt, 240);
        if (!out.src) continue;        // image zonder src is zinloos → drop
        page.blocks.push(out);
        continue;
      }
      if (type === 'divider') {
        page.blocks.push(out);
        continue;
      }
      if (type === 'embed') {
        // url: alleen https:// (anders leeg laten; renderer slaat 'm dan over).
        const rawUrl = _str(rawBlock.url, 1024).trim();
        out.url = /^https:\/\//i.test(rawUrl) ? rawUrl : '';
        // height: integer 200..1200 (default 700).
        const h = Number(rawBlock.height);
        out.height = (Number.isFinite(h) && Number.isInteger(h))
          ? Math.max(200, Math.min(1200, h))
          : 700;
        const title = _str(rawBlock.title, 240).trim();
        if (title) out.title = title;
        page.blocks.push(out);
        continue;
      }
      if (type === 'stats') {
        const title = _str(rawBlock.title, 240).trim();
        if (title) out.title = title;
        const rawItems = Array.isArray(rawBlock.items) ? rawBlock.items : [];
        const items = [];
        for (const it of rawItems) {
          if (!it || typeof it !== 'object') continue;
          const value = _str(it.value, 60).trim();
          const label = _str(it.label, 200).trim();
          const sub   = _str(it.sub,   200).trim();
          if (!value && !label) continue;       // volledig lege rij → drop
          const item = { value, label };
          if (sub) item.sub = sub;
          items.push(item);
          if (items.length >= 12) break;        // hard cap
        }
        out.items = items;
        page.blocks.push(out);
        continue;
      }

      // Veld-blokken: gemeenschappelijke shape.
      const label    = _str(rawBlock.label, 600).trim();
      const required = !!rawBlock.required;
      const help     = _str(rawBlock.help,  600);

      // file_download gebruikt een eigen answer-pad (consent_key).
      if (type === 'file_download') {
        out.label             = label || 'Download';
        out.help              = help || undefined;
        out.files             = _normalizeFiles(rawBlock.files);
        out.requires_consent  = !!rawBlock.requires_consent;
        // is_waiver markeert dat de consent juridisch een 14-dagen-bedenktijd-
        // waiver is (i.p.v. een gewone voorwaarde-acceptatie). Effect:
        //   - admin-overzicht toont een dedicated 'Bedenktijd'-kolom.
        //   - publieke renderer toont de pop-up-waiver-flow met expliciete
        //     "Ik zie af van mijn bedenktijd"-knop i.p.v. een inline-vinkje.
        // Alleen zinvol in combinatie met requires_consent=true; wordt
        // hieronder genegeerd zonder consent.
        out.is_waiver         = !!rawBlock.is_waiver;
        if (out.requires_consent) {
          out.consent_label = _str(rawBlock.consent_label, 600).trim()
            || 'Ik ga akkoord met de voorwaarden.';
          let ck = _str(rawBlock.consent_key, 64).trim().replace(/[^A-Za-z0-9_]/g, '_');
          if (!ck || usedKeys.has(ck)) ck = 'waiver_' + crypto.randomUUID().slice(0, 6);
          while (usedKeys.has(ck)) ck = 'waiver_' + crypto.randomUUID().slice(0, 6);
          usedKeys.add(ck);
          out.consent_key = ck;
        } else {
          // is_waiver heeft geen betekenis zonder consent — strip 'm zodat
          // de structuur zelf-consistent blijft.
          out.is_waiver = false;
        }
        page.blocks.push(out);
        continue;
      }

      // Andere veld-blokken: stabiele key verplicht.
      let key = _str(rawBlock.key, 64).trim().replace(/[^A-Za-z0-9_]/g, '_');
      if (!key || usedKeys.has(key)) key = 'f_' + crypto.randomUUID().slice(0, 8);
      while (usedKeys.has(key)) key = 'f_' + crypto.randomUUID().slice(0, 8);
      usedKeys.add(key);

      out.key      = key;
      out.label    = label || 'Vraag';
      out.required = required;
      if (help) out.help = help;

      if (type === 'single_choice' || type === 'multi_choice' || type === 'select') {
        out.options = _normalizeOptions(rawBlock.options);
      } else if (type === 'scale') {
        const min = Number.isFinite(Number(rawBlock.min)) ? Number(rawBlock.min) : 1;
        const max = Number.isFinite(Number(rawBlock.max)) ? Number(rawBlock.max) : 10;
        out.min = Math.max(0, Math.min(min, 100));
        out.max = Math.max(out.min + 1, Math.min(max, 100));
      } else if (type === 'number') {
        if (rawBlock.min != null && Number.isFinite(Number(rawBlock.min))) out.min = Number(rawBlock.min);
        if (rawBlock.max != null && Number.isFinite(Number(rawBlock.max))) out.max = Number(rawBlock.max);
      } else if (type === 'consent') {
        // label is de waiver-tekst; required wordt al hierboven gezet.
      } else if (type === 'availability') {
        // required default = true zodat een nieuw blok meteen verplicht is.
        if (rawBlock.required === undefined) out.required = true;
        const days     = _normalizeOptions(rawBlock.days);
        const dayparts = _normalizeOptions(rawBlock.dayparts);
        out.days     = (days.length     > 0) ? days     : AVAILABILITY_DEFAULT_DAYS.slice();
        out.dayparts = (dayparts.length > 0) ? dayparts : AVAILABILITY_DEFAULT_DAYPARTS.slice();
      }
      page.blocks.push(out);
    }

    pages.push(page);
  }

  return {
    version : Number.isFinite(Number(input.version)) ? Number(input.version) : 1,
    pages,
  };
}

/**
 * Verzamelt alle storage-paths uit file_download-blokken (files[].path) in
 * een structuur. Nuttig voor garbage-collection bij publish/save (te
 * verwijderen paths = oude paths minus nieuwe).
 *
 * @param {object} struct
 * @returns {string[]} unieke paths
 */
export function collectFileRefs(struct) {
  const out = new Set();
  if (!struct || typeof struct !== 'object') return [];
  for (const page of (struct.pages || [])) {
    for (const b of (page?.blocks || [])) {
      if (b && b.type === 'file_download' && Array.isArray(b.files)) {
        for (const f of b.files) {
          if (f && typeof f.path === 'string' && f.path.trim()) out.add(f.path.trim());
        }
      }
    }
  }
  return Array.from(out);
}

/**
 * Loop door alle blokken van de structuur en geef het EERSTE
 * availability-blok terug (met key + days[] + dayparts[]). Wordt
 * gebruikt door admin-overzicht + detail + mentor-self om antwoorden
 * naar labels te resolven en als per-onboarding 'availability'-veld
 * te hangen.
 *
 * Spiegel van het findWaiverConsentKey-patroon — zelfde fail-soft
 * vorm (returnt null bij geen blok / geen structuur).
 *
 * @param {object} structure  — { pages:[...] }
 * @returns {object|null}     — het availability-block of null
 */
export function findAvailabilityBlock(structure) {
  if (!structure || typeof structure !== 'object') return null;
  const pages = Array.isArray(structure.pages) ? structure.pages : [];
  for (const p of pages) {
    for (const b of (p?.blocks || [])) {
      if (b && b.type === 'availability' && b.key) return b;
    }
  }
  return null;
}

/**
 * Map een raw answers[<availability.key>] naar een label-gerichte
 * structuur die UI direct kan renderen:
 *   { days: [ { label:'Maandag', dayparts:['Ochtend','Avond'] }, ... ] }
 *
 * - Alleen dagen met >=1 dagdeel komen in de output.
 * - Volgorde respecteert block.days[]; dagdelen-volgorde respecteert
 *   block.dayparts[].
 * - Onbekende dag/dagdeel-values (die niet in de structuur staan)
 *   worden gedropt — voorkomt UI-vervuiling bij wizard-rename na
 *   eerdere afronding.
 *
 * Returnt null wanneer block ontbreekt of antwoord leeg/onbruikbaar is.
 *
 * @param {object|null} block    — uit findAvailabilityBlock
 * @param {object|null} answers  — onboardings.answers (jsonb)
 * @returns {{ days:{label:string,dayparts:string[]}[] }|null}
 */
export function buildAvailabilityView(block, answers) {
  if (!block || !block.key) return null;
  const ans = (answers && typeof answers === 'object') ? answers : {};
  const raw = ans[block.key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const dayList     = Array.isArray(block.days)     ? block.days     : [];
  const daypartList = Array.isArray(block.dayparts) ? block.dayparts : [];
  const out = [];
  for (const d of dayList) {
    if (!d || !d.value) continue;
    const arr = Array.isArray(raw[d.value]) ? raw[d.value] : [];
    if (arr.length === 0) continue;
    const labels = [];
    for (const dp of daypartList) {
      if (dp && dp.value && arr.indexOf(dp.value) >= 0) {
        labels.push(dp.label || dp.value);
      }
    }
    if (labels.length === 0) continue;
    out.push({ label: d.label || d.value, dayparts: labels });
  }
  if (out.length === 0) return null;
  return { days: out };
}

/**
 * Server-side validator. Itereert alle blocks in pages en verzamelt de
 * answer-keys die nog ontbreken voor een geldige afronding.
 *
 * - consent (required=true)              → answers[key] === true
 * - file_download (requires_consent=true)→ answers[consent_key] === true
 * - andere veld-blokken (required=true)  → answers[key] niet-leeg
 *
 * @param {object} answers — flat object key→value
 * @param {object} [structure=DEFAULT_WIZARD_STRUCTURE]
 * @returns {{ ok:boolean, missing:string[] }}
 */
export function validateRequired(answers, structure) {
  const struct  = structure || DEFAULT_WIZARD_STRUCTURE;
  const ans     = (answers && typeof answers === 'object') ? answers : {};
  const missing = [];
  for (const page of (struct.pages || [])) {
    for (const b of (page.blocks || [])) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'consent') {
        if (b.required && ans[b.key] !== true) missing.push(b.key);
        continue;
      }
      if (b.type === 'file_download') {
        if (b.requires_consent && b.consent_key && ans[b.consent_key] !== true) {
          missing.push(b.consent_key);
        }
        continue;
      }
      if (b.type === 'availability') {
        // Vervuld = object met minstens 1 dag die een niet-lege array heeft.
        if (b.required === true && b.key) {
          const v = ans[b.key];
          let ok = false;
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const dayKey of Object.keys(v)) {
              if (Array.isArray(v[dayKey]) && v[dayKey].length > 0) { ok = true; break; }
            }
          }
          if (!ok) missing.push(b.key);
        }
        continue;
      }
      // Overige field-blocks met required-vlag.
      if (b.required === true && b.key) {
        if (_isEmptyAnswer(ans[b.key])) missing.push(b.key);
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
