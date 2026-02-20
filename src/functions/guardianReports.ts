import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations, getApprovedAuthorizations } from '../storage/tableClient';
import { getConfig, getCadastroRecords } from '../storage/areaTableClient';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { InterConnector } from '../guardian/interConnector';
import { GuardianAuthorization } from '../shared/types';
import { Categoria } from '../shared/areas';

const logger = createLogger('GuardianReports');

/** Build category-type lookup from active categories */
function buildCatLookup(categorias: Categoria[]): Map<string, { tipo: string; grupo: string }> {
    const map = new Map<string, { tipo: string; grupo: string }>();
    for (const c of categorias) {
        map.set(c.nome, { tipo: c.tipo, grupo: c.grupo });
    }
    return map;
}

function sumByTipo(items: GuardianAuthorization[], catMap: Map<string, { tipo: string; grupo: string }>, tipo: string): number {
    return items.filter(i => {
        const cat = catMap.get(i.classificacao);
        return cat?.tipo === tipo;
    }).reduce((s, i) => s + i.valor, 0);
}

function groupByGrupo(items: GuardianAuthorization[], catMap: Map<string, { tipo: string; grupo: string }>, tipo: string): Record<string, number> {
    const groups: Record<string, number> = {};
    for (const i of items) {
        const cat = catMap.get(i.classificacao);
        if (cat?.tipo !== tipo) continue;
        const grupo = cat.grupo;
        groups[grupo] = (groups[grupo] || 0) + i.valor;
    }
    return groups;
}

/** Build DRE using category map (same model as dashboard) */
function buildDRE(items: GuardianAuthorization[], catMap: Map<string, { tipo: string; grupo: string }>) {
    const receitaBruta = sumByTipo(items, catMap, 'RECEITA_DIRETA');
    const deducoes = receitaBruta * 0.0925;
    const receitaLiquida = receitaBruta - deducoes;

    const varGrupos = groupByGrupo(items, catMap, 'CUSTO_VARIAVEL');
    const varTotal = Object.values(varGrupos).reduce((s, v) => s + v, 0);

    const margemContribuicao = receitaLiquida - varTotal;
    const indiceMC = receitaLiquida > 0 ? margemContribuicao / receitaLiquida : 0;

    const fixoGrupos = groupByGrupo(items, catMap, 'CUSTO_FIXO');
    const fixoTotal = Object.values(fixoGrupos).reduce((s, v) => s + v, 0);

    const resultadoOperacional = margemContribuicao - fixoTotal;

    const receitasFinanceiras = sumByTipo(items, catMap, 'RECEITA_FINANCEIRA');
    const despFinGrupos = groupByGrupo(items, catMap, 'DESPESA_FINANCEIRA');
    const despesasFinanceiras = Object.values(despFinGrupos).reduce((s, v) => s + v, 0);
    const resultadoFinanceiro = receitasFinanceiras - despesasFinanceiras;

    const resultadoAntesIR = resultadoOperacional + resultadoFinanceiro;
    const irCSLL = Math.max(resultadoAntesIR * 0.34, 0);
    const resultadoLiquido = resultadoAntesIR - irCSLL;

    return {
        receitaBruta,
        deducoes,
        receitaLiquida,
        variaveis: { grupos: varGrupos, total: varTotal },
        margemContribuicao,
        indiceMC,
        fixos: { grupos: fixoGrupos, total: fixoTotal },
        resultadoOperacional,
        resultadoFinanceiro: { receitasFinanceiras, despesasFinanceiras: { grupos: despFinGrupos, total: despesasFinanceiras }, liquido: resultadoFinanceiro },
        resultadoAntesIR,
        irCSLL,
        resultadoLiquido,
        margemBruta: receitaBruta > 0 ? ((margemContribuicao / receitaBruta) * 100).toFixed(1) + '%' : '0%',
        margemLiquida: receitaBruta > 0 ? ((resultadoLiquido / receitaBruta) * 100).toFixed(1) + '%' : '0%',
        margemEbitda: receitaBruta > 0 ? ((resultadoOperacional / receitaBruta) * 100).toFixed(1) + '%' : '0%',
        lucroLiquido: resultadoLiquido,
    };
}

