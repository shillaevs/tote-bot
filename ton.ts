// ton.ts — helpers для TON mainnet/testnet, TON и USDT (jetton на TON)
import TonWeb from 'tonweb';
import { mnemonicToKeyPair } from 'tonweb-mnemonic';
import { getHttpEndpoint } from '@orbs-network/ton-access';

const isTestnet = (process.env.TON_NETWORK || 'mainnet') !== 'mainnet';
let tonweb: TonWeb;
let provider: any;

// ENV
const RECEIVE_BASE_ADDRESS = (process.env.TON_RECEIVE_ADDRESS || '').trim(); // базовый (owner) адрес, на который приходят TON, и который является владельцем jetton-кошелька
const MNEMONIC = (process.env.TON_MNEMONIC || '').replace(/\"/g, '');
const MIN_CONF = Number(process.env.TON_MIN_CONFIRMATIONS || 1);
const ASSET = (process.env.CURRENCY || 'TON').toUpperCase(); // 'TON' | 'USDT_TON'

// Адрес мастера USDT-jetton на нужной сети (обязателен если CURRENCY=USDT_TON)
// mainnet: EQDxxxxx..., testnet: EQBxxxxx... — укажите в .env
const USDT_MASTER = (process.env.TON_USDT_MASTER || '').trim();

export function isTonConfigured(): boolean {
  return !!RECEIVE_BASE_ADDRESS;
}
export function getAssetKind(): 'TON' | 'USDT_TON' {
  return ASSET === 'USDT_TON' ? 'USDT_TON' : 'TON';
}
export function getReceiveAddress(): string {
  if (!RECEIVE_BASE_ADDRESS) throw new Error('TON_RECEIVE_ADDRESS is empty');
  return RECEIVE_BASE_ADDRESS;
}

export async function initTon() {
  const endpoint = await getHttpEndpoint({ network: isTestnet ? 'testnet' : 'mainnet' });
  provider = new (TonWeb as any).HttpProvider(endpoint);
  tonweb = new TonWeb(provider);
}

// ------------------ TON: проверка входящего платежа ------------------
export async function checkTonPayment(params: {
  toAddress: string;
  expectedAmountTon: number;
  comment: string;
  minConfirmations?: number;
}): Promise<{ found: boolean; txHash?: string }> {
  const minConf = params.minConfirmations ?? MIN_CONF;
  const txs = await provider.getTransactions(params.toAddress, 40);
  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    const valueNano = Number(inMsg.value || 0);
    const valueTon = valueNano / 1e9;
    const okAmount = Math.abs(valueTon - params.expectedAmountTon) < 0.001 || valueTon >= params.expectedAmountTon;
    const msgText = (inMsg.message || inMsg.comment || '').toString();
    if (okAmount && (!params.comment || msgText.includes(params.comment))) {
      const conf = Number(tx.utime || 0) ? 1 : 0; // MVP
      if (conf >= minConf) return { found: true, txHash: tx.hash };
    }
  }
  return { found: false };
}

// ------------------ TON: отправка ------------------
export async function sendTon(params: {
  toAddress: string;
  amountTon: number;
  comment?: string;
}): Promise<{ ok: boolean; txHash?: string }> {
  if (!MNEMONIC) throw new Error('TON_MNEMONIC is empty');
  const words = MNEMONIC.split(/\s+/);

  const keyPair = await mnemonicToKeyPair(words);
  const WalletClass = (tonweb.wallet.all as any).v3R2;
  const wallet = new WalletClass(tonweb.provider, { publicKey: keyPair.publicKey });
  const seqno = (await wallet.methods.seqno().call()) || 0;

  const amountNano = Math.round(params.amountTon * 1e9);
  const transfer = wallet.methods.transfer({
    secretKey: keyPair.secretKey,
    toAddress: params.toAddress,
    amount: amountNano,
    seqno,
    payload: params.comment ? new (TonWeb.utils as any).TextEncoder().encode(params.comment) : undefined,
    sendMode: 3,
  });

  const res = await transfer.send();
  return { ok: true, txHash: String(res?.transaction?.hash || '') };
}

// ------------------ USDT (jetton): utils ------------------
function requireUSDT() {
  if (!USDT_MASTER) throw new Error('TON_USDT_MASTER is empty (required for USDT_TON)');
}

function addr(a: string) {
  return new (TonWeb.utils as any).Address(a);
}

async function getUserJettonWalletAddress(ownerBaseAddress: string): Promise<string> {
  requireUSDT();
  // Jetton master & wallet
  const JettonMaster = (TonWeb as any).token.jetton.JettonMaster;
  const master = new JettonMaster(tonweb.provider, { address: addr(USDT_MASTER) });
  const walletAddr = await master.getWalletAddress(addr(ownerBaseAddress));
  return walletAddr.toString(true, true, true);
}

