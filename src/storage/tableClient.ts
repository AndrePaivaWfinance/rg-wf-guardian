import { TableClient } from '@azure/data-tables';
import { createLogger } from '../shared/utils';

const logger = createLogger('TableClient');

const TABLES = {
    GUARDIAN_AUTH: 'GuardianAuthorizations',
    GUARDIAN_LEDGER: 'GuardianLedger',
} as const;

let connectionString: string | null = null;
const tableClients: Map<string, TableClient> = new Map();

function getConnectionString(): string {
    if (!connectionString) {
        connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
        if (!connectionString) {
            throw new Error('AZURE_STORAGE_CONNECTION_STRING não configurada');
        }
    }
    return connectionString;
}

function getTableClient(tableName: string): TableClient {
    if (!tableClients.has(tableName)) {
        const client = TableClient.fromConnectionString(
            getConnectionString(),
            tableName
        );
        tableClients.set(tableName, client);
    }
    return tableClients.get(tableName)!;
}

export async function getGuardianAuthorizations(): Promise<any[]> {
    const client = getTableClient(TABLES.GUARDIAN_AUTH);
    const items: any[] = [];
    try {
        const entities = client.listEntities({
            queryOptions: { filter: `status eq 'pendente'` },
        });
        for await (const entity of entities) {
            items.push(entity);
        }
    } catch (error) {
        logger.error('Erro ao listar autorizações Guardian', error);
    }
    return items;
}

export async function createGuardianAuth(auth: any): Promise<void> {
    const client = getTableClient(TABLES.GUARDIAN_AUTH);
    await client.createEntity({
        partitionKey: 'GUARDIAN',
        rowKey: auth.id,
        ...auth,
    });
}
