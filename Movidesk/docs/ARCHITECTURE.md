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
carga por vez, um job que dispara com outra em andamento espera na fila.

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

Cada cron (`silver.cron_job`) tem `interval_minutes` (de 5 min a 24 dias; na tela: atalhos ou "Personalizado…" em
minutos/horas/dias) e, opcionalmente, `params.schedule` (regras em `utils/cronSchedule.js`, horário de Brasília):

- `inicio`/`fim`: janela de horário em que pode rodar (início > fim atravessa a meia-noite);
- `dias`: dias da semana permitidos (0 = domingo … 6 = sábado; vazio = todos);
- `anchor`: alinha as execuções a partir desse horário (âncora + k × intervalo), sem rodar logo após subir o servidor.

Fora da janela a execução agendada é pulada; "Rodar agora" ignora a janela.
