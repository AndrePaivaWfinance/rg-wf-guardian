import { createLogger, nowISO } from '../shared/utils';
import { GuardianDocument } from './emailListener';
import { InterTransaction } from './interConnector';

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

export class GuardianAgents {
    async extractData(doc: GuardianDocument | ImportedDocument): Promise<AnalysisResult[]> {
        const isEmail = (doc as GuardianDocument).subject !== undefined;
        const name = isEmail ? (doc as GuardianDocument).subject : (doc as ImportedDocument).name;

        logger.info(`Extracting data from ${isEmail ? 'email' : 'imported'} document: ${name}`);

        const attachments = isEmail
            ? (doc as GuardianDocument).attachments
            : [{ name: (doc as ImportedDocument).name, type: (doc as ImportedDocument).type, blobUrl: (doc as ImportedDocument).contentUrl, size: (doc as ImportedDocument).size }];

        return attachments.map(att => ({
            id: 'EXT_' + Math.random().toString(36).substring(7),
            type: 'document',
            classification: att.type.includes('xml') ? 'Nota Fiscal Servico' : 'Infraestrutura / AWS',
            confidence: 0.985,
            value: 924.10,
            needsReview: false,
            suggestedAction: 'approve'
        }));
    }

    async classifyTransaction(tx: InterTransaction): Promise<AnalysisResult> {
        logger.info(`Classifying transaction: ${tx.descricao}`);
        // Melhora a confiança para itens recorrentes ou padrão (Simulando Prompt Engineering)
        let confidence = 0.85;
        if (tx.descricao.includes('PIX RECEBIDO')) confidence = 1.0;
        if (tx.descricao.includes('CONDOMINIO')) confidence = 0.95; // Recorrente, alta confiança

        return {
            id: 'CLASS_' + tx.id,
            type: 'transaction',
            classification: tx.tipo === 'CREDITO' ? 'Receita Operacional' : 'Despesas Administrativas',
            confidence,
            value: tx.valor,
            needsReview: confidence < 0.90,
            suggestedAction: confidence >= 0.90 ? 'archive' : 'investigate'
        };
    }

    /**
     * Agent 4: Auditor (Controladoria)
     * Verifica conformidade com orçamento e regras de negócio.
     */
    async audit(result: AnalysisResult): Promise<void> {
        logger.info(`Auditing result: ${result.classification} - R$ ${result.value}`);

        // MOCK: Configuração de Orçamento por Categoria
        const budgets: Record<string, number> = {
            'Infraestrutura / AWS': 1000.00,
            'Despesas Administrativas': 5000.00
        };

        const limit = budgets[result.classification];
        if (limit) {
            const isOver = result.value > limit;
            result.audit = {
                withinBudget: !isOver,
                budgetLimit: limit,
                variation: isOver ? (result.value - limit) : 0,
                alert: isOver ? 'critical' : 'none'
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
        for (const tx of txs) {
            const match = docs.find(d => Math.abs(d.value - tx.value) < 0.01);
            if (match) {
                tx.matchedId = match.id;
                tx.suggestedAction = 'archive';
                tx.confidence = 1.0;
            }
        }
    }
}
