import { TableClient } from '@azure/data-tables';
import { createLogger } from '../shared/utils';
import {
    AreaType,
    OperacoesProject,
    MarketingCampaign,
    ComercialDeal,
    InvestmentAccount,
    InvestmentMovement,
} from '../shared/areas';

const logger = createLogger('AreaTableClient');

type AreaRecord = OperacoesProject | MarketingCampaign | ComercialDeal | InvestmentAccount | InvestmentMovement;

const TABLE_NAMES: Record<AreaType, string> = {
    operacoes: 'GuardianOperacoes',
    marketing: 'GuardianMarketing',
    comercial: 'GuardianComercial',
    investimentos: 'GuardianInvestimentos',
};

const INVESTMENT_MOVEMENTS_TABLE = 'GuardianInvestimentoMovimentos';

// In-memory fallback
const inMemoryStore: Map<string, AreaRecord[]> = new Map();
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
        } catch {
            logger.warn(`Falha ao conectar tabela ${tableName} — usando in-memory`);
            useInMemory = true;
            return null;
        }
    }
    return tableClients.get(tableName)!;
}

function getInMemoryTable(tableName: string): AreaRecord[] {
    if (!inMemoryStore.has(tableName)) {
        inMemoryStore.set(tableName, []);
    }
    return inMemoryStore.get(tableName)!;
}

export async function getAreaRecords<T extends AreaRecord>(area: AreaType): Promise<T[]> {
    const tableName = TABLE_NAMES[area];
    const client = await getTableClient(tableName);

    if (!client) {
        return getInMemoryTable(tableName) as T[];
    }

    const items: T[] = [];
    try {
        const entities = client.listEntities();
        for await (const entity of entities) {
            items.push(entity as unknown as T);
        }
    } catch (error) {
        logger.error(`Erro ao listar ${area}`, error);
    }
    return items;
}

export async function createAreaRecord(area: AreaType, record: AreaRecord): Promise<void> {
    const tableName = TABLE_NAMES[area];
    const client = await getTableClient(tableName);

    if (!client) {
        const table = getInMemoryTable(tableName);
        table.push(record);
        logger.info(`[In-Memory] ${area} record criado: ${record.id}`);
        return;
    }

    await client.createEntity({
        partitionKey: area.toUpperCase(),
        rowKey: record.id,
        ...record,
    });
}

export async function updateAreaRecord(area: AreaType, record: AreaRecord): Promise<void> {
    const tableName = TABLE_NAMES[area];
    const client = await getTableClient(tableName);

    if (!client) {
        const table = getInMemoryTable(tableName);
        const idx = table.findIndex(r => r.id === record.id);
        if (idx >= 0) table[idx] = record;
        else table.push(record);
        logger.info(`[In-Memory] ${area} record atualizado: ${record.id}`);
        return;
    }

    await client.upsertEntity({
        partitionKey: area.toUpperCase(),
        rowKey: record.id,
        ...record,
    });
}

export async function deleteAreaRecord(area: AreaType, recordId: string): Promise<void> {
    const tableName = TABLE_NAMES[area];
    const client = await getTableClient(tableName);

    if (!client) {
        const table = getInMemoryTable(tableName);
        const idx = table.findIndex(r => r.id === recordId);
        if (idx >= 0) table.splice(idx, 1);
        logger.info(`[In-Memory] ${area} record removido: ${recordId}`);
        return;
    }

    await client.deleteEntity(area.toUpperCase(), recordId);
}

// ============ GUARDIAN CONFIG ============

const CONFIG_TABLE = 'GuardianConfig';
const configInMemory: Map<string, string> = new Map();

export async function getConfig(key: string): Promise<string | null> {
    const client = await getTableClient(CONFIG_TABLE);

    if (!client) {
        return configInMemory.get(key) ?? null;
    }

    try {
        const entity = await client.getEntity('CONFIG', key);
        return (entity as unknown as { value: string }).value ?? null;
    } catch {
        return null;
    }
}

export async function setConfig(key: string, value: string): Promise<void> {
    const client = await getTableClient(CONFIG_TABLE);

    if (!client) {
        configInMemory.set(key, value);
        logger.info(`[In-Memory] Config setada: ${key}`);
        return;
    }

    await client.upsertEntity({
        partitionKey: 'CONFIG',
        rowKey: key,
        value,
    });
    logger.info(`Config persistida: ${key}`);
}

export async function getAllConfig(): Promise<Record<string, string>> {
    const client = await getTableClient(CONFIG_TABLE);

    if (!client) {
        const result: Record<string, string> = {};
        configInMemory.forEach((v, k) => { result[k] = v; });
        return result;
    }

    const result: Record<string, string> = {};
    try {
        const entities = client.listEntities();
        for await (const entity of entities) {
            const e = entity as unknown as { rowKey: string; value: string };
            result[e.rowKey] = e.value;
        }
    } catch (error) {
        logger.error('Erro ao listar config', error);
    }
    return result;
}

// ============ INVESTMENT MOVEMENTS ============

export async function getInvestmentMovements(contaId?: string): Promise<InvestmentMovement[]> {
    const client = await getTableClient(INVESTMENT_MOVEMENTS_TABLE);

    if (!client) {
        const table = getInMemoryTable(INVESTMENT_MOVEMENTS_TABLE) as unknown as InvestmentMovement[];
        return contaId ? table.filter(m => m.contaId === contaId) : table;
    }

    const items: InvestmentMovement[] = [];
    try {
        const entities = client.listEntities();
        for await (const entity of entities) {
            const mov = entity as unknown as InvestmentMovement;
            if (!contaId || mov.contaId === contaId) {
                items.push(mov);
            }
        }
    } catch (error) {
        logger.error('Erro ao listar movimentos de investimento', error);
    }
    return items;
}

export async function createInvestmentMovement(movement: InvestmentMovement): Promise<void> {
    const client = await getTableClient(INVESTMENT_MOVEMENTS_TABLE);

    if (!client) {
        const table = getInMemoryTable(INVESTMENT_MOVEMENTS_TABLE);
        table.push(movement as unknown as AreaRecord);
        logger.info(`[In-Memory] Movimento investimento criado: ${movement.id}`);
        return;
    }

    await client.createEntity({
        partitionKey: movement.contaId,
        rowKey: movement.id,
        ...movement,
    });
}

export async function deleteInvestmentMovement(contaId: string, movementId: string): Promise<void> {
    const client = await getTableClient(INVESTMENT_MOVEMENTS_TABLE);

    if (!client) {
        const table = getInMemoryTable(INVESTMENT_MOVEMENTS_TABLE);
        const idx = table.findIndex(r => r.id === movementId);
        if (idx >= 0) table.splice(idx, 1);
        logger.info(`[In-Memory] Movimento investimento removido: ${movementId}`);
        return;
    }

    await client.deleteEntity(contaId, movementId);
}
