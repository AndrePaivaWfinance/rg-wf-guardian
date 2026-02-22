import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { InterConnector } from '../guardian/interConnector';
import { EmailListener } from '../guardian/emailListener';
import { GuardianAgents, AnalysisResult } from '../guardian/guardianAgents';
import { createGuardianAuth } from '../storage/tableClient';
import { createLogger, nowISO, safeErrorMessage } from '../shared/utils';
import { toGuardianAuth } from '../shared/types';
import { InterTransaction } from '../guardian/interConnector';
import { requireAuth } from '../shared/auth';

const logger = createLogger('GuardianSync');

/**
 * GAP #9: Process items in chunks with controlled concurrency.
 * Splits array into chunks of `chunkSize` and processes up to `concurrency` items at a time.
 */
async function processInChunks<T, R>(
    items: T[],
    processor: (item: T) => Promise<R>,
    chunkSize = 50,
    concurrency = 5
): Promise<R[]> {
    const results: R[] = [];

    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        // Process each chunk with limited concurrency
        const chunkResults: R[] = [];
        for (let j = 0; j < chunk.length; j += concurrency) {
            const batch = chunk.slice(j, j + concurrency);
            const batchResults = await Promise.all(batch.map(processor));
            chunkResults.push(...batchResults);
        }
        results.push(...chunkResults);
        if (i + chunkSize < items.length) {
            logger.info(`Processed chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(items.length / chunkSize)}`);
        }
    }

    return results;
}

export async function guardianSyncHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('Iniciando Sincronização Guardian...');

    // GAP #2: Authenticate
    const authResult = await requireAuth(request);
    if ('error' in authResult) return authResult.error;

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

        // GAP #9: Process documents and transactions in batches of 50, max 5 concurrent
        const docResults = (await processInChunks(
            documents,
            (d) => agents.extractData(d),
            50, 5
        )).flat();

        const txResults = await processInChunks(
            transactions,
            (t: InterTransaction) => agents.classifyTransaction(t),
            50, 5
        );

        // Build description map from original transactions
        const txDescMap = new Map<string, { descricao: string; data: string }>();
        for (const tx of transactions) {
            txDescMap.set('CLASS_' + tx.id, { descricao: tx.descricao, data: tx.data });
        }

        // Auditoria e Reconciliação
        const allResults = [...txResults, ...docResults];
        // GAP #9: Audit in batches too
        await processInChunks(
            allResults,
            (res: AnalysisResult) => agents.audit(res).then(() => res),
            50, 5
        );

        // GAP #3: Pass description maps for smarter reconciliation
        await agents.reconcile(txResults, docResults, txDescMap);

        // GAP #9: Persist in batches
        await processInChunks(
            allResults,
            (res: AnalysisResult) => {
                const txInfo = txDescMap.get(res.id);
                return createGuardianAuth(toGuardianAuth(res, nowISO(), undefined, txInfo?.descricao, txInfo?.data));
            },
            50, 5
        );

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
