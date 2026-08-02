// api/wanbetalers-diagnose-analyse-gesprek.js
//
// POST { customer_id } → AI-analyse van het WhatsApp-gesprek met een klant
// om te bepalen of er een BETAALAFSPRAAK is gemaakt. Puur read-only:
// leest whatsapp_messages, roept Anthropic aan (structured output), returnt
// het oordeel. Sla het NIET op in de DB (privacy — we bewaren geen
// gesprekssamenvattingen, alleen live-analyse voor beoordeling).
//
// Response:
// {
//   ok: true,
//   customer_id,
//   analysed_at: ISO,
//   messages_count: N,
//   afspraak_gemaakt: 'JA' | 'NEE' | 'ONDUIDELIJK',
//   samenvatting: string (max 200 chars),
//   termijnen?: [ { bedrag_eur?, datum? } ],
//   vertrouwen: 'hoog' | 'laag',
//   actie_nodig: string,
//   heeft_arrangement: bool,
//   sufficient_data: bool     // false als <3 klant-berichten
// }
//
// Super_admin only. Fail-modes:
//   - 401/403 zonder super_admin
//   - 400 als customer_id ontbreekt/ongeldig
//   - 404 als klant niet bestaat
//   - 200 met sufficient_data=false als er te weinig gesprek is
//   - 503 als ANTHROPIC_API_KEY ontbreekt
//   - 500 bij DB/AI-fout

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { anthropicStructuredOutput, AnthropicClientError } from './_lib/anthropic-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 30;   // laatste N berichten meesturen naar Claude
// Drempel op TOTAAL aantal berichten (inbound + outbound). Een afspraak
// blijkt vaak uit de wisselwerking — vooral uit ons akkoord op een klant-
// voorstel. Bij Ingrid-scenario: 2 klant-berichten + 7 antwoorden van ons
// = 9 totaal, dus ruim genoeg voor analyse. Eerder gebruikte MIN_CUSTOMER_MSGS
// telde alleen inbound → miste de akkoord-momenten. Fix voor #<PR>.
const MIN_TOTAL_MSGS = 3;

