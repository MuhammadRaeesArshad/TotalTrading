/** Mirrors the response models in services/mt5-connector/app/models.py. */

export interface Mt5AccountInfo {
  login: string;
  server: string;
  name: string;
  company: string;
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  margin_free: number;
  margin_level: number;
  profit: number;
  leverage: number;
  trade_allowed: boolean;
}

export interface Mt5SymbolInfo {
  name: string;
  description: string;
  base_currency: string | null;
  profit_currency: string | null;
  digits: number;
  point: number;
  trade_contract_size: number;
  volume_min: number;
  volume_max: number;
  volume_step: number;
  /** Overnight financing, points per lot per night. Negative is a charge. */
  swap_long?: number;
  swap_short?: number;
  /** Weekday charged triple, 0 = Sunday. */
  swap_triple_weekday?: number;
  selected: boolean;
  trade_allowed: boolean;
}

export interface Mt5Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
  spread: number;
}

export interface Mt5ConnectorHealth {
  status: 'ok' | 'degraded';
  mode: 'live' | 'mock';
  terminal_available: boolean;
  version: string;
  detail?: string;
}
