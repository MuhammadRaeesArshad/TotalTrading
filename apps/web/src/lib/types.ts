export type Mt5AccountMode = 'demo' | 'live';

export type ConnectionState =
  | 'never_connected'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export interface AccountSnapshot {
  balance: number;
  equity: number;
  margin: number;
  marginFree: number;
  marginLevel: number;
  profit: number;
  currency: string;
  leverage: number;
  tradeAllowed: boolean;
  capturedAt: string;
}

export interface Mt5Account {
  id: string;
  label: string;
  login: string;
  server: string;
  broker: string | null;
  mode: Mt5AccountMode;
  connectionState: ConnectionState;
  lastError: string | null;
  lastConnectedAt: string | null;
  snapshot: AccountSnapshot | null;
  availableSymbols: string[];
  permissions: {
    readMarketData: boolean;
    readPositions: boolean;
    placeOrders: boolean;
  };
  isActive: boolean;
  createdAt: string;
}

export interface Instrument {
  id: string;
  symbol: string;
  normalizedPair: string | null;
  instrumentClass: 'major' | 'minor' | 'exotic' | 'other';
  digits: number | null;
  volumeMin: number | null;
  selected: boolean;
  tradable: boolean;
}

export interface ServiceStatus {
  reachable: boolean;
  status?: string;
  mode?: 'live' | 'mock';
  terminal_available?: boolean;
  detail?: string;
}

export type ServicesStatus = Record<string, ServiceStatus>;
