import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { CadastroType, Categoria } from '../shared/areas';
import {
    getCadastroRecords,
    createCadastroRecord,
    updateCadastroRecord,
    deleteCadastroRecord,
} from '../storage/areaTableClient';
import { invalidateCategoriasCache } from './guardianDashboard';
import { requireAuth } from '../shared/auth';

const logger = createLogger('GuardianCadastros');

const VALID_TIPOS: CadastroType[] = ['categorias', 'contas', 'clientes', 'fornecedores'];

/**
 * Plano de Contas — DRE por Margem de Contribuicao
 *
 * (+) Receita Bruta ................... RECEITA_DIRETA
 * (-) Deducoes s/ Receita ............. (impostos ~9.25%)
 * (=) Receita Liquida
 * (-) Custos e Despesas Variaveis ..... CUSTO_VARIAVEL
 * (=) MARGEM DE CONTRIBUICAO
 *     Indice MC = MC / RL
 * (-) Custos e Despesas Fixos ......... CUSTO_FIXO
 * (=) RESULTADO OPERACIONAL
 * (+) Receitas Financeiras ............ RECEITA_FINANCEIRA
 * (-) Despesas Financeiras ............ DESPESA_FINANCEIRA
 * (=) Resultado Antes IR
 * (-) IR/CSLL (~34%)
 * (=) RESULTADO LIQUIDO
 *
 * Ponto de Equilibrio = Custos Fixos / Indice MC
 */
