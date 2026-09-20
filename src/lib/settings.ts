import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { systemSettings } from '../db/schema.js';
import { config } from '../config.js';
import { log } from './logger.js';

export interface AppSettings {
  bot_enabled: boolean;
  mode: 'live' | 'assist' | 'shadow' | 'dry_run';
  company_name: string;
  company_brand: string;
  company_inn: string;
  company_mfo: string;
  company_bank: string;
  company_account: string;
  company_address: string;
  company_phone: string;
  manager_name: string;
  manager_role: string;
  manager_phone: string;
  custom_rules: string;
  knowledge_base: string;
  greeting_ru: string;
  greeting_uz: string;
  gemini_model: string;
  telegram_bot_token: string;
  gemini_api_key: string;
  linko_base_url: string;
  linko_token: string;
}

export interface CompanyProfile {
  name: string;
  brand: string;
  inn: string;
  mfo: string;
  account: string;
  bank: string;
  address: string;
  phone: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  bot_enabled: true,
  mode: config.MODE,
  company_name: 'ООО «AKM HOLDINGS INC»',
  company_brand: 'AKM Distribution',
  company_inn: '308057864',
  company_mfo: '00440',
  company_bank: 'АКБ "УЗСАНОАТКУРИЛИШБАНКИ"',
  company_account: '2020 8000 0053 2388 6001',
  company_address: 'г. Ташкент, Мирабадский район, ул. Сайхун, дом 170А/16',
  company_phone: '+998 99 9255955',
  manager_name: 'Шохрух',
  manager_role: 'ведущий менеджер отдела продаж',
  manager_phone: '+998 99 9255955',
  custom_rules: '',
  knowledge_base: `Доставка: осуществляем на следующий день после подтверждения заказа.
Минимальный заказ: от 500 000 сум по Ташкенту.
Оплата: перечислением 1-в-1 с НДС (для юрлиц), либо по согласованию с менеджером.
Документы: полный пакет электронных счетов-фактур (ЭСФ) через Дидокс.
Самовывоз: склад работает с 09:00 до 18:00 (пн-сб).`,
  greeting_ru: 'Здравствуйте! Меня зовут {manager_name}, компания {company_name}. Чем могу помочь?',
  greeting_uz: 'Ассалому алейкум! Мен {manager_name}, {company_name} компаниясидан. Қандай ёрдам бера оламан?',
  gemini_model: config.GEMINI_MODEL,
  telegram_bot_token: '',
  gemini_api_key: '',
  linko_base_url: config.LINKO_BASE_URL,
  linko_token: '',
};

let cache: AppSettings | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5000; // 5 секунд кэша

export async function getAllSettings(): Promise<AppSettings> {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) {
    return { ...cache };
  }

  try {
    const db = await getDb();
    const rows = await db.select().from(systemSettings);
    const map = new Map<string, string>();
    for (const r of rows) {
      map.set(r.key, r.value);
    }

    const result: AppSettings = {
      bot_enabled: map.has('bot_enabled') ? map.get('bot_enabled') === 'true' : DEFAULT_SETTINGS.bot_enabled,
      mode: (map.get('mode') as AppSettings['mode']) || DEFAULT_SETTINGS.mode,
      company_name: map.get('company_name') || DEFAULT_SETTINGS.company_name,
      company_brand: map.get('company_brand') || DEFAULT_SETTINGS.company_brand,
      company_inn: map.get('company_inn') || DEFAULT_SETTINGS.company_inn,
      company_mfo: map.get('company_mfo') || DEFAULT_SETTINGS.company_mfo,
      company_bank: map.get('company_bank') || DEFAULT_SETTINGS.company_bank,
      company_account: map.get('company_account') || DEFAULT_SETTINGS.company_account,
      company_address: map.get('company_address') || DEFAULT_SETTINGS.company_address,
      company_phone: map.get('company_phone') || DEFAULT_SETTINGS.company_phone,
      manager_name: map.get('manager_name') || DEFAULT_SETTINGS.manager_name,
      manager_role: map.get('manager_role') || DEFAULT_SETTINGS.manager_role,
      manager_phone: map.get('manager_phone') || DEFAULT_SETTINGS.manager_phone,
      custom_rules: map.has('custom_rules') ? map.get('custom_rules')! : DEFAULT_SETTINGS.custom_rules,
      knowledge_base: map.has('knowledge_base') ? map.get('knowledge_base')! : DEFAULT_SETTINGS.knowledge_base,
      greeting_ru: map.get('greeting_ru') || DEFAULT_SETTINGS.greeting_ru,
      greeting_uz: map.get('greeting_uz') || DEFAULT_SETTINGS.greeting_uz,
      gemini_model: map.get('gemini_model') || DEFAULT_SETTINGS.gemini_model,
      telegram_bot_token: map.get('telegram_bot_token') || '',
      gemini_api_key: map.get('gemini_api_key') || '',
      linko_base_url: map.get('linko_base_url') || DEFAULT_SETTINGS.linko_base_url,
      linko_token: map.get('linko_token') || '',
    };

    cache = result;
    cacheTime = now;
    return { ...result };
  } catch (e) {
    log.warn('Не удалось прочитать system_settings из БД, использую значения по умолчанию', (e as Error).message);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
  const db = await getDb();
  const now = new Date();

  for (const [k, val] of Object.entries(updates)) {
    if (val === undefined) continue;
    const strVal = typeof val === 'boolean' ? String(val) : String(val);
    
    // UPSERT в system_settings
    await db
      .insert(systemSettings)
      .values({
        key: k,
        value: strVal,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: strVal,
          updatedAt: now,
        },
      });
  }

  // Сброс кэша
  cache = null;
  cacheTime = 0;
  return getAllSettings();
}

export async function isBotEnabled(): Promise<boolean> {
  const settings = await getAllSettings();
  return settings.bot_enabled;
}

export async function getActiveMode(): Promise<AppSettings['mode']> {
  const settings = await getAllSettings();
  return settings.mode;
}

export async function getCompanyProfile(): Promise<CompanyProfile> {
  const s = await getAllSettings();
  return {
    name: s.company_name,
    brand: s.company_brand || s.company_name,
    inn: s.company_inn,
    mfo: s.company_mfo,
    account: s.company_account,
    bank: s.company_bank,
    address: s.company_address,
    phone: s.company_phone,
  };
}
