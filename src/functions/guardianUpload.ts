import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { GuardianAgents, ImportedDocument } from '../guardian/guardianAgents';
import { createGuardianAuth } from '../storage/tableClient';
import { createLogger, nowISO, generateId, safeErrorMessage } from '../shared/utils';
import { toGuardianAuth } from '../shared/types';
import { requireAuth } from '../shared/auth';

const logger = createLogger('GuardianUpload');

interface UploadBody {
    filename: string;
    contentBase64: string;
    type?: 'pdf' | 'xml' | 'ofx' | 'csv';
}

export async function guardianUploadHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('Upload de documento recebido...');

    // GAP #2: Authenticate
    const authResult = await requireAuth(request);
    if ('error' in authResult) return authResult.error;

    try {
        const body = await request.json() as UploadBody;

        if (!body.filename || !body.contentBase64) {
            return { status: 400, jsonBody: { error: 'Campos "filename" e "contentBase64" são obrigatórios.' } };
        }

        const ext = body.filename.split('.').pop()?.toLowerCase() || '';
        const docType = (['pdf', 'xml', 'ofx', 'csv'].includes(ext) ? ext : body.type || 'pdf') as 'pdf' | 'xml' | 'ofx' | 'csv';
        const fileSize = Math.round(body.contentBase64.length * 0.75); // approximate decoded size

        const agents = new GuardianAgents();

        const doc: ImportedDocument = {
            id: generateId('UPL'),
            name: body.filename,
            type: docType,
            source: 'manual_import',
            contentUrl: `data:application/${docType};base64,${body.contentBase64.substring(0, 100)}...`,
            size: fileSize,
            uploadedAt: nowISO(),
        };

        logger.info(`Processando upload: ${body.filename} (${docType}, ~${Math.round(fileSize / 1024)}KB)`);

        const results = await agents.extractData(doc);

        for (const res of results) {
            await agents.audit(res);
            await createGuardianAuth(toGuardianAuth(res, nowISO(), 'upload'));
        }

        return {
            status: 200,
            jsonBody: {
                success: true,
                count: results.length,
                results: results.map(r => ({
                    id: r.id,
                    classification: r.classification,
                    value: r.value,
                    confidence: r.confidence,
                    needsReview: r.needsReview,
                })),
                message: `${results.length} item(ns) extraído(s) de ${body.filename} e enviado(s) para decisão.`,
            },
        };
    } catch (error: unknown) {
        context.error('Erro no upload Guardian', error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

app.http('guardianUpload', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: guardianUploadHandler,
});
