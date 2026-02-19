import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { InterConnector } from '../guardian/interConnector';
import { EmailListener } from '../guardian/emailListener';
import { GuardianAgents } from '../guardian/guardianAgents';
import { createGuardianAuth } from '../storage/tableClient';
import { createLogger, nowISO } from '../shared/utils';

const logger = createLogger('GuardianSync');

export async function guardianSyncHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    logger.info('Iniciando Sincronização Guardian...');

    const inter = new InterConnector();
    const email = new EmailListener();
    const agents = new GuardianAgents();

    try {
        const [balance, txs, docs] = await Promise.all([
            inter.getBalance(),
            inter.syncStatement('2026-01-01', nowISO().split('T')[0]),
            email.processIncomingEmails()
        ]);

        const docResults = (await Promise.all(docs.map(d => agents.extractData(d)))).flat();
        const txResults = await Promise.all(txs.map(t => agents.classifyTransaction(t)));

        await agents.reconcile(txResults, docResults);

        for (const res of [...txResults, ...docResults]) {
            await createGuardianAuth({
                id: res.id,
                tipo: res.type,
                classificacao: res.classification,
                valor: res.value,
                confianca: res.confidence,
                match: res.matchedId || null,
                status: 'pendente',
                criadoEm: nowISO(),
                sugestao: res.suggestedAction
            });
        }

        return {
            status: 200,
            jsonBody: {
                success: true,
                summary: {
                    transactions: txResults.length,
                    documents: docResults.length,
                    automated: txResults.filter(t => t.confidence > 0.90).length
                }
            }
        };
    } catch (error: any) {
        logger.error('Erro no Sync Guardian', error);
        return { status: 500, jsonBody: { error: error.message } };
    }
}

app.http('guardianSync', {
    methods: ['POST'],
    authLevel: 'function',
    handler: guardianSyncHandler
});
