// api/iris-transcribe.js
//
// Spraak naar tekst — de OPTIONELE weg.
//
//   GET   → { route: 'openai'|'browser', openai: boolean }
//   POST  met de ruwe audio in de body en een Content-Type van audio/*
//   ?taal=nl        (standaard)
//   ?model=…        (standaard uit iris_instellingen, anders gpt-4o-transcribe)
//
// Recht: iris.post.beantwoorden.
//
// ── DIT ENDPOINT IS NIET MEER DE HOOFDWEG ────────────────────────────────────
// Maxim gebruikt alleen Anthropic, en de Anthropic-API doet geen spraak naar
// tekst. De microfoon loopt daarom standaard via de Web Speech API van de
// browser (Chrome en Edge). Dit endpoint blijft staan voor het geval er ooit
// een OPENAI_API_KEY is: gpt-4o-transcribe is nauwkeuriger bij eigennamen en
// werkt in élke browser, ook Safari en Firefox.
//
// Vandaar de GET. Het scherm vraagt éérst welke weg het moet nemen, in plaats
// van een opname te sturen en op een 503 te stuiten. Geen sleutel is namelijk
// geen storing maar een keuze, en dat hoort de gebruiker niet als foutmelding
// te zien.
//
// ── WAAROM DE RUWE BODY EN GEEN BASE64 IN JSON ───────────────────────────────
// Base64 maakt een opname een derde groter en moet aan beide kanten omgezet
// worden. De browser heeft met MediaRecorder al een Blob; die kan zo als body
// mee. Dat betekent bodyParser uit en zelf lezen — hetzelfde patroon als
// inbox-webhook.js, dat de ruwe body nodig heeft voor de handtekening.
//
// ── WAAROM DE OPNAME NERGENS BLIJFT ──────────────────────────────────────────
// De audio wordt doorgegeven en weggegooid. Niet in een bucket, niet in de
// databank, niet in een logregel. Een ingesproken opdracht kan van alles
// bevatten — een klantnaam, een bedrag, een oordeel over iemand — en er is
// geen enkele reden om dat te bewaren zodra de tekst er is. Wat er overblijft
// is de tekst, en die staat in iris_concepten waar hij hoort.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalInstellingen } from './_lib/iris/instellingen.js';
import { openaiBeschikbaar, spraakRoute } from './_lib/iris/spraak.js';

export const config = { api: { bodyParser: false } };

/** Vercel kapt af op 30 seconden; een opname van meer dan 5 minuten past niet. */
export const MAX_BYTES = 20 * 1024 * 1024;

const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Welke audiosoorten we doorlaten, en welke bestandsnaam OpenAI daarbij wil. */
export const SOORTEN = Object.freeze({
  'audio/webm': 'opname.webm',
  'audio/ogg': 'opname.ogg',
  'audio/mp4': 'opname.mp4',
  'audio/mpeg': 'opname.mp3',
  'audio/wav': 'opname.wav',
  'audio/x-wav': 'opname.wav',
  'audio/flac': 'opname.flac',
});

/**
 * Bepaal de bestandsnaam bij een content-type.
 *
 * Browsers hangen er parameters aan ('audio/webm;codecs=opus'), dus we kijken
 * alleen naar het stuk vóór de puntkomma. Onbekend geeft null, en dan gaat het
 * verzoek niet door — een bestand waarvan we de soort niet kennen, sturen we
 * niet door naar een externe dienst.
 */
export function bestandsnaamVoor(contentType) {
  const soort = String(contentType || '').split(';')[0].trim().toLowerCase();
  return SOORTEN[soort] || null;
}

