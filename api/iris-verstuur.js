// api/iris-verstuur.js
//
// Goedkeuren, ongedaan maken, versturen.
//
//   POST { actie: 'goedkeuren', concept_id, eigen_naam?, template_naam?, template_vars? }
//   POST { actie: 'ongedaan',   concept_id }
//   POST { actie: 'annuleren',  concept_id }
//
// Recht: iris.versturen.
//
// ── HET ONGEDAAN-VENSTER, EN WAAROM HET GEEN CRON IS ─────────────────────────
// Goedkeuren zet het concept op 'goedgekeurd' met `verstuur_na` op nu plus
// dertig seconden. Binnen die dertig seconden kan het nog terug. Daarna gaat
// het weg.
//
// De opdracht is hier uitdrukkelijk: "daarna vertrekt het bericht meteen, niet
// bij een volgende ronde". Een cron die elke vijf minuten draait, zou gemiddeld
// tweeënhalve minuut vertraging geven. Iemand die op Verstuur drukt en drie
// minuten later ziet dat er nog niets weg is, drukt nog een keer.
//
// Dus: dit verzoek plant de verzending zelf in met waitUntil(). De functie
// geeft meteen antwoord aan de browser, wacht dertig seconden, kijkt of het
// concept nog steeds op 'goedgekeurd' staat, en verstuurt. Diezelfde
// voorwaarde is wat 'ongedaan' gebruikt: die zet de status op 'geannuleerd',
// en dan vindt de wachtende taak niets meer om te versturen.
//
// waitUntil is hetzelfde patroon dat inbox-webhook.js al gebruikt. Wat als de
// functie tussendoor sneuvelt? Dan blijft het concept op 'goedgekeurd' staan
// met een verstuur_na in het verleden, en pikt cron-iris-werk het op. Dat
// vangnet mag traag zijn; het is er voor het geval dat, niet voor het geval
// gewoon.
//
// ── DE CLAIM ─────────────────────────────────────────────────────────────────
// Versturen gebeurt achter een voorwaardelijke update: status van
// 'goedgekeurd' naar 'verzonden' lukt maar één keer. Wint de wachtende taak,
// dan vindt de cron niets; wint de cron, dan vindt de taak niets. Geen
// vergrendeling nodig, geen tellers — dezelfde truc als
// cron-dunning-bulk-send gebruikt.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalInstellingen, leesOngedaanSeconden } from './_lib/iris/instellingen.js';
import { keurVerzending, verstuurWhatsapp, verstuurMail } from './_lib/iris/verzend.js';
import { zetOndertekening } from './_lib/iris/toon.js';
import { waitUntil } from '@vercel/functions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'iris.versturen'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.versturen)' });
  }

  const body = req.body || {};
  const actie = String(body.actie || '').trim();
  const conceptId = String(body.concept_id || '').trim();
  if (!UUID_RE.test(conceptId)) return res.status(400).json({ error: 'concept_id moet een geldige uuid zijn' });

  try {
    if (actie === 'ongedaan' || actie === 'annuleren') {
      return await zetTerug(conceptId, user, actie, res);
    }
    if (actie === 'goedkeuren') {
      return await keurGoed(conceptId, user, body, res);
    }
    return res.status(400).json({ error: `onbekende actie: ${actie || '(leeg)'}` });
  } catch (e) {
    console.error('[iris-verstuur]', actie, e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ── Ongedaan maken ───────────────────────────────────────────────────────────

async function zetTerug(conceptId, user, actie, res) {
  // De voorwaarde op status is wat dit veilig maakt. Is het bericht al weg
  // (status 'verzonden'), dan raakt deze update niets — en dan zeggen we dat
  // ook, in plaats van te doen alsof het gelukt is.
  const toegestaan = actie === 'ongedaan' ? ['goedgekeurd'] : ['klaar', 'goedgekeurd'];
  const { data, error } = await supabaseAdmin
    .from('iris_concepten')
    .update({ status: 'geannuleerd', bijgewerkt_op: new Date().toISOString() })
    .eq('id', conceptId)
    .in('status', toegestaan)
    .select('id, gesprek_id, status')
    .maybeSingle();
  if (error) throw new Error('annuleren: ' + error.message);

  if (!data) {
    const { data: huidig } = await supabaseAdmin
      .from('iris_concepten')
      .select('status, verzonden_op')
      .eq('id', conceptId)
      .maybeSingle();
    if (huidig?.status === 'verzonden') {
      return res.status(409).json({
        error: 'Te laat',
        uitleg: 'Dit bericht is al verstuurd. Terughalen kan niet meer.',
        verzonden_op: huidig.verzonden_op,
      });
    }
    return res.status(404).json({ error: 'Concept niet gevonden of al geannuleerd' });
  }

  const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
    wie: user.id,
    wat: actie === 'ongedaan' ? 'verzending ongedaan gemaakt' : 'concept geannuleerd',
    gesprek_id: data.gesprek_id,
    resultaat: 'ok',
  });
  if (logFout) console.warn('[iris-verstuur] logregel mislukt:', logFout.message);

  return res.status(200).json({ ok: true, status: 'geannuleerd' });
}

