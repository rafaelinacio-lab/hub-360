// Rótulo "n · x%" ao lado de barras horizontais de série única (Ouvidoria, GCC, Satisfação) — mesmo padrão do
// layeredBars do Painel Geral. Uso:
//   const bp=barrasPct({total:N});            // participação: valor ÷ total (mesmo total para todas as barras)
//   const bp=barrasPct({base:[n1,n2,…]});     // taxa: valor ÷ base daquela barra (ex.: negativas ÷ avaliações do item)
//   new Chart(cv,{…, plugins:[bp.plugin], options:{layout:{padding:{right:bp.padding}},
//     plugins:{tooltip:{callbacks:{label:bp.tooltipLabel}}}}});
// Opções: fmt (texto do número, padrão "1.234"), sufixo (depois do %, ex.: ' negativas'), legenda (texto do tooltip),
// cor (cor do rótulo; padrão = --t2 do tema, claro ou escuro).
(function () {
  const nf = (v, d = 1) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: d });
  window.barrasPct = function (opts) {
    const o = opts || {};
    const pctNum = (v, i) => {
      const b = Array.isArray(o.base) ? o.base[i] : o.total;
      return b ? Number(v) / b * 100 : null;
    };
    const pct = (v, i) => { const p = pctNum(v, i); return p == null ? null : `${nf(p)}%${o.sufixo || ''}`; };
    const fmt = o.fmt || (v => nf(v, 0));
    const texto = (v, i) => { const p = pct(v, i); return fmt(v) + (p ? ` · ${p}` : ''); };
    const cor = () => o.cor || getComputedStyle(document.documentElement).getPropertyValue('--t2').trim() || '#888';
    return {
      texto, pct, pctNum,
      padding: o.padding || 104,
      plugin: {
        id: 'rotuloPct',
        afterDatasetsDraw(chart) {
          const c = chart.ctx; c.save();
          c.font = '600 10.5px system-ui,sans-serif'; c.textBaseline = 'middle'; c.fillStyle = cor();
          chart.data.datasets.forEach((ds, di) => {
            const meta = chart.getDatasetMeta(di);
            if (meta.hidden) return;
            meta.data.forEach((bar, i) => { if (ds.data[i] != null) c.fillText(texto(ds.data[i], i), bar.x + 6, bar.y); });
          });
          c.restore();
        },
      },
      tooltipLabel: ctx => texto(ctx.raw, ctx.dataIndex) + (o.legenda ? ` (${o.legenda})` : ''),
    };
  };
})();
