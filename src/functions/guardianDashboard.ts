import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations, getApprovedAuthorizations } from '../storage/tableClient';
import { getConfig, getCadastroRecords } from '../storage/areaTableClient';
import { seedCategoriasIfEmpty } from './guardianCadastros';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { InterConnector } from '../guardian/interConnector';
import { GuardianAuthorization } from '../shared/types';
import { Categoria } from '../shared/areas';
import { requireAuth } from '../shared/auth';

const logger = createLogger('GuardianDashboard');

// In-memory cache for categories (rarely change, avoid re-querying Table Storage every request)
let cachedCategorias: Categoria[] | null = null;
let cachedCategoriasAt = 0;
// GAP #12: Reduced from 5min to 1min for faster reflection of cadastro changes
const CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute

export function invalidateCategoriasCache() { cachedCategorias = null; }

async function getCategoriasCached(): Promise<Categoria[]> {
    const now = Date.now();
    if (cachedCategorias && (now - cachedCategoriasAt) < CACHE_TTL_MS) {
        return cachedCategorias;
    }
    cachedCategorias = await seedCategoriasIfEmpty();
    cachedCategoriasAt = now;
    return cachedCategorias;
}

// Cache balance to avoid hitting Inter API on every dashboard load
let cachedBalance: number | null = null;
let cachedBalanceAt = 0;
const BALANCE_TTL_MS = 2 * 60 * 1000; // 2 minutes

// ---- Financial Statement Builders ----

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

/**
 * DRE — Margem de Contribuicao
 *
 * (+) Receita Bruta ................... RECEITA_DIRETA
 * (-) Deducoes s/ Receita ............. (impostos ~9.25%)
 * (=) Receita Liquida
 * (-) Custos e Despesas Variaveis ..... CUSTO_VARIAVEL (por grupo)
 * (=) MARGEM DE CONTRIBUICAO
 *     Indice MC = MC / RL
 * (-) Custos e Despesas Fixos ......... CUSTO_FIXO (por grupo)
 * (=) RESULTADO OPERACIONAL
 * (+) Receitas Financeiras ............ RECEITA_FINANCEIRA
 * (-) Despesas Financeiras ............ DESPESA_FINANCEIRA (por grupo)
 * (=) Resultado Antes IR
 * (-) IR/CSLL (~34%)
 * (=) RESULTADO LIQUIDO
 *
 * PE = Custos Fixos / Indice MC
 */
