# Arquitetura

## Visão geral

```
Navegador ──HTTPS──▶ Express (server/server.js)
                     ├─ estáticos: /css /js /pages, index.html, login.html, /admin
                     ├─ /api/*  (server/routes/*.js)
                     ├─ cargas Movidesk (server/scripts/movidesk-loader.js)
                     │    agendadas por silver.cron_job (server/scripts/cron-manager.js)
                     └─ Postgres ── tabelas do painel (users, sessions, config, …)
                                 └─ datalake bronze/silver/gold (silver.ticket, …)
```

A aplicação é um shell (`index.html`) com as abas carregadas em iframes de
`pages/*.html`. Todas as páginas falam com `/api` mandando o token da sessão
em `Authorization: Bearer <token>`.

## Autenticação

1. `login.html` usa o Google Identity Services e manda o ID token para
   `POST /api/auth/google`.
2. O backend valida o token (`utils/googleAuth.js`, domínio `ALLOWED_DOMAIN`),
   encontra/cria o usuário (sem cadastro → perfil `guest`) e cria uma sessão
   de 24 h.
3. O token devolvido ao navegador é aleatório (32 bytes). A tabela `sessions`
   guarda só `sha256:<hash>` dele (`utils/auth.js → hashSessionToken`).
4. `authMiddleware` (`routes/auth.js`) resolve o token → usuário; nenhuma rota
   aceita perfil ou vertical vindos da query string.

Não existe login por senha. Usuários são desativados em **Pessoas**
(`is_active = false`), o que também encerra as sessões.

## Autorização

- `requireRole(...)` — rotas administrativas (Configurações, Pessoas, crons,
  cargas manuais).
- `requireTabAccess(aba | [abas])` (`routes/config.js`) — rotas de dados de
  cada aba. `admin` passa sempre; os demais perfis seguem o que está salvo em
  **Configurações → Acesso** (`config.role_tab_permissions`).

| Rota | Exige |
|---|---|
| `/api/tickets/*` | sessão + aba `dashboard`, `movidesk` ou `chamados`; `stats/overview` só admin; `executive-summary` aba `chamados` |
| `/api/curadoria/*` (inclui `ai/chat`) | sessão + aba `chamados` |
| `/api/ouvidoria`, `/api/gcc`, `/api/geral`, `/api/satisfacao`, `/api/jira` | sessão + aba correspondente |
| `/api/tickets/:id/workspace*` (Central do chamado) | ler: sessão + aba `dashboard`/`movidesk`/`chamados`; escrever (responder, status, responsável): além disso perfil `admin`/`supervisor`/`atendente` |
| `/api/incidentes/*` | ler: sessão + aba `incidentes`; criar/alterar/vincular: além disso perfil `admin`/`supervisor`/`atendente` |
| `/api/pessoas/foto*` | sessão |
| `/api/config/*`, `/api/crons/*`, `/api/loader/*`, `/api/users/*` | sessão + papel (quase tudo admin) |

## Limites e cabeçalhos

- Limite de requisições em memória (`utils/rateLimit.js`): login Google 20 /
  15 min por IP; `curadoria/ai/chat` 120 / 10 min por usuário;
  `tickets/:id/executive-summary` 30 / 10 min por usuário. Excedeu → 429.
- `helmet` com Content-Security-Policy listando só os hosts usados pelo front
  (jsDelivr, cdnjs, Tailwind CDN, Google Fonts, Google Sign-In, fotos do
  Google, DiceBear). Ainda precisa de `'unsafe-inline'` por causa dos scripts
  e `onclick` inline. `frame-ancestors 'self'` e `object-src 'none'`.
  `CSP_REPORT_ONLY=1` troca pra modo só-relatório.

## Segredos

`config` guarda token do Movidesk, chave da OpenAI e senha de banco
criptografados por `utils/crypto.js`:

- AES-256-GCM, chave derivada da `ENCRYPTION_KEY` por scrypt, formato
  `v2:<iv>:<tag>:<cifra>`.
- `ENCRYPTION_KEY` é obrigatória (≥ 32 caracteres); o servidor não sobe sem ela.
- Valores no formato antigo (AES-256-CBC) ainda são lidos e são regravados no
  formato v2 no boot (`reencryptLegacyValues`).

