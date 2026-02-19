import { randomBytes } from 'crypto';

export function createLogger(label: string) {
    return {
        info: (msg: string, ...args: unknown[]) => console.log(`[${label}] [INFO] ${msg}`, ...args),
        warn: (msg: string, ...args: unknown[]) => console.warn(`[${label}] [WARN] ${msg}`, ...args),
        error: (msg: string, ...args: unknown[]) => console.error(`[${label}] [ERROR] ${msg}`, ...args),
    };
}

export function nowISO(): string {
    return new Date().toISOString();
}

/** Generates a cryptographically safe, fixed-length unique ID */
export function generateId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;
}

/** Sanitizes error for HTTP response — never leaks internals */
export function safeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        if (process.env.NODE_ENV === 'production' || process.env.AZURE_FUNCTIONS_ENVIRONMENT === 'Production') {
            return 'Erro interno do servidor. Tente novamente mais tarde.';
        }
        return error.message;
    }
    return 'Erro desconhecido';
}

/** Validates a URL string */
export function isValidUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
        return false;
    }
}
