import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { InterConnector } from '../guardian/interConnector';
import { EmailListener } from '../guardian/emailListener';
import { GuardianAgents } from '../guardian/guardianAgents';
import { createGuardianAuth } from '../storage/tableClient';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { toGuardianAuth } from '../shared/types';

const logger = createLogger('GuardianSync');

export async function guardianSyncHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('Iniciando Sincronização Guardian...');

    const inter = new InterConnector();
    const email = new EmailListener();
    const agents = new GuardianAgents();

    try {
        // Accept custom date range via query params, default to 30-day rolling window
        const endDate = request.query.get('dataFim') || nowISO().split('T')[0];
        const startDate = request.query.get('dataInicio') || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        context.log(`Período: ${startDate} até ${endDate}`);

        const [balanceResult, txs, docs] = await Promise.allSettled([
            inter.getBalance(),
            inter.syncStatement(startDate, endDate),
            email.processIncomingEmails(),
        ]);

        const balance = balanceResult.status === 'fulfilled' ? balanceResult.value : { disponivel: 0, reservado: 0, total: 0, dataHora: nowISO() };
        if (balanceResult.status === 'rejected') logger.warn('Inter balance indisponível: ' + String(balanceResult.reason));

        const transactions = txs.status === 'fulfilled' ? txs.value : [];
        if (txs.status === 'rejected') logger.warn('Inter extrato indisponível (degraded): ' + String(txs.reason));

        const documents = docs.status === 'fulfilled' ? docs.value : [];
        if (docs.status === 'rejected') logger.warn('Graph emails indisponível (degraded): ' + String(docs.reason));

        const docResults = (await Promise.all(documents.map(d => agents.extractData(d)))).flat();
        const txResults = await Promise.all(transactions.map(t => agents.classifyTransaction(t)));

        // Build description map from original transactions
        const txDescMap = new Map<string, { descricao: string; data: string }>();
        for (const tx of transactions) {
            txDescMap.set('CLASS_' + tx.id, { descricao: tx.descricao, data: tx.data });
        }

        // Auditoria e Reconciliação
        const allResults = [...txResults, ...docResults];
        for (const res of allResults) {
            await agents.audit(res);
        }
        await agents.reconcile(txResults, docResults);

        // Persist with full data (audit + needsReview + description included)
        for (const res of allResults) {
            const txInfo = txDescMap.get(res.id);
            await createGuardianAuth(toGuardianAuth(res, nowISO(), undefined, txInfo?.descricao, txInfo?.data));
        }

        return {
            status: 200,
            jsonBody: {
                success: true,
                summary: {
                    periodo: { de: startDate, ate: endDate },
                    balance: balance.total,
                    transactions: txResults.length,
                    documents: docResults.length,
                    automated: txResults.filter(t => t.confidence > 0.90).length,
                },
            },
        };
    } catch (error: unknown) {
        context.error('Erro no Sync Guardian', error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

app.http('guardianSync', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: guardianSyncHandler,
});
