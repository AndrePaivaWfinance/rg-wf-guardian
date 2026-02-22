import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import {
    AreaType,
    AreaResponse,
    OperacoesProject,
    OperacoesKPIs,
    OperacoesData,
    MarketingCampaign,
    MarketingKPIs,
    MarketingData,
    ComercialDeal,
    ComercialKPIs,
    ComercialData,
} from '../shared/areas';
import {
    getAreaRecords,
    createAreaRecord,
    updateAreaRecord,
    deleteAreaRecord,
} from '../storage/areaTableClient';
import { getApprovedAuthorizations } from '../storage/tableClient';
import { GuardianAuthorization } from '../shared/types';
import { requireAuth } from '../shared/auth';

const logger = createLogger('GuardianAreas');

const VALID_AREAS: AreaType[] = ['operacoes', 'marketing', 'comercial'];

// ============ KPI CALCULATORS ============

function calcOperacoesKPIs(projects: OperacoesProject[]): OperacoesKPIs {
    const ativos = projects.filter(p => p.status === 'em_andamento');
    const concluidos = projects.filter(p => p.status === 'concluido');
    const bloqueados = projects.filter(p => p.status === 'bloqueado');
    const total = projects.length;
    const horasEst = projects.reduce((s, p) => s + p.horasEstimadas, 0);
    const horasReal = projects.reduce((s, p) => s + p.horasRealizadas, 0);
    const valores = projects.filter(p => p.valorContrato > 0);

    return {
        projetosAtivos: ativos.length,
        projetosConcluidos: concluidos.length,
        projetosBloqueados: bloqueados.length,
        taxaEntrega: total > 0 ? ((concluidos.length / total) * 100).toFixed(1) + '%' : '0%',
        utilizacaoEquipe: horasEst > 0 ? ((horasReal / horasEst) * 100).toFixed(1) + '%' : '0%',
        horasTotais: horasEst,
        horasRealizadas: horasReal,
        slaAtingido: total > 0 ? (((concluidos.length + ativos.length) / total) * 100).toFixed(1) + '%' : '0%',
        ticketMedioContrato: valores.length > 0 ? Math.round(valores.reduce((s, p) => s + p.valorContrato, 0) / valores.length) : 0,
    };
}

/**
 * GAP #8: P&L per project — cross-references approved financial transactions
 * linked via projetoId with the project data (valorContrato, hours, etc.)
 */
interface ProjectPnL {
    projetoId: string;
    projetoNome: string;
    cliente: string;
    valorContrato: number;
    receitas: number;
    despesas: number;
    resultado: number;
    margemPct: string;
    transacoes: number;
}

function calcProjectPnL(projects: OperacoesProject[], financials: GuardianAuthorization[]): ProjectPnL[] {
    return projects.map(p => {
        const linked = financials.filter(f => f.projetoId === p.id);
        const receitas = linked
            .filter(f => f.classificacao?.includes('Receita'))
            .reduce((s, f) => s + f.valor, 0);
        const despesas = linked
            .filter(f => !f.classificacao?.includes('Receita'))
            .reduce((s, f) => s + f.valor, 0);
        const resultado = receitas - despesas;
        const base = receitas > 0 ? receitas : (p.valorContrato > 0 ? p.valorContrato : 1);
        return {
            projetoId: p.id,
            projetoNome: p.nome,
            cliente: p.cliente,
            valorContrato: p.valorContrato,
            receitas,
            despesas,
            resultado,
            margemPct: ((resultado / base) * 100).toFixed(1) + '%',
            transacoes: linked.length,
        };
    }).filter(p => p.transacoes > 0 || p.valorContrato > 0);
}

