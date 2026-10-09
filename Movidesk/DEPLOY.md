# Deploy na VM (Oracle Cloud / OCI)

Guia para subir o painel numa instância OCI existente, via Docker. O Postgres
(`DB_HOST` no `.env`) e a apidatalake (`DATALAKE_API_URL`) são serviços
externos — não sobem junto, só precisam estar alcançáveis pela VM.

## 1. Pré-requisitos na VM

Acesse a VM via SSH e confirme se o Docker está instalado:

```bash
docker --version
docker compose version
```

Se não estiver (ex: Ubuntu):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# saia e reconecte via SSH pra o grupo "docker" valer
```

## 2. Trazer o código

O repositório `PAINEL-SI` tem o painel dentro da pasta `Movidesk/` (a raiz
também tem `Jira/`, outro projeto — não precisa dele pra rodar o painel).

```bash
git clone https://github.com/rafaelinacio-lab/PAINEL-SI.git painel-si
cd painel-si/Movidesk
```

Se já existir um clone anterior na VM, é só `git pull` na raiz do repo
(`cd painel-si && git pull`).

## 3. Configurar o `.env`

```bash
cp .env.example .env
nano .env
```

Preencha (ver comentários no próprio `.env.example` pra detalhes de cada um):
- `PORT` — porta que o painel vai escutar (padrão `5000`)
- `ALLOWED_ORIGINS` — origem(ns) que podem chamar a API
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — Postgres
- `ENCRYPTION_KEY` — chave para criptografar os segredos salvos no banco (gere uma: `openssl rand -hex 32`). **Obrigatória, mínimo 32 caracteres** — sem ela o container não sobe (veja `docker compose logs painel`).
- `LEGACY_ENCRYPTION_KEY` — só se os segredos atuais foram gravados com outra chave (ou sem `ENCRYPTION_KEY`, quando o código usava um valor padrão). No boot eles são regravados no formato novo; depois disso pode remover a variável. Se não souber a chave antiga, basta salvar de novo o token do Movidesk e a chave da IA em Configurações.
- `PHOTOS_DIRS` — pasta(s) com as fotos oficiais das pessoas (`email_dominio.jpg`), separadas por `;`. Dentro do container precisa ser um caminho montado como volume (ver `docker-compose.yml`). Sem ela, os avatares usam a foto do Google ou as iniciais.
- `DATALAKE_API_URL`/`DATALAKE_API_TOKEN` — apidatalake (perfil `painel-sla`); ver [[project_apidatalake_vm_access]]
- `GOOGLE_CLIENT_ID`/`ALLOWED_DOMAIN` — SSO Google
- `SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` (+ `SMTP_HOST`/`SMTP_PORT`, `PUBLIC_URL`) — e-mail de boas-vindas ao cadastrar pessoa; opcional (sem eles o cadastro não envia e-mail)
- `JIRA_DATA_DIR` — já vem correto (`../Jira`) se o clone manteve a estrutura padrão

## 4. Build e subir o container

```bash
docker compose up -d --build
```

Acompanhar logs:

```bash
docker compose logs -f painel
```

Testar localmente na própria VM:

```bash
curl -s http://localhost:${PORT:-5000}/health
```

Deve responder `{"status":"ok","message":"Servidor funcionando"}`.

## 5. Liberar a porta (rede OCI)

Duas camadas para liberar, ambas necessárias:

**a) Security List / Network Security Group (painel OCI)**
No console da OCI: VCN → sua VCN → Security Lists (ou NSG da instância) →
Add Ingress Rule:
- Source CIDR: `0.0.0.0/0` (ou restrinja ao IP/rede de quem vai acessar)
- Protocolo: TCP
- Destination Port Range: a porta do `PORT` (ex: `5000`)

**b) Firewall do próprio SO** — imagens Ubuntu/Oracle Linux da OCI costumam vir
com `iptables`/`firewalld` bloqueando por padrão, além da Security List:

```bash
# Ubuntu (iptables) — libera a porta e persiste
sudo iptables -I INPUT -p tcp --dport ${PORT:-5000} -j ACCEPT
sudo netfilter-persistent save   # ou: sudo apt install iptables-persistent

# Oracle Linux (firewalld)
sudo firewall-cmd --permanent --add-port=${PORT:-5000}/tcp
sudo firewall-cmd --reload
```

Depois disso, `http://<IP-publico-da-VM>:${PORT}` deve responder de fora.

## 6. Primeiro acesso — primeiro admin

O único login é o do Google. A primeira pessoa entra como `guest`; promova-a
a admin direto no banco (uma vez só):

```sql
UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'admin') WHERE email = 'seu.email@viasoft.com.br';
```

Depois disso, os demais perfis são atribuídos pela tela **Pessoas**. Não
existe mais usuário/senha padrão — o antigo `admin@example.com` é desativado
automaticamente no boot.

## 7. Atualizações futuras

```bash
cd painel-si
git pull
cd Movidesk
docker compose up -d --build
```

## 8. Opcional — domínio + HTTPS

Sem domínio, o painel fica acessível só por `http://IP:PORTA` (sem TLS). Se
quiser um domínio com HTTPS na frente, o jeito mais simples é colocar um
Caddy ou nginx reverso na própria VM, na frente do container `painel`. Isso é
opcional e independente de qualquer outro serviço — não é necessário pra o
painel funcionar.

## Observação de segurança já corrigida

O servidor servia a raiz inteira do repositório como arquivo estático
(`.env`, planilha de chamados, scripts de debug — tudo baixável via HTTP).
Isso foi corrigido: agora só `/css`, `/js` e `/pages` são servidos
estaticamente (ver `server/server.js`). Depois do deploy, vale confirmar que
`http://<IP>:${PORT}/.env` e `http://<IP>:${PORT}/curadoria_chamados.xlsx`
retornam 404.

## Endurecimento de segurança (set/2026)

- `/api/tickets/*` exige sessão e acesso à aba (o perfil não pode mais ser
  forjado com `?viewerRole=`).
- Login por senha (`/api/auth/login`, `/first-access`, `/verify-mfa`)
  removido; `admin@example.com` desativado no boot.
- A chave da OpenAI não sai mais do servidor: a Curadoria chama
  `POST /api/curadoria/ai/chat`.
- `ENCRYPTION_KEY` obrigatória; segredos em AES-256-GCM com chave derivada
  por scrypt (os antigos são migrados no boot).
- Sessões gravadas só como hash — **no primeiro boot com essa versão, todo
  mundo precisa entrar de novo pelo Google**.
- Fotos (`/api/pessoas/foto*`) exigem sessão; a pasta vem de `PHOTOS_DIRS`.

