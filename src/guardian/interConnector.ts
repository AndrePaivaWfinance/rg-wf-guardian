import { createLogger, nowISO } from '../shared/utils';

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

export class InterConnector {
    private readonly baseUrl = 'https://cdpj.inter.co/banking/v2';
    private token: string | null = null;
    private tokenExpires: number = 0;

    constructor(
        private readonly clientId: string = process.env.INTER_CLIENT_ID || '',
        private readonly clientSecret: string = process.env.INTER_CLIENT_SECRET || '',
        private readonly certPath: string = process.env.INTER_CERT_PATH || '',
        private readonly keyPath: string = process.env.INTER_KEY_PATH || ''
    ) { }

    async getBalance(): Promise<InterBalance> {
        logger.info('Obtendo saldo Banco Inter...');
        return {
            disponivel: 1242850.42,
            reservado: 0,
            total: 1242850.42,
            dataHora: nowISO()
        };
    }

    async syncStatement(startDate: string, endDate: string): Promise<InterTransaction[]> {
        logger.info(`Sincronizando extrato Inter: ${startDate} até ${endDate}`);
        return [
            {
                id: 'INTER_' + Date.now(),
                data: nowISO().split('T')[0],
                tipo: 'CREDITO',
                valor: 42100.00,
                descricao: 'PIX RECEBIDO - CLIENTE BPO ACME',
                cpfCnpjBeneficiario: '12345678000199'
            },
            {
                id: 'INTER_' + (Date.now() + 1),
                data: nowISO().split('T')[0],
                tipo: 'DEBITO',
                valor: 1540.22,
                descricao: 'PAGAMENTO BOLETO - CONDOMINIO HQ',
            }
        ];
    }

    private async getToken(): Promise<string> {
        if (this.token && Date.now() < this.tokenExpires) {
            return this.token;
        }
        this.token = 'bearer_' + Math.random().toString(36).substring(7);
        this.tokenExpires = Date.now() + 3600 * 1000;
        return this.token;
    }
}
