# Mapeamento V2 — Guardian Sovereign System
# Captacao > Tratamento > Relatorios > Avisos

> Analise completa pos-implementacao dos 14 gaps originais.
> Data: 2026-02-22 | Versao: 2.0

---

## Fluxo BPMN Atual

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          GUARDIAN SOVEREIGN PIPELINE                            │
│                                                                                 │
│   CAPTACAO              TRATAMENTO              RELATORIOS        AVISOS        │
│   ─────────             ──────────              ──────────        ─────         │
│                                                                                 │
│  ┌──────────┐       ┌──────────────────┐    ┌──────────────┐  ┌───────────┐    │
│  │ Inter API │──┐   │ Classificacao    │    │ DRE (MC)     │  │ Teams     │    │
│  │ (Extrato) │  │   │ 3 camadas:       │    │ DFC          │  │ Webhook   │    │
│  └──────────┘  │   │  1. Learning     │    │ Forecast 3x  │  └───────────┘    │
│                │   │  2. Hardcoded    │    │ KPIs         │                    │
│  ┌──────────┐  │   │  3. Kimi K2.5   │    │ P&L Projeto  │  ┌───────────┐    │
│  │ Email    │──┤   └──────────────────┘    └──────────────┘  │ Email     │    │
│  │ Graph API│  │              │                    │          │ Graph API │    │
│  └──────────┘  ├──> Auditoria ────> Aprovacao ────> Dashboard  └───────────┘    │
│                │              │                    │                             │
│  ┌──────────┐  │   ┌──────────────────┐    ┌──────────────┐  ┌───────────┐    │
│  │ Upload   │──┤   │ Reconciliacao    │    │ Categorizado │  │ Timer 8h  │    │
│  │ Manual   │  │   │ Smart (3 scores) │    │ por Grupo    │  │ Diario    │    │
│  └──────────┘  │   └──────────────────┘    └──────────────┘  └───────────┘    │
│                │                                                                │
│  ┌──────────┐  │   ┌──────────────────┐                                        │
│  │ OFX/CSV  │──┘   │ Batch Processing │                                        │
│  │ Import   │      │ Chunks 50 / 5    │                                        │
│  └──────────┘      └──────────────────┘                                        │
│                                                                                 │
│  Auth: Azure AD (Entra ID) + MSAL.js ──────────────────────── Todos endpoints  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Status dos 14 Gaps Originais

| # | Gap | Status |
|---|-----|--------|
| 1 | Trilha de auditoria | CONCLUIDO |
| 2 | Autenticacao Azure AD | CONCLUIDO |
| 3 | Reconciliacao inteligente | CONCLUIDO |
| 4 | Persistencia de anexos email | CONCLUIDO |
| 5 | Parsers OFX/CSV | CONCLUIDO |
| 6 | Forecast com cenarios | CONCLUIDO |
| 7 | Orcamentos dinamicos | CONCLUIDO |
| 8 | Areas vinculadas ao financeiro | CONCLUIDO |
| 9 | Batch processing | CONCLUIDO |
| 10 | Notificacoes proativas | CONCLUIDO |
| 11 | Confirmacao clear_all | CONCLUIDO |
| 12 | Cache com invalidacao | CONCLUIDO |
| 13 | Protecao over-generalization | CONCLUIDO |
| 14 | Regime de competencia | CONCLUIDO |

**14/14 concluidos.** A analise abaixo identifica **novos gaps e melhorias** apos revisao profunda.

---

## Novos Gaps Identificados

### PILAR 1 — CAPTACAO (Ingestao de Dados)

---

#### GAP #15 — Sem validacao de schema nos payloads de entrada
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Todos os endpoints usam `request.json() as Type` — type assertion sem validacao real. Um payload malformado pode causar crashes silenciosos ou dados corrompidos no storage |
| **Exemplo** | `guardianApprove.ts:33` faz `body = await request.json() as ApproveBody` sem validar campos |
| **Impacto** | Dados invalidos podem entrar no Table Storage; campos numericos podem receber strings |
| **Arquivos** | Todos em `src/functions/*.ts` |
| **Solucao** | Implementar validacao com `zod` em cada endpoint. Criar schemas reutilizaveis para `ApproveBody`, `UploadBody`, `ImportBody`, `CadastroBody` |
| **Criterio** | Enviar payload com campo `valor: "abc"` retorna 400 com mensagem descritiva |

---

