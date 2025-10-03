<!-- English -->
<div align="center">

# 🎯 ToteBot - Telegram Totalizator Bot

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Telegraf](https://img.shields.io/badge/Telegraf-4.0+-32A2DB?logo=telegram&logoColor=white)](https://telegraf.js.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> Professional sports betting pool manager with cryptocurrency payments

**English** • [Русский](#русский-russian)

![Bot Preview](https://via.placeholder.com/800x400/2D3748/FFFFFF?text=ToteBot+Interface+Preview)

</div>

## ✨ Features

<div align="center">

| 🎲 Betting System | 💰 Payments | 👑 Administration |
|:-----------------:|:-----------:|:-----------------:|
| 15×3 events system | Crypto Pay integration | Full admin panel |
| Multi-combination tickets | USDT/other cryptocurrencies | Real-time control |
| Interactive interface | Testnet/production modes | Result settlement |

</div>

### 🚀 Core Capabilities

- **📊 Smart Betting**: 15 events × 3 outcomes with automatic combination calculation
- **💳 Crypto Payments**: Seamless integration with @CryptoBot for USDT payments
- **🛡️ Secure**: Webhook-based payment confirmation and data persistence
- **📱 User-Friendly**: Interactive keyboards and real-time updates
- **👥 Multi-user**: Concurrent user support with session management

## 🏁 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or higher
- [Telegram Bot Token](https://t.me/BotFather) from BotFather
- [Crypto Pay Token](https://t.me/CryptoBot) from Crypto Bot

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/totebot.git
cd totebot

# Install dependencies
npm install

# Set up environment configuration
cp .env.example .env
# Edit .env with your credentials

# Start the bot
npm start

<!-- Русская версия --><div id="русский-russian"></div><div align="center">
🎯 ToteBot - Телеграм Бот-Тотализатор
https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white
https://img.shields.io/badge/Telegraf-4.0+-32A2DB?logo=telegram&logoColor=white
https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white
https://img.shields.io/badge/License-MIT-yellow.svg

Профессиональный менеджер спортивных ставок с криптовалютными платежами

English • Русский

https://via.placeholder.com/800x400/2D3748/FFFFFF?text=%D0%98%D0%BD%D1%82%D0%B5%D1%80%D1%84%D0%B5%D0%B9%D1%81+ToteBot

</div>
✨ Возможности
<div align="center">
🎲 Система ставок	💰 Платежи	👑 Администрирование
Система 15×3 событий	Интеграция Crypto Pay	Полная панель управления
Мульти-комбинационные ставки	USDT/другие криптовалюты	Управление в реальном времени
Интерактивный интерфейс	Тестовый/продакшн режимы	Подсчет результатов
</div>
🚀 Основные возможности
📊 Умные ставки: 15 событий × 3 исхода с автоматическим расчетом комбинаций

💳 Криптоплатежи: Бесшовная интеграция с @CryptoBot для платежей USDT

🛡️ Безопасность: Подтверждение платежей через вебхуки и сохранение данных

📱 Удобство: Интерактивные клавиатуры и обновления в реальном времени

👥 Многопользовательский: Поддержка одновременной работы многих пользователей

🏁 Быстрый старт
Предварительные требования
Node.js 18 или выше

Токен Telegram бота от BotFather

Токен Crypto Pay от Crypto Bot

Установка
bash
# Клонируйте репозиторий
git clone https://github.com/yourusername/totebot.git
cd totebot

# Установите зависимости
npm install

# Настройте конфигурацию окружения
cp .env.example .env
# Отредактируйте .env своими данными

# Запустите бота
npm start
🎮 Базовое использование
Для пользователей 👤
Запустите бота командой /start

Выберите исходы (1/X/2) для всех 15 событий

Сохраните ставку и получите инвойс для оплаты

Оплатите через Crypto Pay и ожидайте результатов

Для администраторов 👑
Откройте панель админа командой /admin

Добавьте 15 событий через "➕ Добавить событие"

Откройте прием ставок через "🟢 Открыть приём"

Закройте прием, установите результаты и разошлите победителям

⚙️ Конфигурация
Переменные окружения
Создайте файл .env со следующими переменными:

env
# ===== НАСТРОЙКИ TELEGRAM =====
BOT_TOKEN=ваш_токен_telegram_бота
ADMIN_IDS=123456789,987654321

# ===== НАСТРОЙКИ ИГРЫ =====
EVENTS_COUNT=15
BASE_STAKE=20
CURRENCY=USDT

# ===== НАСТРОЙКИ CRYPTO PAY =====
CRYPTOPAY_TOKEN=ваш_токен_crypto_pay
CRYPTOPAY_TESTNET=true

# ===== НАСТРОЙКИ СЕРВЕРА =====
PORT=3000
PUBLIC_BASE_URL=https://yourdomain.com
📁 Структура проекта
text
tote-bot/
├── 📄 bot.ts                 # Главная точка входа приложения
├── 📁 data/                  # Хранилище данных
│   ├── 📄 store.json         # Текущее состояние игры
│   └── 📁 history/           # Архив тиражей
├── 📄 .env.example           # Шаблон окружения
├── 📄 ecosystem.config.js    # Конфигурация PM2
└── 📄 package.json           # Зависимости и скрипты
🛠️ Разработка
Доступные скрипты
bash
npm run dev       # Режим разработки с горячей перезагрузкой
npm run start     # Продакшен режим
npm run build     # Компиляция TypeScript
npm run lint      # Проверка кода и стиля
Запуск с PM2
bash
# Продакшен деплоймент
pm2 start ecosystem.config.js

# Мониторинг
pm2 monit

# Просмотр логов
pm2 logs tote-bot --lines 50
🔧 Справочник API
Вебхуки Crypto Pay
Бот автоматически обрабатывает платежи через защищенные вебхуки:

Эндпоинт: POST /webhook-secret-{uuid}

Аутентификация: Валидация секретного пути

Действия: Уведомления об оплате инвойсов → автоматическая активация ставок

Проверка здоровья
bash
curl http://localhost:3000/healthz
# Ответ: {"ok": true, "status": "running"}
🎯 Механика игры
Формула расчета стоимости ставки
text
Стоимость ставки = БАЗОВАЯ_СТАВКА × (Исходы₁ × Исходы₂ × ... × Исходы₁₅)
Пример:

Базовая ставка: 20 USDT

15 событий с 1 исходом каждое: 20 × (1¹⁵) = 20 USDT

15 событий с 2 исходами каждое: 20 × (2¹⁵) = 655,360 USDT

Расчет выигрышей
Количество попаданий: Число правильно угаданных исходов

Аннулированные события: Исключаются из расчетов

Система джекпота: Невыигранные призы переносятся на следующий тираж

🐛 Решение проблем
Частые проблемы
Проблема	Решение
Бот не отвечает	Проверьте статус PM2 и логи
Ошибки платежей	Проверьте токен Crypto Pay и тестовый режим
Повреждение данных	Восстановите из резервной копии в data/history/
Ошибки вебхуков	Проверьте доступность сервера и SSL
Логи и отладка
bash
# Просмотр логов в реальном времени
pm2 logs tote-bot

# Логи только ошибок
pm2 logs tote-bot --err

# Последние 100 строк
pm2 logs tote-bot --lines 100
🤝 Участие в разработке
Мы приветствуем вклад в развитие! Ознакомьтесь с руководством по внесению вклада для подробностей.

Сделайте форк репозитория

Создайте ветку для функции (git checkout -b feature/amazing-feature)

Зафиксируйте изменения (git commit -m 'Add amazing feature')

Отправьте в ветку (git push origin feature/amazing-feature)

Откройте Pull Request

📄 Лицензия
Этот проект лицензирован по лицензии MIT - смотрите файл LICENSE для деталей.

🙏 Благодарности
Telegraf.js - Потрясающий фреймворк для Telegram ботов

Crypto Pay API - Надежная обработка платежей

PM2 - Управление процессами в продакшене

<div align="center">
📞 Поддержка
Нужна помощь?

📧 Поддержка по email

💬 Создать issue

📚 Документация Wiki

⭐ Не забудьте поставить звезду репозиторию, если он вам полезен!

</div> ```
