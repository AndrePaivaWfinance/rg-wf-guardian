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
        // Use rolling 30-day window instead of hardcoded start date
        const endDate = nowISO().split('T')[0];
        const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

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

        // Auditoria e Reconciliação
        const allResults = [...txResults, ...docResults];
        for (const res of allResults) {
            await agents.audit(res);
        }
        await agents.reconcile(txResults, docResults);

        // Persist with full data (audit + needsReview included)
        for (const res of allResults) {
            await createGuardianAuth(toGuardianAuth(res, nowISO()));
        }

        return {
            status: 200,
            jsonBody: {
                success: true,
                summary: {
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
    authLevel: 'function',
    handler: guardianSyncHandler,
});
