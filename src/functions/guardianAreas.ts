import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { createLogger, nowISO, generateId, safeErrorMessage } from '../shared/utils';
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
import { getAreaRecords, createAreaRecord, updateAreaRecord, deleteAreaRecord } from '../storage/areaTableClient';

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

// ============ MOCK DATA ============

function getMockOperacoes(): OperacoesProject[] {
    return [
        { id: generateId('OP'), nome: 'BPO Financeiro - Grupo Alfa', cliente: 'Grupo Alfa', responsavel: 'Ana Silva', status: 'em_andamento', prioridade: 'alta', dataInicio: '2026-01-10', dataPrevisao: '2026-03-30', progresso: 65, horasEstimadas: 480, horasRealizadas: 312, valorContrato: 185000, tags: ['bpo', 'financeiro'] },
        { id: generateId('OP'), nome: 'Holding Familiar - Familia Souza', cliente: 'Familia Souza', responsavel: 'Carlos Mendes', status: 'em_andamento', prioridade: 'critica', dataInicio: '2026-01-05', dataPrevisao: '2026-06-30', progresso: 35, horasEstimadas: 960, horasRealizadas: 336, valorContrato: 420000, tags: ['holding', 'sucessao'] },
        { id: generateId('OP'), nome: 'Due Diligence - TechStart', cliente: 'TechStart Ltda', responsavel: 'Marina Costa', status: 'concluido', prioridade: 'alta', dataInicio: '2025-11-01', dataPrevisao: '2026-01-31', dataConclusao: '2026-01-28', progresso: 100, horasEstimadas: 320, horasRealizadas: 298, valorContrato: 95000, tags: ['due-diligence', 'm&a'] },
        { id: generateId('OP'), nome: 'Planejamento Tributario - IndCo', cliente: 'IndCo S.A.', responsavel: 'Roberto Leal', status: 'em_andamento', prioridade: 'media', dataInicio: '2026-02-01', dataPrevisao: '2026-04-15', progresso: 20, horasEstimadas: 200, horasRealizadas: 40, valorContrato: 72000, tags: ['tributario', 'planejamento'] },
        { id: generateId('OP'), nome: 'Reestruturacao Societaria - LogBR', cliente: 'LogBR Transportes', responsavel: 'Ana Silva', status: 'bloqueado', prioridade: 'alta', dataInicio: '2026-01-15', dataPrevisao: '2026-05-30', progresso: 45, horasEstimadas: 640, horasRealizadas: 288, valorContrato: 250000, tags: ['societario', 'reestruturacao'] },
        { id: generateId('OP'), nome: 'Consultoria Gestao - Padaria Pao Quente', cliente: 'Padaria Pao Quente', responsavel: 'Carlos Mendes', status: 'concluido', prioridade: 'baixa', dataInicio: '2025-10-01', dataPrevisao: '2025-12-31', dataConclusao: '2025-12-20', progresso: 100, horasEstimadas: 120, horasRealizadas: 108, valorContrato: 28000, tags: ['consultoria', 'gestao'] },
        { id: generateId('OP'), nome: 'Assessoria M&A - FoodTech + DeliverCo', cliente: 'FoodTech', responsavel: 'Marina Costa', status: 'em_andamento', prioridade: 'critica', dataInicio: '2026-02-10', dataPrevisao: '2026-08-30', progresso: 10, horasEstimadas: 800, horasRealizadas: 80, valorContrato: 350000, tags: ['m&a', 'assessoria'] },
    ];
}

function getMockMarketing(): MarketingCampaign[] {
    return [
        { id: generateId('MKT'), nome: 'Google Ads - Holding Familiar', canal: 'google_ads', status: 'ativa', orcamento: 8000, gastoAtual: 5200, dataInicio: '2026-01-15', leads: 47, conversoes: 6, impressoes: 24500, cliques: 820, cpl: 110.64, cpa: 866.67, roi: 340 },
        { id: generateId('MKT'), nome: 'LinkedIn - C-Level BPO', canal: 'linkedin', status: 'ativa', orcamento: 12000, gastoAtual: 7800, dataInicio: '2026-01-01', leads: 32, conversoes: 4, impressoes: 18200, cliques: 540, cpl: 243.75, cpa: 1950, roi: 280 },
        { id: generateId('MKT'), nome: 'Meta Ads - Awareness Wfinance', canal: 'meta_ads', status: 'ativa', orcamento: 5000, gastoAtual: 3100, dataInicio: '2026-02-01', leads: 85, conversoes: 2, impressoes: 62000, cliques: 2100, cpl: 36.47, cpa: 1550, roi: 120 },
        { id: generateId('MKT'), nome: 'Webinar Planej. Tributario', canal: 'eventos', status: 'finalizada', orcamento: 3500, gastoAtual: 3200, dataInicio: '2025-12-01', dataFim: '2025-12-15', leads: 120, conversoes: 8, impressoes: 4500, cliques: 890, cpl: 26.67, cpa: 400, roi: 520 },
        { id: generateId('MKT'), nome: 'Email Nurture - Base Existente', canal: 'email', status: 'ativa', orcamento: 1500, gastoAtual: 800, dataInicio: '2026-01-10', leads: 22, conversoes: 5, impressoes: 3200, cliques: 480, cpl: 36.36, cpa: 160, roi: 890 },
        { id: generateId('MKT'), nome: 'Programa de Indicacao', canal: 'indicacao', status: 'ativa', orcamento: 15000, gastoAtual: 6500, dataInicio: '2025-11-01', leads: 18, conversoes: 9, impressoes: 0, cliques: 0, cpl: 361.11, cpa: 722.22, roi: 620 },
    ];
}

