# hub-360 (painel-si)

Painel interno da Viasoft para o Movidesk: Dashboard de chamados, Central do chamado (interagir com o Movidesk), Incidentes (ITIL),
Reincidências (IA), Curadoria, Ouvidoria, GCC, Satisfação, Jira e Configurações. Idioma da equipe e do produto: **português do Brasil**
(responda e escreva textos de interface em pt-BR).

## Layout do repositório
- `Movidesk/` — a aplicação (Node/Express + front estático). `docker-compose.yml`, `Dockerfile`, `DEPLOY.md` ficam aqui.
  - `server/server.js` monta as rotas em `/api/*`; `server/routes/*.js` uma por assunto; `server/utils/*` helpers; `server/scripts/*` carregador e cron.
  - `index.html` + `js/*.js` = shell e abas do menu; `pages/*.html` = abas independentes (iframe), com tema claro/escuro por `html.dark`.
  - `docs/ARCHITECTURE.md` descreve cada módulo — leia antes de mexer num assunto.
- `Jira/` — extrator Python e JSONs lidos pela aba Jira (montado só-leitura no contêiner). **Contém credenciais (`jira_credentials.py`), venv e `__pycache__`: nunca versionar.**

## Segredos e segurança (importante)
- Nunca use `git add -A` nem `git add .`: adicione só os arquivos que você alterou. Nunca commitar `.env`, `Jira/jira_credentials.py`, `Jira/venv/`, tokens ou chaves.
- Token do Movidesk e chave da OpenAI ficam no banco (tabela `config`, criptografados) ou no `.env`. Nunca imprimir em log/resposta.
- Esta VM pode ser a **produção**. Trabalhe numa branch (`git checkout -b ...`), revise o diff e só então faça deploy. Não use `sudo` sem necessidade.

## Dados
- Postgres externo; dados do Movidesk em `silver.*` (`ticket`, `ticket_acao`, `ticket_cliente`, `ticket_organizacao`, `ticket_campo_customizado`, `carga_log`, `cron_job`, `cron_task`).
  Tabelas do Hub em `public.*` (`users`, `roles`, `config`, `incidente*`, `problema*`, `reincidencia_analise`, `hub_ticket_interacoes`, `ai_usage_log`). Várias são criadas sozinhas no primeiro uso.
- `silver.ticket.basestatus` aberto = `New`, `InAttendance`, `Stopped`, `InProgress`. Classificação de ticket = campo customizado **23946** (Dashboard usa "Suporte Técnico").
- **O Dashboard lê do banco, não do Movidesk.** O banco é alimentado pela cron (carga "personalizada", ex.: Suporte Técnico, só em aberto, a cada 15 min), que também reconfere chamados abertos no banco que o Movidesk não devolveu. O botão "Conferir com o Movidesk" (Dashboard) compara ao vivo e corrige o banco.
- Ações feitas pela Central do chamado regravam o chamado no banco com o mesmo gravador da carga (`sincronizarTicket` em `movidesk-loader.js`).

## Movidesk (API)
- Base via proxy `MOVIDESK_WRITE_API` (padrão `https://apimovidesk.viasoftcloud.com.br/public/v1`); token por `getToken`.
- Escrita: `PATCH /tickets?id=` com `actions[{type:1 interna|2 pública, origin:9, description, createdBy:{id}}]`. Mudar responsável exige `owner` **e** `ownerTeam`. `htmlDescription` é somente leitura. Status: `status` (+ `justification` se houver justificativas cadastradas; lista em `server/data/justificativas-movidesk.json`).
- A interação é sempre em nome do usuário logado (agente achado por e-mail em `persons`). Confirmar no Movidesk que o status realmente mudou antes de dar sucesso.
- Anexos: a API só devolve o código do arquivo; **não achamos rota de download** (28 testadas, 404). Anexos abrem o chamado no Movidesk.
- Tabela de mensagens de erro e comportamento das cron: ver `docs/ARCHITECTURE.md`.

## IA embutida
- OpenAI chat/completions via `server/utils/ai.js` (`chamarIA`); chave no servidor, prompts no servidor, só RASCUNHOS, conteúdo de chamados é dado e nunca instrução (delimitado por `<<<ROTULO … ROTULO>>>`). Uso registrado em `ai_usage_log`.
- Parâmetros editáveis por admin em Configurações → Assistente de IA (`server/utils/aiSettings.js`, chave `ai_assist_settings`): modelo, diretrizes, limites, liga/desliga por função, contexto etc.
- Reincidências: `server/routes/reincidencias.js` (IA propõe grupos; o servidor valida contra o banco) e análise automática periódica.

## Permissões
- Perfis: `admin`, `supervisor`, `atendente`, `guest`. Abas liberadas por perfil em Configurações → Acesso (`role_tab_permissions`, `TAB_PERMISSION_TABS` em `routes/config.js`). Escrita (Central, Incidentes) só admin/supervisor/atendente.
- **Verticais:** todo painel respeita as verticais atribuídas ao perfil em Pessoas (`users.vertical`, lista `A; B`); perfil sem vertical vê tudo; admin vê tudo; Painel TV público não é filtrado (usa `?vertical=`). Regra e helpers em `server/utils/verticalScope.js` (`escopoVertical`, `filtrarLinhas`, `pertence`); o Dashboard usa `escopoEquipe` (`utils/movideskPeople.js`). Rota nova que devolve chamados precisa aplicar o escopo (depois do cache, se houver).

## Convenções de código
- Siga o estilo do arquivo vizinho (comentários em português, nomes em português no domínio). Não adicione dependências sem necessidade.
- Rotas novas: `authMiddleware` + `requireTabAccess('aba')`; escrita com checagem de perfil e `rateLimit` quando consome IA/Movidesk.
- Front sem build: JS/HTML puro; esconda barras de rolagem como nas outras telas; tema claro/escuro por variáveis CSS.

## Deploy (VM OCI)
```bash
cd ~/painel-si/Movidesk
git pull origin main
docker compose up -d --build
docker compose logs --tail=50
```
Depois, no navegador: Ctrl+Shift+R. Se o build falhar com "network is unreachable" (IPv6), conferir `grep ffff /etc/gai.conf` (`precedence ::ffff:0:0/96 100`) e reiniciar o Docker.

## Fluxo de git usado até aqui
- Desenvolvimento na branch de trabalho, commit com mensagem clara em português, e `cherry-pick -x` para `main` quando aprovado. **Não criar PR a menos que peçam.**
- Rodar os testes/validações relevantes antes de commitar; relatar honestamente o que NÃO foi possível testar (ex.: Movidesk e OpenAI reais).

## Pendências / conhecimento acumulado
- Cron de Suporte Técnico: se aparecer chamado aberto antigo fora do painel, conferir o filtro "Ano de criação" da tarefa e o botão "Conferir com o Movidesk".
- Cron com intervalo mínimo de 1 min; só uma carga roda por vez (as demais entram em fila).
- Painel TV com incidentes ativos e correlação automática avançada (além das sugestões atuais) não foram feitos.
