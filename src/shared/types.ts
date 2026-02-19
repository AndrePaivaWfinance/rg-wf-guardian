/**
 * Guardian Sovereign System — Shared TypeScript Interfaces
 * Eliminates `any` usage across the codebase.
 */

import { AnalysisResult } from '../guardian/guardianAgents';

/** Entity stored in Azure Table Storage / in-memory */
export interface GuardianAuthorization {
    id: string;
    tipo: 'document' | 'transaction';
    classificacao: string;
    valor: number;
    confianca: number;
    match: string | null;
    status: 'pendente' | 'aprovado' | 'rejeitado';
    criadoEm: string;
    sugestao: 'approve' | 'investigate' | 'archive';
    origem?: string;
    audit?: {
        withinBudget: boolean;
        budgetLimit?: number;
        variation?: number;
        alert: 'none' | 'warning' | 'critical';
    };
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
    origem?: string
): GuardianAuthorization {
    return {
        id: res.id,
        tipo: res.type,
        classificacao: res.classification,
        valor: res.value,
        confianca: res.confidence,
        match: res.matchedId || null,
        status: 'pendente',
        criadoEm,
        sugestao: res.suggestedAction,
        origem,
        audit: res.audit,
        needsReview: res.needsReview,
    };
}

/** Valid document types for import */
export const VALID_DOC_TYPES = ['pdf', 'xml', 'ofx', 'csv'] as const;
export type DocType = typeof VALID_DOC_TYPES[number];
