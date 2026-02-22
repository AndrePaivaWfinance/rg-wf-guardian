/**
 * Guardian Sovereign System — Shared TypeScript Interfaces
 * Eliminates `any` usage across the codebase.
 */

import { AnalysisResult } from '../guardian/guardianAgents';

/** Audit result shape (used in-memory and after deserialization) */
export interface AuditInfo {
    withinBudget: boolean;
    budgetLimit?: number;
    variation?: number;
    alert: 'none' | 'warning' | 'critical';
}

/** Entity stored in Azure Table Storage / in-memory.
 *  Complex fields (audit) are serialized as JSON strings for Table Storage compatibility. */
export interface GuardianAuthorization {
    id: string;
    tipo: 'document' | 'transaction';
    classificacao: string;
    valor: number;
    confianca: number;
    match: string;
    status: 'pendente' | 'aprovado' | 'rejeitado';
    criadoEm: string;
    sugestao: 'approve' | 'investigate' | 'archive';
    origem?: string;
    descricao?: string;
    data?: string;

    // Datas financeiras
    dataCompetencia?: string;  // Mês/período contábil (YYYY-MM-DD)
    dataVencimento?: string;   // Data de vencimento (YYYY-MM-DD)
    dataInclusao?: string;     // Data em que foi descoberta/importada (YYYY-MM-DD)
    dataPagamento?: string;    // Data efetiva do pagamento (YYYY-MM-DD)

    // GAP #8: Vinculação com projetos/campanhas
    projetoId?: string;        // ID do projeto (OperacoesProject.id) vinculado
    campanhaId?: string;       // ID da campanha (MarketingCampaign.id) vinculado

    // Sugestão da IA para revisão
    sugestaoIA?: string;       // Texto explicativo da classificação sugerida pela IA

    /** Stored as JSON string in Table Storage, parsed back on read */
    auditJson?: string;
    /** Transient — populated after parsing auditJson */
    audit?: AuditInfo;
    needsReview?: boolean;
    // Azure Table Storage keys
    partitionKey?: string;
    rowKey?: string;
}

/** Body accepted by POST /api/guardianImport */
export interface ImportRequestBody {
    name?: string;
    type?: 'pdf' | 'xml' | 'ofx' | 'csv';
    url: string;
    size?: number;
}

/** KPI output from GuardianAgents.calculateKPIs */
export interface KPIResult {
    ebitda: number;
    revenue: number;
    opExpenses: number;
    netMargin: string;
    efficiency: string;
    status: 'Healthy' | 'Critical';
}

/** Maps AnalysisResult → GuardianAuthorization for persistence */
export function toGuardianAuth(
    res: AnalysisResult,
    criadoEm: string,
    origem?: string,
    descricao?: string,
    data?: string
): GuardianAuthorization {
    const dataTransacao = data || criadoEm.split('T')[0];
    const hoje = criadoEm.split('T')[0];

    return {
        id: res.id,
        tipo: res.type,
        classificacao: res.classification,
        valor: res.value,
        confianca: res.confidence,
        match: res.matchedId || '',
        status: 'pendente',
        criadoEm,
        sugestao: res.suggestedAction,
        origem: origem || '',
        descricao: descricao || '',
        data: dataTransacao,

        // Datas financeiras
        dataCompetencia: dataTransacao.substring(0, 7) + '-01', // primeiro dia do mês da transação
        dataVencimento: dataTransacao,                           // mesma data da transação (ajustável pelo usuário)
        dataInclusao: hoje,                                      // data em que o sync descobriu
        dataPagamento: dataTransacao,                            // data efetiva (para extrato bancário já é a data do pagamento)

        // Sugestão IA
        sugestaoIA: `Classificado como "${res.classification}" com ${(res.confidence * 100).toFixed(0)}% de confiança${
            res.confidence >= 0.80 && res.confidence <= 0.97 && res.id.startsWith('CLASS_') ? ' (aprendizado)' : ''
        }. ${
            res.suggestedAction === 'approve' ? 'Recomendação: aprovar automaticamente.' :
            res.suggestedAction === 'investigate' ? 'Recomendação: revisar antes de aprovar.' :
            'Recomendação: arquivar (conciliado com documento).'
        }`,

        auditJson: res.audit ? JSON.stringify(res.audit) : undefined,
        needsReview: true, // Todas as transações precisam de aprovação do usuário
    };
}

