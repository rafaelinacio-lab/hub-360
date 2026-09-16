"""
jira_extractor.py - Dashboard (versão otimizada, datas dinâmicas)

OTIMIZAÇÕES:
- Índices por pessoa para evitar varrer issues N vezes
- fetch paralelo com ThreadPoolExecutor
- Paginação única por consulta
- Sem loops redundantes

REGRAS DE PONTUACAO:
  pts_req    = est_req    * 0.2  → SEMPRE
  pts_at_tec = est_at_tec * 0.2  → SEMPRE
  pts_test   = est_test   * 0.2  → só Finalizada
  pts_dev    = est_dev    * 0.2  → só Finalizada

  AR/AT     → pts_req + pts_test
  DEV/AT_TEC → pts_dev + pts_at_tec
"""

import requests, json, time, os, re, tempfile
from pathlib import Path
from contextlib import contextmanager
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo

# Horário de Brasília explícito — o servidor que roda o extrator pode estar
# em UTC (ex: VM Linux) e datetime.now() sem timezone pegaria a hora do
# sistema, não a de Brasília, fazendo o "Gerado em" do painel aparecer
# até 3h no futuro em relação ao horário real de quem está olhando.
TZ_BR = ZoneInfo("America/Sao_Paulo")

def _agora():
    return datetime.now(TZ_BR)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv é opcional — funciona também com as env vars já setadas no ambiente

# ══════════════════════════════════════════════════════
# Credenciais via variável de ambiente (ver .env.example) — nunca hardcoded aqui.
JIRA_BASE_URL  = os.environ.get("JIRA_BASE_URL", "")
JIRA_EMAIL     = os.environ.get("JIRA_EMAIL", "")
JIRA_API_TOKEN = os.environ.get("JIRA_API_TOKEN", "")

if not (JIRA_BASE_URL and JIRA_EMAIL and JIRA_API_TOKEN):
    raise SystemExit(
        "Faltam credenciais do Jira: configure JIRA_BASE_URL, JIRA_EMAIL e "
        "JIRA_API_TOKEN (copie Jira/.env.example para Jira/.env e preencha)."
    )

# ── Datas dinâmicas ──────────────────────────────────────────────────────────
import sys
_hoje = _agora()
ANO_ATUAL_INT = _hoje.year
ANO_ANT_INT   = ANO_ATUAL_INT - 1

# Ano a processar — altere aqui ou passe como argumento: python jira_extractor.py 2025
ANO = sys.argv[1] if len(sys.argv) > 1 else str(ANO_ATUAL_INT)
ANO_INT = int(ANO)

# Mês de corte: se estamos no ano atual, usa o mês corrente; anos passados, dezembro completo
MES_FIM = f"{_hoje.month:02d}" if ANO_INT == ANO_ATUAL_INT else "12"

# Sprint: sempre 6 meses atrás
_6m_mes = (_hoje.month - 6) or 12
_6m_ano = _hoje.year if _hoje.month > 6 else _hoje.year - 1
DATA_6M = f"{_6m_ano}-{_6m_mes:02d}-01"

# TDC: 3 anos — atual, anterior e anterior-do-anterior (sem hardcode)
TDC_ANO_ATUAL    = ANO_ATUAL_INT        # ex: 2026
TDC_ANO_ANT      = ANO_ATUAL_INT - 1   # ex: 2025
TDC_ANO_ANT2     = ANO_ATUAL_INT - 2   # ex: 2024
# A JQL cobre do início do ano anterior-do-anterior até o fim do ano atual
TDC_DATE_INI = f"{TDC_ANO_ANT2}-01-01"
TDC_DATE_FIM = f"{TDC_ANO_ATUAL}-12-31"

# ── Query A: Abertos (criados no ano atual) ───────────────────────────────────
JQL_ABERTOS_ANO = f"""
    createdDate >= "{ANO}-01-01"
    AND project in (
        Agrotitan, Petroshow, "zViasuper - inativo", ConstruShow,
        "Testes Automatizados", Fisco, BI, Talent, Tecnologia, Voors,
        "zAutomação Comercial - inativo", Nimitz, CWM, "Agrotitan Fazendas", PERS
    )
    AND status not in (Cancelada, Cancelado)
    ORDER BY created DESC
"""

# ── Query B: Fechados (resolvidos no ano atual) ───────────────────────────────
JQL_FECHADOS_ANO = f"""
    resolutiondate >= "{ANO}-01-01"
    AND project in (
        Agrotitan, Petroshow, "zViasuper - inativo", ConstruShow,
        "Testes Automatizados", Fisco, BI, Talent, Tecnologia, Voors,
        "zAutomação Comercial - inativo", Nimitz, CWM, "Agrotitan Fazendas", PERS
    )
    AND status not in (Cancelada, Cancelado)
    ORDER BY created DESC
"""

# Mantido para compatibilidade com cálculos de indicadores (usa resolutiondate + issuetype filter)
JQL = f"""
    resolutiondate >= "{ANO}-01-01"
    AND resolutiondate <= "{ANO}-{MES_FIM}-31"
    AND issuetype != Epic
    AND status IN ("Finalizada", "Análise Reprovada")
    ORDER BY project, status
"""

JQL_ABERTO = """
    statusCategory != Done
    AND project in (
                    Agrotitan, "Testes Automatizados", "zViasuper - inativo",
                    ConstruShow, Petroshow, Fisco, BI, Talent, Tecnologia, Voors,
                    "zAutomação Comercial - inativo", Nimitz, CWM, "Agrotitan Fazendas", PERS)
    ORDER BY assignee, project
"""

# ── NOVA CONSULTA: TDC — Bugs Cliente/externo ou Sem Classificação ───────────
JQL_TDC = f"""
    issuetype = Bug
    AND createdDate >= {TDC_DATE_INI}
    AND createdDate <= {TDC_DATE_FIM}
    AND status not in ("Reprovada pela análise", "Reprovada Análise", "Bug Reprovado",
                       "Erro Não Confirmado", "Tarefa Abortada", "Análise Reprovada", Cancelada)
    AND (cf[10184] = "Cliente/externo" OR cf[10184] is EMPTY)
    AND project in (Agrotitan, Petroshow, "zViasuper - inativo", ConstruShow, Fisco, BI,
                    Talent, Tecnologia, Voors, CWM, Nimitz,
                    "zAutomação Comercial - inativo", "Agrotitan Fazendas")
    ORDER BY created DESC
"""

# Campos para TDC
FIELDS_TDC = ",".join([
    "key", "summary", "issuetype", "status", "created", "project",
    "customfield_10071",   # squad
    "customfield_10184",   # class_bug (Classificação de BUG)
    "customfield_10166",   # criticidade
    "customfield_10069",   # bug_gerado (Bug Gerado)
    "customfield_10173",   # origem_bug
    "customfield_10259",   # produto
    "customfield_10343",   # clientes
    "customfield_10346",   # modulo
    "customfield_10169",   # rotina
])

FIELDS_IDS = ",".join([
    "key","summary","status","issuetype","created","resolutiondate","project",
    "customfield_10057","customfield_10172","customfield_10048","customfield_10097",
    "customfield_10047","customfield_10096","customfield_10093",
    "customfield_10178","customfield_10115","customfield_10114","customfield_10825",
    "customfield_10173","customfield_10184","customfield_10166",
    "customfield_10060","customfield_10053","customfield_10071",
    "customfield_10180",   # class_melhoria
    "customfield_10031",   # GUT Resultado
    "customfield_10343",   # clientes
    "customfield_10346",   # modulo
    "customfield_10169",   # rotina
    "customfield_12230",   # Quantidade Reprovações Revisão de Código (painel Qualidade)
    "customfield_10076",   # Quantidade de Reprovações — teste interno (painel Qualidade)
    "customfield_10095",   # Tarefa Origem Inconsistência (painel Dev — ranking de bugs)
    "fixVersions",
    "parent",              # painel Progresso da Epic (reaproveita issues já buscadas)
    "customfield_10008",   # Epic Link clássico — fallback caso 'parent' não esteja preenchido
])

_PROJETOS_PADRAO = """
    Agrotitan, Petroshow, "zViasuper - inativo", ConstruShow,
    "Testes Automatizados", Fisco, BI, Talent, Tecnologia, Voors,
    "zAutomação Comercial - inativo", Nimitz, CWM, "Agrotitan Fazendas", PERS
"""

# ── "Tarefas feitas na semana" — transições para status "Desenvolvida" ──
# Query dedicada e filtrada no SERVIDOR do Jira ("status changed to X after -Nd").
# Tentamos antes reaproveitar changelog de Backlog+Fechados filtrando por 'updated',
# mas 'updated' muda com qualquer interação (comentário, campo etc.), não só
# transição de status — na prática quase não reduzia o volume. Query dedicada
# é bem mais rápida aqui porque o filtro é indexado no lado do Jira.
STATUS_DESENVOLVIDA = "Desenvolvida"   # confirmado com o usuário
DIAS_JANELA_DESENVOLVIDA = 180
JQL_DESENVOLVIDA = f"""
    project in ({_PROJETOS_PADRAO})
    AND status changed to "{STATUS_DESENVOLVIDA}" after -{DIAS_JANELA_DESENVOLVIDA}d
    ORDER BY updated DESC
"""
FIELDS_DESENVOLVIDA = "key,customfield_10047,customfield_10071,project,customfield_10259"

