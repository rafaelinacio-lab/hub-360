# Correções de segurança e integridade

Base: c474e880d2a1e9e2e154a79f605b088e6ed3f07f.

## Alterações

- Sessões obrigatórias nas APIs de tickets; perfis e verticais derivados do banco, nunca da URL. Detalhes, SLA, estatísticas e resumos respeitam a vertical do supervisor. Histórico completo exige acesso à aba Movidesk.
- MFA usa desafios separados, com expiração, cinco tentativas e consumo único. Sessões de contas inativas são recusadas; desativação também revoga sessões. MFA já ativo não pode ser substituído pelo endpoint de configuração.
- Chaves OpenAI não saem do servidor. A interface usa `/api/ai/chat`, com autorização por aba, modelo/tamanho fixos, limite por usuário, uma chamada simultânea por usuário e registro de consumo no backend. Falhas de análise/persistência mantêm competências pendentes.
- Renderização escapa texto/atributos; argumentos dinâmicos em eventos usam JSON seguido de codificação HTML. Fotos rejeitam caminhos arbitrários.
- SLA usa America/Sao_Paulo, incluindo horário de verão histórico, almoço, fins de semana e pausas sem efeito retroativo. Datas inválidas não causam exceção.
- Falhas de paginação não equivalem a fim da coleta. Reconciliação considera tickets históricos ativos. Checkpoint incremental usa a data de alteração da origem e só avança ao concluir. Falhas de campos adicionais deixam de reduzir silenciosamente KPIs.
- Timeout nas chamadas externas; tratamento de Retry-After; intervalo mínimo no sincronizador Movidesk; token removido dos logs.
- Schema cria desafios MFA e colunas necessárias ao fallback. Consultas concorrentes aguardam o schema. A rota de auditoria precede a rota de ID.
- Extrator Jira grava JSON por substituição atômica na sua pasta (ou JIRA_DATA_DIR); erros de lotes e histórico inválido interrompem a execução.
- Criptografia nova usa AES-GCM; leitura de registros AES-CBC antigos permanece compatível com a chave explícita. TLS do banco valida o certificado.
- Dependências atualizadas e verificações automáticas adicionadas em GitHub Actions. Runtime Node 22.

## Atualização do ambiente

1. Preserve o valor secreto atual de ENCRYPTION_KEY, desde que válido. O servidor agora exige ao menos 32 caracteres ASCII e rejeita a antiga chave pública padrão. Se o ambiente usava o padrão, configure uma chave aleatória e recadastre as credenciais de integração; os dados de tickets não são alterados por isso.
2. Substitua a chave OpenAI e o token Movidesk se ficaram expostos pelo endpoint antigo ou pelos logs. Esta branch não revoga credenciais externas.
3. Com DB_SSL=true, forneça DB_SSL_CA para certificados privados. A verificação do certificado não é desabilitada.
4. Rode `npm ci` em Movidesk com Node 22. O usuário PostgreSQL precisa das permissões de DDL já exigidas pelo bootstrap; ele cria a tabela mfa_challenges e adiciona as colunas faltantes de tickets. Desafios MFA legados de dez minutos são removidos de sessions.
5. Atualize frontend e backend juntos. Configure o agendador para não executar múltiplos sincronizadores simultaneamente. Horários da carga automática usam Brasília.
6. O limitador de requisições é por processo; múltiplas réplicas precisam de um limite compartilhado no gateway. Gravação atômica protege cada JSON Jira individualmente, não uma transação entre arquivos diferentes.

## Verificação

- `cd Movidesk && npm run check && npm test`
- `python -m unittest discover -s Jira/tests -v`
- `cd Movidesk && npm audit --omit=dev`

Testes HTTP usam Express real, adaptador de banco em memória e fixtures do datalake. Não utilizam dados ou credenciais de produção. Cobrem autenticação/MFA, segregação de verticais, auditoria, segredo indisponível ao cliente, calendário SLA, criptografia, escape, coleta parcial e publicação atômica.

A publicação desta branch não é uma implantação. Validar login Google, PostgreSQL, Jira, datalake, Movidesk e IA em homologação antes do merge/deploy. Não houve execução contra serviços de produção, nem teste visual completo das telas.
