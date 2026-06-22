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
          consent_label: 'Ik begrijp dat ik door deze materialen te downloaden uitdrukkelijk afstand doe van de wettelijke bedenktijd van 14 dagen.',
          consent_key: 'waiver_bedenktijd_digitaal',
        },
      ],
    },

    // ───────────────────────────── 4. Trading-robot
    {
      id: 'trading_robot',
      title: 'Trading-robot',
      blocks: [
        { id: 'tr_p1', type: 'paragraph', text: 'We bieden een optionele trading-robot aan die je kan ondersteunen bij geautomatiseerde setups. Hieronder kun je aangeven wat voor jou past — er is geen druk; ook "geen interesse" is een prima antwoord.' },
        {
          id: 'tr_b1',
          type: 'single_choice',
          key: 'robot_interesse',
          label: 'Heb je interesse in onze trading-robot?',
          required: true,
          options: [
            { value: 'ja_meer_info',     label: 'Ja, ik wil meer informatie' },
            { value: 'ja_direct',        label: 'Ja, ik wil deze graag meteen gebruiken' },
            { value: 'misschien_later',  label: 'Misschien later in het traject' },
            { value: 'nee',              label: 'Nee, geen interesse' },
          ],
        },
      ],
    },

    // ───────────────────────────── 5. Beschikbaarheid
    {
      id: 'beschikbaarheid',
      title: 'Beschikbaarheid',
      blocks: [
        { id: 'bs_p1', type: 'paragraph', text: 'Op welke momenten ben je doorgaans beschikbaar voor 1-op-1 calls met je mentor?' },
        {
          id: 'bs_b1',
          type: 'multi_choice',
          key: 'dagen_beschikbaar',
          label: 'Op welke dagen kun je meestal?',
          required: true,
          options: [
            { value: 'ma', label: 'Maandag' },
            { value: 'di', label: 'Dinsdag' },
            { value: 'wo', label: 'Woensdag' },
            { value: 'do', label: 'Donderdag' },
            { value: 'vr', label: 'Vrijdag' },
            { value: 'za', label: 'Zaterdag' },
            { value: 'zo', label: 'Zondag' },
          ],
        },
        {
          id: 'bs_b2',
          type: 'multi_choice',
          key: 'dagdelen_beschikbaar',
          label: 'En in welke dagdelen?',
          required: true,
          options: [
            { value: 'ochtend', label: 'Ochtend (08:00 – 12:00)' },
            { value: 'middag',  label: 'Middag (12:00 – 17:00)' },
            { value: 'avond',   label: 'Avond (17:00 – 22:00)' },
          ],
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

function _isEmptyAnswer(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') return val.trim() === '';
  if (Array.isArray(val))      return val.length === 0;
  if (typeof val === 'number') return !Number.isFinite(val);
  return false;
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
      // Overige field-blocks met required-vlag.
      if (b.required === true && b.key) {
        if (_isEmptyAnswer(ans[b.key])) missing.push(b.key);
      }
    }
  }
  return { ok: missing.length === 0, missing };
}
