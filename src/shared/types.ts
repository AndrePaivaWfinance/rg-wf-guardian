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
        sugestaoIA: `Classificado como "${res.classification}" com ${(res.confidence * 100).toFixed(0)}% de confiança. ${
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

/** Valid document types for import */
export const VALID_DOC_TYPES = ['pdf', 'xml', 'ofx', 'csv'] as const;
export type DocType = typeof VALID_DOC_TYPES[number];
