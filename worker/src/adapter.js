/** Thin authenticated transport only. Core owns jobs, quota, provider and results.
 * No model keys, PDF fetches, KV/DO storage, email collection or fallback backend.
 */
const ORIGINS = new Set(["https://precodemartelo.com", "https://www.precodemartelo.com"]);
const CORE_HOSTS = new Set(["188-245-254-157.nip.io", "188-245-254-157.sslip.io"]);
const IDENTIFIER = /^[A-Za-z0-9_.:-]{16,120}$/;
const LOT = /^[A-Za-z0-9_.:-]{1,120}$/;
const PATH = "/api/brazil-analysis";
const UPLOAD_PATH = "/analyze/lots/";
const UPLOAD_CONSENT = "brazil-matricula-paid-ai-v1";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Versioned server-owned contract. The browser mirrors this exact value and
// rejects any semantically similar replacement.
const MATRICULA_WARNING =
  "Análise automatizada da matrícula, sujeita a erros e omissões. Não constitui " +
  "certidão atualizada, parecer jurídico ou garantia sobre titularidade, ônus, " +
  "cancelamentos ou disponibilidade do imóvel. Confira o documento integral e " +
  "consulte o cartório e um profissional independente antes de decidir.";
const REPORT_PATH = "/api/brazil-lot-reports/";
const REPORT_ID = /^[a-f0-9]{16}$/;
const TICKET = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[0-9]{10,11}\.[a-f0-9]{64}$/;
const encoder = new TextEncoder();

class PublicError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new PublicError(status, code); };

function json(status, body, origin, extra = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Vary": "Origin", "X-Content-Type-Options": "nosniff", ...extra,
  };
  if (ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Expose-Headers"] = "X-Cache, Retry-After";
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

async function boundedBytes(message, maximum, timeout) {
  const length = message.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    fail(/^\d+$/.test(length) ? 413 : 400, /^\d+$/.test(length) ? "too_large" : "bad_request");
  }
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  let timer, size = 0;
  const chunks = [];
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new PublicError(503, "analysis_unavailable"));
    }, timeout);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { void reader.cancel().catch(() => {}); fail(413, "too_large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

async function bounded(message, maximum, timeout) {
  return new TextDecoder("utf-8", { fatal: true }).decode(await boundedBytes(message, maximum, timeout));
}

function config(env, report = false) {
  if ((report ? env.LOT_REPORTS_ENABLED : env.ANALYSIS_ENABLED) !== "true" || typeof env.BRAZIL_PROXY_SECRET !== "string" ||
      env.BRAZIL_PROXY_SECRET.length < 32) fail(503, "analysis_unavailable");
  let core;
  try { core = new URL(env.BRAZIL_API_ORIGIN); } catch { fail(503, "analysis_unavailable"); }
  if (core.protocol !== "https:" || !CORE_HOSTS.has(core.hostname) || core.port ||
      core.username || core.password || core.search || core.hash || core.pathname !== "/") {
    fail(503, "analysis_unavailable");
  }
  return core.origin;
}

function payload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || !LOT.test(value.id) ||
      typeof value.visitor_id !== "string" || !IDENTIFIER.test(value.visitor_id) ||
      typeof value.idempotency_key !== "string" || !IDENTIFIER.test(value.idempotency_key) ||
      !["pt", "en", "ru"].includes(value.lang || "pt")) fail(400, "bad_request");
  let url;
  try { url = new URL(value.url); } catch { fail(403, "bad_domain"); }
  if (url.protocol !== "https:" || !["www.caixa.gov.br", "venda-imoveis.caixa.gov.br"].includes(url.hostname) ||
      url.port || url.username || url.password || url.hash || !/\.pdf$/i.test(url.pathname) || url.href.length > 2048) {
    fail(403, "bad_domain");
  }
  // Discard extra client fields (subject/model/budget/email/auth are never trusted).
  return { id: value.id, url: url.href, visitor_id: value.visitor_id,
    idempotency_key: value.idempotency_key, lang: value.lang || "pt" };
}

