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
    const margemBruta = receita > 0 ? (lucroBruto / receita) * 100 : 0;
    const despesasAdmin = items.filter(i => i.classificacao?.startsWith('Despesa') || i.classificacao?.includes('Pagamentos')).reduce((s, i) => s + i.valor, 0);
    const despesasImob = items.filter(i => i.classificacao?.includes('Imobiliaria')).reduce((s, i) => s + i.valor, 0);
    const utilidades = items.filter(i => i.classificacao?.includes('Utilidades')).reduce((s, i) => s + i.valor, 0);
    const servicos = items.filter(i => i.classificacao?.includes('Servicos') || i.classificacao?.includes('Contabilidade') || i.classificacao?.includes('Software')).reduce((s, i) => s + i.valor, 0);
    const fornecedores = items.filter(i => i.classificacao?.includes('Fornecedores')).reduce((s, i) => s + i.valor, 0);
    const totalDespOp = despesasAdmin + despesasImob + utilidades + servicos + fornecedores;
    const lucroOperacional = lucroBruto - totalDespOp;
    const margemOperacional = receita > 0 ? (lucroOperacional / receita) * 100 : 0;
    const deprecAmort = receita * 0.02;
    const resultadoFinanceiro = receita * 0.01;
    const lucroAntesIR = lucroOperacional - deprecAmort - resultadoFinanceiro;
    const irCSLL = Math.max(lucroAntesIR * 0.34, 0);
    const lucroLiquido = lucroAntesIR - irCSLL;
    const margemLiquida = receita > 0 ? (lucroLiquido / receita) * 100 : 0;

    return {
        receitaBruta: receita, deducoes, receitaLiquida, custosServicos: custos, lucroBruto,
        margemBrutaPct: margemBruta,
        despesasOperacionais: {
            administrativas: despesasAdmin, imobiliarias: despesasImob, utilidades, servicos, fornecedores, total: totalDespOp,
        },
        lucroOperacional,
        margemOperacionalPct: margemOperacional,
        depreciacaoAmortizacao: deprecAmort, resultadoFinanceiro, lucroAntesIR, irCSLL, lucroLiquido,
        margemLiquidaPct: margemLiquida,
        margemBruta: margemBruta.toFixed(1) + '%',
        margemOperacional: margemOperacional.toFixed(1) + '%',
        margemLiquida: margemLiquida.toFixed(1) + '%',
    };
}

function buildDFC(items: GuardianAuthorization[], caixaAtual: number, caixaInicialConfig: number | null, investmentItems: GuardianAuthorization[]) {
    // Operational
    const recebimentos = items.filter(i => i.tipo === 'transaction' && i.classificacao?.startsWith('Receita')).reduce((s, i) => s + i.valor, 0);
    const pagFornecedores = items.filter(i => i.classificacao?.includes('Fornecedores')).reduce((s, i) => s + i.valor, 0);
    const pagServicos = items.filter(i => i.classificacao?.includes('Servicos') || i.classificacao?.includes('Contabilidade') || i.classificacao?.includes('Software')).reduce((s, i) => s + i.valor, 0);
    const pagDespesas = items.filter(i =>
        i.classificacao?.includes('Pagamentos') || i.classificacao?.includes('Utilidades') ||
        i.classificacao?.includes('Imobiliaria') || i.classificacao?.includes('Folha')
    ).reduce((s, i) => s + i.valor, 0);
    const caixaOperacional = recebimentos - pagFornecedores - pagServicos - pagDespesas;

    // Investment
    const resgates = investmentItems.filter(i => i.classificacao?.includes('Resgate')).reduce((s, i) => s + i.valor, 0);
    const aplicacoes = investmentItems.filter(i => i.classificacao?.includes('Aplicacao')).reduce((s, i) => s + i.valor, 0);
    const caixaInvestimento = resgates - aplicacoes;

    // Financing
    const faturaCartao = items.filter(i => i.classificacao?.includes('Fatura Cartao')).reduce((s, i) => s + i.valor, 0);
    const caixaFinanciamento = -faturaCartao;

    const variacaoLiquida = caixaOperacional + caixaInvestimento + caixaFinanciamento;
    const caixaInicial = caixaInicialConfig ?? (caixaAtual - variacaoLiquida);

    return {
        operacional: {
            recebimentosClientes: recebimentos,
            pagamentosFornecedores: -pagFornecedores,
            pagamentosServicos: -pagServicos,
            pagamentosDespesas: -pagDespesas,
            total: caixaOperacional,
        },
        investimento: {
            resgatesInvestimentos: resgates,
            aplicacoesInvestimentos: -aplicacoes,
            total: caixaInvestimento,
        },
        financiamento: {
            faturaCartao: -faturaCartao,
            total: caixaFinanciamento,
        },
        variacaoLiquida, caixaInicial, caixaFinal: caixaAtual,
    };
}