# ── "Progresso da Epic" — via campo "parent" (assumido; ajustar se sua organização ──
# usar Epic Link clássico em algum projeto company-managed). NÃO faz mais query
# dedicada de Epics/filhos — reaproveita as issues já buscadas para Backlog e Fluxo
# (evita 414 Request-URI Too Large quando há milhares de Epics/filhos).
DONE_STATUSES_EPIC = {"Finalizada", "Análise Reprovada", "Finalizado", "Done", "Concluída"}
CANCEL_STATUSES_EPIC = {"Cancelada", "Cancelado"}

def extract_parent_info(issue):
    """
    Extrai {parent_key, status} de qualquer issue já buscada.
    Prioriza o campo moderno 'parent'; se vazio, cai para o Epic Link clássico
    (customfield_10008) — nesta instância os dois ficam sincronizados, mas o
    fallback cobre issues antigas onde só um dos dois esteja preenchido.
    """
    f = issue["fields"]
    parent = f.get("parent")
    parent_key = parent.get("key") if parent else None
    if not parent_key:
        parent_key = f.get("customfield_10008") or None
    return {
        "parent_key": parent_key,
        "status":     (f.get("status") or {}).get("name"),
    }

FIELDS_ABERTO = ",".join([
    "issuetype","key","created","status","summary","assignee","project",
    "customfield_10184","customfield_10259","customfield_10071","customfield_10166",
    "customfield_10169","customfield_10069","customfield_10180",
    "customfield_10031",   # GUT Resultado
    "customfield_10343","customfield_10346","customfield_10044",
    "parent",              # painel Progresso da Epic
    "customfield_10008",   # Epic Link clássico — fallback
])
# ── Sprint aberta ────────────────────────────────────────────────────────────
JQL_SPRINT = """
    project in (Agrotitan, Petroshow, ConstruShow, Fisco, BI, Tecnologia, Voors,
                TAL, Nimitz, CWM, "Agrotitan Fazendas")
    AND sprint in openSprints()
    ORDER BY sprint DESC, updated DESC
"""

JQL_SPRINT_CLOSED = f"""
    project in (Agrotitan, Petroshow, ConstruShow, Fisco, BI, Tecnologia, Voors,
                TAL, Nimitz, CWM, "Agrotitan Fazendas")
    AND sprint in closedSprints()
    AND sprint not in openSprints()
    AND updatedDate >= "{DATA_6M}"
    ORDER BY sprint DESC, updated DESC
"""

FIELDS_SPRINT = ",".join([
    "issuetype","key","summary","created","status",
    "fixVersions",
    "customfield_10184",    # Classificação de BUG
    "assignee",
    "customfield_10259",    # Produtos
    "customfield_10071",    # Squad
    "project",
    "customfield_10166",    # Criticidade de BUG
    "customfield_10169",    # Rotina
    "customfield_10069",    # Bug Gerado
    "priority",
    "customfield_10010",    # Sprint
    "resolutiondate",
    "customfield_10014",    # Story Points
    "customfield_10178",    # Estimativa Requisitos
    "customfield_10825",    # Estimativa Análise Técnica
    "customfield_10114",    # Estimativa Desenvolvimento
    "customfield_10115",    # Estimativa Testes
])



# Mapeamento projetos → segmento (ajuste conforme sua realidade)
PROJETO_SEGMENTO = {
    "Agrotitan":                    "Agrotitan",
    "Agrotitan Fazendas":           "Agrotitan Fazendas",
    "ConstruShow":                  "ConstruShow",
    "Petroshow":                    "Petroshow",
    "zViasuper - inativo":          "Viasuper",
    "Fisco":                        "Fisco",
    "BI":                           "BI",
    "Talent":                       "Talent",
    "Tecnologia":                   "Tecnologia",
    "Voors":                        "Voors",
    "zAutomação Comercial - inativo": "Automação Comercial",
    "Nimitz":                       "Nimitz",
    "CWM":                          "CRM",
    "PERS":                         "PERS",
}

# Outputs always live next to the extractor, independent of scheduler cwd.
DATA_DIR = Path(os.environ.get("JIRA_DATA_DIR", Path(__file__).resolve().parent)).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)

@contextmanager
def atomic_output(name):
    target = DATA_DIR / name
    fd, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=DATA_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            yield stream
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

# ── helpers ───────────────────────────────────────────
def get_auth():    return (JIRA_EMAIL, JIRA_API_TOKEN)
def get_headers(): return {"Accept": "application/json"}
def pu(f): return f.get("displayName") or f.get("name") if f else None
def po(f): return f.get("value") or f.get("name") if f else None
def pf(v): return float(v) if v else 0.0
def pnum(v):
    """Campo numérico simples (ex.: GUT Resultado). Preserva None quando vazio,
    ao contrário de pf() que zera — aqui 0 é um valor legítimo e distinto de 'sem valor'."""
    if v is None: return None
    try: return float(v)
    except (TypeError, ValueError): return None
def mes(d): return d[:7] if d else ""

# ── fetch paginado com retry automático ──────────────
def fetch_jql(jql, fields, label="", max_retries=5, expand=None):
    url = f"{JIRA_BASE_URL}/rest/api/3/search/jql"
    all_issues, npt = [], ""

    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(
        max_retries=requests.adapters.Retry(
            total=max_retries,
            backoff_factor=2,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"],
        )
    )
    session.mount("https://", adapter)

    while True:
        params = {"jql": jql, "maxResults": 100, "fields": fields}
        if expand: params["expand"] = expand
        if npt: params["nextPageToken"] = npt

        for tentativa in range(1, max_retries + 1):
            try:
                r = session.get(url, auth=get_auth(), headers=get_headers(),
                                params=params, timeout=60, verify=True)
                r.raise_for_status()
                break
            except Exception as e:
                if tentativa == max_retries:
                    raise
                wait = 2 ** tentativa
                print(f"  [{label}] ⚠️  Erro (tentativa {tentativa}/{max_retries}): {type(e).__name__} — aguardando {wait}s...")
                time.sleep(wait)

        data = r.json()
        batch = data.get("issues", [])
        all_issues.extend(batch)
        npt = data.get("nextPageToken", "")
        is_last = data.get("isLast", True) or not npt
        print(f"  [{label}] {len(all_issues)} issues | isLast={is_last}")
        if is_last: break

    return all_issues

# ── fetch usuarios ativos ─────────────────────────────
# ── fetch em lote por chave (evita 414 Request-URI Too Large em listas grandes) ──
def fetch_jql_by_keys(keys, fields, label="", chunk_size=75, expand=None):
    """
    Busca issues por chave em lotes pequenos (key in (...)), sempre que a lista
    de chaves puder ser grande (ex.: parents de Epic, tarefas-origem de bugs,
    changelog de "Desenvolvida"). Evita erro 414 (URI muito grande) que ocorre
    quando se monta 'key in (...)' com centenas/milhares de chaves numa única query.
    """
    keys = sorted({k for k in keys if k})
    if not keys: return []
    resultado = []
    for i in range(0, len(keys), chunk_size):
        lote = keys[i:i+chunk_size]
        jql = "key in (" + ",".join(lote) + ")"
        try:
            resultado.extend(fetch_jql(jql, fields, f"{label} [{i//chunk_size+1}]", expand=expand))
        except Exception as e:
            raise RuntimeError(f"Coleta incompleta: lote {i//chunk_size+1} de {label}") from e
    return resultado


def fetch_active_users():
    url = f"{JIRA_BASE_URL}/rest/api/3/users/search"
    ativos, start = set(), 0
    while True:
        for tentativa in range(1, 4):
            try:
                r = requests.get(url, auth=get_auth(), headers=get_headers(),
                                 params={"query":"","maxResults":50,"startAt":start},
                                 timeout=30)
                r.raise_for_status()
                break
            except Exception as e:
                if tentativa == 3: raise
                time.sleep(2 ** tentativa)
        users = r.json()
        if not users: break
        for u in users:
            if u.get("active") and u.get("displayName"):
                ativos.add(u["displayName"])
        if len(users) < 50: break
        start += 50
    print(f"✓ Usuários ativos: {len(ativos)}")
    return ativos