A chave da OpenAI nunca vai para o navegador. As análises de IA da Curadoria
passam por `POST /api/curadoria/ai/chat`, que só aceita finalidades conhecidas
(`team_narrative`, `competencias`), usa o prompt de sistema salvo no servidor,
limita tamanho de entrada e tokens de saída e registra o uso em
`ai_usage_log`.

## Cargas do Movidesk

`movidesk-loader.js` busca `/tickets` e `/tickets/past` (com
`actions($expand=createdBy)`), grava em `silver.*` e registra cada execução em
`silver.carga_log` (+ diffs por ticket em `silver.carga_log_ticket_change`).
`cron-manager.js` agenda os jobs de `silver.cron_job`; como o loader roda uma
carga por vez, um job que dispara com outra em andamento espera na fila. A fila é FIFO (`cadeia` em `cron-manager.js`): crons disparadas no mesmo instante entram em ordem e cada uma só começa quando a anterior termina (status `queued` na tela); antes, duas crons simultâneas passavam juntas pela checagem de `state.running` e a segunda falhava com "Já existe uma carga em andamento".

## Fotos

`/api/pessoas/foto/:email` e `/foto-por-nome/:name` leem as pastas de
`PHOTOS_DIRS`. Como `<img src>` não manda o header de autorização, o front
marca essas imagens com `data-auth-src` e `js/auth.js` as baixa com o token
(blob URL).

## Vertical deduzida (GCC)

Chamados de GCC sem o campo "GCC - Verticais Insatisfação" (CF 98697)
preenchido no Movidesk recebem uma vertical **deduzida**, guardada em
`silver.gcc_vertical_inferida` (nunca no campo real, que a carga sobrescreve).
`refreshGccVerticalInferida()` (loader) recalcula no boot e a cada 30 min:

- serviço do chamado com ≥ 85% de acerto (≥ 5 chamados) → confiança **alta**;
- exatamente uma palavra confiável no assunto/ações (Agrotitan Fazendas,
  Agrotitan, Construshow, Automação Comercial, Combustíveis) → **alta** se
  concorda com o serviço, senão **média**;
- serviço com 70–84% de acerto → **baixa**; sem base → continua "Não informado".

A vertical real do Movidesk sempre vence. Linhas com `origem = 'manual'` são
confirmações humanas e nunca são sobrescritas. `GET /api/gcc` devolve
`vertical_inferida`, `vertical_confianca` e `vertical_origem`, e a tela marca
"(deduzida · confiança)".


## Central do chamado (Dashboard)

Clicar num chamado do Dashboard abre a conversa dele (lida ao vivo da API do Movidesk) e
permite responder ao cliente, registrar nota interna, mudar o status e trocar o responsável
sem abrir o Movidesk (`routes/ticket-workspace.js`, `js/ticket-workspace.js`).

- A ação é gravada no Movidesk em nome do próprio usuário: o agente é achado pelo e-mail do
  login (`persons?$filter=userName eq ...`). Sem agente ativo com esse e-mail, não escreve.
- Status só aceita valores que existem nos chamados dos últimos 180 dias; Parado/Cancelado
  exigem justificativa. Responsável só aceita agentes ativos do Movidesk.
- Mudanças de status e de responsável também deixam uma nota interna "… pelo Hub 360".
- Toda escrita (sucesso ou erro) fica em `public.hub_ticket_interacoes`.
- `MOVIDESK_WRITE_API` muda a URL base da API; `MOVIDESK_ACTION_ORIGIN` muda o código de
  origem das ações (padrão 9 = API).

## Dashboard por equipe

`GET /api/tickets` (Dashboard, só ativos) devolve por padrão os chamados da(s) equipe(s) do
usuário logado (`utils/movideskPeople.js → escopoEquipe`). A equipe é a **vertical** cadastrada
em Pessoas; um chamado entra se a equipe dele contém o nome da vertical (ex.: "Sistemas Internos"
casa com "VIASOFT - Sistemas Internos") ou se o serviço de 1º nível é essa vertical. Só se a
vertical estiver vazia vale o cadastro de equipes do Movidesk e, depois, o histórico dos últimos
90 dias. Sem nenhuma das opções, não filtra e a tela avisa. Admin e supervisor podem alternar para "Todas as equipes" (`?equipe=todas`);
atendente fica sempre na própria equipe. A aba Movidesk (`?scope=all`) não é filtrada.
`GET /api/tickets/minha-equipe` informa as equipes e se o usuário pode ver todas.

