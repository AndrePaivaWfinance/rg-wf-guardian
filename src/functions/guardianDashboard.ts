import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations } from '../storage/tableClient';
import { getAreaRecords, getInvestmentMovements, getConfig } from '../storage/areaTableClient';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { GuardianAgents, AnalysisResult } from '../guardian/guardianAgents';
import { InterConnector } from '../guardian/interConnector';
import { GuardianAuthorization } from '../shared/types';
import { InvestmentAccount, InvestmentMovement } from '../shared/areas';

const logger = createLogger('GuardianDashboard');

// ---- Financial Statement Builders ----

function buildDRE(items: GuardianAuthorization[], kpis: { revenue: number; opExpenses: number; ebitda: number }) {
    const receita = kpis.revenue;
    const deducoes = receita * 0.0925;
    const receitaLiquida = receita - deducoes;
    const custos = items
        .filter(i => i.classificacao?.includes('Infraestrutura') || i.classificacao?.includes('Folha'))
        .reduce((s, i) => s + i.valor, 0);
    const lucroBruto = receitaLiquida - custos;
    const despesasAdmin = items.filter(i => i.classificacao?.startsWith('Despesa')).reduce((s, i) => s + i.valor, 0);
    const despesasImob = items.filter(i => i.classificacao?.includes('Imobiliaria')).reduce((s, i) => s + i.valor, 0);
    const utilidades = items.filter(i => i.classificacao?.includes('Utilidades')).reduce((s, i) => s + i.valor, 0);
    const totalDespOp = despesasAdmin + despesasImob + utilidades;
    const ebitda = lucroBruto - totalDespOp;
    const deprecAmort = receita * 0.02;
    const ebit = ebitda - deprecAmort;
    const resultadoFinanceiro = receita * 0.01;
    const lucroAntesIR = ebit - resultadoFinanceiro;
    const irCSLL = Math.max(lucroAntesIR * 0.34, 0);
    const lucroLiquido = lucroAntesIR - irCSLL;

    return {
        receitaBruta: receita, deducoes, receitaLiquida, custosServicos: custos, lucroBruto,
        despesasOperacionais: { administrativas: despesasAdmin, imobiliarias: despesasImob, utilidades, total: totalDespOp },
        ebitda, depreciacaoAmortizacao: deprecAmort, ebit, resultadoFinanceiro, lucroAntesIR, irCSLL, lucroLiquido,
        margemBruta: receita > 0 ? ((lucroBruto / receita) * 100).toFixed(1) + '%' : '0%',
        margemLiquida: receita > 0 ? ((lucroLiquido / receita) * 100).toFixed(1) + '%' : '0%',
        margemEbitda: receita > 0 ? ((ebitda / receita) * 100).toFixed(1) + '%' : '0%',
    };
}

function buildDFC(items: GuardianAuthorization[], caixaAtual: number, caixaInicialConfig: number | null) {
    const recebimentos = items.filter(i => i.tipo === 'transaction' && i.classificacao?.startsWith('Receita')).reduce((s, i) => s + i.valor, 0);
    const pagFornecedores = items.filter(i => i.tipo === 'document').reduce((s, i) => s + i.valor, 0);
    const pagDespOp = items.filter(i => i.tipo === 'transaction' && i.classificacao?.startsWith('Despesa')).reduce((s, i) => s + i.valor, 0);
    const caixaOperacional = recebimentos - pagFornecedores - pagDespOp;
    const investimentos = -(items.filter(i => i.classificacao?.includes('Infraestrutura')).reduce((s, i) => s + i.valor, 0));
    const variacaoLiquida = caixaOperacional + investimentos;
    const caixaInicial = caixaInicialConfig ?? (caixaAtual - variacaoLiquida);

    return {
        operacional: { recebimentosClientes: recebimentos, pagamentosFornecedores: -pagFornecedores, pagamentosDespesas: -pagDespOp, total: caixaOperacional },
        investimento: { aquisicaoAtivos: investimentos, total: investimentos },
        financiamento: { total: 0 },
        variacaoLiquida, caixaInicial, caixaFinal: caixaAtual,
    };
}