#### GAP #16 — Inter connector sem retry/circuit breaker
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `interConnector.ts:73` tem timeout de 5s mas sem retry. Se o Inter API retorna 500 ou timeout, o sync inteiro falha no saldo. `Promise.allSettled` no guardianSync atenua mas nao resolve |
| **Impacto** | Dashboard mostra saldo zero quando Inter esta instavel; sync degrada sem retentativa |
| **Arquivo** | `src/guardian/interConnector.ts` |
| **Solucao** | Implementar retry com backoff exponencial (3 tentativas, 1s/2s/4s) e circuit breaker (apos 5 falhas consecutivas, desativar por 5 min e usar cache) |
| **Criterio** | Inter API retornando 503 por 2 chamadas mas OK na 3a → saldo correto no dashboard |

---

#### GAP #17 — Email listener sem deduplicacao
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `emailListener.ts` processa emails nao lidos, mas se o sync falhar apos ler o email (sem marcar como lido), o proximo sync reprocessa os mesmos anexos, gerando transacoes duplicadas |
| **Impacto** | Transacoes duplicadas no sistema; DRE com valores inflados |
| **Arquivo** | `src/guardian/emailListener.ts` |
| **Solucao** | (1) Manter registro de `messageId` ja processados no Table Storage, (2) Verificar antes de processar, (3) Marcar email como lido somente apos persistencia |
| **Criterio** | Processar o mesmo email 2x nao cria transacoes duplicadas |

---

#### GAP #18 — Upload sem limite de tamanho nem tipo
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | Endpoint de upload aceita qualquer arquivo sem limite de tamanho. Um arquivo de 500MB pode travar a function. Sem whitelist de MIME types |
| **Arquivo** | `src/functions/guardianUpload.ts`, `src/functions/guardianImport.ts` |
| **Solucao** | (1) Limitar upload a 10MB, (2) Aceitar somente PDF/XML/OFX/CSV/PNG/JPG, (3) Retornar 413 (Payload Too Large) ou 415 (Unsupported Media Type) |
| **Criterio** | Upload de .exe retorna 415; upload de 50MB retorna 413 |

---

### PILAR 2 — TRATAMENTO (Processamento e Inteligencia)

---

#### GAP #19 — Classificacao hardcoded sem fallback para categorias dinamicas
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | `classifyByDescription()` e `classifyVendor()` retornam nomes hardcoded como `"Infraestrutura / AWS"`, `"Folha de Pagamento"`, etc. Se o usuario renomear a categoria, o match quebra silenciosamente |
| **Impacto** | Transacoes classificadas em categorias que nao existem no cadastro → nao aparecem no DRE, DFC fica inconsistente |
| **Arquivo** | `src/guardian/guardianAgents.ts:529-548` (classifyVendor), linhas de classifyByDescription |
| **Solucao** | (1) Carregar categorias do cadastro uma vez por sync, (2) Fazer match por similaridade entre nome retornado e categorias reais, (3) Se nao houver match, usar a categoria mais proxima + `needsReview: true` |
| **Criterio** | Renomear "Infraestrutura Cloud" para "Cloud & Infra" e invoice da AWS classifica corretamente |

---

#### GAP #20 — DRE duplicado entre dashboard e reports
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `buildDRE()`, `buildDFC()`, `buildForecast()`, `buildCatLookup()`, `sumByTipo()`, `groupByGrupo()` estao **duplicados** em `guardianDashboard.ts` e `guardianReports.ts` com logica identica mas copias independentes. Qualquer fix num arquivo nao se propaga pro outro |
| **Impacto** | `guardianReports.ts:buildForecast()` ainda usa modelo ANTIGO (3% fixo), enquanto dashboard ja usa media movel do GAP #6. DRE pode divergir entre dashboard e relatorio |
| **Arquivos** | `src/functions/guardianDashboard.ts`, `src/functions/guardianReports.ts` |
| **Solucao** | Extrair `buildDRE()`, `buildDFC()`, `buildForecast()`, `sumByTipo()`, `groupByGrupo()`, `buildCatLookup()` para `src/shared/financial.ts` como modulo compartilhado. Ambos endpoints importam do mesmo lugar |
| **Criterio** | Dashboard e Reports retornam DRE/DFC/Forecast identicos para os mesmos dados |

---

