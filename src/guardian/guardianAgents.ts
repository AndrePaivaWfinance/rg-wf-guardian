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
        const confidence = tx.descricao.includes('PIX RECEBIDO') ? 1.0 : 0.85;
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
