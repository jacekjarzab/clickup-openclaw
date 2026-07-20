export type Logger = {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
};

export function createLogger(scope: string): Logger {
  const write = (level: string, message: string, meta?: Record<string, unknown>) => {
    const payload = meta ? ` ${JSON.stringify(meta)}` : "";
    console.log(`[${level}] ${scope}: ${message}${payload}`);
  };

  return {
    info: (message, meta) => write("info", message, meta),
    error: (message, meta) => write("error", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    debug: (message, meta) => write("debug", message, meta),
  };
}
