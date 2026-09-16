"""Public, non-secret consent settings and the current site's privacy notice."""
from __future__ import annotations

import html
import hashlib
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit


def validate_site_url(site: str) -> str:
    u = urlsplit(site)
    if (u.scheme != "https" or not u.hostname or u.username or u.password
            or u.port is not None or u.query or u.fragment
            or not re.fullmatch(r"[A-Za-z0-9.-]+", u.hostname)
            or not re.fullmatch(r"(?:/[A-Za-z0-9_-]+)*/?", u.path)):
        raise ValueError("SITE_URL must be an HTTPS origin with an optional simple base path")
    return site.rstrip("/")


def settings(env=None) -> dict:
    env = os.environ if env is None else env
    ga4 = (env.get("GA4_ID") or "").strip()
    if ga4 and not re.fullmatch(r"G-[A-Z0-9]{4,32}", ga4):
        raise ValueError("GA4_ID must be a GA4 measurement ID")
    return {
        "ga4": ga4,
        # Assertion supplied by the release owner after configuring the stream.
        "enhancedMeasurementDisabled": env.get("GA4_ENHANCED_MEASUREMENT_DISABLED") == "true",
    }


def snippet(env=None) -> str:
    env = os.environ if env is None else env
    # Separate public build switch: never infer readiness from server or GA flags.
    # The browser uses a fixed Worker URL and never receives core configuration.
    analysis = json.dumps(
        {
            "enabled": env.get("BRAZIL_PUBLIC_ANALYSIS_ENABLED") == "true",
            # A cached historical report is a separate, read-only feature.
            # It remains off until both its Worker and report-quality gate are ready.
            "reportsEnabled": env.get("LOT_REPORTS_ENABLED") == "true",
        },
        separators=(",", ":"),
    )
    bootstrap = '<script>window.__ANALYSIS__=' + analysis + ';</script>\n'
    cfg = settings(env)
    if not cfg["ga4"]:
        return bootstrap
    encoded = json.dumps(cfg, separators=(",", ":")).replace("<", "\\u003c")
    script = Path(__file__).parent / "site/parts/analytics.js"
    version = hashlib.sha256(script.read_bytes()).hexdigest()[:12]
    return (bootstrap + '<script>window.__ANALYTICS__=' + encoded + ';</script>\n'
            f'<script src="/parts/analytics.js?v={version}" defer></script>\n')


def privacy_page(site: str, env=None) -> str:
    site = validate_site_url(site)
    e = html.escape
    # Root URLs are versioned and rebased by prerender, just like other pages.
    return f'''<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacidade — Preço Real</title>
<link rel="canonical" href="{e(site)}/privacidade/">
<meta name="robots" content="noindex">
<link rel="stylesheet" href="/v2/style.css"></head><body>
<main class="wrap"><h1>Privacidade</h1>
<h2>Estatísticas opcionais</h2>
<p>Quando configurado, o Google Analytics só é carregado após aceitar estatísticas.
Recusar não impede usar o catálogo ou pedir análise. Após aceitar, o Google pode
usar cookies de análise. A escolha fica no navegador; o botão de preferências
permite alterá-la. Não enviamos email, links digitados de PDF, endereço do imóvel,
identificadores de lote ou texto do documento nos eventos de Analytics.
A medição Cloudflare não é ativada nesta versão.</p>
<h2>Análise de edital</h2>
<p>Ao enviar o formulário, o identificador do lote e o link público do PDF da Caixa
são enviados ao serviço de análise. O servidor busca o documento e usa Google Gemini
para a leitura automática; pode reutilizar uma resposta em cache e aplicar limites.
Não envie documentos privados. A leitura automática não substitui orientação profissional.
Este site não oferece cadastro por email nem lista de espera nesta versão.</p>
<h2>Relatórios históricos armazenados</h2>
<p>Quando houver um relatório já armazenado, ele se refere apenas ao documento
histórico e aos trechos revisados desse documento. Os PDFs, relatórios e registros
operacionais ficam no backend Casa Radar. O Cloudflare atua como transporte e pode
usar cache técnico de curta duração; não mantém uma base própria de relatórios nem
executa o modelo de IA.</p>
<p>Consultar esse relatório não inicia nova análise nem busca de PDF. O relatório
não confirma disponibilidade, ocupação, dívidas, preço, condição atual ou resultado
do leilão. Esta versão não coleta nomes ou emails e não oferece lista de espera.</p>
<h2>Preferências e localização</h2>
<p>O navegador guarda idioma, cidade escolhida, tema e escolha de estatísticas.
A aproximação de cidade pela rede não pede GPS nem envia ou salva coordenadas.
Os serviços de infraestrutura podem processar endereços IP em registros operacionais.</p>
<p><a href="/">Voltar ao catálogo e às preferências de estatísticas</a></p>
</main></body></html>'''
