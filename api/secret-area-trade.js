// api/secret-area-trade.js
// GET    → { trades[], stats:{ win_rate, avg_rr, expectancy, count, per_grade[] } }
//          trades incl. gebruikte tools + afbeeldings-URLs (signed).
// POST   → nieuwe trade { strategy_id?, occurred_at, instrument, direction,
//                         entry, sl, tp, exit, r_multiple, pnl, grade,
//                         notes, images[]:[{ image_path, caption? }],
//                         tools[]:[uuid, ...] }
// DELETE ?id → verwijder trade + images + tool-links.
// Owner-gated.

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';

const BUCKET = 'secret-area';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRADES = new Set(['A+', 'B', 'C']);
const SIGNED_TTL_SEC = 60 * 60; // 1u

async function signPath(path) {
  if (!path) return null;
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET)
      .createSignedUrl(path, SIGNED_TTL_SEC);
    if (error) return null;
    return data?.signedUrl || null;
  } catch (_) { return null; }
}

function computeStats(trades) {
  const t = Array.isArray(trades) ? trades : [];
  const count = t.length;
  if (count === 0) return { win_rate: 0, avg_rr: 0, expectancy: 0, count: 0, per_grade: [] };
  let wins = 0;
  let rrSum = 0;
  let rrN = 0;
  let pnlSum = 0;
  const perGrade = new Map();
  for (const x of t) {
    const pnl = Number(x.pnl);
    if (Number.isFinite(pnl)) pnlSum += pnl;
    const win = Number.isFinite(pnl) ? pnl > 0 : null;
    if (win === true) wins++;
    if (Number.isFinite(Number(x.r_multiple))) { rrSum += Number(x.r_multiple); rrN++; }
    const g = String(x.grade || '').trim();
    if (g) {
      const rec = perGrade.get(g) || { grade: g, count: 0, wins: 0 };
      rec.count++;
      if (win === true) rec.wins++;
      perGrade.set(g, rec);
    }
  }
  return {
    count,
    win_rate:   Math.round((wins / count) * 1000) / 10,
    avg_rr:     rrN ? Math.round((rrSum / rrN) * 100) / 100 : 0,
    expectancy: Math.round((pnlSum / count) * 100) / 100,
    per_grade:  Array.from(perGrade.values()).map((r) => ({
      grade:    r.grade,
      count:    r.count,
      win_rate: r.count ? Math.round((r.wins / r.count) * 1000) / 10 : 0,
    })),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  try {
    if (req.method === 'GET') {
      const { data: trades } = await supabaseAdmin.from('sa_trades')
        .select('*').eq('owner_id', ctx.userId)
        .order('occurred_at', { ascending: false })
        .limit(1000);
      const list = trades || [];
      const ids = list.map((t) => t.id);
      let images = [];
      let toolLinks = [];
      if (ids.length > 0) {
        const [imgRes, linkRes] = await Promise.all([
          supabaseAdmin.from('sa_trade_images')
            .select('*').eq('owner_id', ctx.userId).in('trade_id', ids),
          supabaseAdmin.from('sa_trade_tools')
            .select('*').eq('owner_id', ctx.userId).in('trade_id', ids),
        ]);
        images    = imgRes.data || [];
        toolLinks = linkRes.data || [];
      }
      const imgByTrade  = new Map();
      const toolByTrade = new Map();
      for (const im of images) {
        const arr = imgByTrade.get(im.trade_id) || [];
        arr.push(im);
        imgByTrade.set(im.trade_id, arr);
      }
      for (const tl of toolLinks) {
        const arr = toolByTrade.get(tl.trade_id) || [];
        arr.push(tl.tool_id);
        toolByTrade.set(tl.trade_id, arr);
      }
      const out = [];
      for (const tr of list) {
        const imgs = imgByTrade.get(tr.id) || [];
        const withUrls = [];
        for (const im of imgs) {
          withUrls.push({ ...im, image_url: await signPath(im.image_path) });
        }
        out.push({ ...tr, images: withUrls, tools: toolByTrade.get(tr.id) || [] });
      }
      return res.status(200).json({ trades: out, stats: computeStats(list) });
    }

    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const grade = typeof body.grade === 'string' ? body.grade.trim() : '';
      if (grade && !GRADES.has(grade)) return res.status(400).json({ error: "grade moet A+, B of C zijn" });

      const row = {
        owner_id:     ctx.userId,
        strategy_id:  (typeof body.strategy_id === 'string' && UUID_RE.test(body.strategy_id)) ? body.strategy_id : null,
        occurred_at:  typeof body.occurred_at === 'string' ? body.occurred_at : new Date().toISOString(),
        instrument:   typeof body.instrument  === 'string' ? body.instrument.slice(0, 40)   : null,
        direction:    body.direction === 'short' ? 'short' : (body.direction === 'long' ? 'long' : null),
        entry:        Number.isFinite(body?.entry)      ? Number(body.entry)      : null,
        sl:           Number.isFinite(body?.sl)         ? Number(body.sl)         : null,
        tp:           Number.isFinite(body?.tp)         ? Number(body.tp)         : null,
        exit:         Number.isFinite(body?.exit)       ? Number(body.exit)       : null,
        r_multiple:   Number.isFinite(body?.r_multiple) ? Number(body.r_multiple) : null,
        pnl:          Number.isFinite(body?.pnl)        ? Number(body.pnl)        : null,
        grade:        grade || null,
        notes:        typeof body.notes === 'string' ? body.notes.slice(0, 10000) : null,
      };
      const { data: created, error } = await supabaseAdmin.from('sa_trades').insert(row).select('*').single();
      if (error) throw new Error('insert: ' + error.message);

      // Images.
      if (Array.isArray(body.images) && body.images.length > 0) {
        const imgs = body.images.map((im) => ({
          owner_id:   ctx.userId,
          trade_id:   created.id,
          image_path: typeof im?.image_path === 'string' ? im.image_path.slice(0, 500) : null,
          source_url: typeof im?.source_url === 'string' ? im.source_url.slice(0, 500) : null,
          caption:    typeof im?.caption    === 'string' ? im.caption.slice(0, 500)    : null,
        })).filter((x) => x.image_path || x.source_url);
        if (imgs.length > 0) await supabaseAdmin.from('sa_trade_images').insert(imgs);
      }
      // Tool-koppelingen.
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const links = body.tools
          .filter((t) => typeof t === 'string' && UUID_RE.test(t))
          .map((toolId) => ({ owner_id: ctx.userId, trade_id: created.id, tool_id: toolId }));
        if (links.length > 0) await supabaseAdmin.from('sa_trade_tools').insert(links);
      }
      return res.status(201).json({ trade: created });
    }

    if (req.method === 'DELETE') {
      const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      await supabaseAdmin.from('sa_trade_images').delete().eq('trade_id', id).eq('owner_id', ctx.userId);
      await supabaseAdmin.from('sa_trade_tools').delete().eq('trade_id', id).eq('owner_id', ctx.userId);
      const { error } = await supabaseAdmin.from('sa_trades').delete().eq('id', id).eq('owner_id', ctx.userId);
      if (error) throw new Error('delete: ' + error.message);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sa-trade]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
