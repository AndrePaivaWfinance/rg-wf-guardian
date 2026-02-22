/**
 * GAP #2: Azure AD (Entra ID) Authentication Middleware
 *
 * Validates Bearer tokens from Azure AD.
 * If AAD_CLIENT_ID is not configured, authentication is bypassed (dev mode).
 *
 * Frontend must use MSAL.js to obtain tokens and send them as:
 *   Authorization: Bearer <token>
 */

import * as https from 'https';
import { HttpRequest, HttpResponseInit } from '@azure/functions';
import { createLogger } from './utils';

const logger = createLogger('Auth');

const AAD_CLIENT_ID = process.env.AAD_CLIENT_ID || '';
const AAD_TENANT_ID = process.env.GRAPH_TENANT_ID || '';

interface JwtHeader {
    kid: string;
    alg: string;
}

interface JwtPayload {
    aud: string;
    iss: string;
    exp: number;
    iat: number;
    sub: string;
    name?: string;
    preferred_username?: string;
    oid?: string;
    tid?: string;
}

/** Cached JWKS keys from Azure AD */
let cachedKeys: Map<string, string> | null = null;
let cachedKeysAt = 0;
const KEYS_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Returns true when Azure AD authentication is configured */
export function isAuthConfigured(): boolean {
    return !!(AAD_CLIENT_ID && AAD_TENANT_ID);
}

/** Decodes a base64url string */
function base64urlDecode(str: string): string {
    let padded = str.replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4) padded += '=';
    return Buffer.from(padded, 'base64').toString('utf-8');
}

/** Parses JWT without verification (for extracting kid from header) */
function parseJwt(token: string): { header: JwtHeader; payload: JwtPayload } {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT format');
    return {
        header: JSON.parse(base64urlDecode(parts[0])) as JwtHeader,
        payload: JSON.parse(base64urlDecode(parts[1])) as JwtPayload,
    };
}

/** Fetches Azure AD JWKS keys */
async function fetchJwksKeys(): Promise<Map<string, string>> {
    const now = Date.now();
    if (cachedKeys && (now - cachedKeysAt) < KEYS_TTL_MS) {
        return cachedKeys;
    }

    const jwksUrl = `https://login.microsoftonline.com/${AAD_TENANT_ID}/discovery/v2.0/keys`;

    const data = await new Promise<string>((resolve, reject) => {
        const parsedUrl = new URL(jwksUrl);
        const req = https.request(
            { hostname: parsedUrl.hostname, path: parsedUrl.pathname, method: 'GET' },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks).toString()));
            }
        );
        req.on('error', reject);
        req.end();
    });

    const jwks = JSON.parse(data) as { keys: Array<{ kid: string; x5c?: string[] }> };
    const map = new Map<string, string>();
    for (const key of jwks.keys) {
        if (key.x5c && key.x5c.length > 0) {
            map.set(key.kid, `-----BEGIN CERTIFICATE-----\n${key.x5c[0]}\n-----END CERTIFICATE-----`);
        }
    }

    cachedKeys = map;
    cachedKeysAt = Date.now();
    return map;
}

/** Validates an Azure AD JWT token. Returns the user info or null. */
export async function validateToken(token: string): Promise<JwtPayload | null> {
    try {
        const { header, payload } = parseJwt(token);

        // Basic claim validation
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp < now) {
            logger.warn('Token expired');
            return null;
        }

        // Validate audience (must be our app)
        if (payload.aud !== AAD_CLIENT_ID && payload.aud !== `api://${AAD_CLIENT_ID}`) {
            logger.warn(`Invalid audience: ${payload.aud}`);
            return null;
        }

        // Validate issuer
        const expectedIssuer = `https://login.microsoftonline.com/${AAD_TENANT_ID}/v2.0`;
        if (payload.iss !== expectedIssuer && !payload.iss?.includes(AAD_TENANT_ID)) {
            logger.warn(`Invalid issuer: ${payload.iss}`);
            return null;
        }

        // Verify signature using JWKS
        const keys = await fetchJwksKeys();
        const cert = keys.get(header.kid);
        if (!cert) {
            logger.warn(`Unknown key ID: ${header.kid}`);
            return null;
        }

        const { createVerify } = await import('crypto');
        const [headerB64, payloadB64, signatureB64] = token.split('.');
        const signature = Buffer.from(signatureB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${headerB64}.${payloadB64}`);
        const isValid = verifier.verify(cert, signature);

        if (!isValid) {
            logger.warn('Invalid signature');
            return null;
        }

        return payload;
    } catch (error) {
        logger.error(`Token validation error: ${error}`);
        return null;
    }
}

/** Extracts user identity from a validated request */
export interface AuthUser {
    id: string;       // oid (object ID in Azure AD)
    name: string;     // Display name
    email: string;    // preferred_username
}

/**
 * Authentication middleware for Azure Functions.
 * Returns 401 if auth is configured but token is invalid/missing.
 * Returns null (pass-through) if auth succeeds or is not configured.
 */
export async function requireAuth(request: HttpRequest): Promise<{ error: HttpResponseInit } | { user: AuthUser }> {
    // If auth is not configured, allow all requests (dev mode)
    if (!isAuthConfigured()) {
        return { user: { id: 'anonymous', name: 'Dev User', email: 'dev@local' } };
    }

    const authHeader = request.headers.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
        return {
            error: {
                status: 401,
                jsonBody: { error: 'Authentication required. Send Authorization: Bearer <token>' },
            },
        };
    }

    const token = authHeader.substring(7);
    const payload = await validateToken(token);

    if (!payload) {
        return {
            error: {
                status: 401,
                jsonBody: { error: 'Invalid or expired token.' },
            },
        };
    }

    return {
        user: {
            id: payload.oid || payload.sub,
            name: payload.name || 'Unknown',
            email: payload.preferred_username || '',
        },
    };
}