async function leesBody(req) {
  return new Promise((resolve, reject) => {
    const stukken = [];
    let totaal = 0;
    req.on('data', (stuk) => {
      totaal += stuk.length;
      if (totaal > MAX_BYTES) {
        reject(new Error(`Opname is groter dan ${Math.round(MAX_BYTES / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      stukken.push(stuk);
    });
    req.on('end', () => resolve(Buffer.concat(stukken)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Alleen GET en POST' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet aangemeld' });
  if (!(await requirePermission(req, 'iris.post.beantwoorden'))) {
    return res.status(403).json({ error: 'Geen rechten (iris.post.beantwoorden)' });
  }

  // GET — welke weg moet het scherm nemen? Altijd 200: er valt hier niets te
  // mislukken, en een foutcode zou het scherm laten denken dat er iets stuk is.
  if (req.method === 'GET') {
    return res.status(200).json({ route: spraakRoute(), openai: openaiBeschikbaar() });
  }

  const sleutel = (process.env.OPENAI_API_KEY || '').trim();
  if (!sleutel) {
    // GEEN storing. Het scherm hoort hier niet te komen (de GET hierboven
    // stuurt 'em naar de browser), en als het toch gebeurt is het antwoord
    // "neem de andere weg" en niet "er is iets mis".
    return res.status(503).json({
      error: 'De OpenAI-weg staat uit',
      route: 'browser',
      uitleg: 'Er is geen OPENAI_API_KEY ingesteld — dat is een keuze, geen storing. Spraak loopt via de browser.',
    });
  }

  const bestandsnaam = bestandsnaamVoor(req.headers['content-type']);
  if (!bestandsnaam) {
    return res.status(415).json({
      error: 'Onbekende audiosoort',
      gekregen: String(req.headers['content-type'] || '(geen)'),
      verwacht: Object.keys(SOORTEN),
    });
  }

  let audio;
  try {
    audio = await leesBody(req);
  } catch (e) {
    return res.status(413).json({ error: e?.message || 'Opname niet gelezen' });
  }
  if (!audio || !audio.length) {
    return res.status(400).json({ error: 'Lege opname' });
  }

  const instellingen = await haalInstellingen(supabaseAdmin);
  const model = String(req.query?.model || instellingen.model?.transcriptie || 'gpt-4o-transcribe').trim();
  const taal = String(req.query?.taal || 'nl').trim().slice(0, 5);

  try {
    const formulier = new FormData();
    formulier.append('file', new Blob([audio], { type: String(req.headers['content-type']).split(';')[0] }), bestandsnaam);
    formulier.append('model', model);
    formulier.append('language', taal);
    // Een duwtje in de goede richting voor namen die het model anders fonetisch
    // gokt. Geen inhoud, alleen woorden die in dit werk vaak voorkomen.
    formulier.append('prompt', 'De Forex Opleiding, factuur, betalingsregeling, afbetalingsplan, mentor, onboarding, Maxim, Dave, Chesney.');

    const antwoord = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sleutel}` },
      body: formulier,
    });

    if (!antwoord.ok) {
      const tekst = await antwoord.text().catch(() => '');
      // NOOIT de sleutel loggen, ook niet als hij in een foutmelding terugkomt.
      console.error('[iris-transcribe] OpenAI gaf', antwoord.status, tekst.slice(0, 300));
      return res.status(502).json({
        error: 'Transcriptie mislukt',
        status: antwoord.status,
        uitleg: antwoord.status === 401
          ? 'De OpenAI-sleutel werd niet aanvaard.'
          : 'OpenAI gaf een fout terug. Typen kan altijd nog.',
      });
    }

    const j = await antwoord.json();
    const tekst = String(j?.text || '').trim();
    if (!tekst) {
      return res.status(200).json({ tekst: '', leeg: true, uitleg: 'Er is niets verstaan.' });
    }

    // Het logboek noteert DAT er ingesproken is, niet WAT. De tekst zelf staat
    // straks in het concept; hem hier nog eens neerzetten is een tweede plek
    // waar hij kan lekken.
    const { error: logFout } = await supabaseAdmin.from('iris_log').insert({
      wie: user.id,
      wat: 'spraak omgezet naar tekst',
      resultaat: 'ok',
      details: { tekens: tekst.length, model, taal },
    });
    if (logFout) console.warn('[iris-transcribe] logregel mislukt:', logFout.message);

    return res.status(200).json({ tekst, model, taal });
  } catch (e) {
    console.error('[iris-transcribe]', e?.message || e);
    return res.status(500).json({ error: 'Transcriptie mislukt', uitleg: e?.message || 'Onbekende fout' });
  }
}