// ------------------ USDT (jetton): проверка поступления ------------------
// MVP-алгоритм: смотрим последние транзакции JETTON-WALLET адреса приёма,
// ищем входящий jetton-трансфер на сумму >= expectedAmountTokens,
// и (если возможно) проверяем, что forward-payload содержит наш comment.
export async function checkJettonPayment(params: {
  ownerBaseAddress: string;     // базовый адрес приёма (owner)
  expectedAmountTokens: number; // USDT количество (целое/десятичное)
  comment?: string;
  minConfirmations?: number;
}): Promise<{ found: boolean; txHash?: string }> {
  requireUSDT();
  const minConf = params.minConfirmations ?? MIN_CONF;
  const jettonWallet = await getUserJettonWalletAddress(params.ownerBaseAddress);

  // В большинстве RPC сумма jetton-трансфера не лежит прямо в in_msg.value.
  // Мы используем эвристику: проверим наличие текстового сообщения (forward payload) и попытаемся совпасть по комменту.
  // Если комментария нет, оставим проверку только по сумме (на ответственных кошельках сумма видна).
  const txs = await provider.getTransactions(jettonWallet, 50);
  for (const tx of txs) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;

    // Иногда forward-payload "пробрасывается" в out_msgs на ownerBaseAddress, но не всегда доступен тут.
    // Сначала проверим текст в in_msg (если провайдер его кладёт):
    const text = (inMsg.message || inMsg.comment || '').toString();

    // Эвристика по сумме: некоторые провайдеры пишут "jetton: <amount>" в комментарии.
    const amountHint = (() => {
      const m = text.match(/([0-9]+(?:\.[0-9]+)?)/);
      return m ? Number(m[1]) : NaN;
    })();

    const conf = Number(tx.utime || 0) ? 1 : 0;
    const okConf = conf >= minConf;

    // Совпадение по комменту — надёжнее
    if (params.comment && text.includes(params.comment) && okConf) {
      // при наличии комментария считаем платёж найденным (в пределах последних N транзакций)
      return { found: true, txHash: tx.hash };
    }

    // Если комментария может не быть — fallback по сумме (осторожно)
    if (!isNaN(amountHint)) {
      const okAmount = Math.abs(amountHint - params.expectedAmountTokens) < 1e-6 || amountHint >= params.expectedAmountTokens;
      if (okAmount && okConf) {
        return { found: true, txHash: tx.hash };
      }
    }
  }
  return { found: false };
}

// ------------------ USDT (jetton): отправка ------------------
export async function sendJetton(params: {
  toAddress: string;      // адрес получателя (base)
  amountTokens: number;   // количество USDT (jetton, 6 знаков после запятой)
  comment?: string;       // forward-payload к получателю
}): Promise<{ ok: boolean; txHash?: string }> {
  requireUSDT();
  if (!MNEMONIC) throw new Error('TON_MNEMONIC is empty');
  const words = MNEMONIC.split(/\s+/);

  const keyPair = await mnemonicToKeyPair(words);
  const WalletClass = (tonweb.wallet.all as any).v3R2;
  const ownerWallet = new WalletClass(tonweb.provider, { publicKey: keyPair.publicKey });

  // Адрес jetton-кошелька для *нашего* owner (кошелька выплат)
  const JettonMaster = (TonWeb as any).token.jetton.JettonMaster;
  const JettonWallet = (TonWeb as any).token.jetton.JettonWallet;

  const master = new JettonMaster(tonweb.provider, { address: addr(USDT_MASTER) });

  // Jetton-кошелёк отправителя (наш)
  const ourJettonWalletAddr = await master.getWalletAddress(await ownerWallet.getAddress());
  const ourJettonWallet = new JettonWallet(tonweb.provider, { address: ourJettonWalletAddr });

  // Jetton требует минимальный TON для gas/forward
  const forwardTon = 0.05; // TON для доставки комментария/нотификации получателю (можно уменьшить)
  const amountUnits = BigInt(Math.round(params.amountTokens * 1e6)); // USDT обычно 6 знаков после запятой

  const seqno = (await ownerWallet.methods.seqno().call()) || 0;

  // Метод transfer у JettonWallet:
  // toAddress — base адрес получателя (его jetton-кошелёк вычислится автоматически контрактом),
  // amount — в минимальных единицах jetton (10^decimals),
  // forwardPayload — комментарий (как TextEncoder) попадёт к получателю.
  const payload = params.comment
    ? new (TonWeb.utils as any).TextEncoder().encode(params.comment)
    : undefined;

  const tx = await (ourJettonWallet.methods as any).transfer(
    addr(params.toAddress),
    amountUnits,
    addr(await ownerWallet.getAddress()), // response destination (наш кошелек)
    payload,
    Math.round(forwardTon * 1e9)          // forward_ton_amount (в нанотонах)
  ).send(ownerWallet, keyPair.secretKey, seqno);

  return { ok: true, txHash: String(tx?.transaction?.hash || '') };
}
