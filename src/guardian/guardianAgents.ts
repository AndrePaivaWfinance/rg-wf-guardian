import * as https from 'https';
import { createLogger, generateId, nowISO } from '../shared/utils';
import { GuardianDocument } from './emailListener';
import { InterTransaction } from './interConnector';
import { KPIResult, LearningRule, extractLearningTokens, learningConfidence } from '../shared/types';
import { getLearningRules, upsertLearningRule } from '../storage/tableClient';

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

/** Kimi K2.5 via Azure AI (Cognitive Services) */
const KIMI_API_KEY = process.env.AZURE_KIMI_API_KEY || '';
const KIMI_ENDPOINT = process.env.AZURE_KIMI_ENDPOINT || '';
const KIMI_DEPLOYMENT = 'kimi-k2-5';
const KIMI_API_VERSION = '2024-12-01-preview';

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

    /** Cached learning rules (loaded once per sync cycle) */
    private learningRules: LearningRule[] | null = null;

    /** Loads learning rules from storage (cached for the session) */
    async loadLearningRules(): Promise<LearningRule[]> {
        if (this.learningRules === null) {
            this.learningRules = await getLearningRules();
            logger.info(`Loaded ${this.learningRules.length} learning rules`);
        }
        return this.learningRules;
    }

    /**
     * Matches a transaction description against learned rules.
     * Returns the best match (highest score) or null if no match found.
     * Score = matched tokens / rule tokens. Minimum threshold: 0.5
     */
    private matchLearningRule(descTokens: string[], rules: LearningRule[]): { classification: string; confidence: number; ruleId: string } | null {
        let bestMatch: { classification: string; confidence: number; ruleId: string; score: number } | null = null;

        for (const rule of rules) {
            if (!rule.tokens || rule.tokens.length === 0) continue;

            const matched = rule.tokens.filter(t => descTokens.includes(t));
            const score = matched.length / rule.tokens.length;

            if (score >= 0.5 && (!bestMatch || score > bestMatch.score || (score === bestMatch.score && rule.hits > 0))) {
                bestMatch = {
                    classification: rule.classificacao,
                    confidence: rule.confianca,
                    ruleId: rule.id,
                    score,
                };
            }
        }

        if (bestMatch) {
            logger.info(`Learning match: "${bestMatch.classification}" (score=${bestMatch.score.toFixed(2)}, confidence=${bestMatch.confidence.toFixed(2)}, rule=${bestMatch.ruleId})`);
        }

        return bestMatch;
    }

    /**
     * Registra aprendizado: cria ou reforça uma regra baseada na descrição e classificação.
     * Chamado quando o usuário aprova ou reclassifica uma transação.
     */
    async learn(descricao: string, classificacao: string): Promise<void> {
        const tokens = extractLearningTokens(descricao);
        // GAP #13: Minimum 2 tokens to avoid over-generalization
        if (tokens.length < 2) {
            logger.warn(`Learning skip: need >= 2 significant tokens, got ${tokens.length} in "${descricao}"`);
            return;
        }

        const rules = await this.loadLearningRules();

        // Check if a rule with the same tokens+classification already exists
        const existing = rules.find(r =>
            r.classificacao === classificacao &&
            r.tokens.length === tokens.length &&
            r.tokens.every(t => tokens.includes(t))
        );

        if (existing) {
            // Reinforce: increment hits and update confidence
            existing.hits += 1;
            existing.confianca = learningConfidence(existing.hits);
            existing.atualizadoEm = nowISO();
            await upsertLearningRule(existing);
            logger.info(`Learning reinforced: "${classificacao}" (${existing.hits} hits, confidence=${existing.confianca.toFixed(2)})`);
        } else {
            // Check if same tokens exist but with different classification → update
            const sameTokens = rules.find(r =>
                r.tokens.length === tokens.length &&
                r.tokens.every(t => tokens.includes(t))
            );

            if (sameTokens) {
                // User corrected the classification — update rule
                sameTokens.classificacao = classificacao;
                sameTokens.hits = 1;
                sameTokens.confianca = learningConfidence(1);
                sameTokens.atualizadoEm = nowISO();
                await upsertLearningRule(sameTokens);
                logger.info(`Learning corrected: tokens → "${classificacao}"`);
            } else {
                // Brand new rule
                const newRule: LearningRule = {
                    id: generateId('LRN'),
                    tokens,
                    tokensJson: JSON.stringify(tokens),
                    classificacao,
                    hits: 1,
                    confianca: learningConfidence(1),
                    descricaoOriginal: descricao,
                    criadoEm: nowISO(),
                    atualizadoEm: nowISO(),
                };
                rules.push(newRule);
                await upsertLearningRule(newRule);
                logger.info(`Learning new rule: [${tokens.join(', ')}] → "${classificacao}"`);
            }
        }
    }

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

        logger.warn('Azure AI Document Intelligence não configurado — documento pendente de OCR');
        return attachments.map(att => ({
            id: generateId('EXT'),
            type: 'document' as const,
            classification: 'Documento Pendente OCR',
            confidence: 0.0,
            value: 0,
            needsReview: true,
            suggestedAction: 'investigate' as const,
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

    /** Returns true when Kimi K2.5 is configured on Azure AI */
    private isKimiConfigured(): boolean {
        return !!(KIMI_API_KEY && KIMI_ENDPOINT);
    }

    /**
     * Calls Kimi K2.5 (Azure AI) to classify a transaction description.
     * Uses the list of available categories for structured output.
     * Returns null on error (graceful degradation).
     */
    private async classifyWithKimi(
        descricao: string,
        tipo: 'CREDITO' | 'DEBITO',
        valor: number,
        categorias: string[]
    ): Promise<{ classification: string; confidence: number } | null> {
        if (!this.isKimiConfigured()) return null;

        const systemPrompt = `Você é um classificador financeiro de transações bancárias para uma empresa de tecnologia/serviços (WFinance).
Sua tarefa é classificar a transação na categoria mais adequada.

CATEGORIAS DISPONÍVEIS:
${categorias.map(c => `- ${c}`).join('\n')}

REGRAS:
- Responda APENAS com um JSON: {"classificacao": "Nome Exato da Categoria", "confianca": 0.XX}
- A confiança deve ser entre 0.70 e 0.95
- Use EXATAMENTE o nome da categoria da lista
- Considere o tipo (CREDITO = entrada, DEBITO = saída) e o valor para contexto
- Se não tiver certeza, use confiança mais baixa`;

        const userPrompt = `Classifique esta transação:
Descrição: ${descricao}
Tipo: ${tipo}
Valor: R$ ${valor.toFixed(2)}`;

        try {
            const endpoint = new URL(KIMI_ENDPOINT);
            const apiPath = `/openai/deployments/${KIMI_DEPLOYMENT}/chat/completions?api-version=${KIMI_API_VERSION}`;

            const body = JSON.stringify({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                temperature: 0.3,
                max_tokens: 100,
            });

            const response = await new Promise<string>((resolve, reject) => {
                const req = https.request(
                    {
                        hostname: endpoint.hostname,
                        path: apiPath,
                        method: 'POST',
                        headers: {
                            'api-key': KIMI_API_KEY,
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(body),
                        },
                    },
                    (res) => {
                        const chunks: Buffer[] = [];
                        res.on('data', (chunk: Buffer) => chunks.push(chunk));
                        res.on('end', () => {
                            if (res.statusCode !== 200) {
                                const errBody = Buffer.concat(chunks).toString();
                                reject(new Error(`Kimi API error: ${res.statusCode} — ${errBody}`));
                                return;
                            }
                            resolve(Buffer.concat(chunks).toString());
                        });
                    }
                );
                req.on('error', reject);
                req.setTimeout(15000, () => { req.destroy(); reject(new Error('Kimi API timeout')); });
                req.write(body);
                req.end();
            });

            const parsed = JSON.parse(response) as {
                choices?: Array<{ message?: { content?: string } }>;
            };
            const content = parsed.choices?.[0]?.message?.content || '';

            // Extract JSON from response (Kimi may wrap in markdown)
            const jsonMatch = content.match(/\{[^}]+\}/);
            if (!jsonMatch) {
                logger.warn(`Kimi: could not parse JSON from response: ${content}`);
                return null;
            }

            const result = JSON.parse(jsonMatch[0]) as { classificacao?: string; confianca?: number };
            if (!result.classificacao || !categorias.includes(result.classificacao)) {
                logger.warn(`Kimi: classification "${result.classificacao}" not in allowed categories`);
                return null;
            }

            const confidence = Math.min(0.95, Math.max(0.70, result.confianca || 0.80));
            logger.info(`Kimi K2.5 classified: "${descricao}" → "${result.classificacao}" (${confidence.toFixed(2)})`);
            return { classification: result.classificacao, confidence };
        } catch (error) {
            logger.warn(`Kimi classification failed (graceful degradation): ${error}`);
            return null;
        }
    }

    /** Cached list of category names for Kimi prompt */
    private categoryNames: string[] | null = null;

    /** Loads category names from the cadastros table */
    async loadCategoryNames(): Promise<string[]> {
        if (this.categoryNames) return this.categoryNames;
        try {
            const { getCadastroRecords } = await import('../storage/areaTableClient');
            const { Categoria } = await import('../shared/areas') as { Categoria: never };
            const categorias = await getCadastroRecords<import('../shared/areas').Categoria>('categorias');
            this.categoryNames = categorias.filter(c => c.ativa).map(c => c.nome);
        } catch {
            // Fallback to hardcoded list if cadastros not available
            this.categoryNames = [
                'Receita de Servicos', 'Receita de Projetos', 'Receita Recorrente',
                'Infraestrutura Cloud', 'Marketing Digital', 'Fornecedores',
                'Folha de Pagamento', 'Contabilidade', 'Software ERP',
                'Despesas Imobiliarias', 'Utilidades', 'Servicos Financeiros',
                'Pagamentos Diversos', 'Despesas Administrativas', 'Despesas Nao Classificadas',
                'Pagamento Fatura Cartao', 'Aplicacao Investimento', 'Resgate Investimento',
                'Transferencias', 'Receita Operacional',
            ];
        }
        return this.categoryNames!;
    }

    /** Cached categories for audit budget lookup */
    private auditCategories: Array<{ nome: string; orcamentoMensal: number }> | null = null;

    /** Loads categories with budget info for audit */
    private async loadCategoriesForAudit(): Promise<Array<{ nome: string; orcamentoMensal: number }>> {
        if (this.auditCategories) return this.auditCategories;
        const { getCadastroRecords } = await import('../storage/areaTableClient');
        const categorias = await getCadastroRecords<import('../shared/areas').Categoria>('categorias');
        this.auditCategories = categorias
            .filter(c => c.ativa)
            .map(c => ({ nome: c.nome, orcamentoMensal: c.orcamentoMensal }));
        return this.auditCategories;
    }

    async classifyTransaction(tx: InterTransaction): Promise<AnalysisResult> {
        logger.info(`Classifying transaction: ${tx.descricao}`);
        const desc = (tx.descricao || '').toUpperCase();

        // 1st: Check learned rules (user-trained intelligence)
        const rules = await this.loadLearningRules();
        const descTokens = extractLearningTokens(desc);
        const learned = this.matchLearningRule(descTokens, rules);

        if (learned && learned.confidence >= 0.85) {
            logger.info(`Using LEARNED classification for "${tx.descricao}": ${learned.classification}`);
            return {
                id: 'CLASS_' + tx.id,
                type: 'transaction',
                classification: learned.classification,
                confidence: learned.confidence,
                value: tx.valor,
                needsReview: learned.confidence < 0.92,
                suggestedAction: learned.confidence >= 0.90 ? 'approve' : 'investigate',
            };
        }

        // 2nd: Rule-based classification
        const { classification, confidence } = this.classifyByDescription(desc, tx.tipo);

        // 3rd: If rule-based confidence is low, ask Kimi AI for a better classification
        if (confidence < 0.85 && this.isKimiConfigured()) {
            const categories = await this.loadCategoryNames();
            const kimiResult = await this.classifyWithKimi(tx.descricao, tx.tipo, tx.valor, categories);
            if (kimiResult && kimiResult.confidence > confidence) {
                logger.info(`Kimi override: "${classification}" (${confidence.toFixed(2)}) → "${kimiResult.classification}" (${kimiResult.confidence.toFixed(2)})`);
                return {
                    id: 'CLASS_' + tx.id,
                    type: 'transaction',
                    classification: kimiResult.classification,
                    confidence: kimiResult.confidence,
                    value: tx.valor,
                    needsReview: true,
                    suggestedAction: kimiResult.confidence >= 0.90 ? 'approve' : 'investigate',
                };
            }
        }

        return {
            id: 'CLASS_' + tx.id,
            type: 'transaction',
            classification,
            confidence,
            value: tx.valor,
            needsReview: true,
            suggestedAction: confidence >= 0.90 ? 'approve' : 'investigate',
        };
    }

    /** Rule-based classifier for Inter bank transactions */
    private classifyByDescription(desc: string, tipo: 'CREDITO' | 'DEBITO'): { classification: string; confidence: number } {
        // ---- Transferencias entre contas proprias (nao impacta DRE) ----
        if (desc.includes('RESGATE') && (desc.includes('CDB') || desc.includes('LCI') || desc.includes('LCA') || desc.includes('POUPANCA')))
            return { classification: 'Resgate Investimento', confidence: 0.98 };
        if (desc.includes('APLICACAO') && (desc.includes('CDB') || desc.includes('LCI') || desc.includes('LCA') || desc.includes('POUPANCA')))
            return { classification: 'Aplicacao Investimento', confidence: 0.98 };
        if ((desc.includes('FATURA') && desc.includes('INTER')) || (desc.includes('PAGAMENTO FATURA') && desc.includes('INTER')))
            return { classification: 'Pagamento Fatura Cartao', confidence: 0.98 };
        if (desc.includes('FATURA') && desc.includes('CARTAO'))
            return { classification: 'Pagamento Fatura Cartao', confidence: 0.97 };

        // ---- Known vendors (by CNPJ/name patterns) ----
        if (desc.includes('SERASA'))
            return { classification: 'Servicos Financeiros', confidence: 0.95 };
        if (desc.includes('CONTROLLE') || desc.includes('CONTABILIZEI') || desc.includes('CONTMATIC'))
            return { classification: 'Contabilidade', confidence: 0.95 };
        if (desc.includes('OMIEXPERIENCE') || desc.includes('OMIE'))
            return { classification: 'Software ERP', confidence: 0.95 };
        if (desc.includes('EBANX'))
            return { classification: 'Servicos Financeiros', confidence: 0.93 };
        if (desc.includes('GOOGLE') || desc.includes('META') || desc.includes('FACEBOOK'))
            return { classification: 'Marketing Digital', confidence: 0.95 };
        if (desc.includes('AWS') || desc.includes('AMAZON') || desc.includes('AZURE') || desc.includes('HEROKU'))
            return { classification: 'Infraestrutura Cloud', confidence: 0.96 };

        // ---- Payroll / HR ----
        if (desc.includes('SALARIO') || desc.includes('FOLHA') || desc.includes('INSS') || desc.includes('FGTS'))
            return { classification: 'Folha de Pagamento', confidence: 0.97 };

        // ---- Utilities ----
        if (desc.includes('ENERGIA') || desc.includes('CEMIG') || desc.includes('ENEL') || desc.includes('CPFL'))
            return { classification: 'Utilidades', confidence: 0.95 };
        if (desc.includes('TELEFONE') || desc.includes('INTERNET') || desc.includes('VIVO') || desc.includes('CLARO') || desc.includes('TIM'))
            return { classification: 'Utilidades', confidence: 0.95 };

        // ---- Real estate ----
        if (desc.includes('ALUGUEL') || desc.includes('CONDOMINIO') || desc.includes('IPTU'))
            return { classification: 'Despesas Imobiliarias', confidence: 0.96 };

        // ---- Transfer types ----
        if (desc.includes('TRANSFERENCIA') || desc.includes('TED') || desc.includes('DOC'))
            return tipo === 'CREDITO'
                ? { classification: 'Receita Operacional', confidence: 0.80 }
                : { classification: 'Transferencias', confidence: 0.80 };

        // ---- PIX classification ----
        if (desc.includes('PIX RECEBIDO'))
            return { classification: 'Receita Operacional', confidence: 0.90 };
        if (desc.includes('PIX ENVIADO')) {
            // Try to extract vendor hint from description
            if (desc.includes('MULTIDISPLAY') || desc.includes('PRODUTOS'))
                return { classification: 'Fornecedores', confidence: 0.85 };
            return { classification: 'Pagamentos Diversos', confidence: 0.75 };
        }

        // ---- Boleto ----
        if (desc.includes('BOLETO') || desc.includes('PAGAMENTO'))
            return tipo === 'CREDITO'
                ? { classification: 'Receita Operacional', confidence: 0.85 }
                : { classification: 'Pagamentos Diversos', confidence: 0.80 };

        // ---- Fallback ----
        return tipo === 'CREDITO'
            ? { classification: 'Receita Operacional', confidence: 0.70 }
            : { classification: 'Despesas Nao Classificadas', confidence: 0.60 };
    }

    async audit(result: AnalysisResult): Promise<void> {
        logger.info(`Auditing result: ${result.classification} - R$ ${result.value}`);

        // GAP #7: Load budgets dynamically from cadastro categories
        const FALLBACK_BUDGETS: Record<string, number> = {
            'Infraestrutura Cloud': 500.00,
            'Software ERP': 300.00,
            'Marketing Digital': 2000.00,
            'Pagamento Fatura Cartao': 3000.00,
            'Servicos Financeiros': 1000.00,
            'Contabilidade': 500.00,
            'Folha de Pagamento': 15000.00,
            'Despesas Imobiliarias': 5000.00,
            'Utilidades': 1000.00,
            'Pagamentos Diversos': 1000.00,
            'Fornecedores': 2000.00,
        };

        let budgets: Record<string, number> = FALLBACK_BUDGETS;
        try {
            const categorias = await this.loadCategoriesForAudit();
            if (categorias.length > 0) {
                const dynamic: Record<string, number> = {};
                for (const cat of categorias) {
                    if (cat.orcamentoMensal > 0) {
                        dynamic[cat.nome] = cat.orcamentoMensal;
                    }
                }
                if (Object.keys(dynamic).length > 0) {
                    budgets = dynamic;
                }
            }
        } catch {
            // Fallback already set
        }

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

    /** Non-operational classifications excluded from KPIs */
    private static readonly NON_OPERATIONAL = new Set([
        'Fatura Cartao', 'Transferencias',
    ]);

    async calculateKPIs(results: AnalysisResult[]): Promise<KPIResult> {
        logger.info(`Generating strategic KPIs for ${results.length} items`);

        const operational = results.filter(r => !GuardianAgents.NON_OPERATIONAL.has(r.classification));

        const revenue = operational
            .filter(r => r.classification === 'Receita Operacional')
            .reduce((acc, curr) => acc + curr.value, 0);

        const opExpenses = operational
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
