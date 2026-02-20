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

/** Returns only PENDING authorizations (for review) */
export async function getGuardianAuthorizations(): Promise<GuardianAuthorization[]> {
    return getAuthorizationsByStatus('pendente');
}

/** Returns only APPROVED authorizations (for DRE/dashboard calculations) */
export async function getApprovedAuthorizations(): Promise<GuardianAuthorization[]> {
    return getAuthorizationsByStatus('aprovado');
}

/** Returns ALL authorizations regardless of status */
export async function getAllAuthorizations(): Promise<GuardianAuthorization[]> {
    const client = await getTableClient(TABLES.GUARDIAN_AUTH);

    if (!client) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        return table.map(hydrateAuth);
    }

    const items: GuardianAuthorization[] = [];
    try {
        const entities = client.listEntities();
        for await (const entity of entities) {
            items.push(hydrateAuth(entity as unknown as GuardianAuthorization));
        }
    } catch (error) {
        logger.error('Erro ao listar todas as autorizações Guardian', error);
    }
    return items;
}

/** Returns authorizations filtered by status */
async function getAuthorizationsByStatus(status: string): Promise<GuardianAuthorization[]> {
    const client = await getTableClient(TABLES.GUARDIAN_AUTH);

    if (!client) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        return table.filter(item => item.status === status).map(hydrateAuth);
    }

    const items: GuardianAuthorization[] = [];
    try {
        const entities = client.listEntities({
            queryOptions: { filter: `status eq '${status}'` },
        });
        for await (const entity of entities) {
            items.push(hydrateAuth(entity as unknown as GuardianAuthorization));
        }
    } catch (error) {
        logger.error(`Erro ao listar autorizações Guardian (status=${status})`, error);
    }
    return items;
}

export async function updateGuardianAuth(id: string, updates: Partial<GuardianAuthorization>): Promise<void> {
    const client = await getTableClient(TABLES.GUARDIAN_AUTH);

    if (!client) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        const idx = table.findIndex(i => i.id === id);
        if (idx >= 0) Object.assign(table[idx], updates);
        logger.info(`[In-Memory] Auth atualizada: ${id}`);
        return;
    }

    const { audit, ...storableUpdates } = updates;
    await client.updateEntity(
        { partitionKey: 'GUARDIAN', rowKey: id, ...storableUpdates },
        'Merge'
    );
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

/** Removes ALL entities from the GuardianAuthorizations table */
export async function clearAllAuthorizations(): Promise<number> {
    const client = await getTableClient(TABLES.GUARDIAN_AUTH);

    if (!client) {
        const table = getInMemoryTable(TABLES.GUARDIAN_AUTH);
        const count = table.length;
        table.length = 0;
        logger.info(`[In-Memory] ${count} autorizações removidas`);
        return count;
    }

    let count = 0;
    try {
        const entities = client.listEntities({
            queryOptions: { select: ['partitionKey', 'rowKey'] },
        });
        for await (const entity of entities) {
            await client.deleteEntity(entity.partitionKey as string, entity.rowKey as string);
            count++;
        }
        logger.info(`${count} autorizações removidas da tabela Azure`);
    } catch (error) {
        logger.error('Erro ao limpar autorizações', error);
    }
    return count;
}
