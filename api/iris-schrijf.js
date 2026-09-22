// api/iris-schrijf.js
//
// Een concept maken uit een instructie.
//
//   POST { gesprek_id, instructie?, instructie_bron?, kanaal?, concept_id? }
//
// Recht: iris.post.beantwoorden.
//
// `concept_id` maakt van dit endpoint ook de "pas aan"-knop: een bestaand
// concept wordt overschreven met een nieuwe poging op basis van een nieuwe
// instructie. Er komt dus geen rij bij elke herformulering — anders staat de
// lijst na drie pogingen vol met concepten die niemand meer wil.
//
// Het concept wordt ALTIJD opgeslagen, ook als de poort hem tegenhoudt. Een
// concept met [invullen] erin is precies wat een mens moet zien: dan weet hij
// welk gegeven ontbreekt. Weggooien zou betekenen dat hij een leeg scherm
// krijgt en zelf moet raden wat er misging.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
import { haalInstellingen, magConceptSchrijven } from './_lib/iris/instellingen.js';
import { bouwDossier } from './_lib/iris/dossier.js';
import { schrijfConcept } from './_lib/iris/schrijf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INSTRUCTIE = 2000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Alleen POST' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY niet geconfigureerd',
      uitleg: 'Iris schrijft via Anthropic. Zonder sleutel kan er wel getypt worden.',
    });
  }

  const body = req.body || {};
  const gesprekId = String(body.gesprek_id || '').trim();
  const conceptId = String(body.concept_id || '').trim();
  const instructie = String(body.instructie || '').trim().slice(0, MAX_INSTRUCTIE);
  const instructieBron = ['spraak', 'tekst', 'auto'].includes(body.instructie_bron)
    ? body.instructie_bron : 'tekst';

  if (!UUID_RE.test(gesprekId)) return res.status(400).json({ error: 'gesprek_id moet een geldige uuid zijn' });
  if (conceptId && !UUID_RE.test(conceptId)) return res.status(400).json({ error: 'concept_id moet een geldige uuid zijn' });

  try {
    const { data: gesprek, error: gFout } = await supabaseAdmin
      .from('iris_gesprekken')
      .select('id, contact_id, kanaal, categorie, status, laatste_inbound')
      .eq('id', gesprekId)
      .maybeSingle();
    if (gFout) throw new Error('gesprek: ' + gFout.message);
    if (!gesprek) return res.status(404).json({ error: 'Gesprek niet gevonden' });

    const kanaal = ['whatsapp', 'email'].includes(body.kanaal) ? body.kanaal : gesprek.kanaal;

    const instellingen = await haalInstellingen(supabaseAdmin);

    // Schrijven mag altijd als een MENS erom vraagt. De autonomie-instelling
    // gaat over wat Iris uit zichzelf doet; hem hier laten blokkeren zou
    // betekenen dat een medewerker geen hulp kan vragen zolang de schakelaar
    // uit staat, en dan valt er nooit iets te beoordelen.
    const uitZichzelf = instructieBron === 'auto';
    if (uitZichzelf && !magConceptSchrijven(instellingen.autonomie, gesprek.categorie)) {
      return res.status(200).json({
        overgeslagen: true,
        reden: `De autonomie voor "${gesprek.categorie || 'onbekend'}" staat uit.`,
      });
    }

    const [contact, berichten, joostKennis] = await Promise.all([
      gesprek.contact_id
        ? supabaseAdmin.from('iris_contacten')
            .select('id, customer_id, onboarding_id, hlms_student_id, emails, telefoons, koppelstatus, koppel_reden, weergavenaam')
            .eq('id', gesprek.contact_id).maybeSingle().then((r) => r.data)
        : Promise.resolve(null),
      supabaseAdmin.from('iris_berichten')
        .select('richting, tekst_kort, ontvangen_op')
        .eq('gesprek_id', gesprekId)
        .order('ontvangen_op', { ascending: false })
        .limit(8)
        .then((r) => (r.data || []).reverse()),
      // De vaste bedrijfsgegevens staan al in joost_config.knowledge_base —
      // IBAN, betaalmogelijkheden, openingstijden. Die opnieuw ergens neerzetten
      // zou betekenen dat een wijziging op twee plekken moet.
      supabaseAdmin.from('joost_config')
        .select('knowledge_base')
        .eq('module', 'finance').maybeSingle()
        .then((r) => r.data?.knowledge_base || null)
        .catch(() => null),
    ]);

    const dossier = contact
      ? await bouwDossier(supabaseAdmin, contact, { lmsClient: getDfoLmsClient() })
      : null;

    const laatsteInbound = [...berichten].reverse().find((b) => b.richting === 'in');

    const uit = await schrijfConcept({
      kanaal,
      categorie: gesprek.categorie,
      dossier,
      kennis: joostKennis,
      voorgeschiedenis: berichten,
      laatsteBericht: laatsteInbound?.tekst_kort || null,
      instructie: instructie || null,
      model: instellingen.model?.redeneren,
      temperatuur: instellingen.model?.temperatuur,
    });

    if (!uit.ok) {
      return res.status(502).json({ error: 'Schrijven mislukt', uitleg: uit.fout });
    }

    const c = uit.concept;

    // Ook een concept dat de poort niet haalt, wordt opgeslagen. Dat is het
    // punt: een mens moet kunnen zien wat er ontbrak.
    const rij = {
      gesprek_id: gesprekId,
      instructie: instructie || null,
      instructie_bron: instructieBron,
      kanaal,
      onderwerp: c.onderwerp || null,
      tekst: c.tekst || null,
      status: 'klaar',
      bijgewerkt_op: new Date().toISOString(),
    };

    let opgeslagen;
    if (conceptId) {
      // Een bestaand concept overschrijven mag alleen zolang het nog niet weg
      // is. Een verzonden bericht is niet meer te herschrijven, en een
      // geannuleerd concept opnieuw vullen zou de annulering ongedaan maken.
      const { data, error } = await supabaseAdmin
        .from('iris_concepten')
        .update(rij)
        .eq('id', conceptId)
        .eq('status', 'klaar')
        .select('*')
        .maybeSingle();
      if (error) throw new Error('concept bijwerken: ' + error.message);
      if (!data) {
        return res.status(409).json({
          error: 'Dit concept is niet meer aan te passen',
          uitleg: 'Het is intussen verstuurd of geannuleerd. Maak een nieuw concept.',
        });
      }
      opgeslagen = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('iris_concepten')
        .insert(rij)
        .select('*')
        .single();
      if (error) throw new Error('concept opslaan: ' + error.message);
      opgeslagen = data;
    }

    const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
      wie: user.id,
      wat: conceptId ? 'concept aangepast' : 'concept geschreven',
      gesprek_id: gesprekId,
      contact_id: gesprek.contact_id,
      kanaal,
      resultaat: c.mag_verstuurd_worden ? 'klaar' : 'tegengehouden',
      details: {
        bron: instructieBron,
        gaten: c.heeft_gaten || false,
        blokkades: c.blokkades.length,
        waarschuwingen: c.waarschuwingen.length,
      },
    });
    if (logFout) console.warn('[iris-schrijf] logregel mislukt:', logFout.message);

    return res.status(200).json({
      concept: opgeslagen,
      mag_verstuurd_worden: c.mag_verstuurd_worden,
      blokkades: c.blokkades,
      waarschuwingen: c.waarschuwingen,
      ontbrekende_gegevens: c.ontbrekende_gegevens,
      toelichting: c.toelichting,
      mens_nodig: !!uit.mensNodig,
    });
  } catch (e) {
    console.error('[iris-schrijf]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
