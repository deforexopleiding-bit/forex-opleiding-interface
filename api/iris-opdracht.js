// api/iris-opdracht.js
//
// Opdrachten: aanmaken, beantwoorden, afsluiten, terug openen.
//
//   GET  ?actie=lijst&status=…
//   GET  ?actie=een&id=<uuid>
//   POST { actie: 'maak',       vraag, bron? }
//   POST { actie: 'antwoord',   id, antwoord }
//   POST { actie: 'afsluiten',  id, met_onverstuurd: 'versturen'|'niet_versturen' }
//   POST { actie: 'heropenen',  id }
//   POST { actie: 'afbreken',   id }
//
// Recht: iris.post.beantwoorden voor lezen en maken, iris.versturen voor
// afsluiten met versturen.
//
// ── AFSLUITEN IS HET SCHERPE PUNT ────────────────────────────────────────────
// "Geregeld" drukken terwijl er nog een concept klaarstaat, is precies waar
// dingen stil verdwijnen. Dus: dit endpoint WEIGERT een afsluiting zolang er
// onverstuurde concepten aan de opdracht hangen, tenzij er uitdrukkelijk bij
// staat wat ermee moet. Twee antwoorden, allebei een keuze, geen van beide de
// standaard.
//
// Een afgesloten opdracht blijft zichtbaar en is terug te openen. Weg is
// nergens.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalInstellingen } from './_lib/iris/instellingen.js';
import { maakPlan, volgendeToestand, magDirectUitvoeren, verloopRegel, TOESTANDEN } from './_lib/iris/opdracht.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VRAAG = 2000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
  }

  try {
    if (req.method === 'GET') {
      const actie = String(req.query?.actie || 'lijst');
      if (actie === 'een') return await geefEen(req, res);
      return await geefLijst(req, res);
    }
    if (req.method === 'POST') {
      const actie = String(req.body?.actie || '').trim();
      if (actie === 'maak') return await maak(req, res, user);
      if (actie === 'antwoord') return await antwoord(req, res, user);
      if (actie === 'afsluiten') return await afsluiten(req, res, user);
      if (actie === 'heropenen') return await heropenen(req, res, user);
      if (actie === 'afbreken') return await afbreken(req, res, user);
      return res.status(400).json({ error: `onbekende actie: ${actie || '(leeg)'}` });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Alleen GET en POST' });
  } catch (e) {
    console.error('[iris-opdracht]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ── Lezen ────────────────────────────────────────────────────────────────────

async function geefLijst(req, res) {
  const status = String(req.query?.status || '').trim();
  let vraag = supabaseAdmin
    .from('iris_opdrachten')
    .select('id, vraag, titel, status, vraag_aan_maxim, opties, na_uitvoeren, aangemaakt_op, bijgewerkt_op')
    .order('aangemaakt_op', { ascending: false })
    .limit(100);
  if (status && TOESTANDEN.includes(status)) vraag = vraag.eq('status', status);
  // Een afgeronde opdracht blijft zichtbaar — "weg is nergens". Maar hij staat
  // wel onderaan, en alleen als er niet op status gefilterd is.
  const { data, error } = await vraag;
  if (error) throw new Error('opdrachten: ' + error.message);
  return res.status(200).json({ items: data || [], toestanden: TOESTANDEN });
}

async function geefEen(req, res) {
  const id = String(req.query?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const { data: opdracht, error } = await supabaseAdmin
    .from('iris_opdrachten').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('opdracht: ' + error.message);
  if (!opdracht) return res.status(404).json({ error: 'Opdracht niet gevonden' });

  const { data: acties } = await supabaseAdmin
    .from('iris_acties')
    .select('id, type, parameters, status, uitgevoerd_op, resultaat, fout, aangemaakt_op')
    .eq('opdracht_id', id)
    .order('aangemaakt_op', { ascending: true });

  return res.status(200).json({ opdracht, acties: acties || [] });
}

// ── Maken ────────────────────────────────────────────────────────────────────

async function maak(req, res, user) {
  const vraag = String(req.body?.vraag || '').trim().slice(0, MAX_VRAAG);
  if (!vraag) return res.status(400).json({ error: 'vraag vereist' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
  }

  const instellingen = await haalInstellingen(supabaseAdmin);

  // De rij komt er eerst, met het plan nog leeg. Zo staat een opdracht die
  // tijdens het uitzoeken sneuvelt toch in de lijst, met een zichtbare
  // toestand — in plaats van nergens.
  const { data: rij, error: maakFout } = await supabaseAdmin
    .from('iris_opdrachten')
    .insert({
      vraag,
      status: 'uitzoeken',
      aangemaakt_door: user.id,
      verloop: [verloopRegel('opdracht gegeven', { wie: user.id })],
    })
    .select('*')
    .single();
  if (maakFout) throw new Error('opdracht opslaan: ' + maakFout.message);

  const uit = await maakPlan({
    vraag,
    model: instellingen.model?.redeneren,
    temperatuur: instellingen.model?.temperatuur,
  });

  if (!uit.ok) {
    await supabaseAdmin
      .from('iris_opdrachten')
      .update({
        status: 'afgebroken',
        verloop: [...(rij.verloop || []), verloopRegel('uitzoeken mislukt: ' + uit.fout)],
        bijgewerkt_op: new Date().toISOString(),
      })
      .eq('id', rij.id);
    return res.status(502).json({ error: 'Uitzoeken mislukt', uitleg: uit.fout, opdracht_id: rij.id });
  }

  const plan = uit.plan;
  const direct = magDirectUitvoeren(plan);

  const { data: bijgewerkt, error: bijFout } = await supabaseAdmin
    .from('iris_opdrachten')
    .update({
      titel: plan.titel,
      plan,
      status: volgendeToestand(plan),
      vraag_aan_maxim: plan.vraag,
      opties: plan.opties?.length ? plan.opties : null,
      verloop: [
        ...(rij.verloop || []),
        verloopRegel('plan gemaakt', { details: { stappen: plan.stappen.length, groep: plan.raakt_groep } }),
        ...(plan.geweigerde_stappen?.length
          ? [verloopRegel('stappen geweigerd: ' + plan.geweigerde_stappen.join(', '))]
          : []),
      ],
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', rij.id)
    .select('*')
    .single();
  if (bijFout) throw new Error('plan opslaan: ' + bijFout.message);

  return res.status(200).json({
    opdracht: bijgewerkt,
    plan,
    mag_direct: direct.mag,
    reden: direct.reden,
  });
}

// ── Antwoorden op de ene vraag ───────────────────────────────────────────────

async function antwoord(req, res, user) {
  const id = String(req.body?.id || '').trim();
  const tekst = String(req.body?.antwoord || '').trim().slice(0, 1000);
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });
  if (!tekst) return res.status(400).json({ error: 'antwoord vereist' });

  const { data: opdracht, error } = await supabaseAdmin
    .from('iris_opdrachten').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('opdracht: ' + error.message);
  if (!opdracht) return res.status(404).json({ error: 'Opdracht niet gevonden' });

  const instellingen = await haalInstellingen(supabaseAdmin);

  // Het antwoord gaat terug naar het model, samen met de oorspronkelijke
  // opdracht. Niet als los briefje: zonder de oorspronkelijke vraag erbij
  // weet het model niet waar het antwoord op slaat.
  const uit = await maakPlan({
    vraag: opdracht.vraag,
    context: {
      eerder_gevraagd: opdracht.vraag_aan_maxim,
      antwoord: tekst,
      eerder_plan: opdracht.plan,
    },
    model: instellingen.model?.redeneren,
    temperatuur: instellingen.model?.temperatuur,
  });

  if (!uit.ok) {
    return res.status(502).json({ error: 'Opnieuw uitzoeken mislukt', uitleg: uit.fout });
  }

  const { data: bijgewerkt, error: bijFout } = await supabaseAdmin
    .from('iris_opdrachten')
    .update({
      titel: uit.plan.titel,
      plan: uit.plan,
      antwoord_maxim: tekst,
      vraag_aan_maxim: uit.plan.vraag,
      opties: uit.plan.opties?.length ? uit.plan.opties : null,
      status: volgendeToestand(uit.plan),
      verloop: [...(opdracht.verloop || []), verloopRegel(`beantwoord: ${tekst.slice(0, 80)}`, { wie: user.id })],
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (bijFout) throw new Error('antwoord opslaan: ' + bijFout.message);

  const direct = magDirectUitvoeren(uit.plan);
  return res.status(200).json({ opdracht: bijgewerkt, plan: uit.plan, mag_direct: direct.mag, reden: direct.reden });
}

// ── Afsluiten ────────────────────────────────────────────────────────────────

async function afsluiten(req, res, user) {
  const id = String(req.body?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const keuze = String(req.body?.met_onverstuurd || '').trim();

  // Wat staat er nog klaar? Dit is de kern van dit endpoint.
  const { data: acties, error: aFout } = await supabaseAdmin
    .from('iris_acties')
    .select('id, type, status, concept_id')
    .eq('opdracht_id', id)
    .in('status', ['klaar', 'goedgekeurd']);
  if (aFout) throw new Error('acties: ' + aFout.message);

  const open = acties || [];
  if (open.length && !['versturen', 'niet_versturen'].includes(keuze)) {
    // Geen standaard. Er moet gekozen worden, want allebei de keuzes zijn een
    // beslissing — en een standaard zou die beslissing onzichtbaar maken.
    return res.status(409).json({
      error: 'Er staat nog iets klaar',
      uitleg: `Er ${open.length === 1 ? 'staat nog 1 stap' : `staan nog ${open.length} stappen`} klaar bij deze opdracht. Wat moet daarmee gebeuren?`,
      openstaand: open.map((a) => ({ id: a.id, type: a.type })),
      keuzes: [
        { waarde: 'versturen', label: 'Alsnog versturen en dan afsluiten' },
        { waarde: 'niet_versturen', label: 'Niet versturen, gewoon afsluiten' },
      ],
    });
  }

  if (open.length && keuze === 'versturen') {
    if (!(await requirePermission(req, 'iris.versturen'))) {
      return res.status(403).json({ error: 'Geen rechten om te versturen (iris.versturen)' });
    }
    // De uitvoering zelf loopt via iris-actie; hier zetten we ze alleen op
    // goedgekeurd. Zo blijft er maar één plek waar een actie daadwerkelijk
    // uitgevoerd wordt.
    const { error } = await supabaseAdmin
      .from('iris_acties')
      .update({ status: 'goedgekeurd' })
      .eq('opdracht_id', id)
      .eq('status', 'klaar');
    if (error) throw new Error('acties goedkeuren: ' + error.message);
  }

  if (open.length && keuze === 'niet_versturen') {
    const { error } = await supabaseAdmin
      .from('iris_acties')
      .update({ status: 'geannuleerd' })
      .eq('opdracht_id', id)
      .in('status', ['klaar', 'goedgekeurd']);
    if (error) throw new Error('acties annuleren: ' + error.message);
  }

  const { data: opdracht } = await supabaseAdmin
    .from('iris_opdrachten').select('verloop').eq('id', id).maybeSingle();

  const { data: bijgewerkt, error: bijFout } = await supabaseAdmin
    .from('iris_opdrachten')
    .update({
      status: 'geregeld',
      na_uitvoeren: 'geregeld',
      verloop: [
        ...(opdracht?.verloop || []),
        verloopRegel(open.length
          ? `afgesloten, ${open.length} openstaande stap(pen) ${keuze === 'versturen' ? 'alsnog verstuurd' : 'niet verstuurd'}`
          : 'afgesloten', { wie: user.id }),
      ],
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (bijFout) throw new Error('afsluiten: ' + bijFout.message);

  return res.status(200).json({ opdracht: bijgewerkt, openstaand_afgehandeld: open.length });
}

// ── Terug openen ─────────────────────────────────────────────────────────────

async function heropenen(req, res, user) {
  const id = String(req.body?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const { data: opdracht } = await supabaseAdmin
    .from('iris_opdrachten').select('verloop, status').eq('id', id).maybeSingle();
  if (!opdracht) return res.status(404).json({ error: 'Opdracht niet gevonden' });

  const { data, error } = await supabaseAdmin
    .from('iris_opdrachten')
    .update({
      status: 'wacht_op_ok',
      na_uitvoeren: null,
      verloop: [...(opdracht.verloop || []), verloopRegel('terug geopend', { wie: user.id })],
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error('heropenen: ' + error.message);
  return res.status(200).json({ opdracht: data });
}

async function afbreken(req, res, user) {
  const id = String(req.body?.id || '').trim();
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id moet een geldige uuid zijn' });

  const { data: opdracht } = await supabaseAdmin
    .from('iris_opdrachten').select('verloop').eq('id', id).maybeSingle();
  if (!opdracht) return res.status(404).json({ error: 'Opdracht niet gevonden' });

  // Afbreken annuleert ook wat er klaarstond. Anders blijft er werk hangen
  // aan een opdracht die niemand meer bekijkt.
  const { error: aFout } = await supabaseAdmin
    .from('iris_acties')
    .update({ status: 'geannuleerd' })
    .eq('opdracht_id', id)
    .in('status', ['klaar', 'goedgekeurd']);
  if (aFout) console.warn('[iris-opdracht] acties annuleren:', aFout.message);

  const { data, error } = await supabaseAdmin
    .from('iris_opdrachten')
    .update({
      status: 'afgebroken',
      verloop: [...(opdracht.verloop || []), verloopRegel('afgebroken', { wie: user.id })],
      bijgewerkt_op: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error('afbreken: ' + error.message);
  return res.status(200).json({ opdracht: data });
}
