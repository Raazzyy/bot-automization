import { config } from '../config.js';
import { log } from '../lib/logger.js';
import type {
  Envelope, LinkoMarket, LinkoOrder, LinkoPayment, LinkoProduct,
  LinkoProductBalance, LinkoPriceListItem, LinkoPromotion, LinkoUser,
  SyncOrderPayload,
} from './types.js';

const API = '/api/v1/integration/external-api';

const MAX_LIMIT = 1000;

export class LinkoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'LinkoError';
  }
}

export type Query = Record<string, string | number | undefined>;

function buildUrl(path: string, query: Query = {}): string {
  const url = new URL(API + path, config.LINKO_BASE_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Query; body?: unknown; attempt?: number } = {},
): Promise<T> {
  const attempt = opts.attempt ?? 1;
  const url = buildUrl(path, opts.query);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `External ${config.LINKO_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if (attempt < 4) {
      const wait = 500 * 2 ** (attempt - 1);
      log.warn(`Linko ${path}: сеть недоступна, повтор через ${wait}мс`, { attempt });
      await sleep(wait);
      return request<T>(method, path, { ...opts, attempt: attempt + 1 });
    }
    throw new LinkoError(`Сеть недоступна: ${(e as Error).message}`, 0, '', path);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');

    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = 1000 * 2 ** (attempt - 1);
      log.warn(`Linko ${path}: HTTP ${res.status}, повтор через ${wait}мс`, { attempt });
      await sleep(wait);
      return request<T>(method, path, { ...opts, attempt: attempt + 1 });
    }

    let detail = '';
    try {
      const j = JSON.parse(body) as { detail?: string };
      if (j.detail) detail = j.detail;
    } catch {}

    let hint = '';
    if (/integration disabled/i.test(detail)) {
      hint = ' — внешний API выключен на стороне Linko.'
        + ' Попросите техподдержку включить External API для вашего аккаунта.';
    } else if (res.status === 401 || res.status === 403) {
      hint = ' — проверьте LINKO_TOKEN';
    } else if (res.status === 404) {
      hint = ' — проверьте LINKO_BASE_URL и путь';
    }

    throw new LinkoError(
      `Linko ${method} ${path} вернул HTTP ${res.status}`
      + (detail ? ` (${detail})` : '') + hint,
      res.status,
      body.slice(0, 500),
      path,
    );
  }

  return (await res.json()) as T;
}

async function fetchAll<T>(
  path: string,
  query: Query = {},
  onPage?: (rows: T[], offset: number) => Promise<void> | void,
): Promise<T[]> {
  const limit = Number(query.limit ?? MAX_LIMIT);
  const all: T[] = [];
  let offset = 0;

  for (let page = 0; page < 500; page++) {
    const env = await request<Envelope<T>>('GET', path, {
      query: { ...query, limit, offset },
    });
    const rows = env.results ?? [];

    if (onPage) await onPage(rows, offset);
    else all.push(...rows);

    if (rows.length < limit) break;
    offset += limit;
  }

  return all;
}

export function maxTm(rows: { tm?: string | number | null }[], current = 0): number {
  let max = current;
  for (const r of rows) {
    const t = Number(r.tm ?? 0);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

export const linko = {
  async ping(): Promise<{ ok: true; users: number } | { ok: false; error: string }> {
    try {
      const env = await request<Envelope<LinkoUser>>('GET', '/users/', {
        query: { limit: 1 },
      });
      return { ok: true, users: env.results?.length ?? 0 };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  markets: (q: Query = {}, onPage?: (r: LinkoMarket[], o: number) => Promise<void> | void) =>
    fetchAll<LinkoMarket>('/markets/', q, onPage),

  orders: (q: Query = {}, onPage?: (r: LinkoOrder[], o: number) => Promise<void> | void) =>
    fetchAll<LinkoOrder>('/orders/', q, onPage),

  payments: (q: Query = {}, onPage?: (r: LinkoPayment[], o: number) => Promise<void> | void) =>
    fetchAll<LinkoPayment>('/payments/', q, onPage),

  products: (q: Query = {}, onPage?: (r: LinkoProduct[], o: number) => Promise<void> | void) =>
    fetchAll<LinkoProduct>('/products/', q, onPage),

  productBalances: (q: Query = {}, onPage?: (r: LinkoProductBalance[], o: number) => Promise<void> | void) =>
    fetchAll<LinkoProductBalance>('/product_balances/', q, onPage),

  priceListItems: (q: Query = {}, onPage?: (r: LinkoPriceListItem[], o: number) => Promise<void> | void) =>
    fetchAll<LinkoPriceListItem>('/price_list_items/', q, onPage),

  promotions: (q: Query = {}, onPage?: (r: LinkoPromotion[], o: number) => Promise<void> | void) =>
    fetchAll<LinkoPromotion>('/promotions/', q, onPage),

  users: (q: Query = {}) => fetchAll<LinkoUser>('/users/', q),

  async syncOrders(orders: SyncOrderPayload[]) {
    return request<Envelope<{ id: number; service_id?: string }>>(
      'POST',
      '/sync_order/',
      { body: orders },
    );
  },

  async markOrdersSynced(orderIds: (number | string)[]) {
    return request<{ success: boolean }>('POST', '/order_synced/', {
      body: { linko_order_ids: orderIds.map(String) },
    });
  },
};
