import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { GuardianAgents, ImportedDocument } from '../guardian/guardianAgents';
import { createGuardianAuth } from '../storage/tableClient';
import { createLogger, nowISO } from '../shared/utils';

const logger = createLogger('GuardianImport');

export async function guardianImportHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    logger.info('Iniciando Importação Manual de Documento...');

    try {
        const body = await request.json() as any;
        const agents = new GuardianAgents();

        const doc: ImportedDocument = {
            id: 'IMP_' + Date.now(),
            name: body.name || 'documento_importado',
            type: body.type || 'pdf',
            source: 'manual_import',
            contentUrl: body.url,
            size: body.size || 0,
            uploadedAt: nowISO()
        };

        // 1. Extração via Agente Especializado
        const results = await agents.extractData(doc);

        // 2. Persistência na Fila de Soberania
        for (const res of results) {
            await createGuardianAuth({
                id: res.id,
                tipo: res.type,
                classificacao: res.classification,
                valor: res.value,
                confianca: res.confidence,
                status: 'pendente',
                criadoEm: nowISO(),
                sugestao: res.suggestedAction,
                origem: 'import_manual'
            });
        }

        return {
            status: 200,
            jsonBody: {
                success: true,
                count: results.length,
                message: 'Documento importado e enfileirado para decisão.'
            }
        };

    } catch (error: any) {
        logger.error('Erro na Importação Guardian', error);
        return { status: 500, jsonBody: { error: error.message } };
    }
}

app.http('guardianImport', {
    methods: ['POST'],
    authLevel: 'function',
    handler: guardianImportHandler
});
