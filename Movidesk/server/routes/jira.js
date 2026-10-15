const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('./auth');
const { requireTabAccess } = require('./config');

// A aba Jira não fala com a API do Jira diretamente — quem faz isso é o
// jira_extractor.py (fora deste processo Node, agendado por hora no Task
// Scheduler do Windows), que já calcula indicadores/TDC/backlog/sprint e
// grava tudo em arquivos *.json. Esta rota só lê esses arquivos e devolve
// prontos para o pages/jira.html consumir — sem duplicar a lógica de
// pontuação/JQL, que já está testada em Python.
const JIRA_DATA_DIR = path.resolve(__dirname, '../../', process.env.JIRA_DATA_DIR || '../Jira');

// Whitelist: nunca aceitar um nome de arquivo vindo direto da URL sem checar,
// pra não abrir brecha de path traversal (ex: /api/jira/../../.env).
const ALLOWED_FILES = new Set([
  'dashboard_data.json',
  'tdc_data.json',
  'abertos_data.json',
  'fechados_data.json',
  'sprint_data.json',
  'issues_raw.json',
  'qualidade_data.json',
  'versoes_data.json',   // aba Versões do painel Jira (versões lançadas no ano, geradas pelo extrator)
]);

router.get('/:file', authMiddleware, requireTabAccess('jira'), async (req, res) => {
  const file = req.params.file;
  if (!ALLOWED_FILES.has(file)) {
    return res.status(404).json({ error: 'Arquivo não disponível' });
  }

  const filePath = path.join(JIRA_DATA_DIR, file);
  fs.readFile(filePath, 'utf8', (err, raw) => {
    if (err) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({
          error: `${file} ainda não foi gerado. Rode o jira_extractor.py (ou espere a próxima execução agendada).`,
        });
      }
      console.error(`Erro ao ler ${file}:`, err.message);
      return res.status(500).json({ error: 'Erro ao ler dados do Jira' });
    }
    res.type('application/json').send(raw);
  });
});

module.exports = router;
