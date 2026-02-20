import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { GuardianAgents, ImportedDocument } from '../guardian/guardianAgents';
import { createGuardianAuth } from '../storage/tableClient';
import { createLogger, nowISO, generateId, safeErrorMessage, isValidUrl } from '../shared/utils';
import { toGuardianAuth, ImportRequestBody, VALID_DOC_TYPES, DocType } from '../shared/types';

const logger = createLogger('GuardianImport');

export async function guardianImportHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('Iniciando Importação Manual de Documento...');

    try {
        const body = await request.json() as ImportRequestBody;

        // Input validation
        if (!body.url || typeof body.url !== 'string') {
            return { status: 400, jsonBody: { error: 'Campo "url" é obrigatório.' } };
        }
        if (!isValidUrl(body.url)) {
            return { status: 400, jsonBody: { error: 'URL inválida. Use http:// ou https://.' } };
        }
        const docType: DocType = VALID_DOC_TYPES.includes(body.type as DocType) ? body.type as DocType : 'pdf';

        const agents = new GuardianAgents();

        const doc: ImportedDocument = {
            id: generateId('IMP'),
            name: body.name || 'documento_importado',
            type: docType,
            source: 'manual_import',
            contentUrl: body.url,
            size: body.size || 0,
            uploadedAt: nowISO(),
        };

        const results = await agents.extractData(doc);

        for (const res of results) {
            await createGuardianAuth(toGuardianAuth(res, nowISO(), 'import_manual'));
        }

        return {
            status: 200,
            jsonBody: {
                success: true,
                count: results.length,
                message: 'Documento importado e enfileirado para decisão.',
            },
        };
    } catch (error: unknown) {
        context.error('Erro na Importação Guardian', error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

app.http('guardianImport', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: guardianImportHandler,
});