function calcMarketingKPIs(campaigns: MarketingCampaign[]): MarketingKPIs {
    const ativas = campaigns.filter(c => c.status === 'ativa');
    const totalLeads = campaigns.reduce((s, c) => s + c.leads, 0);
    const totalConversoes = campaigns.reduce((s, c) => s + c.conversoes, 0);
    const totalGasto = campaigns.reduce((s, c) => s + c.gastoAtual, 0);
    const totalReceita = campaigns.reduce((s, c) => s + (c.conversoes * (c.cpa > 0 ? c.roi * c.cpa / 100 : 0)), 0);
    const rois = campaigns.filter(c => c.roi > 0);

    return {
        campanhasAtivas: ativas.length,
        totalLeads,
        totalConversoes,
        taxaConversao: totalLeads > 0 ? ((totalConversoes / totalLeads) * 100).toFixed(1) + '%' : '0%',
        cplMedio: totalLeads > 0 ? Math.round(totalGasto / totalLeads) : 0,
        cpaMedio: totalConversoes > 0 ? Math.round(totalGasto / totalConversoes) : 0,
        roiMedio: rois.length > 0 ? (rois.reduce((s, c) => s + c.roi, 0) / rois.length).toFixed(1) + '%' : '0%',
        investimentoTotal: totalGasto,
        receitaGerada: totalReceita,
    };
}

function calcComercialKPIs(deals: ComercialDeal[]): ComercialKPIs {
    const ativos = deals.filter(d => !d.estagio.startsWith('fechado'));
    const ganhos = deals.filter(d => d.estagio === 'fechado_ganho');
    const perdidos = deals.filter(d => d.estagio === 'fechado_perdido');
    const pipelineTotal = ativos.reduce((s, d) => s + d.valor, 0);
    const pipelinePonderado = ativos.reduce((s, d) => s + (d.valor * d.probabilidade / 100), 0);
    const fechados = ganhos.length + perdidos.length;

    // Ciclo medio de venda (deals ganhos)
    const ciclos = ganhos
        .filter(d => d.dataFechamento)
        .map(d => {
            const created = new Date(d.dataCriacao).getTime();
            const closed = new Date(d.dataFechamento!).getTime();
            return Math.round((closed - created) / (1000 * 60 * 60 * 24));
        });
    const cicloMedio = ciclos.length > 0 ? Math.round(ciclos.reduce((s, c) => s + c, 0) / ciclos.length) : 0;

    // Receita fechada no mes atual
    const now = new Date();
    const mesAtual = now.getMonth();
    const anoAtual = now.getFullYear();
    const receitaMes = ganhos
        .filter(d => {
            if (!d.dataFechamento) return false;
            const dt = new Date(d.dataFechamento);
            return dt.getMonth() === mesAtual && dt.getFullYear() === anoAtual;
        })
        .reduce((s, d) => s + d.valor, 0);

    return {
        pipelineTotal,
        pipelinePonderado: Math.round(pipelinePonderado),
        dealsAtivos: ativos.length,
        dealsFechadosGanho: ganhos.length,
        dealsFechadosPerdido: perdidos.length,
        taxaConversao: fechados > 0 ? ((ganhos.length / fechados) * 100).toFixed(1) + '%' : '0%',
        ticketMedio: ganhos.length > 0 ? Math.round(ganhos.reduce((s, d) => s + d.valor, 0) / ganhos.length) : 0,
        cicloMedioVenda: cicloMedio,
        receitaFechadaMes: receitaMes,
        previsaoReceita: Math.round(pipelinePonderado * 0.6), // 60% do ponderado como previsao conservadora
    };
}

// ============ HANDLERS ============

