import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { getGuardianAuthorizations, getApprovedAuthorizations, getAllAuthorizations } from '../storage/tableClient';
import { safeErrorMessage } from '../shared/utils';

export async function guardianStatusHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
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

        return {
            jsonBody: {
                filter,
                count: enriched.length,
                items: enriched,
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