function buildForecast(items: GuardianAuthorization[], caixaAtual: number) {
    const receita = items.filter(i => i.classificacao?.startsWith('Receita')).reduce((s, i) => s + i.valor, 0);
    const despesas = items.filter(i => !i.classificacao?.startsWith('Receita') && i.tipo === 'transaction').reduce((s, i) => s + i.valor, 0);
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

function buildCategorized(items: GuardianAuthorization[]) {
    const groups: Record<string, { total: number; count: number }> = {};
    for (const item of items) {
        const cat = item.classificacao || 'Outros';
        if (!groups[cat]) groups[cat] = { total: 0, count: 0 };
        groups[cat].total += item.valor;
        groups[cat].count++;
    }
    return Object.entries(groups).map(([category, data]) => ({ category, ...data })).sort((a, b) => b.total - a.total);
}

function buildInsights(items: GuardianAuthorization[], kpis: { revenue: number; opExpenses: number; ebitda: number }, caixaAtual: number, totalInvestimentos: number) {
    const insights: Array<{ type: 'warning' | 'success' | 'info' | 'danger'; title: string; text: string }> = [];
    const receita = kpis.revenue;
    const despesas = kpis.opExpenses;

    // Cash flow health
    if (kpis.ebitda < 0) {
        insights.push({
            type: 'danger',
            title: 'Fluxo de Caixa Negativo',
            text: `A operacao gera deficit de ${formatBRL(Math.abs(kpis.ebitda))}. Receita operacional (${formatBRL(receita)}) insuficiente para cobrir despesas (${formatBRL(despesas)}). Considere revisar custos ou aumentar faturamento.`,
        });
    } else {
        insights.push({
            type: 'success',
            title: 'Operacao Superavitaria',
            text: `Resultado operacional positivo de ${formatBRL(kpis.ebitda)} com margem operacional saudavel.`,
        });
    }

    // Investment concentration
    if (totalInvestimentos > 0 && caixaAtual > 0) {
        const ratio = totalInvestimentos / (totalInvestimentos + caixaAtual);
        if (ratio > 0.95) {
            insights.push({
                type: 'info',
                title: 'Alta Concentracao em Investimentos',
                text: `${(ratio * 100).toFixed(0)}% do patrimonio esta alocado em investimentos. O caixa operacional (${formatBRL(caixaAtual)}) representa apenas ${((1 - ratio) * 100).toFixed(1)}% do total. Monitore a liquidez.`,
            });
        }
    }

    // Revenue concentration
    const receitaItems = items.filter(i => i.classificacao === 'Receita Operacional');
    if (receitaItems.length <= 2 && receita > 0) {
        insights.push({
            type: 'warning',
            title: 'Concentracao de Receita',
            text: `Apenas ${receitaItems.length} fonte(s) de receita operacional identificada(s) totalizando ${formatBRL(receita)}. Diversificacao de clientes reduz risco.`,
        });
    }

    // Card payments
    const faturaCartao = items.filter(i => i.classificacao === 'Fatura Cartao').reduce((s, i) => s + i.valor, 0);
    if (faturaCartao > receita * 2 && receita > 0) {
        insights.push({
            type: 'warning',
            title: 'Faturas de Cartao Elevadas',
            text: `Total de faturas de cartao (${formatBRL(faturaCartao)}) supera ${((faturaCartao / receita) * 100).toFixed(0)}% da receita operacional. Avalie a necessidade de controle de gastos com cartao.`,
        });
    }

    // Projection
    const mesesCaixa = despesas > 0 ? caixaAtual / (despesas / 1) : 99;
    insights.push({
        type: mesesCaixa < 3 ? 'danger' : mesesCaixa < 6 ? 'warning' : 'info',
        title: 'Projecao de Caixa',
        text: `Com o ritmo atual de despesas operacionais (${formatBRL(despesas)}/mes), o caixa disponivel sustenta aproximadamente ${mesesCaixa.toFixed(1)} mes(es) de operacao.`,
    });

    return insights;
}

function formatBRL(v: number): string {
    return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildMonthlyHistory(items: GuardianAuthorization[]) {
    const months: Record<string, { receita: number; despesas: number }> = {};
    for (const item of items) {
        const date = item.data || item.criadoEm?.split('T')[0] || '';
        if (!date) continue;
        const monthKey = date.substring(0, 7); // YYYY-MM
        if (!months[monthKey]) months[monthKey] = { receita: 0, despesas: 0 };
        if (item.classificacao?.startsWith('Receita')) {
            months[monthKey].receita += item.valor;
        } else if (item.tipo === 'transaction') {
            months[monthKey].despesas += item.valor;
        }
    }
    return Object.entries(months)
        .map(([month, data]) => ({ month, ...data, lucro: data.receita - data.despesas }))
        .sort((a, b) => a.month.localeCompare(b.month));
}

// ---- Main BFF Handler ----

export async function guardianDashboardHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('BFF: Carregando dashboard completo...');

    try {
        const [items, investAcctsRaw, investMovsRaw, ccSaldoInicialStr, ccDataRef] = await Promise.all([
            getGuardianAuthorizations(),
            getAreaRecords<InvestmentAccount>('investimentos'),
            getInvestmentMovements(),
            getConfig('CC_SALDO_INICIAL'),
            getConfig('CC_DATA_REFERENCIA'),
        ]);

        const agents = new GuardianAgents();
        const inter = new InterConnector();

        // Filter operational items (exclude investments, card payments, transfers)
        const NON_OPERATIONAL = new Set([
            'Resgate Investimento', 'Aplicacao Investimento', 'Rendimento Investimento',
            'Fatura Cartao', 'Transferencias',
        ]);
        const operationalItems = items.filter(i => !NON_OPERATIONAL.has(i.classificacao));
        const investmentTransactions = items.filter(i => NON_OPERATIONAL.has(i.classificacao));

        // KPIs
        const analysisItems: AnalysisResult[] = operationalItems.map(i => ({
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
            const receitas = items.filter(i => i.tipo === 'transaction' && i.classificacao?.startsWith('Receita')).reduce((s, i) => s + i.valor, 0);
            const despOp = operationalItems.filter(i => i.classificacao !== 'Receita Operacional' && i.tipo === 'transaction').reduce((s, i) => s + i.valor, 0);
            caixaAtual = receitas - despOp;
        }

        // Investments
        const investmentAccounts = investAcctsRaw;
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
        const dre = buildDRE(operationalItems, kpis);
        const dfc = buildDFC(operationalItems, caixaAtual, ccSaldoInicial, investmentTransactions);
        const forecast = buildForecast(operationalItems, caixaAtual);
        const categorized = buildCategorized(items);
        const insights = buildInsights(operationalItems, kpis, caixaAtual, totalInvestimentos);
        const monthlyHistory = buildMonthlyHistory(items);

        // Weekly breakdown
        const now = new Date();
        const weekStart = new Date(now);
        weekStart.setDate(now.getDate() - now.getDay()); // Sunday
        const weekStartStr = weekStart.toISOString().split('T')[0];
        const monthStartStr = now.toISOString().split('T')[0].substring(0, 7);

        const weekItems = items.filter(i => {
            const d = i.data || i.criadoEm?.split('T')[0] || '';
            return d >= weekStartStr;
        });
        const monthItems = items.filter(i => {
            const d = i.data || i.criadoEm?.split('T')[0] || '';
            return d.startsWith(monthStartStr);
        });

        // Pending approvals
        const pendingApproval = items.filter(i => i.needsReview);

        // Payables / Receivables
        const jaPago = monthItems.filter(i => i.tipo === 'transaction' && !i.classificacao?.startsWith('Receita') && !NON_OPERATIONAL.has(i.classificacao));
        const jaRecebido = monthItems.filter(i => i.classificacao?.startsWith('Receita'));

        const totalJaPago = jaPago.reduce((s, i) => s + i.valor, 0);
        const totalJaRecebido = jaRecebido.reduce((s, i) => s + i.valor, 0);

        // Cash flow needed to close month
        const diasNoMes = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const diasRestantes = diasNoMes - now.getDate();
        const despesaDiaria = totalJaPago > 0 ? totalJaPago / now.getDate() : 0;
        const fcNecessario = despesaDiaria * diasRestantes;
        const fcProjetado = caixaAtual + (totalJaRecebido > 0 ? (totalJaRecebido / now.getDate()) * diasRestantes : 0) - fcNecessario;

        const automatedCount = items.filter(i => !i.needsReview).length;
        const automationRate = items.length > 0 ? ((automatedCount / items.length) * 100).toFixed(1) + '%' : '0%';

        return {
            status: 200,
            jsonBody: {
                success: true,
                timestamp: nowISO(),

                // ---- HOME PAGE ----
                home: {
                    indicators: {
                        margemBruta: dre.margemBruta,
                        margemBrutaPct: dre.margemBrutaPct,
                        margemLiquida: dre.margemLiquida,
                        margemLiquidaPct: dre.margemLiquidaPct,
                        margemOperacional: dre.margemOperacional,
                        lucroLiquido: dre.lucroLiquido,
                        fluxoCaixa: dfc.operacional.total,
                        caixaAtual,
                        patrimonioTotal,
                        faturamentoAtual: kpis.revenue,
                        despesasOperacionais: kpis.opExpenses,
                        saudeFinanceira: kpis.status,
                    },
                    treasury: {
                        caixaAtual, caixaInicial: ccSaldoInicial, dataReferencia: ccDataRef,
                        investimentos: investmentAccounts.filter(a => a.ativo).map(a => ({
                            id: a.id, nome: a.nome, tipo: a.tipo, saldoAtual: a.saldoAtual, taxaContratada: a.taxaContratada,
                        })),
                        totalInvestimentos, patrimonioTotal,
                    },
                    insights,
                    monthlyHistory,
                    faturamentoAtual: kpis.revenue,
                    fcNecessario: Math.round(fcNecessario * 100) / 100,
                    fcProjetado: Math.round(fcProjetado * 100) / 100,
                    forecast,
                    diasRestantesMes: diasRestantes,
                },

                // ---- SEMANAL PAGE ----
                semanal: {
                    pendingApproval: pendingApproval.map(i => ({
                        id: i.id, classificacao: i.classificacao, tipo: i.tipo, valor: i.valor,
                        confianca: i.confianca, descricao: i.descricao || '', data: i.data || '',
                        sugestao: i.sugestao, audit: i.audit, origem: i.origem,
                    })),
                    weekSummary: {
                        entradas: weekItems.filter(i => i.classificacao?.startsWith('Receita')).reduce((s, i) => s + i.valor, 0),
                        saidas: weekItems.filter(i => !i.classificacao?.startsWith('Receita') && i.tipo === 'transaction').reduce((s, i) => s + i.valor, 0),
                        count: weekItems.length,
                    },
                    jaPago: jaPago.map(i => ({ id: i.id, classificacao: i.classificacao, valor: i.valor, descricao: i.descricao || '', data: i.data || '' })),
                    jaRecebido: jaRecebido.map(i => ({ id: i.id, classificacao: i.classificacao, valor: i.valor, descricao: i.descricao || '', data: i.data || '' })),
                    totalJaPago,
                    totalJaRecebido,
                    taxaAutomacao: automationRate,
                    alertas: items.filter(i => i.audit?.alert === 'critical').length,
                },

                // ---- MENSAL PAGE ----
                mensal: {
                    dre,
                    dfc,
                    categorized,
                    insights,
                    forecast,
                    monthlyHistory,
                },

                // ---- Investments (shared) ----
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
