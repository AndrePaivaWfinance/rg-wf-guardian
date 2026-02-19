import { InterConnector } from './src/guardian/interConnector';
import { EmailListener } from './src/guardian/emailListener';
import { GuardianAgents } from './src/guardian/guardianAgents';
import { nowISO } from './src/shared/utils';

async function runGuardianTests() {
    console.log('🧪 Iniciando Testes Unitários: Guardian Sovereign System');
    console.log('---------------------------------------------------------');

    const inter = new InterConnector();
    const email = new EmailListener();
    const agents = new GuardianAgents();

    // 1. Teste Conector Inter
    console.log('▶️ Testando Conector Banco Inter...');
    const balance = await inter.getBalance();
    const txs = await inter.syncStatement('2026-01-01', nowISO().split('T')[0]);
    console.log(`✅ Inter OK. Saldo: ${balance.total}. Transações: ${txs.length}`);

    // 2. Teste Ingestor Email
    console.log('▶️ Testando Ingestor de Email...');
    const emails = await email.processIncomingEmails();
    console.log(`✅ Email OK. Mensagens encontradas: ${emails.length}`);

    // 3. Teste Agente Extrator (OCR/Document)
    console.log('▶️ Testando Agente Extrator (AI)...');
    const docResults = (await Promise.all(emails.map(e => agents.extractData(e)))).flat();
    console.log(`✅ Extrator OK. Documentos processados: ${docResults.length}`);

    // 4. Teste Agente Classificador (AI)...
    console.log('▶️ Testando Agente Classificador (AI)...');
    const txResults = await Promise.all(txs.map(t => agents.classifyTransaction(t)));
    console.log(`✅ Classificador OK. Classificações: ${txResults.length}`);

    // 5. Teste Agente Auditor (Controladoria)
    console.log('▶️ Testando Agente Auditor (Budget Control)...');
    for (const res of [...txResults, ...docResults]) {
        await agents.audit(res);
    }
    const budgetAlerts = [...txResults, ...docResults].filter(i => i.audit?.alert === 'critical');
    console.log(`✅ Auditoria OK. Alertas de Orçamento: ${budgetAlerts.length}`);

    // 6. Teste Agente Reconciliador (Smart Match)...
    console.log('▶️ Testando Agente Reconciliador (Smart Match)...');
    await agents.reconcile(txResults, docResults);
    const matches = txResults.filter(t => t.matchedId);
    console.log(`✅ Reconciliador OK. Matches encontrados: ${matches.length}`);

    // 7. Auditoria Final de Integridade
    console.log('---------------------------------------------------------');
    const totalItems = txResults.length + docResults.length;
    const automated = txResults.filter(t => t.confidence > 0.90 && !t.needsReview).length + docResults.filter(d => d.confidence > 0.90 && !d.needsReview).length;
    const rate = (automated / totalItems) * 100;

    console.log(`📊 RESULTADO FINAL:`);
    console.log(`- Taxa de Automação: ${rate.toFixed(1)}%`);
    console.log(`- Status: ${rate >= 90 ? 'PASSED (Grade 10+)' : 'FAILED'}`);

    if (rate < 90) {
        throw new Error('Taxa de automação abaixo da meta de 90%.');
    }
}

runGuardianTests().catch(err => {
    console.error('❌ Erro nos testes:', err);
    process.exit(1);
});
