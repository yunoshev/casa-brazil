"""Public build settings and a factual Portuguese data-use notice.

No secrets belong in these settings. They are embedded in published HTML.
Sender credentials and the task processing/email workers are not implemented.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from seo import validate_site_url

DEFAULT_API = "https://preco-real-analyze.preco-real.workers.dev"


def stylesheet_href() -> str:
    """Keep pending indicators in sync with the published controller."""
    path = Path(__file__).parent / "site" / "v2" / "style.css"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    return f"/v2/style.css?v={digest}"


def app_script_src() -> str:
    """Invalidate cached UI behavior whenever its published content changes."""
    path = Path(__file__).parent / "site" / "v2" / "app.js"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    return f"/v2/app.js?v={digest}"


def analysis_script_src() -> str:
    """Cache-bust the analysis controller with its published bytes."""
    path = Path(__file__).parent / "site" / "parts" / "analyze.js"
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    return f"/parts/analyze.js?v={digest}"


def settings(site: str, env=None) -> dict:
    env = os.environ if env is None else env
    site = validate_site_url(site)
    api = (env.get("ANALYSIS_API_BASE") or DEFAULT_API).strip().rstrip("/")
    u = urlsplit(api)
    if (
        u.scheme != "https"
        or not u.hostname
        or u.username
        or u.password
        or u.port is not None
        or u.path
        or u.query
        or u.fragment
    ):
        raise ValueError("ANALYSIS_API_BASE must be an HTTPS origin without credentials or path")
    operator = (env.get("PUBLIC_OPERATOR_NAME") or "").strip()
    contact = (env.get("PUBLIC_OPERATOR_CONTACT") or "").strip()
    if len(operator) > 160 or len(contact) > 240 or any(ord(c) < 32 for c in operator + contact):
        raise ValueError("Public operator/contact must be short printable text")
    ga4 = (env.get("GA4_ID") or "").strip()
    cf = (env.get("CF_BEACON") or "").strip()
    if ga4 and not re.fullmatch(r"G-[A-Z0-9]{4,32}", ga4):
        raise ValueError("GA4_ID must be a GA4 web stream measurement ID")
    if cf and not re.fullmatch(r"[a-fA-F0-9-]{20,64}", cf):
        raise ValueError("CF_BEACON must be a public Cloudflare Web Analytics token")
    maps_embed_key = env.get("MAPS_EMBED_API_KEY") or ""
    if maps_embed_key and not re.fullmatch(r"AIza[A-Za-z0-9_-]{35}", maps_embed_key):
        raise ValueError("MAPS_EMBED_API_KEY must be a Google API key")
    analytics = {k: v for k, v in (("ga4", ga4), ("cf", cf)) if v}
    if ga4:
        analytics["enhancedMeasurementDisabled"] = (
            env.get("GA4_ENHANCED_MEASUREMENT_DISABLED") == "true"
        )
    return {
        "site": site,
        "operator": operator,
        "contact": contact,
        "analysis": {
            "apiBase": api,
            "enabled": env.get("BRAZIL_PUBLIC_ANALYSIS_ENABLED") == "true",
            "reportsEnabled": env.get("LOT_REPORTS_ENABLED") == "true",
            "privacyUrl": site + "/privacidade/",
            "privacyContact": (operator + " · " + contact) if operator and contact else "",
        },
        "analytics": analytics,
        "maps": {"embedKey": maps_embed_key} if maps_embed_key else {},
    }


def blob(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def snippet(site: str, env=None) -> str:
    cfg = settings(site, env)
    # Always define the analysis settings, even when Google is disabled.
    return (
        "<script>window.__ANALYSIS__="
        + blob(cfg["analysis"])
        + ";window.__ANALYTICS__="
        + blob(cfg["analytics"])
        + ";window.__MAPS__="
        + blob(cfg["maps"])
        + ";</script>\n"
        + ('<script src="/parts/analytics.js" defer></script>\n' if cfg["analytics"] else "")
    )


def privacy_page(site: str, env=None) -> str:
    cfg = settings(site, env)
    e = html.escape
    base = urlsplit(cfg["site"]).path
    configured = bool(cfg["operator"] and cfg["contact"])
    contact = (
        f"<p><strong>Responsável:</strong> {e(cfg['operator'])}.<br>"
        f"<strong>Contato para dúvidas ou exclusão:</strong> {e(cfg['contact'])}.</p>"
        if configured
        else "<p>Esta versão não coleta nomes ou emails e não oferece lista de espera por email.</p>"
    )
    robots = '<meta name="robots" content="noindex">' if not configured else ""
    return f'''<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacidade e pedidos de análise — Preço Real</title>
<meta name="description" content="Como tratamos documentos históricos, relatórios e estatísticas de navegação.">
<link rel="canonical" href="{e(cfg["site"])}/privacidade/">{robots}
<link rel="stylesheet" href="{e(base)}/v2/style.css"></head><body>
<header class="top"><div class="wrap"><a class="brand" href="{e(base)}/">Preço <em>Real</em></a></div></header>
<main class="wrap"><h1>Privacidade e pedidos de análise</h1>
{contact}
<h2>Documentos e relatórios históricos</h2>
<p>O processamento automático de documentos públicos usa trechos selecionados,
com dados pessoais removidos, para análise pelo Google Gemini. Não envie
documentos privados ou links com informações pessoais. Consultar um relatório
já armazenado não inicia uma nova análise nem uma nova busca do PDF.</p>
<p>Os PDFs do arquivo, os relatórios e os registros operacionais ficam no backend
Casa Radar. O Cloudflare atua como transporte entre o site e esse backend, não
como armazenamento dos relatórios ou serviço de análise por modelo.</p>
<p>O relatório identifica seu escopo histórico, a data do documento, a captura
do PDF e a análise original quando disponíveis. Essas datas não são uma nova
verificação da fonte. Um documento histórico não confirma disponibilidade,
ocupação, dívidas, preço, estado atual ou resultado de venda. Regras gerais não
são uma análise específica do imóvel. O resultado não substitui diligência jurídica.</p>
<h2>Quando não há relatório disponível</h2>
<p>Ausência de relatório não significa ausência de riscos. Esta versão não
coleta nomes ou emails, não oferece lista de espera por email e não promete
análise ou envio posterior automático.</p>
<h2>Limites e armazenamento no navegador</h2>
<p>Pedidos de análise, quando habilitados, usam um identificador aleatório do
navegador e chaves de repetição; eles não comprovam a identidade de uma pessoa.
A consulta de um relatório histórico não cria esses identificadores nem guarda
o relatório no armazenamento local. Preferências de idioma, cidade, tema e
estatísticas podem ser guardadas no navegador. O backend aplica controles de
requisição e registros de custo para limitar abuso.</p>
<h2>Estatísticas</h2>
<p>Quando Google Analytics estiver configurado, só o carregamos depois que você
aceitar estatísticas. Recusar não impede ler páginas ou relatórios. Não enviamos
nomes, email, texto do documento, identificadores dos imóveis ou links digitados
nos eventos de Analytics. A medição adicional Cloudflare não é ativada nesta versão.</p>
<p>O evento de exibição de relatório só ocorre após sua renderização e com
consentimento para estatísticas; não representa uma nova análise. As chaves de
acesso e os documentos privados de trabalho não fazem parte do site público
ou do repositório GitHub.</p>
<p><a href="{e(base)}/">Voltar ao catálogo</a></p></main></body></html>'''