### De onde vêm os chamados do Dashboard

Por padrão (`DASHBOARD_SOURCE=db`) a lista sai direto de `silver.ticket` (+ organização, ações e
custom field), sem chamar a apidatalake: quem alimenta é uma cron de carga — ex.: tarefa
personalizada com a equipe "VIASOFT - Sistemas Internos" e "atualizados nos últimos N dias", para
pegar também os que foram resolvidos/fechados e sair da lista. `DASHBOARD_SOURCE=datalake` volta ao
caminho antigo; `DASHBOARD_MAX_ROWS` (padrão 1000) limita a lista. Campos que só existem no
Movidesk (e-mail do responsável, origem da última ação) ficam vazios nesse caminho.

## Incidentes (ITIL)

Um incidente agrupa N chamados do mesmo problema de serviço (aba **Incidentes**, `routes/incidentes.js`,
`pages/incidentes.html`). Tabelas em `public` (criadas sozinhas na primeira chamada):
`incidente`, `incidente_ticket` (1 chamado → no máximo 1 incidente) e `incidente_evento` (linha do tempo).

- **Prioridade** = matriz impacto × urgência (1 alto … 3 baixo): 1×1 → P1; 1×2 e 2×1 → P2; 1×3, 2×2 e 3×1 → P3; demais → P4.
- **Metas** (reconhecer / resolver): P1 15 min / 4 h · P2 30 min / 8 h · P3 2 h / 24 h · P4 8 h / 72 h (constante `METAS`).
- **Ciclo**: aberto → investigando → mitigado → resolvido → fechado (resolvido pode ser reaberto). Resolver exige o texto
  da solução; fechar exige a causa. Toda mudança (status, prioridade, responsável, vínculos, notas, comunicados) vira evento.
- **Indicadores** (`/metricas`): ativos por prioridade, graves, metas estouradas, MTTA, MTTR e % de metas cumpridas (30 dias).
- **Central do chamado**: a seção *Incidente* mostra o incidente do chamado, vincula a um aberto ou abre um novo.
- Nesta fase o incidente vive só no Hub (nada é escrito no Movidesk).

## Agendamento das cargas automáticas

Cada cron (`silver.cron_job`) tem `interval_minutes` (de 1 min a 24 dias; na tela: atalhos ou "Personalizado…" em
minutos/horas/dias) e, opcionalmente, `params.schedule` (regras em `utils/cronSchedule.js`, horário de Brasília):

- `inicio`/`fim`: janela de horário em que pode rodar (início > fim atravessa a meia-noite);
- `dias`: dias da semana permitidos (0 = domingo … 6 = sábado; vazio = todos);
- `anchor`: alinha as execuções a partir desse horário (âncora + k × intervalo), sem rodar logo após subir o servidor.

Fora da janela a execução agendada é pulada; "Rodar agora" ignora a janela.

## IA embutida (Central do chamado e Incidentes)

`utils/ai.js` concentra a chamada à OpenAI (chave de Configurações → Inteligência Artificial; modelo `AI_ASSIST_MODEL`,
padrão `gpt-4o-mini`; `OPENAI_BASE_URL` para testes). Chave, modelo e prompts ficam só no servidor; cada chamada entra em
`ai_usage_log` (fontes `ticket_*` e `incidente_*`) e tem limite por usuário (40 / 10 min nos chamados, 30 nos incidentes).
Só perfis admin/supervisor/atendente usam. A IA devolve **rascunhos**: nada é enviado ao cliente nem gravado sem a pessoa decidir.

| Onde | Rota | O que faz |
|---|---|---|
| Chamado | `POST /api/tickets/:id/workspace/ia/resposta` | rascunho de resposta ao cliente (tom padrão/empático/objetivo; usa o texto da caixa como base) |
| Chamado | `…/ia/corrigir` | corrige ortografia/pontuação sem mudar o sentido; devolve o que mudou |
| Chamado | `…/ia/cliente` | sentimento, urgência, risco de churn, sinais e recomendações + histórico da organização (vem do banco) |
| Incidente | `POST /api/incidentes/:id/ia/resumo` | resumo, hipóteses de causa (com evidências), riscos, próximos passos e lacunas |
| Incidente | `…/ia/comunicado` | rascunho de comunicado (clientes ou equipe; primeiro aviso, atualização ou resolução) |