function trustedIP(request) {
  // Cloudflare overwrites CF-Connecting-IP on public ingress. Never use XFF.
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split(".").every(n => Number(n) <= 255)) {
    return ip.split(".").map(Number).join(".");
  }
  if (ip.includes(":") && /^[a-fA-F0-9:.]+$/.test(ip)) {
    try { return new URL("http://[" + ip + "]/").hostname.slice(1, -1); } catch { /* reject */ }
  }
  fail(403, "bad_request");
}

function hex(bytes) { return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join(""); }
async function hmac(key, value) { return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value))); }

function text(value, maximum = 12000) {
  if (typeof value !== "string" || value.length > maximum) fail(502, "invalid_response");
  return value;
}
function list(value) {
  if (!Array.isArray(value) || value.length > 50) fail(502, "invalid_response");
  return value.map(v => text(v, 2000));
}

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function citation(value) {
  if (!exact(value, ["page", "quote"]) || !Number.isInteger(value.page) || value.page < 1 || value.page > 150) {
    fail(502, "invalid_response");
  }
  return { page: value.page, quote: reportText(value.quote, 360) };
}

function identity(value) {
  if (!exact(value, ["status", "catalog_value", "document_value", "citations"]) ||
      !["match", "contradiction", "omitted"].includes(value.status) || !Array.isArray(value.citations) ||
      value.citations.length > 3 || (value.catalog_value !== null && typeof value.catalog_value !== "string") ||
      (value.document_value !== null && typeof value.document_value !== "string")) fail(502, "invalid_response");
  const citations = value.citations.map(citation);
  if (value.status === "omitted" ? value.document_value !== null || citations.length !== 0 :
      !value.catalog_value?.trim?.() || !value.document_value?.trim?.() || citations.length === 0) fail(502, "invalid_response");
  return { status: value.status,
    catalog_value: value.catalog_value === null ? null : text(value.catalog_value, 500),
    document_value: value.document_value === null ? null : text(value.document_value, 500), citations };
}

function registryEntry(value) {
  if (!exact(value, ["kind", "number", "title", "summary", "effect", "citations"]) ||
      !["R", "AV"].includes(value.kind) || !Number.isInteger(value.number) || value.number < 1 || value.number > 999999 ||
      !["active", "cancelled", "unclear"].includes(value.effect) || !Array.isArray(value.citations) ||
      value.citations.length < 1 || value.citations.length > 4) fail(502, "invalid_response");
  return { kind: value.kind, number: value.number, title: reportText(value.title, 160),
    summary: reportText(value.summary, 1200), effect: value.effect, citations: value.citations.map(citation) };
}

function publicMatricula(body) {
  if (!exact(body, ["contract", "document_type", "identity", "entries", "summary", "warnings", "confidence", "disclaimer", "_meta"]) ||
      body.contract !== "brazil_matricula_v1" || !["matricula", "not_matricula", "unclear"].includes(body.document_type) ||
      !exact(body.identity, ["matricula", "address"]) || !Array.isArray(body.entries) || body.entries.length > 80 ||
      !Array.isArray(body.warnings) || body.warnings.length < 1 || body.warnings.length > 20 ||
      !["high", "medium", "low"].includes(body.confidence) ||
      body.disclaimer !== MATRICULA_WARNING) fail(502, "invalid_response");
  const identities = { matricula: identity(body.identity.matricula), address: identity(body.identity.address) };
  // A provider-produced contradiction or non-registry document is a terminal
  // mismatch, never a successful public result even if core regresses.
  if (body.document_type !== "matricula" || Object.values(identities).some(item => item.status === "contradiction") ||
      !Object.values(identities).some(item => item.status === "match")) fail(422, "document_mismatch");
  if (!exact(body._meta, ["cached", "analyzed_at"]) ||
      typeof body._meta.cached !== "boolean") fail(502, "invalid_response");
  const analyzed = reportTime(body._meta.analyzed_at);
  return { contract: "brazil_matricula_v1", document_type: "matricula", identity: identities,
    entries: body.entries.map(registryEntry), summary: reportText(body.summary, 3000),
    warnings: body.warnings.map(value => reportText(value, 1200)), confidence: body.confidence,
    disclaimer: MATRICULA_WARNING, _meta: { cached: body._meta.cached, analyzed_at: analyzed } };
}

function reportTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) fail(502, "invalid_response");
  return value;
}

function reportText(value, maximum = 900) {
  const safe = text(value, maximum);
  // Defence in depth, not a substitute for core's reviewed public projection.
  if (!safe.trim() || /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(safe)) fail(502, "invalid_response");
  return safe;
}

function reportDate(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    fail(502, "invalid_response");
  }
  return value;
}

function reportEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isInteger(value.page) || value.page < 1 || value.page > 150 ||
      !["America/Sao_Paulo", "unknown"].includes(value.timezone) ||
      (value.time !== null && (typeof value.time !== "string" || !/^[0-2]\d:[0-5]\d$/.test(value.time)))) {
    fail(502, "invalid_response");
  }
  return { date: reportDate(value.date), page: value.page, time: value.time, timezone: value.timezone };
}

function reportFinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !["occupancy", "commission", "charges", "servitude", "auction_date"].includes(value.kind) ||
      !Number.isInteger(value.page) || value.page < 1 || value.page > 150) fail(502, "invalid_response");
  return { kind: value.kind, statement: reportText(value.statement, 360), page: value.page, quote: reportText(value.quote, 360) };
}

function publicReport(status, body, id) {
  if (status === 404 && body?.status === "not_available") return { status: "not_available" };
  if (status === 202) fail(502, "invalid_response");
  if (status !== 200) return publicResponse(status, body);
  const doc = body?.document, match = body?.match, report = body?.report;
  if (body?.status !== "historical_document" || body.source_scope !== "historical_document" || body.lot_id !== id ||
      !doc || !/^[a-f0-9]{64}$/.test(doc.sha256) || !/^[a-f0-9]{64}$/.test(doc.evidence_hash) ||
      !Number.isInteger(doc.page) || doc.page < 1 || doc.page > 10000 ||
      !match || match.address !== true || match.matricula !== true || match.auction_dates !== true ||
      !report ||
      report.language !== "pt" || !Array.isArray(report.findings) || report.findings.length < 1 || report.findings.length > 6 ||
      !Array.isArray(report.auction_events) || report.auction_events.length < 1 || report.auction_events.length > 3 ||
      !Array.isArray(body.limitations) || body.limitations.length < 1 || body.limitations.length > 1) fail(502, "invalid_response");
  const findings = report.findings.map(reportFinding);
  const auctionEvents = report.auction_events.map(reportEvent);
  const documentDate = reportDate(report.document_date);
  // Explicit DTO only: never pass PDF URLs, raw excerpts, owner fields or internal metadata.
  return {
    status: "historical_document", lot_id: id, source_scope: "historical_document",
    analyzed_at: reportTime(body.analyzed_at),
    document: { sha256: doc.sha256, captured_at: reportTime(doc.captured_at), page: doc.page, evidence_hash: doc.evidence_hash },
    match: { address: true, matricula: true, auction_dates: true },
    report: { language: "pt", summary: reportText(report.summary), findings: findings,
      auction_events: auctionEvents, document_date: documentDate },
    limitations: body.limitations.map(value => reportText(value, 900)),
  };
}

