import { TableClient } from '@azure/data-tables';
import { createLogger } from '../shared/utils';
import { GuardianAuthorization, hydrateAuth, LearningRule, hydrateLearningRule, AuditLogEntry } from '../shared/types';

const logger = createLogger('TableClient');

const TABLES = {
    GUARDIAN_AUTH: 'GuardianAuthorizations',
    GUARDIAN_LEDGER: 'GuardianLedger',
    GUARDIAN_LEARNING: 'GuardianLearning',
    GUARDIAN_AUDIT_LOG: 'GuardianAuditLog',
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

// ============ LEARNING RULES ============

const learningInMemory: LearningRule[] = [];

/** Returns all learned classification rules */
export async function getLearningRules(): Promise<LearningRule[]> {
    const client = await getTableClient(TABLES.GUARDIAN_LEARNING);

    if (!client) {
        return learningInMemory.map(hydrateLearningRule);
    }

    const items: LearningRule[] = [];
    try {
        const entities = client.listEntities();
        for await (const entity of entities) {
            items.push(hydrateLearningRule(entity as unknown as LearningRule));
        }
    } catch (error) {
        logger.error('Erro ao listar regras de aprendizado', error);
    }
    return items;
}

/** Creates or updates a learning rule (upsert by ID) */
export async function upsertLearningRule(rule: LearningRule): Promise<void> {
    const client = await getTableClient(TABLES.GUARDIAN_LEARNING);

    if (!client) {
        const idx = learningInMemory.findIndex(r => r.id === rule.id);
        if (idx >= 0) {
            learningInMemory[idx] = rule;
        } else {
            learningInMemory.push(rule);
        }
        logger.info(`[In-Memory] Learning rule upserted: ${rule.id} → ${rule.classificacao} (${rule.hits} hits)`);
        return;
    }

    const { tokens, ...storableRule } = rule;
    await client.upsertEntity({
        partitionKey: 'LEARNING',
        rowKey: rule.id,
        ...storableRule,
    });
    logger.info(`Learning rule persisted: ${rule.id} → ${rule.classificacao} (${rule.hits} hits)`);
}

// ============ AUDIT LOG (GAP #1) ============

const auditLogInMemory: AuditLogEntry[] = [];

/** Inserts a new audit log entry */
export async function insertAuditLog(entry: AuditLogEntry): Promise<void> {
    const client = await getTableClient(TABLES.GUARDIAN_AUDIT_LOG);

    if (!client) {
        auditLogInMemory.push(entry);
        logger.info(`[In-Memory] Audit log: ${entry.acao} on ${entry.authId}`);
        return;
    }

    await client.createEntity({
        partitionKey: 'AUDIT',
        rowKey: entry.id,
        ...entry,
    });
    logger.info(`Audit log persisted: ${entry.acao} on ${entry.authId}`);
}

/** Returns all audit log entries, optionally filtered by authId */
export async function getAuditLogs(authId?: string): Promise<AuditLogEntry[]> {
    const client = await getTableClient(TABLES.GUARDIAN_AUDIT_LOG);

    if (!client) {
        if (authId) return auditLogInMemory.filter(e => e.authId === authId);
        return [...auditLogInMemory];
    }

    const items: AuditLogEntry[] = [];
    try {
        const opts = authId
            ? { queryOptions: { filter: `authId eq '${authId}'` } }
            : undefined;
        const entities = client.listEntities(opts);
        for await (const entity of entities) {
            items.push(entity as unknown as AuditLogEntry);
        }
    } catch (error) {
        logger.error('Erro ao listar audit log', error);
    }
    return items;
}
