import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations } from '../storage/tableClient';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { GuardianAgents, AnalysisResult } from '../guardian/guardianAgents';
import { InterConnector } from '../guardian/interConnector';

const logger = createLogger('GuardianReports');

export async function guardianReportsHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('Gerando Relatório Consolidado (Controladoria)...');

    try {
        const items = await getGuardianAuthorizations();
        const agents = new GuardianAgents();
        const inter = new InterConnector();

        // Map stored items back to AnalysisResult shape for KPI calculation
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

        const report = {
            generatedAt: nowISO(),
            title: 'Strategic Sovereign Report - Wfinance',
            summary: {
                totalAnalizado: kpis.revenue,
                alertasControladoria: items.filter(i => i.audit?.alert === 'critical').length,
                taxaAutomacao: automationRate,
            },
            indicators: {
                ebitda: kpis.ebitda,
                margemLiquida: kpis.netMargin,
                indiceEficiencia: kpis.efficiency,
                saudeFinanceira: kpis.status,
            },
            treasury: {
                caixaAtual,
                previsao30Dias: caixaAtual * 1.058,
            },
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
