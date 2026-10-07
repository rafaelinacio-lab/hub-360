'use strict';
// Avisos automáticos (Configurações → Avisos automáticos). Somente admin.
//  GET  /avisos            — estado geral, regras, variáveis e resumo recente
//  PUT  /avisos/geral      — liga/desliga o módulo e o intervalo
//  POST /avisos/regras     — cria regra · PUT /avisos/regras/:id — edita · DELETE /avisos/regras/:id
//  GET  /avisos/historico  — últimos avisos (enviados, simulados, erros)
//  GET  /avisos/servicos   — serviços existentes (para escolher na regra) · GET /avisos/agentes — remetentes possíveis
//  POST /avisos/previa     — mostra a mensagem montada com dados de exemplo
const express = require('express');
const db = require('../db/remote');
const { authMiddleware, requireRole } = require('./auth');
const av = require('../utils/avisosAutomaticos');

const crypto = require('crypto');
const router = express.Router();
// Rota PÚBLICA (sem login) que entrega as imagens dos avisos: o cliente do Movidesk precisa abrir a imagem.
// O endereço leva um código aleatório longo (não dá para adivinhar) e só serve imagens reais (PNG/JPG/GIF/WEBP).
const publico = express.Router();
publico.get('/:token([a-f0-9]{32})', async (req, res) => {
  try {
    const r = await db.query(`SELECT tipo, dados FROM public.aviso_imagem WHERE token = $1`, [req.params.token]);
    if (!r.rows.length) return res.status(404).end();
    res.set({ 'Content-Type': r.rows[0].tipo, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(r.rows[0].dados);
  } catch (e) { res.status(500).end(); }
});

router.use(authMiddleware, requireRole('admin'));

// Envio de imagem pelo editor (arrastar, colar ou escolher arquivo). Corpo = bytes da imagem; nome em ?nome=.
const tipoPorAssinatura = (b) => {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
};
router.post('/imagem', express.raw({ type: () => true, limit: '3mb' }), async (req, res) => {
  const corpo = Buffer.isBuffer(req.body) ? req.body : null;
  if (!corpo || !corpo.length) return res.status(400).json({ error: 'Nenhuma imagem recebida.' });
  const tipo = tipoPorAssinatura(corpo);
  if (!tipo) return res.status(400).json({ error: 'Use uma imagem PNG, JPG, GIF ou WEBP (até 3 MB).' });
  try {
    await av.garantirTabelas();
    const token = crypto.randomBytes(16).toString('hex');
    await db.query(`INSERT INTO public.aviso_imagem (token, tipo, nome, dados, criado_por) VALUES ($1,$2,$3,$4,$5)`,
      [token, tipo, txt(String(req.query.nome || ''), 120) || null, corpo, req.user.email || null]);
    const estado = await av.lerEstado();
    const base = String(estado.urlPublica || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
    const url = `${base}/api/avisos-img/${token}`;
    res.json({ url, publicaConfigurada: !!estado.urlPublica, https: url.startsWith('https://') });
  } catch (e) { console.error('[avisos] imagem:', e.message); res.status(500).json({ error: 'Erro ao guardar a imagem' }); }
});

const txt = (v, max) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '');
const dataOuNull = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
function lerRegra(b) {
  const servicos = [...new Set((Array.isArray(b.servicos) ? b.servicos : []).map((s) => txt(s, 300)).filter(Boolean))].slice(0, 50);
  const regra = {
    nome: txt(b.nome, 120),
    ativo: b.ativo === true,
    modo: b.modo === 'ativo' ? 'ativo' : 'simulacao',
    servicos,
    tipo_acao: b.tipo_acao === 'interna' ? 'interna' : 'publica',
    mensagem: txt(b.mensagem, 5000),
    agente_id: txt(String(b.agente_id ?? ''), 40) || null,
    agente_nome: txt(b.agente_nome, 200) || null,
    classificacoes: [...new Set((Array.isArray(b.classificacoes) ? b.classificacoes : []).map((c) => txt(c, 200)).filter(Boolean))].slice(0, 30),
    vigencia_inicio: dataOuNull(b.vigencia_inicio),
    vigencia_fim: dataOuNull(b.vigencia_fim),
  };
  if (!regra.nome) return { erro: 'Dê um nome à regra.' };
  if (!regra.servicos.length) return { erro: 'Escolha ao menos um serviço.' };
  if (!regra.mensagem) return { erro: 'Escreva a mensagem.' };
  if (regra.vigencia_inicio && regra.vigencia_fim && new Date(regra.vigencia_fim) <= new Date(regra.vigencia_inicio)) return { erro: 'O fim da vigência precisa ser depois do início.' };
  if (regra.modo === 'ativo' && !regra.agente_id) return { erro: 'Para enviar de verdade, escolha o agente remetente do Movidesk.' };
  return { regra };
}

router.get('/', async (req, res) => {
  try {
    await av.garantirTabelas();
    const [estado, regras, resumo] = await Promise.all([
      av.lerEstado(),
      db.query(`SELECT * FROM public.aviso_regra ORDER BY id`),
      db.query(`SELECT status, COUNT(*)::int AS n FROM public.aviso_envio WHERE criado_em > NOW() - INTERVAL '7 days' GROUP BY 1`),
    ]);
    res.json({ estado, regras: regras.rows, variaveis: av.VARIAVEIS, resumo7d: Object.fromEntries(resumo.rows.map((r) => [r.status, r.n])) });
  } catch (e) { console.error('[avisos] get:', e.message); res.status(500).json({ error: 'Erro ao carregar os avisos automáticos' }); }
});

router.put('/geral', async (req, res) => {
  try {
    const parcial = {};
    if (typeof req.body?.ligado === 'boolean') {
      parcial.ligado = req.body.ligado;
      if (req.body.ligado) parcial.vigia = new Date().toISOString();   // ao ligar, só vale para chamados criados daqui para frente
    }
    if (typeof req.body?.urlPublica === 'string') { const u = req.body.urlPublica.trim().replace(/\/+$/, ''); if (u && !/^https:\/\/[^\s]+$/i.test(u)) return res.status(400).json({ error: 'O endereço público precisa começar com https:// (o Movidesk só exibe imagens por HTTPS).' }); parcial.urlPublica = u; }
    if (req.body?.intervaloSeg != null) parcial.intervaloSeg = Math.min(600, Math.max(30, Math.round(Number(req.body.intervaloSeg)) || 120));
    res.json({ estado: await av.gravarEstado(parcial) });
  } catch (e) { res.status(500).json({ error: 'Erro ao salvar' }); }
});

// Roda uma verificação agora (para testar sem esperar o intervalo). Só funciona com o módulo ligado.
router.post('/verificar', async (req, res) => {
  try { await av.ciclo(); res.json({ estado: await av.lerEstado() }); }
  catch (e) { res.status(500).json({ error: 'Erro ao verificar' }); }
});

router.post('/regras', async (req, res) => {
  const { regra, erro } = lerRegra(req.body || {});
  if (erro) return res.status(400).json({ error: erro });
  try {
    await av.garantirTabelas();
    const r = await db.query(
      `INSERT INTO public.aviso_regra (nome, ativo, modo, servicos, tipo_acao, mensagem, agente_id, agente_nome, criado_por, vigencia_inicio, vigencia_fim, classificacoes)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
      [regra.nome, regra.ativo, regra.modo, JSON.stringify(regra.servicos), regra.tipo_acao, regra.mensagem, regra.agente_id, regra.agente_nome, req.user.email || null, regra.vigencia_inicio, regra.vigencia_fim, JSON.stringify(regra.classificacoes)]);
    res.json({ regra: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Erro ao criar a regra' }); }
});

router.put('/regras/:id(\\d+)', async (req, res) => {
  const { regra, erro } = lerRegra(req.body || {});
  if (erro) return res.status(400).json({ error: erro });
  try {
    const r = await db.query(
      `UPDATE public.aviso_regra SET nome=$2, ativo=$3, modo=$4, servicos=$5::jsonb, tipo_acao=$6, mensagem=$7, agente_id=$8, agente_nome=$9, vigencia_inicio=$10, vigencia_fim=$11, classificacoes=$12::jsonb, atualizado_em=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, regra.nome, regra.ativo, regra.modo, JSON.stringify(regra.servicos), regra.tipo_acao, regra.mensagem, regra.agente_id, regra.agente_nome, regra.vigencia_inicio, regra.vigencia_fim, JSON.stringify(regra.classificacoes)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Regra não encontrada' });
    res.json({ regra: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Erro ao salvar a regra' }); }
});

router.delete('/regras/:id(\\d+)', async (req, res) => {
  try { await db.query(`DELETE FROM public.aviso_regra WHERE id = $1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Erro ao excluir a regra' }); }
});

router.get('/historico', async (req, res) => {
  try {
    await av.garantirTabelas();
    const r = await db.query(
      `SELECT id, regra_id, regra_nome, ticket_id, assunto, servico, status, modo, tentativas, erro, criado_em FROM public.aviso_envio ORDER BY id DESC LIMIT 200`);
    res.json({ itens: r.rows });
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar o histórico' }); }
});

router.get('/servicos', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT service_full AS servico, COUNT(*)::int AS n FROM silver.ticket
        WHERE service_full IS NOT NULL AND service_full <> '' AND createddate >= NOW() - INTERVAL '12 months'
        GROUP BY 1 ORDER BY 1 LIMIT 1500`);
    // inclui também os níveis acima (ex.: "Agronegócio" cobre todo o ramo)
    const mapa = new Map();
    for (const x of r.rows) {
      const partes = x.servico.split(' > ');
      for (let i = 1; i <= partes.length; i++) { const k = partes.slice(0, i).join(' > '); mapa.set(k, (mapa.get(k) || 0) + x.n); }
    }
    res.json({ servicos: [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).map(([servico, n]) => ({ servico, n })) });
  } catch (e) { res.status(500).json({ error: 'Erro ao listar os serviços' }); }
});

router.get('/classificacoes', async (req, res) => {
  try {
    const r = await db.query(`SELECT valor_texto AS v, COUNT(*)::int AS n FROM silver.ticket_campo_customizado
      WHERE custom_field_id = 23946 AND NULLIF(TRIM(valor_texto), '') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 200`);
    res.json({ classificacoes: r.rows.map((x) => x.v) });
  } catch (e) { res.status(500).json({ error: 'Erro ao listar as classificações' }); }
});

router.get('/agentes', async (req, res) => {
  try { res.json({ agentes: (await av.listaAgentes()).map((a) => ({ id: a.id, nome: a.nome })) }); }
  catch (e) { res.status(502).json({ error: 'Não consegui listar os agentes do Movidesk: ' + e.message }); }
});

router.post('/previa', (req, res) => {
  const t = { id: '123456', subject: 'Erro ao emitir nota fiscal', servico: txt(req.body?.servico, 300) || 'Agronegócio > Agrotitan', urgency: 'Alta', ownerTeam: 'Agrotitan - Suporte Técnico' };
  const texto = av.montarMensagem(txt(req.body?.mensagem, 5000), t);
  res.json({ texto, html: av.textoParaHtml(texto) });
});

module.exports = router;
module.exports.publico = publico;
