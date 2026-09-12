import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { products, prices, balances } from '../db/schema.js';
import type { ExtractedEntity, ExtractedItem } from './extract.js';

export interface CatalogProduct {
  id: number;
  name: string;
  measurementName: string | null;
  price: number;
  balance: number;
}

export interface MatchedCatalogItem {
  rawName: string;
  qty: number;
  rawUnit: string | null;
  productId: number | null;
  officialName: string;
  price: number;
  totalPrice: number;
  unit: string;
  stock: number;
  isMatched: boolean;
  confidence: 'exact' | 'high' | 'fuzzy' | 'fallback';
}

export interface EnrichedEntity {
  entity: string | null;
  items: MatchedCatalogItem[];
  totalSum: number;
}

/** Официальный эталонный каталог из Прайс 2026.pdf */
export const OFFICIAL_AKM_CATALOG = [
  // Уксусы Sayam (500 мл стекло)
  { name: 'Яблочный уксус фильтрованный Sayam 500 мл', price: 29_000, unit: 'бут', inBox: 12 },
  { name: 'Яблочный уксус нефильтрованный Sayam 500 мл', price: 39_000, unit: 'бут', inBox: 12 },
  { name: 'Белый виноградный уксус Sayam 500 мл', price: 29_000, unit: 'бут', inBox: 12 },
  { name: 'Черный виноградный уксус Sayam 500 мл', price: 29_000, unit: 'бут', inBox: 12 },
  { name: 'Бальзамический уксус Sayam 500 мл', price: 39_000, unit: 'бут', inBox: 12 },

  // Burcu: томатная паста, соусы, вяленые томаты, пицца соус
  { name: 'Томатная паста Burcu 830 г ж/б', price: 37_000, unit: 'бан', inBox: 12 },
  { name: 'Томатная паста Burcu 600 г стекло', price: 37_000, unit: 'бан', inBox: 12 },
  { name: 'Томатная паста Burcu 4300 г ж/б', price: 149_900, unit: 'бан', inBox: 6 },
  { name: 'Соус Napolitena Burcu 310 г стекло', price: 20_000, unit: 'бан', inBox: 12 },
  { name: 'Соус Arrabbiata Burcu 310 г стекло', price: 20_000, unit: 'бан', inBox: 12 },
  { name: 'Вяленые помидоры в масле Burcu 300 г стекло', price: 39_000, unit: 'бан', inBox: 12 },
  { name: 'Пицца соус Burcu 580 г стекло', price: 26_000, unit: 'бан', inBox: 12 },
  { name: 'Пицца соус Burcu 4200 г ж/б', price: 139_900, unit: 'бан', inBox: 6 },

  // Соусы и соки Doganay & Nare
  { name: 'Гранатовый соус Doganay 340 г ПЭТ', price: 25_900, unit: 'бут', inBox: 12 },
  { name: 'Гранатовый соус Doganay 680 г ПЭТ', price: 34_900, unit: 'бут', inBox: 12 },
  { name: 'Гранатовый соус Doganay 1000 г ПЭТ', price: 42_900, unit: 'бут', inBox: 12 },
  { name: 'Лимонный соус Doganay 500 мл ПЭТ', price: 19_900, unit: 'бут', inBox: 12 },
  { name: 'Лимонный соус Doganay 250 мл ПЭТ', price: 14_000, unit: 'бут', inBox: 24 },
  { name: 'Лимонный соус Doganay 1000 мл ПЭТ', price: 25_900, unit: 'бут', inBox: 12 },
  { name: '100% Лимонный сок Doganay 500 мл ПЭТ', price: 26_000, unit: 'бут', inBox: 12 },
  { name: '100% Гранатовый соус Nare 340 г стекло', price: 37_000, unit: 'бут', inBox: 6 },
  { name: 'Виноградный уксус Nare 500 мл ПЭТ', price: 20_000, unit: 'бут', inBox: 12 },
  { name: 'Виноградный уксус Nare 1000 мл ПЭТ', price: 32_000, unit: 'бут', inBox: 12 },
  { name: 'Яблочный уксус Doganay 500 мл ПЭТ', price: 25_900, unit: 'бут', inBox: 12 },

  // Тунец Dardanel
  { name: 'Тунец кусочками в собственном соку Dardanel 150 г', price: 29_900, unit: 'бан', inBox: 24 },
  { name: 'Тунец кусковой в подсолнечном масле Dardanel 150 г', price: 27_900, unit: 'бан', inBox: 24 },
  { name: 'Тунец филе в подсолнечном масле Dardanel 150 г', price: 29_900, unit: 'бан', inBox: 24 },
  { name: 'Тунец кусковой в оливковом масле Dardanel 150 г', price: 34_900, unit: 'бан', inBox: 24 },
  { name: 'Тунец в подсолнечном масле Dardanel HoReCa 1705 г', price: 245_000, unit: 'бан', inBox: 6 },

  // Халапеньо & Чили
  { name: 'Халапеньо Kavaklidere Efor 650 г стекло', price: 44_000, unit: 'бан', inBox: 12 },
  { name: 'Халапеньо Kavaklidere Efor 325 г стекло', price: 23_500, unit: 'бан', inBox: 12 },
  { name: 'Сладкий соус чили для курицы Scoville 5600 г', price: 180_000, unit: 'кан', inBox: 1 },
];