const DEFAULT_CATEGORIAS: Omit<Categoria, 'id' | 'criadoEm'>[] = [
    // ===== RECEITA_DIRETA — Receita Bruta Operacional =====
    { nome: 'Receita de Servicos',          tipo: 'RECEITA_DIRETA',     grupo: 'Receita de Servicos',          orcamentoMensal: 0, ativa: true },
    { nome: 'Receita de Projetos',          tipo: 'RECEITA_DIRETA',     grupo: 'Receita de Servicos',          orcamentoMensal: 0, ativa: true },
    { nome: 'Receita Recorrente',           tipo: 'RECEITA_DIRETA',     grupo: 'Receita de Servicos',          orcamentoMensal: 0, ativa: true },
    { nome: 'Outras Receitas Operacionais', tipo: 'RECEITA_DIRETA',     grupo: 'Outras Receitas Operacionais', orcamentoMensal: 0, ativa: true },

    // ===== RECEITA_FINANCEIRA — Resultado Financeiro (+) =====
    { nome: 'Rendimento Investimento',      tipo: 'RECEITA_FINANCEIRA', grupo: 'Rendimentos Financeiros',      orcamentoMensal: 0, ativa: true },
    { nome: 'Juros Recebidos',              tipo: 'RECEITA_FINANCEIRA', grupo: 'Juros Ativos',                 orcamentoMensal: 0, ativa: true },
    { nome: 'Resgate Investimento',         tipo: 'RECEITA_FINANCEIRA', grupo: 'Rendimentos Financeiros',      orcamentoMensal: 0, ativa: true },

    // ===== CUSTO_VARIAVEL — Variam proporcionalmente a receita/volume =====
    { nome: 'Subcontratacao / Freelancers', tipo: 'CUSTO_VARIAVEL',     grupo: 'Subcontratacao',               orcamentoMensal: 0,    ativa: true },
    { nome: 'Infraestrutura Cloud',         tipo: 'CUSTO_VARIAVEL',     grupo: 'Infraestrutura Variavel',      orcamentoMensal: 500,  ativa: true },
    { nome: 'Infraestrutura / AWS',         tipo: 'CUSTO_VARIAVEL',     grupo: 'Infraestrutura Variavel',      orcamentoMensal: 500,  ativa: true },
    { nome: 'Marketing Digital',            tipo: 'CUSTO_VARIAVEL',     grupo: 'Marketing Performance',        orcamentoMensal: 2000, ativa: true },
    { nome: 'Comissoes de Venda',           tipo: 'CUSTO_VARIAVEL',     grupo: 'Comissoes',                    orcamentoMensal: 0,    ativa: true },
    { nome: 'Impostos Sobre Servicos',      tipo: 'CUSTO_VARIAVEL',     grupo: 'Impostos Variaveis',           orcamentoMensal: 0,    ativa: true },
    { nome: 'Fornecedores',                 tipo: 'CUSTO_VARIAVEL',     grupo: 'Insumos e Materiais',          orcamentoMensal: 2000, ativa: true },
    { nome: 'Eventos e Patrocinios',        tipo: 'CUSTO_VARIAVEL',     grupo: 'Marketing Performance',        orcamentoMensal: 500,  ativa: true },
    { nome: 'Material para Projetos',       tipo: 'CUSTO_VARIAVEL',     grupo: 'Insumos e Materiais',          orcamentoMensal: 0,    ativa: true },

    // ===== CUSTO_FIXO — Nao variam com o volume de producao =====
    { nome: 'Folha de Pagamento',           tipo: 'CUSTO_FIXO',         grupo: 'Pessoal',                      orcamentoMensal: 15000, ativa: true },
    { nome: 'Encargos Trabalhistas',        tipo: 'CUSTO_FIXO',         grupo: 'Pessoal',                      orcamentoMensal: 5000,  ativa: true },
    { nome: 'Pro-labore',                   tipo: 'CUSTO_FIXO',         grupo: 'Pessoal',                      orcamentoMensal: 0,     ativa: true },
    { nome: 'Aluguel',                      tipo: 'CUSTO_FIXO',         grupo: 'Ocupacao',                     orcamentoMensal: 3000,  ativa: true },
    { nome: 'Condominio',                   tipo: 'CUSTO_FIXO',         grupo: 'Ocupacao',                     orcamentoMensal: 800,   ativa: true },
    { nome: 'IPTU',                         tipo: 'CUSTO_FIXO',         grupo: 'Ocupacao',                     orcamentoMensal: 200,   ativa: true },
    { nome: 'Energia',                      tipo: 'CUSTO_FIXO',         grupo: 'Utilidades',                   orcamentoMensal: 400,   ativa: true },
    { nome: 'Telefone / Internet',          tipo: 'CUSTO_FIXO',         grupo: 'Utilidades',                   orcamentoMensal: 300,   ativa: true },
    { nome: 'Software ERP',                 tipo: 'CUSTO_FIXO',         grupo: 'Assinaturas e Licencas',       orcamentoMensal: 300,   ativa: true },
    { nome: 'Licencas e Ferramentas',       tipo: 'CUSTO_FIXO',         grupo: 'Assinaturas e Licencas',       orcamentoMensal: 200,   ativa: true },
    { nome: 'Contabilidade',                tipo: 'CUSTO_FIXO',         grupo: 'Servicos Terceirizados',       orcamentoMensal: 500,   ativa: true },
    { nome: 'Consultoria Juridica',         tipo: 'CUSTO_FIXO',         grupo: 'Servicos Terceirizados',       orcamentoMensal: 0,     ativa: true },
    { nome: 'Seguros',                      tipo: 'CUSTO_FIXO',         grupo: 'Administrativo',               orcamentoMensal: 300,   ativa: true },
    { nome: 'Despesas Administrativas',     tipo: 'CUSTO_FIXO',         grupo: 'Administrativo',               orcamentoMensal: 500,   ativa: true },
    { nome: 'Material de Escritorio',       tipo: 'CUSTO_FIXO',         grupo: 'Administrativo',               orcamentoMensal: 200,   ativa: true },
    { nome: 'Despesas Imobiliarias',        tipo: 'CUSTO_FIXO',         grupo: 'Ocupacao',                     orcamentoMensal: 5000,  ativa: true },
    { nome: 'Pagamentos Diversos',          tipo: 'CUSTO_FIXO',         grupo: 'Outros',                       orcamentoMensal: 1000,  ativa: true },
    { nome: 'Despesas Nao Classificadas',   tipo: 'CUSTO_FIXO',         grupo: 'Outros',                       orcamentoMensal: 0,     ativa: true },
    { nome: 'Nota Fiscal Servico',          tipo: 'CUSTO_FIXO',         grupo: 'Servicos Terceirizados',       orcamentoMensal: 0,     ativa: true },

    // ===== DESPESA_FINANCEIRA — Resultado Financeiro (-) =====
    { nome: 'Juros e Multas',               tipo: 'DESPESA_FINANCEIRA', grupo: 'Juros e Encargos',             orcamentoMensal: 0,    ativa: true },
    { nome: 'IOF',                          tipo: 'DESPESA_FINANCEIRA', grupo: 'Juros e Encargos',             orcamentoMensal: 0,    ativa: true },
    { nome: 'Tarifas Bancarias',            tipo: 'DESPESA_FINANCEIRA', grupo: 'Tarifas Bancarias',            orcamentoMensal: 100,  ativa: true },
    { nome: 'Servicos Financeiros',         tipo: 'DESPESA_FINANCEIRA', grupo: 'Tarifas Bancarias',            orcamentoMensal: 1000, ativa: true },
    { nome: 'Transferencias',               tipo: 'DESPESA_FINANCEIRA', grupo: 'Outros',                       orcamentoMensal: 0,    ativa: true },

    // ===== TRANSFERENCIA_INTERNA — Movimentacao entre contas proprias (NAO entra no DRE) =====
    { nome: 'Resgate Investimento',         tipo: 'TRANSFERENCIA_INTERNA', grupo: 'Movimentacao Interna',      orcamentoMensal: 0,    ativa: true },
    { nome: 'Aplicacao Investimento',       tipo: 'TRANSFERENCIA_INTERNA', grupo: 'Movimentacao Interna',      orcamentoMensal: 0,    ativa: true },
    { nome: 'Pagamento Fatura Cartao',      tipo: 'TRANSFERENCIA_INTERNA', grupo: 'Movimentacao Interna',      orcamentoMensal: 0,    ativa: true },
    { nome: 'Transferencia Entre Contas',   tipo: 'TRANSFERENCIA_INTERNA', grupo: 'Movimentacao Interna',      orcamentoMensal: 0,    ativa: true },
];

