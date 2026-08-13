// api/_lib/aisha-generate.js
//
// Aisha AI-content-generatie voor leadsonderhoud. ACHTER is_enabled-vlag +
// feature-flag: retourneert null zolang beide niet actief zijn, zodat de
// bestaande cron-leadsonderhoud.js-sjabloon-motor onaangeroerd blijft.
//
// GEBRUIK (later, in aparte cron-integratie-fase):
//   const ai = await maybeGenerateAishaBericht({ lead, stap, sjabloon });
//   if (ai) {
//     // gebruik ai.tekst als bericht-body
//   } else {
//     // fallback naar de bestaande sjabloon-flow (huidige productie-gedrag)
//   }
//
// Deze helper wordt in Fase 4 NIET aangeroepen door cron-leadsonderhoud.js —
// hij ligt klaar voor een expliciete opvolg-fase waarin Jeffrey de cron
// aanpast. Aanroepers moeten altijd de null-return respecteren.

import { supabaseAdmin } from '../supabase.js';
import { anthropicMessages, AnthropicClientError } from './anthropic-client.js';

const MAX_OUTPUT_TOKENS = 400;

function fill(str, vars) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => vars[k] == null ? '' : String(vars[k]));
}

function buildSystemPrompt(cfg, leadCtx) {
  const vars = {
    company_name:    process.env.COMPANY_NAME || 'De Forex Opleiding NL B.V.',
    lead_naam:       leadCtx?.naam || 'de lead',
    lead_interesse:  leadCtx?.interesse || 'onbekend',
    laatste_contact: leadCtx?.laatste_contact || 'onbekend',
  };
  const base = fill(cfg?.system_prompt_template || '', vars);
  const tone = cfg?.persona_tone ? `\n\nToon: ${cfg.persona_tone}` : '';
  const kb = cfg?.knowledge_base;
  let kbBlock = '';
  if (kb && typeof kb === 'object' && !Array.isArray(kb)) {
    if (Array.isArray(kb.dos) && kb.dos.length)
      kbBlock += '\n\nAltijd:\n' + kb.dos.map((s) => '- ' + s).join('\n');
    if (Array.isArray(kb.donts) && kb.donts.length)
      kbBlock += '\n\nNooit:\n' + kb.donts.map((s) => '- ' + s).join('\n');
    if (Array.isArray(kb.stop_keywords) && kb.stop_keywords.length)
      kbBlock += '\n\nStop de sequentie bij: ' + kb.stop_keywords.join(', ');
  }
  return base + tone + kbBlock;
}

/**
 * Genereer een AI-bericht voor Aisha; retourneert null als de vlag(gen) uit
 * staan of als er iets misgaat (fail-soft — laat caller vallen op sjabloon).
 *
 * @param {object} args
 * @param {object} args.lead      Lead-context ({naam, interesse, laatste_contact})
 * @param {string} args.sjabloon  Fallback-sjabloon-tekst (context voor LLM)
 * @param {string} args.stap      Sequentie-stap-label (context voor LLM)
 * @returns {Promise<{tekst:string, model:string} | null>}
 */
export async function maybeGenerateAishaBericht({ lead, sjabloon, stap }) {
  try {
    // 1) Config ophalen
    const { data: cfg, error } = await supabaseAdmin
      .from('joost_config')
      .select('module, persona_name, persona_tone, system_prompt_template, knowledge_base, model, temperature, is_enabled, feature_flags')
      .eq('module', 'leadsonderhoud')
      .maybeSingle();
    if (error) {
      console.warn('[aisha-generate] config fetch faalde:', error.message);
      return null;
    }
    if (!cfg) return null;

    // 2) DUAL-GUARD: is_enabled ÉN feature_flags.aisha_ai_content_enabled moeten beide true zijn.
    if (cfg.is_enabled !== true) return null;
    if (!cfg.feature_flags || cfg.feature_flags.aisha_ai_content_enabled !== true) return null;

    // 3) Ontbrekende Anthropic-key → fail-soft
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('[aisha-generate] ANTHROPIC_API_KEY ontbreekt, val terug op sjabloon');
      return null;
    }

    // 4) LLM-call
    const system = buildSystemPrompt(cfg, lead);
    const userMsg = [
      `Stap in de sequentie: ${stap || 'onbekend'}`,
      '',
      `Fallback-sjabloon (jouw variatie mag maximaal deze lengte + toon houden):`,
      sjabloon || '(geen sjabloon)',
      '',
      `Schrijf één kort, persoonlijk bericht voor deze lead volgens jouw persona.`,
    ].join('\n');

    const result = await anthropicMessages({
      model:       cfg.model || 'claude-sonnet-4-6',
      max_tokens:  MAX_OUTPUT_TOKENS,
      temperature: cfg.temperature != null ? Number(cfg.temperature) : 0.4,
      system,
      messages:    [{ role: 'user', content: userMsg }],
    });

    let tekst = '';
    if (Array.isArray(result?.content)) {
      for (const b of result.content) if (b?.type === 'text' && typeof b.text === 'string') tekst += b.text;
    }
    tekst = tekst.trim();
    if (!tekst) return null;

    return { tekst, model: cfg.model || 'claude-sonnet-4-6' };
  } catch (e) {
    if (e instanceof AnthropicClientError) {
      console.warn('[aisha-generate] anthropic:', e.code, e.message);
    } else {
      console.warn('[aisha-generate] exception:', e?.message || e);
    }
    return null;
  }
}