# ── normalize indicadores ─────────────────────────────
def normalize(issue):
    f = issue["fields"]
    status_nome = f.get("status", {}).get("name")
    is_fin = status_nome != "Análise Reprovada"
    er  = pf(f.get("customfield_10178"))
    et  = pf(f.get("customfield_10115"))
    ed  = pf(f.get("customfield_10114"))
    eat = pf(f.get("customfield_10825"))
    return {
        "chave":      issue["key"],
        "summary":    f.get("summary"),
        "status":     status_nome,
        "tipo":       f.get("issuetype", {}).get("name"),
        "projeto":    f.get("project", {}).get("name"),
        "squad":      po(f.get("customfield_10071")),
        "mes":        mes(f.get("resolutiondate")),
        "criado":     (f.get("created") or "")[:10],
        "resolvido":  (f.get("resolutiondate") or "")[:10],
        "ar":         pu(f.get("customfield_10057")),
        "ar_origem":  pu(f.get("customfield_10172")),
        "at":         pu(f.get("customfield_10048")),
        "at_origem":  pu(f.get("customfield_10097")),
        "dev":        pu(f.get("customfield_10047")),
        "dev_origem": pu(f.get("customfield_10096")),
        "at_tec":     pu(f.get("customfield_10093")),
        "est_req": er, "est_test": et, "est_dev": ed, "est_at_tec": eat,
        "pts_req":    er  * 0.2,
        "pts_test":   et  * 0.2 if is_fin else 0.0,
        "pts_dev":    ed  * 0.2 if is_fin else 0.0,
        "pts_at_tec": eat * 0.2,
        "origem_bug":     po(f.get("customfield_10173")),
        "class_bug":      po(f.get("customfield_10184")),
        "crit_bug":       po(f.get("customfield_10166")),
        "class_melhoria": po(f.get("customfield_10180")),
        "gut_resultado":  pnum(f.get("customfield_10031")),
        "modulo":         po(f.get("customfield_10346")),
        "rotina":         po(f.get("customfield_10169")),
        "clientes":       [c.get("value") or c.get("name","") for c in (f.get("customfield_10343") or []) if c],
        "produto":        po(f.get("customfield_10259")),
    }

# ── normalize TDC ─────────────────────────────────────
def get_segmento_tdc(projeto, produto, squad):
    """Replica a lógica DAX de segmento do Power BI.
    Prioridade:
      1. Produto → só ConstruShow, Petroshow e Talent
      2. Squad → mapeamentos específicos
      3. Projeto → fallback via PROJETO_SEGMENTO
    """
    # 1. Produto — ConstruShow, Petroshow, Talent e Automação Comercial
    if produto:
        if produto in ("Construshow", "ConstruShow", "Web/ Mobile"): return "ConstruShow"
        if produto == "Petroshow":                                    return "Petroshow"
        if produto in ("SAAS", "Delphi"):                            return "Talent"
        if produto == "Automação Comercial":                         return "Automação Comercial"

    # 2. Projetos inativos (nome especial no Jira)
    if projeto == "zViasuper - inativo":            return "Viasuper"
    if projeto == "zAutomação Comercial - inativo": return "Automação Comercial"

    # 3. Squad
    if squad:
        if squad == "Austrália":            return "Agrotitan Fazendas"
        if squad == "Inglaterra":           return "Viasuper"
        if squad == "Testes Automatizados": return "Agrotitan"
        if squad == "Grécia":              return "CRM"
        if squad in ("Blackbird", "Falcon", "Eagle", "Raptor",
                     "Avengers", "Hornet", "Nimitz-Fiscal",
                     "Nimitz-Gerencial"):  return "Nimitz"

    # 3. Projeto → fallback
    return PROJETO_SEGMENTO.get(projeto, projeto)


def normalize_tdc(issue):
    """Normaliza bugs TDC — apenas Bug com class_bug = Cliente/externo (filtrado na JQL)."""
    f = issue["fields"]
    class_bug = po(f.get("customfield_10184")) or "Cliente/externo"
    criado = f.get("created", "")
    mes_ano = ""
    ano = None

    if criado:
        try:
            # API retorna em UTC ex: "2024-01-01T02:30:00.000+0000"
            # Converte para horário Brasil (UTC-3)
            from datetime import timezone, timedelta
            TZ_BR = timezone(timedelta(hours=-3))
            # Parse ISO 8601 — remove timezone info e parseia como UTC
            dt_str = criado[:19]  # "2024-01-01T02:30:00"
            dt_utc = datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
            dt_br  = dt_utc.astimezone(TZ_BR)
            ano    = dt_br.year
            mes_ano = dt_br.strftime("%Y-%m")
        except:
            ano = int(criado[:4]) if criado else None
            mes_ano = criado[:7] if criado else ""

    if ano and ano < TDC_ANO_ANT2:
        return None
    projeto = f.get("project", {}).get("name", "")
    squad   = po(f.get("customfield_10071"))
    prod_raw = f.get("customfield_10259")
    produto  = po(prod_raw) if prod_raw else None

    segmento = get_segmento_tdc(projeto, produto, squad)

    clientes_raw = f.get("customfield_10343") or []
    clientes = [c.get("value") or c.get("name", "") for c in clientes_raw if c]
    bug_gerado = po(f.get("customfield_10069"))

    ULTIMAS_VERSOES = {"3 Últimas Versões", "Última Versão", "3 ultimas versões",
                       "Ultima Versão", "3 Últimas versões", "Ultima versão",
                       "última versão", "ultima versão", "3 últimas versões"}
    is_ultima_versao = bug_gerado in ULTIMAS_VERSOES if bug_gerado else False

    return {
        "chave":          issue["key"],
        "summary":        f.get("summary"),
        "tipo":           f.get("issuetype", {}).get("name"),
        "status":         f.get("status", {}).get("name"),
        "projeto":        projeto,
        "segmento":       segmento,
        "squad":          squad,
        "class_bug":      class_bug,
        "criticidade":    po(f.get("customfield_10166")),
        "bug_gerado":     bug_gerado,
        "is_ultima_versao": is_ultima_versao,
        "origem_bug":     po(f.get("customfield_10173")),
        "produto":        produto,
        "clientes":       clientes,
        "modulo":         po(f.get("customfield_10346")),
        "rotina":         po(f.get("customfield_10169")),
        "criado":         criado,
        "mes_ano":        mes_ano,
        "ano":            ano,
    }

# ── normalize + cálculo — painel Qualidade ──────────────────────────
def normalize_qualidade(issue):
    """Normaliza uma issue resolvida para os índices de qualidade por desenvolvedor."""
    f = issue["fields"]
    resolvido = f.get("resolutiondate") or ""
    ano = None
    if resolvido:
        try: ano = int(resolvido[:4])
        except: ano = None
    return {
        "chave":          issue["key"],
        "summary":        f.get("summary"),
        "status":         (f.get("status") or {}).get("name"),
        "tipo":           (f.get("issuetype") or {}).get("name"),
        "projeto":        f.get("project", {}).get("name"),
        "squad":          po(f.get("customfield_10071")),
        "resolvido":      resolvido[:10],
        "mes":            resolvido[:7] if resolvido else "",
        "ano":            ano,
        "dev":            pu(f.get("customfield_10047")),
        "reprov_codigo":  int(pf(f.get("customfield_12230"))),
        "reprov_interna": int(pf(f.get("customfield_10076"))),
        "origem_bug":     po(f.get("customfield_10173")),  # p/ sinalizar "Falha de Programação" na própria tarefa
    }


