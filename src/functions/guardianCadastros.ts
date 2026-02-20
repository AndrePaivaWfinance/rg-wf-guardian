import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { CadastroType, Categoria } from '../shared/areas';
import {
    getCadastroRecords,
    createCadastroRecord,
    updateCadastroRecord,
    deleteCadastroRecord,
} from '../storage/areaTableClient';

const logger = createLogger('GuardianCadastros');

const VALID_TIPOS: CadastroType[] = ['categorias', 'contas', 'clientes', 'fornecedores'];

// Default categories seeded on first GET if table is empty
const DEFAULT_CATEGORIAS: Omit<Categoria, 'id' | 'criadoEm'>[] = [
    // Receitas
    { nome: 'Receita Operacional', tipo: 'receita', orcamentoMensal: 0, ativa: true },
    { nome: 'Receita Financeira', tipo: 'receita', orcamentoMensal: 0, ativa: true },
    { nome: 'Rendimento Investimento', tipo: 'receita', orcamentoMensal: 0, ativa: true },
    // Despesas
    { nome: 'Folha de Pagamento', tipo: 'despesa', orcamentoMensal: 15000, ativa: true },
    { nome: 'Infraestrutura Cloud', tipo: 'despesa', orcamentoMensal: 500, ativa: true },
    { nome: 'Software ERP', tipo: 'despesa', orcamentoMensal: 300, ativa: true },
    { nome: 'Marketing Digital', tipo: 'despesa', orcamentoMensal: 2000, ativa: true },
    { nome: 'Contabilidade', tipo: 'despesa', orcamentoMensal: 500, ativa: true },
    { nome: 'Fatura Cartao', tipo: 'despesa', orcamentoMensal: 3000, ativa: true },
    { nome: 'Despesas Imobiliarias', tipo: 'despesa', orcamentoMensal: 5000, ativa: true },
    { nome: 'Utilidades', tipo: 'despesa', orcamentoMensal: 1000, ativa: true },
    { nome: 'Servicos Financeiros', tipo: 'despesa', orcamentoMensal: 1000, ativa: true },
    { nome: 'Fornecedores', tipo: 'despesa', orcamentoMensal: 2000, ativa: true },
    { nome: 'Pagamentos Diversos', tipo: 'despesa', orcamentoMensal: 1000, ativa: true },
    { nome: 'Transferencias', tipo: 'despesa', orcamentoMensal: 0, ativa: true },
    { nome: 'Despesas Administrativas', tipo: 'despesa', orcamentoMensal: 500, ativa: true },
    { nome: 'Despesas Nao Classificadas', tipo: 'despesa', orcamentoMensal: 0, ativa: true },
    { nome: 'Nota Fiscal Servico', tipo: 'despesa', orcamentoMensal: 0, ativa: true },
    { nome: 'Infraestrutura / AWS', tipo: 'despesa', orcamentoMensal: 500, ativa: true },
    // Investimentos
    { nome: 'Aplicacao Investimento', tipo: 'investimento', orcamentoMensal: 0, ativa: true },
    { nome: 'Resgate Investimento', tipo: 'investimento', orcamentoMensal: 0, ativa: true },
];

async function seedCategoriasIfEmpty(): Promise<Categoria[]> {
    let categorias = await getCadastroRecords<Categoria>('categorias');
    if (categorias.length === 0) {
        logger.info('Seeding categorias padrao...');
        const now = nowISO();
        for (let i = 0; i < DEFAULT_CATEGORIAS.length; i++) {
            const cat: Categoria = {
                id: `CAT_${String(i + 1).padStart(3, '0')}`,
                ...DEFAULT_CATEGORIAS[i],
                criadoEm: now,
            };
            await createCadastroRecord('categorias', cat);
        }
        categorias = await getCadastroRecords<Categoria>('categorias');
    }
    return categorias;
}

// GET /api/guardianCadastros/{tipo}
export async function guardianCadastrosGetHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    const tipo = request.params.tipo as CadastroType;

    if (!VALID_TIPOS.includes(tipo)) {
        return { status: 400, jsonBody: { error: `Tipo invalido. Use: ${VALID_TIPOS.join(', ')}` } };
    }

    context.log(`Carregando cadastro: ${tipo}`);

    try {
        let records;
        if (tipo === 'categorias') {
            records = await seedCategoriasIfEmpty();
        } else {
            records = await getCadastroRecords(tipo);
        }

        return {
            status: 200,
            jsonBody: { success: true, tipo, count: records.length, records },
        };
    } catch (error: unknown) {
        context.error(`Erro ao carregar cadastro ${tipo}`, error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

// POST /api/guardianCadastros/{tipo}
export async function guardianCadastrosPostHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    const tipo = request.params.tipo as CadastroType;

    if (!VALID_TIPOS.includes(tipo)) {
        return { status: 400, jsonBody: { error: `Tipo invalido. Use: ${VALID_TIPOS.join(', ')}` } };
    }

    try {
        const body = await request.json() as Record<string, unknown>;
        const action = (body.action as string) || 'create';

        if (action === 'create' || action === 'update') {
            const record = body.record as Categoria;
            if (!record || !record.id) {
                return { status: 400, jsonBody: { error: 'Campo "record" com "id" e obrigatorio.' } };
            }

            if (action === 'create') {
                await createCadastroRecord(tipo, record);
            } else {
                await updateCadastroRecord(tipo, record);
            }

            logger.info(`Cadastro ${tipo} ${action}: ${record.id}`);
            return { status: 200, jsonBody: { success: true, action, id: record.id } };
        }

        if (action === 'delete') {
            const recordId = body.id as string;
            if (!recordId) {
                return { status: 400, jsonBody: { error: 'Campo "id" e obrigatorio para delete.' } };
            }
            await deleteCadastroRecord(tipo, recordId);
            logger.info(`Cadastro ${tipo} delete: ${recordId}`);
            return { status: 200, jsonBody: { success: true, action: 'delete', id: recordId } };
        }

        return { status: 400, jsonBody: { error: `Action invalida: ${action}. Use: create, update, delete` } };
    } catch (error: unknown) {
        context.error(`Erro ao modificar cadastro ${tipo}`, error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

// ============ ROUTES ============

app.http('guardianCadastrosGet', {
    methods: ['GET'],
    route: 'guardianCadastros/{tipo}',
    authLevel: 'anonymous',
    handler: guardianCadastrosGetHandler,
});

app.http('guardianCadastrosPost', {
    methods: ['POST'],
    route: 'guardianCadastros/{tipo}',
    authLevel: 'anonymous',
    handler: guardianCadastrosPostHandler,
});
