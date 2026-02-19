import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations } from '../storage/tableClient';
import { safeErrorMessage } from '../shared/utils';

export async function guardianStatusHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    try {
        const items = await getGuardianAuthorizations();
        return { jsonBody: { items } };
    } catch (error: unknown) {
        context.error('Erro ao buscar status Guardian', error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

app.http('guardianStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: guardianStatusHandler,
});