O conteúdo dos chamados é delimitado nos prompts (`<<<ROTULO … ROTULO>>>`) e tratado como dado, nunca como instrução; notas
internas servem de contexto mas não podem aparecer na resposta ao cliente.

## Assistente de IA configurável

Configurações → **Assistente de IA** (admin) controla a IA dos chamados e dos incidentes sem mexer em código.
Os parâmetros ficam num JSON na tabela `config` (chave `ai_assist_settings`), lido por `server/utils/aiSettings.js`
(padrões, validação/limites, cache de 15 s). Rotas: `GET/PUT /api/config/ai-assist`.
Cobre: modelo, diretrizes da empresa (entram em todos os prompts), limites de uso por pessoa, e por função
(resposta, correção, análise do cliente, resumo e comunicado de incidente) liga/desliga, tom/estilo, tamanhos,
quanto contexto é enviado, janelas do histórico do cliente, termos de risco, nº de hipóteses/passos/riscos e
orientação extra. Funções desligadas respondem 403 e os botões somem na tela (via `/ia/status`).

## Incidentes — fase 2 (correlação, Movidesk, pós-incidente, problemas)

`server/routes/incidentes-avancado.js` (montado antes de `incidentes.js`, porque tem rotas fixas):
- **Correlação automática** (`utils/correlacao.js`, sem IA): agrupa chamados abertos recentes do mesmo serviço com assuntos parecidos
  (sobreposição de termos, ignorando palavras genéricas). Só vira sugestão com ≥3 chamados de ≥2 clientes. `GET /sugestoes`,
  `POST /sugestoes/ignorar`, e `GET /:id/relacionados` para chamados soltos parecidos com um incidente aberto. Só lê; quem cria/vincula é a pessoa.
- **Movidesk**: `POST /:id/movidesk/avisar` escreve nota interna ou resposta pública nos chamados vinculados, em nome do usuário logado
  (mesmo agente do Movidesk da Central do chamado), com confirmação, no máx. 50 por envio, resultado por chamado e registro na linha do tempo.
  `modelo: 'vinculo'` deixa em cada chamado uma nota informando o incidente.
- **Pós-incidente** (`incidente_posmortem`): resumo, impacto, causa raiz, porquês, o que funcionou/melhorar e ações; rascunho → publicado
  (exige incidente resolvido, resumo, causa raiz e ≥1 ação). Obrigatório para graves/P1/P2 (`/posmortem/pendentes` alimenta o KPI). Rascunho por IA configurável.
- **Problemas** (`problema`, `problema_incidente`): causa raiz compartilhada; status aberto → em análise → erro conhecido (exige contorno) → resolvido (exige causa).

## Reincidências

Aba `reincidencias` (permissão própria em Configurações → Acesso). `server/routes/reincidencias.js` + `pages/reincidencias.html`.
A IA recebe o histórico completo (`silver.ticket_acao`) dos chamados criados na janela escolhida e devolve três dimensões:
0 (recorrência no mesmo chamado), A (mesmo cliente, chamados diferentes) e B (entre clientes, mín. configurável, padrão 3).
O servidor revalida tudo contra o banco: descarta ids inexistentes, exige o mesmo cliente real na dimensão A e o mínimo de
clientes distintos na B. Resultados ficam em `public.reincidencia_analise` (histórico de análises). Parâmetros em
Configurações → Assistente de IA → Reincidências.

Painel: `GET /api/reincidencias/painel` devolve a última análise, a anterior comparável (mesmo período/serviço) e a série histórica
(taxa de reincidência = chamados envolvidos em alguma recorrência ÷ analisados). Uma rotina interna (a cada 30 min) refaz a análise
padrão sozinha quando a última tem mais de `autoHoras` (Configurações → Assistente de IA → Reincidências; 0 desliga; `REINCIDENCIAS_SEM_AUTO=1` desliga no ambiente).