function publicResponse(status, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(502, "invalid_response");
  if (status === 200) {
    if (body.contract !== undefined) return publicMatricula(body);
    if (!["sim", "nao", "incerto"].includes(body.ocupado) ||
        !["lot_specific", "generic_rules"].includes(body.source_scope) ||
        !["alta", "media", "baixa"].includes(body.confianca) || !body.dividas ||
        !body.resumo?.trim?.() || !body.aviso?.trim?.()) fail(502, "invalid_response");
    const result = {
      source_scope: body.source_scope,
      ocupado: body.ocupado, confianca: body.confianca,
      dividas: { iptu: text(body.dividas.iptu), condominio: text(body.dividas.condominio), outras: list(body.dividas.outras || []) },
      fase: text(body.fase || ""), riscos: list(body.riscos || []),
      resumo: text(body.resumo), aviso: text(body.aviso),
    };
    if (body._meta && typeof body._meta === "object") {
      if (typeof body._meta.cached !== "boolean" || typeof body._meta.analyzed_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(body._meta.analyzed_at) ||
          isNaN(Date.parse(body._meta.analyzed_at))) fail(502, "invalid_response");
      // The public catalogue deliberately excludes internal job/model IDs.
      result._meta = { cached: body._meta.cached, analyzed_at: text(body._meta.analyzed_at, 120) };
    }
    return result;
  }
  if (status === 202) {
    if (body.status !== "pending" || typeof body.analysis_id !== "string" || !LOT.test(body.analysis_id) ||
        typeof body.job_ticket !== "string" || !TICKET.test(body.job_ticket)) fail(502, "invalid_response");
    const result = { status: "pending", analysis_id: body.analysis_id,
      retry_after_seconds: Math.max(1, Math.min(15, Number(body.retry_after_seconds) || 5)) };
    if (typeof body.job_ticket === "string") result.job_ticket = text(body.job_ticket, 4096);
    return result;
  }
  const codes = {
    400: ["bad_request"], 403: ["bad_domain"], 404: ["lot_not_found"], 409: ["idempotency_conflict"],
    413: ["too_large"], 422: ["invalid_pdf", "document_mismatch"],
    429: ["budget_exhausted", "free_limit_reached", "capacity_exhausted", "rate_limited",
      "daily_limit_reached", "monthly_limit_reached"],
    502: ["fetch_failed", "invalid_response", "upstream", "source_unavailable", "source_blocked"],
    503: ["analysis_unavailable", "source_unavailable", "source_blocked"],
  };
  if (!codes[status]?.includes(body.error)) fail(503, "analysis_unavailable");
  // No upstream message/debug/PII, and never enable a public email form.
  return { error: body.error, waitlist_available: false };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    try {
      if (!ORIGINS.has(origin)) fail(403, "bad_origin");
      const url = new URL(request.url);
      const reportID = url.pathname.startsWith(REPORT_PATH) ? url.pathname.slice(REPORT_PATH.length) : null;
      const pollCandidate = url.pathname.startsWith("/analyze/") ? url.pathname.slice(9) : null;
      const pollTicket = pollCandidate && TICKET.test(pollCandidate) ? pollCandidate : null;
      const upload = url.pathname.startsWith(UPLOAD_PATH) ? url.pathname.slice(UPLOAD_PATH.length) : null;
      if (url.search || (url.pathname !== "/analyze" &&
          !(pollTicket && TICKET.test(pollTicket)) && !(reportID && REPORT_ID.test(reportID)) &&
          !(upload && REPORT_ID.test(upload)))) fail(404, "not_found");
      const method = pollTicket || reportID ? "GET" : "POST";
      const path = reportID ? REPORT_PATH + reportID : upload ? PATH + "/lots/" + upload + "/matricula" :
        PATH + (pollTicket ? "/" + pollTicket : "");
      if (request.method === "OPTIONS") {
        const allowedHeaders = upload ? ["content-type", "x-visitor-id", "x-idempotency-key", "x-analysis-lang", "x-analysis-consent"] : ["content-type"];
        if (request.headers.get("Access-Control-Request-Method") !== method ||
            (request.headers.get("Access-Control-Request-Headers") || "").split(",").some(h => h.trim() && !allowedHeaders.includes(h.trim().toLowerCase()))) fail(403, "bad_request");
        return json(204, null, origin, { "Access-Control-Allow-Methods": method,
          "Access-Control-Allow-Headers": upload ? "Content-Type, X-Visitor-Id, X-Idempotency-Key, X-Analysis-Lang, X-Analysis-Consent" : "Content-Type" });
      }
      if (request.method !== method) fail(405, "method_not_allowed");
      const core = config(env, !!reportID);
      let body = "";
      let forwarded = { "Content-Type": "application/json", "Accept": "application/json" };
      if (method === "POST") {
        if (upload) {
          const visitor = request.headers.get("X-Visitor-Id") || "", requestKey = request.headers.get("X-Idempotency-Key") || "";
          const lang = request.headers.get("X-Analysis-Lang") || "pt";
          if (request.headers.get("Content-Type")?.trim().toLowerCase() !== "application/pdf") fail(422, "invalid_pdf");
          if (!IDENTIFIER.test(visitor) || !IDENTIFIER.test(requestKey) || !["pt", "en", "ru"].includes(lang) ||
              request.headers.get("X-Analysis-Consent") !== UPLOAD_CONSENT) fail(400, "bad_request");
          body = await boundedBytes(request, MAX_UPLOAD_BYTES, 15000);
          if (body.length < 5 || String.fromCharCode(...body.slice(0, 5)) !== "%PDF-") fail(422, "invalid_pdf");
          forwarded = { "Content-Type": "application/pdf", "Accept": "application/json", "X-Visitor-Id": visitor,
            "X-Idempotency-Key": requestKey, "X-Analysis-Lang": lang };
        } else {
          if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") fail(400, "bad_request");
          let input;
          try { input = JSON.parse(await bounded(request, 8192, 10000)); }
          catch (e) { if (e instanceof PublicError) throw e; fail(400, "bad_request"); }
          body = JSON.stringify(payload(input));
        }
      }
      const key = await crypto.subtle.importKey("raw", encoder.encode(env.BRAZIL_PROXY_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const subject = await hmac(key, "brazil-subject-v1\n" + trustedIP(request));
      const timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomUUID();
      const digestBytes = typeof body === "string" ? encoder.encode(body) : body;
      const digest = hex(await crypto.subtle.digest("SHA-256", digestBytes));
      const signature = await hmac(key, ["brazil-proxy-v1", method, path, timestamp, nonce, origin, subject, digest].join("\n"));
      const response = await fetch(core + path, { method, redirect: "manual", signal: AbortSignal.timeout(20000),
        headers: { ...forwarded,
          "X-Brazil-Origin": origin, "X-Brazil-Timestamp": timestamp, "X-Brazil-Nonce": nonce,
          "X-Brazil-Subject": subject, "X-Brazil-Signature": signature }, ...(method === "POST" ? { body } : {}) });
      if (response.status >= 300 && response.status < 400) fail(503, "analysis_unavailable");
      if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") fail(502, "invalid_response");
      const raw = JSON.parse(await bounded(response, reportID ? 32768 : 262144, 10000));
      const result = reportID ? publicReport(response.status, raw, reportID) : publicResponse(response.status, raw);
      const headers = {};
      if (reportID && response.status === 200) headers["Cache-Control"] = "public, max-age=300";
      if (["hit", "miss"].includes(response.headers.get("X-Cache"))) headers["X-Cache"] = response.headers.get("X-Cache");
      if (/^\d{1,5}$/.test(response.headers.get("Retry-After") || "")) headers["Retry-After"] = response.headers.get("Retry-After");
      return json(response.status, result, origin, headers);
    } catch (e) {
      return json(e instanceof PublicError ? e.status : 503, {
        error: e instanceof PublicError ? e.code : "analysis_unavailable",
      }, origin);
    }
  },
};
