# Hub 360 — painel Movidesk

Painel interno da Viasoft sobre os chamados do Movidesk: Dashboard, Movidesk,
Chamados (Curadoria com IA), Painel Geral, Ouvidoria, GCC, Satisfação, Painel
TV, Jira, Pessoas e Configurações.

- Backend: Node/Express (`server/`), Postgres (datalake bronze/silver/gold +
  tabelas do painel).
- Frontend: HTML/JS estático (`index.html`, `pages/*.html`, `js/`, `css/`),
  servido pelo próprio Express.
- Deploy: Docker na VM OCI — passo a passo em [`DEPLOY.md`](DEPLOY.md).
- Visão técnica: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Rodar localmente

```bash
npm install
cp .env.example .env   # preencha (ver abaixo)
npm start              # http://localhost:5000
```

Variáveis obrigatórias no `.env`:

| Variável | Para quê |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Postgres |
| `ENCRYPTION_KEY` | Criptografa os segredos salvos em `config` (token Movidesk, chave OpenAI). **Mínimo 32 caracteres — sem ela o servidor não sobe.** Gere com `openssl rand -hex 32`. |
| `GOOGLE_CLIENT_ID`, `ALLOWED_DOMAIN` | Login com Google (único meio de entrar) |
| `DATALAKE_API_URL`, `DATALAKE_API_TOKEN` | apidatalake |

Opcionais: `ALLOWED_ORIGINS`, `JIRA_DATA_DIR`, `PHOTOS_DIRS` (pastas das fotos
oficiais, separadas por `;`) e `LEGACY_ENCRYPTION_KEY` (só para migrar
segredos gravados com uma chave antiga — ver `DEPLOY.md`).

## Login e permissões

- Só existe login com Google (`POST /api/auth/google`). Não há login por
  senha nem usuário admin padrão.
- Conta do domínio sem cadastro em **Pessoas** entra como `guest` (só
  Dashboard). Um admin atribui o perfil em Pessoas.
- Cada aba é liberada por perfil em **Configurações → Acesso**; o backend
  confere a mesma regra (`requireTabAccess`) em todas as rotas de dados.
- A sessão é um token aleatório enviado em `Authorization: Bearer`; o banco
  guarda só o hash SHA-256 dele.

## Cargas do Movidesk

As cargas rodam dentro do servidor, por crons configuráveis em
**Configurações → Cargas automáticas** (`server/scripts/cron-manager.js` +
`server/scripts/movidesk-loader.js`). Só uma carga roda por vez; as demais
esperam na fila.

## Scripts de manutenção (`scripts/`)

Utilitários pontuais da Curadoria (`import-curadoria-*.js`,
`enriquecer-curadoria.js`, `truncate-curadoria.js`, …) e o
`sync-movidesk.js` legado. Rodam à mão com `node scripts/<arquivo>.js`.
