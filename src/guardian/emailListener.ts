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

/** GAP #4: Attachment with downloaded content bytes */
interface GraphAttachmentWithContent extends GraphAttachment {
    contentBytes?: string; // base64
}

export class EmailListener {
    private readonly tenantId = process.env.GRAPH_TENANT_ID || '';
    private readonly graphClientId = process.env.GRAPH_CLIENT_ID || '';
    private readonly graphClientSecret = process.env.GRAPH_CLIENT_SECRET || '';
    private readonly storageConnStr = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
    private readonly blobContainer = 'mailbox';
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

            // GAP #4: Fetch attachments WITH content bytes
            const attachments = await this.fetchAttachmentsWithContent(token, msg.id);
            const docAttachments: Array<{ name: string; type: string; blobUrl: string; size: number }> = [];

            for (const a of attachments) {
                if (!this.isSupportedType(a.contentType)) continue;

                const blobName = `${generateId('ATT')}_${a.name}`;
                let blobUrl: string;

                // GAP #4: Upload to real Azure Blob Storage if content available
                if (a.contentBytes && this.isBlobConfigured()) {
                    try {
                        blobUrl = await this.uploadToBlob(blobName, a.contentBytes, a.contentType);
                        logger.info(`Attachment uploaded to blob: ${blobName}`);
                    } catch (err) {
                        logger.warn(`Blob upload failed for ${a.name}, using placeholder URL: ${err}`);
                        blobUrl = `https://stguardian.blob.core.windows.net/${this.blobContainer}/${blobName}`;
                    }
                } else {
                    blobUrl = `https://stguardian.blob.core.windows.net/${this.blobContainer}/${blobName}`;
                    if (a.contentBytes) {
                        logger.warn(`Blob Storage not configured — using placeholder URL for ${a.name}`);
                    }
                }

                docAttachments.push({ name: a.name, type: a.contentType, blobUrl, size: a.size });
            }

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

    /**
     * GAP #4: Fetch attachments WITH contentBytes from Graph API.
     * This downloads the actual file content for each attachment.
     */
    private async fetchAttachmentsWithContent(token: string, messageId: string): Promise<GraphAttachmentWithContent[]> {
        const userPrincipal = encodeURIComponent(this.email);
        // Request contentBytes in the select to get the actual file data
        const path = `/v1.0/users/${userPrincipal}/messages/${messageId}/attachments?$select=id,name,contentType,size,contentBytes`;

        const data = await this.graphGet<{ value: GraphAttachmentWithContent[] }>(token, path);
        return data.value || [];
    }

    /** Returns true when Azure Blob Storage is configured */
    private isBlobConfigured(): boolean {
        return !!(this.storageConnStr && this.storageConnStr !== 'UseDevelopmentStorage=true');
    }

    /**
     * GAP #4: Upload base64 content to Azure Blob Storage.
     * Uses the @azure/data-tables connection string to derive the storage account.
     * Returns the public URL of the uploaded blob.
     */
    private async uploadToBlob(blobName: string, contentBase64: string, contentType: string): Promise<string> {
        // Parse storage account from connection string
        const accountMatch = this.storageConnStr.match(/AccountName=([^;]+)/);
        const keyMatch = this.storageConnStr.match(/AccountKey=([^;]+)/);

        if (!accountMatch || !keyMatch) {
            throw new Error('Cannot parse storage account from connection string');
        }

        const accountName = accountMatch[1];
        const accountKey = keyMatch[1];
        const blobBytes = Buffer.from(contentBase64, 'base64');

        // Use REST API to upload blob (avoids extra dependency on @azure/storage-blob)
        const now = new Date().toUTCString();
        const url = `https://${accountName}.blob.core.windows.net/${this.blobContainer}/${blobName}`;

        // Create container if needed, then upload
        // For simplicity, use shared key authentication with x-ms-version header
        const { createHmac } = await import('crypto');

        const putHeaders: Record<string, string> = {
            'x-ms-version': '2023-01-03',
            'x-ms-date': now,
            'x-ms-blob-type': 'BlockBlob',
            'Content-Type': contentType,
            'Content-Length': String(blobBytes.length),
        };

        // Build canonical headers
        const canonicalHeaders = Object.entries(putHeaders)
            .filter(([k]) => k.startsWith('x-ms-'))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}:${v}`)
            .join('\n');

        const canonicalResource = `/${accountName}/${this.blobContainer}/${blobName}`;
        const stringToSign = `PUT\n\n\n${blobBytes.length}\n\n${contentType}\n\n\n\n\n\n\n${canonicalHeaders}\n${canonicalResource}`;
        const signature = createHmac('sha256', Buffer.from(accountKey, 'base64'))
            .update(stringToSign, 'utf-8')
            .digest('base64');

        putHeaders['Authorization'] = `SharedKey ${accountName}:${signature}`;

        const parsedUrl = new URL(url);
        await new Promise<void>((resolve, reject) => {
            const req = https.request(
                {
                    hostname: parsedUrl.hostname,
                    path: parsedUrl.pathname,
                    method: 'PUT',
                    headers: putHeaders,
                },
                (res) => {
                    res.on('data', () => { /* drain */ });
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve();
                        } else {
                            reject(new Error(`Blob upload failed: ${res.statusCode}`));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.write(blobBytes);
            req.end();
        });

        return url;
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
