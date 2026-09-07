// tests/dfo-lms-sessies.test.js
//
// Borgt de regel waar deze module voor bestaat: "leeg" en "niet gelukt"
// mogen nooit hetzelfde zijn.
//
// Dat is de rode draad van alles wat we deze week vonden. Elke Bubble-lezer
// in het CRM vangt zijn fouten af naar een lege lijst, waardoor een storing
// en "er is niets" er identiek uitzien. De betaalherinnering-cron meldde
// daardoor maandenlang `checked: 0` terwijl klanten hun herinnering misliepen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  haalSessiesInVenster,
  BRON_GELEZEN,
  BRON_ONBEREIKBAAR,
  BRON_NIET_GECONFIGUREERD,
  AFGEHANDELDE_STATUSSEN,
} from '../api/_lib/dfo-lms-sessies.js';

const VAN = '2026-09-07T08:00:00.000Z';
const TOT = '2026-09-08T08:00:00.000Z';

/**
 * Minimale nabootsing van de supabase-client. Antwoordt PER TABEL, zodat één
 * stub alle ketens aankan die deze module gebruikt. De keten is een thenable:
 * elke methode geeft zichzelf terug en het geheel lost op bij `await`.
 *
 * Een waarde mag ook een Error zijn — dan doet die tabel alsof de bevraging
 * mislukte.
 */
function nepClient(perTabel = {}) {
  const antwoord = (bron) => (bron instanceof Error
    ? { data: null, error: { message: bron.message } }
    : { data: bron || [], error: null });

  return {
    from(tabel) {
      const keten = {
        select: () => keten, eq: () => keten, gt: () => keten, gte: () => keten,
        lt: () => keten, in: () => keten, order: () => keten, limit: () => keten,
        then: (resolve, reject) => Promise.resolve(antwoord(perTabel[tabel])).then(resolve, reject),
      };
      return keten;
    },
  };
}

/** Kortere naam voor de veelgebruikte vorm van haalSessiesInVenster-tests. */
const clientMet = ({ sessies, studenten, personeel } = {}) => nepClient({
  hlms_sessie: sessies, hlms_student: studenten, hlms_personeel: personeel,
});

const sessie = (o) => ({
  id: 's1', start_tijd: '2026-09-07T10:00:00.000Z',
  status: 'gepland', student_id: 'stu-1', ...o,
});
const student = (o) => ({ id: 'stu-1', email: 'a@b.nl', voornaam: 'A', achternaam: 'B', ...o });

// ── 1) De kernregel: leeg is niet hetzelfde als mislukt ─────────────────────

test('nul sessies met een GELUKTE bevraging is een feit, geen storing', async () => {
  const r = await haalSessiesInVenster({ vanIso: VAN, totIso: TOT, client: clientMet({ sessies: [] }) });
  assert.equal(r.bron_status, BRON_GELEZEN, 'de bron is gelezen — nul betekent echt nul');
  assert.deepEqual(r.sessies, []);
  assert.equal(r.fout, null);
});

test('een MISLUKTE bevraging levert nooit stilzwijgend een lege lijst op', async () => {
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({ sessies: new Error('connection reset') }),
  });
  assert.equal(r.bron_status, BRON_ONBEREIKBAAR);
  assert.match(r.fout, /connection reset/);
  assert.deepEqual(r.sessies, [], 'lijst is leeg, maar de status zegt waarom');
});

test('ontbrekende configuratie is een DERDE toestand, niet leeg en niet stuk', async () => {
  const oudeUrl = process.env.DFO_LMS_SUPABASE_URL;
  const oudeKey = process.env.DFO_LMS_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.DFO_LMS_SUPABASE_URL;
  delete process.env.DFO_LMS_SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await haalSessiesInVenster({ vanIso: VAN, totIso: TOT });
    assert.equal(r.bron_status, BRON_NIET_GECONFIGUREERD);
    assert.match(r.fout, /DFO_LMS/);
  } finally {
    if (oudeUrl) process.env.DFO_LMS_SUPABASE_URL = oudeUrl;
    if (oudeKey) process.env.DFO_LMS_SUPABASE_SERVICE_ROLE_KEY = oudeKey;
  }
});