#### GAP #21 — Sync nao verifica duplicatas de transacao
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | `guardianSync.ts` cria `GuardianAuthorization` para cada transacao do extrato sem verificar se ja existe. Se o usuario disparar 2 syncs no mesmo periodo, todas as transacoes duplicam |
| **Impacto** | Receitas e despesas dobram no DRE; saldo do dashboard fica inconsistente |
| **Arquivo** | `src/functions/guardianSync.ts:110-117` |
| **Solucao** | (1) Antes de persistir, consultar auths existentes por `descricao + valor + data`, (2) Se ja existe com mesma combinacao, pular. (3) Opcionalmente, usar `id` estavel derivado de hash do extrato |
| **Criterio** | 2 syncs consecutivos para o mesmo periodo produzem o mesmo numero de transacoes |

---

#### GAP #22 — Aprovacao carrega TODAS as autorizacoes para encontrar 1
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `guardianApprove.ts:88` faz `getAllAuthorizations()` (full table scan) para encontrar 1 registro por ID. Com 10.000+ registros isso e lento e custoso |
| **Arquivo** | `src/functions/guardianApprove.ts:88` |
| **Solucao** | Criar `getAuthorizationById(id)` no tableClient que usa `getEntity(partitionKey, rowKey)` diretamente — O(1) ao inves de O(n) |
| **Criterio** | Aprovacao responde em < 200ms mesmo com 10.000 registros |

---

#### GAP #23 — Learning rules sem decaimento temporal
| Item | Detalhe |
|------|---------|
| **Severidade** | BAIXA |
| **Problema** | Regras de aprendizado acumulam `hits` infinitamente. Uma regra criada ha 2 anos com 500 hits domina mesmo que o padrao de gasto tenha mudado |
| **Arquivo** | `src/guardian/guardianAgents.ts:116-173` |
| **Solucao** | Aplicar decaimento temporal: `scoreEfetivo = hits * decayFactor(diasDesdeUltimoHit)`. Regras sem uso em 90 dias perdem relevancia gradualmente |
| **Criterio** | Regra sem uso em 6 meses tem confianca reduzida em pelo menos 50% |

---

### PILAR 3 — RELATORIOS (Saidas e Visualizacao)

---

#### GAP #24 — Sem exportacao de relatorios (PDF/Excel)
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Dashboard so mostra dados na tela. Analista nao consegue exportar DRE, DFC ou extrato em PDF/Excel para enviar ao contador, diretor ou auditoria |
| **Impacto** | Analista faz print screen ou copia dados manualmente — erro humano, improdutividade |
| **Arquivos** | `public/index.html`, `src/functions/guardianReports.ts` |
| **Solucao** | (1) Adicionar botao "Exportar PDF" no frontend que chama `/api/guardianReports?format=pdf`, (2) No backend, usar biblioteca como `pdfmake` ou `@react-pdf/renderer` para gerar PDF do DRE/DFC, (3) Para Excel, usar `exceljs` para gerar .xlsx com DRE e lancamentos |
| **Criterio** | Clicar em "Exportar PDF" baixa arquivo PDF formatado com DRE + DFC do periodo |

---

#### GAP #25 — Sem filtro de periodo nos relatorios
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Dashboard e Reports processam TODOS os dados aprovados, sem filtro por mes/trimestre/ano. Analista nao consegue ver DRE de janeiro vs fevereiro separadamente |
| **Impacto** | Impossivel fazer analise comparativa mensal; DRE acumula todos os meses juntos |
| **Arquivos** | `src/functions/guardianDashboard.ts`, `src/functions/guardianReports.ts`, `public/index.html` |
| **Solucao** | (1) Aceitar query params `?mesInicio=2026-01&mesFim=2026-02`, (2) Filtrar `approvedItems` por `dataCompetencia` dentro do range, (3) No frontend, adicionar seletor de periodo (mes, trimestre, ano) |
| **Criterio** | Selecionar "Janeiro 2026" mostra DRE apenas com transacoes de competencia jan/2026 |

---

#### GAP #26 — DRE sem comparativo (Real vs Orcado vs Anterior)
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | DRE mostra apenas valores reais do periodo. Analista nao tem comparativo com orcamento nem com periodo anterior para avaliar performance |
| **Impacto** | Impossivel saber se o mes foi bom ou ruim sem referencia; orcamentos cadastrados nao sao usados no DRE |
| **Arquivos** | `src/functions/guardianDashboard.ts`, `public/index.html` |
| **Solucao** | (1) DRE com 3 colunas: Real | Orcado | % Var, (2) Opcao de comparar com mesmo mes do ano anterior, (3) Colorir variacoes: verde se favoravel, vermelho se desfavoravel |
| **Criterio** | DRE mostra coluna "Orcado" com soma dos `orcamentoMensal` por tipo e "% Var" com desvio |

