export function createLogger(scope) {
    const write = (level, message, meta) => {
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