test('de drie bron-statussen zijn onderling verschillend', () => {
  const set = new Set([BRON_GELEZEN, BRON_ONBEREIKBAAR, BRON_NIET_GECONFIGUREERD]);
  assert.equal(set.size, 3);
});

test('valt de studenten-bevraging om, dan is dat OOK onbereikbaar', async () => {
  // De sessies zijn gelezen, maar zonder e-mailadres kan de aanroeper niets.
  // Dat als 'nul sessies' terugmelden zou de fout weer onzichtbaar maken.
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({ sessies: [sessie()], studenten: new Error('timeout') }),
  });
  assert.equal(r.bron_status, BRON_ONBEREIKBAAR);
  assert.match(r.fout, /hlms_student/);
});

// ── 2) Tellen wat er buiten de filter viel ──────────────────────────────────

test('afgehandelde sessies vallen af EN worden geteld', async () => {
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({
      sessies: [
        sessie({ id: 's1', status: 'gepland' }),
        sessie({ id: 's2', status: 'afgerond' }),
        sessie({ id: 's3', status: 'no_show' }),
      ],
      studenten: [student()],
    }),
  });
  assert.equal(r.bron_status, BRON_GELEZEN);
  assert.equal(r.sessies.length, 1);
  assert.equal(r.sessies[0].id, 's1');
  assert.equal(r.totaal_in_venster, 3);
  assert.equal(r.overgeslagen_afgehandeld, 2, 'wat wegvalt moet zichtbaar blijven in de telling');
});

test('sessies zonder student vallen af EN worden geteld', async () => {
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({
      sessies: [sessie({ id: 's1' }), sessie({ id: 's2', student_id: null })],
      studenten: [student()],
    }),
  });
  assert.equal(r.sessies.length, 1);
  assert.equal(r.zonder_student, 1);
});

test('sessies met een student zonder e-mailadres vallen af EN worden geteld', async () => {
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({
      sessies: [sessie({ id: 's1', student_id: 'stu-1' })],
      studenten: [student({ id: 'stu-1', email: '  ' })],
    }),
  });
  assert.equal(r.sessies.length, 0);
  assert.equal(r.zonder_email, 1);
  assert.equal(r.bron_status, BRON_GELEZEN, 'nog steeds gelezen — alleen onbruikbaar');
});

// ── 3) Falen richting versturen ─────────────────────────────────────────────

test('een ONBEKENDE status komt er wel doorheen', async () => {
  // Bij een betaalherinnering is niet-versturen de duurdere fout. Een status
  // die we nog niet kennen mag dus geen stille uitsluiting worden.
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({ sessies: [sessie({ status: 'verzet' })], studenten: [student()] }),
  });
  assert.equal(r.sessies.length, 1);
  assert.equal(r.overgeslagen_afgehandeld, 0);
});

test('een sessie zonder status komt er ook doorheen', async () => {
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({ sessies: [sessie({ status: null })], studenten: [student()] }),
  });
  assert.equal(r.sessies.length, 1, 'NULL-status mag niet stilzwijgend wegvallen');
});

test('afgehandelde statussen zijn hoofdletterongevoelig', async () => {
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({ sessies: [sessie({ status: 'Afgerond' })], studenten: [student()] }),
  });
  assert.equal(r.sessies.length, 0);
  assert.equal(r.overgeslagen_afgehandeld, 1);
});

test('de lijst afgehandelde statussen is precies afgerond + no_show', () => {
  assert.deepEqual([...AFGEHANDELDE_STATUSSEN].sort(), ['afgerond', 'no_show']);
});