/** Узбекско-русский словарь HoReCa терминов */
const UZ_RU: Record<string, string> = {
  tunes: 'тунец', tunets: 'тунец', dardanel: 'dardanel', дарданел: 'dardanel',
  sirka: 'уксус', сирка: 'уксус',
  olma: 'яблочный', олма: 'яблочный',
  uzum: 'виноградный', узум: 'виноградный',
  anor: 'гранатовый', анор: 'гранатовый',
  limon: 'лимонный', лимон: 'лимонный',
  tomat: 'томатная', salca: 'паста', salcasi: 'паста',
  pomidor: 'помидоры', quritilgan: 'вяленые',
  sous: 'соус', sousi: 'соус',
  qalampir: 'халапеньо', jalapeno: 'халапеньо',
  chili: 'чили', shirin: 'сладкий',
  sharbat: 'сок',
};

/** Токенизация и перевод */
function normalizeTokens(s: string): string[] {
  const clean = s
    .toLowerCase()
    .replace(/[^a-zа-яё0-9_\s'ʻ‘]/gi, ' ')
    .trim();

  const rawTokens = clean.split(/\s+/).filter((t) => t.length > 1);
  const out: string[] = [];

  for (const t of rawTokens) {
    out.push(t);
    const tr = UZ_RU[t];
    if (tr) out.push(tr);
  }

  return [...new Set(out)];
}

/** Загрузка активного каталога с ценами и остатками из БД */
export async function getActiveCatalog(priceListId = 1): Promise<CatalogProduct[]> {
  const db = await getDb();

  const prods = await db.select().from(products).where(eq(products.isActive, true));
  if (!prods.length) {
    // Если в БД пока пусто, возвращаем официальный каталог по умолчанию
    return OFFICIAL_AKM_CATALOG.map((p, idx) => ({
      id: -(idx + 1),
      name: p.name,
      measurementName: p.unit,
      price: p.price,
      balance: 500,
    }));
  }

  const prRows = await db.select().from(prices).where(eq(prices.priceListId, priceListId));
  const priceMap = new Map<number, number>();
  for (const p of prRows) {
    priceMap.set(p.productId, Number(p.price) || 0);
  }

  const balRows = await db
    .select({
      productId: balances.productId,
      total: sql<string>`coalesce(sum(${balances.balance}), 0)`,
    })
    .from(balances)
    .groupBy(balances.productId);

  const balMap = new Map<number, number>();
  for (const b of balRows) {
    balMap.set(b.productId, Number(b.total) || 0);
  }

  return prods.map((p) => ({
    id: p.id,
    name: p.name,
    measurementName: p.measurementName,
    price: priceMap.get(p.id) ?? 29_000,
    balance: balMap.get(p.id) ?? 0,
  }));
}

/**
 * Интеллектуальное сопоставление (додумывание) позиции из свободного текста клиента
 * с товаром из официального каталога AKM Holdings.
 */
export function matchItemToCatalogSync(
  rawItem: ExtractedItem,
  catalog: CatalogProduct[],
): MatchedCatalogItem {
  const qty = rawItem.qty ?? 1;
  const rawUnit = rawItem.unit ?? null;
  const queryTokens = normalizeTokens(rawItem.name);

  if (!catalog.length || !queryTokens.length) {
    return {
      rawName: rawItem.name,
      qty,
      rawUnit,
      productId: null,
      officialName: rawItem.name,
      price: 29_000,
      totalPrice: 29_000 * qty,
      unit: rawUnit || 'шт',
      stock: 0,
      isMatched: false,
      confidence: 'fallback',
    };
  }

  let bestProduct: CatalogProduct | null = null;
  let bestScore = 0;
  let bestConfidence: MatchedCatalogItem['confidence'] = 'fallback';

  for (const prod of catalog) {
    const prodTokens = normalizeTokens(prod.name);
    let matchedTokenCount = 0;

    for (const q of queryTokens) {
      const hasMatch = prodTokens.some((pt) => pt === q || pt.includes(q) || q.includes(pt));
      if (hasMatch) {
        matchedTokenCount++;
      }
    }

    if (matchedTokenCount > 0) {
      let score = matchedTokenCount / queryTokens.length;
      const lowProd = prod.name.toLowerCase();

      // Приоритет совпадения брендов
      if (queryTokens.includes('dardanel') && lowProd.includes('dardanel')) score += 0.6;
      if (queryTokens.includes('burcu') && lowProd.includes('burcu')) score += 0.6;
      if (queryTokens.includes('sayam') && lowProd.includes('sayam')) score += 0.6;
      if (queryTokens.includes('doganay') && lowProd.includes('doganay')) score += 0.6;
      if (queryTokens.includes('nare') && lowProd.includes('nare')) score += 0.6;
      if (queryTokens.includes('scoville') && lowProd.includes('scoville')) score += 0.6;

      // Приоритет категорий
      if (queryTokens.includes('тунец') && lowProd.includes('тунец')) score += 0.5;
      if (queryTokens.includes('уксус') && lowProd.includes('уксус')) score += 0.5;
      if (queryTokens.includes('яблочный') && lowProd.includes('яблочный')) score += 0.5;
      if (queryTokens.includes('томатная') && lowProd.includes('томатная')) score += 0.5;
      if (queryTokens.includes('паста') && lowProd.includes('паста')) score += 0.4;
      if (queryTokens.includes('пицца') && lowProd.includes('пицца')) score += 0.6;
      if (queryTokens.includes('соус') && lowProd.includes('соус')) score += 0.3;
      if (queryTokens.includes('гранатовый') && lowProd.includes('гранатовый')) score += 0.5;
      if (queryTokens.includes('лимонный') && lowProd.includes('лимонный')) score += 0.5;
      if (queryTokens.includes('халапеньо') && lowProd.includes('халапеньо')) score += 0.7;
      if (queryTokens.includes('чили') && lowProd.includes('чили')) score += 0.7;
      if (queryTokens.includes('вяленые') && lowProd.includes('вяленые')) score += 0.7;

      // Приоритет граммовок (830, 4300, 500, 310, 150, 1705, 5600)
      for (const t of queryTokens) {
        if (/^\d{3,4}$/.test(t) && lowProd.includes(t)) {
          score += 0.4;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestProduct = prod;
        if (score >= 1.0) {
          bestConfidence = 'exact';
        } else if (score >= 0.7) {
          bestConfidence = 'high';
        } else {
          bestConfidence = 'fuzzy';
        }
      }
    }
  }

  // Если нашли товар в каталоге
  if (bestProduct && bestScore >= 0.35) {
    const price = bestProduct.price > 0 ? bestProduct.price : 29_000;
    const officialUnit = bestProduct.measurementName || rawUnit || 'шт';

    return {
      rawName: rawItem.name,
      qty,
      rawUnit,
      productId: bestProduct.id,
      officialName: bestProduct.name,
      price,
      totalPrice: price * qty,
      unit: officialUnit,
      stock: bestProduct.balance,
      isMatched: true,
      confidence: bestConfidence,
    };
  }

  // Fallback на официальный перечень AKM
  const rawLower = rawItem.name.toLowerCase();
  for (const ref of OFFICIAL_AKM_CATALOG) {
    const refLower = ref.name.toLowerCase();
    if (
      (rawLower.includes('тунец') && refLower.includes('тунец')) ||
      (rawLower.includes('dardanel') && refLower.includes('dardanel')) ||
      (rawLower.includes('уксус') && refLower.includes('уксус')) ||
      (rawLower.includes('томат') && refLower.includes('томат')) ||
      (rawLower.includes('гранат') && refLower.includes('гранат')) ||
      (rawLower.includes('пицца') && refLower.includes('пицца')) ||
      (rawLower.includes('халапень') && refLower.includes('халапень')) ||
      (rawLower.includes('чили') && refLower.includes('чили'))
    ) {
      return {
        rawName: rawItem.name,
        qty,
        rawUnit,
        productId: null,
        officialName: ref.name,
        price: ref.price,
        totalPrice: ref.price * qty,
        unit: rawUnit || ref.unit,
        stock: 500,
        isMatched: true,
        confidence: 'fuzzy',
      };
    }
  }

  return {
    rawName: rawItem.name,
    qty,
    rawUnit,
    productId: null,
    officialName: rawItem.name,
    price: 29_000,
    totalPrice: 29_000 * qty,
    unit: rawUnit || 'шт',
    stock: 0,
    isMatched: false,
    confidence: 'fallback',
  };
}

/**
 * Сопоставляет все позиции заказа из структуры ExtractedEntity[] с реальным каталогом Linko
 */
export async function matchOrderEntitiesToCatalog(
  entities: ExtractedEntity[],
  priceListId = 1,
): Promise<EnrichedEntity[]> {
  const catalog = await getActiveCatalog(priceListId);

  const enriched: EnrichedEntity[] = [];

  for (const ent of entities) {
    const matchedItems: MatchedCatalogItem[] = [];
    let totalSum = 0;

    for (const it of ent.items) {
      const matched = matchItemToCatalogSync(it, catalog);
      matchedItems.push(matched);
      totalSum += matched.totalPrice;
    }

    enriched.push({
      entity: ent.entity,
      items: matchedItems,
      totalSum,
    });
  }

  return enriched;
}