function buildForecast(items: GuardianAuthorization[], caixaAtual: number) {
    const receita = items.filter(i => i.classificacao?.startsWith('Receita')).reduce((s, i) => s + i.valor, 0);
    const despesas = items.filter(i => !i.classificacao?.startsWith('Receita') && i.tipo === 'transaction').reduce((s, i) => s + i.valor, 0);
    const docCosts = items.filter(i => i.tipo === 'document').reduce((s, i) => s + i.valor, 0);
    const growthRate = 0.03;
    const months: Array<{ month: string; receita: number; despesas: number; lucroLiquido: number; fluxoCaixa: number; caixaAcumulado: number }> = [];
    const now = new Date();
    let caixa = caixaAtual;

    for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const label = d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
        const factor = Math.pow(1 + growthRate, i);
        const mReceita = receita * factor;
        const mDespesas = (despesas + docCosts) * (1 + (growthRate * 0.5 * i));
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

function buildCategorized(items: GuardianAuthorization[]) {
    const groups: Record<string, { items: Array<{ id: string; valor: number; tipo: string; origem?: string }>; total: number; count: number }> = {};
    for (const item of items) {
        const cat = item.classificacao || 'Outros';
        if (!groups[cat]) groups[cat] = { items: [], total: 0, count: 0 };
        groups[cat].items.push({ id: item.id, valor: item.valor, tipo: item.tipo, origem: item.origem });
        groups[cat].total += item.valor;
        groups[cat].count++;
    }
    return Object.entries(groups).map(([category, data]) => ({ category, ...data })).sort((a, b) => b.total - a.total);
}

// ---- Main BFF Handler ----

export async function guardianDashboardHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('BFF: Carregando dashboard completo...');

    try {
        // Parallel fetch: items, balance, investments, config
        const [items, investAcctsRaw, investMovsRaw, ccSaldoInicialStr, ccDataRef] = await Promise.all([
            getGuardianAuthorizations(),
            getAreaRecords<InvestmentAccount>('investimentos'),
            getInvestmentMovements(),
            getConfig('CC_SALDO_INICIAL'),
            getConfig('CC_DATA_REFERENCIA'),
        ]);

        const agents = new GuardianAgents();
        const inter = new InterConnector();

        // KPIs
        const analysisItems: AnalysisResult[] = items.map(i => ({
            id: i.id, type: i.tipo, classification: i.classificacao, confidence: i.confianca,
            value: i.valor, needsReview: i.needsReview ?? false, suggestedAction: i.sugestao, audit: i.audit,
        }));
        const kpis = await agents.calculateKPIs(analysisItems);

        // Balance
        let caixaAtual: number;
        try {
            const balance = await inter.getBalance();
            caixaAtual = balance.total;
        } catch {
            logger.warn('Inter API indisponivel — calculando saldo a partir dos dados persistidos');
            const receitas = items.filter(i => i.tipo === 'transaction' && i.valor > 0 && i.classificacao?.startsWith('Receita')).reduce((s, i) => s + i.valor, 0);
            const despesas = items.filter(i => i.tipo === 'transaction' && i.classificacao?.startsWith('Despesa')).reduce((s, i) => s + i.valor, 0);
            caixaAtual = receitas - despesas;
        }

        // Investments
        let investmentAccounts = investAcctsRaw;
        const investmentMovements = investMovsRaw;
        if (investmentAccounts.length > 0) {
            for (const acct of investmentAccounts) {
                const acctMov = investmentMovements.filter(m => m.contaId === acct.id);
                let saldo = acct.saldoInicial;
                for (const m of acctMov) {
                    if (m.tipo === 'JUROS' || m.tipo === 'TRANSFERENCIA_DA_CC' || m.tipo === 'APLICACAO') saldo += m.valor;
                    else saldo -= m.valor;
                }
                acct.saldoAtual = Math.round(saldo * 100) / 100;
            }
        }

        const totalInvestimentos = investmentAccounts.filter(a => a.ativo).reduce((s, a) => s + a.saldoAtual, 0);
        const patrimonioTotal = caixaAtual + totalInvestimentos;
        const ccSaldoInicial = ccSaldoInicialStr ? parseFloat(ccSaldoInicialStr) : null;

        // Build financial statements
        const dre = buildDRE(items, kpis);
        const dfc = buildDFC(items, caixaAtual, ccSaldoInicial);
        const forecast = buildForecast(items, caixaAtual);
        const categorized = buildCategorized(items);

        const entradas = items
            .filter(i => i.classificacao?.startsWith('Receita'))
            .map(i => ({ id: i.id, classificacao: i.classificacao, valor: i.valor, confianca: i.confianca, tipo: i.tipo, origem: i.origem }));
        const saidas = items
            .filter(i => !i.classificacao?.startsWith('Receita'))
            .map(i => ({ id: i.id, classificacao: i.classificacao, valor: i.valor, confianca: i.confianca, tipo: i.tipo, origem: i.origem, audit: i.audit }));

        const automatedCount = items.filter(i => i.confianca > 0.90 && !i.needsReview).length;
        const automationRate = items.length > 0 ? ((automatedCount / items.length) * 100).toFixed(1) + '%' : '0%';

        return {
            status: 200,
            jsonBody: {
                success: true,
                timestamp: nowISO(),
                // Inbox (decision items)
                inbox: items.map(i => ({
                    id: i.id, classificacao: i.classificacao, tipo: i.tipo, valor: i.valor,
                    confianca: i.confianca, audit: i.audit, needsReview: i.needsReview, origem: i.origem, sugestao: i.sugestao,
                })),
                // Report
                report: {
                    summary: {
                        totalAnalizado: kpis.revenue,
                        alertasControladoria: items.filter(i => i.audit?.alert === 'critical').length,
                        taxaAutomacao: automationRate,
                        totalEntradas: entradas.reduce((s, i) => s + i.valor, 0),
                        totalSaidas: saidas.reduce((s, i) => s + i.valor, 0),
                    },
                    indicators: {
                        ebitda: kpis.ebitda, margemLiquida: dre.margemLiquida, margemBruta: dre.margemBruta,
                        margemEbitda: dre.margemEbitda, lucroLiquido: dre.lucroLiquido,
                        indiceEficiencia: kpis.efficiency, saudeFinanceira: kpis.status, fluxoCaixa: dfc.operacional.total,
                    },
                    treasury: {
                        caixaAtual, caixaInicial: ccSaldoInicial, dataReferencia: ccDataRef,
                        previsao30Dias: caixaAtual * 1.058,
                        investimentos: investmentAccounts.filter(a => a.ativo).map(a => ({
                            id: a.id, nome: a.nome, tipo: a.tipo, saldoAtual: a.saldoAtual, taxaContratada: a.taxaContratada,
                        })),
                        totalInvestimentos, patrimonioTotal,
                    },
                    dre, dfc, forecast, categorized, entradas, saidas,
                },
                // Investments (full detail for movements table)
                investments: {
                    accounts: investmentAccounts,
                    movements: investmentMovements,
                },
            },
        };
    } catch (error: unknown) {
        context.error('Erro no BFF Dashboard', error);
        return { status: 500, jsonBody: { success: false, error: safeErrorMessage(error) } };
    }
}

app.http('guardianDashboard', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: guardianDashboardHandler,
});