// ── 4) De vorm die de aanroeper krijgt ──────────────────────────────────────

test('een sessie draagt id, tijdstip en genormaliseerd e-mailadres', async () => {
  const r = await haalSessiesInVenster({
    vanIso: VAN, totIso: TOT,
    client: clientMet({
      sessies: [sessie({ id: 'abc', start_tijd: '2026-09-07T11:30:00.000Z' })],
      studenten: [student({ email: '  Wim@Example.NL ' })],
    }),
  });
  const s = r.sessies[0];
  assert.equal(s.id, 'abc');
  assert.equal(s.start_tijd, '2026-09-07T11:30:00.000Z');
  assert.equal(s.email, 'wim@example.nl');
  assert.equal(s.voornaam, 'A');
});

// ── 5) haalNoShowsSinds — de bron voor de no-show-detectie ──────────────────

import { haalNoShowsSinds, haalSessieOverzichtPerStudent } from '../api/_lib/dfo-lms-sessies.js';

// NA het watermerk VAN (7 sep 08:00): de bron filtert nu ook in JS op het
// venster, dus een fixture ervóór zou terecht wegvallen.
const noshow = (o) => ({
  id: 'ns1', start_tijd: '2026-09-07T10:00:00.000Z', status: 'no_show',
  student_id: 'stu-1', mentor_id: 'men-1', ...o,
});
const mentor = (o) => ({ id: 'men-1', email: 'Dave@DeForexOpleiding.nl', naam: 'Dave', ...o });

test('no-show levert student-brug én mentor-e-mail op', async () => {
  const r = await haalNoShowsSinds({
    sindsIso: VAN,
    client: clientMet({
      sessies: [noshow()],
      studenten: [student({ id: 'stu-1', bubble_user_id: 'bub-99' })],
      personeel: [mentor()],
    }),
  });
  assert.equal(r.bron_status, BRON_GELEZEN);
  assert.equal(r.sessies.length, 1);
  assert.equal(r.sessies[0].bubble_user_id, 'bub-99', 'de brug naar het CRM moet mee');
  assert.equal(r.sessies[0].mentor_email, 'dave@deforexopleiding.nl', 'kleine letters voor de vergelijking');
});

test('no-show zonder student-brug valt af EN wordt geteld', async () => {
  // Vier adminrijen en Wim hebben geen bubble_user_id (gemeten 7-9-2026).
  // Zonder die waarde kan het signaal nergens aan hangen.
  const r = await haalNoShowsSinds({
    sindsIso: VAN,
    client: clientMet({
      sessies: [noshow()],
      studenten: [student({ id: 'stu-1', bubble_user_id: null })],
      personeel: [mentor()],
    }),
  });
  assert.equal(r.sessies.length, 0);
  assert.equal(r.zonder_bubble_koppeling, 1);
  assert.equal(r.bron_status, BRON_GELEZEN, 'gelezen — alleen onbruikbaar');
});

test('no-show zonder mentor-e-mail valt af EN wordt geteld', async () => {
  const r = await haalNoShowsSinds({
    sindsIso: VAN,
    client: clientMet({
      sessies: [noshow()],
      studenten: [student({ id: 'stu-1', bubble_user_id: 'bub-99' })],
      personeel: [mentor({ email: '' })],
    }),
  });
  assert.equal(r.sessies.length, 0);
  assert.equal(r.zonder_mentor, 1);
});

test('geen no-shows met een gelukte bevraging is een feit', async () => {
  const r = await haalNoShowsSinds({ sindsIso: VAN, client: clientMet({ sessies: [] }) });
  assert.equal(r.bron_status, BRON_GELEZEN);
  assert.equal(r.sessies.length, 0);
});