function buildDRE(items: GuardianAuthorization[], catMap: Map<string, { tipo: string; grupo: string }>) {
    // (+) Receita Bruta
    const receitaBruta = sumByTipo(items, catMap, 'RECEITA_DIRETA');

    // (-) Deducoes (PIS 1.65% + COFINS 7.6% = 9.25%)
    const deducoes = receitaBruta * 0.0925;
    const receitaLiquida = receitaBruta - deducoes;

    // (-) Custos e Despesas Variaveis
    const varGrupos = groupByGrupo(items, catMap, 'CUSTO_VARIAVEL');
    const varTotal = Object.values(varGrupos).reduce((s, v) => s + v, 0);

    // (=) Margem de Contribuicao
    const margemContribuicao = receitaLiquida - varTotal;
    const indiceMC = receitaLiquida > 0 ? margemContribuicao / receitaLiquida : 0;
    const margemContribuicaoPct = indiceMC * 100;

    // (-) Custos e Despesas Fixos
    const fixoGrupos = groupByGrupo(items, catMap, 'CUSTO_FIXO');
    const fixoTotal = Object.values(fixoGrupos).reduce((s, v) => s + v, 0);

    // (=) Resultado Operacional
    const resultadoOperacional = margemContribuicao - fixoTotal;
    const margemOperacionalPct = receitaBruta > 0 ? (resultadoOperacional / receitaBruta) * 100 : 0;

    // (+/-) Resultado Financeiro
    const receitasFinanceiras = sumByTipo(items, catMap, 'RECEITA_FINANCEIRA');
    const despFinGrupos = groupByGrupo(items, catMap, 'DESPESA_FINANCEIRA');
    const despesasFinanceiras = Object.values(despFinGrupos).reduce((s, v) => s + v, 0);
    const resultadoFinanceiro = receitasFinanceiras - despesasFinanceiras;

    // (=) Resultado Antes IR
    const resultadoAntesIR = resultadoOperacional + resultadoFinanceiro;

    // (-) IR/CSLL
    const irCSLL = Math.max(resultadoAntesIR * 0.34, 0);

    // (=) Resultado Liquido
    const resultadoLiquido = resultadoAntesIR - irCSLL;
    const margemLiquidaPct = receitaBruta > 0 ? (resultadoLiquido / receitaBruta) * 100 : 0;

    // Ponto de Equilibrio
    const pontoEquilibrio = indiceMC > 0 ? fixoTotal / indiceMC : 0;

    return {
        receitaBruta,
        deducoes,
        receitaLiquida,

        variaveis: { grupos: varGrupos, total: varTotal },
        margemContribuicao,
        indiceMC,
        margemContribuicaoPct,
        margemContribuicaoFmt: margemContribuicaoPct.toFixed(1) + '%',

        fixos: { grupos: fixoGrupos, total: fixoTotal },
        resultadoOperacional,
        margemOperacionalPct,
        margemOperacional: margemOperacionalPct.toFixed(1) + '%',

        resultadoFinanceiro: {
            receitasFinanceiras,
            despesasFinanceiras: { grupos: despFinGrupos, total: despesasFinanceiras },
            liquido: resultadoFinanceiro,
        },

        resultadoAntesIR,
        irCSLL,
        resultadoLiquido,
        margemLiquidaPct,
        margemLiquida: margemLiquidaPct.toFixed(1) + '%',

        // Ponto de Equilibrio
        pontoEquilibrio,

        // Compat com home indicators
        lucroLiquido: resultadoLiquido,
        margemBruta: margemContribuicaoPct.toFixed(1) + '%',
        margemBrutaPct: margemContribuicaoPct,
    };
}