export async function seedCategoriasIfEmpty(): Promise<Categoria[]> {
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
    } else {
        // Ensure new default categories are added if missing
        const existingNames = new Set(categorias.map(c => c.nome));
        const missing = DEFAULT_CATEGORIAS.filter(d => !existingNames.has(d.nome));
        if (missing.length > 0) {
            logger.info(`Adicionando ${missing.length} categorias novas...`);
            const now = nowISO();
            const nextId = categorias.length + 1;
            for (let i = 0; i < missing.length; i++) {
                const cat: Categoria = {
                    id: `CAT_${String(nextId + i).padStart(3, '0')}`,
                    ...missing[i],
                    criadoEm: now,
                };
                await createCadastroRecord('categorias', cat);
            }
            categorias = await getCadastroRecords<Categoria>('categorias');
        }
    }
    return categorias;
}

// GET /api/guardianCadastros/{tipo}
export async function guardianCadastrosGetHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    // GAP #2: Authenticate
    const authResult = await requireAuth(request);
    if ('error' in authResult) return authResult.error;

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
    // GAP #2: Authenticate
    const authResult = await requireAuth(request);
    if ('error' in authResult) return authResult.error;

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

            // GAP #12: Invalidate dashboard cache on cadastro changes
            if (tipo === 'categorias') invalidateCategoriasCache();

            logger.info(`Cadastro ${tipo} ${action}: ${record.id}`);
            return { status: 200, jsonBody: { success: true, action, id: record.id } };
        }

        if (action === 'delete') {
            const recordId = body.id as string;
            if (!recordId) {
                return { status: 400, jsonBody: { error: 'Campo "id" e obrigatorio para delete.' } };
            }
            await deleteCadastroRecord(tipo, recordId);

            // GAP #12: Invalidate dashboard cache on cadastro changes
            if (tipo === 'categorias') invalidateCategoriasCache();

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
