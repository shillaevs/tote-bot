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
