import {
  pgTable, text, integer, bigint, boolean, timestamp, numeric,
  jsonb, primaryKey, index, uniqueIndex, serial,
} from 'drizzle-orm/pg-core';

/* ─────────── Служебное ─────────── */

/** Курсор last_tm по каждой сущности Linko */
export const syncState = pgTable('sync_state', {
  entity: text('entity').primaryKey(),
  lastTm: numeric('last_tm').notNull().default('0'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastError: text('last_error'),
  rowsTotal: integer('rows_total').notNull().default(0),
});

/* ─────────── Зеркало Linko ─────────── */

export const markets = pgTable('markets', {
  id: integer('id').primaryKey(),
  uuid: text('uuid'),
  serviceId: text('service_id'),
  name: text('name').notNull(),
  inn: text('inn'),
  code: text('code'),
  contactName: text('contact_name'),
  phones: jsonb('phones').$type<string[]>().notNull().default([]),
  marketTypeId: integer('market_type_id'),
  marketTypeName: text('market_type_name'),
  responsibleAgentId: integer('responsible_agent_id'),
  priceListId: integer('price_list_id'),
  address: text('address'),
  lat: numeric('lat'),
  lon: numeric('lon'),
  tm: numeric('tm'),
  raw: jsonb('raw'),
}, (t) => ({
  nameIdx: index('markets_name_idx').on(t.name),
}));

export const products = pgTable('products', {
  id: integer('id').primaryKey(),
  serviceId: text('service_id'),
  code: text('code'),
  name: text('name').notNull(),
  productTypeId: integer('product_type_id'),
  measurementName: text('measurement_name'),
  isActive: boolean('is_active').notNull().default(true),
  tm: numeric('tm'),
  raw: jsonb('raw'),
}, (t) => ({ nameIdx: index('products_name_idx').on(t.name) }));

export const prices = pgTable('prices', {
  priceListId: integer('price_list_id').notNull(),
  productId: integer('product_id').notNull(),
  price: numeric('price').notNull(),
  tm: numeric('tm'),
}, (t) => ({ pk: primaryKey({ columns: [t.priceListId, t.productId] }) }));

export const balances = pgTable('balances', {
  stockId: integer('stock_id').notNull(),
  productId: integer('product_id').notNull(),
  balance: numeric('balance').notNull().default('0'),
  tm: numeric('tm'),
}, (t) => ({ pk: primaryKey({ columns: [t.stockId, t.productId] }) }));

export const orders = pgTable('orders', {
  id: integer('id').primaryKey(),
  uuid: text('uuid'),
  serviceId: text('service_id'),
  marketId: integer('market_id'),
  marketName: text('market_name'),
  marketInn: text('market_inn'),
  agentId: integer('agent_id'),
  deliveryManId: integer('delivery_man_id'),
  stockId: integer('stock_id'),
  status: text('status'),
  paymentType: text('payment_type'),
  createdDate: text('created_date'),
  dateDelivery: text('date_delivery'),
  paymentDate: text('payment_date'),
  invoiceNumber: text('invoice_number'),
  invoiceDate: text('invoice_date'),
  totalPrice: numeric('total_price').notNull().default('0'),
  discountPrice: numeric('discount_price').notNull().default('0'),
  comment: text('comment'),
  /** заказ, созданный нашим ботом (M2) */
  createdByBot: boolean('created_by_bot').notNull().default(false),
  tm: numeric('tm'),
  raw: jsonb('raw'),
}, (t) => ({
  marketIdx: index('orders_market_idx').on(t.marketId),
  statusIdx: index('orders_status_idx').on(t.status),
  dateIdx: index('orders_date_idx').on(t.createdDate),
}));

export const orderItems = pgTable('order_items', {
  id: integer('id').primaryKey(),
  orderId: integer('order_id').notNull(),
  productId: integer('product_id'),
  productName: text('product_name'),
  amount: numeric('amount').notNull().default('0'),
  price: numeric('price').notNull().default('0'),
  totalPrice: numeric('total_price').notNull().default('0'),
  totalDiscount: numeric('total_discount').notNull().default('0'),
  measurementName: text('measurement_name'),
}, (t) => ({ orderIdx: index('order_items_order_idx').on(t.orderId) }));

export const payments = pgTable('payments', {
  id: integer('id').primaryKey(),
  uuid: text('uuid'),
  serviceId: text('service_id'),
  marketId: integer('market_id'),
  marketName: text('market_name'),
  marketInn: text('market_inn'),
  orderId: integer('order_id'),
  amount: numeric('amount').notNull().default('0'),
  paymentType: text('payment_type'),
  status: text('status'),
  type: text('type'),
  userId: integer('user_id'),
  comment: text('comment'),
  createdDate: text('created_date'),
  acceptedTime: text('accepted_time'),
  isDelete: boolean('is_delete').notNull().default(false),
  tm: numeric('tm'),
  raw: jsonb('raw'),
}, (t) => ({
  marketIdx: index('payments_market_idx').on(t.marketId),
  typeIdx: index('payments_type_idx').on(t.paymentType, t.status),
}));

export const promotions = pgTable('promotions', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type'),
  discountType: text('discount_type'),
  beginDate: text('begin_date'),
  tillDate: text('till_date'),
  discount: numeric('discount'),
  isApplyAll: boolean('is_apply_all').notNull().default(false),
  products: jsonb('products'),
  tm: numeric('tm'),
  raw: jsonb('raw'),
});

