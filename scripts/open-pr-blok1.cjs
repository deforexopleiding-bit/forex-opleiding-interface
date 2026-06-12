#!/usr/bin/env node
// scripts/open-pr-blok1.cjs
// Opent PR voor feat/events-blok1-lifecycle -> main via GitHub REST API.
// Auth: leest token uit `git credential fill` (geen GH_TOKEN env-var nodig).
//
// One-shot script. Print { number, html_url } na succes. Niet hergebruikt
// als utility. Wordt door agent 4 uitgevoerd en daarna in een commit
// opgenomen (zodat git-history traceerbaar is). NIET MERGEN.

const { spawnSync } = require('node:child_process');
const https = require('node:https');

const OWNER = 'deforexopleiding-bit';
const REPO  = 'forex-opleiding-interface';
const HEAD  = 'feat/events-blok1-lifecycle';
const BASE  = 'main';
const TITLE = 'Events Blok 1 - signups_closed lifecycle + cleanup + item-6 fix';

const BODY = `## Inhoud

Foundation voor Events Module Blok 1: signups-closed lifecycle + Webflow CMS-cleanup
+ item-6 hard-delete fix. Bouw bovenop F2 (PR #171). 16 commits, 4 agents.

### Datamodel (SQL migratie)
- \`2026-06-12-events-signups-closed.sql\`: 4 nieuwe kolommen op \`events\`:
  \`signups_closed bool default false\`, \`signups_closed_at timestamptz\`,
  \`signups_closed_reason text\` (CHECK in \`manual|auto_time|auto_full|auto_deadline\`),
  \`signups_closed_by_user_id uuid\` (FK auth.users).

### Helpers (\`api/_lib/\`)
- \`webflow-client.js\`: nieuwe helpers \`hardDeleteItem\` (permanent CMS-delete,
  404=success) + \`republishItem\` (PATCH /live primair, POST /publish fallback).
- \`event-sync-orchestrator.js\`: \`closeSignupsOutbound\`,
  \`reopenSignupsOutbound\`, en filter \`computeUpcomingLabels\` skipt
  \`signups_closed=true\`.

### Endpoints
- \`POST /api/events-close-signups?id=<uuid>\`: handmatige close, audit-trail
  via \`signups_closed_by_user_id\`, awaited outbound sync.
- \`POST /api/events-reopen-signups?id=<uuid>\`: heropen met deadline-guard
  (T-1 dag 00:00 NL); te laat -> \`409 REOPEN_TOO_LATE\`.
- \`events-list\` + \`events-detail\` returnen nu de 4 signups_closed velden.

### Crons (\`vercel.json\`)
- \`cron-events-signups-auto-close\` (\`0 * * * *\` hourly): automatische close
  voor events waarvan T-1 dag 00:00 NL gepasseerd is; idempotent (skip
  bij \`signups_closed=true\`); reason=\`auto_time\`.
- \`cron-events-cms-cleanup\` (daily): permanent verwijderen van Webflow
  CMS-items voor events ouder dan 7 dagen of cancelled; events-row blijft
  staan (record + bonus + assessment intact).

### Frontend
- \`modules/events.html\`: nieuwe chip "Aanmelding gesloten" in lijst-row
  achter status-badge, tooltip met reason + sinds-datum.
- \`modules/events-detail.html\`: badge "Aanmelding GESLOTEN" in header,
  banner met reason, knoppen "Aanmelding sluiten" / "Aanmelding heropen"
  (RBAC \`events.event.edit\`), 409 REOPEN_TOO_LATE toont eigen toast.
  Aanwezige-toevoegen knop disabled met tooltip bij gesloten inschrijvingen.

## Item-6 fix
\`events-delete\` archive-pad gebruikte voorheen \`unpublishItem\` (item bleef
bestaan, alleen draft). Nu \`hardDeleteItem\` - CMS-item permanent weg na
event-cancel of archive. Zie diagnose-doc + commit \`1bb21c0\`.

## Locks toegepast (uit plan-gate)
- **OQ1**: 3-veld signups_closed model. \`auto_full\` in CHECK voor
  forward-compat (geen cron-write in deze release).
- **OQ2**: auto-close cron hourly (\`0 * * * *\`), idempotent.
- **OQ6**: reopen na deadline -> \`409 REOPEN_TOO_LATE\`.

## Pre-merge instructies
1. Run SQL migratie \`docs/sql-migrations/2026-06-12-events-signups-closed.sql\`
   op productie-Supabase (4 kolommen + CHECK + FK; zie verificatie-queries
   in \`docs/events-f2-smoke-tests.md\` -> Pre-flight Blok 1).
2. Bevestig env-vars: \`CRON_SECRET\`, \`WEBFLOW_API_TOKEN\`, \`WEBFLOW_SITE_ID\`,
   \`WEBFLOW_EVENTS_COLLECTION_ID\`, \`GHL_EVENTS_PIT_TOKEN\` aanwezig in
   Vercel (Production + Preview).
3. Vercel preview-build groen voor branch + 2 nieuwe cron-entries in
   \`vercel.json\`.
4. Doorloop scenarios 9-14 in \`docs/events-f2-smoke-tests.md\`. Beide
   crons zijn handmatig triggerbaar via curl met
   \`Authorization: Bearer $CRON_SECRET\`.
5. Geen tech-debt in PR-diff (geen wijzigingen aan \`modules/finance.html\`
   of \`modules/shared/finance-views/*\`).

## Merge-instructie (STRICT lesson #148)

USER doet de merge zelf - geen agent merget deze PR.

Squash-merge alleen bij \`{ merged: true }\` response van GitHub API.
Branch-delete alleen na succesvolle strict-assertion.

Voorbeeld-prompt voor user:
\`\`\`
Squash-merge PR #<nr> via GitHub API. Verifieer dat de response
{ merged: true } returnt. Pas daarna mag origin/feat/events-blok1-lifecycle
verwijderd worden.
\`\`\`
`;

function getGithubToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error('git credential fill failed: ' + r.stderr);
  }
  const lines = r.stdout.split(/\r?\n/);
  let token = null;
  for (const line of lines) {
    if (line.startsWith('password=')) {
      token = line.slice('password='.length);
      break;
    }
  }
  if (!token) throw new Error('geen password in credential fill output');
  return token;
}

function ghRequest({ method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'forex-opleiding-pr-script',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let json = null;
        try { json = chunks ? JSON.parse(chunks) : null; } catch (_) {}
        resolve({ status: res.statusCode, body: json, raw: chunks });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const token = getGithubToken();

  // Defensief: check of er al een open PR is voor deze head -> skip create.
  const listPath = '/repos/' + OWNER + '/' + REPO + '/pulls?state=open&head=' +
    encodeURIComponent(OWNER + ':' + HEAD);
  const existing = await ghRequest({ method: 'GET', path: listPath, token });
  if (existing.status === 200 && Array.isArray(existing.body) && existing.body.length > 0) {
    const pr = existing.body[0];
    console.log(JSON.stringify({ created: false, number: pr.number, html_url: pr.html_url }, null, 2));
    return;
  }

  const createPath = '/repos/' + OWNER + '/' + REPO + '/pulls';
  const res = await ghRequest({
    method: 'POST',
    path: createPath,
    token,
    body: { title: TITLE, head: HEAD, base: BASE, body: BODY, draft: false },
  });

  if (res.status !== 201) {
    console.error('PR create failed: status=' + res.status);
    console.error(res.raw);
    process.exit(1);
  }

  console.log(JSON.stringify({ created: true, number: res.body.number, html_url: res.body.html_url }, null, 2));
})().catch((e) => {
  console.error('script error:', e.message);
  process.exit(1);
});
