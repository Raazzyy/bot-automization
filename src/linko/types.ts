/** Типы ответов Linko External API. Выведены из docs на sfademo.linko.uz/docs */

export interface Envelope<T> {
  results: T[];
  errors: unknown[];
}

export interface Ref {
  id?: number;
  service_id?: string | null;
  name?: string | null;
}

export interface LinkoMarket {
  id: number;
  name: string;
  contact_name?: string | null;
  market_phones?: { id: number; phone: string }[];
  market_type?: { id: number; name: string; parent?: number | null } | null;
  uuid?: string | null;
  service_id?: string | null;
  inn?: string | null;
  code?: string | null;
  created_by?: Ref | null;
  responsible_agent?: (Ref & { phone_number?: string | null }) | null;
  price_list?: Ref | null;
  location?: { lat?: number | null; lon?: number | null } | null;
  address?: string | null;
  tm?: string | number | null;
}

export interface LinkoOrderProduct {
  id: number;
  product?: (Ref & { code?: string | null }) | null;
  measurement?: { id: number; name: string; is_weighted?: boolean } | null;
  price: string | number;
  origin_price?: string | number | null;
  amount: string | number;
  return_amount?: string | number | null;
  total_price: string | number;
  total_weight?: string | number | null;
  total_discount?: string | number | null;
  discount_percent?: string | number | null;
  total_origin_price?: string | number | null;
}

export type OrderStatus = 'not_delivered' | 'delivered' | 'given' | 'cancelled';

export interface LinkoOrder {
  id: number;
  uuid?: string | null;
  created_date?: string | null;
  date_delivery?: string | null;
  payment_type?: 'cash' | 'bank' | null;
  payment_date?: string | null;
  service_id?: string | null;
  status?: OrderStatus | null;
  tm?: string | number | null;
  is_full_return?: boolean | null;
  accepted_time?: string | null;
  invoice_date?: string | null;
  invoice_number?: string | null;
  service_order_number?: string | null;
  comment?: string | null;
  total_price?: string | number | null;
  total_weight?: string | number | null;
  discount_price?: string | number | null;
  market?: (Ref & { inn?: string | null; code?: string | null; uuid?: string | null }) | null;
  branch?: Ref | null;
  division?: Ref | null;
  stock?: Ref | null;
  agent?: Ref | null;
  delivery_man?: Ref | null;
  price_list?: Ref | null;
  currency?: Ref | null;
  location?: { lat?: number | null; lon?: number | null } | null;
  products?: LinkoOrderProduct[];
}

export interface LinkoPayment {
  id: number;
  uuid?: string | null;
  amount: string | number;
  comment?: string | null;
  currency?: Ref | null;
  market?: (Ref & { inn?: string | null; code?: string | null; uuid?: string | null }) | null;
  division?: Ref | null;
  payment_type?: 'cash' | 'bank' | null;
  type?: string | null;
  status?: 'accepted' | 'not_accepted' | null;
  user?: Ref | null;
  delivery_man?: Ref | null;
  created_date?: string | null;
  accepted_time?: string | null;
  order_id?: number | null;
  transaction_id?: string | null;
  service_id?: string | null;
  is_delete?: boolean | null;
  tm?: string | number | null;
}

export interface LinkoProduct {
  id: number;
  name: string;
  code?: string | null;
  service_id?: string | null;
  product_type?: Ref | null;
  measurement?: { id: number; name: string } | null;
  is_active?: boolean | null;
  tm?: string | number | null;
}

export interface LinkoProductBalance {
  product?: Ref | null;
  stock?: Ref | null;
  balance: string | number;
  tm?: string | number | null;
}

export interface LinkoPriceListItem {
  id?: number;
  price_list?: Ref | null;
  product?: Ref | null;
  price: string | number;
  tm?: string | number | null;
}

export interface LinkoPromotion {
  id: number;
  name: string;
  type?: string | null;
  begin_date?: string | null;
  till_date?: string | null;
  division?: Ref | null;
  products?: { product?: Ref | null; amount?: string | number; type?: string }[];
  promotion_type?: string | null;
  discount_type?: string | null;
  is_apply_all?: boolean | null;
  bonus_fund?: string | number | null;
  discount?: string | number | null;
  tm?: string | number | null;
}

export interface LinkoUser {
  id: number;
  first_name?: string | null;
  second_name?: string | null;
  username?: string | null;
  phone_number?: string | null;
  service_id?: string | null;
  role?: string | null;
  tm?: string | number | null;
}

/* ─── Создание заказа (POST sync_order) ─── */

export interface SyncOrderRef {
  linko_id?: number;
  service_id?: string;
}

export interface SyncOrderProduct {
  product: SyncOrderRef;
  price: number;
  amount: number;
  origin_price?: number;
}

export interface SyncOrderPayload {
  service_id?: string;
  linko_id?: number;
  payment_type: 'cash' | 'bank';
  status: OrderStatus;
  comment?: string;
  date_delivery?: string;
  payment_date?: string;
  linko_currency_id?: number;
  service_order_number?: string;
  market: SyncOrderRef;
  stock: SyncOrderRef;
  agent: SyncOrderRef;
  delivery_man: SyncOrderRef;
  price_list?: SyncOrderRef;
  products?: SyncOrderProduct[];
}
