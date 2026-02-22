import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations, getApprovedAuthorizations, getAllAuthorizations, getAuditLogs } from '../storage/tableClient';
import { safeErrorMessage } from '../shared/utils';
import { requireAuth } from '../shared/auth';

export async function guardianStatusHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    // GAP #2: Authenticate
    const authResult = await requireAuth(request);
    if ('error' in authResult) return authResult.error;

    try {
        const filter = request.query.get('status') || 'all';

        let items;
        if (filter === 'pendente') {
            items = await getGuardianAuthorizations();
        } else if (filter === 'aprovado') {
            items = await getApprovedAuthorizations();
        } else {
            items = await getAllAuthorizations();
        }

        // Enrich response with date fields
        const enriched = items.map(i => ({
            id: i.id,
            tipo: i.tipo,
            classificacao: i.classificacao,
            valor: i.valor,
            confianca: i.confianca,
            status: i.status,
            descricao: i.descricao || '',
            origem: i.origem || '',
            sugestao: i.sugestao,
            sugestaoIA: i.sugestaoIA || '',
            data: i.data || '',
            dataCompetencia: i.dataCompetencia || '',
            dataVencimento: i.dataVencimento || '',
            dataInclusao: i.dataInclusao || '',
            dataPagamento: i.dataPagamento || '',
            criadoEm: i.criadoEm,
            needsReview: i.needsReview,
            audit: i.audit,
        }));

        // GAP #1: Include audit log when querying specific authId or all
        const authId = request.query.get('authId') || undefined;
        const auditLog = authId ? await getAuditLogs(authId) : [];

        return {
            jsonBody: {
                filter,
                count: enriched.length,
                items: enriched,
                ...(authId ? { auditLog } : {}),
            },
        };
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