const SYSTEM_PROMPT = `Je bent een assistent voor de finance-afdeling van De Forex Opleiding.
Je krijgt een WhatsApp-gesprek met een klant die een openstaande factuur heeft.
Beoordeel of er een CONCRETE BETAALAFSPRAAK is gemaakt.

BELANGRIJK: een betaalafspraak blijkt uit de WISSELWERKING, niet alleen uit wat de klant zegt.
- Als de klant een voorstel doet ("kan ik in 4×€350 betalen?") én WIJ akkoord gaan ("ja, prima —
  eerste termijn op ...", "we gaan akkoord", "afgesproken"): dat is een AFSPRAAK JA.
- Ook een unilateraal duidelijk voorstel van de klant kan JA zijn als er geen tegenspraak volgt
  en het bedrag+datum concreet zijn.
- Onze bevestiging telt net zo zwaar als de klantvraag.

Onder een betaalafspraak versta je:
- een specifiek bedrag OF een specifieke termijn-verdeling
- met een specifieke datum of duidelijke termijn ("elke 15e", "volgende week vrijdag", "eind van de maand")
- door één van beide partijen voorgesteld EN door de andere partij bevestigd (of niet tegengesproken)

GEEN afspraak:
- vage uitingen ("ik betaal snel", "ik regel het") zonder bedrag/datum
- alleen een intentie zonder concreet moment
- gesprek loopt nog, geen definitief antwoord van beide kanten
- klant stelt iets voor maar WIJ hebben geen antwoord gegeven (nog niet bevestigd)

Bij twijfel: ONDUIDELIJK. Wees streng maar herken duidelijk akkoord.
Samenvatting max 200 chars, in het Nederlands, noem BEIDE partijen als er
akkoord is (bv. "klant vroeg 4×€350, wij akkoord op 29 juli").
Termijnen alleen invullen als de afspraak echt is (max 12 items).`;

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    afspraak_gemaakt: {
      type: 'string',
      enum: ['JA', 'NEE', 'ONDUIDELIJK'],
      description: 'Is er een concrete betaalafspraak gemaakt in het gesprek?',
    },
    samenvatting: {
      type: 'string',
      description: 'Max 200 chars Nederlandse samenvatting van wat er wel/niet is afgesproken.',
      maxLength: 200,
    },
    termijnen: {
      type: 'array',
      description: 'Alleen bij afspraak_gemaakt=JA. Concrete termijnen als (bedrag, datum). Max 12.',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          bedrag_eur: { type: 'number', description: 'Bedrag in EUR' },
          datum:      { type: 'string', description: 'Datum in tekst zoals in het gesprek (bv. "15 augustus" of "2026-08-15")' },
        },
      },
    },
    vertrouwen: {
      type: 'string',
      enum: ['hoog', 'laag'],
      description: 'Hoe zeker ben je van de conclusie?',
    },
  },
  required: ['afspraak_gemaakt', 'samenvatting', 'vertrouwen'],
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const admin = await verifyAdmin(req);
  if (!admin)                            return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (admin.profile?.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin.' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
  if (!customerId || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
  }

  try {
    // 1) Klant + open bedrag (context voor de AI).
    const { data: customer } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, is_test, anonymized_at')
      .eq('id', customerId)
      .maybeSingle();
    if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });
    if (customer.is_test) return res.status(400).json({ error: 'Test-klant — geen echte analyse gewenst' });
    if (customer.anonymized_at) return res.status(400).json({ error: 'Klant is geanonimiseerd — geen gesprek meer beschikbaar' });

    const custDisplay = customer.is_company
      ? (customer.company_name || '(bedrijf)')
      : [customer.first_name, customer.last_name].filter(Boolean).join(' ') || '(zonder naam)';

    // 2) Open bedrag voor context.
    const { data: openInvs } = await supabaseAdmin
      .from('invoices')
      .select('amount_total, amount_paid, credited_amount, status, is_test')
      .eq('customer_id', customerId)
      .in('status', ['open','partially_paid','overdue'])
      .eq('is_test', false);
    const openEur = (openInvs || [])
      .reduce((s, iv) => s + Math.max(0, (Number(iv.amount_total)||0) - (Number(iv.amount_paid)||0) - (Number(iv.credited_amount)||0)), 0);

    // 3) Meest recente conversation + laatste N berichten.
    const { data: convs } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, last_inbound_at, last_message_at')
      .eq('customer_id', customerId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1);
    const conv = (convs || [])[0];
    if (!conv) {
      return res.status(200).json({
        ok: true, customer_id: customerId, analysed_at: new Date().toISOString(),
        messages_count: 0, sufficient_data: false,
        afspraak_gemaakt: 'ONDUIDELIJK',
        samenvatting: 'Geen WhatsApp-gesprek beschikbaar om te analyseren.',
        vertrouwen: 'laag',
        actie_nodig: 'Geen actie — geen gesprek.',
        heeft_arrangement: false,
      });
    }
    const { data: msgs } = await supabaseAdmin
      .from('whatsapp_messages')
      .select('direction, body, created_at')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(MAX_MESSAGES);
    const messages = (msgs || []).reverse();  // chronologisch (oud → nieuw)

    // Sufficient-guard op TOTAAL aantal berichten (was: alleen inbound).
    // De afspraak zit vaak in de wisselwerking — ons akkoord op een klant-
    // voorstel telt evenveel als de klantvraag zelf.
    const customerMsgCount = messages.filter((m) => m.direction === 'in').length;
    const outboundMsgCount = messages.length - customerMsgCount;
    const sufficient = messages.length >= MIN_TOTAL_MSGS;

    // 4) Bestaat er al een arrangement (om actie_nodig te bepalen).
    const { data: arrs } = await supabaseAdmin
      .from('payment_arrangements')
      .select('status')
      .eq('customer_id', customerId)
      .in('status', ['ACTIEF','VOORGESTELD']);
    const hasArrangement = (arrs || []).length > 0;

    if (!sufficient) {
      return res.status(200).json({
        ok: true, customer_id: customerId, analysed_at: new Date().toISOString(),
        messages_count: messages.length,
        customer_msg_count: customerMsgCount,
        outbound_msg_count: outboundMsgCount,
        sufficient_data: false,
        afspraak_gemaakt: 'ONDUIDELIJK',
        samenvatting: `Onvoldoende data: slechts ${messages.length} bericht(en) totaal (${customerMsgCount} in / ${outboundMsgCount} uit).`,
        vertrouwen: 'laag',
        actie_nodig: 'Geen analyse — te weinig gesprek.',
        heeft_arrangement: hasArrangement,
      });
    }

    // 5) Prompt bouwen: klant-context + chronologisch gesprek.
    // Bewust: alleen direction + body meegeven. Geen namen (Claude weet niet
    // wie exact de klant is) — voorkomt overreach in de prompt.
    const conversationTxt = messages.map((m, i) =>
      `${i+1}. [${m.direction === 'in' ? 'KLANT' : 'WIJ'}] ${String(m.body || '').slice(0, 500)}`
    ).join('\n');
    const userMsg = `Klant: ${custDisplay}
Openstaand bedrag: €${openEur.toFixed(2)}

Recente WhatsApp-berichten (chronologisch, max ${MAX_MESSAGES}):
${conversationTxt}

Analyseer.`;

    let ai;
    try {
      ai = await anthropicStructuredOutput({
        system:           SYSTEM_PROMPT,
        messages:         [{ role: 'user', content: userMsg }],
        tool_name:        'rapporteer_afspraak',
        tool_input_schema: TOOL_INPUT_SCHEMA,
        temperature:      0.1,
        max_tokens:       800,
      });
    } catch (aiErr) {
      if (aiErr instanceof AnthropicClientError) {
        return res.status(500).json({
          ok: false,
          error: 'AI-analyse faalde',
          code: aiErr.code,
          message: aiErr.message,
        });
      }
      throw aiErr;
    }

    // 6) actie_nodig afleiden op basis van AI-oordeel + arrangement-status.
    let actieNodig = 'Geen actie.';
    if (ai.afspraak_gemaakt === 'JA' && !hasArrangement) {
      actieNodig = 'Leg vast als TOEZEGGING — er is een concrete afspraak maar geen payment_arrangement.';
    } else if (ai.afspraak_gemaakt === 'JA' && hasArrangement) {
      actieNodig = 'Afspraak matcht bestaand arrangement (of check of details kloppen).';
    } else if (ai.afspraak_gemaakt === 'ONDUIDELIJK') {
      actieNodig = 'Handmatig lezen; AI is niet zeker.';
    } else {
      actieNodig = 'Geen afspraak → engine mag doorlopen; overweeg extra contact.';
    }

    const analysedAt = new Date().toISOString();
    const termijnen  = Array.isArray(ai.termijnen) ? ai.termijnen.slice(0, 12) : [];

    // ── UPSERT-cache in dunning_gesprek_analyse ─────────────────────────
    // Fail-soft: als de tabel/kolom nog ontbreekt (migratie nog niet
    // gedraaid), returnt het oordeel wél maar zonder persistence. De UI
    // blijft dan client-only werken. Zodra de migratie draait wordt cache
    // automatisch bijgewerkt.
    try {
      await supabaseAdmin
        .from('dunning_gesprek_analyse')
        .upsert({
          customer_id:        customerId,
          afspraak_gemaakt:   ai.afspraak_gemaakt,
          samenvatting:       ai.samenvatting || '',
          termijnen,
          vertrouwen:         ai.vertrouwen || 'laag',
          actie_nodig:        actieNodig,
          heeft_arrangement:  hasArrangement,
          messages_count:     messages.length,
          customer_msg_count: customerMsgCount,
          outbound_msg_count: outboundMsgCount,
          sufficient_data:    true,
          geanalyseerd_op:    analysedAt,
          geanalyseerd_door:  admin.user.id,
          updated_at:         analysedAt,
        }, { onConflict: 'customer_id' });
    } catch (upErr) {
      console.warn('[analyse-gesprek] cache upsert soft-fail:', upErr?.message || upErr);
    }

    return res.status(200).json({
      ok:               true,
      customer_id:      customerId,
      analysed_at:      analysedAt,
      messages_count:   messages.length,
      customer_msg_count: customerMsgCount,
      outbound_msg_count: outboundMsgCount,
      sufficient_data:  true,
      afspraak_gemaakt: ai.afspraak_gemaakt,
      samenvatting:     ai.samenvatting || '',
      termijnen,
      vertrouwen:       ai.vertrouwen || 'laag',
      actie_nodig:      actieNodig,
      heeft_arrangement: hasArrangement,
      geanalyseerd_door: admin.user.id,
      geanalyseerd_door_email: admin.user.email || null,
    });
  } catch (e) {
    console.error('[wanbetalers-diagnose-analyse-gesprek]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
