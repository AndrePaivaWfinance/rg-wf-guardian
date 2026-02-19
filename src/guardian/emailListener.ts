import { createLogger, nowISO, generateId } from '../shared/utils';

const logger = createLogger('EmailListener');

export interface GuardianDocument {
    id: string;
    source: string;
    sender: string;
    receivedAt: string;
    subject: string;
    attachments: Array<{
        name: string;
        type: string;
        blobUrl: string;
        size: number;
    }>;
}

export class EmailListener {
    constructor(
        private readonly email: string = 'financeiro@wfinancegestao.com.br'
    ) { }

    async processIncomingEmails(): Promise<GuardianDocument[]> {
        logger.info(`Checking mailbox for ${this.email}...`);
        // TODO: Integração real com Microsoft Graph API
        return [
            {
                id: generateId('MSG'),
                source: this.email,
                sender: 'faturamento@amazon.com',
                receivedAt: nowISO(),
                subject: 'Sua Fatura AWS - FEV/2026',
                attachments: [
                    {
                        name: 'fatura_aws_9241.pdf',
                        type: 'application/pdf',
                        blobUrl: 'https://stguardian.blob.core.windows.net/mailbox/fatura_aws_9241.pdf',
                        size: 152400,
                    },
                ],
            },
        ];
    }
}