Visão geral (todos os anos): `GET /api/reincidencias/geral?ano=&dias=&equipe=&cliente=&classif=`. **Quem decide é a IA, lendo contexto e ações** (histórico completo do chamado e dos anteriores do
mesmo cliente); o módulo/rotina é só dica para a IA e filtro/agrupamento. O banco apenas escolhe candidatos (mesmo cliente, anterior encerrado até 60 dias antes, qualquer módulo; encerramento =
`resolved_in`/`closed_in` ou, nos antigos, a última ação de chamados fechados). `POST /geral/analisar {max}` (admin/supervisor/atendente, rate limit) dispara em segundo plano um job que manda lotes de 5
chamados + até 2 anteriores à OpenAI (mesmo prompt-base da análise por IA, `promptBase` ou o padrão, + `FORMATO_PARES` em `utils/reincidenciaPrompt.js`) e grava o veredito em `public.reincidencia_par` (reincidente, anterior_id, confiança, explicação, dias_entre); o servidor valida
que o anterior citado é um dos candidatos. `GET /geral/progresso` mostra cobertura e andamento. É incremental (mais recentes primeiro) e a rotina automática (a cada 30 min, se `autoHoras`) analisa 60 por vez.
A janela da tela (7/15/30/60 dias) filtra o veredito pelo intervalo real. KPIs, séries, rankings e a gaveta (`GERAL_CTE`) leem esses vereditos; só entram na taxa chamados já analisados. Cache de 10 min (limpo a cada lote). A aba tem só esta tela: a antiga "Análise por IA" (cards das Dimensões 0/A/B) foi removida do front; os endpoints `/analisar`, `/painel` e a rotina automática dela seguem no servidor, sem tela.
## Melhorias (sugestões para o próprio Hub)

Aba `melhorias`, aberta a **qualquer usuário logado** (não depende de Configurações → Acesso). `server/routes/melhorias.js` + `pages/melhorias.html`.
Qualquer um cadastra, apoia (voto) e comenta; só `admin` avalia (status, prioridade P1-P4, esforço P/M/G/GG, previsão, responsável, resposta ao
autor, nota de implantação) e escreve notas internas. Fluxo: nova → em avaliação → aprovada → em desenvolvimento → implantada | recusada
(recusar exige resposta; implantar exige nota). Autor edita/exclui só enquanto "nova". Tabelas `public.melhoria*`, criadas no primeiro uso.
O admin tem o botão "Copiar briefing de desenvolvimento" (texto pronto para colar no Claude Code).

## Escopo por vertical (GCC e Satisfação)

`server/utils/verticalScope.js`: `admin` vê tudo; os demais perfis veem só a vertical definida em Pessoas (`users.vertical`). Casa (sem acento/maiúsculas) por
campo "vertical" (GCC, real ou inferida), 1º nível do serviço ou, na Satisfação, equipe que contém a vertical. Sem vertical definida: nada é exibido e as telas avisam
(`GET /api/escopo-vertical`). Os detalhes do GCC (`/:ticketId`, `/actions`) também checam, para não abrir chamado de outra vertical pelo número.

Um usuário pode participar de **várias verticais**: `users.vertical` guarda a lista separada por `;` (ex.: `Agro; Construshow`). Pessoas edita com caixas de seleção;
`verticalScope.listaVerticais`/`escopoVertical`, `escopoEquipe` (Dashboard) e o filtro de supervisor em `tickets.js` aceitam a lista. Valores antigos (uma só vertical) continuam válidos.

Sub-abas do Movidesk em Configurações → Acesso: `movidesk` (Painel Geral), `satisfacao` e `paineltv` (Painel TV). As duas últimas só valem com `movidesk` marcado
Painel Geral (`pages/geral.html`): filtros multi-seleção por equipe, responsável, serviço, **cliente** (com busca), classificação, status, ano e mês, todos aplicados no navegador sobre `_rows`/`_rowsPendentesAll`. Todo card e gráfico tem uma seta de expansão (`EXPANSOES`/`abrirExpansao`) que abre os chamados por trás do número, respeitando os filtros; o modal desenha no máximo 1000 linhas (o resto: filtrar ou Exportar).
(a tela desabilita). `GET /api/config/minhas-abas` entrega as abas liberadas ao usuário e `geral.html`/`satisfacao.html` escondem as sub-abas sem acesso;
`/api/geral/pendentes` (Painel TV) exige `paineltv`. Configurações salvas antes (sem `__versao: 2`) ganham `paineltv` automaticamente onde já havia `movidesk`.
Satisfação: cada linha traz `vertical` (1º nível do serviço), há filtro de Vertical e o escopo por perfil segue a mesma lógica do GCC.