/** Build DFC */
function buildDFC(items: GuardianAuthorization[], caixaAtual: number, caixaInicialConfig: number | null, catMap: Map<string, { tipo: string; grupo: string }>) {
    const recebimentos = sumByTipo(items, catMap, 'RECEITA_DIRETA');
    const pagVar = sumByTipo(items, catMap, 'CUSTO_VARIAVEL');
    const pagFixo = sumByTipo(items, catMap, 'CUSTO_FIXO');
    const caixaOperacional = recebimentos - pagVar - pagFixo;

    const recFinanceiras = sumByTipo(items, catMap, 'RECEITA_FINANCEIRA');
    const despFinanceiras = sumByTipo(items, catMap, 'DESPESA_FINANCEIRA');
    const caixaFinanceiro = recFinanceiras - despFinanceiras;

    const variacaoLiquida = caixaOperacional + caixaFinanceiro;
    const caixaInicial = caixaInicialConfig ?? (caixaAtual - variacaoLiquida);

    return {
        operacional: {
            recebimentosClientes: recebimentos,
            custosVariaveis: -pagVar,
            custosFixos: -pagFixo,
            total: caixaOperacional,
        },
        financeiro: {
            receitasFinanceiras: recFinanceiras,
            despesasFinanceiras: -despFinanceiras,
            total: caixaFinanceiro,
        },
        variacaoLiquida,
        caixaInicial,
        caixaFinal: caixaAtual,
    };
}

/** Generate 6-month forecast */
function buildForecast(items: GuardianAuthorization[], caixaAtual: number, catMap: Map<string, { tipo: string; grupo: string }>) {
    const receita = sumByTipo(items, catMap, 'RECEITA_DIRETA');
    const despesas = sumByTipo(items, catMap, 'CUSTO_VARIAVEL') + sumByTipo(items, catMap, 'CUSTO_FIXO');
    const growthRate = 0.03;
    const months: Array<{ month: string; receita: number; despesas: number; lucroLiquido: number; caixaAcumulado: number }> = [];
    const now = new Date();
    let caixa = caixaAtual;

    for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const label = d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
        const factor = Math.pow(1 + growthRate, i);
        const mReceita = receita * factor;
        const mDespesas = despesas * (1 + (growthRate * 0.5 * i));
        const mLucro = mReceita - mDespesas;
        caixa += mLucro;
        months.push({
            month: label,
            receita: Math.round(mReceita * 100) / 100,
            despesas: Math.round(mDespesas * 100) / 100,
            lucroLiquido: Math.round(mLucro * 100) / 100,
            caixaAcumulado: Math.round(caixa * 100) / 100,
        });
    }
    return months;
}

/** Group transactions by category */
function buildCategorized(items: GuardianAuthorization[]) {
    const groups: Record<string, { items: Array<{ id: string; valor: number; tipo: string; descricao: string; data: string; origem?: string }>; total: number; count: number }> = {};
    for (const item of items) {
        const cat = item.classificacao || 'Outros';
        if (!groups[cat]) groups[cat] = { items: [], total: 0, count: 0 };
        groups[cat].items.push({
            id: item.id, valor: item.valor, tipo: item.tipo,
            descricao: item.descricao || '', data: item.data || '',
            origem: item.origem,
        });
        groups[cat].total += item.valor;
        groups[cat].count++;
    }
    return Object.entries(groups)
        .map(([category, data]) => ({ category, ...data }))
        .sort((a, b) => b.total - a.total);
}

