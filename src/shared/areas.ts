/**
 * Guardian Areas — Operations, Marketing & Commercial types
 */

export type AreaType = 'operacoes' | 'marketing' | 'comercial' | 'investimentos';

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

// ============ INVESTMENTS ============

export type InvestmentAccountType = 'CDB' | 'LCI' | 'LCA' | 'FUNDO' | 'TESOURO';

export type InvestmentMovementType =
    | 'JUROS'
    | 'IMPOSTO_IR'
    | 'IOF'
    | 'TRANSFERENCIA_PARA_CC'
    | 'TRANSFERENCIA_DA_CC'
    | 'APLICACAO'
    | 'RESGATE';

export interface InvestmentAccount {
    id: string;
    nome: string;
    tipo: InvestmentAccountType;
    banco: string;
    saldoInicial: number;
    saldoAtual: number;
    dataAbertura: string;
    taxaContratada: string;
    ativo: boolean;
}

export interface InvestmentMovement {
    id: string;
    contaId: string;
    data: string;
    tipo: InvestmentMovementType;
    valor: number;
    descricao: string;
}

export interface InvestmentKPIs {
    totalInvestido: number;
    rendimentoAcumulado: number;
    impostosTotais: number;
    rendimentoLiquido: number;
    rentabilidadeMedia: string;
    contasAtivas: number;
}

export interface InvestmentData {
    accounts: InvestmentAccount[];
    movements: InvestmentMovement[];
    kpis: InvestmentKPIs;
}

// ============ CADASTROS ============

export type CategoriaTipo = 'receita' | 'despesa' | 'investimento' | 'financiamento';

export interface Categoria {
    id: string;
    nome: string;
    tipo: CategoriaTipo;
    orcamentoMensal: number;
    ativa: boolean;
    criadoEm: string;
}

export type CadastroType = 'categorias' | 'contas' | 'clientes' | 'fornecedores';

// ============ UNIFIED ============

export interface AreaResponse {
    area: AreaType;
    generatedAt: string;
    data: OperacoesData | MarketingData | ComercialData | InvestmentData;
}
