import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations } from '../storage/tableClient';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { GuardianAgents, AnalysisResult } from '../guardian/guardianAgents';
import { InterConnector } from '../guardian/interConnector';
import { GuardianAuthorization } from '../shared/types';

const logger = createLogger('GuardianReports');

/** Build DRE (Demonstração do Resultado do Exercício) from items */
function buildDRE(items: GuardianAuthorization[], kpis: { revenue: number; opExpenses: number; ebitda: number }) {
    const receita = kpis.revenue;
    const deducoes = receita * 0.0925; // PIS/COFINS/ISS simulated
    const receitaLiquida = receita - deducoes;
    const custos = items
        .filter(i => i.classificacao?.includes('Infraestrutura') || i.classificacao?.includes('Folha'))
        .reduce((s, i) => s + i.valor, 0);
    const lucroBruto = receitaLiquida - custos;
    const despesasAdmin = items
        .filter(i => i.classificacao?.startsWith('Despesa'))
        .reduce((s, i) => s + i.valor, 0);
    const despesasImob = items
        .filter(i => i.classificacao?.includes('Imobiliaria'))
        .reduce((s, i) => s + i.valor, 0);
    const utilidades = items
        .filter(i => i.classificacao?.includes('Utilidades'))
        .reduce((s, i) => s + i.valor, 0);
    const totalDespOp = despesasAdmin + despesasImob + utilidades;
    const ebitda = lucroBruto - totalDespOp;
    const deprecAmort = receita * 0.02;
    const ebit = ebitda - deprecAmort;
    const resultadoFinanceiro = receita * 0.01;
    const lucroAntesIR = ebit - resultadoFinanceiro;
    const irCSLL = Math.max(lucroAntesIR * 0.34, 0);
    const lucroLiquido = lucroAntesIR - irCSLL;

    return {
        receitaBruta: receita,
        deducoes,
        receitaLiquida,
        custosServicos: custos,
        lucroBruto,
        despesasOperacionais: {
            administrativas: despesasAdmin,
            imobiliarias: despesasImob,
            utilidades,
            total: totalDespOp,
        },
        ebitda,
        depreciacaoAmortizacao: deprecAmort,
        ebit,
        resultadoFinanceiro,
        lucroAntesIR,
        irCSLL,
        lucroLiquido,
        margemBruta: receita > 0 ? ((lucroBruto / receita) * 100).toFixed(1) + '%' : '0%',
        margemLiquida: receita > 0 ? ((lucroLiquido / receita) * 100).toFixed(1) + '%' : '0%',
        margemEbitda: receita > 0 ? ((ebitda / receita) * 100).toFixed(1) + '%' : '0%',
    };
}

/** Build DFC (Demonstração de Fluxo de Caixa) */
function buildDFC(items: GuardianAuthorization[], caixaAtual: number) {
    const recebimentos = items
        .filter(i => i.tipo === 'transaction' && i.classificacao?.startsWith('Receita'))
        .reduce((s, i) => s + i.valor, 0);
    const pagFornecedores = items
        .filter(i => i.tipo === 'document')
        .reduce((s, i) => s + i.valor, 0);
    const pagDespOp = items
        .filter(i => i.tipo === 'transaction' && i.classificacao?.startsWith('Despesa'))
        .reduce((s, i) => s + i.valor, 0);
    const caixaOperacional = recebimentos - pagFornecedores - pagDespOp;
    const investimentos = -(items
        .filter(i => i.classificacao?.includes('Infraestrutura'))
        .reduce((s, i) => s + i.valor, 0));
    const financiamento = 0;
    const variacaoLiquida = caixaOperacional + investimentos + financiamento;
    const caixaInicial = caixaAtual - variacaoLiquida;

    return {
        operacional: {
            recebimentosClientes: recebimentos,
            pagamentosFornecedores: -pagFornecedores,
            pagamentosDespesas: -pagDespOp,
            total: caixaOperacional,
        },
        investimento: {
            aquisicaoAtivos: investimentos,
            total: investimentos,
        },
        financiamento: {
            total: financiamento,
        },
        variacaoLiquida,
        caixaInicial,
        caixaFinal: caixaAtual,
    };
}

