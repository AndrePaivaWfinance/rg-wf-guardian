import * as https from 'https';
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

/** Azure AI Document Intelligence configuration */
const AI_ENDPOINT = process.env.FORM_RECOGNIZER_ENDPOINT || '';
const AI_KEY = process.env.FORM_RECOGNIZER_KEY || '';

interface FormRecognizerField {
    content?: string;
    value?: number | string;
    confidence?: number;
}

interface FormRecognizerResult {
    documents?: Array<{
        fields: Record<string, FormRecognizerField>;
        confidence: number;
    }>;
}

/** Discriminated union check via `source` field */
function isEmailDocument(doc: GuardianDocument | ImportedDocument): doc is GuardianDocument {
    return doc.source !== 'manual_import';
}

export class GuardianAgents {

    /** Returns true when Azure AI Document Intelligence is configured */
    private isAIConfigured(): boolean {
        return !!(AI_ENDPOINT && AI_KEY);
    }

    async extractData(doc: GuardianDocument | ImportedDocument): Promise<AnalysisResult[]> {
        const isEmail = isEmailDocument(doc);
        const name = isEmail ? doc.subject : doc.name;

        logger.info(`Extracting data from ${isEmail ? 'email' : 'imported'} document: ${name}`);

        const attachments = isEmail
            ? doc.attachments
            : [{ name: doc.name, type: doc.type, blobUrl: doc.contentUrl, size: doc.size }];

        if (this.isAIConfigured()) {
            return this.extractWithAI(attachments);
        }

        logger.warn('Azure AI Document Intelligence não configurado — usando dados mock');
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

    /** Calls Azure AI Document Intelligence (prebuilt-invoice model) for real OCR */
    private async extractWithAI(attachments: Array<{ name: string; type: string; blobUrl: string; size: number }>): Promise<AnalysisResult[]> {
        const results: AnalysisResult[] = [];

        for (const att of attachments) {
            try {
                const analyzed = await this.analyzeDocument(att.blobUrl);

                if (analyzed.documents && analyzed.documents.length > 0) {
                    const fields = analyzed.documents[0].fields;
                    const docConfidence = analyzed.documents[0].confidence;

                    const vendorName = (fields['VendorName']?.content || fields['VendorName']?.value || '') as string;
                    const invoiceTotal = (fields['InvoiceTotal']?.value || fields['AmountDue']?.value || 0) as number;
                    const classification = this.classifyVendor(vendorName, att.name);

                    results.push({
                        id: generateId('EXT'),
                        type: 'document',
                        classification,
                        confidence: docConfidence,
                        value: invoiceTotal,
                        needsReview: docConfidence < 0.90,
                        suggestedAction: docConfidence >= 0.90 ? 'approve' : 'investigate',
                    });
                } else {
                    results.push({
                        id: generateId('EXT'),
                        type: 'document',
                        classification: 'Documento Não Classificado',
                        confidence: 0.5,
                        value: 0,
                        needsReview: true,
                        suggestedAction: 'investigate',
                    });
                }
            } catch (error) {
                logger.error(`Erro ao analisar documento ${att.name}: ${error}`);
                results.push({
                    id: generateId('EXT'),
                    type: 'document',
                    classification: att.type.includes('xml') ? 'Nota Fiscal Servico' : 'Infraestrutura / AWS',
                    confidence: 0.5,
                    value: 0,
                    needsReview: true,
                    suggestedAction: 'investigate',
                });
            }
        }

        return results;
    }

    /** Sends document URL to Azure AI Document Intelligence for analysis */
    private async analyzeDocument(documentUrl: string): Promise<FormRecognizerResult> {
        const endpoint = new URL(AI_ENDPOINT);
        const analyzePath = `/formrecognizer/documentModels/prebuilt-invoice:analyze?api-version=2023-07-31`;
        const body = JSON.stringify({ urlSource: documentUrl });

        // Step 1: Start analysis (returns Operation-Location header)
        const operationUrl = await new Promise<string>((resolve, reject) => {
            const req = https.request(
                {
                    hostname: endpoint.hostname,
                    path: analyzePath,
                    method: 'POST',
                    headers: {
                        'Ocp-Apim-Subscription-Key': AI_KEY,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                    },
                },
                (res) => {
                    res.on('data', () => { /* drain */ });
                    res.on('end', () => {
                        const rawLocation = res.headers['operation-location'];
                        const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
                        if (res.statusCode === 202 && location) {
                            resolve(location);
                        } else {
                            reject(new Error(`Form Recognizer start failed (${res.statusCode})`));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.write(body);
            req.end();
        });

        // Step 2: Poll for completion (max 30 seconds)
        return this.pollAnalysisResult(operationUrl);
    }

    /** Polls the operation URL until the analysis is complete */
    private async pollAnalysisResult(operationUrl: string): Promise<FormRecognizerResult> {
        const url = new URL(operationUrl);
        const maxAttempts = 15;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            await new Promise(r => setTimeout(r, 2000));

            const result = await new Promise<{ status: string; analyzeResult?: FormRecognizerResult }>((resolve, reject) => {
                const req = https.request(
                    {
                        hostname: url.hostname,
                        path: url.pathname + url.search,
                        method: 'GET',
                        headers: { 'Ocp-Apim-Subscription-Key': AI_KEY },
                    },
                    (res) => {
                        const chunks: Buffer[] = [];
                        res.on('data', (chunk: Buffer) => chunks.push(chunk));
                        res.on('end', () => {
                            const body = Buffer.concat(chunks).toString();
                            resolve(JSON.parse(body) as { status: string; analyzeResult?: FormRecognizerResult });
                        });
                    }
                );
                req.on('error', reject);
                req.end();
            });

            if (result.status === 'succeeded' && result.analyzeResult) {
                return result.analyzeResult;
            }
            if (result.status === 'failed') {
                throw new Error('Form Recognizer analysis failed');
            }
        }

        throw new Error('Form Recognizer analysis timed out');
    }

    /** Maps vendor name to a financial classification */
    private classifyVendor(vendorName: string, fileName: string): string {
        const lower = (vendorName + ' ' + fileName).toLowerCase();
        if (lower.includes('aws') || lower.includes('amazon') || lower.includes('azure') || lower.includes('google cloud')) {
            return 'Infraestrutura / AWS';
        }
        if (lower.includes('nota fiscal') || lower.includes('nf-e') || lower.includes('nfse')) {
            return 'Nota Fiscal Servico';
        }
        if (lower.includes('aluguel') || lower.includes('condominio') || lower.includes('iptu')) {
            return 'Despesas Imobiliarias';
        }
        if (lower.includes('salario') || lower.includes('folha') || lower.includes('inss') || lower.includes('fgts')) {
            return 'Folha de Pagamento';
        }
        if (lower.includes('energia') || lower.includes('telefone') || lower.includes('internet')) {
            return 'Utilidades';
        }
        return 'Despesas Administrativas';
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
