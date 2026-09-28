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
| `/api/pessoas/foto*` | sessão |
| `/api/config/*`, `/api/crons/*`, `/api/loader/*`, `/api/users/*` | sessão + papel (quase tudo admin) |

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