export async function guardianReportsHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('Gerando Relatório Consolidado (Controladoria)...');

    try {
        // Fetch approved (for DRE) and pending (for review section) in parallel
        const [approvedItems, pendingItems, ccSaldoInicialStr, ccDataRef, categorias] = await Promise.all([
            getApprovedAuthorizations(),
            getGuardianAuthorizations(),
            getConfig('CC_SALDO_INICIAL'),
            getConfig('CC_DATA_REFERENCIA'),
            getCadastroRecords<Categoria>('categorias'),
        ]);

        const inter = new InterConnector();
        const catMap = buildCatLookup(categorias);

        // Only approved items for financial calculations
        const items = approvedItems;

        // KPIs from approved items
        const receitaDireta = sumByTipo(items, catMap, 'RECEITA_DIRETA');
        const custoVariavel = sumByTipo(items, catMap, 'CUSTO_VARIAVEL');
        const custoFixo = sumByTipo(items, catMap, 'CUSTO_FIXO');
        const kpis = {
            revenue: receitaDireta,
            opExpenses: custoVariavel + custoFixo,
            ebitda: receitaDireta - custoVariavel - custoFixo,
        };

        // Try live balance
        let caixaAtual: number;
        try {
            const balance = await inter.getBalance();
            caixaAtual = balance.total;
        } catch {
            logger.warn('Inter API indisponível — calculando saldo a partir dos dados persistidos');
            const receitas = sumByTipo(items, catMap, 'RECEITA_DIRETA') + sumByTipo(items, catMap, 'RECEITA_FINANCEIRA');
            const despesas = custoVariavel + custoFixo + sumByTipo(items, catMap, 'DESPESA_FINANCEIRA');
            caixaAtual = receitas - despesas;
        }

        const automatedCount = items.filter(i => !i.needsReview).length;
        const automationRate = items.length > 0 ? ((automatedCount / items.length) * 100).toFixed(1) + '%' : '0%';

        const ccSaldoInicial = ccSaldoInicialStr ? parseFloat(ccSaldoInicialStr) : null;

        // Build financial statements
        const dre = buildDRE(items, catMap);
        const dfc = buildDFC(items, caixaAtual, ccSaldoInicial, catMap);
        const forecast = buildForecast(items, caixaAtual, catMap);
        const categorized = buildCategorized(items);

        // Separate approved entries/exits
        const isReceita = (i: GuardianAuthorization) => {
            const cat = catMap.get(i.classificacao);
            return cat?.tipo === 'RECEITA_DIRETA' || cat?.tipo === 'RECEITA_FINANCEIRA';
        };
        const entradas = items
            .filter(i => isReceita(i))
            .map(i => ({
                id: i.id, classificacao: i.classificacao, valor: i.valor, confianca: i.confianca,
                tipo: i.tipo, origem: i.origem, descricao: i.descricao || '', data: i.data || '',
                dataCompetencia: i.dataCompetencia || '', dataPagamento: i.dataPagamento || '',
            }));
        const saidas = items
            .filter(i => !isReceita(i))
            .map(i => ({
                id: i.id, classificacao: i.classificacao, valor: i.valor, confianca: i.confianca,
                tipo: i.tipo, origem: i.origem, descricao: i.descricao || '', data: i.data || '',
                dataCompetencia: i.dataCompetencia || '', dataPagamento: i.dataPagamento || '',
                audit: i.audit,
            }));

        // ---- Transações Encontradas (pending review) ----
        const transacoesEncontradas = pendingItems.map(i => ({
            id: i.id,
            descricao: i.descricao || '',
            classificacao: i.classificacao,
            valor: i.valor,
            confianca: i.confianca,
            sugestaoIA: i.sugestaoIA || '',
            sugestao: i.sugestao,
            origem: i.origem || '',
            data: i.data || '',
            dataCompetencia: i.dataCompetencia || '',
            dataVencimento: i.dataVencimento || '',
            dataInclusao: i.dataInclusao || '',
            dataPagamento: i.dataPagamento || '',
            audit: i.audit,
        }));

        const report = {
            generatedAt: nowISO(),
            title: 'Relatório Estratégico Sovereign - Wfinance',
            summary: {
                totalAnalizado: kpis.revenue,
                alertasControladoria: items.filter(i => i.audit?.alert === 'critical').length,
                taxaAutomacao: automationRate,
                totalEntradas: entradas.reduce((s, i) => s + i.valor, 0),
                totalSaidas: saidas.reduce((s, i) => s + i.valor, 0),
                transacoesPendentes: transacoesEncontradas.length,
                valorPendente: transacoesEncontradas.reduce((s, i) => s + i.valor, 0),
            },
            indicators: {
                ebitda: kpis.ebitda,
                margemLiquida: dre.margemLiquida,
                margemBruta: dre.margemBruta,
                margemEbitda: dre.margemEbitda,
                lucroLiquido: dre.lucroLiquido,
                saudeFinanceira: kpis.ebitda >= 0 ? 'Healthy' : 'Critical',
                fluxoCaixa: dfc.operacional.total,
            },
            treasury: {
                caixaAtual,
                caixaInicial: ccSaldoInicial,
                dataReferencia: ccDataRef,
                previsao30Dias: caixaAtual + (kpis.ebitda > 0 ? kpis.ebitda : 0),
            },
            dre,
            dfc,
            forecast,
            categorized,
            entradas,
            saidas,

            // ---- SEÇÃO: Transações Encontradas ----
            transacoesEncontradas,
        };

        return {
            status: 200,
            jsonBody: { success: true, report },
        };
    } catch (error: unknown) {
        context.error('Erro ao gerar relatório', error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

app.http('guardianReports', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: guardianReportsHandler,
});
