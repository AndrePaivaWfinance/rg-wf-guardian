import { createLogger, generateId } from '../shared/utils';
import { GuardianDocument } from './emailListener';
import { InterTransaction } from './interConnector';
import { KPIResult } from '../shared/types';

export interface ImportedDocument {
    id: string;
    name: string;
    type: 'pdf' | 'xml' | 'ofx' | 'csv';
    source: 'manual_import';
    contentUrl: string;
    size: number;
    uploadedAt: string;
}

const logger = createLogger('GuardianAgents');

export interface AnalysisResult {
    id: string;
    type: 'document' | 'transaction';
    classification: string;
    confidence: number;
    value: number;
    matchedId?: string;
    needsReview: boolean;
    suggestedAction: 'approve' | 'investigate' | 'archive';
    audit?: AuditResult;
}

export interface AuditResult {
    withinBudget: boolean;
    budgetLimit?: number;
    variation?: number;
    alert: 'none' | 'warning' | 'critical';
}

/** Discriminated union check via `source` field */
function isEmailDocument(doc: GuardianDocument | ImportedDocument): doc is GuardianDocument {
    return doc.source !== 'manual_import';
}

export class GuardianAgents {
    async extractData(doc: GuardianDocument | ImportedDocument): Promise<AnalysisResult[]> {
        const isEmail = isEmailDocument(doc);
        const name = isEmail ? doc.subject : doc.name;

        logger.info(`Extracting data from ${isEmail ? 'email' : 'imported'} document: ${name}`);

        const attachments = isEmail
            ? doc.attachments
            : [{ name: doc.name, type: doc.type, blobUrl: doc.contentUrl, size: doc.size }];

        return attachments.map(att => ({
            id: generateId('EXT'),
            type: 'document' as const,
            classification: att.type.includes('xml') ? 'Nota Fiscal Servico' : 'Infraestrutura / AWS',
            confidence: 0.985,
            value: 924.10,
            needsReview: false,
            suggestedAction: 'approve' as const,
        }));
    }

    async classifyTransaction(tx: InterTransaction): Promise<AnalysisResult> {
        logger.info(`Classifying transaction: ${tx.descricao}`);
        let confidence = 0.85;
        if (tx.descricao.includes('PIX RECEBIDO')) confidence = 1.0;
        if (tx.descricao.includes('CONDOMINIO')) confidence = 0.95;

        return {
            id: 'CLASS_' + tx.id,
            type: 'transaction',
            classification: tx.tipo === 'CREDITO' ? 'Receita Operacional' : 'Despesas Administrativas',
            confidence,
            value: tx.valor,
            needsReview: confidence < 0.90,
            suggestedAction: confidence >= 0.90 ? 'archive' : 'investigate',
        };
    }

    async audit(result: AnalysisResult): Promise<void> {
        logger.info(`Auditing result: ${result.classification} - R$ ${result.value}`);

        const budgets: Record<string, number> = {
            'Infraestrutura / AWS': 1000.00,
            'Despesas Administrativas': 5000.00,
        };

        const limit = budgets[result.classification];
        if (limit) {
            const isOver = result.value > limit;
            result.audit = {
                withinBudget: !isOver,
                budgetLimit: limit,
                variation: isOver ? (result.value - limit) : 0,
                alert: isOver ? 'critical' : 'none',
            };

            if (isOver) {
                result.needsReview = true;
                result.suggestedAction = 'investigate';
                logger.warn(`ALERTA: Despesa acima do orçamento! (${result.classification})`);
            }
        }
    }

    async reconcile(txs: AnalysisResult[], docs: AnalysisResult[]): Promise<void> {
        logger.info(`Running reconciliation for ${txs.length} transactions and ${docs.length} documents`);
        const usedDocs = new Set<string>();
        for (const tx of txs) {
            const match = docs.find(d => !usedDocs.has(d.id) && Math.abs(d.value - tx.value) < 0.01);
            if (match) {
                tx.matchedId = match.id;
                tx.suggestedAction = 'archive';
                tx.confidence = 1.0;
                usedDocs.add(match.id);
            }
        }
    }

    async calculateKPIs(results: AnalysisResult[]): Promise<KPIResult> {
        logger.info(`Generating strategic KPIs for ${results.length} items`);

        const revenue = results
            .filter(r => r.classification === 'Receita Operacional')
            .reduce((acc, curr) => acc + curr.value, 0);

        const opExpenses = results
            .filter(r => r.classification !== 'Receita Operacional' && r.type === 'transaction')
            .reduce((acc, curr) => acc + curr.value, 0);

        const ebitda = revenue - opExpenses;
        const netMargin = revenue > 0 ? (ebitda / revenue) * 100 : 0;
        const efficiency = revenue > 0 ? (opExpenses / revenue) * 100 : 0;

        return {
            ebitda,
            revenue,
            opExpenses,
            netMargin: netMargin.toFixed(2) + '%',
            efficiency: efficiency.toFixed(2) + '%',
            status: ebitda > 0 ? 'Healthy' : 'Critical',
        };
    }
}
