import { sql } from 'drizzle-orm';
import { getDb } from './index.js';
import { log } from '../lib/logger.js';

/**
 * Схема создаётся обычным SQL, а не drizzle-kit: одни и те же запросы
 * проходят и на встроенной PGlite, и на боевом Postgres, без отдельного шага сборки.
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS sync_state (
     entity text PRIMARY KEY,
     last_tm numeric NOT NULL DEFAULT 0,
     last_run_at timestamptz,
     last_error text,
     rows_total integer NOT NULL DEFAULT 0
   )`,

  `CREATE TABLE IF NOT EXISTS markets (
     id integer PRIMARY KEY,
     uuid text, service_id text,
     name text NOT NULL,
     inn text, code text, contact_name text,
     phones jsonb NOT NULL DEFAULT '[]'::jsonb,
     market_type_id integer, market_type_name text,
     responsible_agent_id integer, price_list_id integer,
     address text, lat numeric, lon numeric,
     tm numeric, raw jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS markets_name_idx ON markets (name)`,

  `CREATE TABLE IF NOT EXISTS products (
     id integer PRIMARY KEY,
     service_id text, code text,
     name text NOT NULL,
     product_type_id integer, measurement_name text,
     is_active boolean NOT NULL DEFAULT true,
     tm numeric, raw jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS products_name_idx ON products (name)`,

  `CREATE TABLE IF NOT EXISTS prices (
     price_list_id integer NOT NULL,
     product_id integer NOT NULL,
     price numeric NOT NULL,
     tm numeric,
     PRIMARY KEY (price_list_id, product_id)
   )`,

  `CREATE TABLE IF NOT EXISTS balances (
     stock_id integer NOT NULL,
     product_id integer NOT NULL,
     balance numeric NOT NULL DEFAULT 0,
     tm numeric,
     PRIMARY KEY (stock_id, product_id)
   )`,

  `CREATE TABLE IF NOT EXISTS orders (
     id integer PRIMARY KEY,
     uuid text, service_id text,
     market_id integer, market_name text, market_inn text,
     agent_id integer, delivery_man_id integer, stock_id integer,
     status text, payment_type text,
     created_date text, date_delivery text, payment_date text,
     invoice_number text, invoice_date text,
     total_price numeric NOT NULL DEFAULT 0,
     discount_price numeric NOT NULL DEFAULT 0,
     comment text,
     created_by_bot boolean NOT NULL DEFAULT false,
     tm numeric, raw jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS orders_market_idx ON orders (market_id)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)`,
  `CREATE INDEX IF NOT EXISTS orders_date_idx ON orders (created_date)`,

  `CREATE TABLE IF NOT EXISTS order_items (
     id integer PRIMARY KEY,
     order_id integer NOT NULL,
     product_id integer, product_name text,
     amount numeric NOT NULL DEFAULT 0,
     price numeric NOT NULL DEFAULT 0,
     total_price numeric NOT NULL DEFAULT 0,
     total_discount numeric NOT NULL DEFAULT 0,
     measurement_name text
   )`,
  `CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id)`,

  `CREATE TABLE IF NOT EXISTS payments (
     id integer PRIMARY KEY,
     uuid text, service_id text,
     market_id integer, market_name text, market_inn text,
     order_id integer,
     amount numeric NOT NULL DEFAULT 0,
     payment_type text, status text, type text,
     user_id integer, comment text,
     created_date text, accepted_time text,
     is_delete boolean NOT NULL DEFAULT false,
     tm numeric, raw jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS payments_market_idx ON payments (market_id)`,
  `CREATE INDEX IF NOT EXISTS payments_type_idx ON payments (payment_type, status)`,

  `CREATE TABLE IF NOT EXISTS promotions (
     id integer PRIMARY KEY,
     name text NOT NULL,
     type text, discount_type text,
     begin_date text, till_date text,
     discount numeric,
     is_apply_all boolean NOT NULL DEFAULT false,
     products jsonb, tm numeric, raw jsonb
   )`,

  `CREATE TABLE IF NOT EXISTS customers (
     id serial PRIMARY KEY,
     tg_user_id bigint NOT NULL,
     first_name text, username text, phone text,
     lang text NOT NULL DEFAULT 'ru',
     market_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
     opted_out boolean NOT NULL DEFAULT false,
     opted_out_at timestamptz,
     blocked_bot boolean NOT NULL DEFAULT false,
     needs_manual_link boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS customers_tg_uid ON customers (tg_user_id)`,

  `CREATE TABLE IF NOT EXISTS channel_bindings (
     id serial PRIMARY KEY,
     customer_id integer NOT NULL,
     channel text NOT NULL,
     chat_id bigint NOT NULL,
     business_connection_id text,
     last_seen_at timestamptz
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_uq ON channel_bindings (channel, chat_id)`,

  `CREATE TABLE IF NOT EXISTS business_connections (
     id text PRIMARY KEY,
     owner_user_id bigint NOT NULL,
     owner_username text,
     can_reply boolean NOT NULL DEFAULT false,
     is_enabled boolean NOT NULL DEFAULT true,
     rights jsonb,
     connected_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS messages (
     id serial PRIMARY KEY,
     customer_id integer,
     channel text NOT NULL,
     chat_id bigint NOT NULL,
     tg_message_id integer,
     direction text NOT NULL,
     author text NOT NULL,
     text text,
     tool_calls jsonb,
     mode text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages (chat_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS outbox (
     id serial PRIMARY KEY,
     dedupe_key text NOT NULL,
     channel text NOT NULL,
     chat_id bigint,
     kind text NOT NULL,
     payload jsonb,
     status text NOT NULL DEFAULT 'pending',
     error text,
     sent_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe ON outbox (dedupe_key)`,

  `CREATE TABLE IF NOT EXISTS esf_queue (
     order_id integer PRIMARY KEY,
     status text NOT NULL DEFAULT 'new',
     card_chat_id bigint,
     card_message_id integer,
     posted_at timestamptz,
     issued_at timestamptz,
     issued_by_user_id bigint,
     issued_by_name text,
     synced_to_linko boolean NOT NULL DEFAULT false,
     reminded_at timestamptz,
     note text
   )`,
  `CREATE INDEX IF NOT EXISTS esf_status_idx ON esf_queue (status)`,

  `CREATE TABLE IF NOT EXISTS media_files (
     key text PRIMARY KEY,
     kind text NOT NULL,
     title text NOT NULL,
     description text,
     keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
     path text,
     file_id text,
     caption text,
     is_active boolean NOT NULL DEFAULT true,
     sent_count integer NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS requests (
     id serial PRIMARY KEY,
     chat_id bigint NOT NULL,
     business_connection_id text,
     client_name text NOT NULL,
     username text,
     text text NOT NULL,
     attachment_kind text,
     extracted jsonb,
     summary text,
     status text NOT NULL DEFAULT 'new',
     card_chat_id bigint,
     card_message_id integer,
     taken_by_user_id bigint,
     taken_by_name text,
     taken_at timestamptz,
     replied_at timestamptz,
     closed_by_name text,
     closed_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status)`,
  `CREATE INDEX IF NOT EXISTS requests_card_idx ON requests (card_message_id)`,

  `CREATE TABLE IF NOT EXISTS debt_snapshots (
     id serial PRIMARY KEY,
     date text NOT NULL,
     market_id integer NOT NULL,
     debt_total numeric NOT NULL DEFAULT 0,
     overdue numeric NOT NULL DEFAULT 0,
     bucket_0_7 numeric NOT NULL DEFAULT 0,
     bucket_8_30 numeric NOT NULL DEFAULT 0,
     bucket_31_60 numeric NOT NULL DEFAULT 0,
     bucket_60_plus numeric NOT NULL DEFAULT 0
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS debt_snap_uq ON debt_snapshots (date, market_id)`,
];

export async function migrate(): Promise<number> {
  const db = await getDb();
  for (const stmt of DDL) {
    await db.execute(sql.raw(stmt));
  }
  return DDL.length;
}

// Запуск напрямую: tsx src/db/migrate.ts
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  migrate()
    .then((n) => {
      log.info(`Схема готова: выполнено ${n} запросов`);
      process.exit(0);
    })
    .catch((e) => {
      log.error('Миграция не прошла', (e as Error).message);
      process.exit(1);
    });
}