def build_qualidade_ano(issues_ano, bugs_externa_por_nome):
    """
    Calcula, para UM ano, os índices de qualidade por desenvolvedor:
      - Índice de qualidade de código:   reprovações em revisão de código (cf 12230) / tarefas
      - Índice de qualidade interna:     reprovações em teste (cf 10076) / tarefas
      - Índice de qualidade externa:     bugs por falha de programação — REAPROVEITADO
                                          diretamente do cálculo já existente do painel
                                          Indicadores (bugs_falha_dev / tx_bug_falha), que já
                                          filtra class_bug=="Cliente/externo" e evita "nomes"
                                          espúrios (ex.: "Não identificado", "Movidesk") que
                                          o campo de origem do bug às vezes contém.
    "tarefas" = tarefas em que a pessoa figura como DEV (customfield_10047).

    bugs_externa_por_nome: dict {nome: {"bugs_falha_dev":int, "tx_bug_falha":float,
                                         "tarefas_bug_dev":[...]}}
    vindo do cálculo já existente em calc_pessoa() (Indicadores) — inclui a lista
    de bugs (usada no drill-down por desenvolvedor no dashboard).

    OBS: o campo "bugs_gerados" por tarefa (via customfield_10095) foi removido
    do drill-down — o usuário reportou que a atribuição tarefa→bug não estava
    confiável o suficiente para exibir por tarefa individual. O ranking geral
    "Tarefa com Mais Número de Bugs" (painel próprio) continua existindo.
    """
    por_dev = defaultdict(lambda: {"qtd_tarefas": 0, "rep_codigo": 0,
                                    "rep_interna": 0, "squads": set(),
                                    "projetos": set(), "tarefas": []})
    for i in issues_ano:
        nome = i["dev"]
        if not nome: continue
        d = por_dev[nome]
        d["qtd_tarefas"] += 1
        d["rep_codigo"]  += i["reprov_codigo"]
        d["rep_interna"] += i["reprov_interna"]
        if i["projeto"]: d["projetos"].add(i["projeto"])
        if i["squad"]:   d["squads"].add(i["squad"])
        d["tarefas"].append({
            "chave":          i["chave"],
            "summary":        i["summary"],
            "status":         i["status"],
            "tipo":           i["tipo"],
            "projeto":        i["projeto"],
            "squad":          i["squad"],
            "mes":            i["mes"],
            "reprov_codigo":  i["reprov_codigo"],
            "reprov_interna": i["reprov_interna"],
        })

    lista = []
    for nome, d in por_dev.items():
        qtd = d["qtd_tarefas"] or 1
        externa = bugs_externa_por_nome.get(nome, {})
        bugs_prog = externa.get("bugs_falha_dev", 0)
        tarefas_ordenadas = sorted(d["tarefas"], key=lambda t: t["mes"], reverse=True)
        lista.append({
            "nome":                 nome,
            "qtd_tarefas":          d["qtd_tarefas"],
            "rep_codigo":           d["rep_codigo"],
            "tx_qualidade_codigo":  round(d["rep_codigo"]  / qtd * 100, 2),
            "rep_interna":          d["rep_interna"],
            "tx_qualidade_interna":round(d["rep_interna"] / qtd * 100, 2),
            "bugs_prog":            bugs_prog,
            "tx_qualidade_externa":round(bugs_prog / qtd * 100, 2),
            "projetos":             sorted(d["projetos"]),
            "squads":               sorted(d["squads"]),
            "tarefas":              tarefas_ordenadas,
            "bugs_tarefas":         externa.get("tarefas_bug_dev", []),
        })
    lista.sort(key=lambda x: x["nome"])
    return lista


# ── ranking "Tarefa com mais número de bugs" (customfield_10095) ────────────
# Exige número > 0 no final (ex.: PS-0 é lixo/placeholder, não uma tarefa real)
_RE_CHAVE_ISSUE = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,9}-([1-9]\d*)$")

def build_bug_counts_ano(raw_fechados):
    """
    Conta, para os Bugs resolvidos no ano corrente (reaproveita raw_fechados,
    já buscado para o Fluxo — sem query dedicada), ocorrências de
    customfield_10095 (Tarefa Origem Inconsistência), desconsiderando valores
    vazios, '0', '-' ou qualquer texto que não pareça uma chave de issue real
    (ex.: "Não identificado", "N/A", "Nenhuma", "Antigo", "TMS", "PS-0"). Só
    entram valores no formato "PROJ-123" com número > 0. Retorna
    {chave_origem: qtd} — apenas deste ano.
    """
    contagem = defaultdict(int)
    for issue in raw_fechados:
        f = issue["fields"]
        if (f.get("issuetype") or {}).get("name") != "Bug":
            continue
        val = f.get("customfield_10095")
        val = val.strip() if isinstance(val, str) else ""
        if not _RE_CHAVE_ISSUE.match(val): continue
        contagem[val] += 1
    return dict(contagem)


def merge_bug_ranking(bug_counts_por_ano, max_top=50):
    """Soma as contagens de todos os anos já mesclados e devolve o top N geral."""
    total = defaultdict(int)
    for ano_counts in bug_counts_por_ano.values():
        for chave, qtd in ano_counts.items():
            total[chave] += qtd
    ranking = sorted(total.items(), key=lambda x: x[1], reverse=True)[:max_top]
    return [{"chave_origem": k, "qtd_bugs": v} for k, v in ranking]


def fetch_fixversions_for_keys(keys):
    """
    Busca metadados das tarefas-origem do ranking de bugs (em lotes, evita 414):
    resumo, status, fixVersions e squad/produto/projeto — usados pelos filtros
    do painel Dev.
    """
    raw = fetch_jql_by_keys(keys, "key,summary,fixVersions,status,project,customfield_10071,customfield_10259", "FixVersions Origem")
    out = {}
    for i in raw:
        f = i["fields"]
        out[i["key"]] = {
            "summary":      f.get("summary"),
            "status":       (f.get("status") or {}).get("name"),
            "fix_versions": [v.get("name","") for v in (f.get("fixVersions") or []) if v],
            "projeto":      (f.get("project") or {}).get("name"),
            "squad":        po(f.get("customfield_10071")),
            "produto":      po(f.get("customfield_10259")),
        }
    return out


# ── NOVO: "Tarefas feitas na semana" (via changelog — transições p/ Desenvolvida) ──
def build_tarefas_semana(raw_desenvolvida):
    """
    Para cada issue (query dedicada 'status changed to Desenvolvida') que
    passou pelo status STATUS_DESENVOLVIDA, localiza a transição mais recente
    e retorna um registro por issue (com squad/projeto/produto) — para que o
    dashboard possa aplicar os MESMOS filtros usados nos outros quadros da
    página (Desenvolvedor/Squad/Projeto/Produto). A agregação por semana é
    feita no client, depois de filtrar.
    """
    resultado = []
    for issue in raw_desenvolvida:
        f = issue["fields"]
        dev = pu(f.get("customfield_10047"))
        if not dev: continue
        histories = (issue.get("changelog") or {}).get("histories", [])
        if not histories: continue   # normal: a maioria não passou por nenhuma transição registrada
        datas_transicao = []
        for h in histories:
            for item in h.get("items", []):
                if item.get("field") == "status" and item.get("toString") == STATUS_DESENVOLVIDA:
                    datas_transicao.append(h.get("created"))
        if not datas_transicao: continue
        data_str = max(datas_transicao)  # transição mais recente para o status
        try:
            data = datetime.strptime(data_str[:10], "%Y-%m-%d").date()
        except Exception:
            continue
        iso_ano, iso_semana, _ = data.isocalendar()
        semana_key = f"{iso_ano}-W{iso_semana:02d}"
        resultado.append({
            "chave":   issue["key"],
            "semana":  semana_key,
            "dev":     dev,
            "squad":   po(f.get("customfield_10071")),
            "projeto": (f.get("project") or {}).get("name"),
            "produto": po(f.get("customfield_10259")),
        })
    resultado.sort(key=lambda x: x["semana"])
    return resultado


# ── "Progresso da Epic" (via campo parent — reaproveita Backlog + Fluxo) ────
def build_epic_progress(issues_com_parent):
    """
    Agrupa issues (já buscadas para Backlog/Fluxo, com o campo 'parent' incluído)
    por Epic e calcula % de conclusão. Não faz nenhuma query dedicada de Epics —
    o parent aponta direto pra Epic (ou é None se não houver).
    ATENÇÃO: assume o campo 'parent' (padrão em projetos team-managed / next-gen).
    Se sua organização usa Epic Link clássico (customfield próprio) em projetos
    company-managed, os filhos desses projetos não serão contabilizados aqui.

    issues_com_parent: lista de dicts com {"parent_key":..., "status":...}
    """
    child_by_epic = defaultdict(list)
    for i in issues_com_parent:
        epic_key = i.get("parent_key")
        if not epic_key: continue
        child_by_epic[epic_key].append(i.get("status"))

    if not child_by_epic:
        return []

    # Busca resumo/status das Epics em lotes pequenos (evita 414) — só das que
    # realmente aparecem como parent de alguma issue já buscada.
    epic_info = {}
    raw_epics = fetch_jql_by_keys(list(child_by_epic.keys()), "key,summary,status,project", "Epics (parent)")
    for e in raw_epics:
        f = e["fields"]
        epic_info[e["key"]] = {
            "summary": f.get("summary"),
            "status":  (f.get("status") or {}).get("name"),
            "projeto": (f.get("project") or {}).get("name"),
        }

    resultado = []
    for epic_key, statuses in child_by_epic.items():
        statuses_validos = [s for s in statuses if s not in CANCEL_STATUSES_EPIC]
        total = len(statuses_validos)
        done  = sum(1 for s in statuses_validos if s in DONE_STATUSES_EPIC)
        info = epic_info.get(epic_key, {})
        resultado.append({
            "chave":            epic_key,
            "summary":          info.get("summary"),
            "status":           info.get("status"),
            "projeto":          info.get("projeto"),
            "total_filhos":     total,
            "filhos_concluidos":done,
            "progresso_pct":    round(done/total*100, 1) if total else 0,
        })
    # Ordena pelo que mais falta (menor progresso primeiro); Epics sem filhos
    # (sem dado de progresso) ficam no final.
    resultado.sort(key=lambda x: (x["total_filhos"] == 0, x["progresso_pct"]))
    return resultado



