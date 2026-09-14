/**
 * Client Application for B2B AI Bot Platform & CRM
 */
const app = {
  activeTab: 'tab-overview',
  botEnabled: true,
  settings: {},
  chatHistory: [],

  // Кэш данных для мгновенной фильтрации
  allDebts: [],
  filteredDebts: [],
  allSleepers: [],
  filteredSleepers: [],
  filterOverdueOnly: false,
  marketsList: [],

  init() {
    this.initNavigation();
    this.bindEvents();
    this.startClock();
    this.loadAllData();
    this.loadMarketsForSimulator();
  },

  // ─────────── 1. Навигация по вкладкам ───────────

  initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');
        this.switchTab(tabId);
      });
    });

    // Обработка Hash в URL
    const hash = window.location.hash.replace('#', '');
    if (hash && document.getElementById(hash)) {
      this.switchTab(hash);
    }
  },

  switchTab(tabId) {
    this.activeTab = tabId;
    window.location.hash = tabId;

    document.querySelectorAll('.nav-item').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });

    document.querySelectorAll('.tab-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.id === tabId);
    });

    // Обновление заголовка страницы
    const titles = {
      'tab-overview': ['Дашборд & KPI', 'Мониторинг автоматизации и заказов'],
      'tab-behavior': ['Поведение & База знаний', 'Обучение нейросети и регламенты компании'],
      'tab-whitelabel': ['White-Label & Реквизиты', 'Настройка решения под ключ и перепродажа'],
      'tab-orders': ['Журнал заказов', 'Лента отгрузок, просмотр позиций и печать PDF'],
      'tab-debts': ['Дебиторская задолженность', 'Старение долга, поиск должников и Акты сверки'],
      'tab-sleepers': ['Спящие клиенты', 'Анализ цикла повторных закупок и офферы'],
      'tab-simulator': ['Live AI Симулятор', 'Тестирование ответов нейросети в песочнице'],
    };

    if (titles[tabId]) {
      document.getElementById('pageTitle').textContent = titles[tabId][0];
      document.getElementById('topSubtitle').textContent = titles[tabId][1];
    }

    // Ленивая дозагрузка данных вкладки
    if (tabId === 'tab-orders') this.loadOrders();
    if (tabId === 'tab-debts') this.loadDebts();
    if (tabId === 'tab-sleepers') this.loadSleepers();
  },

  // ─────────── 2. Привязка событий ───────────

  bindEvents() {
    // Тумблер ВКЛ/ВЫКЛ
    document.getElementById('btnToggleBot').addEventListener('click', () => this.toggleBot());

    // Смена режима
    document.getElementById('modeSelect').addEventListener('change', (e) => {
      this.saveSetting({ mode: e.target.value });
    });

    // Кнопка синхронизации
    document.getElementById('btnSyncLinko').addEventListener('click', () => this.triggerSync());

    // Форма Поведения и знаний
    document.getElementById('formBehavior').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveBehaviorSettings();
    });

    // Форма White-Label
    document.getElementById('formWhiteLabel').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveWhiteLabelSettings();
    });

    // Синхронизация профиля Telegram
    document.getElementById('btnPushTelegramProfile').addEventListener('click', () => {
      this.pushTelegramProfile();
    });

    // Тест связи с Linko
    document.getElementById('btnTestLinkoPing')?.addEventListener('click', () => {
      this.testLinkoConnection();
    });

    // Поиск и фильтрация заказов
    let orderSearchTimeout = null;
    document.getElementById('orderSearchInput')?.addEventListener('input', () => {
      clearTimeout(orderSearchTimeout);
      orderSearchTimeout = setTimeout(() => this.loadOrders(), 300);
    });
    document.getElementById('orderStatusFilter')?.addEventListener('change', () => {
      this.loadOrders();
    });

    // Поиск и фильтрация дебиторки
    document.getElementById('debtSearchInput')?.addEventListener('input', (e) => {
      this.filterDebts();
    });
    document.getElementById('btnFilterOverdueOnly')?.addEventListener('click', (e) => {
      this.filterOverdueOnly = !this.filterOverdueOnly;
      e.target.classList.toggle('active', this.filterOverdueOnly);
      this.filterDebts();
    });

    // Поиск и фильтрация спящих клиентов
    document.getElementById('sleeperSearchInput')?.addEventListener('input', () => {
      this.filterSleepers();
    });
    document.getElementById('sleeperOverdueFilter')?.addEventListener('change', () => {
      this.filterSleepers();
    });

    // Модальное окно заказа
    document.getElementById('btnCloseOrderModal')?.addEventListener('click', () => this.closeOrderModal());
    document.getElementById('btnModalClose')?.addEventListener('click', () => this.closeOrderModal());
    document.getElementById('orderModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'orderModal') this.closeOrderModal();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeOrderModal();
    });

    // Чат симулятор
    document.getElementById('chatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendChatMessage();
    });

    document.getElementById('btnClearChat').addEventListener('click', () => {
      this.clearChat();
    });
  },

  // ─────────── 3. Часы и таймеры ───────────

  startClock() {
    const clockEl = document.getElementById('serverClock');
    const update = () => {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    update();
    setInterval(update, 1000);
  },

  // ─────────── 4. Загрузка данных ───────────

  async loadAllData() {
    await Promise.all([
      this.loadStatus(),
      this.loadStats(),
      this.loadSettings(),
    ]);
  },

  async loadStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();

      this.botEnabled = Boolean(data.bot_enabled);
      this.updateBotToggleUI(this.botEnabled);

      if (data.mode) {
        document.getElementById('modeSelect').value = data.mode;
      }

      if (data.company_name) {
        document.getElementById('sideBrandName').textContent = data.company_name;
      }
      if (data.manager_name) {
        document.getElementById('simManagerName').textContent = `${data.manager_name} (AI Менеджер)`;
      }

      if (data.linko) {
        const badgeText = document.getElementById('linkoBadgeText');
        if (badgeText) {
          if (data.linko.live_token_active || !data.linko.read_only_mode) {
            badgeText.textContent = 'Linko API: Боевой (Live)';
            badgeText.parentElement.title = `Подключено: ${data.linko.base_url}`;
          } else {
            badgeText.textContent = 'Linko Read-Only Safe';
          }
        }
      }
    } catch (e) {
      console.error('Ошибка загрузки статуса:', e);
    }
  },

  async toggleBot() {
    try {
      const btn = document.getElementById('btnToggleBot');
      btn.style.opacity = '0.5';

      const res = await fetch('/api/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !this.botEnabled }),
      });
      const data = await res.json();

      this.botEnabled = Boolean(data.bot_enabled);
      this.updateBotToggleUI(this.botEnabled);
      btn.style.opacity = '1';

      this.showToast(
        this.botEnabled ? 'Бот успешно включен и отвечает клиентам' : 'Бот выключен (переведен в режим ожидания)',
        this.botEnabled ? 'success' : 'error',
      );
    } catch (e) {
      this.showToast('Ошибка переключения бота: ' + e.message, 'error');
    }
  },

  updateBotToggleUI(enabled) {
    const btn = document.getElementById('btnToggleBot');
    const text = document.getElementById('botStatusText');

    if (enabled) {
      btn.classList.add('active');
      btn.classList.remove('disabled');
      text.textContent = 'ВКЛЮЧЕН';
    } else {
      btn.classList.remove('active');
      btn.classList.add('disabled');
      text.textContent = 'ВЫКЛЮЧЕН';
    }
  },

  async loadStats() {
    try {
      const res = await fetch('/api/stats');
      const data = await res.json();

      // Карточки KPI
      document.getElementById('kpiVolume').textContent = this.formatMoney(data.orders_volume);
      document.getElementById('kpiOrdersCount').textContent = data.orders_count;
      document.getElementById('kpiTotalDebt').textContent = this.formatMoney(data.total_debt);
      document.getElementById('kpiDebtorsCount').textContent = data.debtors_count;
      document.getElementById('kpiOverdue').textContent = this.formatMoney(data.total_overdue);
      document.getElementById('kpiSleepersCount').textContent = data.sleepers_count;

      // Aging прогресс-бары
      const totalDebt = Math.max(data.total_debt, 1);
      const b0 = data.aging?.b0_7 || 0;
      const b8 = data.aging?.b8_30 || 0;
      const b31 = data.aging?.b31_60 || 0;
      const b60 = data.aging?.b60p || 0;

      document.getElementById('aging0_7').textContent = this.formatMoney(b0);
      document.getElementById('aging8_30').textContent = this.formatMoney(b8);
      document.getElementById('aging31_60').textContent = this.formatMoney(b31);
      document.getElementById('aging60p').textContent = this.formatMoney(b60);

      document.getElementById('bar0_7').style.width = Math.min(100, Math.round((b0 / totalDebt) * 100)) + '%';
      document.getElementById('bar8_30').style.width = Math.min(100, Math.round((b8 / totalDebt) * 100)) + '%';
      document.getElementById('bar31_60').style.width = Math.min(100, Math.round((b31 / totalDebt) * 100)) + '%';
      document.getElementById('bar60p').style.width = Math.min(100, Math.round((b60 / totalDebt) * 100)) + '%';

      // Таблица последних заказов
      const tbody = document.getElementById('recentOrdersTbody');
      if (data.recent_orders?.length) {
        tbody.innerHTML = data.recent_orders.map((o) => `
          <tr class="clickable-row" onclick="app.openOrderModal(${o.id})">
            <td><strong>#${o.id}</strong></td>
            <td><strong>${this.escapeHtml(o.market_name)}</strong></td>
            <td>${o.created_date || '—'}</td>
            <td>${this.formatMoney(o.total_price)}</td>
            <td><span class="status-tag status-${this.getStatusClass(o.status)}">${o.status}</span></td>
            <td>${o.created_by_bot ? '<span class="badge-sub">Telegram Bot</span>' : 'Linko SFA'}</td>
            <td>
              <div style="display:flex; gap:6px;">
                <button class="btn-sm-pdf" onclick="event.stopPropagation(); app.openOrderModal(${o.id})">
                  Состав
                </button>
                <a href="/api/orders/${o.id}/pdf" target="_blank" class="btn-sm-pdf" onclick="event.stopPropagation()">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                  PDF
                </a>
              </div>
            </td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-muted">Заказов пока нет</td></tr>`;
      }
    } catch (e) {
      console.error('Ошибка загрузки статистики:', e);
    }
  },

  async loadSettings() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      this.settings = data;

      // Поведение
      document.getElementById('cfgManagerName').value = data.manager_name || '';
      document.getElementById('cfgManagerRole').value = data.manager_role || '';
      document.getElementById('cfgKnowledgeBase').value = data.knowledge_base || '';
      document.getElementById('cfgCustomRules').value = data.custom_rules || '';
      document.getElementById('cfgGreetingRu').value = data.greeting_ru || '';
      document.getElementById('cfgGreetingUz').value = data.greeting_uz || '';

      // White-Label
      document.getElementById('cfgCompanyName').value = data.company_name || '';
      document.getElementById('cfgCompanyInn').value = data.company_inn || '';
      document.getElementById('cfgCompanyMfo').value = data.company_mfo || '';
      document.getElementById('cfgCompanyAccount').value = data.company_account || '';
      document.getElementById('cfgCompanyBank').value = data.company_bank || '';
      document.getElementById('cfgCompanyPhone').value = data.company_phone || '';
      document.getElementById('cfgCompanyAddress').value = data.company_address || '';
      document.getElementById('cfgLinkoUrl').value = data.linko_base_url || '';

      if (data.gemini_model) {
        document.getElementById('cfgGeminiModel').value = data.gemini_model;
      }
    } catch (e) {
      console.error('Ошибка загрузки настроек:', e);
    }
  },

  async saveSetting(patch) {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.ok) {
        this.showToast('Настройки сохранены', 'success');
        if (patch.company_name) {
          document.getElementById('sideBrandName').textContent = patch.company_name;
        }
      }
    } catch (e) {
      this.showToast('Ошибка сохранения: ' + e.message, 'error');
    }
  },

  async saveBehaviorSettings() {
    const patch = {
      manager_name: document.getElementById('cfgManagerName').value.trim(),
      manager_role: document.getElementById('cfgManagerRole').value.trim(),
      knowledge_base: document.getElementById('cfgKnowledgeBase').value.trim(),
      custom_rules: document.getElementById('cfgCustomRules').value.trim(),
      greeting_ru: document.getElementById('cfgGreetingRu').value.trim(),
      greeting_uz: document.getElementById('cfgGreetingUz').value.trim(),
    };
    await this.saveSetting(patch);
  },

  async saveWhiteLabelSettings() {
    const patch = {
      company_name: document.getElementById('cfgCompanyName').value.trim(),
      company_inn: document.getElementById('cfgCompanyInn').value.trim(),
      company_mfo: document.getElementById('cfgCompanyMfo').value.trim(),
      company_account: document.getElementById('cfgCompanyAccount').value.trim(),
      company_bank: document.getElementById('cfgCompanyBank').value.trim(),
      company_phone: document.getElementById('cfgCompanyPhone').value.trim(),
      company_address: document.getElementById('cfgCompanyAddress').value.trim(),
      linko_base_url: document.getElementById('cfgLinkoUrl').value.trim(),
      gemini_model: document.getElementById('cfgGeminiModel').value,
    };

    const botToken = document.getElementById('cfgBotToken').value.trim();
    if (botToken) patch.telegram_bot_token = botToken;

    const geminiKey = document.getElementById('cfgGeminiKey').value.trim();
    if (geminiKey) patch.gemini_api_key = geminiKey;

    await this.saveSetting(patch);
  },

  async pushTelegramProfile() {
    const name = document.getElementById('tgName').value.trim();
    const shortDescription = document.getElementById('tgShortDesc').value.trim();
    const description = document.getElementById('tgDesc').value.trim();

    if (!name && !shortDescription && !description) {
      return this.showToast('Заполните хотя бы одно поле для Telegram', 'error');
    }

    try {
      const res = await fetch('/api/telegram/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, shortDescription, description }),
      });
      const data = await res.json();
      if (data.ok) {
        this.showToast('Профиль бота в Telegram успешно обновлён!', 'success');
      } else {
        this.showToast('Ошибка Telegram: ' + (data.error || 'Не удалось обновить'), 'error');
      }
    } catch (e) {
      this.showToast('Ошибка: ' + e.message, 'error');
    }
  },

  async triggerSync() {
    const btn = document.getElementById('btnSyncLinko');
    btn.disabled = true;
    btn.style.opacity = '0.5';

    try {
      this.showToast('Синхронизация с Linko запущена...', 'success');
      const res = await fetch('/api/sync/trigger', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        this.showToast('Синхронизация завершена успешно!', 'success');
        this.loadStats();
      }
    } catch (e) {
      this.showToast('Синхронизация не удалась: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  },

  async testLinkoConnection() {
    const btn = document.getElementById('btnTestLinkoPing');
    if (!btn) return;
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.innerHTML = `Проверяю связь...`;
    const start = Date.now();
    try {
      const res = await fetch('/api/linko/ping');
      const data = await res.json();
      const ms = Date.now() - start;
      if (data.ok) {
        this.showToast(`✅ Linko External API активен! Сервер: ${data.base_url || 'akm.linko.uz'} (${ms} мс)`, 'success');
      } else {
        this.showToast(`⚠️ Ошибка подключения к Linko: ${data.error || 'неизвестная ошибка'}`, 'error');
      }
    } catch (e) {
      this.showToast(`❌ Ошибка запроса к Linko: ${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.innerHTML = origHtml;
    }
  },

  // ─────────── 5. Журнал заказов ───────────

  async loadOrders() {
    const tbody = document.getElementById('ordersFullTbody');
    const q = document.getElementById('orderSearchInput')?.value?.trim() || '';
    const status = document.getElementById('orderStatusFilter')?.value || 'all';

    try {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-6 text-muted">Загрузка заказов...</td></tr>`;

      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (status && status !== 'all') params.set('status', status);
      params.set('limit', '50');

      const res = await fetch(`/api/orders?${params.toString()}`);
      const list = await res.json();

      const badge = document.getElementById('orderCountBadge');
      if (badge) badge.textContent = `Заказов: ${list.length}`;

      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center py-6 text-muted">Заказы по запросу «${this.escapeHtml(q)}» не найдены</td></tr>`;
        return;
      }

      tbody.innerHTML = list.map((o) => `
        <tr class="clickable-row" onclick="app.openOrderModal(${o.real_id})">
          <td><strong>#${o.id}</strong></td>
          <td><strong>${this.escapeHtml(o.marketName || 'Не указано')}</strong></td>
          <td>${o.createdDate || '—'}</td>
          <td>${o.dateDelivery || '—'}</td>
          <td>${o.paymentType === 'bank' ? 'Перечисление' : 'Наличные'}</td>
          <td><strong>${o.total_price_fmt}</strong></td>
          <td><span class="status-tag status-${this.getStatusClass(o.status)}">${o.status || 'new'}</span></td>
          <td>${o.createdByBot ? '<span class="badge-sub">Telegram Bot</span>' : 'Linko SFA'}</td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-sm-pdf" onclick="event.stopPropagation(); app.openOrderModal(${o.real_id})">
                Состав
              </button>
              <a href="/api/orders/${o.real_id}/pdf" target="_blank" class="btn-sm-pdf" onclick="event.stopPropagation()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
                PDF
              </a>
            </div>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-6 text-danger">Ошибка: ${e.message}</td></tr>`;
    }
  },

  // ─────────── 6. Детали заказа (Модалка) ───────────

  async openOrderModal(orderId) {
    const modal = document.getElementById('orderModal');
    const titleEl = document.getElementById('modalOrderTitle');
    const subEl = document.getElementById('modalOrderSub');
    const metaEl = document.getElementById('modalOrderMeta');
    const tbody = document.getElementById('modalOrderItemsTbody');
    const totalEl = document.getElementById('modalOrderTotal');
    const pdfBtn = document.getElementById('btnModalDownloadPdf');

    titleEl.textContent = `Заказ #${Math.abs(orderId)}`;
    subEl.textContent = 'Загрузка данных...';
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-muted">Загрузка состава заказа...</td></tr>`;
    metaEl.innerHTML = '';
    pdfBtn.href = `/api/orders/${orderId}/pdf`;

    modal.classList.remove('hidden');

    try {
      const res = await fetch(`/api/orders/${orderId}/items`);
      const data = await res.json();

      if (!data.order) {
        throw new Error(data.error || 'Не удалось получить данные заказа');
      }

      const ord = data.order;
      subEl.textContent = ord.market_name;
      totalEl.textContent = ord.total_price_fmt;

      metaEl.innerHTML = `
        <div class="meta-item">
          <span class="meta-label">Заведение / Точка</span>
          <span class="meta-val">${this.escapeHtml(ord.market_name)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">ИНН клиента</span>
          <span class="meta-val">${ord.market_inn || '—'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Телефон</span>
          <span class="meta-val">${ord.market_phone || '—'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Дата заказа / Доставка</span>
          <span class="meta-val">${ord.created_date || '—'} → ${ord.date_delivery || '—'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Оплата</span>
          <span class="meta-val">${ord.payment_type}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Статус</span>
          <span class="meta-val"><span class="status-tag status-${this.getStatusClass(ord.status)}">${ord.status}</span></span>
        </div>
      `;

      if (data.items?.length) {
        tbody.innerHTML = data.items.map((it, idx) => `
          <tr>
            <td>${idx + 1}</td>
            <td><strong>${this.escapeHtml(it.product_name)}</strong></td>
            <td>${it.measurement_name}</td>
            <td>${it.amount_fmt}</td>
            <td>${it.price_fmt} сум</td>
            <td><strong>${it.total_price_fmt} сум</strong></td>
          </tr>
        `).join('');
      } else {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-muted">Позиции отсутствуют или заказ пуст</td></tr>`;
      }
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center py-6 text-danger">Ошибка: ${e.message}</td></tr>`;
    }
  },

  closeOrderModal() {
    document.getElementById('orderModal')?.classList.add('hidden');
  },

  // ─────────── 7. Дебиторка ───────────

  async loadDebts() {
    const tbody = document.getElementById('debtsTbody');
    try {
      tbody.innerHTML = `<tr><td colspan="10" class="text-center py-6 text-muted">Загрузка дебиторки...</td></tr>`;
      const res = await fetch('/api/debts');
      const data = await res.json();

      this.allDebts = data.debtors || [];
      this.filterDebts();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="10" class="text-center py-6 text-danger">Ошибка: ${e.message}</td></tr>`;
    }
  },

  filterDebts() {
    const q = document.getElementById('debtSearchInput')?.value?.toLowerCase().trim() || '';
    const overdueOnly = this.filterOverdueOnly;

    this.filteredDebts = this.allDebts.filter((d) => {
      const matchQ = !q ||
        (d.marketName && d.marketName.toLowerCase().includes(q)) ||
        (d.marketInn && d.marketInn.includes(q)) ||
        (d.phone && d.phone.includes(q));

      const matchOverdue = !overdueOnly || d.overdue > 0;
      return matchQ && matchOverdue;
    });

    const badge = document.getElementById('debtCountBadge');
    if (badge) badge.textContent = `Должников: ${this.filteredDebts.length} из ${this.allDebts.length}`;

    const tbody = document.getElementById('debtsTbody');
    if (!this.filteredDebts.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="text-center py-6 text-muted">Должники не найдены</td></tr>`;
      return;
    }

    tbody.innerHTML = this.filteredDebts.map((d) => `
      <tr>
        <td><strong>${this.escapeHtml(d.marketName)}</strong></td>
        <td>${d.marketInn || '—'}</td>
        <td>${d.phone || '—'}</td>
        <td><strong style="color:#fff;">${this.formatMoney(d.debtTotal)}</strong></td>
        <td><strong style="color:var(--accent-rose);">${this.formatMoney(d.overdue)}</strong></td>
        <td>${this.formatMoney(d.bucket0007)}</td>
        <td>${this.formatMoney(d.bucket0830)}</td>
        <td>${this.formatMoney(d.bucket3160)}</td>
        <td>${this.formatMoney(d.bucket60p)}</td>
        <td>
          <a href="/api/debts/${d.marketId}/pdf" target="_blank" class="btn-sm-pdf">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
            Акт сверки
          </a>
        </td>
      </tr>
    `).join('');
  },

  // ─────────── 8. Спящие клиенты ───────────

  async loadSleepers() {
    const container = document.getElementById('sleepersContainer');
    try {
      container.innerHTML = `<div class="text-center py-8 text-muted w-100">Анализ истории заказов клиентов...</div>`;
      const res = await fetch('/api/sleepers');
      this.allSleepers = await res.json();
      this.filterSleepers();
    } catch (e) {
      container.innerHTML = `<div class="text-center py-8 text-danger w-100">Ошибка: ${e.message}</div>`;
    }
  },

  filterSleepers() {
    const q = document.getElementById('sleeperSearchInput')?.value?.toLowerCase().trim() || '';
    const minOverdue = Number(document.getElementById('sleeperOverdueFilter')?.value) || 0;

    this.filteredSleepers = this.allSleepers.filter((s) => {
      const matchQ = !q ||
        (s.marketName && s.marketName.toLowerCase().includes(q)) ||
        (s.phone && s.phone.includes(q));

      const matchDays = s.daysOverdueCycle >= minOverdue;
      return matchQ && matchDays;
    });

    const badge = document.getElementById('sleeperCountBadge');
    if (badge) badge.textContent = `Спящих точек: ${this.filteredSleepers.length} из ${this.allSleepers.length}`;

    const container = document.getElementById('sleepersContainer');
    if (!this.filteredSleepers.length) {
      container.innerHTML = `<div class="text-center py-8 text-muted w-100">Клиентов по заданным критериям не найдено</div>`;
      return;
    }

    container.innerHTML = this.filteredSleepers.map((s) => `
      <div class="sleeper-card">
        <div class="sleeper-card-header">
          <div>
            <h4 class="sleeper-name">${this.escapeHtml(s.marketName)}</h4>
            <span class="text-muted text-sm">${s.phone || 'Телефон не указан'}</span>
          </div>
          <span class="sleeper-badge">Просрочка ${s.daysOverdueCycle} дн.</span>
        </div>

        <div class="sleeper-metrics">
          <div class="sleeper-metrics-col">
            <span>Заказов всего:</span>
            <strong>${s.ordersCount}</strong>
          </div>
          <div class="sleeper-metrics-col">
            <span>Привычный цикл:</span>
            <strong>${s.medianIntervalDays} дн.</strong>
          </div>
          <div class="sleeper-metrics-col">
            <span>Последний заказ:</span>
            <strong>${s.lastOrderDate}</strong>
          </div>
        </div>

        <div class="offer-box">
          <div class="text-muted text-sm mb-1">Готовое предложение (RU):</div>
          <div>${this.escapeHtml(s.draftMessageRu)}</div>
        </div>

        <button class="btn-secondary" onclick="app.copyOffer('${encodeURIComponent(s.draftMessageRu)}')">
          Копировать предложение
        </button>
      </div>
    `).join('');
  },

  copyOffer(encodedText) {
    const text = decodeURIComponent(encodedText);
    this.copyToClipboard(text);
    this.showToast('Текст предложения скопирован!', 'success');
  },

  copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => this.fallbackCopyText(text));
    } else {
      this.fallbackCopyText(text);
    }
  },

  fallbackCopyText(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
    } catch (err) {
      console.error('Fallback copy failed', err);
    }
    document.body.removeChild(textArea);
  },

  // ─────────── 9. Точки для AI Симулятора ───────────

  async loadMarketsForSimulator() {
    const select = document.getElementById('simMarketSelect');
    if (!select) return;

    try {
      const res = await fetch('/api/markets?limit=100');
      const list = await res.json();
      this.marketsList = list;

      let html = '<option value="">Клиент без точки (Гость)</option>';
      for (const m of list) {
        html += `<option value="${m.id}">${this.escapeHtml(m.name)} (ID ${Math.abs(m.id)}${m.inn ? ', ИНН ' + m.inn : ''})</option>`;
      }
      select.innerHTML = html;
    } catch (e) {
      console.error('Ошибка загрузки точек для симулятора:', e);
    }
  },

  // ─────────── 10. AI Симулятор ───────────

  async sendChatMessage() {
    const input = document.getElementById('chatInput');
    const msg = input.value.trim();
    if (!msg) return;

    input.value = '';
    const messagesEl = document.getElementById('chatMessages');

    // Реплика пользователя
    messagesEl.innerHTML += `<div class="chat-bubble user">${this.escapeHtml(msg)}</div>`;
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Плейсхолдер ответа
    const pendingId = 'bot-' + Date.now();
    messagesEl.innerHTML += `<div id="${pendingId}" class="chat-bubble bot text-muted">Печатает...</div>`;
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const marketId = document.getElementById('simMarketSelect').value
      ? Number(document.getElementById('simMarketSelect').value)
      : undefined;

    try {
      const res = await fetch('/api/ai/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          marketId,
          history: this.chatHistory,
        }),
      });

      const data = await res.json();
      const botBubble = document.getElementById(pendingId);

      if (data.error) {
        botBubble.innerHTML = `<span style="color:var(--accent-rose)">Ошибка: ${this.escapeHtml(data.error)}</span>`;
      } else {
        botBubble.textContent = data.reply || '(пустой ответ)';
      }

      // Обновляем историю диалога
      this.chatHistory.push({ role: 'user', text: msg });
      if (data.reply) {
        this.chatHistory.push({ role: 'model', text: data.reply });
      }

      // Инспектор инструментов
      this.renderInspector(data);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (e) {
      const botBubble = document.getElementById(pendingId);
      if (botBubble) {
        botBubble.innerHTML = `<span style="color:var(--accent-rose)">Ошибка сети: ${e.message}</span>`;
      }
    }
  },

  renderInspector(data) {
    const el = document.getElementById('inspectorContent');
    let html = '';

    if (data.handoff) {
      html += `
        <div class="inspector-item" style="border-color:var(--accent-rose); background: rgba(244,63,94,0.1);">
          <div style="color:var(--accent-rose); font-weight:700;">⚠️ HANDOFF (Вызов менеджера)</div>
          <div class="text-sm mt-1">${this.escapeHtml(data.handoff)}</div>
        </div>
      `;
    }

    if (data.toolCalls?.length) {
      html += `<div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">ВЫЗВАННЫЕ ИНСТРУМЕНТЫ (${data.toolCalls.length}):</div>`;
      html += data.toolCalls.map((tc) => `
        <div class="inspector-item">
          <div class="inspector-tool-name">⚙ ${tc.name}()</div>
          <div class="text-muted text-sm">Параметры:</div>
          <pre class="inspector-json">${this.escapeHtml(JSON.stringify(tc.args, null, 2))}</pre>
          <div class="text-muted text-sm mt-2">Результат:</div>
          <pre class="inspector-json">${this.escapeHtml(tc.result)}</pre>
        </div>
      `).join('');
    } else {
      html += `<p class="text-muted text-sm">Нейросеть ответила напрямую из контекста или базы знаний без обращения к внешним инструментам.</p>`;
    }

    if (data.attachments?.length) {
      html += `
        <div class="inspector-item" style="border-color:var(--accent-cyan);">
          <div style="color:var(--accent-cyan); font-weight:600;">📎 Вложенные файлы:</div>
          <div class="text-sm mt-1">${data.attachments.join(', ')}</div>
        </div>
      `;
    }

    el.innerHTML = html;
  },

  clearChat() {
    this.chatHistory = [];
    document.getElementById('chatMessages').innerHTML = `
      <div class="chat-bubble bot">
        Диалог очищен. Напишите новое сообщение для проверки.
      </div>
    `;
    document.getElementById('inspectorContent').innerHTML = `
      <p class="text-muted text-sm">История очищена. Отправьте вопрос в чат для отслеживания вызовов инструментов.</p>
    `;
  },

  // ─────────── 11. Утилиты ───────────

  formatMoney(num) {
    if (num == null) return '0 сум';
    const n = Math.round(Number(num) || 0);
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' сум';
  },

  getStatusClass(status) {
    if (!status) return 'new';
    const s = String(status).toLowerCase();
    if (s.includes('deliver') || s.includes('success') || s.includes('given')) return 'delivered';
    if (s.includes('cancel') || s.includes('fail')) return 'cancel';
    return 'new';
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span>${type === 'success' ? '✅' : '⚠️'}</span>
      <div>${this.escapeHtml(message)}</div>
    `;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },
};

// Запуск при загрузке страницы
document.addEventListener('DOMContentLoaded', () => app.init());