// ── Goedkeuren ───────────────────────────────────────────────────────────────

async function keurGoed(conceptId, user, body, res) {
  const { data: concept, error } = await supabaseAdmin
    .from('iris_concepten')
    .select('id, gesprek_id, kanaal, onderwerp, tekst, status, template_naam, template_vars')
    .eq('id', conceptId)
    .maybeSingle();
  if (error) throw new Error('concept: ' + error.message);
  if (!concept) return res.status(404).json({ error: 'Concept niet gevonden' });
  if (concept.status !== 'klaar') {
    return res.status(409).json({
      error: 'Dit concept staat niet klaar',
      status: concept.status,
      uitleg: concept.status === 'verzonden' ? 'Het is al verstuurd.' : `Status is "${concept.status}".`,
    });
  }

  const { data: gesprek, error: gFout } = await supabaseAdmin
    .from('iris_gesprekken')
    .select('id, contact_id, kanaal, extern_id, categorie, laatste_inbound')
    .eq('id', concept.gesprek_id)
    .maybeSingle();
  if (gFout) throw new Error('gesprek: ' + gFout.message);
  if (!gesprek) return res.status(404).json({ error: 'Gesprek niet gevonden' });

  const instellingen = await haalInstellingen(supabaseAdmin);

  // De ondertekening kan bij het goedkeuren nog veranderen: de opdracht laat
  // Maxim uitdrukkelijk zijn eigen naam kiezen in plaats van de bedrijfsnaam.
  const eigenNaam = body.eigen_naam ? String(body.eigen_naam).trim().slice(0, 60) : null;
  const tekst = eigenNaam
    ? zetOndertekening(concept.tekst || '', { kanaal: concept.kanaal, eigenNaam })
    : (concept.tekst || '');

  const templateNaam = body.template_naam ? String(body.template_naam).trim() : concept.template_naam;
  const templateVars = Array.isArray(body.template_vars) ? body.template_vars : (concept.template_vars || []);

  // De poort. Bij een mens tellen de stille uren en de dosering niet mee, maar
  // [invullen] en de tekstgrenzen wél.
  const keuring = keurVerzending({
    tekst,
    kanaal: concept.kanaal,
    laatsteInbound: gesprek.laatste_inbound,
    stilleUrenInstelling: instellingen.stille_uren,
    doorMens: true,
    nu: new Date(),
  });

  if (!keuring.mag) {
    return res.status(422).json({
      error: 'Dit bericht kan niet verstuurd worden',
      blokkades: keuring.blokkades,
      waarschuwingen: keuring.waarschuwingen,
    });
  }
  if (keuring.vorm === 'template' && !templateNaam) {
    return res.status(422).json({
      error: 'Het venster van 24 uur is dicht',
      uitleg: 'Buiten het venster mag alleen een goedgekeurde template. Kies er een.',
      blokkades: ['Het venster is dicht en er is geen template gekozen.'],
    });
  }

  const seconden = leesOngedaanSeconden(instellingen.ongedaan_seconden);
  const verstuurNa = new Date(Date.now() + seconden * 1000);

  const { data: goedgekeurd, error: uFout } = await supabaseAdmin
    .from('iris_concepten')
    .update({
      status: 'goedgekeurd',
      tekst,
      template_naam: templateNaam || null,
      template_vars: templateVars.length ? templateVars : null,
      verstuur_na: verstuurNa.toISOString(),
      verzonden_door: user.id,
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', conceptId)
    .eq('status', 'klaar')
    .select('id')
    .maybeSingle();
  if (uFout) throw new Error('goedkeuren: ' + uFout.message);
  if (!goedgekeurd) {
    // Iemand anders was ons voor in dezelfde seconde.
    return res.status(409).json({ error: 'Dit concept is intussen door iemand anders opgepakt' });
  }

  // De verzending zelf. Niet awaiten: de browser krijgt meteen antwoord en de
  // aftelling begint zichtbaar te lopen.
  try {
    waitUntil(wachtEnVerstuur(conceptId, seconden));
  } catch (e) {
    // waitUntil bestaat niet buiten Vercel. Dan valt het terug op de cron, en
    // dat is precies waar die voor is.
    console.warn('[iris-verstuur] waitUntil niet beschikbaar, de cron pikt het op:', e?.message || e);
  }

  return res.status(200).json({
    ok: true,
    status: 'goedgekeurd',
    verstuur_na: verstuurNa.toISOString(),
    ongedaan_seconden: seconden,
    waarschuwingen: keuring.waarschuwingen,
    vorm: keuring.vorm,
  });
}

// ── Wachten en dan versturen ─────────────────────────────────────────────────

async function wachtEnVerstuur(conceptId, seconden) {
  await new Promise((r) => setTimeout(r, seconden * 1000 + 200));
  try {
    await verstuurConcept(conceptId);
  } catch (e) {
    console.error('[iris-verstuur] verzending na wachten mislukt:', e?.message || e);
  }
}

/**
 * Verstuur één goedgekeurd concept.
 *
 * Wordt aangeroepen door de wachtende taak én door cron-iris-werk. De
 * voorwaardelijke update hieronder zorgt dat er maar één van de twee wint.
 * Geëxporteerd zodat de cron hem kan gebruiken.
 */
export async function verstuurConcept(conceptId) {
  // De claim. Van 'goedgekeurd' naar 'verzonden' lukt precies één keer.
  // Zou dit een gewone update zijn zonder de status-voorwaarde, dan kon een
  // bericht bij een samenloop twee keer vertrekken — en een dubbele aanmaning
  // is het soort fout waar een klant over belt.
  const { data: geclaimd, error: claimFout } = await supabaseAdmin
    .from('iris_concepten')
    .update({ status: 'verzonden', verzonden_op: new Date().toISOString() })
    .eq('id', conceptId)
    .eq('status', 'goedgekeurd')
    .select('id, gesprek_id, kanaal, onderwerp, tekst, template_naam, template_vars, verzonden_door')
    .maybeSingle();
  if (claimFout) throw new Error('claim: ' + claimFout.message);
  if (!geclaimd) return { ok: false, reden: 'niet_geclaimd' };

  // Vanaf hier is het concept geclaimd. Gaat het versturen mis, dan zetten we
  // hem op 'mislukt' — NIET terug op 'goedgekeurd'. Anders zou de cron het
  // eindeloos blijven proberen met een bericht dat structureel niet weg kan,
  // en dat is precies hoe je bij Meta een slechte beoordeling verdient.
  try {
    const { data: gesprek } = await supabaseAdmin
      .from('iris_gesprekken')
      .select('id, contact_id, kanaal, extern_id, laatste_inbound, categorie')
      .eq('id', geclaimd.gesprek_id)
      .maybeSingle();
    if (!gesprek) throw new Error('gesprek niet gevonden');

    const contact = gesprek.contact_id
      ? (await supabaseAdmin.from('iris_contacten')
          .select('emails, telefoons').eq('id', gesprek.contact_id).maybeSingle()).data
      : null;

    let uit;
    if (geclaimd.kanaal === 'whatsapp') {
      // Het nummer staat op de conversatie in whatsapp_conversations; die is
      // de bron, niet het contact. Een contact kan twee nummers hebben, en dan
      // moet het antwoord naar het nummer waar het gesprek op loopt.
      const { data: conv } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('phone_number, phone_number_id')
        .eq('id', gesprek.extern_id)
        .maybeSingle();
      const naar = conv?.phone_number || contact?.telefoons?.[0];
      if (!naar) throw new Error('geen telefoonnummer');

      const binnenVenster = gesprek.laatste_inbound
        && (Date.now() - new Date(gesprek.laatste_inbound).getTime()) < 24 * 3600 * 1000;

      uit = await verstuurWhatsapp({
        naar,
        tekst: geclaimd.tekst,
        vorm: binnenVenster ? 'tekst' : 'template',
        templateNaam: geclaimd.template_naam,
        templateVars: geclaimd.template_vars || [],
        phoneNumberId: conv?.phone_number_id || null,
      });
    } else {
      const naar = gesprek.extern_id || contact?.emails?.[0];
      if (!naar) throw new Error('geen e-mailadres');
      const instellingen = await haalInstellingen(supabaseAdmin);
      const vanMailbox = instellingen.mailboxen?.afzender_per_categorie?.[gesprek.categorie]
        || instellingen.mailboxen?.standaard
        || 'administratie@deforexopleiding.nl';
      uit = await verstuurMail({
        vanMailbox,
        naar,
        onderwerp: geclaimd.onderwerp || 'Bericht van De Forex Opleiding',
        tekst: geclaimd.tekst,
      });
    }

    if (!uit.ok) throw new Error(`${uit.code}: ${uit.fout}`);

    await supabaseAdmin
      .from('iris_concepten')
      .update({ extern_id: uit.extern_id || null, fout: null })
      .eq('id', conceptId);

    await supabaseAdmin
      .from('iris_gesprekken')
      .update({
        status: 'wacht_op_klant',
        laatste_outbound: new Date().toISOString(),
        bijgewerkt_op: new Date().toISOString(),
      })
      .eq('id', geclaimd.gesprek_id);

    const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
      wie: geclaimd.verzonden_door || null,
      wat: 'bericht verstuurd',
      gesprek_id: geclaimd.gesprek_id,
      contact_id: gesprek.contact_id,
      kanaal: geclaimd.kanaal,
      resultaat: 'ok',
      details: { tekens: (geclaimd.tekst || '').length, template: geclaimd.template_naam || null },
    });
    if (logFout) console.warn('[iris-verstuur] logregel mislukt:', logFout.message);

    return { ok: true, extern_id: uit.extern_id };
  } catch (e) {
    const tekst = e?.message || String(e);
    console.error('[iris-verstuur] versturen mislukt:', tekst);
    await supabaseAdmin
      .from('iris_concepten')
      .update({ status: 'mislukt', fout: tekst.slice(0, 500) })
      .eq('id', conceptId);
    const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
      wie: geclaimd.verzonden_door || null,
      wat: 'bericht verstuurd',
      gesprek_id: geclaimd.gesprek_id,
      kanaal: geclaimd.kanaal,
      resultaat: 'mislukt',
      fout: tekst.slice(0, 500),
    });
    if (logFout) console.warn('[iris-verstuur] logregel mislukt:', logFout.message);
    return { ok: false, fout: tekst };
  }
}

// De doseerpoort (alGestuurdVandaag + maxPerDag in keurVerzending) staat er
// wel, maar wordt vanuit dit bestand niet aangeroepen — en dat is juist.
// Alles wat hier langskomt is door een MENS goedgekeurd, en de dosering gaat
// over aandringen door software, niet over een collega die drie keer moet
// reageren. Zodra er een pad komt waarin Iris uit zichzelf verstuurt (de stand
// 'zelf' per categorie), hoort dat pad keurVerzending aan te roepen MET
// doorMens: false en met de dagteller erbij. Daar staat deze notitie voor.
