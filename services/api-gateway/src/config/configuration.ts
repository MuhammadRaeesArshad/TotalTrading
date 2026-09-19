export interface AppConfig {
  port: number;
  nodeEnv: string;
  corsOrigins: string[];
  mongoUri: string;
  redisUrl: string;
  mt5ConnectorUrl: string;
  engineUrl: string;
  aiAnalysisUrl: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  /** 32-byte key, hex or base64, used to encrypt MT5 passwords at rest. */
  credKey: string;
  allowRegistration: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in — see docs/RUNNING.md.`,
    );
  }
  return value;
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/totaltrading',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  mt5ConnectorUrl: process.env.MT5_CONNECTOR_URL ?? 'http://localhost:8001',
  engineUrl: process.env.ENGINE_URL ?? 'http://localhost:8004',
  aiAnalysisUrl: process.env.AI_ANALYSIS_URL ?? 'http://localhost:8003',
  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
  },
  credKey: required('MT5_CRED_KEY'),
  // Single-operator tool by default. Open it only if you want more than one login.
  allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
});
