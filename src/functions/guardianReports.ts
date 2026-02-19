import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations } from '../storage/tableClient';
import { createLogger, nowISO } from '../shared/utils';

const logger = createLogger('GuardianReports');

export async function guardianReportsHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    logger.info('Gerando Relatório Consolidado (Controladoria)...');

    try {
        const items = await getGuardianAuthorizations();

        // Simulação de Agregação de Dados para Relatório
        const totalValue = items.reduce((acc, curr) => acc + (curr.valor || 0), 0);
        const criticalAlerts = items.filter(i => i.audit?.alert === 'critical').length;

        const report = {
            generatedAt: nowISO(),
            title: 'Sovereign Financial Book - Fevereiro 2026',
            summary: {
                totalAnalizado: totalValue,
                itemsPendentes: items.length,
                alertasControladoria: criticalAlerts,
                taxaAutomacao: '92.4%'
            },
            treasury: {
                caixaAtual: 1242850.42,
                previsao30Dias: 1315400.00,
                liquidezImediata: 'Alta'
            }
        };

        return {
            status: 200,
            jsonBody: { success: true, report }
        };

    } catch (error: any) {
        logger.error('Erro ao gerar relatório', error);
        return { status: 500, jsonBody: { error: error.message } };
    }
}

app.http('guardianReports', {
    methods: ['GET'],
    authLevel: 'function',
    handler: guardianReportsHandler
});
