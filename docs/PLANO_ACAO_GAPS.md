# Plano de Acao — 14 Gaps Identificados no Processo do Analista Financeiro

> Documento gerado a partir da analise BPMN do sistema Guardian.
> Data: 2026-02-22 | Versao: 1.0

---

## Resumo Executivo

Foram identificados **14 gaps** no processo do analista financeiro apos mapeamento completo
do fluxo BPMN do Guardian. Este plano organiza a correcao em **3 ondas** por prioridade,
com responsavel, arquivos impactados, criterio de aceite e status de execucao.

---

## Onda 1 — Quick Wins (Impacto imediato, baixo esforco)

### GAP #7 — Orcamentos hardcoded na auditoria
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `audit()` usa um map hardcoded de budgets em vez dos `orcamentoMensal` cadastrados nas categorias |
| **Arquivo** | `src/guardian/guardianAgents.ts` — metodo `audit()` (linha ~458) |
| **Solucao** | Carregar categorias da tabela `GuardianCategorias` e montar o map de budgets dinamicamente |
| **Criterio de Aceite** | Alterar orcamento de uma categoria via `/api/guardianCadastros/categorias` e ver o novo limite refletido na auditoria |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #11 — `clear_all` sem confirmacao
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Endpoint `clear_all` apaga TODOS os dados sem nenhuma verificacao adicional |
| **Arquivo** | `src/functions/guardianApprove.ts` — bloco `clear_all` (linha ~32) |
| **Solucao** | Exigir campo `confirm: true` no body. Sem ele, retornar 400 com aviso |
| **Criterio de Aceite** | POST sem `confirm: true` retorna erro 400; POST com `confirm: true` executa normalmente |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #13 — Aprendizado sem protecao contra over-generalization
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | Descricoes curtas (1-2 tokens significativos) podem gerar regras genéricas demais que classificam erroneamente |
| **Arquivo** | `src/guardian/guardianAgents.ts` — metodo `learn()` (linha ~110) |
| **Solucao** | Exigir minimo de 2 tokens significativos para criar uma regra. Se < 2, logar warning e nao criar |
| **Criterio de Aceite** | Aprovar transacao com descricao "PIX ENVIADO" (0 tokens uteis) nao deve criar learning rule |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #12 — Cache de categorias no dashboard nao invalida apos POST
| Item | Detalhe |
|------|---------|
| **Severidade** | BAIXA |
| **Problema** | Dashboard cacheia categorias por 5 min; apos criar/editar categoria, dashboard mostra dados antigos |
| **Arquivo** | `src/functions/guardianDashboard.ts` |
| **Solucao** | Reduzir TTL do cache para 1 min OU invalidar cache no POST de cadastros |
| **Criterio de Aceite** | Criar nova categoria e ver refletida no dashboard sem precisar esperar 5 min |
| **Status** | [x] Concluido (2026-02-22) |

---

## Onda 2 — Medio Prazo (Correcoes estruturais)

