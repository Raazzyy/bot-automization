/**
 * Модуль умных допродаж (Cross-Sell & Upsell) для B2B оптовой торговли FMCG/HoReCa.
 * Автоматически подбирает сопутствующие и акционные товары на основе текущего заказа клиента.
 */

export interface CartItemLike {
  productName: string;
  quantity?: number;
}

export interface CrossSellRecommendation {
  suggestedProduct: string;
  reason: string;
  recommendationPhraseRu: string;
  recommendationPhraseUz: string;
}

// Матрица товарного соседства (на основе реального ассортимента Dardanel, Burcu, Sayam)
const COMPATIBILITY_RULES: Array<{
  triggers: string[];
  suggestedProduct: string;
  reason: string;
  phraseRu: string;
  phraseUz: string;
}> = [
  {
    triggers: ['тунец', 'ton', 'dardanel', 'салатный'],
    suggestedProduct: 'Оливки и маслины Burcu',
    reason: 'Классическое сочетание для пиццы и салатов в HoReCa',
    phraseRu: 'Кстати, к тунцу у нас сейчас отличная цена на оливки и маслины Burcu. Добавить банку на пробу к доставке?',
    phraseUz: 'Aytgancha, tunesga qo‘shimcha Burcu zaytunlari ham kelgan. Buyurtmaga qo‘shib yuboraylikmi?',
  },
  {
    triggers: ['тунец', 'ton', 'dardanel'],
    suggestedProduct: 'Кукуруза десертная консервированная Burcu',
    reason: 'Высокомаржинальный компонент ресторанных салатов с тунцом',
    phraseRu: 'Шефы часто берут к тунцу сладкую кукурузу Burcu. Включить 1 коробку в эту поставку?',
    phraseUz: 'Oshpazlar tunes bilan birga Burcu shirin makkajo‘xorisini ham ko‘p olishadi. 1 quti qo‘shaylikmi?',
  },
  {
    triggers: ['томатная паста', 'pomidor pastasi', 'кетчуп', 'соус', 'burcu'],
    suggestedProduct: 'Огурцы маринованные / Корнишоны Burcu',
    reason: 'Сопутствующая консервация для кухни и бургеров',
    phraseRu: 'К соусам и томатной пасте также рекомендуем хрустящие корнишоны Burcu. Забронировать упаковку?',
    phraseUz: 'Sous va tomat pastasi bilan birga qarsildoq Burcu kornishonlarini ham tavsiya qilamiz. Qo‘shib beraylikmi?',
  },
  {
    triggers: ['макароны', 'паста', 'спагетти'],
    suggestedProduct: 'Томатная паста Burcu 830г',
    reason: 'Базовый соус для всех видов пасты',
    phraseRu: 'Для пасты у нас есть густая томатная паста Burcu 830г высшего качества. Добавить в заказ?',
    phraseUz: 'Pasta tayyorlash uchun quyuq Burcu 830g tomat pastasini ham buyurtmaga kiritaylikmi?',
  },
  {
    triggers: ['уксус', 'nare', 'виноградный', 'яблочный'],
    suggestedProduct: 'Оливковое масло Extra Virgin',
    reason: 'Заправка для салатов европейской кухни',
    phraseRu: 'Вместе с уксусом часто берут натуральное оливковое масло. Проверить для вас наличие на складе?',
    phraseUz: 'Sirka bilan birga tabiiy zaytun moyi ham olib ketishadi. Ombordagi qoldiqni tekshirib beraymi?',
  },
];

/**
 * Подобрать лучшую допродажу на основе позиций в заказе
 */
export function getCrossSellRecommendation(
  cart: CartItemLike[],
  alreadySuggested: string[] = [],
): CrossSellRecommendation | null {
  if (!cart || cart.length === 0) return null;

  const cartText = cart.map((i) => i.productName.toLowerCase()).join(' ');

  for (const rule of COMPATIBILITY_RULES) {
    // Проверяем, есть ли триггер в корзине
    const hasTrigger = rule.triggers.some((tr) => cartText.includes(tr));
    const firstWord = (rule.suggestedProduct.toLowerCase().split(' ')[0]) ?? '';
    const alreadyInCart = Boolean(firstWord && cartText.includes(firstWord));
    const wasAlreadyOffered = alreadySuggested.includes(rule.suggestedProduct);

    if (hasTrigger && !alreadyInCart && !wasAlreadyOffered) {
      return {
        suggestedProduct: rule.suggestedProduct,
        reason: rule.reason,
        recommendationPhraseRu: rule.phraseRu,
        recommendationPhraseUz: rule.phraseUz,
      };
    }
  }

  return null;
}