export async function guardianAreasGetHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    // GAP #2: Authenticate
    const authResult = await requireAuth(request);
    if ('error' in authResult) return authResult.error;

    const area = request.params.area as AreaType;

    if (!VALID_AREAS.includes(area)) {
        return { status: 400, jsonBody: { error: `Area invalida. Use: ${VALID_AREAS.join(', ')}` } };
    }

    context.log(`Carregando dados da area: ${area}`);

    try {
        let response: AreaResponse;

        if (area === 'operacoes') {
            const [projects, financials] = await Promise.all([
                getAreaRecords<OperacoesProject>(area),
                getApprovedAuthorizations(),
            ]);
            const kpis = calcOperacoesKPIs(projects);
            // GAP #8: P&L per project
            const projectPnL = calcProjectPnL(projects, financials);
            const data: OperacoesData & { projectPnL?: ProjectPnL[] } = { projects, kpis, projectPnL };
            response = { area, generatedAt: nowISO(), data };
        } else if (area === 'marketing') {
            const [campaigns, financials] = await Promise.all([
                getAreaRecords<MarketingCampaign>(area),
                getApprovedAuthorizations(),
            ]);
            const kpis = calcMarketingKPIs(campaigns);
            // GAP #8: Link campaign financial data
            const campanhaFinanceiro = campaigns.map(c => {
                const linked = financials.filter(f => f.campanhaId === c.id);
                const gastoReal = linked.reduce((s, f) => s + f.valor, 0);
                return { campanhaId: c.id, nome: c.nome, gastoOrcado: c.orcamento, gastoReal, transacoes: linked.length };
            }).filter(c => c.transacoes > 0 || c.gastoOrcado > 0);
            const data: MarketingData & { campanhaFinanceiro?: typeof campanhaFinanceiro } = { campaigns, kpis, campanhaFinanceiro };
            response = { area, generatedAt: nowISO(), data };
        } else if (area === 'comercial') {
            const deals = await getAreaRecords<ComercialDeal>(area);
            const data: ComercialData = { deals, kpis: calcComercialKPIs(deals) };
            response = { area, generatedAt: nowISO(), data };
        } else {
            return { status: 400, jsonBody: { error: `Area invalida. Use: ${VALID_AREAS.join(', ')}` } };
        }

        return { status: 200, jsonBody: { success: true, ...response } };
    } catch (error: unknown) {
        context.error(`Erro ao carregar area ${area}`, error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

export async function guardianAreasPostHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    // GAP #2: Authenticate
    const authResult = await requireAuth(request);
    if ('error' in authResult) return authResult.error;

    const area = request.params.area as AreaType;

    if (!VALID_AREAS.includes(area)) {
        return { status: 400, jsonBody: { error: `Area invalida. Use: ${VALID_AREAS.join(', ')}` } };
    }

    try {
        const body = await request.json() as Record<string, unknown>;
        const action = (body.action as string) || 'create';

        if (action === 'create' || action === 'update') {
            const record = body.record as OperacoesProject | MarketingCampaign | ComercialDeal;
            if (!record || !record.id) {
                return { status: 400, jsonBody: { error: 'Campo "record" com "id" e obrigatorio.' } };
            }

            if (action === 'create') {
                await createAreaRecord(area, record);
            } else {
                await updateAreaRecord(area, record);
            }

            logger.info(`${area} ${action}: ${record.id}`);
            return { status: 200, jsonBody: { success: true, action, id: record.id } };
        }

        if (action === 'delete') {
            const recordId = body.id as string;
            if (!recordId) {
                return { status: 400, jsonBody: { error: 'Campo "id" e obrigatorio para delete.' } };
            }
            await deleteAreaRecord(area, recordId);
            logger.info(`${area} delete: ${recordId}`);
            return { status: 200, jsonBody: { success: true, action: 'delete', id: recordId } };
        }

        return { status: 400, jsonBody: { error: `Action invalida: ${action}. Use: create, update, delete` } };
    } catch (error: unknown) {
        context.error(`Erro ao modificar area ${area}`, error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

// ============ ROUTES ============

app.http('guardianAreasGet', {
    methods: ['GET'],
    route: 'guardianAreas/{area}',
    authLevel: 'anonymous',
    handler: guardianAreasGetHandler,
});

app.http('guardianAreasPost', {
    methods: ['POST'],
    route: 'guardianAreas/{area}',
    authLevel: 'anonymous',
    handler: guardianAreasPostHandler,
});
