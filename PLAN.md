# Plano — Cadastros Operacionais (Aba Semanal)

Implementacao incremental: um modulo por vez, testar, e avancar.

---

## Etapa 1: Categorias Editaveis

**Backend:**
- Nova tabela `GuardianCategorias` no areaTableClient
- Interface `Categoria { id, nome, tipo: 'receita'|'despesa'|'investimento'|'financiamento', orcamentoMensal, ativa, criadoEm }`
- CRUD via `guardianCadastros` endpoint (POST /api/guardianCadastros/categorias)
- Seed de categorias padrao baseadas nas que ja existem no classificador
- Ao aprovar/reclassificar transacao, usar lista de categorias do banco

**Frontend (aba Semanal):**
- Secao "Categorias" com tabela: nome, tipo, orcamento, status
- Botoes: + Nova, Editar (inline ou modal), Desativar
- Dropdown de reclassificacao na aprovacao usa categorias do banco

---

## Etapa 2: Contas Correntes

**Backend:**
- Nova tabela `GuardianContasCorrentes`
- Interface `ContaCorrente { id, banco, agencia, conta, tipo: 'PJ'|'PF', apelido, saldoInicial, dataSaldoInicial, saldoAtual, status: 'ativa'|'arquivada', criadoEm }`
- CRUD via `guardianCadastros/contas`
- Saldo atual = saldoInicial + sum(entradas) - sum(saidas) desde dataSaldoInicial
- Conta Inter PJ pre-cadastrada com saldo via API Inter

**Frontend (aba Semanal):**
- Secao "Contas Correntes" com cards por conta (similar ao patrimonio)
- Modal: adicionar/editar conta com campos banco, agencia, conta, saldo inicial, data ref
- Botao arquivar (soft delete)
- Visao patrimonial na Home atualizada para usar contas do banco

---

## Etapa 3: Clientes

**Backend:**
- Nova tabela `GuardianClientes`
- Interface `Cliente { id, nome, cnpjCpf, contato, email, telefone, segmento, status: 'ativo'|'inativo'|'prospect', dealIds[], receitaTotal, criadoEm }`
- CRUD via `guardianCadastros/clientes`
- Vinculacao com ComercialDeal: quando deal fecha_ganho, cria/atualiza cliente
- Transacoes de receita podem ser vinculadas a um cliente

**Frontend (aba Semanal):**
- Secao "Clientes" com tabela: nome, CNPJ, segmento, receita total, status
- Modal: adicionar/editar cliente
- Link para deals do comercial

---

## Etapa 4: Fornecedores

**Backend:**
- Nova tabela `GuardianFornecedores`
- Interface `Fornecedor { id, nome, cnpjCpf, contato, email, telefone, categoriaServico, status: 'ativo'|'inativo'|'bloqueado', despesaTotal, criadoEm }`
- CRUD via `guardianCadastros/fornecedores`
- Vinculacao com transacoes de saida (PIX/boleto)

**Frontend (aba Semanal):**
- Secao "Fornecedores" com tabela: nome, CNPJ, categoria, despesa total, status
- Modal: adicionar/editar fornecedor

---

## Ordem de execucao

1. **Categorias** → build → test → deploy → validar
2. **Contas Correntes** → build → test → deploy → validar
3. **Clientes** → build → test → deploy → validar
4. **Fornecedores** → build → test → deploy → validar

Cada etapa: backend (types + storage + endpoint) → frontend (UI + modais) → testes → deploy