Equivalência de verticais: o campo "GCC - Verticais Insatisfação" (id 98697) aceita vários valores juntos ("Agrotitan, Fisco Contábil") e usa nomes diferentes de Pessoas
(ex.: Agrotitan = Agronegócio). `verticalScope` separa o campo pela vírgula e expande cada vertical do usuário pelas equivalências (padrão em `ALIASES_PADRAO`, editável por admin em
Configurações → Acesso → "Equivalência de verticais", chave `vertical_aliases`).

Reincidências — prompt: o texto-base (dimensões 0, A e B) está em `server/utils/reincidenciaPrompt.js` e pode ser substituído por admin em Configurações → Assistente de IA → Reincidências
("Prompt da análise"; vazio = padrão). O servidor acrescenta o formato de saída em JSON e aplica o mínimo de clientes configurado nas frases que citam "3". Admin não precisa de vertical (vê todas).

Reincidências — visão geral (regra no banco, sem IA, `GET /api/reincidencias/geral`): chamado reincidente = mesmo cliente + mesmo motivo ("Módulo X Rotina", ou "Causa" 148916) abrindo outro em até N dias
Reincidências — visão geral: chamado reincidente = veredito da IA sobre contexto e ações (não o módulo) em `public.reincidencia_par`; ver o parágrafo "Visão geral" da seção de Reincidências. Tudo é clicável:
`GET /geral/chamados?tipo=kpi|motivo|cliente|equipe|ano|mes&valor=…` (mesmos filtros e mesma CTE `GERAL_CTE`) lista os chamados por trás de cada número
numa gaveta dentro da própria aba, com link para o Movidesk, o chamado anterior e a explicação da IA.
## Telemetria de uso
Quem usa o Hub, o quê, quando e quantos cliques. Coleta em `js/telemetria.js` (incluído em `index.html` e em cada `pages/*.html`): clique (só o RÓTULO do botão/link/aba — nunca texto
digitado, valores de campos nem conteúdo de linhas; números longos viram `#`), `view` (troca de aba do menu, só no shell), `pagina` (tela carregada) e `ativo` (30 s de uso: aba visível,
com foco e interação nos últimos 60 s). Os lotes vão a `POST /api/telemetria/eventos` (rate limit 60/min) e o servidor grava o usuário SEMPRE pela sessão em `public.hub_telemetria`
(criada no primeiro uso; retenção de 180 dias, expurgo diário). O relatório é `GET /api/telemetria/resumo?dias=&usuario=` (só admin), exibido em Configurações → Telemetria
(usuários, abas, controles mais clicados, mapa dia × hora em horário de Brasília, dia a dia e quem não acessou).

## Reincidências — confiança alta e motivo pelo conteúdo
- Só conta como reincidente o veredito de **confiança Alta** (`rn` na CTE `GERAL_CTE`); a análise por grupos (dimensões 0/A/B) também guarda só grupos de confiança Alta.
- O **motivo** não vem só do campo Módulo/Rotina: `motivosDe()` (reincidencias.js) classifica pelo texto (assunto, 5 primeiras ações, explicação da IA e assunto do chamado anterior) com o
  dicionário de `server/data/temas-chamados.json` (o mesmo dos Temas do Painel Geral). Sem tema no texto, vale o campo (Módulo/Rotina ou Causa); sem nada, "Sem motivo identificado". Cache em memória de 6 h.