/* ─────────── Наше ─────────── */

/** Клиент как личность, независимо от канала */
export const customers = pgTable('customers', {
  id: serial('id').primaryKey(),
  tgUserId: bigint('tg_user_id', { mode: 'number' }).notNull(),
  firstName: text('first_name'),
  username: text('username'),
  phone: text('phone'),
  lang: text('lang').notNull().default('ru'),
  marketIds: jsonb('market_ids').$type<number[]>().notNull().default([]),
  /** согласие на проактивные сообщения (M4) */
  optedOut: boolean('opted_out').notNull().default(false),
  optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
  blockedBot: boolean('blocked_bot').notNull().default(false),
  needsManualLink: boolean('needs_manual_link').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uid: uniqueIndex('customers_tg_uid').on(t.tgUserId) }));

/** Склейка каналов: один человек — разные chat_id в A и B */
export const channelBindings = pgTable('channel_bindings', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').notNull(),
  channel: text('channel').notNull(),
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  businessConnectionId: text('business_connection_id'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
}, (t) => ({ uq: uniqueIndex('channel_bindings_uq').on(t.channel, t.chatId) }));

/** Активные Business-подключения аккаунта */
export const businessConnections = pgTable('business_connections', {
  id: text('id').primaryKey(),
  ownerUserId: bigint('owner_user_id', { mode: 'number' }).notNull(),
  ownerUsername: text('owner_username'),
  canReply: boolean('can_reply').notNull().default(false),
  isEnabled: boolean('is_enabled').notNull().default(true),
  rights: jsonb('rights'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Вся переписка — с пометкой канала */
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id'),
  channel: text('channel').notNull(),
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  tgMessageId: integer('tg_message_id'),
  direction: text('direction').notNull(),
  author: text('author').notNull(),
  text: text('text'),
  toolCalls: jsonb('tool_calls'),
  mode: text('mode'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ chatIdx: index('messages_chat_idx').on(t.chatId, t.createdAt) }));

/** Что и кому отправлено — дедупликация и антиспам */
export const outbox = pgTable('outbox', {
  id: serial('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull(),
  channel: text('channel').notNull(),
  chatId: bigint('chat_id', { mode: 'number' }),
  kind: text('kind').notNull(),
  payload: jsonb('payload'),
  status: text('status').notNull().default('pending'),
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ dedupe: uniqueIndex('outbox_dedupe').on(t.dedupeKey) }));

/** M1: состояние заказа в ЭСФ-конвейере */
export const esfQueue = pgTable('esf_queue', {
  orderId: integer('order_id').primaryKey(),
  status: text('status').notNull().default('new'),
  cardChatId: bigint('card_chat_id', { mode: 'number' }),
  cardMessageId: integer('card_message_id'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  issuedByUserId: bigint('issued_by_user_id', { mode: 'number' }),
  issuedByName: text('issued_by_name'),
  syncedToLinko: boolean('synced_to_linko').notNull().default(false),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  note: text('note'),
}, (t) => ({ statusIdx: index('esf_status_idx').on(t.status) }));

/**
 * Библиотека файлов: прайсы, фото товаров, ролики.
 * file_id кэшируется после первой отправки — Telegram позволяет
 * переиспользовать его и не заливать файл заново каждый раз.
 */
export const mediaFiles = pgTable('media_files', {
  key: text('key').primaryKey(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
  path: text('path'),
  fileId: text('file_id'),
  caption: text('caption'),
  isActive: boolean('is_active').notNull().default(true),
  sentCount: integer('sent_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** M5: ежедневный срез дебиторки */
export const debtSnapshots = pgTable('debt_snapshots', {
  id: serial('id').primaryKey(),
  date: text('date').notNull(),
  marketId: integer('market_id').notNull(),
  debtTotal: numeric('debt_total').notNull().default('0'),
  overdue: numeric('overdue').notNull().default('0'),
  bucket0007: numeric('bucket_0_7').notNull().default('0'),
  bucket0830: numeric('bucket_8_30').notNull().default('0'),
  bucket3160: numeric('bucket_31_60').notNull().default('0'),
  bucket60p: numeric('bucket_60_plus').notNull().default('0'),
}, (t) => ({ uq: uniqueIndex('debt_snap_uq').on(t.date, t.marketId) }));
