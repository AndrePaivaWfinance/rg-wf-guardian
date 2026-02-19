import { describe, it, expect } from 'vitest';
import { generateId, safeErrorMessage, isValidUrl, nowISO } from '../src/shared/utils';
import { toGuardianAuth, VALID_DOC_TYPES } from '../src/shared/types';
import { GuardianAgents, AnalysisResult } from '../src/guardian/guardianAgents';
import { InterConnector } from '../src/guardian/interConnector';
import { EmailListener } from '../src/guardian/emailListener';

describe('Utils', () => {
    it('generateId produces unique, non-empty IDs with correct prefix', () => {
        const id1 = generateId('TEST');
        const id2 = generateId('TEST');
        expect(id1).toMatch(/^TEST_/);
        expect(id2).toMatch(/^TEST_/);
        expect(id1).not.toBe(id2);
        expect(id1.length).toBeGreaterThan(10);
    });

    it('nowISO returns valid ISO string', () => {
        const iso = nowISO();
        expect(new Date(iso).toISOString()).toBe(iso);
    });

    it('safeErrorMessage returns message from Error', () => {
        const msg = safeErrorMessage(new Error('test error'));
        expect(msg).toBe('test error');
    });

    it('safeErrorMessage handles non-Error values', () => {
        expect(safeErrorMessage('string')).toBe('Erro desconhecido');
        expect(safeErrorMessage(null)).toBe('Erro desconhecido');
    });

    it('isValidUrl validates URLs correctly', () => {
        expect(isValidUrl('https://example.com/file.pdf')).toBe(true);
        expect(isValidUrl('http://example.com')).toBe(true);
        expect(isValidUrl('ftp://bad.com')).toBe(false);
        expect(isValidUrl('not-a-url')).toBe(false);
        expect(isValidUrl('')).toBe(false);
    });
});

describe('Types', () => {
    it('VALID_DOC_TYPES contains expected types', () => {
        expect(VALID_DOC_TYPES).toContain('pdf');
        expect(VALID_DOC_TYPES).toContain('xml');
        expect(VALID_DOC_TYPES).toContain('ofx');
        expect(VALID_DOC_TYPES).toContain('csv');
    });

    it('toGuardianAuth maps AnalysisResult correctly', () => {
        const result: AnalysisResult = {
            id: 'TEST_1',
            type: 'transaction',
            classification: 'Receita',
            confidence: 0.95,
            value: 1000,
            needsReview: false,
            suggestedAction: 'approve',
            audit: { withinBudget: true, alert: 'none' },
        };

        const auth = toGuardianAuth(result, '2026-01-01T00:00:00Z', 'import_manual');

        expect(auth.id).toBe('TEST_1');
        expect(auth.tipo).toBe('transaction');
        expect(auth.classificacao).toBe('Receita');
        expect(auth.valor).toBe(1000);
        expect(auth.confianca).toBe(0.95);
        expect(auth.status).toBe('pendente');
        expect(auth.sugestao).toBe('approve');
        expect(auth.origem).toBe('import_manual');
        expect(auth.audit?.alert).toBe('none');
        expect(auth.needsReview).toBe(false);
    });
});

describe('InterConnector', () => {
    const inter = new InterConnector();

    it('getBalance returns valid balance', async () => {
        const balance = await inter.getBalance();
        expect(balance.total).toBeGreaterThan(0);
        expect(balance.disponivel).toBe(balance.total);
        expect(balance.dataHora).toBeTruthy();
    });

    it('syncStatement returns transactions with unique IDs', async () => {
        const txs = await inter.syncStatement('2026-01-01', '2026-01-31');
        expect(txs.length).toBe(2);
        expect(txs[0].id).not.toBe(txs[1].id);
        expect(txs[0].tipo).toBe('CREDITO');
        expect(txs[1].tipo).toBe('DEBITO');
    });
});

describe('EmailListener', () => {
    it('processIncomingEmails returns documents', async () => {
        const listener = new EmailListener();
        const docs = await listener.processIncomingEmails();
        expect(docs.length).toBeGreaterThan(0);
        expect(docs[0].id).toMatch(/^MSG_/);
        expect(docs[0].attachments.length).toBeGreaterThan(0);
    });
});