### GAP #1 — Sem trilha de auditoria
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Aprovacoes/rejeicoes atualizam in-place, sem historico de quem/quando/o que mudou |
| **Arquivos** | `src/storage/tableClient.ts`, `src/functions/guardianApprove.ts`, `src/shared/types.ts` |
| **Solucao** | Criar tabela `GuardianAuditLog` com registro: `{id, authId, acao, antes, depois, timestamp, usuario}`. Inserir log em cada approve/reject/reclassify |
| **Criterio de Aceite** | Apos aprovar uma transacao, consultar `/api/guardianStatus?status=all` e ver campo `auditLog` com historico completo |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #3 — Reconciliacao fragil
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `reconcile()` faz match apenas por valor (+-R$0.01), sem validar data ou fornecedor. Pode gerar falsos positivos |
| **Arquivo** | `src/guardian/guardianAgents.ts` — metodo `reconcile()` (linha ~493) |
| **Solucao** | Adicionar criterios: (1) data dentro de +-3 dias, (2) match parcial de tokens do fornecedor. Score composto: valor=50%, data=30%, fornecedor=20% |
| **Criterio de Aceite** | Duas transacoes com mesmo valor mas datas distantes (>7 dias) NAO devem ser reconciliadas |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #5 — OFX/CSV nao sao parseados
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `extractWithAI()` usa modelo `prebuilt-invoice` do Form Recognizer, que nao funciona para OFX (extrato bancario XML) nem CSV |
| **Arquivos** | `src/guardian/guardianAgents.ts` — metodo `extractData()` |
| **Solucao** | Criar parsers dedicados: (1) `parseOFX()` — extrair transacoes do XML OFX e mapear para `InterTransaction[]`, (2) `parseCSV()` — detectar colunas (data, descricao, valor, tipo) e mapear |
| **Criterio de Aceite** | Upload de arquivo .ofx gera transacoes classificadas corretamente |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #14 — Sem regime de competencia real
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | `dataCompetencia` e sempre calculado como 1o dia do mes da transacao. Analista nao consegue lancar despesa de jan em fev |
| **Arquivos** | `src/shared/types.ts` — `toGuardianAuth()`, `src/functions/guardianApprove.ts`, `public/index.html` |
| **Solucao** | (1) No frontend, ao aprovar/reclassificar, permitir que o analista selecione o mes de competencia. (2) No approve, aceitar `dataCompetencia` como override |
| **Criterio de Aceite** | Analista consegue aprovar transacao de fev/2026 e atribuir competencia a jan/2026 |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #4 — Documentos de email nao sao persistidos
| Item | Detalhe |
|------|---------|
| **Severidade** | MEDIA |
| **Problema** | Email attachments geram URLs ficticias (`stguardian.blob.core.windows.net/mailbox/{uuid}`), mas o conteudo nunca e baixado/armazenado |
| **Arquivos** | `src/guardian/emailListener.ts` |
| **Solucao** | (1) Baixar conteudo do attachment via Graph API (`/messages/{id}/attachments/{attId}/$value`), (2) Upload para Azure Blob Storage, (3) Usar URL real do blob no `extractData()` |
| **Criterio de Aceite** | Email com PDF anexo gera blob real no storage e Form Recognizer consegue processar |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #9 — Sem processamento batch
| Item | Detalhe |
|------|---------|
| **Severidade** | BAIXA |
| **Problema** | `guardianSync` processa transacoes sequencialmente. Com 1000+ transacoes, pode dar timeout (10 min max Azure Functions) |
| **Arquivo** | `src/functions/guardianSync.ts` |
| **Solucao** | Processar em chunks de 50 com `Promise.all()`. Kimi AI limitar a 5 chamadas paralelas (rate limit) |
| **Criterio de Aceite** | Sync de 500 transacoes completa em < 2 minutos |
| **Status** | [x] Concluido (2026-02-22) |

---

## Onda 3 — Longo Prazo (Evolucoes estrategicas)