/** Hydrates audit from JSON string after reading from Table Storage */
export function hydrateAuth(auth: GuardianAuthorization): GuardianAuthorization {
    if (auth.auditJson && !auth.audit) {
        try {
            auth.audit = JSON.parse(auth.auditJson) as AuditInfo;
        } catch { /* ignore parse errors */ }
    }
    return auth;
}

/** ============ LEARNING ============ */

/** Regra aprendida a partir de aprovações/reclassificações do usuário */
export interface LearningRule {
    id: string;
    /** Tokens significativos extraídos da descrição (ex: ["MULTIDISPLAY", "COMERCIO"]) */
    tokens: string[];
    /** Tokens serializado como string para Azure Table Storage */
    tokensJson: string;
    /** Classificação correta aprendida */
    classificacao: string;
    /** Quantas vezes essa regra foi confirmada */
    hits: number;
    /** Confiança calculada: min(0.97, 0.80 + hits * 0.03) */
    confianca: number;
    /** Descrição original que gerou a regra (para auditoria) */
    descricaoOriginal: string;
    criadoEm: string;
    atualizadoEm: string;
}

/** Tokens genéricos bancários que não são úteis para aprendizado */
export const BANKING_STOPWORDS = new Set([
    'PIX', 'ENVIADO', 'RECEBIDO', 'TRANSFERENCIA', 'TED', 'DOC',
    'PAGAMENTO', 'BOLETO', 'DEBITO', 'CREDITO', 'FATURA', 'INTER',
    'BANCO', 'CONTA', 'PARCELA', 'TAXA', 'TARIFA', 'DE', 'DO', 'DA',
    'DOS', 'DAS', 'PARA', 'COM', 'EM', 'POR', 'AO', 'NO', 'NA',
    'LTDA', 'EIRELI', 'MEI', 'SA', 'S/A', 'ME', 'EPP', 'SS',
    'CNPJ', 'CPF', 'REF', 'NR', 'NUM', 'COD',
]);

/** Extrai tokens significativos de uma descrição bancária */
export function extractLearningTokens(descricao: string): string[] {
    return descricao
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 3 && !BANKING_STOPWORDS.has(t))
        .filter((t, i, arr) => arr.indexOf(t) === i); // unique
}

/** Calcula confiança baseada no número de hits */
export function learningConfidence(hits: number): number {
    return Math.min(0.97, 0.80 + hits * 0.03);
}

/** Hydrates tokens from JSON string after reading from Table Storage */
export function hydrateLearningRule(rule: LearningRule): LearningRule {
    if (rule.tokensJson && (!rule.tokens || rule.tokens.length === 0)) {
        try {
            rule.tokens = JSON.parse(rule.tokensJson) as string[];
        } catch { rule.tokens = []; }
    }
    return rule;
}

/** ============ AUDIT LOG (GAP #1) ============ */

/** Acao registrada na trilha de auditoria */
export type AuditAction = 'approve' | 'reject' | 'reclassify' | 'clear_all';

/** Entrada na tabela GuardianAuditLog */
export interface AuditLogEntry {
    id: string;
    /** ID da autorizacao afetada (vazio em clear_all) */
    authId: string;
    /** Acao realizada */
    acao: AuditAction;
    /** Snapshot antes da acao (JSON) */
    antes: string;
    /** Snapshot depois da acao (JSON) */
    depois: string;
    /** ISO timestamp */
    timestamp: string;
    /** Identificador do usuario (futuro: Azure AD, por ora "analyst") */
    usuario: string;
}

/** Valid document types for import */
export const VALID_DOC_TYPES = ['pdf', 'xml', 'ofx', 'csv'] as const;
export type DocType = typeof VALID_DOC_TYPES[number];