# ── índices para lookup O(1) ──────────────────────────
def build_indexes(issues):
    idx = {
        "ar":     defaultdict(list),
        "at":     defaultdict(list),
        "dev":    defaultdict(list),
        "at_tec": defaultdict(list),
        "ar_orig":defaultdict(list),
        "at_orig":defaultdict(list),
        "dev_orig":defaultdict(list),
    }
    for i in issues:
        if i["ar"]:     idx["ar"][i["ar"]].append(i)
        if i["at"]:     idx["at"][i["at"]].append(i)
        if i["dev"]:    idx["dev"][i["dev"]].append(i)
        if i["at_tec"]: idx["at_tec"][i["at_tec"]].append(i)
        if i["class_bug"] == "Cliente/externo":
            if i["origem_bug"] == "Falha de Análise" and i["ar_origem"]:
                idx["ar_orig"][i["ar_origem"]].append(i)
            if i["origem_bug"] == "Falha de Programação":
                if i["at_origem"]:  idx["at_orig"][i["at_origem"]].append(i)
                if i["dev_origem"]: idx["dev_orig"][i["dev_origem"]].append(i)
    return idx

def cargo_principal(nome, idx):
    counts = {
        "AR":     len(idx["ar"][nome]),
        "AT":     len(idx["at"][nome]),
        "DEV":    len(idx["dev"][nome]),
        "AT_TEC": len(idx["at_tec"][nome]),
    }
    return max(counts, key=counts.get), counts

def calcular(nome, cargo, idx):
    campo = {"AR":"ar","AT":"at","DEV":"dev","AT_TEC":"at_tec"}[cargo]
    tasks = idx[campo][nome]
    seen  = {t["chave"] for t in tasks}

    if cargo in ("AR","AT"):
        extras = [i for i in idx["at"][nome] + idx["ar"][nome] if i["chave"] not in seen]
    else:
        extras = [i for i in idx["at_tec"][nome] + idx["dev"][nome] if i["chave"] not in seen]

    seen2 = set(); extras2 = []
    for i in extras:
        if i["chave"] not in seen and i["chave"] not in seen2:
            seen2.add(i["chave"]); extras2.append(i)
    extras = extras2

    pontos = 0.0
    monthly = defaultdict(float)
    tarefas = []
    projetos_set = set()
    squads_set   = set()

    for t in tasks + extras:
        if cargo in ("AR","AT"):
            p1 = t["pts_req"]  if t["ar"]     == nome else 0.0
            p2 = t["pts_test"] if t["at"]     == nome else 0.0
        else:
            p1 = t["pts_dev"]    if t["dev"]    == nome else 0.0
            p2 = t["pts_at_tec"] if t["at_tec"] == nome else 0.0

        pts = p1 + p2
        if pts == 0.0: continue

        pontos += pts
        monthly[t["mes"]] += pts
        if t["projeto"]: projetos_set.add(t["projeto"])
        if t["squad"]:   squads_set.add(t["squad"])

        tarefas.append({
            "chave":     t["chave"],
            "summary":   t["summary"],
            "status":    t["status"],
            "tipo":      t["tipo"],
            "projeto":   t["projeto"],
            "squad":     t["squad"],
            "mes":       t["mes"],
            "pts_p1":    round(p1, 3),
            "pts_p2":    round(p2, 3),
            "pontos":    round(pts, 3),
            "is_ar":     t["ar"]     == nome,
            "is_at":     t["at"]     == nome,
            "is_dev":    t["dev"]    == nome,
            "is_at_tec": t["at_tec"] == nome,
        })

    tarefas.sort(key=lambda x: x["mes"], reverse=True)
    fin = [t for t in tasks if t["status"] == "Finalizada"]
    rep = [t for t in tasks if t["status"] == "Análise Reprovada"]
    tipo_counts = defaultdict(int)
    for t in tasks: tipo_counts[t["tipo"]] += 1

    return {
        "qtd_tarefas":   len(tasks),
        "finalizadas":   len(fin),
        "reprovadas":    len(rep),
        "tx_reprov_pct": round(len(rep)/len(tasks)*100, 2) if tasks else 0,
        "pontos":        round(pontos, 1),
        "monthly":       {m.replace(f"{ANO}-",""): round(v,2) for m,v in sorted(monthly.items())},
        "tipo_counts":   dict(tipo_counts),
        "tarefas":       tarefas,
        "projetos":      sorted(projetos_set),
        "squads":        sorted(squads_set),
    }

def calcular_bugs(nome, cargo, idx):
    bugs_req  = idx["ar_orig"][nome]
    bugs_test = idx["at_orig"][nome]
    bugs_dev  = idx["dev_orig"][nome]

    def fmt(lst, tipo_falha):
        return [{"chave": i["chave"], "summary": i["summary"],
                 "tipo_falha": tipo_falha, "crit_bug": i["crit_bug"],
                 "projeto": i["projeto"], "squad": i["squad"], "mes": i["mes"]} for i in lst]

    bug_cargo = bugs_req if cargo=="AR" else bugs_test if cargo=="AT" else bugs_dev
    return {
        "bugs_falha_req":   len(bugs_req),
        "bugs_falha_test":  len(bugs_test),
        "bugs_falha_dev":   len(bugs_dev),
        "bug_cargo":        len(bug_cargo),
        "tx_bug_falha":     0.0,
        "tarefas_bug_req":  fmt(bugs_req,  "Falha de Análise"),
        "tarefas_bug_test": fmt(bugs_test, "Falha de Programação"),
        "tarefas_bug_dev":  fmt(bugs_dev,  "Falha de Programação"),
    }

def normalize_aberto(issue):
    f = issue["fields"]
    prazo_str = f.get("customfield_10044")
    dias_prazo, prazo_vencido = None, False
    if prazo_str:
        try:
            prazo = datetime.strptime(prazo_str, "%Y-%m-%d").date()
            dias_prazo = (prazo - date.today()).days
            prazo_vencido = dias_prazo < 0
        except: pass

    prod_raw = f.get("customfield_10259")
    clientes_raw = f.get("customfield_10343") or []
    clientes = [c.get("value") or c.get("name","") for c in clientes_raw if c]

    return {
        "chave":         issue["key"],
        "tipo":          f.get("issuetype", {}).get("name"),
        "status":        f.get("status", {}).get("name"),
        "summary":       f.get("summary"),
        "responsavel":   pu(f.get("assignee")),
        "projeto":       f.get("project", {}).get("name"),
        "squad":         po(f.get("customfield_10071")),
        "class_bug":     po(f.get("customfield_10184")),
        "criticidade":   po(f.get("customfield_10166")),
        "rotina":        po(f.get("customfield_10169")),
        "bug_gerado":    po(f.get("customfield_10069")),
        "class_melhoria":po(f.get("customfield_10180")),
        "gut_resultado": pnum(f.get("customfield_10031")),
        "clientes":      clientes,
        "modulo":        po(f.get("customfield_10346")),
        "produtos":      [po(prod_raw)] if prod_raw else [],
        "prazo":         prazo_str,
        "dias_prazo":    dias_prazo,
        "prazo_vencido": prazo_vencido,
        "criado":        f.get("created"),
    }


def agrupar_por_responsavel(tarefas):
    grupos = defaultdict(list)
    for t in tarefas:
        grupos[t["responsavel"] or "Sem responsável"].append(t)
    resultado = []
    for resp, tasks in grupos.items():
        vencidas = sum(1 for t in tasks if t["prazo_vencido"])
        hoje     = sum(1 for t in tasks if t["dias_prazo"] is not None and 0 <= t["dias_prazo"] <= 1)
        resultado.append({
            "responsavel": resp, "total": len(tasks),
            "vencidas": vencidas, "vence_hoje": hoje,
            "tarefas": sorted(tasks, key=lambda x: (x["prazo"] or "9999", x["projeto"] or "")),
        })
    return sorted(resultado, key=lambda x: (-x["vencidas"], -x["total"]))

