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
        data: data || criadoEm.split('T')[0],
        auditJson: res.audit ? JSON.stringify(res.audit) : undefined,
        needsReview: res.needsReview,
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
