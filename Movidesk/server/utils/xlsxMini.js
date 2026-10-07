'use strict';
// Leitor mínimo de planilha .xlsx (sem dependências): abre o zip, lê a 1ª planilha e devolve as linhas como texto.
// Serve para listas exportadas do Movidesk (ex.: coluna "Número" com os ids dos chamados).
const zlib = require('zlib');

function lerZip(buf) {
  let fim = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  if (fim < 0) throw new Error('Arquivo não é uma planilha .xlsx válida');
  const n = buf.readUInt16LE(fim + 10); let p = buf.readUInt32LE(fim + 16);
  const arquivos = {};
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10), tamComp = buf.readUInt32LE(p + 20), nomeLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), comLen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const nome = buf.toString('utf8', p + 46, p + 46 + nomeLen);
    arquivos[nome] = { metodo, tamComp, off };
    p += 46 + nomeLen + extraLen + comLen;
  }
  return (nome) => {
    const a = arquivos[nome]; if (!a) return null;
    const nl = buf.readUInt16LE(a.off + 26), el = buf.readUInt16LE(a.off + 28), ini = a.off + 30 + nl + el;
    const dados = buf.subarray(ini, ini + a.tamComp);
    return (a.metodo === 8 ? zlib.inflateRawSync(dados) : dados).toString('utf8');
  };
}
const decod = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

// Devolve { cabecalho:[...], linhas:[[...],...] } da primeira planilha.
function lerXlsx(buf) {
  const ler = lerZip(buf);
  const xml = ler('xl/worksheets/sheet1.xml');
  if (!xml) throw new Error('Planilha sem a primeira aba');
  const ssXml = ler('xl/sharedStrings.xml');
  const compartilhadas = ssXml ? [...ssXml.matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m => decod([...m[1].matchAll(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(x => x[1]).join(''))) : [];
  const linhas = [];
  for (const r of xml.matchAll(/<(?:\w+:)?row[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const cel = [];
    for (const c of r[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attr = c[1] || '', inner = c[2] || '';
      let v = '';
      const t = inner.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/), vv = inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/);
      if (/t="s"/.test(attr) && vv) v = compartilhadas[Number(vv[1])] || '';
      else if (t) v = decod(t[1]);
      else if (vv) v = decod(vv[1]);
      cel.push(v);
    }
    linhas.push(cel);
  }
  return { cabecalho: linhas[0] || [], linhas: linhas.slice(1) };
}

// Ids de chamados de um arquivo: xlsx (coluna "Número"/"Ticket"/"ID", senão a 1ª) ou texto/csv (todos os números de 3 a 12 dígitos).
function lerIds(buf) {
  let ids = [];
  if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
    const { cabecalho, linhas } = lerXlsx(buf);
    let col = cabecalho.findIndex(h => /^(n[uú]mero|ticket|id|chamado)$/i.test(String(h).trim()));
    if (col < 0) col = 0;
    ids = linhas.map(l => String(l[col] || '').trim()).filter(v => /^\d{3,12}$/.test(v));
  } else {
    ids = (buf.toString('utf8').match(/\b\d{3,12}\b/g) || []);
  }
  return [...new Set(ids)];
}
module.exports = { lerXlsx, lerIds };
