// settlement.ts — стратегии распределения призов

export type FormulaName = 'MAX_HITS_EQUAL_SHARE' | 'TIERED_WEIGHTS' | 'FIXED_TABLE';

export interface SettlementInput {
  drawId: string;
  totalBank: number;
  maxHitsInDraw: number;
  hitsByUser: Array<{ userId: number; wallet: string; hits: number }>;
}

export interface Payout {
  userId: number;
  wallet: string;
  amount: number;
  hits: number;
}

export interface SettlementResult {
  formulaName: FormulaName;
  formulaVersion: string;
  formulaParams: any;
  prizePool: number;
  payouts: Payout[];
  leftover: number;
  maxHitsInDraw: number;
}

interface MaxHitsParams { prizePoolPct: number; rolloverIfNoWinners: boolean }
interface TieredParams { prizePoolPct: number; weights: { [hits: string]: number }; minHits: number; rolloverUnclaimed: boolean }
interface FixedParams { fixed: { [hits: string]: number }; rolloverUnclaimed: boolean }

const FORMULA_VERSION = '1.0.0';

function toMinor(x: number, decimals = 6): bigint {
  return BigInt(Math.round(x * Math.pow(10, decimals)));
}

function fromMinor(x: bigint, decimals = 6): number {
  return Number(x) / Math.pow(10, decimals);
}

function maxHitsEqualShare(input: SettlementInput, params: any): SettlementResult {
  const prizePoolPct = params?.prizePoolPct ?? 0.90;
  const prizePoolMinor = toMinor(input.totalBank * prizePoolPct);
  const winners = input.hitsByUser.filter(h => h.hits === input.maxHitsInDraw);

  if (winners.length === 0) {
    return {
      formulaName: 'MAX_HITS_EQUAL_SHARE',
      formulaVersion: FORMULA_VERSION,
      formulaParams: params,
      prizePool: fromMinor(prizePoolMinor),
      payouts: [],
      leftover: fromMinor(prizePoolMinor),
	  maxHitsInDraw: input.maxHitsInDraw
    };
  }

  const shareMinor = prizePoolMinor / BigInt(winners.length);
  const payouts: Payout[] = winners.map(w => ({
    userId: w.userId,
    wallet: w.wallet,
    hits: w.hits,
    amount: fromMinor(shareMinor)
  }));

  const distributedMinor = shareMinor * BigInt(winners.length);
  const leftoverMinor = prizePoolMinor - distributedMinor;

  return {
    formulaName: 'MAX_HITS_EQUAL_SHARE',
    formulaVersion: FORMULA_VERSION,
    formulaParams: params,
    prizePool: fromMinor(prizePoolMinor),
    payouts,
    leftover: fromMinor(leftoverMinor),
	maxHitsInDraw: input.maxHitsInDraw
  };
}

function tieredWeights(input: SettlementInput, params: any): SettlementResult {
  const prizePoolPct = params?.prizePoolPct ?? 0.90;
  const weights: Record<string, number> = params?.weights ?? { "15": 70, "14": 20, "13": 10 };
  const minHits = params?.minHits ?? Math.min(...Object.keys(weights).map(k => +k));
  if (!weights || typeof weights !== 'object' || !minHits) {
    throw new Error('Invalid TIERED_WEIGHTS params');
  }

  const prizePoolMinor = toMinor(input.totalBank * prizePoolPct);
  const levels = Object.keys(weights).map(n => +n).filter(h => h <= input.maxHitsInDraw && h >= minHits);
  const winnersByLevel: Record<number, Array<{ userId: number; wallet: string }>> = {};
  levels.forEach(h => {
    winnersByLevel[h] = input.hitsByUser.filter(u => u.hits === h);
  });

  const totalWeight = levels.reduce((s, h) => s + (weights[h] ?? 0) * winnersByLevel[h].length, 0);
  if (totalWeight <= 0) {
    return {
      formulaName: 'TIERED_WEIGHTS',
      formulaVersion: FORMULA_VERSION,
      formulaParams: params,
      prizePool: fromMinor(prizePoolMinor),
      payouts: [],
      leftover: fromMinor(prizePoolMinor),
	  maxHitsInDraw: input.maxHitsInDraw
    };
  }

  const unitMinor = prizePoolMinor / BigInt(totalWeight);
  const payouts: Payout[] = [];
  let distributedMinor = 0n;
  for (const hits of levels) {
    const group = winnersByLevel[hits];
    if (!group?.length) continue;
    const weight = weights[hits] || 0;
    const shareMinor = unitMinor * BigInt(weight);
    for (const w of group) {
      payouts.push({ userId: w.userId, wallet: w.wallet, hits, amount: fromMinor(shareMinor) });
    }
    distributedMinor += shareMinor * BigInt(group.length);
  }

  const leftoverMinor = prizePoolMinor - distributedMinor;
  return {
    formulaName: 'TIERED_WEIGHTS',
    formulaVersion: FORMULA_VERSION,
    formulaParams: params,
    prizePool: fromMinor(prizePoolMinor),
    payouts,
    leftover: fromMinor(leftoverMinor < 0n ? 0n : leftoverMinor),
	maxHitsInDraw: input.maxHitsInDraw
  };
}

function fixedTable(input: SettlementInput, params: any): SettlementResult {
  const fixed: Record<string, number> = params?.fixed ?? {};
  if (!fixed || typeof fixed !== 'object') {
    throw new Error('Invalid FIXED_TABLE params');
  }

  const prizePoolMinor = toMinor(input.totalBank);
  const payouts: Payout[] = [];
  let distributedMinor = 0n;

  const winnersByLevel: Record<number, Array<{ userId: number; wallet: string }>> = {};
  for (let hits = 0; hits <= input.maxHitsInDraw; hits++) {
    winnersByLevel[hits] = input.hitsByUser.filter(u => u.hits === hits);
  }

  for (const hits of Object.keys(winnersByLevel).map(n => +n)) {
    const group = winnersByLevel[hits];
    if (!group?.length) continue;
    const prize = fixed[hits] ?? 0;
    if (prize <= 0) continue;
    const prizeMinor = toMinor(prize);
    for (const w of group) {
      payouts.push({ userId: w.userId, wallet: w.wallet, hits, amount: fromMinor(prizeMinor) });
    }
    distributedMinor += prizeMinor * BigInt(group.length);
  }

  const leftoverMinor = prizePoolMinor - distributedMinor;
  return {
    formulaName: 'FIXED_TABLE',
    formulaVersion: FORMULA_VERSION,
    formulaParams: params,
    prizePool: fromMinor(prizePoolMinor),
    payouts,
    leftover: fromMinor(leftoverMinor < 0n ? 0n : leftoverMinor),
	maxHitsInDraw: input.maxHitsInDraw
  };
}

export function calculatePayouts(formula: FormulaName, input: SettlementInput, params: MaxHitsParams | TieredParams | FixedParams): SettlementResult {
  if (formula === 'MAX_HITS_EQUAL_SHARE') return maxHitsEqualShare(input, params);
  if (formula === 'TIERED_WEIGHTS') return tieredWeights(input, params);
  if (formula === 'FIXED_TABLE') return fixedTable(input, params);
  throw new Error('Unknown formula: ' + formula);
}
