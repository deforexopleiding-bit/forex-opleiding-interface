// api/opvolging-whatsapp-historiek.js
//
// POST { nummer, taak_id?, limiet? } → haalt de geschiedenis van dit gesprek op
// bij de brug en schrijft hem weg in opvolging_wa_berichten.
//
// De brug LEEST alleen; het wegschrijven gebeurt hier, langs hetzelfde pad als
// de webhook en idempotent op bericht_id. De unieke index ligt er al, dus twee
// keer ophalen levert geen dubbele regels op — 23505 is hier geen fout maar het
// bewijs dat de regel er al stond.
//
// WAT ER TERUGKOMT IS NIET NOODZAKELIJK ALLES, en dat is geen bijzaak.
// WhatsApp synct een beperkt venster naar een gekoppeld apparaat, en deze brug
// is pas kort gekoppeld. Wat Dave op zijn eigen toestel ziet kan dus méér zijn
// dan wat hier binnenkomt. Vandaar dat het antwoord `oudste` draagt: het paneel
// zegt daarmee tot wanneer er gekeken is, in plaats van te doen alsof dit het
// volledige gesprek is.
//
// GEEN POGINGEN. Een gesprek van vorige week is geen moeite van vandaag; die
// rijen zouden de telling in Afgerond vervuilen. Dit endpoint raakt
// opvolging_pogingen niet aan.
//
// Permission: opvolging.module.access — zelfde poort als de rest van de module.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { brugFetch, brugFoutNaarHttp } from './_lib/whatsapp-brug-client.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';

const STANDAARD_LIMIET = 50;
const MAX_LIMIET = 200;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'opvolging.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });
  }

  const b = req.body || {};
  const nummer = normaliseerNummer(b.nummer);
  if (!nummer) return res.status(400).json({ error: 'nummer ontbreekt of is onleesbaar' });
  const taakId = b.taak_id ? String(b.taak_id) : null;
  const limiet = Math.max(1, Math.min(MAX_LIMIET, Number(b.limiet) || STANDAARD_LIMIET));

  let uit;
  try {
    uit = await brugFetch('/historiek?nummer=' + encodeURIComponent(nummer) + '&limiet=' + limiet);
  } catch (e) {
    if (e?.code === 'BRUG_FOUT' && e.status === 403) {
      return res.status(403).json({
        error: 'Dit nummer hoort niet bij een lopende opvolgtaak, dus de brug geeft er niets over terug.',
        code : 'NIET_TOEGESTAAN',
      });
    }
    if (e?.code === 'BRUG_FOUT' && e.status === 404) {
      // Geen storing: dit gesprek staat niet op het gekoppelde apparaat. Kan
      // kloppen — het kan buiten het gesynchroniseerde venster vallen, of er is
      // nooit met dit nummer gechat vanaf dit toestel.
      return res.status(200).json({
        ok: true, opgehaald: 0, nieuw: 0, oudste: null, nieuwste: null,
        code: 'GEEN_GESPREK',
        melding: 'WhatsApp kent op dit apparaat geen gesprek met dit nummer. Dat kan betekenen dat het buiten het gesynchroniseerde venster valt.',
      });
    }
    const { status, body } = brugFoutNaarHttp(e);
    if (e?.oorzaak) console.warn('[opvolging-whatsapp-historiek]', e.code, e.oorzaak);
    return res.status(status).json(body);
  }

  const berichten = Array.isArray(uit?.berichten) ? uit.berichten : [];
  if (berichten.length === 0) {
    return res.status(200).json({
      ok: true, opgehaald: 0, nieuw: 0, oudste: null, nieuwste: null,
      code: 'LEEG',
      melding: 'WhatsApp gaf voor dit nummer geen berichten terug. Een gekoppeld apparaat krijgt maar een beperkt venster van de telefoon gesynct.',
    });
  }

  // Per rij invoegen en 23505 doorlaten. Eén insert met alle rijen zou op de
  // eerste dubbele bericht_id de hele batch weigeren, en dan komt er bij een
  // tweede ophaalronde nooit meer iets binnen.
  let nieuw = 0;
  const fouten = [];
  for (const m of berichten) {
    try {
      const { error } = await supabaseAdmin.from('opvolging_wa_berichten').insert({
        nummer,
        taak_id   : taakId,
        richting  : m.richting === 'uit' ? 'uit' : 'in',
        tekst     : m.tekst || null,
        media_type: m.media_type ? String(m.media_type).slice(0, 40) : null,
        bericht_id: m.bericht_id || null,
        tijdstip  : m.tijdstip,
      });
      if (error) {
        if (error.code === '23505') continue;      // stond er al
        throw new Error(error.message);
      }
      nieuw += 1;
    } catch (e) {
      // Per bericht vangen: één rij die weigert mag de rest niet laten liggen.
      // Nooit de tekst in het log — alleen dát het misging.
      fouten.push(e?.message || String(e));
      console.warn('[opvolging-whatsapp-historiek] rij overgeslagen:', e?.message || e);
    }
  }

  if (fouten.length && nieuw === 0) {
    // Alles mislukt: dan is er iets structureel mis (meestal een migratie die
    // nog niet gedraaid is), en dat hoort geen stille nul te worden.
    return res.status(500).json({
      error: 'De berichten konden niet bewaard worden. ' + fouten[0],
      code : 'OPSLAAN_MISLUKT',
    });
  }

  return res.status(200).json({
    ok        : true,
    opgehaald : berichten.length,
    nieuw,
    oudste    : uit.oudste || berichten[0].tijdstip,
    nieuwste  : uit.nieuwste || berichten[berichten.length - 1].tijdstip,
    // De brug meldt of de lijst tot aan de grens liep. Zo ja, dan is er
    // waarschijnlijk méér — dat is iets anders dan 'dit is alles'.
    mogelijk_meer: uit.mogelijk_meer === true,
    overgeslagen : fouten.length,
  });
}
