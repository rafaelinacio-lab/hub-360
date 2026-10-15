// ── equipesTipo.js — a que "tipo" pertence cada equipe do Movidesk ─────────────────────────────────────────
// Tabela única usada nas visões do Painel Geral (Suporte Técnico, Produto, …). Para mudar uma equipe de tipo, é só editar a lista abaixo.
// Tipos: franquia | interno | produto | servicos | suporte | depende.
//   "depende" = o tipo muda conforme a classificação do chamado (regra em hubTipoEquipe): classificação Suporte Técnico → suporte;
//   qualquer outra classificação → produto.
(function () {
    var LISTA = {
        depende: ['Analytics - B.I', 'VIASOFT - Suporte Oracle Cloud', 'VIASOFT - Tecnologia'],
        franquia: ['FRANQUIA - AD TECH NEGOCIOS LTDA', 'FRANQUIA - Borges e Mazete - Suporte', 'FRANQUIA - Cands - Suporte', 'FRANQUIA - LZ - Suporte',
            'FRANQUIA - MP AGROTECH - Suporte', 'FRANQUIA - PRODACON - Consultores', 'FRANQUIA - PRODACON - Suporte'],
        interno: ['Administradores', 'Agente', 'Curadoria IA', 'Financeiro - VIASOFT', 'GCC - Gestão de Combate ao Churn', 'Ouvidoria', 'VIABOT - Adm', 'VIASOFT - Canais',
            'VIASOFT - Comitê de IA', 'VIASOFT - HOK', 'VIASOFT - Migrações', 'VIASOFT - Sistemas Internos', 'VIASOFT - Support Leaders', 'VIASOFT - Tático', 'VIASOFT - TESTE INTERNO'],
        produto: ['Agrotitan - Equipe Técnica', 'Agrotitan Fazendas - Equipe Técnica', 'Automação Comercial - Equipe Técnica', 'Construshow - Equipe Técnica', 'CRM - Equipe Técnica',
            'Filt - Equipe Técnica', 'Petroshow - Equipe Técnica', 'Serviços Fiscais - Equipe Técnica', 'TalentRH - Equipe Técnica', 'Viasuper - Equipe Técnica', 'VOORS - Equipe Técnica'],
        servicos: ['VX - Agrotitan', 'VX - Agrotitan Fazendas', 'VX - Construshow', 'VX - CRM', 'VX - Filt', 'VX - Fisco/Talent', 'VX - Petroshow', 'VX - Voors'],
        suporte: ['Agrotitan - Suporte', 'Agrotitan Fazendas - Suporte', 'Aut. Comercial - Suporte', 'Construshow - Suporte', 'CRM - Suporte', 'Filt - Suporte', 'Petroshow - Suporte',
            'Serviços Fiscais - Suporte', 'TalentRH - Suporte', 'Viasuper - Suporte', 'Voors - Suporte']
    };
    var norm = function (t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); };
    var MAPA = {};
    Object.keys(LISTA).forEach(function (tipo) { LISTA[tipo].forEach(function (nome) { MAPA[norm(nome)] = tipo; }); });
    // Tipo da equipe ('' se a equipe não está na tabela). Para equipes "depende", a classificação do chamado decide.
    window.hubTipoEquipe = function (equipe, classificacao) {
        var t = MAPA[norm(equipe)] || '';
        if (t !== 'depende') return t;
        return norm(classificacao) === 'suporte tecnico' ? 'suporte' : 'produto';
    };
    window.HUB_EQUIPES_TIPO = LISTA;
})();
