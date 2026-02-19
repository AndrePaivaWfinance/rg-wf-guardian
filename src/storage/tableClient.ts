import { TableClient } from '@azure/data-tables';
import { createLogger } from '../shared/utils';

const logger = createLogger('TableClient');

const TABLES = {
    GUARDIAN_AUTH: 'GuardianAuthorizations',
    GUARDIAN_LEDGER: 'GuardianLedger',
} as const;

// In-memory fallback for local development (no Azurite/Azure Storage needed)
const inMemoryStore: Map<string, any[]> = new Map();
let useInMemory = false;

function isLocalDev(): boolean {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
    return !connStr || connStr === 'UseDevelopmentStorage=true';
}

let connectionString: string | null = null;
const tableClients: Map<string, TableClient> = new Map();

function getConnectionString(): string {
    if (!connectionString) {
        connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
        if (!connectionString) {
            logger.warn('AZURE_STORAGE_CONNECTION_STRING não configurada - usando armazenamento in-memory');
            useInMemory = true;
            return '';
        }
    }
    return connectionString;
}

function getTableClient(tableName: string): TableClient | null {
    if (useInMemory || isLocalDev()) {
        useInMemory = true;
        return null;
    }
    if (!tableClients.has(tableName)) {
        try {
            const client = TableClient.fromConnectionString(
                getConnectionString(),
                tableName
            );
            tableClients.set(tableName, client);
        } catch (error) {
            logger.warn('Falha ao conectar ao Azure Table Storage - usando armazenamento in-memory');
            useInMemory = true;
            return null;
        }
    }
    return tableClients.get(tableName)!;
}

function getInMemoryTable(tableName: string): any[] {
    if (!inMemoryStore.has(tableName)) {
        inMemoryStore.set(tableName, []);
    }
    return inMemoryStore.get(tableName)!;
}

export async function getGuardianAuthorizations(): Promise<any[]> {
    if (useInMemory || isLocalDev()) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        return table.filter((item: any) => item.status === 'pendente');
    }

    const client = getTableClient(TABLES.GUARDIAN_AUTH);
    if (!client) {
        return getInMemoryTable(TABLES.GUARDIAN_AUTH).filter((item: any) => item.status === 'pendente');
    }

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
    if (useInMemory || isLocalDev()) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        table.push({ partitionKey: 'GUARDIAN', rowKey: auth.id, ...auth });
        logger.info(`[In-Memory] Auth criada: ${auth.id}`);
        return;
    }

    const client = getTableClient(TABLES.GUARDIAN_AUTH);
    if (!client) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        table.push({ partitionKey: 'GUARDIAN', rowKey: auth.id, ...auth });
        logger.info(`[In-Memory] Auth criada: ${auth.id}`);
        return;
    }

    await client.createEntity({
        partitionKey: 'GUARDIAN',
        rowKey: auth.id,
        ...auth,
    });
}
