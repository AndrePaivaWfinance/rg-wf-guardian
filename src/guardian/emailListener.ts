import * as https from 'https';
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

interface GraphTokenResponse {
    access_token: string;
    expires_in: number;
}

interface GraphMessage {
    id: string;
    from: { emailAddress: { address: string } };
    receivedDateTime: string;
    subject: string;
    hasAttachments: boolean;
}

interface GraphAttachment {
    id: string;
    name: string;
    contentType: string;
    size: number;
}

export class EmailListener {
    private readonly tenantId = process.env.GRAPH_TENANT_ID || '';
    private readonly graphClientId = process.env.GRAPH_CLIENT_ID || '';
    private readonly graphClientSecret = process.env.GRAPH_CLIENT_SECRET || '';
    private token: string | null = null;
    private tokenExpires: number = 0;

    constructor(
        private readonly email: string = 'financeiro@wfinancegestao.com.br'
    ) { }

    /** Returns true when Microsoft Graph credentials are configured */
    private isConfigured(): boolean {
        return !!(this.tenantId && this.graphClientId && this.graphClientSecret);
    }

    async processIncomingEmails(): Promise<GuardianDocument[]> {
        logger.info(`Checking mailbox for ${this.email}...`);

        if (!this.isConfigured()) {
            logger.warn('Microsoft Graph não configurado — retornando vazio');
            return [];
        }

        const token = await this.getGraphToken();
        const messages = await this.fetchUnreadMessages(token);
        const results: GuardianDocument[] = [];

        for (const msg of messages) {
            if (!msg.hasAttachments) continue;

            const attachments = await this.fetchAttachments(token, msg.id);
            const docAttachments = attachments
                .filter(a => this.isSupportedType(a.contentType))
                .map(a => ({
                    name: a.name,
                    type: a.contentType,
                    blobUrl: `https://stguardian.blob.core.windows.net/mailbox/${generateId('ATT')}_${a.name}`,
                    size: a.size,
                }));

            if (docAttachments.length > 0) {
                results.push({
                    id: generateId('MSG'),
                    source: this.email,
                    sender: msg.from.emailAddress.address,
                    receivedAt: msg.receivedDateTime,
                    subject: msg.subject,
                    attachments: docAttachments,
                });
            }

            await this.markAsRead(token, msg.id);
        }

        logger.info(`Processados ${results.length} emails com anexos relevantes`);
        return results;
    }

    private isSupportedType(contentType: string): boolean {
        const supported = ['application/pdf', 'text/xml', 'application/xml', 'application/octet-stream', 'text/csv'];
        return supported.some(t => contentType.includes(t));
    }

    private async getGraphToken(): Promise<string> {
        if (this.token && Date.now() < this.tokenExpires) {
            return this.token;
        }

        const postData = `client_id=${encodeURIComponent(this.graphClientId)}&client_secret=${encodeURIComponent(this.graphClientSecret)}&grant_type=client_credentials&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default`;

        const data = await this.graphPost<GraphTokenResponse>(
            'login.microsoftonline.com',
            `/${this.tenantId}/oauth2/v2.0/token`,
            postData
        );

        this.token = data.access_token;
        this.tokenExpires = Date.now() + (data.expires_in - 60) * 1000;
        logger.info('Token Microsoft Graph obtido com sucesso');
        return this.token;
    }

    private async fetchUnreadMessages(token: string): Promise<GraphMessage[]> {
        const userPrincipal = encodeURIComponent(this.email);
        const path = `/v1.0/users/${userPrincipal}/mailFolders/inbox/messages?$filter=isRead eq false&$top=50&$select=id,from,receivedDateTime,subject,hasAttachments`;

        const data = await this.graphGet<{ value: GraphMessage[] }>(token, path);
        return data.value || [];
    }

    private async fetchAttachments(token: string, messageId: string): Promise<GraphAttachment[]> {
        const userPrincipal = encodeURIComponent(this.email);
        const path = `/v1.0/users/${userPrincipal}/messages/${messageId}/attachments?$select=id,name,contentType,size`;

        const data = await this.graphGet<{ value: GraphAttachment[] }>(token, path);
        return data.value || [];
    }

    private async markAsRead(token: string, messageId: string): Promise<void> {
        const userPrincipal = encodeURIComponent(this.email);
        const path = `/v1.0/users/${userPrincipal}/messages/${messageId}`;
        const body = JSON.stringify({ isRead: true });

        await new Promise<void>((resolve, reject) => {
            const req = https.request(
                {
                    hostname: 'graph.microsoft.com',
                    path,
                    method: 'PATCH',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                },
                (res) => {
                    res.on('data', () => { /* drain */ });
                    res.on('end', () => resolve());
                }
            );
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    private async graphGet<T>(token: string, path: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname: 'graph.microsoft.com',
                    path,
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/json',
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        const body = Buffer.concat(chunks).toString();
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(JSON.parse(body) as T);
                        } else {
                            reject(new Error(`Graph API ${res.statusCode}: ${body}`));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.end();
        });
    }

    private async graphPost<T>(hostname: string, path: string, postData: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    hostname,
                    path,
                    method: 'POST',
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
                            resolve(JSON.parse(body) as T);
                        } else {
                            reject(new Error(`Graph Auth ${res.statusCode}: ${body}`));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }
}