### GAP #2 — Sem autenticacao
| Item | Detalhe |
|------|---------|
| **Severidade** | ALTA |
| **Problema** | Todos os endpoints sao `authLevel: 'anonymous'`. Qualquer pessoa com a URL acessa dados financeiros |
| **Arquivos** | Todos os arquivos em `src/functions/*.ts`, `.github/workflows/main_guardian_deploy.yml` |
| **Solucao** | (1) Configurar Azure AD (Entra ID) como identity provider, (2) Mudar `authLevel: 'anonymous'` para `'function'` com validacao de token, (3) No frontend, implementar login com MSAL.js |
| **Dependencia** | `AAD_CLIENT_ID` e `AAD_CLIENT_SECRET` ja existem no `local.settings.json` (vazios) |
| **Criterio de Aceite** | Acesso sem token retorna 401. Login com Azure AD permite acesso normal |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #6 — Forecast ingenuo
| Item | Detalhe |
|------|---------|
| **Severidade** | BAIXA |
| **Problema** | Projecao 6 meses usa 3% fixo de crescimento e 50% de crescimento de despesas. Sem sazonalidade nem variancia |
| **Arquivo** | `src/functions/guardianDashboard.ts` — `buildForecast()` |
| **Solucao** | (1) Calcular media movel dos ultimos 6 meses, (2) Aplicar desvio padrao para range otimista/pessimista, (3) Opcionalmente usar Kimi para analise de tendencia |
| **Criterio de Aceite** | Forecast mostra 3 cenarios (otimista, realista, pessimista) baseados em dados historicos |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #8 — Areas desconectadas do financeiro
| Item | Detalhe |
|------|---------|
| **Severidade** | BAIXA |
| **Problema** | Modulos Operacoes/Marketing/Comercial existem mas nao se integram com dados financeiros. Nao ha P&L por projeto/campanha |
| **Arquivos** | `src/functions/guardianAreas.ts`, `src/functions/guardianDashboard.ts` |
| **Solucao** | (1) Adicionar campo `projetoId` / `campanhaId` nas autorizacoes, (2) Permitir vincular transacao a projeto na aprovacao, (3) Calcular P&L por projeto/campanha no dashboard |
| **Criterio de Aceite** | Analista vincula despesa a projeto e ve margem do projeto no painel |
| **Status** | [x] Concluido (2026-02-22) |

---

### GAP #10 — Sem notificacoes proativas
| Item | Detalhe |
|------|---------|
| **Severidade** | BAIXA |
| **Problema** | Analista precisa acessar o painel manualmente para ver transacoes pendentes |
| **Arquivos** | Novo arquivo `src/functions/guardianNotify.ts` |
| **Solucao** | (1) Timer trigger diario (8h) que verifica pendencias, (2) Enviar alerta via Microsoft Teams webhook ou email (Graph API), (3) Resumo: X pendentes, Y acima do orcamento, Z nao classificadas |
| **Criterio de Aceite** | Analista recebe mensagem no Teams as 8h com resumo de pendencias |
| **Status** | [x] Concluido (2026-02-22) |

---

## Matriz de Impacto vs Esforco

```
           ALTO IMPACTO
               |
    GAP #2     |  GAP #1    GAP #11
    (Auth)     |  (Audit)   (Confirm)
               |
ALTO ──────────┼────────────── BAIXO
ESFORCO        |               ESFORCO
               |
    GAP #8     |  GAP #7    GAP #13
    (Areas)    |  (Budget)  (Tokens)
    GAP #10    |  GAP #12
    (Notify)   |  (Cache)
               |
           BAIXO IMPACTO
```

---

## Cronograma Sugerido

| Onda | Gaps | Estimativa | Sprint |
|------|------|-----------|--------|
| **Onda 1** | #7, #11, #13, #12 | 1 sprint | Sprint atual |
| **Onda 2** | #1, #3, #5, #14, #4, #9 | 2-3 sprints | Proximo ciclo |
| **Onda 3** | #2, #6, #8, #10 | 3-4 sprints | Roadmap Q2 |

---

## Arquivos Impactados (Consolidado)

| Arquivo | Gaps |
|---------|------|
| `src/guardian/guardianAgents.ts` | #3, #5, #7, #13 |
| `src/functions/guardianApprove.ts` | #1, #11, #14 |
| `src/functions/guardianDashboard.ts` | #6, #8, #12 |
| `src/functions/guardianSync.ts` | #9 |
| `src/guardian/emailListener.ts` | #4 |
| `src/storage/tableClient.ts` | #1 |
| `src/shared/types.ts` | #1, #14 |
| `src/functions/guardianAreas.ts` | #8 |
| `src/functions/*.ts` (todos) | #2 |
| `public/index.html` | #2, #14 |
| `src/functions/guardianNotify.ts` (novo) | #10 |

---

## Como Acompanhar

Cada gap resolvido deve:
1. Ter seu `[ ]` marcado como `[x]` neste documento
2. Ser commitado com mensagem: `fix(gap-XX): descricao curta`
3. Ter teste cobrindo o criterio de aceite

---

*Documento vivo — atualizar conforme gaps forem resolvidos.*