---

#### GAP #27 — Frontend monolitico (1 arquivo HTML com tudo)
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `public/index.html` tem ~1200+ linhas com CSS, HTML e JS inline. Dificil de manter, testar e escalar. Mudancas arriscam quebrar funcionalidades nao relacionadas |
| **Impacto** | Produtividade no frontend; impossivel ter testes de UI; conflitos em merge |
| **Arquivo** | `public/index.html` |
| **Solucao** | (1) Separar em `styles.css`, `app.js`, `api.js`, `components.js`, (2) Opcionalmente migrar para framework leve (Vue/Svelte CDN), (3) Manter deploy como static web app |
| **Criterio** | Frontend funciona identicamente com arquivos separados; JS e CSS sao cacheaveis separadamente |

---

### PILAR 4 — AVISOS (Seguranca, Monitoramento e Alertas)

---

#### GAP #28 — RBAC inexistente (so autentica, nao autoriza)
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Auth middleware valida o token mas nao verifica ROLES. Qualquer usuario autenticado pode aprovar, rejeitar, limpar dados, ver relatorios. Sem distincao analista/gestor/admin |
| **Impacto** | Estagiario pode executar `clear_all`; sem segregacao de funcoes (principio contabil basico) |
| **Arquivos** | `src/shared/auth.ts`, todos endpoints em `src/functions/*.ts` |
| **Solucao** | (1) Definir roles: `analyst` (ve e classifica), `approver` (aprova/rejeita), `admin` (cadastros + clear_all), (2) Extrair roles do token AAD (`roles` claim), (3) Criar `requireRole('approver')` middleware |
| **Criterio** | Usuario com role `analyst` recebe 403 ao tentar aprovar; `approver` consegue |

---

#### GAP #29 — CSP inseguro com `unsafe-inline`
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | `staticwebapp.config.json:67` define `script-src 'unsafe-inline'` — permite execucao de qualquer script inline, anulando a protecao contra XSS |
| **Impacto** | Se um atacante injetar script via campo de descricao, ele executa no browser do analista |
| **Arquivo** | `public/staticwebapp.config.json` |
| **Solucao** | (1) Mover JS inline para `app.js` externo, (2) Usar `nonce` ou `hash` no CSP para scripts que precisam ser inline, (3) Remover `unsafe-inline` do CSP |
| **Criterio** | CSP nao contem `unsafe-inline`; aplicacao funciona normalmente |

---

#### GAP #30 — Sem rate limiting
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Nenhum endpoint tem rate limiting. Um ator malicioso pode chamar `/api/guardianSync` 1000x/min, gerando custos no Azure e potencialmente corrompendo dados com syncs simultaneos |
| **Impacto** | DDoS no Azure Functions (custo por execucao); sync concorrente pode gerar duplicatas |
| **Arquivos** | Todos endpoints, `host.json` |
| **Solucao** | (1) Implementar rate limiter in-memory com sliding window: 10 req/min para sync, 30 req/min para dashboard, 5 req/min para approve, (2) Configurar `maxConcurrentRequests` no `host.json`, (3) Retornar 429 (Too Many Requests) com `Retry-After` header |
| **Criterio** | 11a chamada ao sync em 1 minuto retorna 429 |

---

#### GAP #31 — Logs sem estrutura (console.log puro)
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `createLogger()` em `utils.ts` usa `console.log/warn/error` com formato textual. Sem correlation ID, sem metadata estruturada, sem integracao com Application Insights |
| **Impacto** | Impossivel rastrear uma requisicao de ponta a ponta; debug em producao e tentativa e erro |
| **Arquivo** | `src/shared/utils.ts` |
| **Solucao** | (1) Logger emitir JSON estruturado: `{timestamp, level, label, message, correlationId, ...meta}`, (2) Propagar `invocationId` do Azure Functions como correlation ID, (3) Integrar com Application Insights custom events |
| **Criterio** | Log de uma requisicao contem `correlationId` que permite rastrear toda a cadeia (sync → classify → audit → persist) |

---

#### GAP #32 — Sem health check endpoint
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | Nao existe `/api/health` para monitoramento. CI/CD deploya sem verificar se o sistema esta funcional. Azure App Insights nao tem endpoint custom para verificar dependencias |
| **Arquivo** | Nao existe |
| **Solucao** | Criar `guardianHealth.ts` que verifica: (1) Table Storage acessivel, (2) Inter API respondendo, (3) Kimi AI configurado, (4) Graph API token valido. Retornar `{status: 'healthy', checks: {...}, version: '1.1.0'}` |
| **Criterio** | `GET /api/health` retorna 200 com status de cada dependencia; CI/CD verifica apos deploy |