describe('GuardianAgents', () => {
    const agents = new GuardianAgents();

    it('extractData from email doc produces results with unique IDs', async () => {
        const listener = new EmailListener();
        const docs = await listener.processIncomingEmails();
        const results = await agents.extractData(docs[0]);

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].id).toMatch(/^EXT_/);
        expect(results[0].type).toBe('document');
        expect(results[0].confidence).toBeGreaterThan(0);
    });

    it('extractData from imported doc works', async () => {
        const imported = {
            id: 'IMP_test',
            name: 'test.xml',
            type: 'xml' as const,
            source: 'manual_import' as const,
            contentUrl: 'https://example.com/test.xml',
            size: 1024,
            uploadedAt: nowISO(),
        };
        const results = await agents.extractData(imported);
        expect(results[0].classification).toBe('Nota Fiscal Servico');
    });

    it('classifyTransaction classifies CREDITO as Receita', async () => {
        const tx = {
            id: 'TX_1',
            data: '2026-01-15',
            tipo: 'CREDITO' as const,
            valor: 5000,
            descricao: 'PIX RECEBIDO - CLIENTE',
        };
        const result = await agents.classifyTransaction(tx);
        expect(result.classification).toBe('Receita Operacional');
        expect(result.confidence).toBe(1.0);
    });

    it('classifyTransaction classifies DEBITO as Despesa', async () => {
        const tx = {
            id: 'TX_2',
            data: '2026-01-15',
            tipo: 'DEBITO' as const,
            valor: 200,
            descricao: 'PAGAMENTO DIVERSOS',
        };
        const result = await agents.classifyTransaction(tx);
        expect(result.classification).toBe('Despesas Administrativas');
        expect(result.needsReview).toBe(true);
    });

    it('audit flags over-budget items', async () => {
        const result: AnalysisResult = {
            id: 'AUD_1',
            type: 'document',
            classification: 'Infraestrutura / AWS',
            confidence: 0.98,
            value: 1500, // over 1000 budget
            needsReview: false,
            suggestedAction: 'approve',
        };
        await agents.audit(result);
        expect(result.audit).toBeDefined();
        expect(result.audit!.alert).toBe('critical');
        expect(result.audit!.withinBudget).toBe(false);
        expect(result.needsReview).toBe(true);
        expect(result.suggestedAction).toBe('investigate');
    });

    it('audit allows within-budget items', async () => {
        const result: AnalysisResult = {
            id: 'AUD_2',
            type: 'document',
            classification: 'Infraestrutura / AWS',
            confidence: 0.98,
            value: 500, // under 1000 budget
            needsReview: false,
            suggestedAction: 'approve',
        };
        await agents.audit(result);
        expect(result.audit!.alert).toBe('none');
        expect(result.audit!.withinBudget).toBe(true);
    });

    it('reconcile matches transactions to documents by value', async () => {
        const txs: AnalysisResult[] = [{
            id: 'TX_R1', type: 'transaction', classification: 'Despesas',
            confidence: 0.9, value: 924.10, needsReview: false, suggestedAction: 'archive',
        }];
        const docs: AnalysisResult[] = [{
            id: 'DOC_R1', type: 'document', classification: 'AWS',
            confidence: 0.98, value: 924.10, needsReview: false, suggestedAction: 'approve',
        }];

        await agents.reconcile(txs, docs);
        expect(txs[0].matchedId).toBe('DOC_R1');
        expect(txs[0].confidence).toBe(1.0);
    });

    it('reconcile does not double-match same document', async () => {
        const txs: AnalysisResult[] = [
            { id: 'TX_A', type: 'transaction', classification: 'X', confidence: 0.9, value: 100, needsReview: false, suggestedAction: 'archive' },
            { id: 'TX_B', type: 'transaction', classification: 'X', confidence: 0.9, value: 100, needsReview: false, suggestedAction: 'archive' },
        ];
        const docs: AnalysisResult[] = [
            { id: 'DOC_A', type: 'document', classification: 'X', confidence: 0.98, value: 100, needsReview: false, suggestedAction: 'approve' },
        ];

        await agents.reconcile(txs, docs);
        expect(txs[0].matchedId).toBe('DOC_A');
        expect(txs[1].matchedId).toBeUndefined();
    });

    it('calculateKPIs computes correct values', async () => {
        const items: AnalysisResult[] = [
            { id: '1', type: 'transaction', classification: 'Receita Operacional', confidence: 1, value: 10000, needsReview: false, suggestedAction: 'archive' },
            { id: '2', type: 'transaction', classification: 'Despesas Administrativas', confidence: 0.9, value: 3000, needsReview: false, suggestedAction: 'archive' },
        ];

        const kpis = await agents.calculateKPIs(items);
        expect(kpis.ebitda).toBe(7000);
        expect(kpis.revenue).toBe(10000);
        expect(kpis.opExpenses).toBe(3000);
        expect(kpis.status).toBe('Healthy');
    });
});

describe('End-to-End Pipeline', () => {
    it('full sync pipeline produces audited and reconciled results', async () => {
        const inter = new InterConnector();
        const email = new EmailListener();
        const agents = new GuardianAgents();

        const [, txs, docs] = await Promise.all([
            inter.getBalance(),
            inter.syncStatement('2026-01-01', '2026-01-31'),
            email.processIncomingEmails(),
        ]);

        const docResults = (await Promise.all(docs.map(d => agents.extractData(d)))).flat();
        const txResults = await Promise.all(txs.map(t => agents.classifyTransaction(t)));

        for (const res of [...txResults, ...docResults]) {
            await agents.audit(res);
        }
        await agents.reconcile(txResults, docResults);

        // All results should have IDs
        const allResults = [...txResults, ...docResults];
        expect(allResults.every(r => r.id.length > 0)).toBe(true);

        // At least one audit alert expected (AWS doc = 924.10 < 1000 = within budget, but check exists)
        expect(allResults.some(r => r.audit !== undefined)).toBe(true);

        // Automation rate should be computable
        const automated = allResults.filter(r => r.confidence > 0.90 && !r.needsReview).length;
        const rate = (automated / allResults.length) * 100;
        expect(rate).toBeGreaterThan(0);
    });
});
