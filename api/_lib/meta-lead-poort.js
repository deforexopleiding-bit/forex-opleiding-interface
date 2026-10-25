// api/_lib/meta-lead-poort.js
//
// De poort voor het Meta "Lead"-event aan CRM-kant (2026-10-21) — spiegel van
// lib/meta-lead-poort.ts in dfo-website. Eén Lead per CRM-lead:
//   1. alleen op productie (VERCEL_ENV=production);
//   2. geen test (is_test of een testadres: +test/+labtest, example-domeinen,
//      env META_LEAD_UITSLUITEN);
//   3. geen bot (user-agent);
//   4. claim leads.meta_lead_op (alleen de eerste keer lukt dat);
//   5. event_id 'lead_<lead_id>' — dezelfde conventie als de website, dus een
//      lead die via de website én via The Lab binnenkomt telt bij Meta één keer.
// Zonder de kolom (migratie 2026-10-21-leads-meta-lead-op.sql in dfo-website nog
// niet gedraaid): alleen het vaste event_id, Meta ontdubbelt binnen zijn venster.

export function metaLeadEventId(leadId) {
  return `lead_${leadId}`;
}

const TEST_DOMEINEN = /@(example\.(com|nl|org|be)|test\.(com|nl)|mailinator\.com)$/i;

export function isTestAdres(email, extra = process.env.META_LEAD_UITSLUITEN) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return true;
  if (/\+[^@]*test[^@]*@/.test(e)) return true;
  if (TEST_DOMEINEN.test(e)) return true;
  const lijst = String(extra || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return lijst.some((x) => (x.startsWith('@') ? e.endsWith(x) : e === x));
}

const BOT_UA = /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|selenium|lighthouse|python-requests|curl\/|wget|httpclient|axios\/|node-fetch|go-http-client/i;

export function isBotAgent(ua) {
  const s = String(ua || '').trim();
  return !s || BOT_UA.test(s);
}

/**
 * @returns {Promise<{ eventId: string|null, reden: string }>}
 * Fail-soft: een claim-fout geeft GEEN Lead (liever één te weinig dan dubbel).
 */
export async function beslisMetaLead(sb, { leadId, email, userAgent, isTest = false, vercelEnv = process.env.VERCEL_ENV, toestemming = false }) {
  // Alleen met toestemming voor advertentiecookies (2026-10-25, _lib/advertentie-toestemming.js).
  if (toestemming !== true) return { eventId: null, reden: 'geen_toestemming' };
  if (vercelEnv !== 'production') return { eventId: null, reden: 'geen_productie' };
  if (isTest || isTestAdres(email)) return { eventId: null, reden: 'testadres' };
  if (isBotAgent(userAgent)) return { eventId: null, reden: 'bot' };
  if (!leadId) return { eventId: null, reden: 'geen_lead' };
  try {
    const { data, error } = await sb.from('leads')
      .update({ meta_lead_op: new Date().toISOString() })
      .eq('id', leadId).is('meta_lead_op', null)
      .select('id');
    if (error) {
      if (['42703', 'PGRST204'].includes(String(error.code))) return { eventId: metaLeadEventId(leadId), reden: 'zonder_kolom' };
      console.error('[meta-lead] claim mislukt', { leadId, code: error.code, fout: error.message });
      return { eventId: null, reden: 'claim_fout' };
    }
    if (!data || !data.length) return { eventId: null, reden: 'al_gemeld' };
    return { eventId: metaLeadEventId(leadId), reden: 'nieuw' };
  } catch (e) {
    console.error('[meta-lead] claim exception', { leadId, fout: e?.message || String(e) });
    return { eventId: null, reden: 'claim_fout' };
  }
}