function buildDFC(
    items: GuardianAuthorization[],
    caixaAtual: number,
    caixaInicialConfig: number | null,
    allItems: GuardianAuthorization[],
    catMap: Map<string, { tipo: string; grupo: string }>
) {
    // Operacional: Receita - Variaveis - Fixos
    const recebimentos = sumByTipo(items, catMap, 'RECEITA_DIRETA');
    const pagVar = sumByTipo(items, catMap, 'CUSTO_VARIAVEL');
    const pagFixo = sumByTipo(items, catMap, 'CUSTO_FIXO');
    const caixaOperacional = recebimentos - pagVar - pagFixo;

    // Financeiro: Receita Financeira - Despesa Financeira
    const recFinanceiras = sumByTipo(allItems, catMap, 'RECEITA_FINANCEIRA');
    const despFinanceiras = sumByTipo(allItems, catMap, 'DESPESA_FINANCEIRA');
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

/**
 * GAP #6: Smart forecast using moving average of historical data with 3 scenarios.
 * Uses standard deviation for optimistic/pessimistic ranges.
 */
function buildForecast(
    items: GuardianAuthorization[],
    caixaAtual: number,
    catMap: Map<string, { tipo: string; grupo: string }>,
    monthlyHist?: Array<{ month: string; receita: number; despesas: number }>
) {
    const now = new Date();
    const histReceitas: number[] = [];
    const histDespesas: number[] = [];

    if (monthlyHist && monthlyHist.length >= 2) {
        const recent = monthlyHist.slice(-6);
        for (const m of recent) {
            histReceitas.push(m.receita);
            histDespesas.push(m.despesas);
        }
    }

    // Fallback: use current period totals
    if (histReceitas.length === 0) {
        histReceitas.push(sumByTipo(items, catMap, 'RECEITA_DIRETA'));
        histDespesas.push(sumByTipo(items, catMap, 'CUSTO_VARIAVEL') + sumByTipo(items, catMap, 'CUSTO_FIXO'));
    }

    const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
    const std = (arr: number[], mean: number) => arr.length > 1
        ? Math.sqrt(arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / arr.length)
        : mean * 0.10;

    const avgR = avg(histReceitas);
    const avgD = avg(histDespesas);
    const stdR = std(histReceitas, avgR);
    const stdD = std(histDespesas, avgD);

    type FM = { month: string; receita: number; despesas: number; lucroLiquido: number; caixaAcumulado: number };

    function scenario(rMult: number, dMult: number): FM[] {
        const ms: FM[] = [];
        let caixa = caixaAtual;
        for (let i = 0; i < 6; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
            const label = d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
            const trend = 1 + (0.01 * i);
            const mR = Math.max(0, (avgR + stdR * rMult) * trend);
            const mD = Math.max(0, (avgD + stdD * dMult) * trend);
            const mL = mR - mD;
            caixa += mL;
            ms.push({
                month: label,
                receita: Math.round(mR * 100) / 100,
                despesas: Math.round(mD * 100) / 100,
                lucroLiquido: Math.round(mL * 100) / 100,
                caixaAcumulado: Math.round(caixa * 100) / 100,
            });
        }
        return ms;
    }

    return {
        realista: scenario(0, 0),
        otimista: scenario(1, -0.5),
        pessimista: scenario(-1, 0.5),
    };
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

function buildInsights(
    items: GuardianAuthorization[],
    kpis: { revenue: number; opExpenses: number; ebitda: number },
    caixaAtual: number,
    catMap: Map<string, { tipo: string; grupo: string }>
) {
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

    // Revenue concentration
    const receitaItems = items.filter(i => catMap.get(i.classificacao)?.tipo === 'RECEITA_DIRETA');
    if (receitaItems.length <= 2 && receita > 0) {
        insights.push({
            type: 'warning',
            title: 'Concentracao de Receita',
            text: `Apenas ${receitaItems.length} fonte(s) de receita operacional identificada(s) totalizando ${formatBRL(receita)}. Diversificacao de clientes reduz risco.`,
        });
    }

    // Despesas financeiras altas
    const despFin = sumByTipo(items, catMap, 'DESPESA_FINANCEIRA');
    if (despFin > receita * 0.1 && receita > 0) {
        insights.push({
            type: 'warning',
            title: 'Despesas Financeiras Elevadas',
            text: `Despesas financeiras (${formatBRL(despFin)}) representam ${((despFin / receita) * 100).toFixed(1)}% da receita. Avalie renegociacao de tarifas e reducao de juros.`,
        });
    }

    // Custos Variaveis altos — MC comprimida
    const custosVar = sumByTipo(items, catMap, 'CUSTO_VARIAVEL');
    if (custosVar > 0 && receita > 0) {
        const rl = receita * 0.9075; // receita liquida
        const mc = rl - custosVar;
        const indiceMC = mc / rl;
        if (indiceMC < 0.3) {
            insights.push({
                type: 'danger',
                title: 'Margem de Contribuicao Critica',
                text: `Indice MC de ${(indiceMC * 100).toFixed(1)}% — custos variaveis (${formatBRL(custosVar)}) consomem mais de 70% da receita liquida. Revise pricing ou reduza custos variaveis.`,
            });
        }

        // Ponto de Equilibrio
        const custosFixos = sumByTipo(items, catMap, 'CUSTO_FIXO');
        if (indiceMC > 0) {
            const pe = custosFixos / indiceMC;
            insights.push({
                type: pe > receita ? 'danger' : 'info',
                title: 'Ponto de Equilibrio',
                text: `PE mensal: ${formatBRL(pe)}. ${pe > receita ? 'ABAIXO do PE — a empresa opera com prejuizo operacional.' : 'Receita atual supera o PE em ' + formatBRL(receita - pe) + '.'}`,
            });
        }
    }

    // Projection
    const mesesCaixa = despesas > 0 ? caixaAtual / despesas : 99;
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

function buildMonthlyHistory(items: GuardianAuthorization[], catMap: Map<string, { tipo: string; grupo: string }>) {
    const months: Record<string, { receita: number; despesas: number }> = {};
    for (const item of items) {
        const date = item.dataCompetencia || item.data || item.criadoEm?.split('T')[0] || '';
        if (!date) continue;
        const monthKey = date.substring(0, 7); // YYYY-MM
        if (!months[monthKey]) months[monthKey] = { receita: 0, despesas: 0 };
        const cat = catMap.get(item.classificacao);
        if (cat?.tipo === 'RECEITA_DIRETA' || cat?.tipo === 'RECEITA_FINANCEIRA') {
            months[monthKey].receita += item.valor;
        } else if (cat?.tipo === 'CUSTO_VARIAVEL' || cat?.tipo === 'CUSTO_FIXO' || cat?.tipo === 'DESPESA_FINANCEIRA') {
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

    // GAP #2: Authenticate
    const authResult = await requireAuth(request);
    if ('error' in authResult) return authResult.error;

    try {
        // Fetch data in parallel — categorias are cached in memory
        const [approvedItems, pendingItems, ccSaldoInicialStr, ccDataRef, categorias] = await Promise.all([
            getApprovedAuthorizations(),
            getGuardianAuthorizations(),
            getConfig('CC_SALDO_INICIAL'),
            getConfig('CC_DATA_REFERENCIA'),
            getCategoriasCached(),
        ]);

        const inter = new InterConnector();

        // Build category lookup for DRE classification
        const catMap = buildCatLookup(categorias);

        // Only APPROVED items feed into DRE/DFC calculations
        const items = approvedItems;

        // Categorize items using the catMap
        const isReceita = (i: GuardianAuthorization) => {
            const cat = catMap.get(i.classificacao);
            return cat?.tipo === 'RECEITA_DIRETA' || cat?.tipo === 'RECEITA_FINANCEIRA';
        };
        const isDespesa = (i: GuardianAuthorization) => {
            const cat = catMap.get(i.classificacao);
            return cat?.tipo === 'CUSTO_VARIAVEL' || cat?.tipo === 'CUSTO_FIXO' || cat?.tipo === 'DESPESA_FINANCEIRA';
        };

        // KPIs (using catMap for proper classification) — only from approved
        const receitaDireta = sumByTipo(items, catMap, 'RECEITA_DIRETA');
        const custoVariavel = sumByTipo(items, catMap, 'CUSTO_VARIAVEL');
        const custoFixo = sumByTipo(items, catMap, 'CUSTO_FIXO');
        const kpis = {
            revenue: receitaDireta,
            opExpenses: custoVariavel + custoFixo,
            ebitda: receitaDireta - custoVariavel - custoFixo,
            status: (receitaDireta - custoVariavel - custoFixo) >= 0 ? 'saudavel' : 'atencao',
        };

        // Balance — cached for 2 min to avoid slow Inter API calls
        let caixaAtual: number;
        const now2 = Date.now();
        if (cachedBalance !== null && (now2 - cachedBalanceAt) < BALANCE_TTL_MS) {
            caixaAtual = cachedBalance;
        } else {
            try {
                const balance = await inter.getBalance();
                caixaAtual = balance.total;
                cachedBalance = caixaAtual;
                cachedBalanceAt = Date.now();
            } catch {
                logger.warn('Inter API indisponivel — usando fallback');
                const totalReceitas = items.filter(i => isReceita(i)).reduce((s, i) => s + i.valor, 0);
                const totalDespesas = items.filter(i => isDespesa(i)).reduce((s, i) => s + i.valor, 0);
                caixaAtual = cachedBalance ?? (totalReceitas - totalDespesas);
            }
        }

        const ccSaldoInicial = ccSaldoInicialStr ? parseFloat(ccSaldoInicialStr) : null;

        // Build financial statements using category map — ONLY approved items
        const dre = buildDRE(items, catMap);
        const dfc = buildDFC(items, caixaAtual, ccSaldoInicial, items, catMap);
        const monthlyHistory = buildMonthlyHistory(items, catMap);
        // GAP #6: Smart forecast with 3 scenarios based on historical moving average
        const forecast = buildForecast(items, caixaAtual, catMap, monthlyHistory);
        const categorized = buildCategorized(items);
        const insights = buildInsights(items, kpis, caixaAtual, catMap);

        // Weekly breakdown (from approved only)
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

        // Payables / Receivables (using catMap, from approved)
        const jaPago = monthItems.filter(i => {
            const cat = catMap.get(i.classificacao);
            return cat?.tipo === 'CUSTO_VARIAVEL' || cat?.tipo === 'CUSTO_FIXO' || cat?.tipo === 'DESPESA_FINANCEIRA';
        });
        const jaRecebido = monthItems.filter(i => {
            const cat = catMap.get(i.classificacao);
            return cat?.tipo === 'RECEITA_DIRETA' || cat?.tipo === 'RECEITA_FINANCEIRA';
        });

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

        // ---- Transações Encontradas (pending review) ----
        const mapTx = (i: GuardianAuthorization) => ({
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
            // GAP #8: project/campaign linking
            projetoId: i.projetoId || '',
            campanhaId: i.campanhaId || '',
            audit: i.audit,
            isTransferenciaInterna: catMap.get(i.classificacao)?.tipo === 'TRANSFERENCIA_INTERNA',
        });
        const allPending = pendingItems.map(mapTx);
        const transacoesEncontradas = allPending.filter(i => !i.isTransferenciaInterna);
        const movimentacoesInternas = allPending.filter(i => i.isTransferenciaInterna);

        // Approved internal transfers (for totals display)
        const approvedInternas = items.filter(i => catMap.get(i.classificacao)?.tipo === 'TRANSFERENCIA_INTERNA');

        return {
            status: 200,
            jsonBody: {
                success: true,
                timestamp: nowISO(),

                // ---- HOME PAGE ----
                home: {
                    indicators: {
                        margemContribuicao: dre.margemContribuicaoFmt,
                        margemContribuicaoPct: dre.margemContribuicaoPct,
                        indiceMC: dre.indiceMC,
                        margemLiquida: dre.margemLiquida,
                        margemLiquidaPct: dre.margemLiquidaPct,
                        margemOperacional: dre.margemOperacional,
                        resultadoOperacional: dre.resultadoOperacional,
                        resultadoLiquido: dre.resultadoLiquido,
                        pontoEquilibrio: dre.pontoEquilibrio,
                        // Compat
                        margemBruta: dre.margemBruta,
                        margemBrutaPct: dre.margemBrutaPct,
                        lucroLiquido: dre.lucroLiquido,
                        fluxoCaixa: dfc.operacional.total,
                        caixaAtual,
                        faturamentoAtual: kpis.revenue,
                        despesasOperacionais: kpis.opExpenses,
                        saudeFinanceira: kpis.status,
                    },
                    treasury: {
                        caixaAtual, caixaInicial: ccSaldoInicial, dataReferencia: ccDataRef,
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
                    categorias: categorias.filter(c => c.ativa).map(c => ({
                        id: c.id, nome: c.nome, tipo: c.tipo, grupo: c.grupo, orcamentoMensal: c.orcamentoMensal,
                    })),

                    // Transações encontradas pelo sync — aguardando aprovação
                    transacoesEncontradas,
                    totalPendentes: transacoesEncontradas.length,
                    totalPendentesValor: transacoesEncontradas.reduce((s, i) => s + i.valor, 0),

                    // Movimentações internas (transferências entre contas próprias — NÃO impactam DRE)
                    movimentacoesInternas,
                    totalMovInternas: movimentacoesInternas.length + approvedInternas.length,
                    totalMovInternasValor: movimentacoesInternas.reduce((s, i) => s + i.valor, 0) + approvedInternas.reduce((s, i) => s + i.valor, 0),

                    weekSummary: {
                        entradas: weekItems.filter(i => {
                            const c = catMap.get(i.classificacao);
                            return c?.tipo === 'RECEITA_DIRETA' || c?.tipo === 'RECEITA_FINANCEIRA';
                        }).reduce((s, i) => s + i.valor, 0),
                        saidas: weekItems.filter(i => {
                            const c = catMap.get(i.classificacao);
                            return c?.tipo === 'CUSTO_VARIAVEL' || c?.tipo === 'CUSTO_FIXO' || c?.tipo === 'DESPESA_FINANCEIRA';
                        }).reduce((s, i) => s + i.valor, 0),
                        count: weekItems.length,
                    },
                    jaPago: jaPago.map(i => ({
                        id: i.id, classificacao: i.classificacao, valor: i.valor,
                        descricao: i.descricao || '', data: i.data || '',
                        dataCompetencia: i.dataCompetencia || '', dataPagamento: i.dataPagamento || '',
                    })),
                    jaRecebido: jaRecebido.map(i => ({
                        id: i.id, classificacao: i.classificacao, valor: i.valor,
                        descricao: i.descricao || '', data: i.data || '',
                        dataCompetencia: i.dataCompetencia || '', dataPagamento: i.dataPagamento || '',
                    })),
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
