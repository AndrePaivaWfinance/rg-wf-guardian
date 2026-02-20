import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getConfig, setConfig, getAllConfig } from '../storage/areaTableClient';
import { safeErrorMessage } from '../shared/utils';

export async function guardianConfigGetHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    try {
        const config = await getAllConfig();
        return { status: 200, jsonBody: { success: true, config } };
    } catch (error: unknown) {
        context.error('Erro ao ler config', error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

export async function guardianConfigPostHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    try {
        const body = await request.json() as Record<string, string>;
        const entries = Object.entries(body).filter(([k]) => k !== 'action');

        if (entries.length === 0) {
            return { status: 400, jsonBody: { error: 'Envie pares chave:valor no body.' } };
        }

        for (const [key, value] of entries) {
            await setConfig(key, String(value));
        }

        context.log(`Config atualizada: ${entries.map(([k]) => k).join(', ')}`);
        return { status: 200, jsonBody: { success: true, updated: entries.map(([k]) => k) } };
    } catch (error: unknown) {
        context.error('Erro ao salvar config', error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

app.http('guardianConfigGet', {
    methods: ['GET'],
    route: 'guardianConfig',
    authLevel: 'anonymous',
    handler: guardianConfigGetHandler,
});

app.http('guardianConfigPost', {
    methods: ['POST'],
    route: 'guardianConfig',
    authLevel: 'anonymous',
    handler: guardianConfigPostHandler,
});
