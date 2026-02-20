import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { updateGuardianAuth, clearAllAuthorizations } from '../storage/tableClient';
import { createLogger, safeErrorMessage } from '../shared/utils';
import { GuardianAuthorization } from '../shared/types';

const logger = createLogger('GuardianApprove');

interface ApproveBody {
    id: string;
    action: 'approve' | 'reject' | 'reclassify' | 'clear_all';
    classificacao?: string;
    dataCompetencia?: string;
    dataVencimento?: string;
    dataPagamento?: string;
}

export async function guardianApproveHandler(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log('Processando aprovação de transação...');

    try {
        const body = await request.json() as ApproveBody;

        // ---- Clear all data ----
        if (body.action === 'clear_all') {
            const removed = await clearAllAuthorizations();
            logger.info(`Limpeza completa: ${removed} registros removidos`);
            return {
                status: 200,
                jsonBody: { success: true, action: 'clear_all', removed },
            };
        }

        if (!body.id) {
            return { status: 400, jsonBody: { error: 'Campo "id" é obrigatório.' } };
        }

        if (!['approve', 'reject', 'reclassify'].includes(body.action)) {
            return { status: 400, jsonBody: { error: 'Action inválida. Use: approve, reject, reclassify, clear_all' } };
        }

        // Build update payload — always allow optional date overrides
        const dateUpdates: Partial<GuardianAuthorization> = {};
        if (body.dataCompetencia) dateUpdates.dataCompetencia = body.dataCompetencia;
        if (body.dataVencimento) dateUpdates.dataVencimento = body.dataVencimento;
        if (body.dataPagamento) dateUpdates.dataPagamento = body.dataPagamento;

        if (body.action === 'approve') {
            await updateGuardianAuth(body.id, {
                status: 'aprovado',
                needsReview: false,
                ...dateUpdates,
            });
            logger.info(`Transação aprovada: ${body.id}`);
        } else if (body.action === 'reject') {
            await updateGuardianAuth(body.id, {
                status: 'rejeitado',
                needsReview: false,
                ...dateUpdates,
            });
            logger.info(`Transação rejeitada: ${body.id}`);
        } else if (body.action === 'reclassify') {
            if (!body.classificacao) {
                return { status: 400, jsonBody: { error: 'Campo "classificacao" é obrigatório para reclassify.' } };
            }
            await updateGuardianAuth(body.id, {
                classificacao: body.classificacao,
                status: 'aprovado',
                needsReview: false,
                confianca: 1.0,
                ...dateUpdates,
            });
            logger.info(`Transação reclassificada: ${body.id} → ${body.classificacao}`);
        }

        return {
            status: 200,
            jsonBody: { success: true, id: body.id, action: body.action },
        };
    } catch (error: unknown) {
        context.error('Erro ao aprovar transação', error);
        return { status: 500, jsonBody: { error: safeErrorMessage(error) } };
    }
}

app.http('guardianApprove', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: guardianApproveHandler,
});
