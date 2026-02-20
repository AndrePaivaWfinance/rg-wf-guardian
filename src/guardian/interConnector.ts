import * as https from 'https';
import * as fs from 'fs';
import { createLogger, nowISO, generateId } from '../shared/utils';

const logger = createLogger('InterConnector');

export interface InterBalance {
    disponivel: number;
    reservado: number;
    total: number;
    dataHora: string;
}

export interface InterTransaction {
    id: string;
    data: string;
    tipo: 'DEBITO' | 'CREDITO';
    valor: number;
    descricao: string;
    cpfCnpjBeneficiario?: string;
}

interface InterTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

export class InterConnector {
    private readonly baseUrl: string;
    private readonly tokenUrl: string;
    private token: string | null = null;
    private tokenExpires: number = 0;

    constructor(
        private readonly clientId: string = process.env.INTER_CLIENT_ID || '',
        private readonly clientSecret: string = process.env.INTER_CLIENT_SECRET || '',
        private readonly certBase64: string = process.env.INTER_CERT_BASE64 || '',
        private readonly keyBase64: string = process.env.INTER_KEY_BASE64 || '',
        private readonly certPath: string = process.env.INTER_CERT_PATH || '',
        private readonly keyPath: string = process.env.INTER_KEY_PATH || '',
        private readonly contaCorrente: string = process.env.INTER_CONTA_CORRENTE || '',
        private readonly environment: 'sandbox' | 'production' = (process.env.INTER_ENVIRONMENT as 'sandbox' | 'production') || 'production'
    ) {
        const host = this.environment === 'sandbox'
            ? 'https://cdpj-sandbox.partners.bancointer.com.br'
            : 'https://cdpj.partners.bancointer.com.br';
        this.baseUrl = `${host}/banking/v2`;
        this.tokenUrl = `${host}/oauth/v2/token`;
    }

    /** Returns true when real Inter API credentials are configured */
    private isConfigured(): boolean {
        const hasCreds = !!(this.clientId && this.clientSecret);
        const hasCerts = !!(this.certBase64 && this.keyBase64) || !!(this.certPath && this.keyPath);
        return hasCreds && hasCerts;
    }

    /** Loads mTLS cert and key — supports base64 env vars or file paths */
    private loadCertificates(): { cert: Buffer; key: Buffer } {
        if (this.certBase64 && this.keyBase64) {
            return {
                cert: Buffer.from(this.certBase64, 'base64'),
                key: Buffer.from(this.keyBase64, 'base64'),
            };
        }
        return {
            cert: fs.readFileSync(this.certPath),
            key: fs.readFileSync(this.keyPath),
        };
    }

    /** Makes an HTTPS request with mTLS to Inter API */
    private async request<T>(method: string, path: string, body?: string): Promise<T> {
        const token = await this.getToken();
        const { cert, key } = this.loadCertificates();
        const url = new URL(path, this.baseUrl.replace('/banking/v2', ''));

        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: url.hostname,
                    path: url.pathname + url.search,
                    method,
                    cert,
                    key,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        const data = Buffer.concat(chunks).toString();
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(JSON.parse(data) as T);
                        } else {
                            reject(new Error(`Inter API ${res.statusCode}: ${data}`));
                        }
                    });
                }
            );
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    async getBalance(): Promise<InterBalance> {
        logger.info('Obtendo saldo Banco Inter...');

        if (!this.isConfigured()) {
            logger.warn('Inter API não configurada — usando dados mock');
            return {
                disponivel: 1242850.42,
                reservado: 0,
                total: 1242850.42,
                dataHora: nowISO(),
            };
        }

        const data = await this.request<{ disponivel: number; bloqueadoCheque: number; bloqueadoJudicialmente: number }>(
            'GET',
            '/banking/v2/saldo'
        );

        const disponivel = data.disponivel || 0;
        const reservado = (data.bloqueadoCheque || 0) + (data.bloqueadoJudicialmente || 0);
        return {
            disponivel,
            reservado,
            total: disponivel + reservado,
            dataHora: nowISO(),
        };
    }

    async syncStatement(startDate: string, endDate: string): Promise<InterTransaction[]> {
        logger.info(`Sincronizando extrato Inter: ${startDate} até ${endDate}`);

        if (!this.isConfigured()) {
            logger.warn('Inter API não configurada — usando dados mock');
            return [
                {
                    id: generateId('INTER'),
                    data: nowISO().split('T')[0],
                    tipo: 'CREDITO',
                    valor: 42100.00,
                    descricao: 'PIX RECEBIDO - CLIENTE BPO ACME',
                    cpfCnpjBeneficiario: '12345678000199',
                },
                {
                    id: generateId('INTER'),
                    data: nowISO().split('T')[0],
                    tipo: 'DEBITO',
                    valor: 1540.22,
                    descricao: 'PAGAMENTO BOLETO - CONDOMINIO HQ',
                },
            ];
        }

        const data = await this.request<{ transacoes: Array<{
            dataEntrada: string;
            tipoTransacao: string;
            tipoOperacao: string;
            valor: string;
            titulo: string;
            descricao: string;
            cpfCnpj?: string;
        }> }>(
            'GET',
            `/banking/v2/extrato?dataInicio=${startDate}&dataFim=${endDate}`
        );

        return (data.transacoes || []).map(tx => ({
            id: generateId('INTER'),
            data: tx.dataEntrada,
            tipo: (tx.tipoOperacao === 'C' ? 'CREDITO' : 'DEBITO') as 'CREDITO' | 'DEBITO',
            valor: parseFloat(tx.valor),
            descricao: tx.titulo || tx.descricao,
            cpfCnpjBeneficiario: tx.cpfCnpj,
        }));
    }

    private async getToken(): Promise<string> {
        if (this.token && Date.now() < this.tokenExpires) {
            return this.token;
        }

        if (!this.isConfigured()) {
            this.token = 'bearer_mock_token';
            this.tokenExpires = Date.now() + 3600 * 1000;
            return this.token;
        }

        const { cert, key } = this.loadCertificates();
        const postData = `client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}&grant_type=client_credentials&scope=extrato.read boleto-cobranca.read`;
        const url = new URL(this.tokenUrl);

        const tokenData = await new Promise<InterTokenResponse>((resolve, reject) => {
            const req = https.request(
                {
                    hostname: url.hostname,
                    path: url.pathname,
                    method: 'POST',
                    cert,
                    key,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(postData),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        const body = Buffer.concat(chunks).toString();
                        if (res.statusCode === 200) {
                            resolve(JSON.parse(body) as InterTokenResponse);
                        } else {
                            reject(new Error(`Inter OAuth2 falhou (${res.statusCode}): ${body}`));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.write(postData);
            req.end();
        });

        this.token = tokenData.access_token;
        this.tokenExpires = Date.now() + (tokenData.expires_in - 60) * 1000;
        logger.info('Token Inter obtido com sucesso');
        return this.token;
    }
}