---

#### GAP #33 — Sem backup / disaster recovery
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Azure Table Storage nao tem backup configurado. Se a storage account for deletada ou corrompida, TODOS os dados financeiros sao perdidos irreversivelmente |
| **Impacto** | Perda total de: transacoes, regras de aprendizado, audit log, cadastros, configuracoes |
| **Arquivo** | Nao existe mecanismo |
| **Solucao** | (1) Criar timer trigger semanal que exporta todas as tabelas para Azure Blob (JSON), (2) Habilitar geo-replicacao (RA-GRS) na storage account, (3) Criar runbook de recovery documentado |
| **Criterio** | Backup semanal gera arquivo JSON no blob; recovery restaura 100% dos dados |

---

#### GAP #34 — Pipeline CI/CD sem quality gates
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `.github/workflows/main_guardian_deploy.yml` roda test + build mas sem: coverage report, lint, audit de seguranca, health check pos-deploy, staging environment |
| **Impacto** | Codigo sem lint pode ter bugs sutis; deploy direto em producao sem staging; sem metricas de cobertura |
| **Arquivo** | `.github/workflows/main_guardian_deploy.yml` |
| **Solucao** | (1) Adicionar `npm audit --audit-level=moderate`, (2) Adicionar `npm run lint`, (3) Cobertura minima 60%, (4) Health check pos-deploy, (5) Deploy em staging antes de prod |
| **Criterio** | PR com vulnerabilidade conhecida nao passa no CI; cobertura abaixo de 60% bloqueia merge |

---

#### GAP #35 — Testes cobrem somente core logic (~35% do codigo)
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | 31 testes cobrem: utils, types, agents, parsers, areas storage, e2e pipeline. Mas ZERO testes para: 11 HTTP endpoints, auth middleware, DRE/DFC calculations, learning system edge cases, audit log |
| **Impacto** | Regressoes nao sao detectadas; refactoring e arriscado; DRE pode ter bug e ninguem percebe |
| **Arquivo** | `test/guardian.test.ts` |
| **Solucao** | Adicionar testes para: (1) Auth middleware (token valido/invalido/expirado/sem header), (2) Approve handler (approve/reject/reclassify/clear_all com validacao), (3) DRE calculation (cenarios com valores zerados, negativos, sem categorias), (4) Forecast com 0/1/6+ meses de historico, (5) Notify payload builder |
| **Criterio** | 60+ testes; cobertura de todos os handlers HTTP; zero regressoes |

---

#### GAP #36 — Endpoints GET sensíveis acessiveis sem auth no SWA
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | `staticwebapp.config.json` permite `["anonymous", "authenticated"]` em `/api/guardianStatus`, `/api/guardianReports`, `/api/guardianAreas/*` GET. Embora o middleware de auth exija token, a Static Web App pode servir como proxy sem autenticacao quando AAD nao esta configurado |
| **Impacto** | Dados financeiros visiveis sem login quando auth nao esta ativo |
| **Arquivo** | `public/staticwebapp.config.json` |
| **Solucao** | Trocar todas as routes para `["authenticated"]` exceto `/.auth/login/aad` e health check |
| **Criterio** | Todas rotas `/api/*` exigem `authenticated` no SWA config |

---

## Matriz de Prioridade

```
              ALTO IMPACTO
                  │
  #21 (Dedup)     │  #15 (Schema)    #28 (RBAC)
  #33 (Backup)    │  #24 (Export)    #36 (SWA Auth)
  #19 (ClassMap)  │  #25 (Periodo)   #35 (Testes)
  #30 (RateLimit) │  #29 (CSP)
                  │
ALTO ─────────────┼──────────────────── BAIXO
ESFORCO           │                     ESFORCO
                  │
  #20 (DRE Unif)  │  #22 (GetById)   #17 (Dedup Email)
  #27 (Frontend)  │  #31 (Logs)      #16 (Retry)
  #34 (CI/CD)     │  #32 (Health)    #23 (Decay)
                  │  #26 (DRE Comp)  #18 (Upload Lim)
                  │
              BAIXO IMPACTO
```

---

## Organizacao em Ondas

### Onda 4 — Integridade de Dados (Urgente)

