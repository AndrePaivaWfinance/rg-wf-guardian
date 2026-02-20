/**
 * Guardian Areas — Operations, Marketing & Commercial types
 */

export type AreaType = 'operacoes' | 'marketing' | 'comercial';

// ============ OPERATIONS ============

export interface OperacoesProject {
    id: string;
    nome: string;
    cliente: string;
    responsavel: string;
    status: 'backlog' | 'em_andamento' | 'concluido' | 'bloqueado';
    prioridade: 'baixa' | 'media' | 'alta' | 'critica';
    dataInicio: string;
    dataPrevisao: string;
    dataConclusao?: string;
    progresso: number; // 0-100
    horasEstimadas: number;
    horasRealizadas: number;
    valorContrato: number;
    tags: string[];
}

export interface OperacoesKPIs {
    projetosAtivos: number;
    projetosConcluidos: number;
    projetosBloqueados: number;
    taxaEntrega: string; // percentage
    utilizacaoEquipe: string;
    horasTotais: number;
    horasRealizadas: number;
    slaAtingido: string;
    ticketMedioContrato: number;
}

export interface OperacoesData {
    projects: OperacoesProject[];
    kpis: OperacoesKPIs;
}

// ============ MARKETING ============

export interface MarketingCampaign {
    id: string;
    nome: string;
    canal: 'google_ads' | 'meta_ads' | 'linkedin' | 'email' | 'organico' | 'eventos' | 'indicacao';
    status: 'planejada' | 'ativa' | 'pausada' | 'finalizada';
    orcamento: number;
    gastoAtual: number;
    dataInicio: string;
    dataFim?: string;
    leads: number;
    conversoes: number;
    impressoes: number;
    cliques: number;
    cpl: number; // custo por lead
    cpa: number; // custo por aquisicao
    roi: number; // retorno sobre investimento %
}

export interface MarketingKPIs {
    campanhasAtivas: number;
    totalLeads: number;
    totalConversoes: number;
    taxaConversao: string;
    cplMedio: number;
    cpaMedio: number;
    roiMedio: string;
    investimentoTotal: number;
    receitaGerada: number;
}

export interface MarketingData {
    campaigns: MarketingCampaign[];
    kpis: MarketingKPIs;
}

// ============ COMMERCIAL ============

export interface ComercialDeal {
    id: string;
    empresa: string;
    contato: string;
    servico: string;
    estagio: 'prospeccao' | 'qualificacao' | 'proposta' | 'negociacao' | 'fechado_ganho' | 'fechado_perdido';
    valor: number;
    recorrencia: 'unico' | 'mensal' | 'trimestral' | 'anual';
    probabilidade: number; // 0-100
    responsavel: string;
    dataCriacao: string;
    dataPrevisaoFechamento: string;
    dataFechamento?: string;
    motivoPerda?: string;
    origem: 'inbound' | 'outbound' | 'indicacao' | 'evento';
}

export interface ComercialKPIs {
    pipelineTotal: number; // valor total do pipeline
    pipelinePonderado: number; // valor * probabilidade
    dealsAtivos: number;
    dealsFechadosGanho: number;
    dealsFechadosPerdido: number;
    taxaConversao: string;
    ticketMedio: number;
    cicloMedioVenda: number; // dias
    receitaFechadaMes: number;
    previsaoReceita: number; // prox 30 dias
}

export interface ComercialData {
    deals: ComercialDeal[];
    kpis: ComercialKPIs;
}

// ============ CADASTROS ============

/**
 * DRE por Margem de Contribuicao
 *
 * (+) Receita Bruta ................... RECEITA_DIRETA
 * (-) Deducoes s/ Receita ............. (impostos ~9.25%)
 * (=) Receita Liquida
 * (-) Custos e Despesas Variaveis ..... CUSTO_VARIAVEL
 * (=) MARGEM DE CONTRIBUICAO (MC)
 *     Indice MC = MC / RL
 * (-) Custos e Despesas Fixos ......... CUSTO_FIXO
 * (=) RESULTADO OPERACIONAL
 * (+) Receitas Financeiras ............ RECEITA_FINANCEIRA
 * (-) Despesas Financeiras ............ DESPESA_FINANCEIRA
 * (=) Resultado Antes do IR
 * (-) IR/CSLL ......................... (~34%)
 * (=) RESULTADO LIQUIDO
 *
 * Ponto de Equilibrio = Custos Fixos / Indice MC
 */
export type CategoriaTipo =
    | 'RECEITA_DIRETA'
    | 'RECEITA_FINANCEIRA'
    | 'CUSTO_VARIAVEL'
    | 'CUSTO_FIXO'
    | 'DESPESA_FINANCEIRA'
    | 'TRANSFERENCIA_INTERNA';

/** Grupo contabil dentro do DRE para sub-agrupamento */
export type CategoriaGrupo =
    // Receitas
    | 'Receita de Servicos'
    | 'Outras Receitas Operacionais'
    | 'Rendimentos Financeiros'
    | 'Juros Ativos'
    // Custos/Despesas Variaveis
    | 'Subcontratacao'
    | 'Infraestrutura Variavel'
    | 'Comissoes'
    | 'Marketing Performance'
    | 'Impostos Variaveis'
    | 'Insumos e Materiais'
    // Custos/Despesas Fixos
    | 'Pessoal'
    | 'Ocupacao'
    | 'Utilidades'
    | 'Assinaturas e Licencas'
    | 'Servicos Terceirizados'
    | 'Administrativo'
    // Despesas Financeiras
    | 'Juros e Encargos'
    | 'Tarifas Bancarias'
    | 'Outros'
    // Transferencias Internas (nao impacta DRE)
    | 'Movimentacao Interna';

export interface Categoria {
    id: string;
    nome: string;
    tipo: CategoriaTipo;
    grupo: CategoriaGrupo;
    orcamentoMensal: number;
    ativa: boolean;
    criadoEm: string;
}

export type CadastroType = 'categorias' | 'contas' | 'clientes' | 'fornecedores';

// ============ UNIFIED ============

export interface AreaResponse {
    area: AreaType;
    generatedAt: string;
    data: OperacoesData | MarketingData | ComercialData;
}