## Chats (acompanhamento quase em tempo real)
Um chamado é de chat quando tem **`chatGroup`** (os chats do WhatsApp/NLU vêm com grupo e sem widget; não se filtra por origem: `origin` é enum no OData do Movidesk e `origin eq 24` dá erro de tipo). `server/routes/chats.js` copia esses chamados para
`public.hub_chat` (criada no primeiro uso; a carga principal em `silver.*` não é tocada). A cada 60 s (`CHATS_INTERVALO_S`; desligável com `CHATS_SYNC=0`) faz duas buscas na API com `$expand=owner,clients`:
os alterados desde a última coleta (`lastUpdate ge …`, com folga de 10 min) e todos os ainda abertos dos últimos 7 dias. Depois grava uma foto em `public.hub_chat_snapshot` (ativos/abertos por grupo,
`*` = total; 90 dias). `POST /api/chats/sincronizar {dias}` (admin) reprocessa o histórico. **Ativo** = `baseStatus` Novo ou Em atendimento **e** o chat ainda não terminou: criado nas últimas 24 h e SEM `chatTalkTime` (o Movidesk só preenche o tempo de conversa quando o chat termina, e durante a conversa o
chamado quase não é atualizado, então `lastUpdate` recente NÃO serve: o primeiro critério, "atividade em 30 min", escondia chats longos). O seletor da tela também oferece "atividade em 30 min / 2 h / 24 h" (`janela` em minutos;
0 = padrão; `CHATS_JANELA_ATIVO_MIN` muda o padrão do histórico). A varredura dos abertos olha os últimos 2 dias (10 páginas). `GET /api/chats/resumo?dias=&janela=` alimenta `pages/chats.html`: conversas em atendimento
(ticket, cliente, organização, serviço, atendente, duração, origem), por atendente e por serviço, histórico de 24 h, hoje por grupo, por hora e por dia. A **fila de espera**, a posição, o tempo na fila e os
agentes online só existem na tela interna `/ChatQueue` e não estão na API pública. `chatTalkTime`/`chatWaitingTime` só vêm preenchidos quando o chat termina; unidade assumida: segundos.
O diagnóstico em Configurações → Movidesk (`GET /api/geral/chat-diagnostico`) mostra o que a API devolve para os campos de chat.

Limite conhecido (medido em 05/10/2026): a API pública não devolve os chamados dos chats AINDA EM ATENDIMENTO que aparecem em /ChatQueue (nem por `?id=` nem por `$filter=id eq N`); só os de conversas já encerradas, que chegam com
`chatTalkTime`/`chatWaitingTime`. Por isso o painel Chats mostra volume, espera e duração dos chats encerrados, e NÃO a fila nem as conversas em andamento. Para tempo real de verdade seria preciso um recurso
fora da API de tickets (eventos do Zenvia NLU enviados ao Hub, ou um endpoint de chat do Movidesk).

## Fuso horário
O banco guarda os instantes em `timestamptz` (UTC, a API do Movidesk devolve datas em UTC) e o contêiner roda em UTC (sem `TZ`). Consultas que agrupam por dia/mês/hora convertem com `AT TIME ZONE 'America/Sao_Paulo'`
(Chats, Telemetria, Reincidências); as telas agrupam por mês no fuso do navegador (`monthKeyOf`). O expediente do SLA (07:45-12:00 e 13:30-18:00, seg-sex) é horário de BRASÍLIA: `minutosUteisEntre(inicio, fim, fusoMin)` em
`server/utils/sla.js` desloca os extremos por `FUSO_BRASILIA_MIN` (-180) antes de aplicar o expediente. O SLA de solução líquido (`POST /geral/sla-liquido`) já usa isso; o SLA de PRIMEIRO CONTATO (`calcularSLAPrimeiroContato`)
ainda usa o padrão antigo (expediente lido em UTC, defasado em 3 h) até ser validado contra o Movidesk.

## Visual 2.0
- `css/v2.css` + `js/ui-version.js`: camada de estilo inspirada no sistema de design do Hub 360 2.0 (fundo quente, navbar flutuante, cards de cantos grandes, controles em pílula, laranja de marca). Só vale com `<html data-ui="v2">`.
- O Visual 2.0 é o padrão e único (sem botão de alternância). `js/ui-version.js` só marca `data-ui="v2"` no `<html>`; o visual clássico fica disponível apenas pela branch `main` anterior.
- Regra de cor: `--brand` (#ff8a2b) para preenchimento; `--brand-text` para laranja em texto. Nas páginas, `--orange` passa a ser o laranja seguro para texto.
- Fase 1: shell (`index.html`) e Painel Geral (`pages/geral.html`). As demais abas ainda usam o visual clássico (basta incluir `v2.css` e `ui-version.js` e mapear as classes).