/** Generate 6-month forecast based on current trends */
function buildForecast(items: GuardianAuthorization[], caixaAtual: number) {
    const receita = items
        .filter(i => i.classificacao?.startsWith('Receita'))
        .reduce((s, i) => s + i.valor, 0);
    const despesas = items
        .filter(i => !i.classificacao?.startsWith('Receita') && i.tipo === 'transaction')
        .reduce((s, i) => s + i.valor, 0);
    const docCosts = items
        .filter(i => i.tipo === 'document')
        .reduce((s, i) => s + i.valor, 0);

    const monthlyNet = receita - despesas - docCosts;
    const growthRate = 0.03; // 3% monthly growth projection
    const months: Array<{
        month: string;
        receita: number;
        despesas: number;
        lucroLiquido: number;
        fluxoCaixa: number;
        caixaAcumulado: number;
    }> = [];

    const now = new Date();
    let caixa = caixaAtual;

    for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const label = d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
        const factor = Math.pow(1 + growthRate, i);
        const mReceita = receita * factor;
        const mDespesas = (despesas + docCosts) * (1 + (growthRate * 0.5 * i)); // despesas crescem metade
        const mLucro = mReceita - mDespesas;
        caixa += mLucro;

        months.push({
            month: label,
            receita: Math.round(mReceita * 100) / 100,
            despesas: Math.round(mDespesas * 100) / 100,
            lucroLiquido: Math.round(mLucro * 100) / 100,
            fluxoCaixa: Math.round(mLucro * 100) / 100,
            caixaAcumulado: Math.round(caixa * 100) / 100,
        });
    }

    return months;
}

/** Group transactions by category */
function buildCategorized(items: GuardianAuthorization[]) {
    const groups: Record<string, { items: Array<{ id: string; valor: number; tipo: string; origem?: string }>; total: number; count: number }> = {};
    for (const item of items) {
        const cat = item.classificacao || 'Outros';
        if (!groups[cat]) groups[cat] = { items: [], total: 0, count: 0 };
        groups[cat].items.push({ id: item.id, valor: item.valor, tipo: item.tipo, origem: item.origem });
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
        const items = await getGuardianAuthorizations();
        const agents = new GuardianAgents();
        const inter = new InterConnector();

        const analysisItems: AnalysisResult[] = items.map(i => ({
            id: i.id,
            type: i.tipo,
            classification: i.classificacao,
            confidence: i.confianca,
            value: i.valor,
            needsReview: i.needsReview ?? false,
            suggestedAction: i.sugestao,
            audit: i.audit,
        }));

        const kpis = await agents.calculateKPIs(analysisItems);

        // Try live balance; fall back to computed balance from persisted items
        let caixaAtual: number;
        try {
            const balance = await inter.getBalance();
            caixaAtual = balance.total;
        } catch (err: unknown) {
            logger.warn('Inter API indisponível — calculando saldo a partir dos dados persistidos');
            const receitas = items.filter(i => i.tipo === 'transaction' && i.valor > 0 && i.classificacao?.startsWith('Receita')).reduce((s, i) => s + i.valor, 0);
            const despesas = items.filter(i => i.tipo === 'transaction' && i.classificacao?.startsWith('Despesa')).reduce((s, i) => s + i.valor, 0);
            caixaAtual = receitas - despesas;
        }

        const automatedCount = items.filter(i => i.confianca > 0.90 && !i.needsReview).length;
        const automationRate = items.length > 0 ? ((automatedCount / items.length) * 100).toFixed(1) + '%' : '0%';

        // Build financial statements
        const dre = buildDRE(items, kpis);
        const dfc = buildDFC(items, caixaAtual);
        const forecast = buildForecast(items, caixaAtual);
        const categorized = buildCategorized(items);

        // Separate transactions
        const entradas = items
            .filter(i => i.classificacao?.startsWith('Receita'))
            .map(i => ({ id: i.id, classificacao: i.classificacao, valor: i.valor, confianca: i.confianca, tipo: i.tipo, origem: i.origem }));
        const saidas = items
            .filter(i => !i.classificacao?.startsWith('Receita'))
            .map(i => ({ id: i.id, classificacao: i.classificacao, valor: i.valor, confianca: i.confianca, tipo: i.tipo, origem: i.origem, audit: i.audit }));

        const report = {
            generatedAt: nowISO(),
            title: 'Strategic Sovereign Report - Wfinance',
            summary: {
                totalAnalizado: kpis.revenue,
                alertasControladoria: items.filter(i => i.audit?.alert === 'critical').length,
                taxaAutomacao: automationRate,
                totalEntradas: entradas.reduce((s, i) => s + i.valor, 0),
                totalSaidas: saidas.reduce((s, i) => s + i.valor, 0),
            },
            indicators: {
                ebitda: kpis.ebitda,
                margemLiquida: dre.margemLiquida,
                margemBruta: dre.margemBruta,
                margemEbitda: dre.margemEbitda,
                lucroLiquido: dre.lucroLiquido,
                indiceEficiencia: kpis.efficiency,
                saudeFinanceira: kpis.status,
                fluxoCaixa: dfc.operacional.total,
            },
            treasury: {
                caixaAtual,
                previsao30Dias: caixaAtual * 1.058,
            },
            dre,
            dfc,
            forecast,
            categorized,
            entradas,
            saidas,
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