test('mislukte no-show-bevraging is onbereikbaar, geen lege lijst', async () => {
  const r = await haalNoShowsSinds({
    sindsIso: VAN, client: clientMet({ sessies: new Error('geen verbinding') }),
  });
  assert.equal(r.bron_status, BRON_ONBEREIKBAAR);
  assert.match(r.fout, /geen verbinding/);
});

// ── 6) haalSessieOverzichtPerStudent — de bron voor de intake-status ────────

const NU = new Date('2026-09-07T12:00:00.000Z');

test('geeft vroegste afgeronde, laatste no-show en eerstvolgende geplande', async () => {
  const r = await haalSessieOverzichtPerStudent({
    bubbleUserIds: ['bub-1'], nu: NU,
    client: clientMet({
      studenten: [{ id: 'stu-1', bubble_user_id: 'bub-1' }],
      sessies: [
        { id: 'a', start_tijd: '2026-08-01T10:00:00.000Z', status: 'afgerond',  student_id: 'stu-1' },
        { id: 'b', start_tijd: '2026-08-20T10:00:00.000Z', status: 'afgerond',  student_id: 'stu-1' },
        { id: 'c', start_tijd: '2026-08-10T10:00:00.000Z', status: 'no_show',   student_id: 'stu-1' },
        { id: 'd', start_tijd: '2026-08-25T10:00:00.000Z', status: 'no_show',   student_id: 'stu-1' },
        { id: 'e', start_tijd: '2026-09-20T10:00:00.000Z', status: 'gepland',   student_id: 'stu-1' },
        { id: 'f', start_tijd: '2026-09-10T10:00:00.000Z', status: 'gepland',   student_id: 'stu-1' },
      ],
    }),
  });
  const v = r.perStudent.get('bub-1');
  assert.equal(v.done,   '2026-08-01T10:00:00.000Z', 'VROEGSTE afgeronde');
  assert.equal(v.noshow, '2026-08-25T10:00:00.000Z', 'LAATSTE no-show');
  assert.equal(v.next,   '2026-09-10T10:00:00.000Z', 'EERSTVOLGENDE geplande');
});

test('een geplande sessie in het VERLEDEN telt niet als eerstvolgende', async () => {
  const r = await haalSessieOverzichtPerStudent({
    bubbleUserIds: ['bub-1'], nu: NU,
    client: clientMet({
      studenten: [{ id: 'stu-1', bubble_user_id: 'bub-1' }],
      sessies: [{ id: 'a', start_tijd: '2026-09-01T10:00:00.000Z', status: 'gepland', student_id: 'stu-1' }],
    }),
  });
  assert.equal(r.perStudent.get('bub-1').next, null);
});

test('DE KERNCASUS: een student met sessies levert niet-lege gegevens op', async () => {
  // De student van Seppe met dertien sessies stond bovenaan als 'nog te
  // benaderen' omdat de Bubble-bron leeg was. Met deze bron gebeurt dat niet.
  const sessies = Array.from({ length: 13 }, (_, i) => ({
    id: 's' + i, start_tijd: '2026-09-0' + ((i % 5) + 1) + 'T10:00:00.000Z',
    status: 'afgerond', student_id: 'stu-1',
  }));
  const r = await haalSessieOverzichtPerStudent({
    bubbleUserIds: ['bub-1'], nu: NU,
    client: clientMet({ studenten: [{ id: 'stu-1', bubble_user_id: 'bub-1' }], sessies }),
  });
  assert.ok(r.perStudent.get('bub-1').done, 'er MOET een afgeronde sessie uitkomen');
});

test('een lege id-lijst is geen bevraging en dus geen storing', async () => {
  const r = await haalSessieOverzichtPerStudent({ bubbleUserIds: [], nu: NU });
  assert.equal(r.bron_status, BRON_GELEZEN);
  assert.equal(r.perStudent.size, 0);
});

