import { TableClient } from '@azure/data-tables';
import { createLogger } from '../shared/utils';
import { GuardianAuthorization, hydrateAuth } from '../shared/types';

const logger = createLogger('TableClient');

const TABLES = {
    GUARDIAN_AUTH: 'GuardianAuthorizations',
    GUARDIAN_LEDGER: 'GuardianLedger',
} as const;

// In-memory fallback for local development
const inMemoryStore: Map<string, GuardianAuthorization[]> = new Map();
let useInMemory = false;

const tableClients: Map<string, TableClient> = new Map();
const initializedTables: Set<string> = new Set();

function shouldUseInMemory(): boolean {
    if (useInMemory) return true;
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
    if (!connStr || connStr === 'UseDevelopmentStorage=true') {
        useInMemory = true;
        return true;
    }
    return false;
}

async function getTableClient(tableName: string): Promise<TableClient | null> {
    if (shouldUseInMemory()) return null;

    if (!tableClients.has(tableName)) {
        try {
            const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING || '';
            const client = TableClient.fromConnectionString(connStr, tableName);

            if (!initializedTables.has(tableName)) {
                await client.createTable();
                initializedTables.add(tableName);
                logger.info(`Tabela ${tableName} garantida no Azure Storage`);
            }

            tableClients.set(tableName, client);
        } catch (error) {
            logger.warn('Falha ao conectar ao Azure Table Storage — usando armazenamento in-memory');
            useInMemory = true;
            return null;
        }
    }
    return tableClients.get(tableName)!;
}

function getInMemoryTable(tableName: string): GuardianAuthorization[] {
    if (!inMemoryStore.has(tableName)) {
        inMemoryStore.set(tableName, []);
    }
    return inMemoryStore.get(tableName)!;
}

export async function getGuardianAuthorizations(): Promise<GuardianAuthorization[]> {
    const client = await getTableClient(TABLES.GUARDIAN_AUTH);

    if (!client) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        return table.filter(item => item.status === 'pendente').map(hydrateAuth);
    }

    const items: GuardianAuthorization[] = [];
    try {
        const entities = client.listEntities({
            queryOptions: { filter: `status eq 'pendente'` },
        });
        for await (const entity of entities) {
            items.push(hydrateAuth(entity as unknown as GuardianAuthorization));
        }
    } catch (error) {
        logger.error('Erro ao listar autorizações Guardian', error);
    }
    return items;
}

export async function createGuardianAuth(auth: GuardianAuthorization): Promise<void> {
    const client = await getTableClient(TABLES.GUARDIAN_AUTH);

    if (!client) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        table.push({ partitionKey: 'GUARDIAN', rowKey: auth.id, ...auth });
        logger.info(`[In-Memory] Auth criada: ${auth.id}`);
        return;
    }

    // Strip transient `audit` object — Table Storage only accepts primitives
    const { audit, ...storableAuth } = auth;
    await client.createEntity({
        partitionKey: 'GUARDIAN',
        rowKey: auth.id,
        ...storableAuth,
    });
}