# ── Gerar estatísticas TDC agregadas ─────────────────
def gerar_stats_tdc(bugs_tdc):
    """Gera estatísticas agregadas para o dashboard TDC (3 anos: atual, anterior, anterior-do-anterior)."""
    por_seg        = defaultdict(lambda: {"ant2": 0, "ant": 0, "atual": 0})
    por_bug_gerado = defaultdict(lambda: {"ant2": 0, "ant": 0, "atual": 0})
    por_mes   = defaultdict(int)
    por_crit  = defaultdict(int)
    # usa as constantes dinâmicas definidas no topo do script
    _ANO_ATUAL = TDC_ANO_ATUAL
    _ANO_ANT   = TDC_ANO_ANT
    _ANO_ANT2  = TDC_ANO_ANT2

    for b in bugs_tdc:
        ano = b.get("ano")
        seg = b.get("segmento", "Outros")
        bg  = b.get("bug_gerado") or "Não informado"
        ma  = b.get("mes_ano", "")
        cr  = b.get("criticidade") or "Sem Criticidade"

        if ano == _ANO_ATUAL:
            por_seg[seg]["atual"] += 1
            por_bug_gerado[bg]["atual"] += 1
        elif ano == _ANO_ANT:
            por_seg[seg]["ant"] += 1
            por_bug_gerado[bg]["ant"] += 1
        elif ano == _ANO_ANT2:
            por_seg[seg]["ant2"] += 1
            por_bug_gerado[bg]["ant2"] += 1

        if ma: por_mes[ma] += 1
        por_crit[cr] += 1

    def var_pct(ant, atual):
        return round((atual - ant) / ant * 100, 2) if ant > 0 else None

    segs = sorted(por_seg.items(), key=lambda x: x[1]["atual"], reverse=True)
    bgs  = sorted(por_bug_gerado.items(), key=lambda x: x[1]["atual"], reverse=True)

    return {
        "ano_atual": _ANO_ATUAL,
        "ano_ant":   _ANO_ANT,
        "ano_ant2":  _ANO_ANT2,
        "por_segmento": [
            {"segmento": s,
             "ant2": v["ant2"], "ant": v["ant"], "atual": v["atual"],
             "var_pct_ant_ant2": var_pct(v["ant2"], v["ant"]),
             "var_pct_atual_ant": var_pct(v["ant"], v["atual"])}
            for s, v in segs
        ],
        "por_bug_gerado": [
            {"bug_gerado": bg,
             "ant2": v["ant2"], "ant": v["ant"], "atual": v["atual"],
             "var_pct_ant_ant2": var_pct(v["ant2"], v["ant"]),
             "var_pct_atual_ant": var_pct(v["ant"], v["atual"])}
            for bg, v in bgs
        ],
        "por_mes":  dict(sorted(por_mes.items())),
        "por_criticidade": dict(sorted(por_crit.items(), key=lambda x: x[1], reverse=True)),
        "total_ant2":  sum(b.get("ano") == _ANO_ANT2  for b in bugs_tdc),
        "total_ant":   sum(b.get("ano") == _ANO_ANT   for b in bugs_tdc),
        "total_atual": sum(b.get("ano") == _ANO_ATUAL for b in bugs_tdc),
        "total_geral": len(bugs_tdc),
    }


def fetch_boards_and_sprints():
    session = requests.Session()
    sprint_meta = {}
    PROJ_KEYS = ["AG","PS","CS","FS","BI","TECD","VO","TAL","NM","CWM","AGF"]
    board_ids = set()
    try:
        for proj in PROJ_KEYS:
            url = f"{JIRA_BASE_URL}/rest/agile/1.0/board"
            r = session.get(url, auth=get_auth(), headers=get_headers(),
                            params={"projectKeyOrId": proj, "maxResults": 50}, timeout=30)
            if r.ok:
                for b in r.json().get("values", []):
                    board_ids.add(b["id"])
    except Exception as e:
        print(f"   ⚠ Boards: {e}")
    for bid in board_ids:
        for state in ("active", "closed"):
            start = 0
            while True:
                try:
                    url = f"{JIRA_BASE_URL}/rest/agile/1.0/board/{bid}/sprint"
                    r = session.get(url, auth=get_auth(), headers=get_headers(),
                                    params={"state": state, "startAt": start, "maxResults": 50}, timeout=30)
                    if not r.ok: break
                    data = r.json()
                    for sp in data.get("values", []):
                        cd = sp.get("completeDate","") or ""
                        if state == "closed" and cd and cd[:10] < DATA_6M:
                            continue
                        name = sp.get("name","")
                        sprint_meta[name] = {
                            "id":           sp.get("id"),
                            "state":        sp.get("state","").lower(),
                            "startDate":    (sp.get("startDate") or "")[:10],
                            "endDate":      (sp.get("endDate") or "")[:10],
                            "completeDate": cd[:10] if cd else None,
                            "boardId":      bid,
                        }
                    if data.get("isLast", True): break
                    start += 50
                except Exception as e:
                    print(f"   ⚠ Board {bid}/{state}: {e}")
                    break
    print(f"   ✓ {len(sprint_meta)} sprints com metadados (boards: {len(board_ids)})")
    return sprint_meta


def normalize_sprint(issue, sprint_meta=None):
    import re as _re
    sprint_meta = sprint_meta or {}
    f = issue["fields"]
    sprints_raw = f.get("customfield_10010") or []
    sprint_names = []
    sprint_raw_meta = {}
    for s in sprints_raw:
        if isinstance(s, str):
            m = _re.search(r'name=([^,\]]+)', s)
            name = m.group(1).strip() if m else s
            sprint_names.append(name)
            def _extract(key, _s=s):
                mm = _re.search(rf'{key}=([^,\]]+)', _s)
                return mm.group(1).strip() if mm else None
            raw_state = (_extract("state") or "").lower()
            sprint_raw_meta[name] = {
                "state":        "closed" if "close" in raw_state else ("future" if "future" in raw_state else "active"),
                "startDate":    (_extract("startDate") or "")[:10] or None,
                "endDate":      (_extract("endDate") or "")[:10] or None,
                "completeDate": (_extract("completeDate") or "")[:10] or None,
            }
        elif isinstance(s, dict):
            name = s.get("name","")
            sprint_names.append(name)
            cd = s.get("completeDate","") or ""
            raw_state = (s.get("state","") or "").lower()
            sprint_raw_meta[name] = {
                "state":        "closed" if "close" in raw_state else ("future" if "future" in raw_state else "active"),
                "startDate":    (s.get("startDate","") or "")[:10] or None,
                "endDate":      (s.get("endDate","") or "")[:10] or None,
                "completeDate": cd[:10] if cd else None,
            }
    sprint_name = sprint_names[0] if sprint_names else None
    all_sprint_names = sprint_names  # todas as sprints da issue
    meta     = sprint_meta.get(sprint_name, {}) if sprint_name else {}
    raw_meta = sprint_raw_meta.get(sprint_name, {}) if sprint_name else {}
    def _meta(key, default=None):
        return meta.get(key) or raw_meta.get(key) or default
    raw_state = (_meta("state","") or "").lower()
    if "close" in raw_state:    sprint_state = "closed"
    elif "future" in raw_state: sprint_state = "future"
    else:                       sprint_state = "active"

    produto_raw  = f.get("customfield_10259")
    produto      = po(produto_raw) if produto_raw else None
    story_points = f.get("customfield_10014")
    prioridade   = (f.get("priority") or {}).get("name")
    status_name  = (f.get("status") or {}).get("name","")
    DONE_STATUS  = {"Finalizada","Análise Reprovada","Finalizado","Done","Concluída"}
    concluida    = status_name in DONE_STATUS
    fix_versions = [v.get("name","") for v in (f.get("fixVersions") or []) if v]

    base = {
        "chave":           issue["key"],
        "summary":         f.get("summary"),
        "tipo":            (f.get("issuetype") or {}).get("name"),
        "status":          status_name,
        "projeto":         (f.get("project") or {}).get("name"),
        "squad":           po(f.get("customfield_10071")),
        "criado":          (f.get("created") or "")[:10],
        "resolvido":       (f.get("resolutiondate") or "")[:10] or None,
        "responsavel":     pu(f.get("assignee")),
        "class_bug":       po(f.get("customfield_10184")),
        "crit_bug":        po(f.get("customfield_10166")),
        "rotina":          po(f.get("customfield_10169")),
        "bug_gerado":      po(f.get("customfield_10069")),
        "produto":         produto,
        "prioridade":      prioridade,
        "fix_versions":    fix_versions,
        "story_points":    float(story_points) if story_points else None,
        # concluida é calculada por sprint abaixo
        "est_req":         float(f.get("customfield_10178") or 0) or None,
        "est_at_tec":      float(f.get("customfield_10825") or 0) or None,
        "est_dev":         float(f.get("customfield_10114") or 0) or None,
        "est_test":        float(f.get("customfield_10115") or 0) or None,
    }

    # Gera um item por sprint (issues em múltiplas sprints aparecem em cada uma)
    results = []
    for sp_name in (all_sprint_names if all_sprint_names else [None]):
        sp_meta  = sprint_meta.get(sp_name, {}) if sp_name else {}
        sp_raw   = sprint_raw_meta.get(sp_name, {}) if sp_name else {}
        def _sp(key, default=None, _m=sp_meta, _r=sp_raw):
            return _m.get(key) or _r.get(key) or default
        raw_st = (_sp("state","") or "").lower()
        st = "closed" if "close" in raw_st else ("future" if "future" in raw_st else "active")

        # Concluída nesta sprint: só se a data de resolução cai dentro do período da sprint
        # ou se é a última sprint da issue e está concluída
        sp_end  = _sp("endDate") or _sp("completeDate")
        sp_start= _sp("startDate")
        resolvido = base.get("resolvido") or ""
        if concluida and resolvido and sp_start and sp_end:
            # Conta como concluída nesta sprint se resolvido caiu dentro do período
            concluida_aqui = sp_start <= resolvido <= sp_end
        elif concluida and sp_name == all_sprint_names[-1]:
            # Sem datas de sprint, atribui à última sprint
            concluida_aqui = True
        else:
            concluida_aqui = False

        results.append({**base,
            "sprint":          sp_name,
            "sprint_state":    st,
            "sprint_start":    _sp("startDate"),
            "sprint_end":      _sp("endDate"),
            "sprint_complete": _sp("completeDate"),
            "concluida":       concluida_aqui,
        })
    return results