test('mislukte sessie-bevraging is onbereikbaar, geen lege map', async () => {
  const r = await haalSessieOverzichtPerStudent({
    bubbleUserIds: ['bub-1'], nu: NU,
    client: clientMet({
      studenten: [{ id: 'stu-1', bubble_user_id: 'bub-1' }],
      sessies: new Error('timeout'),
    }),
  });
  assert.equal(r.bron_status, BRON_ONBEREIKBAAR);
  assert.equal(r.perStudent.size, 0);
  assert.match(r.fout, /timeout/);
});

test('onbekende student-brug levert simpelweg geen rij op', async () => {
  const r = await haalSessieOverzichtPerStudent({
    bubbleUserIds: ['bestaat-niet'], nu: NU, client: clientMet({ studenten: [] }),
  });
  assert.equal(r.bron_status, BRON_GELEZEN);
  assert.equal(r.perStudent.size, 0);
});

// ── 7) DE REGEL van 7 september 2026 ────────────────────────────────────────
//
// "De vroegste AFGERONDE sessie van een student sluit diens onboarding af."
//
// Deze tests worden rood zodra die regel wegvalt of verschuift. Ze bewaken
// vier dingen die makkelijk stilletjes verkeerd gaan:
//   - het is de VROEGSTE afgeronde, niet zomaar een afgeronde;
//   - er is GEEN soort-onderscheid (geen kennismakingsgesprek, geen
//     Alpha/Delta) — elke coachingsessie telt;
//   - een no-show sluit NIETS af;
//   - het watermerk voorkomt een terugwerkende vloedgolf.

import { haalAfgerondeEersteSessies } from '../api/_lib/dfo-lms-sessies.js';

const WM = '2026-09-01T00:00:00.000Z';
const ses = (id, tijd, status, stu = 'stu-1') =>
  ({ id, start_tijd: tijd, status, student_id: stu });

test('REGEL: de vroegste afgeronde sessie is de sluiter', async () => {
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM,
    client: clientMet({
      sessies: [
        ses('laat',    '2026-09-20T10:00:00.000Z', 'afgerond'),
        ses('vroegst', '2026-09-05T10:00:00.000Z', 'afgerond'),
        ses('midden',  '2026-09-10T10:00:00.000Z', 'afgerond'),
      ],
      studenten: [student({ id: 'stu-1', bubble_user_id: 'bub-1' })],
    }),
  });
  assert.equal(r.sessies.length, 1, 'precies één sessie mag de onboarding sluiten');
  assert.equal(r.sessies[0].id, 'vroegst');
});

test('REGEL: een NO-SHOW sluit niets af', async () => {
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM,
    client: clientMet({
      sessies: [ses('ns', '2026-09-05T10:00:00.000Z', 'no_show')],
      studenten: [student({ id: 'stu-1', bubble_user_id: 'bub-1' })],
    }),
  });
  assert.equal(r.sessies.length, 0);
});

test('REGEL: na een gemiste eerste call sluit de VOLGENDE afgeronde sessie alsnog', async () => {
  // Dit is het verschil tussen "de eerste sessie mits afgerond" en "de
  // vroegste afgeronde". Zou het eerste gelden, dan bleef deze onboarding
  // voor altijd open staan omdat de eerste sessie een no-show was.
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM,
    client: clientMet({
      sessies: [
        ses('ns',   '2026-09-05T10:00:00.000Z', 'no_show'),
        ses('goed', '2026-09-12T10:00:00.000Z', 'afgerond'),
      ],
      studenten: [student({ id: 'stu-1', bubble_user_id: 'bub-1' })],
    }),
  });
  assert.equal(r.sessies.length, 1);
  assert.equal(r.sessies[0].id, 'goed');
});

