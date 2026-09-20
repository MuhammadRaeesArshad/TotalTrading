export interface AppConfig {
  port: number;
  nodeEnv: string;
  corsOrigins: string[];
  ollamaUrl: string;
  ollamaModel: string;
  /** A 14B model on a mid-range card is not fast. Generous by design. */
  ollamaTimeoutMs: number;
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '8003', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  ollamaUrl: (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen2.5:14b',
  ollamaTimeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS ?? '120000', 10),
});