# ── MAIN ─────────────────────────────────────────────
def main():
    t0 = time.time()
    print(f"=== Jira Extractor {ANO_ATUAL_INT} (otimizado) ===\n")

    # 1. Consultas em PARALELO (indicadores + aberto + TDC + Qualidade/Dev)
    print("1. Buscando issues em paralelo...")
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_issues  = ex.submit(fetch_jql, JQL,               FIELDS_IDS,    "Indicadores")
        f_abertos = ex.submit(fetch_jql, JQL_ABERTOS_ANO,  FIELDS_IDS,    f"Abertos {ANO}")
        f_fechados= ex.submit(fetch_jql, JQL_FECHADOS_ANO, FIELDS_IDS,    f"Fechados {ANO}")
        f_aberto  = ex.submit(fetch_jql, JQL_ABERTO, FIELDS_ABERTO, "Aberto")
        f_tdc     = ex.submit(fetch_jql, JQL_TDC,    FIELDS_TDC,    "TDC")
        f_sprint        = ex.submit(fetch_jql, JQL_SPRINT,        FIELDS_SPRINT, "Sprint Aberta")
        f_sprint_closed = ex.submit(fetch_jql, JQL_SPRINT_CLOSED, FIELDS_SPRINT, "Sprint Fechada")
        f_sprint_meta   = ex.submit(fetch_boards_and_sprints)
        f_users         = ex.submit(fetch_active_users)
        f_desenvolvida  = ex.submit(fetch_jql, JQL_DESENVOLVIDA, FIELDS_DESENVOLVIDA, "Desenvolvida", expand="changelog")
        raw_issues      = f_issues.result()
        raw_abertos     = f_abertos.result()
        raw_fechados    = f_fechados.result()
        print(f"   Abertos {ANO}: {len(raw_abertos)} | Fechados {ANO}: {len(raw_fechados)}")
        raw_aberto      = f_aberto.result()
        raw_tdc         = f_tdc.result()
        raw_sprint      = f_sprint.result()
        raw_sprint_cl   = f_sprint_closed.result()
        sprint_meta     = f_sprint_meta.result()
        usuarios_ativos = f_users.result()
        raw_desenvolvida= f_desenvolvida.result()

    # Qualidade e Progresso da Epic: NÃO fazem query dedicada — reaproveitam
    # raw_fechados (resolvidos do ano, já buscado p/ Fluxo) e raw_aberto
    # (backlog aberto, já buscado p/ Backlog). Isso evita repetir uma varredura
    # multi-ano pesada e evita o 414 de "parent in (milhares de epics)".

    print(f"\n2. Normalizando {len(raw_issues)} issues...")
    issues = [normalize(i) for i in raw_issues]
    with atomic_output("issues_raw.json") as f:
        json.dump(issues, f, ensure_ascii=False, separators=(',',':'))

    print(f"   Normalizando {len(raw_tdc)} issues TDC...")
    bugs_tdc_raw = [normalize_tdc(i) for i in raw_tdc]
    bugs_tdc = [b for b in bugs_tdc_raw if b is not None]  # filtra anos fora do range (ajuste UTC)
    print(f"   ✓ {len(bugs_tdc)} bugs TDC (Cliente/externo + Sem classificação) de {len(raw_tdc)} totais")

    print("3. Construindo índices...")
    idx = build_indexes(issues)

    all_projetos = sorted(set(i["projeto"] for i in issues if i["projeto"]))
    all_squads   = sorted(set(i["squad"]   for i in issues if i["squad"]))

    print("4. Identificando profissionais ativos (≥10 tarefas)...")
    contador = defaultdict(lambda:{"AR":0,"AT":0,"DEV":0,"AT_TEC":0})
    for nome, lst in idx["ar"].items():     contador[nome]["AR"]     = len(lst)
    for nome, lst in idx["at"].items():     contador[nome]["AT"]     = len(lst)
    for nome, lst in idx["dev"].items():    contador[nome]["DEV"]    = len(lst)
    for nome, lst in idx["at_tec"].items(): contador[nome]["AT_TEC"] = len(lst)

    pessoas, inativos = [], []
    for nome, counts in contador.items():
        cargo = max(counts, key=counts.get)
        if counts[cargo] >= 10:
            if nome in usuarios_ativos: pessoas.append((nome, cargo))
            else: inativos.append(nome)

    if inativos:
        print(f"   ⚠️  {len(inativos)} inativos ignorados")
    pessoas.sort(key=lambda x: x[0])
    print(f"   ✓ {len(pessoas)} profissionais ativos")

    print("5. Calculando indicadores em paralelo...")
    def calc_pessoa(args):
        nome, cargo = args
        _, role_counts = cargo_principal(nome, idx)
        dados = calcular(nome, cargo, idx)
        bugs  = calcular_bugs(nome, cargo, idx)
        qtd   = dados["qtd_tarefas"]
        bugs["tx_bug_falha"] = round(bugs["bug_cargo"]/qtd*100, 2) if qtd else 0
        return {"nome":nome,"cargo":cargo,"role_counts":role_counts,**dados,**bugs}

    with ThreadPoolExecutor(max_workers=8) as ex:
        resultados = list(ex.map(calc_pessoa, pessoas))

    resultados.sort(key=lambda x: x["pontos"], reverse=True)

    print(f"6. Normalizando {len(raw_aberto)} tarefas em aberto...")
    tarefas_abertas = [normalize_aberto(i) for i in raw_aberto]
    por_responsavel = agrupar_por_responsavel(tarefas_abertas)

    print("7. Gerando estatísticas TDC...")
    stats_tdc = gerar_stats_tdc(bugs_tdc)

    output = {
        "profissionais":  resultados,
        "all_projetos":   all_projetos,
        "all_squads":     all_squads,
        "tarefas_abertas":tarefas_abertas,
        "por_responsavel":por_responsavel,
        "total_aberto":   len(tarefas_abertas),
        "gerado_em":      _agora().strftime("%d/%m/%Y %H:%M"),
    }

    fname = "dashboard_data.json" if ANO == str(ANO_ATUAL_INT) else f"dashboard_data_{ANO}.json"
    with atomic_output(fname) as f:
        json.dump(output, f, ensure_ascii=False, separators=(',',':'))

    # Salvar TDC separado (sempre tdc_data.json — cobre os 3 anos dinâmicos)
    tdc_output = {
        "bugs":         bugs_tdc,
        "stats":        stats_tdc,
        "total":        len(bugs_tdc),
        "gerado_em":    _agora().strftime("%d/%m/%Y %H:%M"),
    }
    with atomic_output("tdc_data.json") as f:
        json.dump(tdc_output, f, ensure_ascii=False, separators=(',',':'))



    # Salvar abertos_data.json e fechados_data.json (para painel Supervisão)
    print(f"9. Normalizando {len(raw_abertos)} itens Abertos {ANO} e {len(raw_fechados)} Fechados {ANO}...")
    abertos_output = {
        "itens":     [normalize(i) for i in raw_abertos],
        "total":     len(raw_abertos),
        "gerado_em": _agora().strftime("%d/%m/%Y %H:%M"),
    }
    with atomic_output("abertos_data.json") as f:
        json.dump(abertos_output, f, ensure_ascii=False, separators=(',',':'))

    fechados_output = {
        "itens":     [normalize(i) for i in raw_fechados],
        "total":     len(raw_fechados),
        "gerado_em": _agora().strftime("%d/%m/%Y %H:%M"),
    }
    with atomic_output("fechados_data.json") as f:
        json.dump(fechados_output, f, ensure_ascii=False, separators=(',',':'))
    print(f"   ✓ {len(raw_abertos)} abertos → abertos_data.json | {len(raw_fechados)} fechados → fechados_data.json")

    # Sprint
    sprint_itens    = [item for i in raw_sprint    for item in normalize_sprint(i, sprint_meta)]
    sprint_itens_cl = [item for i in raw_sprint_cl for item in normalize_sprint(i, sprint_meta)]

    def build_sprint_summary(itens):
        from collections import defaultdict as _dd
        sprint_map = _dd(lambda: {"pts_plan":0.0,"pts_done":0.0,"tasks_plan":0,"tasks_done":0,
                                   "bugs":0,"melhorias":0,"tarefas":0,
                                   "est_req":0.0,"est_at_tec":0.0,"est_dev":0.0,"est_test":0.0,
                                   "sprint_state":"","sprint_start":None,"sprint_end":None,"sprint_complete":None})
        for it in itens:
            sp = it.get("sprint") or "Sem Sprint"
            m  = sprint_map[sp]
            pts = it.get("story_points") or 0
            m["pts_plan"]   += pts
            m["tasks_plan"] += 1
            if it.get("concluida"):
                m["pts_done"]   += pts
                m["tasks_done"] += 1
            m["est_req"]    += it.get("est_req")    or 0
            m["est_at_tec"] += it.get("est_at_tec") or 0
            m["est_dev"]    += it.get("est_dev")    or 0
            m["est_test"]   += it.get("est_test")   or 0
            t = it.get("tipo","")
            if t == "Bug":      m["bugs"]      += 1
            elif t in ("Melhoria","Nova Funcionalidade"): m["melhorias"] += 1
            else:               m["tarefas"]   += 1
            if not m["sprint_state"] and it.get("sprint_state"):
                m["sprint_state"]    = it.get("sprint_state","")
                m["sprint_start"]    = it.get("sprint_start")
                m["sprint_end"]      = it.get("sprint_end")
                m["sprint_complete"] = it.get("sprint_complete")
        summary = []
        for sp_name, v in sprint_map.items():
            say_do_pts   = round(v["pts_done"]   / v["pts_plan"]   * 100, 1) if v["pts_plan"]   > 0 else None
            say_do_tasks = round(v["tasks_done"] / v["tasks_plan"] * 100, 1) if v["tasks_plan"] > 0 else None
            summary.append({
                "sprint": sp_name,
                "sprint_state":   v["sprint_state"] or "active",
                "sprint_start":   v["sprint_start"],
                "sprint_end":     v["sprint_end"],
                "sprint_complete":v["sprint_complete"],
                "tasks_plan": v["tasks_plan"], "tasks_done": v["tasks_done"],
                "pts_plan": round(v["pts_plan"],1), "pts_done": round(v["pts_done"],1),
                "say_do_pts": say_do_pts, "say_do_tasks": say_do_tasks,
                "bugs": v["bugs"], "melhorias": v["melhorias"], "tarefas": v["tarefas"],
                "est_req":    round(v["est_req"],1),
                "est_at_tec": round(v["est_at_tec"],1),
                "est_dev":    round(v["est_dev"],1),
                "est_test":   round(v["est_test"],1),
                "est_total":  round(v["est_req"]+v["est_at_tec"]+v["est_dev"]+v["est_test"],1),
            })
        return summary

    sprint_output = {
        "itens":          sprint_itens,
        "itens_fechadas": sprint_itens_cl,
        "sprints":        build_sprint_summary(sprint_itens),
        "sprints_closed": build_sprint_summary(sprint_itens_cl),
        "total":          len(sprint_itens),
        "total_closed":   len(sprint_itens_cl),
        "gerado_em":      _agora().strftime("%d/%m/%Y %H:%M"),
    }
    with atomic_output("sprint_data.json") as f:
        json.dump(sprint_output, f, ensure_ascii=False, separators=(',',':'))
    print(f"   ✓ {len(sprint_itens)} itens abertos + {len(sprint_itens_cl)} fechados → sprint_data.json")

    # ── Painel Qualidade — reaproveita raw_fechados (resolvidos do ano, já ──
    # buscado para o Fluxo). Sem query dedicada 2025+; para ter vários anos no
    # dashboard, basta rodar o script uma vez por ano (igual já se faz para
    # dashboard_data_2025.json) — o resultado é mesclado em qualidade_data.json.
    print(f"10. Normalizando {len(raw_fechados)} tarefas resolvidas de {ANO} para o painel Qualidade...")
    qual_issues_ano = [normalize_qualidade(i) for i in raw_fechados if i["fields"].get("issuetype",{}).get("name") != "Epic"]
    bugs_externa_por_nome = {r["nome"]: {"bugs_falha_dev":  r.get("bugs_falha_dev", 0),
                                          "tx_bug_falha":    r.get("tx_bug_falha", 0),
                                          "tarefas_bug_dev": r.get("tarefas_bug_dev", [])}
                              for r in resultados}

    print(f"11. Contando bugs por Tarefa Origem Inconsistência (ano {ANO}, reaproveitando resolvidos)...")
    bug_counts_ano = build_bug_counts_ano(raw_fechados)  # usado no ranking "Tarefa com Mais Número de Bugs"

    qualidade_lista_ano = build_qualidade_ano(qual_issues_ano, bugs_externa_por_nome)

    # Tarefas feitas na semana — já buscada em paralelo no início (raw_desenvolvida).
    print(f"12. Calculando tarefas feitas na semana ({len(raw_desenvolvida)} issues c/ transição p/ '{STATUS_DESENVOLVIDA}')...")
    tarefas_semana = build_tarefas_semana(raw_desenvolvida)

    # Progresso de Epic — reaproveita Backlog (raw_aberto) + Resolvidos do ano
    # (raw_fechados), ambos já buscados com o campo 'parent'. Sem query de Epics.
    issues_com_parent = [extract_parent_info(i) for i in raw_aberto] + \
                        [extract_parent_info(i) for i in raw_fechados]
    print(f"13. Calculando progresso de Epics a partir de {len(issues_com_parent)} issues (Backlog + Resolvidos {ANO})...")
    epic_progress = build_epic_progress(issues_com_parent)

    # Merge com qualidade_data.json existente (preserva anos já calculados em
    # execuções anteriores do script — ex.: rodou 2025 antes, agora roda 2026).
    # Isso vale tanto para os índices de Qualidade quanto para a contagem de bugs
    # por Tarefa Origem — ambos vêm de raw_fechados (só o ano corrente), então
    # mesclamos ano a ano para não perder histórico entre execuções.
    qualidade_por_ano = {}
    bug_counts_por_ano = {}
    if (DATA_DIR / "qualidade_data.json").exists():
        try:
            with open(DATA_DIR / "qualidade_data.json", encoding="utf-8") as f:
                existing = json.load(f)
                qualidade_por_ano  = existing.get("por_ano", {})
                bug_counts_por_ano = existing.get("bug_counts_por_ano", {})
        except Exception as e:
            raise RuntimeError("Histórico de qualidade inválido; arquivo preservado") from e
    qualidade_por_ano[str(ANO_INT)]  = qualidade_lista_ano
    bug_counts_por_ano[str(ANO_INT)] = bug_counts_ano
    anos_qualidade = sorted(int(a) for a in qualidade_por_ano.keys())
    bug_ranking = merge_bug_ranking(bug_counts_por_ano)
    fixversions_origem = fetch_fixversions_for_keys([b["chave_origem"] for b in bug_ranking])
    for b in bug_ranking:
        info = fixversions_origem.get(b["chave_origem"], {})
        b["summary"]      = info.get("summary")
        b["status"]       = info.get("status")
        b["fix_versions"] = info.get("fix_versions", [])
        b["projeto"]      = info.get("projeto")
        b["squad"]        = info.get("squad")
        b["produto"]      = info.get("produto")

    qualidade_output = {
        "por_ano":            qualidade_por_ano,
        "anos_disponiveis":   anos_qualidade,
        "bug_counts_por_ano": bug_counts_por_ano,   # bruto, por ano — usado para o merge
        "bug_ranking":        bug_ranking,           # já mesclado/ordenado — usado pelo dashboard
        "tarefas_semana":     tarefas_semana,
        "epic_progress":      epic_progress,
        "gerado_em":          _agora().strftime("%d/%m/%Y %H:%M"),
    }
    with atomic_output("qualidade_data.json") as f:
        json.dump(qualidade_output, f, ensure_ascii=False, separators=(',',':'))
    print(f"   ✓ Qualidade {ANO}: {len(qualidade_lista_ano)} devs (anos no arquivo: {anos_qualidade}) | "
          f"Bug ranking: {len(bug_ranking)} (acumulado de {len(bug_counts_por_ano)} ano(s)) | "
          f"Semana: {len(tarefas_semana)} | Epics: {len(epic_progress)} → qualidade_data.json")

    t1 = time.time()
    print(f"\n✓ Concluído em {t1-t0:.1f}s")
    print(f"  Arquivo indicadores: {fname}")
    print(f"  Arquivo TDC:         tdc_data.json")
    print(f"  Arquivos Fluxo:      abertos_data.json | fechados_data.json")
    print(f"  Arquivo Qualidade:   qualidade_data.json")
    print(f"  {len(resultados)} profissionais | {len(tarefas_abertas)} tarefas em aberto | {len(bugs_tdc)} bugs TDC")
    print(f"  Gerado em: {output['gerado_em']}")
    print(f"\nTop 5 Indicadores:")
    for r in resultados[:5]:
        print(f"  {r['nome'][:30]:30} {r['cargo']:6} {r['pontos']:6.1f} pts")
    print(f"\nTDC — Bugs por Segmento (ano atual):")
    for s in stats_tdc["por_segmento"][:8]:
        var = f"{s['var_pct_atual_ant']:+.1f}%" if s['var_pct_atual_ant'] is not None else "—"
        print(f"  {s['segmento'][:25]:25} ant:{s['ant']:4}  atual:{s['atual']:4}  var:{var}")

if __name__ == "__main__":
    main()