test('REGEL: geen soort-onderscheid — elke afgeronde coachingsessie telt', async () => {
  // Er bestaat geen 'kennismakingsgesprek' en geen Alpha/Delta. Zou er ooit
  // weer een soort-filter insluipen, dan valt deze sessie weg en wordt deze
  // test rood.
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM,
    client: clientMet({
      sessies: [{ ...ses('x', '2026-09-05T10:00:00.000Z', 'afgerond'),
        titel: 'Wekelijkse coaching', soort: 'zomaar-iets' }],
      studenten: [student({ id: 'stu-1', bubble_user_id: 'bub-1' })],
    }),
  });
  assert.equal(r.sessies.length, 1);
});

test('WATERMERK: een afgeronde sessie VÓÓR het watermerk sluit niets af', async () => {
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM,
    client: clientMet({
      sessies: [ses('oud', '2026-08-01T10:00:00.000Z', 'afgerond')],
      studenten: [student({ id: 'stu-1', bubble_user_id: 'bub-1' })],
    }),
  });
  assert.equal(r.sessies.length, 0, 'geen terugwerkende vloedgolf');
});

test('WATERMERK: ligt de vroegste afgeronde erbuiten, dan telt de latere NIET mee', async () => {
  // De onboarding had destijds al gesloten moeten worden. Dat alsnog doen zou
  // vandaag een oude gebeurtenis als nieuw laten lijken. Wel zichtbaar tellen.
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM,
    client: clientMet({
      sessies: [
        ses('oud',   '2026-08-01T10:00:00.000Z', 'afgerond'),
        ses('nieuw', '2026-09-10T10:00:00.000Z', 'afgerond'),
      ],
      studenten: [student({ id: 'stu-1', bubble_user_id: 'bub-1' })],
    }),
  });
  assert.equal(r.sessies.length, 0);
  assert.equal(r.eerdere_afgeronde_buiten_venster, 1, 'wat wegvalt moet zichtbaar blijven');
});

test('twee studenten krijgen elk hun eigen vroegste afgeronde', async () => {
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM,
    client: clientMet({
      sessies: [
        ses('a1', '2026-09-05T10:00:00.000Z', 'afgerond', 'stu-1'),
        ses('a2', '2026-09-08T10:00:00.000Z', 'afgerond', 'stu-1'),
        ses('b1', '2026-09-06T10:00:00.000Z', 'afgerond', 'stu-2'),
      ],
      studenten: [
        student({ id: 'stu-1', bubble_user_id: 'bub-1' }),
        student({ id: 'stu-2', bubble_user_id: 'bub-2' }),
      ],
    }),
  });
  assert.deepEqual(r.sessies.map((s) => s.id).sort(), ['a1', 'b1']);
});

test('zonder student-brug sluit er niets af EN wordt het geteld', async () => {
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM,
    client: clientMet({
      sessies: [ses('x', '2026-09-05T10:00:00.000Z', 'afgerond')],
      studenten: [student({ id: 'stu-1', bubble_user_id: null })],
    }),
  });
  assert.equal(r.sessies.length, 0);
  assert.equal(r.zonder_bubble_koppeling, 1);
});

test('mislukte bevraging sluit NOOIT iets af', async () => {
  const r = await haalAfgerondeEersteSessies({
    sindsIso: WM, client: clientMet({ sessies: new Error('down') }),
  });
  assert.equal(r.bron_status, BRON_ONBEREIKBAAR);
  assert.equal(r.sessies.length, 0);
});

// ── 8) De eerste sessie, voor het no-show-signaaltype ───────────────────────

import { haalEersteSessiePerStudent } from '../api/_lib/dfo-lms-sessies.js';

test('eerste sessie is chronologisch, ONGEACHT status', async () => {
  const r = await haalEersteSessiePerStudent({
    studentIds: ['stu-1'],
    client: clientMet({
      sessies: [
        ses('b', '2026-09-10T10:00:00.000Z', 'afgerond'),
        ses('a', '2026-09-02T10:00:00.000Z', 'no_show'),
      ],
    }),
  });
  const e = r.perStudent.get('stu-1');
  assert.equal(e.id, 'a', 'de vroegste, ook als die een no-show is');
  assert.equal(e.status, 'no_show');
});

