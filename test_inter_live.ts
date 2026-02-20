/**
 * Test script: calls Inter API directly through proxy to see real data
 */
import * as https from 'https';
import * as fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Load env from local.settings.json
const settings = JSON.parse(fs.readFileSync('./local.settings.json', 'utf-8'));
const env = settings.Values || {};

const CLIENT_ID = env.INTER_CLIENT_ID || '';
const CLIENT_SECRET = env.INTER_CLIENT_SECRET || '';
const CERT_B64 = env.INTER_CERT_BASE64 || '';
const KEY_B64 = env.INTER_KEY_BASE64 || '';
// Force production since sandbox DNS doesn't resolve
const ENV = 'production' as const;

const HOST = ENV === 'sandbox'
    ? 'cdpj-sandbox.partners.bancointer.com.br'
    : 'cdpj.partners.bancointer.com.br';

const cert = Buffer.from(CERT_B64, 'base64');
const key = Buffer.from(KEY_B64, 'base64');

const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

console.log(`\n=== Inter API Live Test ===`);
console.log(`Environment: ${ENV}`);
console.log(`Host: ${HOST}`);
console.log(`Client ID: ${CLIENT_ID.substring(0, 8)}...`);
console.log(`Cert loaded: ${cert.length} bytes`);
console.log(`Key loaded: ${key.length} bytes`);
console.log(`Proxy: ${proxyUrl ? 'YES' : 'NO'}\n`);

function request<T>(method: string, hostname: string, path: string, body?: string, headers?: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; data: T | string }> {
    return new Promise((resolve, reject) => {
        const opts: https.RequestOptions = {
            hostname,
            path,
            method,
            cert,
            key,
            headers: headers || {},
            agent,
            rejectUnauthorized: true,
        };
        console.log(`  >> ${method} https://${hostname}${path}`);
        if (body) console.log(`  >> Body (${body.length} bytes): ${body.substring(0, 120)}...`);
        const req = https.request(opts, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                console.log(`  << Status: ${res.statusCode}`);
                console.log(`  << Headers: ${JSON.stringify(res.headers)}`);
                console.log(`  << Body (${raw.length} chars): ${raw.substring(0, 500)}`);
                try {
                    resolve({ status: res.statusCode || 0, headers: res.headers, data: JSON.parse(raw) as T });
                } catch {
                    resolve({ status: res.statusCode || 0, headers: res.headers, data: raw });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function main() {
    // 1. Get token
    console.log('--- Step 1: OAuth2 Token ---');
    const postData = `client_id=${encodeURIComponent(CLIENT_ID)}&client_secret=${encodeURIComponent(CLIENT_SECRET)}&grant_type=client_credentials&scope=${encodeURIComponent('extrato.read boleto-cobranca.read')}`;

    const tokenResp = await request<{ access_token: string; token_type: string; expires_in: number }>(
        'POST',
        HOST,
        '/oauth/v2/token',
        postData,
        {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(Buffer.byteLength(postData)),
        }
    );

    console.log(`Token response status: ${tokenResp.status}`);
    if (tokenResp.status !== 200) {
        console.log('Token response:', JSON.stringify(tokenResp.data, null, 2));
        console.log('\nFailed to get token. Aborting.');
        return;
    }

    const tokenData = tokenResp.data as { access_token: string };
    const token = tokenData.access_token;
    console.log(`Token obtained: ${token.substring(0, 20)}...`);
    console.log('Full token response:', JSON.stringify(tokenResp.data, null, 2));

    const authHeaders = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };

    // 2. Get balance
    console.log('\n--- Step 2: Saldo ---');
    const balanceResp = await request('GET', HOST, '/banking/v2/saldo', undefined, authHeaders);
    console.log(`Balance status: ${balanceResp.status}`);
    console.log('Balance:', JSON.stringify(balanceResp.data, null, 2));

    // 3. Get statement (last 30 days)
    console.log('\n--- Step 3: Extrato (30 dias) ---');
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const extratoResp = await request('GET', HOST, `/banking/v2/extrato?dataInicio=${startDate}&dataFim=${endDate}`, undefined, authHeaders);
    console.log(`Extrato status: ${extratoResp.status}`);
    console.log('Extrato:', JSON.stringify(extratoResp.data, null, 2));
}

main().catch(err => {
    console.error('FATAL ERROR:', err.message || err);
});
