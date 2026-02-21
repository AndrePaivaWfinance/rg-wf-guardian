import * as https from 'https';
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

/**
 * InterConnector — consumes wf-operacao-inter-ops as a service.
 * No mTLS needed; inter-ops handles all certificate/OAuth2 logic.
 */
export class InterConnector {
    private readonly baseUrl: string;
    private readonly functionKey: string;
    private readonly client: string;

    constructor(
        baseUrl: string = process.env.INTER_OPS_BASE_URL || '',
        functionKey: string = process.env.INTER_OPS_FUNCTION_KEY || '',
        client: string = process.env.INTER_OPS_CLIENT || 'WFINANCE'
    ) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.functionKey = functionKey;
        this.client = client;
    }

    private isConfigured(): boolean {
        return !!(this.baseUrl && this.functionKey);
    }

    private async request<T>(path: string): Promise<T> {
        const separator = path.includes('?') ? '&' : '?';
        const fullPath = `${path}${separator}code=${encodeURIComponent(this.functionKey)}&client=${encodeURIComponent(this.client)}`;
        const url = new URL(fullPath, this.baseUrl);

        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: url.hostname,
                    path: url.pathname + url.search,
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                    timeout: 5000,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        const data = Buffer.concat(chunks).toString();
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(JSON.parse(data) as T);
                        } else {
                            reject(new Error(`inter-ops ${url.pathname} ${res.statusCode}: ${data}`));
                        }
                    });
                }
            );
            req.setTimeout(5000, () => {
                req.destroy();
                reject(new Error('inter-ops timeout (5s)'));
            });
            req.on('error', reject);
            req.end();
        });
    }

    async getBalance(): Promise<InterBalance> {
        logger.info('Obtendo saldo via inter-ops...');

        if (!this.isConfigured()) {
            throw new Error('inter-ops não configurado');
        }

        const data = await this.request<{
            disponivel: number;
            bloqueadoCheque: number;
            bloqueadoJudicialmente: number;
            bloqueadoAdministrativo?: number;
        }>('/api/saldo');

        const disponivel = data.disponivel || 0;
        const reservado = (data.bloqueadoCheque || 0) + (data.bloqueadoJudicialmente || 0) + (data.bloqueadoAdministrativo || 0);
        return {
            disponivel,
            reservado,
            total: disponivel + reservado,
            dataHora: nowISO(),
        };
    }

    async syncStatement(startDate: string, endDate: string): Promise<InterTransaction[]> {
        logger.info(`Sincronizando extrato via inter-ops: ${startDate} até ${endDate}`);

        if (!this.isConfigured()) {
            logger.warn('inter-ops não configurado — retornando vazio');
            return [];
        }

        const data = await this.request<{
            items: Array<{
                dataEntrada: string;
                tipoTransacao: string;
                tipoOperacao: string;
                valor: string;
                titulo: string;
                descricao: string;
                cpfCnpj?: string;
            }>;
            total: number;
        }>(`/api/extrato?dataInicio=${startDate}&dataFim=${endDate}`);

        return (data.items || []).map(tx => ({
            id: generateId('INTER'),
            data: tx.dataEntrada,
            tipo: (tx.tipoOperacao === 'C' ? 'CREDITO' : 'DEBITO') as 'CREDITO' | 'DEBITO',
            valor: parseFloat(tx.valor),
            descricao: tx.descricao || tx.titulo,
            cpfCnpj: tx.cpfCnpj,
        }));
    }
}
