import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations } from '../storage/tableClient';
import { createLogger } from '../shared/utils';

const logger = createLogger('GuardianStatus');

export async function guardianStatusHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    try {
        const items = await getGuardianAuthorizations();
        return { jsonBody: { items } };
    } catch (error: any) {
        logger.error('Erro ao buscar status Guardian', error);
        return { status: 500, jsonBody: { error: error.message } };
    }
}

app.http('guardianStatus', {
    methods: ['GET'],
    authLevel: 'function',
    handler: guardianStatusHandler
});
