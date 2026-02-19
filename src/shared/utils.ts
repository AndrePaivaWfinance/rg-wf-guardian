export function createLogger(label: string) {
    return {
        info: (msg: string, ...args: any[]) => console.log(`[${label}] [INFO] ${msg}`, ...args),
        warn: (msg: string, ...args: any[]) => console.warn(`[${label}] [WARN] ${msg}`, ...args),
        error: (msg: string, ...args: any[]) => console.error(`[${label}] [ERROR] ${msg}`, ...args),
    };
}

export function nowISO(): string {
    return new Date().toISOString();
}