| # | Gap | Pilar | Esforco |
|---|-----|-------|---------|
| 21 | Deduplicacao de sync | Tratamento | Medio |
| 15 | Validacao de schema (zod) | Captacao | Medio |
| 20 | DRE/DFC/Forecast unificados | Tratamento | Baixo |
| 22 | getAuthorizationById O(1) | Tratamento | Baixo |
| 36 | SWA routes → authenticated | Avisos | Baixo |

**Resultado:** Dados confiaveis, sem duplicatas, sem divergencia DRE, performance otimizada.

---

### Onda 5 — Seguranca e Observabilidade

| # | Gap | Pilar | Esforco |
|---|-----|-------|---------|
| 28 | RBAC (analyst/approver/admin) | Avisos | Medio |
| 29 | CSP sem unsafe-inline | Avisos | Medio |
| 30 | Rate limiting | Avisos | Medio |
| 32 | Health check endpoint | Avisos | Baixo |
| 31 | Logs estruturados + correlation ID | Avisos | Medio |
| 35 | Cobertura de testes 60%+ | Avisos | Alto |

**Resultado:** Sistema seguro em producao, rastreavel, monitoravel, testado.

---

### Onda 6 — Poder Analitico

| # | Gap | Pilar | Esforco |
|---|-----|-------|---------|
| 25 | Filtro de periodo (mes/trimestre/ano) | Relatorios | Medio |
| 24 | Exportacao PDF/Excel | Relatorios | Alto |
| 26 | DRE comparativo (Real vs Orcado) | Relatorios | Medio |
| 19 | Classificacao vinculada ao cadastro | Tratamento | Medio |
| 23 | Decay temporal no learning | Tratamento | Baixo |

**Resultado:** Analista com ferramentas de controller: compara, exporta, apresenta.

---

### Onda 7 — Resiliencia e Escala

| # | Gap | Pilar | Esforco |
|---|-----|-------|---------|
| 33 | Backup + disaster recovery | Avisos | Alto |
| 34 | CI/CD com quality gates | Avisos | Medio |
| 16 | Retry + circuit breaker (Inter) | Captacao | Medio |
| 17 | Deduplicacao email | Captacao | Medio |
| 18 | Limite upload (tamanho + tipo) | Captacao | Baixo |
| 27 | Modularizacao frontend | Relatorios | Alto |

**Resultado:** Sistema resistente a falhas, com deploy seguro e frontend sustentavel.

---

## Resumo por Pilar

| Pilar | Gaps Existentes | Gaps Novos | Status |
|-------|----------------|------------|--------|
| **Captacao** | 5 (OFX, CSV, email, batch, upload) | 4 (#15, #16, #17, #18) | Funcional mas fragil |
| **Tratamento** | 6 (classif, audit, reconc, learning, competencia, areas) | 5 (#19, #20, #21, #22, #23) | Inteligente mas com riscos de integridade |
| **Relatorios** | 3 (DRE, DFC, forecast) | 4 (#24, #25, #26, #27) | Basico — falta exportacao e filtros |
| **Avisos** | 1 (notificacao timer) | 8 (#28-#35, #36) | Critico — seguranca e observabilidade fracas |

---

## Arquivos Impactados (Consolidado)

| Arquivo | Gaps Novos |
|---------|-----------|
| `src/functions/guardianSync.ts` | #21 |
| `src/functions/guardianApprove.ts` | #15, #22 |
| `src/functions/guardianReports.ts` | #20, #25 |
| `src/functions/guardianDashboard.ts` | #20, #25, #26 |
| `src/functions/guardianUpload.ts` | #15, #18 |
| `src/functions/guardianImport.ts` | #15, #18 |
| `src/guardian/guardianAgents.ts` | #19, #23 |
| `src/guardian/interConnector.ts` | #16 |
| `src/guardian/emailListener.ts` | #17 |
| `src/shared/utils.ts` | #31 |
| `src/shared/auth.ts` | #28 |
| `src/shared/financial.ts` (novo) | #20 |
| `src/functions/guardianHealth.ts` (novo) | #32 |
| `src/functions/guardianBackup.ts` (novo) | #33 |
| `public/staticwebapp.config.json` | #29, #36 |
| `public/index.html` | #24, #25, #27 |
| `.github/workflows/main_guardian_deploy.yml` | #34 |
| `test/guardian.test.ts` | #35 |
| `host.json` | #30 |
| `package.json` | #15 (zod), #24 (pdfmake/exceljs) |

---

*Documento gerado em 2026-02-22. Mapeamento V2 pos 14 gaps originais.*
