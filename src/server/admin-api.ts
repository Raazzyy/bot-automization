import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { desc, eq, sql, and, or } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { orders, orderItems, markets, businessConnections } from '../db/schema.js';
import { getAllSettings, updateSettings, isBotEnabled, getActiveMode } from '../lib/settings.js';
import { calculateDebts } from '../bot/debts.js';
import { findDormantMarkets } from '../bot/reactivate.js';
import { generateWaybillPdf, generateReconciliationPdf } from '../lib/pdf-waybill.js';
import { runAgent } from '../ai/agent.js';
import { syncAll } from '../linko/sync.js';
import { linko } from '../linko/client.js';
import { log } from '../lib/logger.js';
import { fmtSum, fmtNum, fmtAmount, toSum } from '../lib/money.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};

function parseJsonBody<T = any>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Тело запроса слишком большое (>2MB)'));
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({} as T);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Невалидный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function serveStatic(res: ServerResponse, filePath: string) {
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
    'Content-Length': content.length,
  });
  res.end(content);
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  const host = req.headers.host || 'localhost:3000';
  const parsedUrl = new URL(req.url || '/', `http://${host}`);
  const pathname = parsedUrl.pathname;

  try {
    if (pathname === '/api/status' && req.method === 'GET') {
      const enabled = await isBotEnabled();
      const mode = await getActiveMode();
      const settings = await getAllSettings();
      const db = await getDb();

      const [conn] = await db
        .select()
        .from(businessConnections)
        .orderBy(desc(businessConnections.updatedAt))
        .limit(1);

      return sendJson(res, 200, {
        status: 'ok',
        bot_enabled: enabled,
        mode,
        company_name: settings.company_name,
        company_brand: settings.company_brand || settings.company_name,
        manager_name: settings.manager_name,
        manager_phone: settings.manager_phone,
        bot_configured: Boolean(settings.telegram_bot_token || config.BOT_TOKEN),
        polling_disabled: config.DISABLE_BOT_POLLING,
        gemini_configured: Boolean(settings.gemini_api_key || config.GEMINI_API_KEY),
        business_account: conn ? {
          connected: conn.isEnabled,
          owner: conn.ownerUsername ? `@${conn.ownerUsername}` : String(conn.ownerUserId),
          can_reply: conn.canReply,
        } : null,
        linko: {
          base_url: settings.linko_base_url,
          live_token_active: true,
          read_only_mode: false,
          live_mode: true,
        },
        time: new Date().toISOString(),
      });
    }

    if ((pathname === '/health' || pathname === '/api/health') && req.method === 'GET') {
      return sendJson(res, 200, {
        status: 'ok',
        uptime_sec: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
        service: 'AKM Holdings B2B Bot & CRM Platform',
        mode: config.MODE,
        linko_url: config.LINKO_BASE_URL,
      });
    }

    if (pathname === '/api/linko/ping' && req.method === 'GET') {
      const [ping, settings] = await Promise.all([
        linko.ping(),
        getAllSettings(),
      ]);
      return sendJson(res, 200, {
        ...ping,
        base_url: settings.linko_base_url,
        live_active: ping.ok,
      });
    }

    if (pathname === '/api/bot/toggle' && req.method === 'POST') {
      const body = await parseJsonBody<{ enabled?: boolean }>(req);
      const current = await isBotEnabled();
      const nextState = typeof body.enabled === 'boolean' ? body.enabled : !current;
      await updateSettings({ bot_enabled: nextState });
      log.info(`Админка: тумблер бота переключен в состояние ${nextState ? 'ВКЛ' : 'ВЫКЛ'}`);
      return sendJson(res, 200, { ok: true, bot_enabled: nextState });
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      const db = await getDb();
      const debts = await calculateDebts();
      const sleepers = await findDormantMarkets();

      const allOrders = await db
        .select({
          id: orders.id,
          marketName: orders.marketName,
          totalPrice: orders.totalPrice,
          createdDate: orders.createdDate,
          status: orders.status,
          createdByBot: orders.createdByBot,
        })
        .from(orders)
        .orderBy(desc(orders.id))
        .limit(10);

      const [totals] = await db
        .select({
          count: sql<number>`count(*)::int`,
          volume: sql<string>`coalesce(sum(${orders.totalPrice}), 0)`,
        })
        .from(orders);

      return sendJson(res, 200, {
        orders_count: totals?.count ?? 0,
        orders_volume: toSum(totals?.volume ?? 0),
        total_debt: debts.totalDebt,
        total_overdue: debts.totalOverdue,
        debtors_count: debts.debtorsCount,
        aging: {
          b0_7: debts.bucket0007,
          b8_30: debts.bucket0830,
          b31_60: debts.bucket3160,
          b60p: debts.bucket60p,
        },
        sleepers_count: sleepers.length,
        recent_orders: allOrders.map((o) => ({
          id: Math.abs(o.id),
          market_name: o.marketName || 'Не указан',
          total_price: toSum(o.totalPrice),
          created_date: o.createdDate,
          status: o.status || 'new',
          created_by_bot: o.createdByBot,
        })),
      });
    }

    if (pathname === '/api/settings' && req.method === 'GET') {
      const s = await getAllSettings();
      return sendJson(res, 200, {
        ...s,
        telegram_bot_token_masked: s.telegram_bot_token || config.BOT_TOKEN
          ? '••••••••' + (s.telegram_bot_token || config.BOT_TOKEN).slice(-5)
          : '',
        gemini_api_key_masked: s.gemini_api_key || config.GEMINI_API_KEY
          ? '••••••••' + (s.gemini_api_key || config.GEMINI_API_KEY).slice(-4)
          : '',
        linko_token_masked: s.linko_token || config.LINKO_TOKEN
          ? '••••••••' + (s.linko_token || config.LINKO_TOKEN).slice(-4)
          : '',
      });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const updated = await updateSettings(body);
      log.info('Админка: настройки White-Label успешно сохранены');
      return sendJson(res, 200, { ok: true, settings: updated });
    }

    if (pathname === '/api/telegram/update-profile' && req.method === 'POST') {
      const body = await parseJsonBody<{ name?: string; description?: string; shortDescription?: string }>(req);
      const settings = await getAllSettings();
      const token = settings.telegram_bot_token || config.BOT_TOKEN;

      if (!token) {
        return sendJson(res, 400, { ok: false, error: 'BOT_TOKEN не задан' });
      }

      const results: Record<string, any> = {};

      if (body.name) {
        const r = await fetch(`https://api.telegram.org/bot${token}/setMyName`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: body.name }),
        });
        results.setMyName = await r.json();
      }

      if (body.description) {
        const r = await fetch(`https://api.telegram.org/bot${token}/setMyDescription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: body.description }),
        });
        results.setMyDescription = await r.json();
      }

      if (body.shortDescription) {
        const r = await fetch(`https://api.telegram.org/bot${token}/setMyShortDescription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ short_description: body.shortDescription }),
        });
        results.setMyShortDescription = await r.json();
      }

      log.info('Админка: профиль бота в Telegram обновлён', results);
      return sendJson(res, 200, { ok: true, results });
    }

    if (pathname === '/api/orders' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q')?.trim() || '';
      const statusFilter = parsedUrl.searchParams.get('status')?.trim() || '';
      const limit = Math.min(100, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 50));
      const offset = Math.max(0, Number(parsedUrl.searchParams.get('offset')) || 0);

      const db = await getDb();
      let query = db
        .select({
          id: orders.id,
          marketId: orders.marketId,
          marketName: orders.marketName,
          totalPrice: orders.totalPrice,
          status: orders.status,
          createdDate: orders.createdDate,
          dateDelivery: orders.dateDelivery,
          paymentType: orders.paymentType,
          createdByBot: orders.createdByBot,
        })
        .from(orders);

      const conditions = [];
      if (statusFilter && statusFilter !== 'all') {
        conditions.push(eq(orders.status, statusFilter));
      }
      if (q) {
        const numQ = Number(q);
        if (!isNaN(numQ) && q.length > 0) {
          conditions.push(or(
            sql`lower(${orders.marketName}) LIKE ${'%' + q.toLowerCase() + '%'}`,
            eq(orders.id, numQ),
            eq(orders.id, -numQ)
          ));
        } else {
          conditions.push(sql`lower(${orders.marketName}) LIKE ${'%' + q.toLowerCase() + '%'}`);
        }
      }

      if (conditions.length > 0) {
        query = query.where(and(...conditions)) as any;
      }

      const list = await query
        .orderBy(desc(orders.id))
        .limit(limit)
        .offset(offset);

      return sendJson(res, 200, list.map((o) => ({
        ...o,
        id: Math.abs(o.id),
        real_id: o.id,
        total_price_num: toSum(o.totalPrice),
        total_price_fmt: fmtSum(toSum(o.totalPrice)),
      })));
    }

    const orderItemsMatch = pathname.match(/^\/api\/orders\/(-?\d+)\/items$/);
    if (orderItemsMatch && req.method === 'GET') {
      const orderId = Number(orderItemsMatch[1]);
      const db = await getDb();
      const [o] = await db
        .select()
        .from(orders)
        .where(or(eq(orders.id, orderId), eq(orders.id, -orderId)))
        .limit(1);

      if (!o) {
        return sendJson(res, 404, { ok: false, error: `Заказ #${orderId} не найден` });
      }

      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, o.id));
      const market = o.marketId ? (await db.select().from(markets).where(eq(markets.id, o.marketId)).limit(1))[0] : null;

      return sendJson(res, 200, {
        order: {
          id: Math.abs(o.id),
          real_id: o.id,
          market_name: o.marketName || market?.name || 'Не указан',
          market_inn: o.marketInn || market?.inn || '—',
          market_phone: (market?.phones as string[])?.[0] || '—',
          market_address: market?.address || 'г. Ташкент',
          created_date: o.createdDate,
          date_delivery: o.dateDelivery,
          payment_type: o.paymentType === 'bank' ? 'Перечисление' : 'Наличные',
          status: o.status || 'new',
          total_price: toSum(o.totalPrice),
          total_price_fmt: fmtSum(toSum(o.totalPrice)),
          created_by_bot: o.createdByBot,
        },
        items: items.map((it) => ({
          id: it.id,
          product_id: it.productId,
          product_name: it.productName || `Товар #${it.productId}`,
          amount: it.amount,
          amount_fmt: fmtAmount(it.amount),
          price: toSum(it.price),
          price_fmt: fmtNum(it.price),
          total_price: toSum(it.totalPrice),
          total_price_fmt: fmtNum(it.totalPrice),
          measurement_name: it.measurementName || 'шт',
        })),
      });
    }

    const orderPdfMatch = pathname.match(/^\/api\/orders\/(-?\d+)\/pdf$/);
    if (orderPdfMatch && req.method === 'GET') {
      const orderId = Number(orderPdfMatch[1]);
      try {
        const pdfBuf = await generateWaybillPdf(orderId);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="nakladnaya_${Math.abs(orderId)}.pdf"`,
          'Content-Length': pdfBuf.length,
        });
        res.end(pdfBuf);
        return;
      } catch (e) {
        return sendJson(res, 404, { ok: false, error: (e as Error).message });
      }
    }

    if (pathname === '/api/debts' && req.method === 'GET') {
      const overview = await calculateDebts();
      return sendJson(res, 200, overview);
    }

    const debtPdfMatch = pathname.match(/^\/api\/debts\/(-?\d+)\/pdf$/);
    if (debtPdfMatch && req.method === 'GET') {
      const marketId = Number(debtPdfMatch[1]);
      try {
        const pdfBuf = await generateReconciliationPdf(marketId);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="akt_sverki_${marketId}.pdf"`,
          'Content-Length': pdfBuf.length,
        });
        res.end(pdfBuf);
        return;
      } catch (e) {
        return sendJson(res, 404, { ok: false, error: (e as Error).message });
      }
    }

    if (pathname === '/api/sleepers' && req.method === 'GET') {
      const sleepers = await findDormantMarkets();
      return sendJson(res, 200, sleepers);
    }

    if (pathname === '/api/ai/simulate' && req.method === 'POST') {
      const body = await parseJsonBody<{
        message: string;
        marketId?: number;
        clientName?: string;
        history?: { role: 'user' | 'model'; text: string }[];
      }>(req);

      if (!body.message?.trim()) {
        return sendJson(res, 400, { ok: false, error: 'Сообщение не может быть пустым' });
      }

      let marketName: string | null = null;
      if (body.marketId) {
        const db = await getDb();
        const [m] = await db.select().from(markets).where(eq(markets.id, body.marketId)).limit(1);
        marketName = m?.name ?? null;
      }

      const turn = await runAgent({
        message: body.message,
        channel: 'A',
        ctx: { marketId: body.marketId ?? null },
        clientName: body.clientName || 'Покупатель (Тест)',
        marketName,
        history: body.history,
      });

      return sendJson(res, 200, {
        reply: turn.reply,
        toolCalls: turn.toolCalls,
        attachments: turn.attachments,
        handoff: turn.handoff,
        error: turn.error,
      });
    }

    if (pathname === '/api/sync/trigger' && req.method === 'POST') {
      const results = await syncAll();
      return sendJson(res, 200, { ok: true, results });
    }

    if (pathname === '/api/markets' && req.method === 'GET') {
      const q = parsedUrl.searchParams.get('q')?.toLowerCase() || '';
      const limit = Math.min(200, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 100));
      const db = await getDb();
      const allMarkets = await db
        .select({
          id: markets.id,
          name: markets.name,
          inn: markets.inn,
          address: markets.address,
          phones: markets.phones,
        })
        .from(markets)
        .orderBy(markets.name);

      const filtered = q
        ? allMarkets.filter(
            (m) =>
              (m.name && m.name.toLowerCase().includes(q)) ||
              (m.inn && m.inn.includes(q)) ||
              (m.address && m.address.toLowerCase().includes(q))
          )
        : allMarkets;

      return sendJson(res, 200, filtered.slice(0, limit));
    }

    const publicDir = resolve(process.cwd(), 'public', 'admin');

    if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') {
      return serveStatic(res, join(publicDir, 'index.html'));
    }

    if (pathname.startsWith('/admin/')) {
      const rel = pathname.slice('/admin/'.length);
      return serveStatic(res, join(publicDir, rel));
    }

    const directPath = join(publicDir, pathname.replace(/^\//, ''));
    if (existsSync(directPath) && !statSync(directPath).isDirectory()) {
      return serveStatic(res, directPath);
    }

    return sendJson(res, 404, { error: 'Маршрут не найден', path: pathname });
  } catch (err) {
    log.error(`Admin API Error: ${(err as Error).message}`);
    return sendJson(res, 500, { error: 'Внутренняя ошибка сервера', details: (err as Error).message });
  }
}

export function startAdminServer(port: number = 3000): Server {
  const server = createServer((req, res) => {
    void handleAdminRequest(req, res);
  });

  server.listen(port, '0.0.0.0', () => {
    log.info(`👑 White-Label B2B Панель управления запущена: http://localhost:${port}/admin`);
  });

  return server;
}