test('een sessie zonder start_tijd kan nooit de eerste zijn', async () => {
  const r = await haalEersteSessiePerStudent({
    studentIds: ['stu-1'],
    client: clientMet({
      sessies: [
        { id: 'geen-tijd', start_tijd: null, status: 'gepland', student_id: 'stu-1' },
        ses('a', '2026-09-02T10:00:00.000Z', 'gepland'),
      ],
    }),
  });
  assert.equal(r.perStudent.get('stu-1').id, 'a');
});

// ── 9) Contract-tests op de crons ───────────────────────────────────────────
//
// Deze twee crons zijn niet zonder databank te draaien. Wat er stil fout kan
// gaan, bewaken we daarom op broncode-niveau: verdwijnt een van deze regels,
// dan wordt de test rood in plaats van dat een klant of een mentor het merkt.

const AFRONDEN = readFileSync(
  new URL('../api/cron/onboarding-eerste-sessie-afronden.js', import.meta.url), 'utf8');
const NOSHOW = readFileSync(
  new URL('../api/cron/noshow-detect.js', import.meta.url), 'utf8');

test('CONTRACT: een gemiste EERSTE call krijgt een eigen signaaltype', () => {
  assert.match(NOSHOW, /eerste_call_no_show/,
    'zonder eigen type is een gemiste eerste call niet te onderscheiden van '
    + 'een gewone no-show, terwijl de reden een andere is');
});

test('CONTRACT: het afsluiten is idempotent op auto_afgerond_sessie_id', () => {
  // Twee sloten: de voorcontrole en een optimistische voorwaarde op de
  // update zelf. Valt er een weg, dan kan een handmatig heropende onboarding
  // opnieuw dichtgetrokken worden door dezelfde sessie.
  assert.match(AFRONDEN, /if \(ob\.auto_afgerond_sessie_id\)/,
    'de voorcontrole op auto_afgerond_sessie_id ontbreekt');
  assert.match(AFRONDEN, /\.is\('auto_afgerond_sessie_id', null\)/,
    'de optimistische voorwaarde op de update ontbreekt');
});

test('CONTRACT: bij afsluiten wordt de OORZAAK vastgelegd', () => {
  // Een onboarding die 'afgerond' zegt zonder aanwijsbare oorzaak is precies
  // het schermsoort dat dit project twee keer een halve dag heeft gekost.
  for (const veld of ['auto_afgerond_sessie_id', 'auto_afgerond_sessie_op', 'auto_afgerond_op']) {
    assert.ok(AFRONDEN.includes(veld + ':'),
      'het veld ' + veld + ' wordt niet weggeschreven bij het afsluiten');
  }
});

test('CONTRACT: eerste run zet alleen het watermerk en doet verder niets', () => {
  assert.match(AFRONDEN, /result\.initialized = true/,
    'zonder init-tak loopt een eerste uitrol in één klap over de hele historie');
});

test('CONTRACT: een droogloop schrijft nooit', () => {
  assert.match(AFRONDEN, /if \(dry\)/, 'geen droogloop-tak gevonden');
  assert.match(AFRONDEN, /!dry && highestMs > oudMs/,
    'een droogloop mag het watermerk niet verzetten');
});

test('CONTRACT: een eigen periode werkt ALLEEN in een droogloop', () => {
  assert.match(AFRONDEN, /dry && typeof req\.query\?\.since/,
    'zonder deze koppeling kan een echte run breder lopen dan het watermerk');
});

test('CONTRACT: beide crons stoppen bij een onleesbare bron', () => {
  for (const [naam, bron] of [['afronden', AFRONDEN], ['noshow-detect', NOSHOW]]) {
    assert.match(bron, /bron_status !== BRON_GELEZEN/,
      naam + ': een mislukte bevraging wordt niet onderscheiden van een lege uitkomst');
  }
});