function getMockComercial(): ComercialDeal[] {
    return [
        { id: generateId('DEAL'), empresa: 'Construtora Horizonte', contato: 'Ricardo Pimentel', servico: 'BPO Financeiro', estagio: 'negociacao', valor: 240000, recorrencia: 'mensal', probabilidade: 75, responsavel: 'Andre Paiva', dataCriacao: '2026-01-20', dataPrevisaoFechamento: '2026-03-15', origem: 'inbound' },
        { id: generateId('DEAL'), empresa: 'Farmacia Popular Rede', contato: 'Juliana Matos', servico: 'Holding Familiar', estagio: 'proposta', valor: 180000, recorrencia: 'unico', probabilidade: 50, responsavel: 'Andre Paiva', dataCriacao: '2026-02-05', dataPrevisaoFechamento: '2026-04-01', origem: 'indicacao' },
        { id: generateId('DEAL'), empresa: 'AutoParts Brasil', contato: 'Fernando Gomes', servico: 'Planejamento Tributario', estagio: 'qualificacao', valor: 85000, recorrencia: 'anual', probabilidade: 30, responsavel: 'Carlos Mendes', dataCriacao: '2026-02-10', dataPrevisaoFechamento: '2026-05-30', origem: 'outbound' },
        { id: generateId('DEAL'), empresa: 'Grupo Viver Bem', contato: 'Patricia Lima', servico: 'Assessoria M&A', estagio: 'prospeccao', valor: 450000, recorrencia: 'unico', probabilidade: 15, responsavel: 'Marina Costa', dataCriacao: '2026-02-15', dataPrevisaoFechamento: '2026-07-30', origem: 'evento' },
        { id: generateId('DEAL'), empresa: 'Logistica Express', contato: 'Marcos Tavares', servico: 'Reestruturacao Societaria', estagio: 'negociacao', valor: 320000, recorrencia: 'unico', probabilidade: 80, responsavel: 'Ana Silva', dataCriacao: '2025-12-10', dataPrevisaoFechamento: '2026-03-01', origem: 'indicacao' },
        { id: generateId('DEAL'), empresa: 'TechFood Delivery', contato: 'Bruno Almeida', servico: 'BPO Financeiro', estagio: 'fechado_ganho', valor: 156000, recorrencia: 'mensal', probabilidade: 100, responsavel: 'Andre Paiva', dataCriacao: '2025-11-01', dataPrevisaoFechamento: '2026-01-31', dataFechamento: '2026-01-25', origem: 'inbound' },
        { id: generateId('DEAL'), empresa: 'Clinica Saude Total', contato: 'Dr. Eduardo Reis', servico: 'Consultoria Gestao', estagio: 'fechado_ganho', valor: 72000, recorrencia: 'trimestral', probabilidade: 100, responsavel: 'Carlos Mendes', dataCriacao: '2025-12-15', dataPrevisaoFechamento: '2026-02-15', dataFechamento: '2026-02-10', origem: 'indicacao' },
        { id: generateId('DEAL'), empresa: 'Mercado Online BR', contato: 'Camila Torres', servico: 'Due Diligence', estagio: 'fechado_perdido', valor: 110000, recorrencia: 'unico', probabilidade: 0, responsavel: 'Marina Costa', dataCriacao: '2025-10-20', dataPrevisaoFechamento: '2026-01-15', dataFechamento: '2026-01-10', motivoPerda: 'Orcamento insuficiente do cliente', origem: 'outbound' },
    ];
}

// ============ HANDLERS ============

export async function guardianAreasGetHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    const area = request.params.area as AreaType;

    if (!VALID_AREAS.includes(area)) {
        return { status: 400, jsonBody: { error: `Area invalida. Use: ${VALID_AREAS.join(', ')}` } };
    }

    context.log(`Carregando dados da area: ${area}`);

    try {
        let response: AreaResponse;

        if (area === 'operacoes') {
            let projects = await getAreaRecords<OperacoesProject>(area);
            if (projects.length === 0) projects = getMockOperacoes();
            const data: OperacoesData = { projects, kpis: calcOperacoesKPIs(projects) };
            response = { area, generatedAt: nowISO(), data };
        } else if (area === 'marketing') {
            let campaigns = await getAreaRecords<MarketingCampaign>(area);
            if (campaigns.length === 0) campaigns = getMockMarketing();
            const data: MarketingData = { campaigns, kpis: calcMarketingKPIs(campaigns) };
            response = { area, generatedAt: nowISO(), data };
        } else {
            let deals = await getAreaRecords<ComercialDeal>(area);
            if (deals.length === 0) deals = getMockComercial();
            const data: ComercialData = { deals, kpis: calcComercialKPIs(deals) };
            response = { area, generatedAt: nowISO(), data };
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
    authLevel: 'function',
    handler: guardianAreasPostHandler,
});
