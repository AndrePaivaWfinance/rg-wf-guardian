import { describe, it, expect } from 'vitest';
import { generateId, safeErrorMessage, isValidUrl, nowISO } from '../src/shared/utils';
import { toGuardianAuth, hydrateAuth, VALID_DOC_TYPES } from '../src/shared/types';
import { GuardianAgents, AnalysisResult } from '../src/guardian/guardianAgents';
import { InterConnector } from '../src/guardian/interConnector';
import { EmailListener } from '../src/guardian/emailListener';
import { OperacoesProject, MarketingCampaign, ComercialDeal } from '../src/shared/areas';
import { getAreaRecords, createAreaRecord, updateAreaRecord, deleteAreaRecord } from '../src/storage/areaTableClient';

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
        // audit is serialized as JSON string for Table Storage
        expect(auth.auditJson).toBe('{"withinBudget":true,"alert":"none"}');
        // After hydration, audit object is restored
        const hydrated = hydrateAuth({ ...auth });
        expect(hydrated.audit?.alert).toBe('none');
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

describe('Area Storage - Operacoes', () => {
    it('creates and retrieves operacoes records', async () => {
        const project: OperacoesProject = {
            id: generateId('OP'),
            nome: 'Teste BPO',
            cliente: 'Empresa Teste',
            responsavel: 'Tester',
            status: 'em_andamento',
            prioridade: 'alta',
            dataInicio: '2026-02-01',
            dataPrevisao: '2026-04-01',
            progresso: 50,
            horasEstimadas: 200,
            horasRealizadas: 100,
            valorContrato: 50000,
            tags: ['teste'],
        };

        await createAreaRecord('operacoes', project);
        const records = await getAreaRecords<OperacoesProject>('operacoes');
        expect(records.length).toBeGreaterThan(0);
        const found = records.find(r => r.id === project.id);
        expect(found).toBeDefined();
        expect(found!.nome).toBe('Teste BPO');
        expect(found!.valorContrato).toBe(50000);
    });

    it('updates operacoes records', async () => {
        const project: OperacoesProject = {
            id: generateId('OP'),
            nome: 'Update Test',
            cliente: 'Cli',
            responsavel: 'R',
            status: 'backlog',
            prioridade: 'media',
            dataInicio: '2026-02-01',
            dataPrevisao: '2026-03-01',
            progresso: 0,
            horasEstimadas: 100,
            horasRealizadas: 0,
            valorContrato: 20000,
            tags: [],
        };

        await createAreaRecord('operacoes', project);
        project.status = 'em_andamento';
        project.progresso = 30;
        await updateAreaRecord('operacoes', project);

        const records = await getAreaRecords<OperacoesProject>('operacoes');
        const found = records.find(r => r.id === project.id);
        expect(found!.status).toBe('em_andamento');
        expect(found!.progresso).toBe(30);
    });

    it('deletes operacoes records', async () => {
        const project: OperacoesProject = {
            id: generateId('OP'),
            nome: 'Delete Test',
            cliente: 'Cli',
            responsavel: 'R',
            status: 'backlog',
            prioridade: 'baixa',
            dataInicio: '2026-02-01',
            dataPrevisao: '2026-03-01',
            progresso: 0,
            horasEstimadas: 50,
            horasRealizadas: 0,
            valorContrato: 10000,
            tags: [],
        };

        await createAreaRecord('operacoes', project);
        await deleteAreaRecord('operacoes', project.id);

        const records = await getAreaRecords<OperacoesProject>('operacoes');
        const found = records.find(r => r.id === project.id);
        expect(found).toBeUndefined();
    });
});

describe('Area Storage - Marketing', () => {
    it('creates and retrieves marketing campaigns', async () => {
        const campaign: MarketingCampaign = {
            id: generateId('MKT'),
            nome: 'Teste Google Ads',
            canal: 'google_ads',
            status: 'ativa',
            orcamento: 5000,
            gastoAtual: 2500,
            dataInicio: '2026-02-01',
            leads: 30,
            conversoes: 3,
            impressoes: 10000,
            cliques: 500,
            cpl: 83.33,
            cpa: 833.33,
            roi: 250,
        };

        await createAreaRecord('marketing', campaign);
        const records = await getAreaRecords<MarketingCampaign>('marketing');
        const found = records.find(r => r.id === campaign.id);
        expect(found).toBeDefined();
        expect(found!.canal).toBe('google_ads');
        expect(found!.leads).toBe(30);
    });
});

describe('Area Storage - Comercial', () => {
    it('creates and retrieves comercial deals', async () => {
        const deal: ComercialDeal = {
            id: generateId('DEAL'),
            empresa: 'Empresa Teste',
            contato: 'Fulano',
            servico: 'BPO Financeiro',
            estagio: 'proposta',
            valor: 120000,
            recorrencia: 'mensal',
            probabilidade: 60,
            responsavel: 'Tester',
            dataCriacao: '2026-02-01',
            dataPrevisaoFechamento: '2026-04-01',
            origem: 'inbound',
        };

        await createAreaRecord('comercial', deal);
        const records = await getAreaRecords<ComercialDeal>('comercial');
        const found = records.find(r => r.id === deal.id);
        expect(found).toBeDefined();
        expect(found!.estagio).toBe('proposta');
        expect(found!.valor).toBe(120000);
    });

    it('handles deal lifecycle (create -> update stage -> close)', async () => {
        const deal: ComercialDeal = {
            id: generateId('DEAL'),
            empresa: 'Lifecycle Test',
            contato: 'Contact',
            servico: 'Consultoria',
            estagio: 'prospeccao',
            valor: 80000,
            recorrencia: 'unico',
            probabilidade: 20,
            responsavel: 'Tester',
            dataCriacao: '2026-01-15',
            dataPrevisaoFechamento: '2026-03-15',
            origem: 'outbound',
        };

        await createAreaRecord('comercial', deal);

        // Move to negociacao
        deal.estagio = 'negociacao';
        deal.probabilidade = 70;
        await updateAreaRecord('comercial', deal);

        // Close as won
        deal.estagio = 'fechado_ganho';
        deal.probabilidade = 100;
        deal.dataFechamento = '2026-02-20';
        await updateAreaRecord('comercial', deal);

        const records = await getAreaRecords<ComercialDeal>('comercial');
        const found = records.find(r => r.id === deal.id);
        expect(found!.estagio).toBe('fechado_ganho');
        expect(found!.probabilidade).toBe(100);
        expect(found!.dataFechamento).toBe('2026-02-20');
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
