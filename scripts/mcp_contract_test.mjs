#!/usr/bin/env node

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const DEFAULT_URL = "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const CONTRACT_PERIOD = makeContractPeriod();
const EXPECTED_TOOLS = [
  "list_metadata_objects",
  "get_metadata_structure",
  "search_metadata_fields",
  "count_event_subscriptions_by_event",
  "list_event_subscriptions",
  "run_1c_query",
  "validate_1c_query",
  "get_1c_query_guidance",
  "list_1c_language_doc_topics",
  "search_1c_language_docs",
  "read_1c_language_doc_section",
  "get_1c_language_doc_provenance",
  "list_registers",
  "get_accounting_accounts_map",
  "get_accounting_balances",
  "get_accounting_balances_by_subconto_age",
  "compare_accounting_balances_by_subconto",
  "get_accounting_entries",
  "get_inventory_balances_by_item",
  "get_calculation_types_map",
  "get_database_passport",
  "get_object_by_ref",
  "find_object_by_id",
  "search_objects",
  "get_link_of_object",
  "find_references_to_object",
  "get_enum_values",
  "get_register_records",
  "get_document_movements",
  "list_reports",
  "get_report_info",
  "run_1c_report",
  "get_object_history",
  "get_current_user_context",
  "get_query_examples",
  "list_legal_sources",
  "get_legal_source_guide",
];

function parseArgs(argv) {
  const options = {
    url: process.env.MCP_URL || DEFAULT_URL,
    basic: process.env.MCP_BASIC || "",
    timeoutMs: Number(process.env.MCP_TIMEOUT_MS || 60000),
    out: process.env.MCP_CONTRACT_OUT || "",
    responseMode: process.env.MCP_RESPONSE_MODE || "",
    modes: [],
    failFast: false,
    verbose: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") options.url = argv[++i];
    else if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg === "--basic") options.basic = argv[++i];
    else if (arg.startsWith("--basic=")) options.basic = arg.slice("--basic=".length);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--out") options.out = argv[++i];
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
    else if (arg === "--response-mode") options.responseMode = argv[++i];
    else if (arg.startsWith("--response-mode=")) options.responseMode = arg.slice("--response-mode=".length);
    else if (arg === "--modes") options.modes = parseModes(argv[++i]);
    else if (arg.startsWith("--modes=")) options.modes = parseModes(arg.slice("--modes=".length));
    else if (arg === "--all-response-modes") options.modes = ["text_only", "structured_only", "both"];
    else if (arg === "--fail-fast") options.failFast = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.url) throw new Error("MCP URL is required. Use --url or MCP_URL.");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  if (options.responseMode) options.responseMode = normalizeMode(options.responseMode);
  if (options.modes.length === 0 && process.env.MCP_RESPONSE_MODES) {
    options.modes = parseModes(process.env.MCP_RESPONSE_MODES);
  }
  options.modes = options.modes.map(normalizeMode);
  return options;
}

function parseModes(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (!["text_only", "structured_only", "both"].includes(normalized)) {
    throw new Error(`Unsupported response mode: ${mode}`);
  }
  return normalized;
}

function printHelp() {
  console.log(`Usage:
  node scripts/mcp_contract_test.mjs [--url URL] [--basic user:pass] [--out report.json] [--response-mode MODE] [--all-response-modes] [--verbose]

Environment:
  MCP_URL          JSON-RPC endpoint. Defaults to ${DEFAULT_URL}
  MCP_BASIC        Optional Basic auth value in user:pass form.
  MCP_TIMEOUT_MS   Per-request timeout, default 60000.
  MCP_CONTRACT_OUT Optional JSON report path.
  MCP_RESPONSE_MODE Optional tool result mode: text_only, structured_only, both.
  MCP_RESPONSE_MODES Optional comma-separated modes for repeated runs.
  MCP_TRANSPORT_RETRY_DELAY_MS Пауза перед единственным повтором транспортного отказа, по умолчанию 800.

Коды возврата: 0 — провалов нет; 1 — есть ассертные провалы (дефект контракта);
3 — провалы только транспортные, прогон недостоверен и подлежит повтору.
`);
}

class McpHttpClient {
  constructor(options) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs;
    this.verbose = options.verbose;
    this.responseMode = options.responseMode || "";
    this.nextId = 1;
    // Учёт транспортных повторов: счётчик и список восстановленных вызовов уходят в
    // отчёт, чтобы восстановленный прогон нельзя было спутать с чистым.
    this.transportRetries = 0;
    this.recovered = [];
    this.lastRetry = null;
    this.retryDelayMs = Number(process.env.MCP_TRANSPORT_RETRY_DELAY_MS || 800);
    this.headers = {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2025-06-18",
    };
    if (options.basic) {
      this.headers.authorization = `Basic ${Buffer.from(options.basic, "utf8").toString("base64")}`;
    }
  }

  // Транспортный отказ — соединение не состоялось или оборвалось, а НЕ отказ сервера.
  // Различие принципиально: повторять можно только транспорт. HTTP-статус, JSON-RPC
  // error и упавший ассерт повторять нельзя — иначе реальная регрессия будет
  // замаскирована повтором.
  //
  // Проверяется не только сообщение верхнего уровня (`fetch failed`), но и цепочка
  // cause: undici кладёт настоящую причину туда, и по одному тексту класс отказа не
  // определить.
  //
  // Замеренный на практике случай — `UND_ERR_CONNECT_TIMEOUT` примерно на 10,7 с. Это
  // СОБСТВЕННЫЙ connectTimeout undici (10 000 мс по умолчанию), а не порог сервера:
  // отказ наступает до обмена данными, поэтому задевает даже `initialize`, а
  // --timeout-ms на него не влияет — тот таймер ограничивает запрос целиком, а не
  // установку соединения. Тот же признак воспроизводился одновременно на трёх
  // несвязанных хостах, то есть источник — клиентская сеть, а не контур. Вывод для
  // приёмки: такие провалы нельзя записывать ни в дефекты сервера, ни в регресс.
  static isTransportFailure(error) {
    if (!error) return false;
    if (error.rpcError) return false;          // сервер ответил — это не транспорт
    if (error.httpStatus !== undefined) return false;
    const codes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND",
      "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED"]);
    for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
      if (current.code && codes.has(String(current.code))) return true;
      const message = String(current.message || "");
      if (/fetch failed|socket hang up|terminated|other side closed|network socket/i.test(message)) return true;
    }
    return false;
  }

  // Повторяем только чтение. Сервер read-only, но перечень задан явно: если появится
  // изменяющий метод, он не должен попасть под повтор автоматически.
  static isRetryableMethod(method) {
    return ["initialize", "tools/list", "tools/call", "resources/list", "resources/read", "prompts/list"].includes(method);
  }

  async rpc(method, params = {}) {
    if (!McpHttpClient.isRetryableMethod(method)) return this.rpcOnce(method, params);
    try {
      return await this.rpcOnce(method, params);
    } catch (error) {
      if (!McpHttpClient.isTransportFailure(error)) throw error;
      // Один повтор, короткая пауза: цель — отличить перемежающийся обрыв от отказа,
      // а не «дожать» контур. Признак повтора уходит в отчёт, поэтому восстановленный
      // прогон не выглядит обычным PASS.
      this.transportRetries += 1;
      const first = `${error.message}${error.cause?.code ? " cause=" + error.cause.code : ""}`;
      await new Promise((done) => setTimeout(done, this.retryDelayMs));
      try {
        const outcome = await this.rpcOnce(method, params);
        this.recovered.push({ method, first_transport_error: first });
        this.lastRetry = { transport_retry: true, attempts: 2, first_transport_error: first };
        return outcome;
      } catch (again) {
        if (McpHttpClient.isTransportFailure(again)) {
          again.transportFailure = true;
          again.attempts = 2;
          again.firstTransportError = first;
        }
        throw again;
      }
    }
  }

  async rpcOnce(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    if (this.responseMode && (method === "tools/list" || method === "tools/call")) {
      params = { ...params, _response_mode: this.responseMode };
    }
    const body = { jsonrpc: "2.0", id, method, params };
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const elapsedMs = Date.now() - started;
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (error) {
          throw new Error(`HTTP ${response.status}, non-JSON response: ${text.slice(0, 500)}`);
        }
      }
      if (!response.ok) {
        // httpStatus проставляется явно: классификатор отказов по нему отличает ответ
        // сервера от обрыва соединения, не полагаясь на текст сообщения. Тело ответа
        // может содержать любые слова, включая те, по которым узнаётся транспорт.
        const error = new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
        error.httpStatus = response.status;
        throw error;
      }
      if (this.verbose) {
        console.log(`[rpc] ${method} #${id} ${elapsedMs}ms`);
      }
      if (json?.error) {
        const error = new Error(`JSON-RPC error ${json.error.code}: ${json.error.message}`);
        error.rpcError = json.error;
        error.elapsedMs = elapsedMs;
        throw error;
      }
      return { result: json?.result, elapsedMs, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }

  async callTool(name, args = {}) {
    const { result, elapsedMs } = await this.rpc("tools/call", { name, arguments: args });
    return { result, elapsedMs };
  }

  // Низкоуровневый HTTP-запрос произвольным методом с опциональным телом и
  // доп.заголовками. В отличие от rpc() не бросает на json.error и возвращает
  // status/headers/text/json — для транспортных проверок (202/405/версия и т.п.).
  async rawRequest(httpMethod, bodyText = null, extraHeaders = {}) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const opts = {
        method: httpMethod,
        headers: { ...this.headers, ...extraHeaders },
        signal: controller.signal,
      };
      if (bodyText !== null) opts.body = bodyText;
      const response = await fetch(this.url, opts);
      const text = await response.text();
      let json = null;
      if (text) {
        try { json = JSON.parse(text); } catch (_) { json = null; }
      }
      const headers = {};
      response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      return { status: response.status, headers, text, json, elapsedMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  // Низкоуровневый POST сырого тела (в т.ч. заведомо битого JSON): в отличие от rpc()
  // не бросает на json.error, чтобы тест мог проверить содержимое error/error.data.
  async rawPost(bodyText) {
    return this.rawRequest("POST", bodyText);
  }
}

class ContractRunner {
  constructor(client, options) {
    this.client = client;
    this.options = options;
    this.tests = [];
    this.context = {};
    this.startedAt = null;
  }

  async test(name, fn, meta = {}) {
    const started = Date.now();
    this.client.lastRetry = null;
    try {
      const details = await fn();
      const row = {
        name,
        status: "PASS",
        elapsedMs: Date.now() - started,
        details: details || {},
        ...meta,
      };
      // Восстановленный транспортным повтором кейс помечается: без этого он выглядит
      // как обычный PASS, и нестабильность контура исчезает из отчёта.
      if (this.client.lastRetry) Object.assign(row, this.client.lastRetry);
      this.tests.push(row);
      printRow(row);
      return row;
    } catch (error) {
      const row = {
        name,
        status: "FAIL",
        elapsedMs: Date.now() - started,
        error: formatError(error),
        failure_class: classifyFailure(error),
        ...meta,
      };
      if (error?.transportFailure) {
        row.attempts = error.attempts;
        row.first_transport_error = error.firstTransportError;
      }
      this.tests.push(row);
      printRow(row);
      if (this.options.failFast) throw error;
      return row;
    }
  }

  async run() {
    this.startedAt = new Date().toISOString();
    console.log(`MCP contract test target: ${this.client.url}`);
    if (this.options.responseMode) console.log(`Response mode: ${this.options.responseMode}`);
    console.log(`Started: ${this.startedAt}`);

    await this.protocolTests();
    await this.fixtureDiscovery();
    await this.discoveryTests();
    await this.queryAndSchemaTests();
    await this.referenceTests();
    await this.registerTests();
    await this.documentTests();
    await this.reportTests();
    await this.negativeTests();
    await this.crossChecks();
    await this.queryExamplesTests();

    return this.summary();
  }

  async fixtureDiscovery() {
    await this.test("fixtures.discover_generic_metadata", async () => {
      this.context.genericCatalog = await findFirstMetadataObject(this.client, ["Справочник"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: false,
        });
        return structure.ok === true && structure.metadata?.supports_ref === true;
      });
      this.context.genericDocument = await findFirstMetadataObject(this.client, ["Документ"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: false,
        });
        return structure.ok === true && structure.metadata?.supports_ref === true;
      });
      this.context.catalogWithTabular = await findFirstMetadataObject(this.client, ["Справочник", "Документ"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: true,
        });
        const sections = structure.metadata?.tabular_sections || [];
        if (structure.ok === true && sections.length > 0) {
          item.structure = structure.metadata;
          item.tabularSection = sections[0];
          return true;
        }
        return false;
      });
      this.context.infoRegister = await findFirstMetadataObject(this.client, ["РегистрСведений"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: false,
        });
        const schema = structure.metadata?.register_schema;
        if (structure.ok === true && schema && ((schema.dimensions || []).length > 0 || (schema.resources || []).length > 0)) {
          item.structure = structure.metadata;
          return true;
        }
        return false;
      });
      this.context.enumType = await findFirstMetadataObject(this.client, ["Перечисление"], async () => true);
      assert(this.context.genericCatalog || this.context.infoRegister, "no generic metadata fixture found");
      return {
        catalog: this.context.genericCatalog?.full_name,
        document: this.context.genericDocument?.full_name,
        catalogWithTabular: this.context.catalogWithTabular?.full_name,
        infoRegister: this.context.infoRegister?.full_name,
        enumType: this.context.enumType?.full_name,
      };
    });
  }

  async protocolTests() {
    await this.test("protocol.initialize", async () => {
      const { result } = await this.client.rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-contract-test", version: "1.0.0" },
      });
      assert(result?.serverInfo?.name, "initialize must return serverInfo.name");
      assert(String(result?.instructions || "").includes("ОБЯЗАТЕЛЬНАЯ ПОЛИТИКА"),
        "initialize.instructions must mark legal-source policy as mandatory");
      assert(String(result?.instructions || "").includes("list_legal_sources")
        && String(result?.instructions || "").includes("get_legal_source_guide"),
        "initialize.instructions must declare the mandatory legal-source workflow");
      assert(String(result?.instructions || "").includes("fallback"),
        "initialize.instructions must forbid web-search fallback");
      return { server: result.serverInfo, instructionsLength: result.instructions.length };
    });

    await this.test("protocol.tools_list_has_expected_tools", async () => {
      const { result } = await this.client.rpc("tools/list", {});
      const tools = result?.tools || [];
      const names = tools.map((tool) => tool.name).sort();
      const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
      const extra = names.filter((name) => !EXPECTED_TOOLS.includes(name));
      assert(missing.length === 0, `missing tools: ${missing.join(", ")}`);
      assert(names.length === EXPECTED_TOOLS.length, `expected ${EXPECTED_TOOLS.length}, got ${names.length}; extra=${extra.join(", ")}`);
      assert((result?.server_hints || []).some((hint) => String(hint).includes("access_denied")), "tools/list must warn about per-user access_denied retry policy");
      assert((result?.server_hints || []).some((hint) =>
        String(hint).includes("ОБЯЗАТЕЛЬНАЯ ПОЛИТИКА") && String(hint).includes("fallback")),
        "tools/list must repeat mandatory no-web-fallback legal policy");
      assertToolsListMode(tools, this.options.responseMode);
      this.context.toolNames = names;
      return { count: names.length };
    });

    await this.test("protocol.resources_list_and_read", async () => {
      const list = await this.client.rpc("resources/list", {});
      const resources = list.result?.resources || [];
      assert(resources.some((item) => item.uri === "1c://metadata"), "metadata resource is missing");
      assert(resources.some((item) => item.uri === "1c://context/current-user"), "current-user resource is missing");
      assert(resources.some((item) => item.uri === "1c://knowledge/query"), "query knowledge resource is missing");
      assert(resources.some((item) => item.uri === "1c://knowledge/query/subkonto"), "subkonto knowledge resource is missing");
      assert(resources.some((item) => item.uri === "1c-docs://8.3.27/query-language/index"), "1C language docs index resource is missing");
      assert(resources.some((item) => item.uri === "1c-docs://8.3.27/query-language/provenance"), "1C language docs provenance resource is missing");
      const read = await this.client.rpc("resources/read", { uri: "1c://context/current-user" });
      const text = read.result?.contents?.[0]?.text || "";
      assert(text.includes("user"), "current-user resource must contain user data");
      const knowledge = await this.client.rpc("resources/read", { uri: "1c://knowledge/query/temporary-tables" });
      const knowledgeText = knowledge.result?.contents?.[0]?.text || "";
      assert(knowledgeText.includes("ПОМЕСТИТЬ"), "temporary-table knowledge must mention ПОМЕСТИТЬ");
      assert(knowledgeText.includes("read-only"), "temporary-table knowledge must explain read-only boundary");
      const docsIndex = await this.client.rpc("resources/read", { uri: "1c-docs://8.3.27/query-language/index" });
      const docsText = docsIndex.result?.contents?.[0]?.text || "";
      assert(docsText.includes("Документация по языку запросов 1С 8.3.27"), "docs index must mention 8.3.27");
      assert(docsText.includes("query-syntax"), "docs index must list query-syntax");
      return { resources: resources.map((item) => item.uri) };
    });

    await this.test("transport.notification_returns_202_empty", async () => {
      const resp = await this.client.rawRequest("POST",
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      assert(resp.status === 202, `expected HTTP 202, got ${resp.status}`);
      assert(!resp.text, `notification must have empty body, got: ${String(resp.text).slice(0, 100)}`);
      return { status: resp.status };
    });

    await this.test("transport.get_returns_405_with_allow", async () => {
      const resp = await this.client.rawRequest("GET");
      assert(resp.status === 405, `expected HTTP 405, got ${resp.status}`);
      assert((resp.headers["allow"] || "").length > 0, "405 response must include Allow header");
      return { status: resp.status, allow: resp.headers["allow"] };
    });

    await this.test("transport.delete_returns_405", async () => {
      const resp = await this.client.rawRequest("DELETE");
      assert(resp.status === 405, `expected HTTP 405, got ${resp.status}`);
      return { status: resp.status };
    });

    await this.test("transport.ping_returns_empty_result", async () => {
      const { result } = await this.client.rpc("ping", {});
      assert(result && typeof result === "object" && !Array.isArray(result) && Object.keys(result).length === 0,
        `ping must return empty object result, got ${JSON.stringify(result)}`);
      return { result };
    });

    await this.test("transport.prompts_list_is_method_not_found", async () => {
      const resp = await this.client.rawPost(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "prompts/list", params: {} }));
      assert(resp.json?.error?.code === -32601, `expected -32601, got ${resp.json?.error?.code}`);
      return { code: resp.json?.error?.code };
    });

    await this.test("transport.unsupported_version_header_returns_400", async () => {
      const resp = await this.client.rawRequest("POST",
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
        { "mcp-protocol-version": "1999-01-01" });
      assert(resp.status === 400, `expected HTTP 400, got ${resp.status}`);
      // Тело проверяется отдельно от статуса: пока ветка отказа падала на сериализации,
      // ассерт на статусе срабатывал первым и первопричину (платформенное исключение
      // вместо JSON-RPC) не было видно три прогона подряд.
      assert(resp.json !== null, `body must be JSON, got: ${String(resp.text).slice(0, 200)}`);
      assert(resp.json?.error?.code === -32000, `expected -32000, got ${resp.json?.error?.code}`);
      assert("id" in resp.json && resp.json.id === null, `id must be present and null, got: ${JSON.stringify(resp.json?.id)}`);
      return { status: resp.status, code: resp.json?.error?.code, contentType: resp.headers["content-type"] };
    });

    // Тот же путь формирования ответа, что у отказа по версии протокола
    // (СформироватьОшибкуJSONRPC), но ни одним кейсом он раньше не покрывался —
    // поэтому дефект сериализации был виден только в одном из четырёх проявлений.
    // Статус здесь намеренно НЕ проверяется: обработчик отдаёт 200 с JSON-RPC
    // ошибкой, а отказ по версии — 400; согласование этих статусов между собой —
    // отдельное решение, а не предмет этого кейса.
    await this.test("transport.empty_body_returns_parse_error", async () => {
      const resp = await this.client.rawRequest("POST", "");
      assert(resp.json !== null, `body must be JSON, got: ${String(resp.text).slice(0, 200)}`);
      assert(resp.json?.error?.code === -32700, `expected -32700, got ${resp.json?.error?.code}`);
      assert("id" in resp.json && resp.json.id === null, `id must be present and null, got: ${JSON.stringify(resp.json?.id)}`);
      assert(resp.json?.jsonrpc === "2.0", `jsonrpc must be 2.0, got: ${resp.json?.jsonrpc}`);
      return { status: resp.status, code: resp.json?.error?.code };
    });

    await this.test("transport.works_under_protocol_2025_11_25", async () => {
      const body = JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-contract-test", version: "1.0.0" } },
      });
      const resp = await this.client.rawRequest("POST", body, { "mcp-protocol-version": "2025-11-25" });
      assert(resp.status === 200, `expected HTTP 200, got ${resp.status}`);
      assert(resp.json?.result?.serverInfo?.name, "initialize under 2025-11-25 must return serverInfo.name");
      return { negotiated: resp.json?.result?.protocolVersion };
    });
  }

  async discoveryTests() {
    await this.test("tool.get_current_user_context", async () => {
      const result = await okTool(this.client, "get_current_user_context", {
        include_roles: true,
        include_limits: true,
        include_allowed_metadata_summary: true,
        include_server_info: true,
      });
      assert(result.allowed_metadata_summary?.objects_count > 100, "objects_count is suspiciously low");
      assert(Array.isArray(result.mcp_server?.tools), "mcp_server.tools must be present");
      return {
        user: result.user?.name,
        objects: result.allowed_metadata_summary.objects_count,
        tools: result.mcp_server.tools.length,
      };
    });

    await this.test("tool.list_metadata_objects_pagination", async () => {
      const first = await okTool(this.client, "list_metadata_objects", {
        kinds: ["Справочник"],
        limit: 1,
        include_details: true,
      });
      assert(first.objects?.length === 1, "first page must contain one object");
      assert(first.next_cursor, "first page must expose next_cursor");
      const second = await okTool(this.client, "list_metadata_objects", {
        kinds: ["Справочник"],
        limit: 1,
        cursor: first.next_cursor,
        include_details: true,
      });
      assert(second.objects?.length === 1, "second page must contain one object");
      assert(first.objects[0].full_name !== second.objects[0].full_name, "cursor did not advance");
      return { first: first.objects[0].full_name, second: second.objects[0].full_name };
    });

    await this.test("tool.search_metadata_fields_pagination", async () => {
      const result = await okTool(this.client, "search_metadata_fields", {
        query: "Дата",
        kinds: ["Документ"],
        limit: 2,
      });
      assert(Array.isArray(result.fields), "fields must be an array");
      assert("truncated" in result, "truncated flag must be present");
      if (result.truncated) assert(result.next_cursor, "truncated field search must expose next_cursor");
      return { fields: result.fields.map((item) => `${item.owner_type}.${item.path}`), truncated: result.truncated };
    });

    await this.test("tool.count_event_subscriptions_by_event", async () => {
      const result = await okTool(this.client, "count_event_subscriptions_by_event", {});
      assert(Array.isArray(result.events), "events must be an array");
      assert(typeof result.event_count === "number", "event_count must be numeric");
      assert(typeof result.subscription_count === "number", "subscription_count must be numeric");
      for (let index = 0; index < result.events.length; index += 1) {
        const row = result.events[index];
        assert(typeof row.event === "string" && row.event.length > 0, "event must be a non-empty string");
        assert(typeof row.count === "number" && row.count > 0, `count must be positive for ${row.event}`);
        if (index > 0) {
          const prev = result.events[index - 1];
          assert(prev.count >= row.count, "events must be sorted by count desc");
        }
      }
      const extended = await okTool(this.client, "count_event_subscriptions_by_event", {
        include_top_handlers: true,
        top_handlers_limit: 2,
      });
      assert(Array.isArray(extended.events), "extended events must be an array");
      for (const row of extended.events) {
        assert(Array.isArray(row.top_handlers), `top_handlers must be present for ${row.event}`);
        assert(row.top_handlers.length <= 2, `top_handlers_limit was not applied for ${row.event}`);
        for (const handler of row.top_handlers) {
          assert(typeof handler.module === "string" && handler.module.length > 0, "handler module must be a non-empty string");
          assert(typeof handler.count === "number" && handler.count > 0, "handler count must be positive");
        }
      }
      this.context.eventSubscriptionEvent = result.events[0]?.event || "";
      this.context.eventSubscriptionHandlerModule = extended.events[0]?.top_handlers?.[0]?.module || "";
      return { events: result.event_count, subscriptions: result.subscription_count };
    });

    await this.test("tool.list_event_subscriptions_filters", async () => {
      const event = this.context.eventSubscriptionEvent || "";
      const listArgs = event ? { event, limit: 5 } : { limit: 5 };
      const result = await okTool(this.client, "list_event_subscriptions", listArgs);
      assert(Array.isArray(result.subscriptions), "subscriptions must be an array");
      assert("truncated" in result, "truncated flag must be present");
      if (event) {
        for (const row of result.subscriptions) {
          assert(row.event === event, `subscription event must match filter: ${row.event} !== ${event}`);
        }
      }
      const handlerContains = this.context.eventSubscriptionHandlerModule || "";
      if (event && handlerContains) {
        const filtered = await okTool(this.client, "list_event_subscriptions", {
          event,
          handler_contains: handlerContains.toLowerCase(),
          limit: 5,
        });
        for (const row of filtered.subscriptions) {
          assert(row.event === event, "combined filter must preserve event");
          assert(String(row.handler || "").toLowerCase().includes(handlerContains.toLowerCase()),
            `handler_contains did not match ${row.handler}`);
        }
        return { event, handler_contains: handlerContains, filtered: filtered.subscriptions.length };
      }
      return { event, listed: result.subscriptions.length };
    });

    await this.test("tool.list_registers_pagination", async () => {
      const result = await okTool(this.client, "list_registers", {
        register_types: ["РегистрБухгалтерии", "РегистрНакопления", "РегистрСведений"],
        limit: 2,
      });
      assert(Array.isArray(result.registers), "registers must be an array");
      assert(result.registers.length > 0, "expected at least one register");
      assert("truncated" in result, "truncated flag must be present");
      if (result.truncated) assert(result.next_cursor, "truncated register list must expose next_cursor");
      return { registers: result.registers.map((item) => item.full_name), truncated: result.truncated };
    });

    await this.test("tool.list_metadata_objects_does_not_mask_technical_metadata", async () => {
      const result = await okTool(this.client, "list_metadata_objects", {
        kinds: ["Справочник", "РегистрБухгалтерии", "ПланСчетов", "ПланВидовРасчета"],
        limit: 50,
        include_details: true,
      });
      assert(result.objects?.length > 0, "expected metadata objects");
      for (const item of result.objects || []) {
        assert(!String(item.full_name || "").includes("скрыто"), `full_name must not be privacy-masked: ${item.full_name}`);
        assert(!String(item.kind || "").includes("скрыто"), `kind must not be privacy-masked: ${item.kind}`);
        assert(!String(item.resource_uri || "").includes("скрыто"), `resource_uri must not be privacy-masked: ${item.resource_uri}`);
        assert(typeof item.full_name === "string" && item.full_name.includes("."), `full_name must remain a metadata identifier: ${item.full_name}`);
      }
      return { checked: result.objects.length };
    });

    await this.test("tool.list_metadata_objects_does_not_invent_missing_register", async () => {
      const result = await okTool(this.client, "list_metadata_objects", {
        query: "MCP_НесуществующийРегистр",
        limit: 50,
        include_details: true,
        include_not_allowed: true,
      });
      const names = (result.objects || []).map((item) => item.full_name);
      assert(!names.includes("РегистрСведений.MCP_НесуществующийРегистр"), "non-existent register appeared in metadata");
      return { found: names.length };
    });

    await this.test("tool.discovery_returns_guidance_is_contextual", async () => {
      const sales = await okTool(this.client, "list_reports", {
        query: "продажи прибыль рентабельность по товарным позициям",
        include_variants: false,
        include_guidance: true,
        limit: 1,
      });
      assert(hasGuidance(sales, "returns_and_storno"), "sales/report discovery must include returns-and-storno guidance");
      assert(hasGuidance(sales, "report_or_direct_query_choice"), "sales/report discovery must include report-or-query guidance");

      const materials = await okTool(this.client, "list_reports", {
        query: "остатки и поступление сырья материалов тмц возвраты поставщику",
        include_variants: false,
        include_guidance: true,
        limit: 1,
      });
      assert(hasGuidance(materials, "returns_and_storno"), "materials/inventory discovery must include returns-and-storno guidance");

      const hr = await okTool(this.client, "list_reports", {
        query: "увольнение сотрудников кадровые документы",
        include_variants: false,
        include_guidance: true,
        limit: 1,
      });
      assert(!hasGuidance(hr, "returns_and_storno"), "HR discovery must not include returns-and-storno guidance");
      return {
        salesGuidance: sales.domain_guidance,
        materialsGuidance: materials.domain_guidance,
        hrGuidanceCount: hr.domain_guidance?.length || 0,
      };
    });
  }

  async queryAndSchemaTests() {
    await this.test("tool.get_metadata_structure_generic_reference_object", async () => {
      const fixture = this.context.catalogWithTabular || this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no reference metadata object" };
      const result = await okTool(this.client, "get_metadata_structure", {
        type: fixture.full_name,
        include_standard_attributes: true,
        include_tabular_sections: true,
      });
      const meta = result.metadata;
      assert(meta.supports_ref === true, "fixture must support references");
      const ts = meta.tabular_sections || [];
      if (fixture.tabularSection) {
        assert(ts.some((item) => item.name === fixture.tabularSection.name), "fixture tabular section is missing");
      }
      return { attributes: meta.attributes?.length, tabularSections: ts.map((item) => item.name).slice(0, 8) };
    });

    await this.test("tool.get_metadata_structure_information_register_schema", async () => {
      const fixture = this.context.infoRegister;
      if (!fixture) return { skipped: true, reason: "no information register fixture" };
      const result = await okTool(this.client, "get_metadata_structure", {
        type: fixture.full_name,
        include_standard_attributes: false,
        include_tabular_sections: false,
      });
      const schema = result.metadata?.register_schema;
      assert(result.metadata?.kind === "РегистрСведений", "register kind must be РегистрСведений");
      assert(schema, "register_schema must be present");
      return { periodicity: schema.periodicity, dimensions: schema.dimensions.length, resources: schema.resources.length };
    });

    await this.test("tool.get_metadata_structure_accounting_register_virtual_tables", async () => {
      const accountingRegister = await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      this.context.accountingRegister = accountingRegister;
      const result = await okTool(this.client, "get_metadata_structure", {
        type: accountingRegister.fullName,
        include_standard_attributes: true,
        include_tabular_sections: false,
        include_virtual_tables: true,
      });
      const schema = result.metadata?.register_schema;
      assert(result.metadata?.kind === "РегистрБухгалтерии", "register kind must be РегистрБухгалтерии");
      assert(schema, "register_schema must be present");
      const virtualTables = schema.virtual_tables || [];
      assert(virtualTables.some((item) => item.name === "Остатки"), "accounting register Остатки virtual table is missing");
      assert(virtualTables.some((item) => item.name === "Обороты"), "accounting register Обороты virtual table is missing");
      assert(virtualTables.some((item) => item.name === "ОборотыДтКт"), "accounting register ОборотыДтКт virtual table is missing");
      assert(virtualTables.some((item) => item.name === "ОстаткиИОбороты"), "accounting register ОстаткиИОбороты virtual table is missing");
      const balance = virtualTables.find((item) => item.name === "Остатки");
      assert((balance.common_fields || []).includes("Субконто1"), "Остатки must advertise Субконто1");
      assert((balance.common_fields || []).includes("КоличествоОстаток"), "Остатки must advertise КоличествоОстаток");
      assert((balance.common_fields || []).includes("СуммаОстаток"), "Остатки must advertise СуммаОстаток");
      assert(!(balance.common_fields || []).includes("ВидСубконто1"), "Остатки must not advertise non-universal ВидСубконто1 field");
      assert((balance.description || "").includes("УникальныйИдентификатор"), "Остатки description must mention UUID joins for Субконто");
      assert((balance.description || "").includes("ВидыСубконто"), "Остатки description must mention account chart ВидыСубконто lookup");
      const debitCredit = virtualTables.find((item) => item.name === "ОборотыДтКт");
      assert((debitCredit.common_fields || []).includes("СубконтоДт1"), "ОборотыДтКт must advertise СубконтоДт1");
      assert((debitCredit.common_fields || []).includes("СубконтоКт1"), "ОборотыДтКт must advertise СубконтоКт1");
      assert((debitCredit.common_fields || []).includes("СуммаПРОборотДт"), "ОборотыДтКт must advertise СуммаПРОборотДт");
      assert((debitCredit.common_fields || []).includes("СуммаПРОборотКт"), "ОборотыДтКт must advertise СуммаПРОборотКт");
      assert(!(debitCredit.common_fields || []).includes("ВидСубконтоДт1"), "ОборотыДтКт must not advertise non-universal ВидСубконтоДт1 field");
      return { register: accountingRegister.fullName, virtualTables };
    });

    await this.test("tool.get_metadata_structure_accumulation_resources_by_mode", async () => {
      const accumulationRegister = await findAccumulationRegister(this.client);
      if (!accumulationRegister) return { skipped: true, reason: "no accumulation register" };
      this.context.accumulationRegister = accumulationRegister;
      const result = await okTool(this.client, "get_metadata_structure", {
        type: accumulationRegister.fullName,
        include_standard_attributes: true,
        include_tabular_sections: false,
        include_virtual_tables: true,
      });
      const schema = result.metadata?.register_schema;
      assert(schema, "register_schema must be present");
      assert(schema.resources_by_mode && typeof schema.resources_by_mode === "object", "resources_by_mode must be present");
      assert(Array.isArray(schema.resources_by_mode.records), "resources_by_mode.records must be an array");
      assert(Array.isArray(schema.resources_by_mode.turnovers), "resources_by_mode.turnovers must be an array");
      return { register: accumulationRegister.fullName, resourcesByMode: schema.resources_by_mode };
    });

    await this.test("tool.validate_1c_query_existing_tabular_section", async () => {
      const fixture = this.context.catalogWithTabular;
      if (!fixture?.tabularSection?.name) return { skipped: true, reason: "no tabular section fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ ${fixture.full_name}.${fixture.tabularSection.name}`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `expected valid=true, errors=${JSON.stringify(result.errors)}`);
      assert((result.detected_objects || []).includes(fixture.full_name), "detected_objects should include parent object");
      return { detected: result.detected_objects };
    });

    await this.test("tool.validate_1c_query_guidance_is_opt_in", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const query = `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК Продажи ИЗ ${fixture.full_name}`;
      const compact = await okTool(this.client, "validate_1c_query", {
        query,
        strict: true,
      });
      assert(!Array.isArray(compact.query_guidance), "validate_1c_query must omit query_guidance by default");
      assert(!Array.isArray(compact.domain_guidance), "validate_1c_query must omit domain_guidance by default");

      const explained = await okTool(this.client, "validate_1c_query", {
        query,
        strict: true,
        include_guidance: true,
      });
      assert(hasGuidance(explained, "returns_and_storno"), "validate_1c_query must include domain_guidance when requested");
      return { compactGuidance: compact.domain_guidance, explainedGuidance: explained.domain_guidance?.length || 0 };
    });

    await this.test("tool.validate_1c_query_warns_document_tabular_register_fanout", async () => {
      const documentWithTabular = await findFirstMetadataObject(this.client, ["Документ"], async (item) => {
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: true,
          include_tabular_sections: true,
        });
        const sections = structure.metadata?.tabular_sections || [];
        if (structure.ok === true && sections.length > 0) {
          item.structure = structure.metadata;
          item.tabularSection = sections[0];
          return true;
        }
        return false;
      });
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!documentWithTabular?.tabularSection?.name || !accountingRegister) {
        return { skipped: true, reason: "no document tabular section or accounting register fixture" };
      }

      const result = await okTool(this.client, "validate_1c_query", {
        // Основная таблица регистра нужна по существу: кейс проверяет именно риск
        // умножения строк при соединении табличной части с записями регистра, а
        // ДвиженияССубконто отдаёт готовые пары Дт+Кт и умножала бы строки иначе.
        // Исключение объявлено штатным маркером, как требует §1, и стоит ПЕРВОЙ строкой:
        // предмет кейса — fanout, а не расположение комментария.
        query: "// СТАНДАРТ-ИСКЛЮЧЕНИЕ: base_register_table_without_vt_check — кейс проверяет умножение строк на записях регистра, ДвиженияССубконто отдаёт пары Дт+Кт и меняет саму проверяемую семантику\n"
          + `ВЫБРАТЬ ПЕРВЫЕ 10 ТЧ.Ссылка КАК Документ, СУММА(ТЧ.Сумма) КАК Сумма ИЗ ${documentWithTabular.full_name}.${documentWithTabular.tabularSection.name} КАК ТЧ ВНУТРЕННЕЕ СОЕДИНЕНИЕ ${accountingRegister.fullName} КАК Рег ПО Рег.Регистратор = ТЧ.Ссылка СГРУППИРОВАТЬ ПО ТЧ.Ссылка`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `fanout-risk query should remain valid, errors=${JSON.stringify(result.errors)}`);
      assert((result.warnings || []).some((warning) => warning.includes("Риск умножения строк")), `fanout warning is missing: ${JSON.stringify(result.warnings)}`);
      assert(hasGuidance(result, "document_tabular_register_join_fanout"), "fanout guidance is missing");
      return {
        document: documentWithTabular.full_name,
        tabularSection: documentWithTabular.tabularSection.name,
        register: accountingRegister.fullName,
        warnings: result.warnings,
        guidance: result.domain_guidance,
      };
    });

    await this.test("tool.validate_1c_query_warns_accounting_subconto_fanout", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "validate_1c_query", {
        // Поле внешнего соединения обёрнуто в ЕСТЬNULL: §4.4 стандартов требует этого для
        // КАЖДОГО поля присоединяемой таблицы, попадающего в выборку, а не только в условие.
        // Соединение с компаньоном .Субконто — документированный паттерн §1.1, поэтому
        // основная таблица движений здесь допустима без объявленного исключения.
        query: `ВЫБРАТЬ ПЕРВЫЕ 10 Рег.Регистратор КАК Регистратор, ЕСТЬNULL(Субконто.Значение, НЕОПРЕДЕЛЕНО) КАК Субконто ИЗ ${accountingRegister.fullName} КАК Рег ЛЕВОЕ СОЕДИНЕНИЕ ${accountingRegister.fullName}.Субконто КАК Субконто ПО Рег.Период = Субконто.Период И Рег.Регистратор = Субконто.Регистратор И Рег.НомерСтроки = Субконто.НомерСтроки`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `subconto join warning query must remain valid, errors=${JSON.stringify(result.errors)}`);
      assert((result.warnings || []).some((warning) => warning.includes("без отбора по Вид")), `subconto kind fanout warning is missing: ${JSON.stringify(result.warnings)}`);
      assert((result.warnings || []).some((warning) => warning.includes("ВидДвижения")), `subconto movement warning is missing: ${JSON.stringify(result.warnings)}`);
      return { register: accountingRegister.fullName, warnings: result.warnings };
    });

    // Подбор доменной подсказки не должен зависеть от форматирования запроса: триггеры
    // ищут ключевые слова вместе с окружающими пробелами, поэтому до нормализации
    // перевод строки после СОЕДИНЕНИЕ — обычный стиль — терял подсказку целиком.
    await this.test("regression.domain_guidance_survives_query_formatting", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      const documentWithTabular = this.context.genericDocument || this.context.catalogWithTabular;
      if (!accountingRegister || !documentWithTabular?.full_name) {
        return { skipped: true, reason: "no accounting register or document fixture" };
      }
      const ids = [];
      for (const [shape, joinSeparator] of [["одна строка", " "], ["перенос строки после СОЕДИНЕНИЕ", "\n\t"]]) {
        const result = await okTool(this.client, "validate_1c_query", {
          query: `ВЫБРАТЬ ПЕРВЫЕ 1 ТЧ.Ссылка КАК Документ ИЗ ${documentWithTabular.full_name} КАК ТЧ`
            + ` ВНУТРЕННЕЕ СОЕДИНЕНИЕ${joinSeparator}${accountingRegister.fullName} КАК Рег ПО Рег.Регистратор = ТЧ.Ссылка`,
          strict: true,
          explain: true,
        });
        const has = hasGuidance(result, "document_tabular_register_join_fanout");
        assert(has, `guidance пропала при форматировании «${shape}»: ${JSON.stringify((result.domain_guidance || []).map((item) => item.id))}`);
        ids.push(shape);
      }
      return { shapes: ids };
    });

    await this.test("tool.validate_1c_query_returns_guidance_is_contextual", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const sales = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК Продажи ИЗ ${fixture.full_name}`,
        strict: true,
        explain: true,
      });
      assert(hasGuidance(sales, "returns_and_storno"), "sales-like query validation must include returns-and-storno guidance");
      assert(hasGuidance(sales, "report_or_direct_query_choice"), "sales-like query validation must include report-or-query guidance");

      const assets = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК ОсновныеСредства ИЗ ${fixture.full_name}`,
        strict: true,
        explain: true,
      });
      assert(hasGuidance(assets, "returns_and_storno"), "fixed-assets query validation must include returns-and-storno guidance");

      const hr = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК КадровыйОбъект ИЗ ${fixture.full_name}`,
        strict: true,
        explain: true,
      });
      assert(!hasGuidance(hr, "returns_and_storno"), "HR-like query validation must not include returns-and-storno guidance");
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      let subconto = null;
      if (accountingRegister) {
        subconto = await okTool(this.client, "validate_1c_query", {
          query: `ВЫБРАТЬ ПЕРВЫЕ 1 Обороты.СубконтоДт1 ИЗ ${accountingRegister.fullName}.ОборотыДтКт(&Начало, &Конец) КАК Обороты`,
          parameters: {
            Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
            Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
          },
          strict: true,
          explain: true,
        });
        assert(hasGuidance(subconto, "subconto_join_by_uuid"), "subconto query validation must include UUID join guidance");
        const instruction = (subconto.domain_guidance || []).find((item) => item.id === "subconto_join_by_uuid")?.instruction || "";
        assert(instruction.includes("ВидыСубконто"), "subconto guidance must mention account chart ВидыСубконто lookup");
      }
      return {
        salesValid: sales.valid,
        assetsValid: assets.valid,
        hrValid: hr.valid,
        salesGuidance: sales.domain_guidance,
        assetsGuidance: assets.domain_guidance,
        subcontoGuidance: subconto?.domain_guidance,
      };
    });

    await this.test("tool.domain_guidance_parity_payroll_and_balance_TC029", async () => {
      // --- P2: payroll-salary-source-selection должен быть на ОБОИХ путях ---
      const payrollDiscovery = await okTool(this.client, "list_reports", {
        query: "начисленная зарплата сотрудников за период",
        include_variants: true,
        include_guidance: true,
        limit: 1,
      });
      const payrollQuery = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ Обороты.СуммаОборотКт ИЗ РегистрБухгалтерии.Хозрасчетный.Обороты(&Нач, &Кон, , Счет = &Счет70) КАК Обороты",
        parameters: {
          Нач: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Кон: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        strict: true,
        include_guidance: true,
      });
      assert(hasGuidance(payrollDiscovery, "payroll-salary-source-selection"),
        "P2: payroll guidance must appear on discovery path (list_reports)");
      assert(hasGuidance(payrollQuery, "payroll-salary-source-selection"),
        "P2: payroll guidance must appear on query path (credit turnover of account 70)");

      // --- P3: accounting-balance-vs-turnover должен быть на ОБОИХ путях ---
      const balanceQuery = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ Остатки.СуммаОстаток ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки(&НаДату, Счет = &Счет62) КАК Остатки",
        parameters: { НаДату: { kind: "datetime", value: CONTRACT_PERIOD.end } },
        strict: true,
        include_guidance: true,
      });
      const balanceDiscovery = await okTool(this.client, "list_reports", {
        query: "долг контрагента на конец 2024 года",
        include_variants: true,
        include_guidance: true,
        limit: 1,
      });
      assert(hasGuidance(balanceQuery, "accounting-balance-vs-turnover"),
        "P3: balance guidance must appear on query path (validate_1c_query)");
      assert(hasGuidance(balanceDiscovery, "accounting-balance-vs-turnover"),
        "P3: balance guidance must appear on discovery path (list_reports)");

      return {
        payrollDiscovery: (payrollDiscovery.domain_guidance || []).map((i) => i.id),
        payrollQuery: (payrollQuery.domain_guidance || []).map((i) => i.id),
        balanceQuery: (balanceQuery.domain_guidance || []).map((i) => i.id),
        balanceDiscovery: (balanceDiscovery.domain_guidance || []).map((i) => i.id),
      };
    });

    await this.test("tool.validate_1c_query_rejects_main_register_subconto_dtkt", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Хозрасчетный.СубконтоДт1 КАК Субконто ИЗ ${accountingRegister.fullName} КАК Хозрасчетный`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "main accounting register СубконтоДт1 must be invalid");
      assert((result.errors || []).some((error) => error.code === "subconto_wrong_table"), `subconto_wrong_table error is missing: ${JSON.stringify(result.errors)}`);
      return { errors: result.errors };
    });

    // #86: АБС/ABS — функция встроенного языка, в языке запросов её нет. Предвалидатор
    // пропускал вызов как валидный, а движок падал синтаксической ошибкой на первом же
    // АБС(. Второй ассерт кейса охраняет обратную сторону правила: список закрыт, и
    // подстрока в имени поля вызовом не считается — иначе правило начнёт давать ложные
    // отказы на функциях конфигурации и на собственных псевдонимах.
    await this.test("tool.validate_1c_query_rejects_unsupported_function", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const rejected = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 АБС(-1) КАК Модуль ИЗ ${fixture.full_name} КАК Объект`,
        strict: true,
        explain: true,
      });
      const codes = (rejected.errors || []).map((error) => error.code);
      assert(rejected.valid === false, "АБС(...) must be rejected before the engine");
      assert(codes.includes("unsupported_query_function"),
        `expected unsupported_query_function, got: ${codes.join(", ") || "нет"}`);

      const allowed = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Объект.Ссылка КАК СсылкаАБС ИЗ ${fixture.full_name} КАК Объект`,
        strict: true,
        explain: true,
      });
      assert(allowed.valid === true,
        `identifier containing АБС must stay valid: ${JSON.stringify(allowed.errors || [])}`);
      return { rejectedCodes: codes, allowed: allowed.valid };
    });

    await this.test("tool.validate_1c_query_having_keyword", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 10 Объект.Ссылка КАК Ссылка, КОЛИЧЕСТВО(Объект.Ссылка) КАК Количество ИЗ ${fixture.full_name} КАК Объект СГРУППИРОВАТЬ ПО Объект.Ссылка ИМЕЮЩИЕ КОЛИЧЕСТВО(Объект.Ссылка) > 0`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `ИМЕЮЩИЕ must be valid, errors=${JSON.stringify(result.errors)}`);
      assert(hasQueryGuidance(result, "grouping_having"), "validation must include grouping guidance");
      return { detected: result.detected_objects };
    });

    await this.test("tool.get_1c_query_guidance_contextual", async () => {
      const result = await okTool(this.client, "get_1c_query_guidance", {
        query: "ВЫБРАТЬ Субконто1, СУММА(СуммаОборот) КАК Сумма ПОМЕСТИТЬ ВТ_Обороты ИЗ РегистрБухгалтерии.<Имя>.Обороты(&Нач, &Кон) СГРУППИРОВАТЬ ПО Субконто1 ИМЕЮЩИЕ СУММА(СуммаОборот) > 0",
        intent: "проверить бухгалтерскую аналитику по субконто через временные таблицы",
        include_examples: true,
        max_sections: 8,
      });
      assert(Array.isArray(result.guidance), "guidance must be an array");
      assert(result.configuration_agnostic === true, "guidance must be configuration agnostic");
      assert(hasGuidanceItem(result.guidance, "temporary_tables_read_only"), "must include temporary table guidance");
      assert(hasGuidanceItem(result.guidance, "subconto_generic"), "must include subconto guidance");
      assert(hasGuidanceItem(result.guidance, "grouping_having"), "must include grouping guidance");
      const parameters = await okTool(this.client, "get_1c_query_guidance", {
        topic: "parameters",
        include_examples: true,
        max_sections: 3,
      });
      assert(hasGuidanceItem(parameters.guidance, "query_parameters"), "parameters topic must include query_parameters guidance");
      assert(JSON.stringify(parameters.guidance).includes("uuid"), "parameters guidance must mention UUID references");
      const payroll = await okTool(this.client, "get_1c_query_guidance", {
        topic: "payroll-and-hr",
        include_examples: true,
        max_sections: 3,
      });
      assert(hasGuidanceItem(payroll.guidance, "payroll_calculation_registers"), "payroll topic must include calculation register guidance");
      const reportsVsQuery = await okTool(this.client, "get_1c_query_guidance", {
        topic: "reports-vs-query",
        include_examples: true,
        max_sections: 3,
      });
      assert(hasGuidanceItem(reportsVsQuery.guidance, "report_or_direct_query_choice"), "reports-vs-query topic must include report-or-query guidance");
      const debtors = await okTool(this.client, "get_1c_query_guidance", {
        intent: "отчет по дебиторам: долг на начало 2025, отгрузки за 2024, оплаты за 2024, долг на текущий момент",
        include_examples: true,
        max_sections: 8,
      });
      assert(hasGuidanceItem(debtors.guidance, "debtors_report_pattern"), "debtor report guidance must include deterministic pattern");
      return { guidance: result.guidance.map((item) => item.id), debtorsGuidance: debtors.guidance.map((item) => item.id) };
    });

    await this.test("tool.1c_language_docs_generated_index", async () => {
      const topics = await okTool(this.client, "list_1c_language_doc_topics", {
        version: "8.3.27",
      });
      assert(topics.version === "8.3.27", "topics must use documentation version 8.3.27");
      assert(Array.isArray(topics.supported_versions) && topics.supported_versions.includes("8.3.27"), "topics must expose supported_versions");
      assert(Array.isArray(topics.topics), "topics must be an array");
      assert(topics.topics.every((item) => item.version === "8.3.27"), "topics must be filtered by requested version");
      assert(topics.topics.some((item) => item.id === "query-syntax"), "query-syntax topic is missing");
      assert(topics.topics.some((item) => item.id === "version-provenance"), "version-provenance topic is missing");

      const slice = await okTool(this.client, "search_1c_language_docs", {
        query: "СрезПоследних ГДЕ Условие",
        top_k: 5,
        max_chars_per_result: 1200,
      });
      assert(slice.version === "8.3.27", "search must use documentation version 8.3.27");
      assert(Array.isArray(slice.supported_versions) && slice.supported_versions.includes("8.3.27"), "search must expose supported_versions");
      assert(Array.isArray(slice.results), "search results must be an array");
      assert(slice.results.every((item) => item.version === "8.3.27"), "search results must include requested version");
      assert(slice.results.some((item) => String(item.source_file || "").includes("info-register")), "СрезПоследних search must find info-register docs");
      assert(slice.results.every((item) => String(item.excerpt || "").length <= 1200), "search excerpts must respect max_chars_per_result");

      const abs = await okTool(this.client, "search_1c_language_docs", {
        query: "АБС функция",
        top_k: 5,
      });
      assert(abs.results.some((item) => String(item.source_file || "").includes("functions-and-expressions")), "АБС search must find functions docs");

      const section = slice.results[0];
      const read = await okTool(this.client, "read_1c_language_doc_section", {
        section_id: section.section_id,
        version: section.version,
        max_chars: 1000,
      });
      assert(read.section_id === section.section_id, "read section must return requested section_id");
      assert(read.version === section.version, "read section must return requested version");
      assert(Array.isArray(read.supported_versions) && read.supported_versions.includes("8.3.27"), "read section must expose supported_versions");
      assert(typeof read.content === "string" && read.content.length > 0, "read section must return content");
      assert(read.content.length <= 1000, "read section must respect max_chars");

      const provenance = await okTool(this.client, "get_1c_language_doc_provenance", {
        version: "8.3.27",
      });
      assert(provenance.version === "8.3.27", "provenance must use documentation version 8.3.27");
      assert(Array.isArray(provenance.rules?.supported_versions) && provenance.rules.supported_versions.includes("8.3.27"), "provenance rules must expose supported_versions");
      assert(String(provenance.source_file || "").includes("version-provenance"), "provenance must cite version-provenance source");
      assert(provenance.rules?.default_version === "8.3.27", "provenance must include default_version rule");
      return {
        topics: topics.topics.length,
        sliceResults: slice.results.map((item) => item.section_id),
        absResults: abs.results.map((item) => item.section_id),
      };
    });

    await this.test("tool.get_accounting_accounts_map", async () => {
      const charts = await okTool(this.client, "list_metadata_objects", {
        kinds: ["ПланСчетов"],
        limit: 1,
      });
      const chart = charts.objects?.[0]?.full_name;
      if (!chart) return { skipped: true, reason: "no chart of accounts in metadata" };
      const result = await okTool(this.client, "get_accounting_accounts_map", {
        chart,
        include_empty_subconto: false,
        include_raw_rows: true,
        limit: 5,
      });
      assert(result.chart === chart, `unexpected chart: ${result.chart}`);
      assert(Array.isArray(result.columns), "columns must be present");
      assert(Array.isArray(result.rows), "rows must be present");
      assert(Array.isArray(result.accounts), "accounts must be present");
      assert("total_accounts" in result, "total_accounts must be present");
      if (result.accounts.length > 0) {
        assert(Array.isArray(result.accounts[0].subconto), "account.subconto must be an array");
      }
      assert(result.configuration_agnostic === true, "result must be configuration agnostic");
      const maxLimitResult = await okTool(this.client, "get_accounting_accounts_map", {
        chart,
        include_query: true,
        limit: 1000,
      });
      assert(maxLimitResult.query_used?.includes("ВЫБРАТЬ ПЕРВЫЕ 1000 "), "query must use an ungrouped numeric limit");
      assert(!/ВЫБРАТЬ\s+ПЕРВЫЕ\s+1[\s\u00a0\u202f]+000\b/u.test(maxLimitResult.query_used || ""), "query limit must not contain thousands separators");
      return { chart, rows: result.rows.length, maxLimitAccounts: maxLimitResult.accounts?.length || 0, subcontoAttributes: result.subconto_attributes };
    });

    await this.test("tool.get_accounting_entries_grouped", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        credit_account_code_prefixes: ["02"],
        group_by: ["period_month", "credit_account"],
        include_query: true,
        limit: 5,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(result.accounting_register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.configuration_agnostic === true, "result must be configuration agnostic");
      assert(result.mode === "entries_grouped", "grouped entries mode is expected");
      assert(columnNames.includes("ПериодМесяц"), "period_month grouping column is missing");
      assert(columnNames.includes("СчетКт"), "credit_account grouping column is missing");
      assert(columnNames.includes("Сумма"), "amount aggregate column is missing");
      assert(result.query_used?.includes(`${accountingRegister.fullName} КАК Рег`), "query must read main accounting register records");
      assert(result.query_used?.includes("Рег.СчетКт.Код ПОДОБНО &CreditPrefix0"), "credit account prefix filter must be emitted");
      return { register: accountingRegister.fullName, rows: result.rows?.length || 0, queryUsed: result.query_used };
    });

    await this.test("tool.get_accounting_entries_subconto_join", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const charts = await okTool(this.client, "list_metadata_objects", {
        kinds: ["ПланСчетов"],
        limit: 1,
      });
      const chart = charts.objects?.[0]?.full_name;
      if (!chart) return { skipped: true, reason: "no chart of accounts in metadata" };
      const accountMap = await okTool(this.client, "get_accounting_accounts_map", {
        chart,
        include_empty_subconto: false,
        limit: 20,
      });
      const account = (accountMap.accounts || []).find((item) => item.subconto?.[0]?.ref?.type && item.subconto?.[0]?.ref?.uuid);
      const subconto = account?.subconto?.[0]?.ref;
      if (!account?.code || !subconto) {
        return { skipped: true, reason: "no account with subconto mapping", chart };
      }
      const result = await okTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        credit_account_code_prefixes: [String(account.code)],
        subconto_side: "credit",
        subconto_kind: toQueryRef(subconto),
        group_by: ["credit_subconto"],
        include_query: true,
        limit: 5,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(columnNames.includes("СубконтоКт"), "credit subconto grouping column is missing");
      assert(result.query_used?.includes(`${accountingRegister.fullName}.Субконто КАК СубконтоКт`), "query must join accounting register subconto table");
      // Соединение обязано быть внутренним: при левом поле компаньона попадает в выборку
      // и группировку как потенциальный NULL, что отклоняется правилом
      // outer_join_field_without_isnull, а обёртка в ЕСТЬNULL для составной ссылки
      // невозможна (§4.4 — нет значения того же типа).
      assert(result.query_used?.includes("ВНУТРЕННЕЕ СОЕДИНЕНИЕ"), "subconto companion must be joined with ВНУТРЕННЕЕ СОЕДИНЕНИЕ");
      assert(!result.query_used?.includes("ЛЕВОЕ СОЕДИНЕНИЕ"), "left join with subconto companion reintroduces the NULL trap");
      assert(result.query_used?.includes("СубконтоКт.Вид = &ВидСубконто"), "subconto kind filter must be emitted");
      return { register: accountingRegister.fullName, account: account.code, subconto: subconto.presentation, rows: result.rows?.length || 0 };
    });

    await this.test("tool.get_accounting_entries_preflight_rejects_mismatched_subconto_kind", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const charts = await okTool(this.client, "list_metadata_objects", {
        kinds: ["ПланСчетов"],
        limit: 1,
      });
      const chart = charts.objects?.[0]?.full_name;
      if (!chart) return { skipped: true, reason: "no chart of accounts in metadata" };
      const accountMap = await okTool(this.client, "get_accounting_accounts_map", {
        chart,
        include_empty_subconto: false,
        limit: 1000,
      });
      const accounts = accountMap.accounts || [];
      let fixture = null;
      for (const account of accounts) {
        const accountCode = String(account.code || "");
        const familySubcontoUuids = new Set(
          accounts
            .filter((item) => String(item.code || "").startsWith(accountCode))
            .flatMap((item) => item.subconto || [])
            .map((item) => item.uuid)
            .filter(Boolean),
        );
        const foreign = accounts
          .flatMap((item) => item.subconto || [])
          .find((item) => item.uuid && item.ref?.type && !familySubcontoUuids.has(item.uuid));
        if (accountCode && account.subconto?.length && foreign) {
          fixture = { account, foreign };
          break;
        }
      }
      if (!fixture) return { skipped: true, reason: "no mismatched subconto kind fixture", chart };

      const result = await rawTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        chart,
        debit_account_code_prefixes: [String(fixture.account.code)],
        subconto_side: "debit",
        subconto_kind: {
          type: fixture.foreign.ref.type,
          uuid: fixture.foreign.uuid,
          presentation: fixture.foreign.name,
        },
        group_by: ["debit_subconto", "debit_account"],
        include_query: true,
        limit: 5,
      });
      assert(result.ok === false, "mismatched subconto kind must fail before query execution");
      assert((result.error_code || result.error?.error_code) === "subconto_kind_mismatch", `unexpected smart error_code: ${JSON.stringify(result)}`);
      const details = result.details || result.error?.details?.parsed_details || {};
      assert(Array.isArray(details.available_subconto_kinds), "available_subconto_kinds must be present");
      assert(details.available_subconto_kinds.length === (fixture.account.subconto || []).length
        || details.available_subconto_kinds.length > 0, "available_subconto_kinds must not be empty for selected account");
      assert(Array.isArray(result.suggestions || result.error?.suggestions), "suggestions must be present");
      assert(Array.isArray(result.query_guidance || result.error?.query_guidance), "query_guidance must be forced on mismatch");
      return {
        account: fixture.account.code,
        requestedSubconto: fixture.foreign.name,
        available: details.available_subconto_kinds,
        errorCode: result.error_code || result.error?.error_code,
      };
    });

    await this.test("tool.get_accounting_entries_rejects_ambiguous_subconto_grouping", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await rawTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        group_by: ["credit_subconto"],
        limit: 5,
      });
      assert(result.ok === false, "ambiguous subconto grouping must fail");
      assert(result.error?.code === "invalid_arguments", `unexpected code: ${result.error?.code}`);
      assert(String(result.error?.message || "").includes("subconto_kind"), "error must point to subconto_kind");
      return { error: result.error };
    });

    await this.test("tool.get_calculation_types_map", async () => {
      const plans = await okTool(this.client, "list_metadata_objects", {
        kinds: ["ПланВидовРасчета"],
        limit: 2,
      });
      const plan = plans.objects?.[0]?.full_name;
      if (!plan) return { skipped: true, reason: "no chart of calculation types in metadata" };
      const result = await okTool(this.client, "get_calculation_types_map", {
        plan,
        limit: 5,
      });
      assert(result.plan === plan, `unexpected plan: ${result.plan}`);
      assert(Array.isArray(result.calculation_types), "calculation_types must be present");
      assert("total_calculation_types" in result, "total_calculation_types must be present");
      assert(result.configuration_agnostic === true, "result must be configuration agnostic");
      return { plan, calculationTypes: result.calculation_types.length, total: result.total_calculation_types };
    });

    await this.test("tool.get_database_passport", async () => {
      const result = await okTool(this.client, "get_database_passport", {
        include_organizations: true,
        include_period: true,
        include_closed_periods: true,
        include_accumulation_registers: true,
        include_information_registers: true,
        include_calculation_registers: true,
        organization_limit: 5,
        accounting_register_limit: 2,
        accumulation_register_limit: 5,
        information_register_limit: 5,
        calculation_register_limit: 5,
        include_empty_registers: true,
      });
      assert(result.configuration_agnostic === true, "passport must be configuration agnostic");
      assert(result.read_only === true, "passport must be read-only");
      assert(result.cache_hit === false || result.cache_hit === true, "cache_hit must be boolean");
      assert(typeof result.cache_age_seconds === "number", "cache_age_seconds must be a number");
      assert(Array.isArray(result.organizations), "organizations must be an array");
      assert(result.data_period && typeof result.data_period === "object", "data_period must be present");
      assert(Array.isArray(result.accounting_registers), "accounting_registers must be an array");
      // Внутренний запрос паспорта не должен отклоняться собственными правилами
      // предвалидатора: period_error означает, что сервер зарезал сам себя, и период
      // данных молча приходит пустым (регресс от base_register_table_without_vt_check).
      for (const register of result.accounting_registers) {
        assert(register.period_error === undefined,
          `passport period query rejected for ${register.register}: ${register.period_error}`);
      }
      assert(Array.isArray(result.closed_periods), "closed_periods must be an array");
      assert(result.accumulation_registers && typeof result.accumulation_registers === "object", "accumulation_registers must be an object");
      assert(result.accumulation_registers.cache_hit === false || result.accumulation_registers.cache_hit === true, "accumulation_registers.cache_hit must be boolean");
      assert(typeof result.accumulation_registers.cache_age_seconds === "number", "accumulation_registers.cache_age_seconds must be a number");
      assert(typeof result.accumulation_registers.checked === "number", "accumulation_registers.checked must be a number");
      assert(Array.isArray(result.accumulation_registers.with_data), "accumulation_registers.with_data must be an array");
      assert(Array.isArray(result.accumulation_registers.empty), "accumulation_registers.empty must be an array");
      assert(result.information_registers && typeof result.information_registers === "object", "information_registers must be an object");
      assert(result.calculation_registers && typeof result.calculation_registers === "object", "calculation_registers must be an object");
      return {
        organizations: result.organizations.length,
        accountingRegisters: result.accounting_registers.length,
        accumulationChecked: result.accumulation_registers_checked,
      };
    });

    await this.test("tool.list_legal_sources", async () => {
      const result = await okTool(this.client, "list_legal_sources", {});
      assert(Array.isArray(result.sources), "sources must be an array");
      assert(result.sources.length >= 1, "registry must contain at least one source");
      assert(typeof result.total === "number", "total must be a number");
      const pravo = result.sources.find((s) => s.id === "pravo_gov_ru");
      assert(pravo, "embedded source pravo_gov_ru must be present");
      assert(Array.isArray(pravo.coverage_areas) && pravo.coverage_areas.length > 0, "coverage_areas must be non-empty");
      assert(pravo.api_available === true, "pravo_gov_ru must advertise api_available");
      const actual = result.sources.find((s) => s.id === "pravo_gov_ru_actual");
      assert(actual, "embedded source pravo_gov_ru_actual must be present");
      assert(result.policy?.internet_search_forbidden === true, "policy.internet_search_forbidden must be true");
      assert(result.policy?.web_search_fallback_forbidden === true, "policy.web_search_fallback_forbidden must be true");
      assert(result.policy?.enforcement === "mandatory", "policy.enforcement must be mandatory");
      assert(result.policy?.allowed_access_mode === "direct_to_registry_source_urls_only",
        "policy.allowed_access_mode must allow only direct registry-source URLs");
      assert(result.policy?.on_source_unavailable === "stop_and_report_unverified",
        "policy.on_source_unavailable must be fail-closed");
      assert(Array.isArray(result.policy?.required_workflow)
        && result.policy.required_workflow.join(",") ===
          "list_legal_sources,get_legal_source_guide,direct_request_to_guide_url,cite_source_document_and_card",
        "policy.required_workflow must declare the complete legal-source route");
      const filtered = await okTool(this.client, "list_legal_sources", { area: "налог" });
      assert(filtered.sources.some((s) => s.id === "pravo_gov_ru"), "area filter 'налог' must keep pravo_gov_ru");
      return { total: result.total, filteredTotal: filtered.total };
    });

    await this.test("tool.get_legal_source_guide", async () => {
      const result = await okTool(this.client, "get_legal_source_guide", { source_id: "pravo_gov_ru" });
      assert(result.source_id === "pravo_gov_ru", `unexpected source_id: ${result.source_id}`);
      assert(typeof result.guide === "string" && result.guide.length > 500, "guide must be a substantial text");
      assert(result.guide.includes("publication.pravo.gov.ru"), "guide must mention the portal");
      assert(result.links?.document_card_template?.includes("{eoNumber}"), "links must include document card template");
      assert(result.links?.document_pdf_template?.includes("{eoNumber}"), "links must include pdf template");
      assert(result.policy?.internet_search_forbidden === true, "policy.internet_search_forbidden must be true");
      assert(result.policy?.web_search_fallback_forbidden === true, "guide policy must forbid web-search fallback");
      assert(result.policy?.on_source_unavailable === "stop_and_report_unverified",
        "guide policy must be fail-closed when source is unavailable");
      assert(result.guide.includes("обязательное ограничение") && result.guide.includes("как fallback"),
        "guide must state that no-web-fallback policy is mandatory");
      return { guideLength: result.guide.length, storage: result.storage };
    });

    await this.test("negative.get_legal_source_guide_unknown_source", async () => {
      const result = await rawTool(this.client, "get_legal_source_guide", { source_id: "no_such_source" });
      assert(result.ok === false, "unknown source_id must fail");
      assert(result.error?.code === "invalid_arguments", `expected invalid_arguments, got: ${result.error?.code}`);
      assert(String(result.error?.message || "").includes("list_legal_sources"), "error must point to list_legal_sources");
      return { code: result.error?.code };
    });

    await this.test("tool.run_1c_query_temporary_table_package", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 5 Объект.Ссылка КАК Ссылка, УникальныйИдентификатор(Объект.Ссылка) КАК UUID ПОМЕСТИТЬ ВТОбъекты ИЗ ${fixture.full_name} КАК Объект ИНДЕКСИРОВАТЬ ПО UUID; ВЫБРАТЬ ПЕРВЫЕ 1 ВТОбъекты.Ссылка КАК Ссылка, ВТОбъекты.UUID КАК UUID ИЗ ВТОбъекты КАК ВТОбъекты`,
        limit: 1,
        include_column_types: true,
      });
      const row = result.rows?.[0];
      if (!row) return { skipped: true, reason: "generic catalog fixture has no rows", catalog: fixture.full_name };
      assertRef(row.Ссылка, "temporary table ref");
      assert(row.Ссылка.uuid === row.UUID, "temporary table UUID must match encoded ref uuid");
      assert(result.validation?.ok === true, "run_1c_query must include successful validation.ok");
      assert(result.validation?.valid === true, "run_1c_query validation must keep valid=true for compatibility");
      assert(Array.isArray(result.validation?.warnings), "run_1c_query validation warnings must be an array");
      return { row };
    });

    await this.test("tool.run_1c_query_guidance_is_opt_in", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const query = `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка КАК Продажи ИЗ ${fixture.full_name}`;
      const compact = await okTool(this.client, "run_1c_query", {
        query,
        limit: 1,
      });
      assert(!Array.isArray(compact.query_guidance), "run_1c_query must omit query_guidance by default");
      assert(!Array.isArray(compact.domain_guidance), "run_1c_query must omit domain_guidance by default");
      assert(!Array.isArray(compact.validation?.query_guidance), "run_1c_query validation.query_guidance must be opt-in");

      const guided = await okTool(this.client, "run_1c_query", {
        query,
        limit: 1,
        include_guidance: true,
      });
      assert(Array.isArray(guided.query_guidance), "run_1c_query must include query_guidance when requested");
      assert(Array.isArray(guided.validation?.query_guidance), "run_1c_query validation.query_guidance must follow include_guidance");
      return { compactRows: compact.rows?.length || 0, guidedQueryGuidance: guided.query_guidance.length };
    });

    await this.test("tool.run_1c_query_counterparty_contact_info", async () => {
      const fixture = this.context.catalogWithTabular;
      if (!fixture?.tabularSection?.name) return { skipped: true, reason: "no tabular section fixture" };
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 5 Ссылка ИЗ ${fixture.full_name}.${fixture.tabularSection.name}`,
        limit: 5,
        include_column_types: true,
      });
      if (!result.rows?.length) {
        return { skipped: true, reason: "tabular section fixture has no rows", table: `${fixture.full_name}.${fixture.tabularSection.name}` };
      }
      const first = result.rows[0];
      assertRef(first.Ссылка, "tabular section row owner ref");
      this.context.counterpartyRef = first.Ссылка;
      this.context.sampleRef ||= first.Ссылка;
      return { rows: result.rows.length, firstRef: first.Ссылка };
    });

    await this.test("tool.run_1c_query_reference_encoding", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка, УникальныйИдентификатор(Ссылка) КАК UUID ИЗ ${fixture.full_name}`,
        limit: 1,
        include_column_types: true,
      });
      const row = result.rows?.[0];
      if (!row) return { skipped: true, reason: "generic catalog fixture has no rows", catalog: fixture.full_name };
      assertRef(row.Ссылка, "organization query ref");
      assert(row.Ссылка.uuid === row.UUID, "encoded ref uuid must match query UUID column");
      this.context.organizationRef = row.Ссылка;
      this.context.sampleRef ||= row.Ссылка;
      return { ref: row.Ссылка };
    });

    await this.test("tool.run_1c_query_accounting_debit_credit_subconto", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Обороты.СчетДт, Обороты.СчетКт, Обороты.СубконтоДт1, Обороты.СубконтоКт1, Обороты.СуммаОборот ИЗ ${accountingRegister.fullName}.ОборотыДтКт(&Начало, &Конец) КАК Обороты`,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 1,
        include_column_types: true,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(columnNames.includes("СубконтоДт1"), "ОборотыДтКт query must expose СубконтоДт1");
      assert(columnNames.includes("СубконтоКт1"), "ОборотыДтКт query must expose СубконтоКт1");
      return { register: accountingRegister.fullName, columns: columnNames, rows: result.rows?.length || 0 };
    });

    await this.test("negative.run_1c_query_vt_field_rejected_pre_flight", async () => {
      // ТЗ pre-flight: несуществующее поле ВТ отсекается ДО движка с детерминированным
      // validation_failed_before_run (критерии приёмки 1 и 7). СуммаПРОборот в ОборотыДтКт
      // не существует (есть только СуммаПРОборотДт/Кт), поэтому запрос блокируется заранее.
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Обороты.СуммаПРОборот ИЗ ${accountingRegister.fullName}.ОборотыДтКт(&Начало, &Конец) КАК Обороты`,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 1,
      });
      const errorCode = result.error_code || result.error?.error_code;
      const topCode = result.error?.code;
      const sourceTable = result.source_table || result.error?.source_table;
      const availableFields = result.available_fields || result.error?.available_fields || [];
      const availableFieldsSource = result.available_fields_source || result.error?.available_fields_source;
      const availableFieldsSample = result.available_fields_sample || result.error?.available_fields_sample || [];
      const hint = result.hint || result.error?.hint || "";
      const field = result.field || result.error?.field;
      const object = result.object || result.error?.object;
      const correlationId = result.error?.correlation_id;
      assert(result.ok === false, "invalid ОборотыДтКт field must fail");
      assert(errorCode === "validation_failed_before_run", `expected pre-flight rejection, got: ${errorCode}`);
      assert(topCode === "validation_failed_before_run", `error.code must be validation_failed_before_run, got: ${topCode}`);
      assert(field === "СуммаПРОборот", `unexpected field: ${field}`);
      assert(object === accountingRegister.fullName, `unexpected object: ${object}`);
      assert(typeof correlationId === "string" && correlationId.length > 0, "correlation_id must be preserved");
      assert(sourceTable === `${accountingRegister.fullName}.ОборотыДтКт`, `unexpected source_table: ${sourceTable}`);
      assert(availableFieldsSource === "virtual_table", `available_fields_source must be virtual_table, got: ${availableFieldsSource}`);
      assert(availableFields.includes("СуммаПРОборотДт"), "available_fields must include СуммаПРОборотДт");
      assert(availableFields.includes("СуммаПРОборотКт"), "available_fields must include СуммаПРОборотКт");
      assert(!availableFields.includes("СуммаПРОборот"), "ОборотыДтКт must not advertise plain СуммаПРОборот (Дт/Кт only)");
      assert(!availableFields.includes("Содержание"), "available_fields must not contain main register fields");
      assert(availableFieldsSample[0]?.type === sourceTable, "available_fields_sample type must point to the virtual table");
      assert((availableFieldsSample[0]?.fields || []).includes("СуммаПРОборотДт"), "available_fields_sample must expose virtual-table fields");
      assert(hint.includes("ОборотыДтКт"), "hint must mention ОборотыДтКт");
      assert(hint.includes("СуммаПРОборотДт") && hint.includes("СуммаПРОборотКт"), "hint must suggest debit and credit replacements");
      return { register: accountingRegister.fullName, errorCode, sourceTable, availableFieldsCount: availableFields.length, hint };
    });

    // F7 (#84): область действия псевдонима. Первая команда пакета читает ВТ регистра
    // под псевдонимом Данные и кладёт результат во временную таблицу; вторая читает эту
    // временную таблицу ТОЖЕ под псевдонимом Данные и выбирает её поле Месяц. Поля Месяц
    // у ОстаткиИОбороты нет, и до фикса pre-flight приписывал обращение исходной ВТ,
    // отклоняя корректный запрос с validation_failed_before_run.
    await this.test("regression.run_1c_query_alias_reused_in_next_batch_command", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const query = `ВЫБРАТЬ
    Данные.Период КАК Месяц,
    СУММА(Данные.СуммаОборот) КАК Сумма
ПОМЕСТИТЬ ВТМесячныеДанные
ИЗ ${accountingRegister.fullName}.ОстаткиИОбороты(&Начало, &Конец, Месяц, , , , ) КАК Данные
СГРУППИРОВАТЬ ПО Данные.Период
;
ВЫБРАТЬ ПЕРВЫЕ 5
    Данные.Месяц КАК Месяц,
    Данные.Сумма КАК Сумма
ИЗ ВТМесячныеДанные КАК Данные
УПОРЯДОЧИТЬ ПО Месяц`;
      const result = await rawTool(this.client, "run_1c_query", {
        query,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 5,
      });
      const errorCode = result.error_code || result.error?.error_code;
      assert(errorCode !== "validation_failed_before_run",
        `alias reused in another batch command must not be attributed to the first source: ${JSON.stringify(result.error || {}).slice(0, 500)}`);
      assert(result.ok === true, `batch query must reach the engine: ${JSON.stringify(result.error || {}).slice(0, 500)}`);
      return { register: accountingRegister.fullName, rows: (result.rows || []).length };
    });

    // Обратная сторона того же правила: сужение области не должно превратить проверку в
    // «пропускать всё». Несуществующее поле ВТ в той же команде обязано по-прежнему
    // отклоняться до движка.
    await this.test("regression.run_1c_query_missing_vt_field_still_rejected_in_batch", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const query = `ВЫБРАТЬ
    Данные.ЗаведомоНетТакогоПоляВТ КАК Поле
ПОМЕСТИТЬ ВТПроба
ИЗ ${accountingRegister.fullName}.ОстаткиИОбороты(&Начало, &Конец, Месяц, , , , ) КАК Данные
;
ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Поле КАК Поле ИЗ ВТПроба КАК Данные`;
      const result = await rawTool(this.client, "run_1c_query", {
        query,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 1,
      });
      const errorCode = result.error_code || result.error?.error_code;
      assert(result.ok === false, "non-existent VT field must still fail");
      assert(errorCode === "validation_failed_before_run",
        `expected pre-flight rejection inside the declaring command, got: ${errorCode}`);
      const field = result.field || result.error?.field;
      assert(field === "ЗаведомоНетТакогоПоляВТ", `unexpected field: ${field}`);
      return { register: accountingRegister.fullName, errorCode, field };
    });

    await this.test("tool.vt_field_generator_authoritative_superset", async () => {
      // ТЗ критерии 3/4: генератор полей ВТ возвращает надмножество авторитетной схемы.
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const result = await okTool(this.client, "get_metadata_structure", {
        type: accountingRegister.fullName,
        include_standard_attributes: true,
        include_tabular_sections: false,
        include_virtual_tables: true,
      });
      const vts = result.metadata?.register_schema?.virtual_tables || [];
      const fieldsOf = (name) => (vts.find((v) => v.name === name)?.common_fields) || [];

      const balance = fieldsOf("Остатки");
      for (const f of ["СуммаОстаток", "СуммаОстатокДт", "СуммаОстатокКт", "СуммаРазвернутыйОстатокДт", "СуммаРазвернутыйОстатокКт", "КоличествоОстаток"]) {
        assert(balance.includes(f), `Остатки superset must include ${f}`);
      }

      const dtkt = fieldsOf("ОборотыДтКт");
      for (const f of ["СубконтоДт1", "СубконтоКт1", "СуммаОборот", "СуммаПРОборотДт", "СуммаПРОборотКт"]) {
        assert(dtkt.includes(f), `ОборотыДтКт superset must include ${f}`);
      }
      // СуммаОборотДт/СуммаОборотКт есть не на всех конфигурациях: у ОборотыДтКт
      // сумма корреспонденции одна (СуммаОборот), раздельные Дт/Кт остаются только
      // для НУ/ПР/ВР и валютных ресурсов. Проверяем конфигурационно-зависимо.
      const dtktHasSplitSum = dtkt.includes("СуммаОборотДт");
      if (dtktHasSplitSum) {
        assert(dtkt.includes("СуммаОборотКт"), "ОборотыДтКт must include both СуммаОборотДт and СуммаОборотКт");
      } else {
        assert(!dtkt.includes("СуммаОборотКт"), "ОборотыДтКт must NOT include СуммаОборотКт");
      }
      assert(!dtkt.includes("Субконто1"), "ОборотыДтКт must NOT include bare Субконто1");
      assert(!dtkt.includes("СуммаПРОборот"), "ОборотыДтКт must NOT include plain СуммаПРОборот");

      const balTurn = fieldsOf("ОстаткиИОбороты");
      for (const f of ["СуммаНачальныйОстаток", "СуммаОборот", "СуммаКонечныйОстаток"]) {
        assert(balTurn.includes(f), `ОстаткиИОбороты superset must include ${f}`);
      }
      // Развёрнутый остаток на начало/конец периода (Дт/Кт). Порядок сегментов
      // платформа задаёт сама, и он НЕ такой, как ждал прежний хардкод: контур
      // публикует и исполняет СуммаКонечныйРазвернутыйОстатокДт, а тест требовал
      // СуммаРазвернутыйКонечныйОстатокДт — отсюда «провал», который дефектом
      // сервера не был (классифицировано живой пробой 05.08.2026). Проверяем
      // наличие семейства по составу сегментов, а не по написанию: правило
      // универсальности запрещает зашивать порядок слов конкретной платформы.
      for (const edge of ["Начальный", "Конечный"]) {
        for (const side of ["Дт", "Кт"]) {
          const found = balTurn.find((f) =>
            f.startsWith("Сумма") && f.includes("Развернутый") && f.includes(edge)
            && f.includes("Остаток") && f.endsWith(side));
          assert(found, `ОстаткиИОбороты superset must include развёрнутый ${edge} остаток ${side}`
            + ` (в любом написании; получено: ${balTurn.filter((f) => f.includes("Развернутый")).join(", ") || "ничего"})`);
        }
      }
      return { balance: balance.length, dtkt: dtkt.length, balTurn: balTurn.length };
    });

    await this.test("regression.run_1c_query_developed_balance_fields_not_rejected", async () => {
      // ТЗ критерий 2 (прямая защита от регресса F4): валидные Дт/Кт/Развернутый поля
      // НЕ должны ложно отклоняться pre-flight.
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 3 Остатки.Счет, Остатки.СуммаОстатокДт, Остатки.СуммаОстатокКт, Остатки.СуммаРазвернутыйОстатокКт ИЗ ${accountingRegister.fullName}.Остатки(&Период) КАК Остатки`,
        parameters: { Период: { kind: "datetime", value: CONTRACT_PERIOD.end } },
        limit: 3,
      });
      const code = result.error_code || result.error?.error_code;
      assert(code !== "validation_failed_before_run",
        `F4 regression: valid developed balance fields must NOT be rejected pre-flight (got ${code})`);
      if (!result.ok) {
        return { softFail: true, reason: `engine rejected (likely non-correspondence register): ${code}` };
      }
      return { register: accountingRegister.fullName, rows: result.rows?.length ?? 0 };
    });

    await this.test("regression.run_1c_query_balance_turnover_developed_fields_not_rejected", async () => {
      // Прямое воспроизведение отчёта 2026-07-16 (BUH_KORP): развёрнутый конечный остаток
      // в ОстаткиИОбороты перечислялся в available_fields, но pre-flight его отклонял
      // (само-противоречие hint). Поле обязано проходить проверку — движок вызывается.
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      // Имя поля берём из опубликованного available_fields, а не зашиваем: порядок
      // сегментов задаёт платформа, и хардкод СуммаРазвернутыйКонечныйОстатокДт
      // давал «провал» на конфигурации, где публикуется и исполняется
      // СуммаКонечныйРазвернутыйОстатокДт. Проверяется pre-flight, а не написание.
      const schema = await rawTool(this.client, "get_metadata_structure", {
        type: accountingRegister.fullName,
        include_virtual_tables: true,
      });
      const btFields = (schema.metadata?.register_schema?.virtual_tables || [])
        .find((v) => v.name === "ОстаткиИОбороты")?.common_fields || [];
      const developedField = btFields.find((f) =>
        f.startsWith("Сумма") && f.includes("Развернутый") && f.includes("Конечный")
        && f.includes("Остаток") && f.endsWith("Дт"));
      if (!developedField) {
        return { skipped: true, reason: "у ОстаткиИОбороты нет развёрнутого конечного остатка Дт" };
      }
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 100 Ост.Период, Ост.${developedField} `
          + `ИЗ ${accountingRegister.fullName}.ОстаткиИОбороты(&Начало, &Конец, Месяц, ДвиженияИГраницыПериода, , , ) КАК Ост`,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 100,
      });
      const code = result.error_code || result.error?.error_code;
      assert(code !== "validation_failed_before_run",
        `report 2026-07-16: developed closing balance must NOT be rejected pre-flight (got ${code})`);
      if (!result.ok) {
        return { softFail: true, reason: `engine rejected (likely non-correspondence register): ${code}` };
      }
      return { register: accountingRegister.fullName, rows: result.rows?.length ?? 0 };
    });

    await this.test("invariant.pre_flight_never_rejects_advertised_vt_field", async () => {
      // Ядро отчёта 2026-07-16: валидатор не должен отклонять поле, которое сам же
      // объявляет в available_fields. Инвариант «advertised ⟹ accepted» проверяем на
      // семействе развёрнутых остатков ОстаткиИОбороты (ровно там всплыл дефект).
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const meta = await okTool(this.client, "get_metadata_structure", {
        type: accountingRegister.fullName,
        include_virtual_tables: true,
      });
      const advertised = ((meta.metadata?.register_schema?.virtual_tables || [])
        .find((v) => v.name === "ОстаткиИОбороты")?.common_fields) || [];
      const developed = advertised.filter((f) => /^.+Развернутый.+Остаток(Дт|Кт)$/.test(f));
      if (developed.length === 0) return { skipped: true, reason: "register exposes no developed-balance fields" };
      // Адресуем КАЖДОЕ объявленное развёрнутое поле — если хоть одно pre-flight отклонит,
      // это ровно баг из отчёта (перечислено как доступное, но не проходит проверку).
      const selectList = developed.map((f) => `Ост.${f}`).join(", ");
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 ${selectList} `
          + `ИЗ ${accountingRegister.fullName}.ОстаткиИОбороты(&Начало, &Конец) КАК Ост`,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 1,
      });
      const code = result.error_code || result.error?.error_code;
      assert(code !== "validation_failed_before_run",
        `advertised⟹accepted violated: pre-flight rejected an advertised field (got ${code}); field=${result.field || result.error?.field}`);
      if (!result.ok) {
        return { softFail: true, reason: `engine rejected (likely non-correspondence register): ${code}`, advertised: developed.length };
      }
      return { register: accountingRegister.fullName, advertisedDeveloped: developed.length };
    });

    // #81: инвариант «advertised ⟹ executable» для двусторонней ВТ. Каждое поле,
    // которое метаданные объявляют у ОборотыДтКт, обязано не только пройти pre-flight,
    // но и исполниться движком. Ловит обе стороны дефекта: плоское небалансовое
    // измерение в наборе (Валюта) упало бы в движке, а отсутствие стороннего имени
    // (ВалютаДт) — на pre-flight. Поля берутся из discovery, имена конфигурации
    // в кейсе не зашиты.
    await this.test("invariant.two_sided_vt_advertised_fields_executable", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const meta = await okTool(this.client, "get_metadata_structure", {
        type: accountingRegister.fullName,
        include_virtual_tables: true,
      });
      const advertised = ((meta.metadata?.register_schema?.virtual_tables || [])
        .find((v) => v.name === "ОборотыДтКт")?.common_fields) || [];
      if (advertised.length === 0) return { skipped: true, reason: "no advertised fields for ОборотыДтКт" };
      const selectList = advertised.map((f) => `Т.${f} КАК П${advertised.indexOf(f)}`).join(", ");
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 ${selectList} ИЗ ${accountingRegister.fullName}.ОборотыДтКт(&Начало, &Конец) КАК Т`,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 1,
      });
      const code = result.error_code || result.error?.error_code;
      assert(code !== "validation_failed_before_run",
        `advertised field rejected by pre-flight: ${result.field || result.error?.field}`);
      assert(result.ok === true,
        `advertised field must execute; engine said: ${String(result.error?.message || code).slice(0, 300)}`);
      return { register: accountingRegister.fullName, advertised: advertised.length };
    });

    // #81: у ДвиженияССубконто появился pre-flight (раньше генератор возвращал для
    // неё Ложь, и проверка не работала вовсе). Обе стороны: несуществующее поле
    // отклоняется до движка с available_fields от правильной таблицы, а реальные
    // поля записей движений (Регистратор и стороны счёта) проходят и исполняются.
    await this.test("regression.run_1c_query_dvizheniya_s_subkonto_pre_flight", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const params = {
        Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
        Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
      };
      const positive = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Период, Т.Регистратор, Т.СчетДт, Т.СчетКт, Т.СубконтоДт1 `
          + `ИЗ ${accountingRegister.fullName}.ДвиженияССубконто(&Начало, &Конец) КАК Т`,
        parameters: params,
        limit: 1,
      });
      const positiveCode = positive.error_code || positive.error?.error_code;
      assert(positiveCode !== "validation_failed_before_run",
        `real ДвиженияССубконто fields must pass pre-flight, rejected: ${positive.field || positive.error?.field}`);
      if (positive.ok !== true) {
        // Регистр без корреспонденции: полей СчетДт/СчетКт нет, схема не строится —
        // это объявленная деградация, а не провал кейса.
        return { skipped: true, reason: `engine rejected sided fields (non-correspondence register?): ${positiveCode}` };
      }
      const negative = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.ЗаведомоНетТакогоПоляДвижений `
          + `ИЗ ${accountingRegister.fullName}.ДвиженияССубконто(&Начало, &Конец) КАК Т`,
        parameters: params,
        limit: 1,
      });
      const negativeCode = negative.error_code || negative.error?.error_code;
      assert(negative.ok === false, "non-existent field must fail");
      assert(negativeCode === "validation_failed_before_run",
        `expected pre-flight rejection for ДвиженияССубконто, got: ${negativeCode}`);
      const availableFields = negative.available_fields || negative.error?.available_fields || [];
      assert(availableFields.some((f) => f.toUpperCase() === "РЕГИСТРАТОР"),
        "available_fields must include Регистратор — the reason this VT exists");
      return { register: accountingRegister.fullName, availableFieldsCount: availableFields.length };
    });

    await this.test("invariant.pre_flight_rejection_never_suggests_rejected_field", async () => {
      // Само-противоречие из отчёта: hint отклонял поле и одновременно предлагал его же
      // как «Возможная замена». Guard в ВариантыПохожихПолей это запрещает: отклонённое
      // поле не должно фигурировать среди предложенных замен, а available_fields не должен
      // содержать его точную (нормализованную) форму.
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const badField = "СуммаРазвернутыйКонечныйОстатокДтНесуществует";
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ост.${badField} `
          + `ИЗ ${accountingRegister.fullName}.ОстаткиИОбороты(&Начало, &Конец) КАК Ост`,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 1,
      });
      const code = result.error_code || result.error?.error_code;
      assert(code === "validation_failed_before_run", `truly-absent field must be pre-flight rejected (got ${code})`);
      const rejected = result.field || result.error?.field;
      const available = result.available_fields || result.error?.available_fields || [];
      const hint = result.hint || result.error?.hint || "";
      const norm = (s) => String(s).trim().toUpperCase();
      assert(!available.some((f) => norm(f) === norm(rejected)),
        "self-consistency: available_fields must NOT contain the rejected field");
      // «Возможная замена: <...>» не должна перечислять само отклонённое поле.
      const replMatch = hint.match(/Возможная замена:\s*(.+?)\.\s*$/);
      const replacements = replMatch ? replMatch[1].split(/\s+или\s+/).map(norm) : [];
      assert(!replacements.includes(norm(rejected)),
        "self-consistency: hint must NOT suggest the rejected field as its own replacement");
      return { register: accountingRegister.fullName, rejected, replacements: replacements.length };
    });

    await this.test("parity.pre_flight_and_metadata_fields_match", async () => {
      // ТЗ F-08: available_fields в pre-flight отказе и common_fields из метаданных
      // строятся одним генератором и должны совпадать для одного источника.
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const meta = await okTool(this.client, "get_metadata_structure", {
        type: accountingRegister.fullName,
        include_virtual_tables: true,
      });
      const metaFields = ((meta.metadata?.register_schema?.virtual_tables || [])
        .find((v) => v.name === "ОборотыДтКт")?.common_fields) || [];
      const rejected = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Обороты.ПолеКоторогоНет ИЗ ${accountingRegister.fullName}.ОборотыДтКт(&Начало, &Конец) КАК Обороты`,
        parameters: {
          Начало: { kind: "datetime", value: CONTRACT_PERIOD.start },
          Конец: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 1,
      });
      const preFlightFields = rejected.available_fields || rejected.error?.available_fields || [];
      assert((rejected.error_code || rejected.error?.error_code) === "validation_failed_before_run", "bad field must be pre-flight rejected");
      assert(metaFields.length > 0 && preFlightFields.length > 0, "both field sets must be non-empty");
      const norm = (a) => [...a].map((x) => x.toUpperCase()).sort().join("|");
      assert(norm(metaFields) === norm(preFlightFields), "F-08: pre-flight available_fields must equal metadata common_fields");
      return { count: preFlightFields.length };
    });

    await this.test("negative.run_1c_query_accumulation_vt_field_rejected_pre_flight", async () => {
      // ТЗ критерий 5 (устранение F5): для регистров накопления pre-flight теперь
      // тоже отсекает несуществующее поле ВТ и отдаёт available_fields.
      const accumulationRegister = this.context.accumulationRegister || await findAccumulationRegister(this.client);
      if (!accumulationRegister) return { skipped: true, reason: "no accumulation register" };
      const meta = await okTool(this.client, "get_metadata_structure", {
        type: accumulationRegister.fullName,
        include_virtual_tables: true,
      });
      const vts = meta.metadata?.register_schema?.virtual_tables || [];
      const target = vts.find((v) => Array.isArray(v.common_fields) && v.common_fields.length > 0
        && (v.name === "Остатки" || v.name === "Обороты" || v.name === "ОстаткиИОбороты"));
      if (!target) return { skipped: true, reason: "accumulation register exposes no balance/turnover VT fields" };
      const paramText = target.name === "Остатки" ? "(&Период)" : "(&Начало, &Конец)";
      const params = target.name === "Остатки"
        ? { Период: { kind: "datetime", value: CONTRACT_PERIOD.end } }
        : { Начало: { kind: "datetime", value: CONTRACT_PERIOD.start }, Конец: { kind: "datetime", value: CONTRACT_PERIOD.end } };
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.ПолеКоторогоТочноНет ИЗ ${accumulationRegister.fullName}.${target.name}${paramText} КАК Т`,
        parameters: params,
        limit: 1,
      });
      const code = result.error_code || result.error?.error_code;
      const availableFields = result.available_fields || result.error?.available_fields || [];
      const sourceTable = result.source_table || result.error?.source_table;
      assert(result.ok === false, "non-existent accumulation VT field must fail");
      assert(code === "validation_failed_before_run", `expected pre-flight rejection for accumulation register, got: ${code}`);
      assert(sourceTable === `${accumulationRegister.fullName}.${target.name}`, `unexpected source_table: ${sourceTable}`);
      assert(availableFields.length > 0, "accumulation VT rejection must expose available_fields (F5 fixed)");
      return { register: accumulationRegister.fullName, vt: target.name, availableFieldsCount: availableFields.length };
    });

    await this.test("negative.run_1c_query_tabular_part_rejected_pre_flight", async () => {
      // ТЗ pre-flight полей/ТЧ, F-01: несуществующая табличная часть в источнике
      // <Вид>.<Имя>.<ИмяТЧ> отсекается ДО движка.
      const fixture = this.context.catalogWithTabular;
      if (!fixture?.tabularSection?.name) return { skipped: true, reason: "no tabular section fixture" };
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка ИЗ ${fixture.full_name}.ТабличнаяЧастьКоторойТочноНет КАК Т`,
        limit: 1,
      });
      const code = result.error_code || result.error?.error_code;
      const topCode = result.error?.code;
      const object = result.object || result.error?.object;
      const parts = result.available_tabular_parts || result.error?.available_tabular_parts || [];
      const platformMessage = result.platform_message || result.error?.platform_message;
      assert(result.ok === false, "non-existent tabular part must fail");
      assert(code === "tabular_part_not_found", `expected tabular_part_not_found, got: ${code}`);
      assert(topCode === "validation_failed_before_run", `error.code must be validation_failed_before_run, got: ${topCode}`);
      assert(object === fixture.full_name, `unexpected object: ${object}`);
      assert(parts.includes(fixture.tabularSection.name), "available_tabular_parts must list the real tabular section");
      assert(!platformMessage, "engine must not be called: platform_message must be absent");
      // stage сервер отдаёт на верхнем уровне ответа И в error: MCP_Tools копирует его
      // туда намеренно (СкопироватьПолеДеталей(Детали, Данные, Ошибка, "stage")), чтобы
      // признак «движок не вызывался» был виден клиенту. Проверка одного лишь
      // error.details.stage не проходила никогда — это и был дефект кейса.
      //
      // Оба контрактных пути проверяются ПОРОЗНЬ и без запасного error.details.stage.
      // Цепочка с фолбэком здесь недопустима: публикация, отдающая stage только по
      // устаревшему пути, прошла бы проверку. Фолбэк оставлен только в smoke-gate,
      // где задача обратная — не завалить гейт на старой публикации.
      assert(result.stage === "validation",
        `top-level stage must be validation, got: ${JSON.stringify(result.stage)}`);
      assert(result.error?.stage === "validation",
        `error.stage must be validation, got: ${JSON.stringify(result.error?.stage)}`);
      return {
        object,
        availableTabularParts: parts.slice(0, 8),
        code,
        stage: result.stage,
        errorStage: result.error?.stage,
      };
    });

    await this.test("negative.run_1c_query_object_field_rejected_pre_flight", async () => {
      // F-02: несуществующее поле обычной таблицы отсекается ДО движка,
      // available_fields заполнен реальным составом.
      const fixture = this.context.genericDocument || this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no document/catalog fixture" };
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Д.ПолеКоторогоТочноНет ИЗ ${fixture.full_name} КАК Д`,
        limit: 1,
      });
      const code = result.error_code || result.error?.error_code;
      const topCode = result.error?.code;
      const availableFields = result.available_fields || result.error?.available_fields || [];
      const source = result.available_fields_source || result.error?.available_fields_source;
      const field = result.field || result.error?.field;
      const platformMessage = result.platform_message || result.error?.platform_message;
      assert(result.ok === false, "non-existent object field must fail");
      assert(code === "field_not_found", `expected field_not_found, got: ${code}`);
      assert(topCode === "validation_failed_before_run", `error.code must be validation_failed_before_run, got: ${topCode}`);
      assert(field === "ПолеКоторогоТочноНет", `unexpected field: ${field}`);
      assert(source === "metadata_object", `available_fields_source must be metadata_object, got: ${source}`);
      assert(availableFields.includes("Ссылка"), "available_fields must include the standard Ссылка attribute");
      assert(!platformMessage, "engine must not be called: platform_message must be absent");
      return { object: fixture.full_name, availableFieldsCount: availableFields.length, code };
    });

    await this.test("regression.run_1c_query_tabular_part_standard_fields_not_rejected", async () => {
      // NF-02: Ссылка и НомерСтроки есть у таблицы любой табличной части, но в
      // интроспекции ТЧ.Реквизиты их нет. Оракул обязан их знать, иначе ложный отказ.
      const fixture = this.context.catalogWithTabular;
      if (!fixture?.tabularSection?.name) return { skipped: true, reason: "no tabular section fixture" };
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка, Т.НомерСтроки ИЗ ${fixture.full_name}.${fixture.tabularSection.name} КАК Т`,
        limit: 1,
      });
      const code = result.error_code || result.error?.error_code;
      assert(code !== "field_not_found" && code !== "validation_failed_before_run",
        `tabular part Ссылка/НомерСтроки must not be pre-flight rejected, got: ${code}`);
      assert(result.ok === true, `valid tabular-part query must succeed: ${JSON.stringify(result.error || {}).slice(0, 400)}`);
      return { table: `${fixture.full_name}.${fixture.tabularSection.name}`, rows: result.rows?.length || 0 };
    });

    await this.test("regression.run_1c_query_accounting_register_fields_not_pre_flight_rejected", async () => {
      // NF-02: у основной таблицы регистра бухгалтерии поля производные по стороне
      // (СуммаДт/СуммаКт, СчетДт/СчетКт, Субконто*), поэтому оракула нет и проверка
      // полей не выполняется. Ложный отказ здесь недопустим.
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Рег.Регистратор, Рег.Период, Рег.СуммаДт ИЗ ${accountingRegister.fullName} КАК Рег`,
        limit: 1,
      });
      const code = result.error_code || result.error?.error_code;
      assert(code !== "validation_failed_before_run",
        `accounting register main-table fields must not be pre-flight rejected, got: ${code}`);
      return { register: accountingRegister.fullName, ok: result.ok === true, code: code || null };
    });

    await this.test("tool.run_1c_query_alias_collides_with_tabular_part_warns", async () => {
      // F-04: псевдоним, совпадающий с именем ТЧ другой таблицы запроса, даёт warning,
      // но НЕ блокирует запрос. Проверяем через validate_1c_query (тот же модуль).
      const fixture = this.context.catalogWithTabular;
      if (!fixture?.tabularSection?.name) return { skipped: true, reason: "no tabular section fixture" };
      const ts = fixture.tabularSection.name;
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 ${ts}.Ссылка ИЗ ${fixture.full_name}.${ts} КАК ${ts} ВНУТРЕННЕЕ СОЕДИНЕНИЕ ${fixture.full_name} КАК Осн ПО ${ts}.Ссылка = Осн.Ссылка`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, `alias collision must warn, not block: ${JSON.stringify(result.errors || [])}`);
      assert((result.warnings || []).some((w) => w.includes("совпадает с именем табличной части")),
        `alias collision warning is missing: ${JSON.stringify(result.warnings || [])}`);
      return { table: fixture.full_name, tabularSection: ts, warnings: result.warnings };
    });

    await this.test("regression.run_1c_query_distinct_aliases_no_collision_warning", async () => {
      // F-04, T3-8/T3-6: при корректных различных псевдонимах предупреждения нет.
      const fixture = this.context.catalogWithTabular;
      if (!fixture?.tabularSection?.name) return { skipped: true, reason: "no tabular section fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 ТЧ.Ссылка ИЗ ${fixture.full_name}.${fixture.tabularSection.name} КАК ТЧ`,
        strict: true,
        explain: true,
      });
      assert(result.valid === true, "single tabular-part source must stay valid");
      assert(!(result.warnings || []).some((w) => w.includes("совпадает с именем табличной части")),
        `no collision warning expected: ${JSON.stringify(result.warnings || [])}`);
      return { table: `${fixture.full_name}.${fixture.tabularSection.name}`, warnings: result.warnings };
    });

    await this.test("tool.run_1c_query_accounting_balance_subconto", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 5 Остатки.Счет, Остатки.Субконто1, Остатки.КоличествоОстаток, Остатки.СуммаОстаток ИЗ ${accountingRegister.fullName}.Остатки(&Период) КАК Остатки`,
        parameters: {
          Период: { kind: "datetime", value: CONTRACT_PERIOD.end },
        },
        limit: 5,
        include_column_types: true,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(columnNames.includes("Субконто1"), "balance query must expose Субконто1");
      assert(columnNames.includes("КоличествоОстаток"), "balance query must expose КоличествоОстаток");
      assert(columnNames.includes("СуммаОстаток"), "balance query must expose СуммаОстаток");
      return { register: accountingRegister.fullName, columns: columnNames, rows: result.rows?.length || 0 };
    });

    await this.test("tool.run_1c_query_zero_row_subconto_position_warning", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      // Нулевая выборка задаётся пустым списком счетов в ПАРАМЕТРАХ ВТ, а не отбором
      // во внешнем ГДЕ: отбор по счёту в ГДЕ нарушает §2 стандартов и отклоняется
      // правилом vt_filter_in_external_where. Прежняя форма «ГДЕ Остатки.Счет.Код = &Код»
      // вдобавок разыменовывала счёт, что в параметрах ВТ запрещено, поэтому простой
      // перенос условия не подошёл бы — нужен именно пустой массив ссылок.
      //
      // Пустой массив здесь — требование самого кейса (нужны ровно нулевые строки), и он
      // НЕ покрывает список счетов, который сервер собирает сам: пустой список — как раз
      // единственная форма, при которой сериализация ссылок в параметрах ВТ не проявляется.
      // За непустой внутренний список отвечают tool.get_inventory_balances_by_item,
      // tool.get_accounting_balances_by_subconto_age и tool.compare_accounting_balances_by_subconto.
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Остатки.Счет, Остатки.Субконто1 ИЗ ${accountingRegister.fullName}.Остатки(&Период, Счет В (&ПустойСписокСчетов), , ) КАК Остатки`,
        parameters: {
          Период: { kind: "datetime", value: CONTRACT_PERIOD.end },
          ПустойСписокСчетов: { kind: "array", value: [] },
        },
        limit: 1,
      });
      assert(result.row_count === 0, "fixture query must return zero rows");
      assert((result.warnings || []).some((item) => String(item).includes("позиция субконто")), "zero-row accounting subconto query must warn about subconto position");
      assert(!Array.isArray(result.query_guidance), "position warning must not force query_guidance");
      return { register: accountingRegister.fullName, warnings: result.warnings };
    });
  }

  async referenceTests() {
    await this.test("tool.search_objects_returns_structured_refs", async () => {
      const ref = this.context.sampleRef || this.context.organizationRef || this.context.counterpartyRef;
      if (!ref?.type) return { skipped: true, reason: "no sample reference fixture" };
      const query = String(ref.presentation || "").trim();
      if (!query) return { skipped: true, reason: "sample reference has empty presentation" };
      const result = await okTool(this.client, "search_objects", {
        query,
        types: [ref.type],
        limit: 3,
        include_fields: [],
      });
      if (!result.matches?.length) {
        return { skipped: true, reason: "sample reference presentation is not searchable for this type", query, type: ref.type };
      }
      assertRef(result.matches[0].ref, "search_objects ref");
      this.context.counterpartyRef ||= result.matches[0].ref;
      return { matches: result.matches.length, first: result.matches[0].ref };
    });

    await this.test("tool.get_object_by_ref_with_tabular_section", async () => {
      const ref = requireContextRef(this.context.counterpartyRef || this.context.sampleRef, "counterpartyRef/sampleRef");
      const fixture = this.context.catalogWithTabular;
      const wantsTabular = fixture?.full_name === ref.type && fixture?.tabularSection?.name;
      const result = await okTool(this.client, "get_object_by_ref", {
        type: ref.type,
        uuid: ref.uuid,
        fields: [],
        include_standard_fields: true,
        include_tabular_sections: Boolean(wantsTabular),
        tabular_sections: wantsTabular ? [fixture.tabularSection.name] : [],
        tabular_section_row_limit: 5,
      });
      assert(result.found === true, "object must be found");
      assertRef(result.object?.ref, "get_object_by_ref object.ref");
      if (wantsTabular) {
        assert(result.object?.tabular_sections?.[fixture.tabularSection.name], "fixture tabular section must be returned");
      }
      return {
        ref: result.object.ref,
        fields: Object.keys(result.object.fields || {}),
        tabularSections: Object.keys(result.object.tabular_sections || {}),
      };
    });

    await this.test("tool.find_object_by_id", async () => {
      const ref = requireContextRef(this.context.counterpartyRef || this.context.sampleRef, "counterpartyRef/sampleRef");
      const result = await okTool(this.client, "find_object_by_id", {
        uuid: ref.uuid,
        types: [ref.type],
        limit: 5,
      });
      assert(result.found === true, "find_object_by_id must find the object");
      assertRef(result.matches?.[0]?.ref, "find_object_by_id match ref");
      return { searchedTypes: result.searched_types_count, matches: result.matches.length };
    });

    await this.test("tool.get_link_of_object", async () => {
      const ref = requireContextRef(this.context.counterpartyRef || this.context.sampleRef, "counterpartyRef/sampleRef");
      const result = await okTool(this.client, "get_link_of_object", {
        type: ref.type,
        uuid: ref.uuid,
        link_type: "auto",
        include_presentation: true,
      });
      assert(result.found === true, "get_link_of_object must find the object");
      assertRef(result.ref, "get_link_of_object ref");
      assert((result.links || []).some((link) => link.type === "e1cib"), "e1cib link must be present");
      return { links: result.links };
    });

    await this.test("tool.find_references_to_object", async () => {
      const ref = requireContextRef(this.context.organizationRef || this.context.counterpartyRef || this.context.sampleRef, "organizationRef/counterpartyRef/sampleRef");
      const result = await okTool(this.client, "find_references_to_object", {
        target: { type: ref.type, uuid: ref.uuid },
        max_types: 3,
        limit_per_type: 2,
        include_samples: true,
      });
      assertRef(result.target, "find_references_to_object target");
      assert(Array.isArray(result.references), "references must be an array");
      return { groups: result.references.length, searchedTypes: result.searched_types_count, truncated: result.truncated };
    });

    await this.test("tool.get_object_history_graceful", async () => {
      const ref = requireContextRef(this.context.counterpartyRef || this.context.sampleRef, "counterpartyRef/sampleRef");
      const result = await okTool(this.client, "get_object_history", {
        target: { type: ref.type, uuid: ref.uuid },
        mode: "auto",
        limit: 5,
      });
      assertRef(result.target, "get_object_history target");
      assert(Array.isArray(result.events), "events must be an array");
      assert(result.capabilities, "capabilities must be present");
      return { supported: result.supported, events: result.events.length, capabilities: result.capabilities };
    });
  }

  async registerTests() {
    await this.test("tool.get_enum_values", async () => {
      const enumType = this.context.enumType;
      if (!enumType) return { skipped: true, reason: "no enum fixture" };
      const result = await okTool(this.client, "get_enum_values", {
        type: enumType.full_name,
        include_empty: true,
        include_order: true,
        limit: 10,
      });
      assert(Array.isArray(result.values), "enum values must be an array");
      return { values: result.values.map((item) => item.name) };
    });

    await this.test("tool.get_register_records_records_mode", async () => {
      const fixture = this.context.infoRegister;
      if (!fixture) return { skipped: true, reason: "no information register fixture" };
      const result = await okTool(this.client, "get_register_records", {
        register_type: "РегистрСведений",
        register: fixture.name,
        mode: "records",
        limit: 2,
      });
      assert(result.register === fixture.full_name, "unexpected register name");
      assert(Array.isArray(result.rows), "register rows must be an array");
      return { rows: result.rows.length, truncated: result.truncated, nextCursor: result.next_cursor };
    });

    await this.test("tool.get_register_records_accounting_debit_credit_mode", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers_debit_credit",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        dimensions: ["СчетДт", "СчетКт", "СубконтоДт1", "СубконтоКт1"],
        resources: ["СуммаОборот"],
        include_column_types: true,
        limit: 1,
      });
      const columnNames = (result.columns || []).map((item) => item.name);
      assert(result.register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.mode === "turnovers_debit_credit", "unexpected accounting register mode");
      assert(columnNames.includes("СубконтоДт1"), "get_register_records must expose СубконтоДт1");
      assert(columnNames.includes("СубконтоКт1"), "get_register_records must expose СубконтоКт1");
      return { register: accountingRegister.fullName, columns: columnNames, rows: result.rows?.length || 0, queryUsed: result.query_used };
    });

    await this.test("tool.get_register_records_accounting_debit_credit_filter", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const sample = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers_debit_credit",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        dimensions: ["СчетДт", "СчетКт"],
        resources: ["СуммаОборот"],
        limit: 1,
      });
      const account = sample.rows?.[0]?.СчетДт;
      if (!account?.type || !account?.uuid) {
        return { skipped: true, reason: "no debit-credit turnover rows with account ref", register: accountingRegister.fullName };
      }
      const result = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers_debit_credit",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        filters: { СчетДт: toQueryRef(account) },
        dimensions: ["СчетДт", "СчетКт"],
        resources: ["СуммаОборот"],
        include_query: true,
        limit: 5,
      });
      assert(result.query_used?.includes("ГДЕ СчетДт = &Filter_СчетДт"), "accounting debit-credit filter must be emitted as WHERE");
      assert(!result.query_used?.includes("ОборотыДтКт(&ПериодНачало, &ПериодКонец,"), "filter must not be injected into ОборотыДтКт parameter slots");
      for (const row of result.rows || []) {
        assert(row.СчетДт?.uuid === account.uuid, "filtered debit account must match requested account");
      }
      return { register: accountingRegister.fullName, account: account.presentation, rows: result.rows?.length || 0, queryUsed: result.query_used };
    });

    await this.test("tool.get_register_records_accounting_turnovers_filter", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const sample = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        dimensions: ["Счет"],
        resources: ["СуммаОборот"],
        limit: 1,
      });
      const account = sample.rows?.[0]?.Счет;
      if (!account?.type || !account?.uuid) {
        return { skipped: true, reason: "no accounting turnover rows with account ref", register: accountingRegister.fullName };
      }
      const turnovers = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "turnovers",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        filters: { Счет: toQueryRef(account) },
        dimensions: ["Счет"],
        resources: ["СуммаОборот"],
        include_query: true,
        limit: 5,
      });
      assert(turnovers.query_used?.includes("ГДЕ Счет = &Filter_Счет"), "accounting turnovers filter must be emitted as WHERE");
      assert(!turnovers.query_used?.includes("Обороты(&ПериодНачало, &ПериодКонец,"), "filter must not be injected into Обороты parameter slots");
      for (const row of turnovers.rows || []) {
        assert(row.Счет?.uuid === account.uuid, "filtered turnover account must match requested account");
      }
      const balanceAndTurnovers = await okTool(this.client, "get_register_records", {
        register_type: "РегистрБухгалтерии",
        register: accountingRegister.name,
        mode: "balance_and_turnovers",
        period_from: { kind: "datetime", value: CONTRACT_PERIOD.start },
        period_to: { kind: "datetime", value: CONTRACT_PERIOD.end },
        filters: { Счет: toQueryRef(account) },
        dimensions: ["Счет"],
        resources: ["СуммаОборот"],
        include_query: true,
        limit: 5,
      });
      assert(balanceAndTurnovers.query_used?.includes("ГДЕ Счет = &Filter_Счет"), "accounting balance-and-turnovers filter must be emitted as WHERE");
      assert(!balanceAndTurnovers.query_used?.includes("ОстаткиИОбороты(&ПериодНачало, &ПериодКонец,"), "filter must not be injected into ОстаткиИОбороты parameter slots");
      for (const row of balanceAndTurnovers.rows || []) {
        assert(row.Счет?.uuid === account.uuid, "filtered account must match requested account");
      }
      return {
        register: accountingRegister.fullName,
        account: account.presentation,
        turnoversRows: turnovers.rows?.length || 0,
        balanceAndTurnoversRows: balanceAndTurnovers.rows?.length || 0,
        turnoversQueryUsed: turnovers.query_used,
        balanceAndTurnoversQueryUsed: balanceAndTurnovers.query_used,
      };
    });

    await this.test("tool.get_accounting_balances", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const result = await okTool(this.client, "get_accounting_balances", {
        accounting_register: accountingRegister.name,
        mode: "balance",
        period: { kind: "datetime", value: CONTRACT_PERIOD.end },
        dimensions: ["Счет"],
        resources: ["Сумма"],
        limit: 2,
      });
      assert(result.accounting_register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.mode === "balance", "unexpected accounting balance mode");
      assert(Array.isArray(result.rows), "accounting balance rows must be an array");
      assert("truncated" in result, "truncated flag must be present");
      return { register: accountingRegister.fullName, rows: result.rows.length, truncated: result.truncated };
    });

    await this.test("tool.get_accounting_balances_by_subconto_age", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const map = await okTool(this.client, "get_accounting_accounts_map", {
        account_code_prefix: "62",
        include_empty_subconto: false,
        limit: 20,
      });
      const accountWithSettlementDoc = (map.accounts || []).find((account) =>
        (account.subconto || []).some((item) => item.position === 1)
        && (account.subconto || []).some((item) => item.position === 3)
      );
      if (!accountWithSettlementDoc) {
        return { skipped: true, reason: "no 62 account with subconto positions 1 and 3" };
      }
      const subcontoKinds = (accountWithSettlementDoc.subconto || [])
        .sort((left, right) => left.position - right.position)
        .map((item) => item.name);
      const result = await okTool(this.client, "get_accounting_balances_by_subconto_age", {
        accounting_register: accountingRegister.name,
        as_of: CONTRACT_PERIOD.end,
        account_code_prefixes: ["62"],
        balance_side: "debit",
        subconto_kinds: subcontoKinds,
        group_subconto_index: 1,
        age_subconto_index: 3,
        age_buckets: [90, 180, 365],
        limit: 5,
        include_query: true,
      });
      assert(result.accounting_register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.configuration_agnostic === true, "aging tool must be configuration agnostic");
      assert(Array.isArray(result.bucket_rows), "aging bucket_rows must be an array");
      assert(Array.isArray(result.rows), "aging rows must be an array");
      assert(result.query_used?.detail?.includes(".Остатки("), "aging detail query must use Остатки");
      return { register: accountingRegister.fullName, rows: result.rows.length, buckets: result.bucket_rows.length };
    });

    await this.test("tool.compare_accounting_balances_by_subconto", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const map = await okTool(this.client, "get_accounting_accounts_map", {
        account_code_prefix: "62",
        include_empty_subconto: false,
        limit: 20,
      });
      const accountWithCounterparty = (map.accounts || []).find((account) =>
        (account.subconto || []).some((item) => item.position === 1)
      );
      if (!accountWithCounterparty) {
        return { skipped: true, reason: "no 62 account with counterparty subconto" };
      }
      const subcontoKinds = (accountWithCounterparty.subconto || [])
        .sort((left, right) => left.position - right.position)
        .map((item) => item.name);
      const result = await okTool(this.client, "compare_accounting_balances_by_subconto", {
        accounting_register: accountingRegister.name,
        as_of: CONTRACT_PERIOD.end,
        subconto_kinds: subcontoKinds,
        match_subconto_index: 1,
        left_account_code_prefixes: ["62"],
        left_balance_side: "debit",
        right_account_code_prefixes: ["60"],
        right_balance_side: "credit",
        limit: 5,
        include_query: true,
      });
      assert(result.accounting_register === accountingRegister.fullName, "unexpected accounting register name");
      assert(result.configuration_agnostic === true, "compare tool must be configuration agnostic");
      assert(Array.isArray(result.rows), "compare rows must be an array");
      assert(result.query_used?.includes("ВТ_ЛевыеОстатки"), "compare query must use temporary left table");
      return { register: accountingRegister.fullName, rows: result.rows.length };
    });

    // Третий инструмент, собирающий список счетов внутри сервера и отдающий его в
    // позицию условия по счёту ВТ. До этого кейса он не вызывался ни одним тестом —
    // имя было только в EXPECTED_TOOLS, поэтому его отказ на непустом списке ссылок
    // оставался невидимым. Попутно кейс покрывает саму форму «Счет В (непустой массив)»:
    // единственная другая проба этой формы в наборе передаёт ПУСТОЙ массив, а он
    // проходит и при сломанной сборке списка.
    await this.test("tool.get_inventory_balances_by_item", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) {
        return { skipped: true, reason: "no accounting register in metadata" };
      }
      const map = await okTool(this.client, "get_accounting_accounts_map", {
        account_code_prefix: "41",
        include_empty_subconto: false,
        limit: 20,
      });
      // В список идут ВСЕ подходящие счёта префикса, а не первый: у счёта-группы
      // (41) остатков не бывает — они лежат на субсчетах (41.01…), и проба по одной
      // группе давала 0 строк, из-за чего кейс уходил в skipped. Пропуск выглядит как
      // успех, поэтому здесь он допустим только когда в базе действительно нет
      // товарных остатков.
      const candidates = (map.accounts || []).filter((account) =>
        (account.subconto || []).some((item) => item.position === 1)
        && (account.subconto || []).some((item) => item.position === 2)
      );
      if (candidates.length === 0) {
        return { skipped: true, reason: "no 41 account with subconto positions 1 and 2" };
      }

      // Товар подбирается discovery по остаткам самих счетов, а не именем: имя
      // номенклатуры конфигурационно-зависимо. Заодно это проба формы
      // «Счет В (&Список)» с НЕПУСТЫМ массивом ссылок — той, на которой инструменты
      // и падали, пока список собирался из сериализованных значений.
      const probe = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Остатки.Счет КАК Счет, Остатки.Субконто1 КАК Товар`
          + ` ИЗ ${accountingRegister.fullName}.Остатки(&Период, Счет В (&СписокСчетов), &ВидыСубконто, ) КАК Остатки`,
        parameters: {
          Период: { kind: "datetime", value: CONTRACT_PERIOD.end },
          СписокСчетов: {
            kind: "array",
            value: candidates.map((account) => ({ kind: "ref", type: account.account.type, uuid: account.uuid })),
          },
          // Виды субконто берутся у первого кандидата: параметр переиндексирует поля
          // Субконто1/2 по порядку массива, поэтому позиции у остальных счетов из
          // выборки совпадут с этим порядком.
          ВидыСубконто: {
            kind: "array",
            value: (candidates[0].subconto || [])
              .sort((left, right) => left.position - right.position)
              .map((item) => ({ kind: "ref", type: item.ref.type, uuid: item.ref.uuid })),
          },
        },
        limit: 1,
      });
      const item = probe.rows?.[0]?.Товар;
      if (!item?.uuid || !item?.type) {
        return {
          skipped: true,
          reason: "no inventory balance rows to take an item from",
          accounts: candidates.map((account) => account.code),
        };
      }

      // Счёт из строки остатков определяет, чьи имена видов субконто передавать:
      // у разных субсчетов порядок аналитик может отличаться.
      const balanceAccount = candidates.find((account) => account.uuid === probe.rows[0].Счет?.uuid) || candidates[0];
      const byPosition = (position) => (balanceAccount.subconto || []).find((item) => item.position === position);

      const result = await okTool(this.client, "get_inventory_balances_by_item", {
        accounting_register: accountingRegister.name,
        as_of: CONTRACT_PERIOD.end,
        account_code_prefixes: [balanceAccount.code],
        item_ref: { type: item.type, uuid: item.uuid },
        item_subconto_name: byPosition(1)?.name,
        warehouse_subconto_name: byPosition(2)?.name,
        include_zero: true,
        limit: 5,
        include_query: true,
      });
      assert(Array.isArray(result.rows), "inventory rows must be an array");
      assert(result.configuration_agnostic === true, "inventory tool must be configuration agnostic");
      assert(Array.isArray(result.account_code_prefixes) && result.account_code_prefixes.length > 0,
        "inventory tool must report the account prefixes it used");
      assert(String(result.query_used || "").includes(".Остатки("), "inventory query must use Остатки");
      // Регресс-страховка ровно на дефект #79: список счетов уходит в параметры ВТ, и
      // если он снова окажется сериализованным, okTool выше не пропустит «Неверные
      // параметры».
      assert(String(result.query_used || "").includes("&СписокСчетов"),
        "inventory query must filter accounts through virtual table parameters");
      return {
        register: accountingRegister.fullName,
        account: balanceAccount.code,
        subcontoKinds: (balanceAccount.subconto || [])
          .sort((left, right) => left.position - right.position)
          .map((subconto) => subconto.name),
        rows: result.rows.length,
        prefixes: result.account_code_prefixes,
      };
    });

    await this.test("tool.get_register_records_bad_mode_is_diagnostic", async () => {
      const fixture = this.context.infoRegister;
      if (!fixture) return { skipped: true, reason: "no information register fixture" };
      const result = await rawTool(this.client, "get_register_records", {
        register_type: "РегистрСведений",
        register: fixture.name,
        mode: "balance",
        period: "2026-05-13T00:00:00",
        limit: 1,
      });
      assert(result.ok === false, "bad register mode must return ok=false");
      assert(result.error?.code === "register_mode_not_supported", `unexpected error code: ${result.error?.code}`);
      return { error: result.error };
    });
  }

  async documentTests() {
    await this.test("fixture.query_document_with_movements", async () => {
      const fixture = this.context.genericDocument;
      if (!fixture) return { skipped: true, reason: "no document fixture" };
      const result = await okTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка, УникальныйИдентификатор(Ссылка) КАК UUID ИЗ ${fixture.full_name}`,
        limit: 1,
        include_column_types: true,
      });
      const row = result.rows?.[0];
      if (!row) return { skipped: true, reason: "document fixture has no rows", document: fixture.full_name };
      assertRef(row.Ссылка, "document query ref");
      this.context.documentRef = row.Ссылка;
      return { ref: row.Ссылка };
    });

    await this.test("tool.get_document_movements", async () => {
      const ref = this.context.documentRef;
      if (!ref) return { skipped: true, reason: "no document row fixture" };
      const result = await okTool(this.client, "get_document_movements", {
        document_type: ref.type,
        uuid: ref.uuid,
        row_limit_per_register: 2,
        include_empty_registers: false,
      });
      assert(result.found === true, "document movements target must be found");
      assertRef(result.document, "get_document_movements document");
      assert(Array.isArray(result.movements), "movements must be an array");
      return { registers: result.movements.map((item) => item.register), truncated: result.truncated };
    });
  }

  async reportTests() {
    await this.test("tool.list_reports", async () => {
      const result = await okTool(this.client, "list_reports", {
        query: "Анализ",
        include_variants: true,
        include_guidance: true,
        limit: 5,
      });
      assert(result.reports?.length > 0, "expected reports");
      assert(hasInteractionHint(result, "report_or_direct_query_choice"), "report discovery must include report-or-query interaction hint");
      const report = result.reports[0];
      assert(report.type?.startsWith("Отчет."), "report type must be full metadata name");
      assert(typeof report.has_custom_pre_compose === "boolean", "report must expose has_custom_pre_compose flag");
      this.context.reportType = report.type;
      this.context.reportVariant = report.variants?.[0]?.name || "Основной";
      return { reports: result.reports.map((item) => item.type), firstVariant: this.context.reportVariant };
    });

    await this.test("tool.get_report_info", async () => {
      const report = this.context.reportType;
      if (!report) return { skipped: true, reason: "no report fixture" };
      const result = await okTool(this.client, "get_report_info", {
        report,
        include_schema: true,
        include_variants: true,
        include_default_settings: true,
      });
      assert(result.report === report, "report_info returned different report");
      assert(Array.isArray(result.variants), "variants must be an array");
      assert(Array.isArray(result.parameters), "parameters must be an array");
      assert(typeof result.has_custom_pre_compose === "boolean", "report_info must expose has_custom_pre_compose flag");
      assert(typeof result.report_parameter_source === "string", "report_info must expose report_parameter_source");
      if (result.parameters.length > 0) {
        assert("name" in result.parameters[0], "report parameter must include name");
        assert("type" in result.parameters[0] || "type_description" in result.parameters[0], "report parameter must include type");
      }
      return { report: result.report, variants: result.variants };
    });

    await this.test("tool.run_1c_report_graceful", async () => {
      const report = this.context.reportType;
      if (!report) return { skipped: true, reason: "no report fixture" };
      const variant = this.context.reportVariant || "Основной";
      const result = await okTool(this.client, "run_1c_report", {
        report,
        variant,
        output_format: "table",
        limit: 3,
        timeout_seconds: 30,
        include_parameters_used: true,
      });
      assert(result.report === report, "run_1c_report returned different report");
      assert("execution_supported" in result, "execution_supported must be present");
      assert(result.parameters_used && typeof result.parameters_used === "object", "parameters_used must be present");
      assert("pre_compose_applied" in result || result.execution_supported === false, "pre_compose_applied must be present for supported report execution");
      assert(Array.isArray(result.rows), "rows must be an array even when unsupported");
      return {
        report: result.report,
        executionSupported: result.execution_supported,
        rows: result.rows.length,
        warnings: result.warnings || [],
      };
    });
  }

  async negativeTests() {
    await this.test("negative.validate_missing_metadata_is_invalid", async () => {
      const result = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Объект ИЗ РегистрСведений.MCP_НесуществующийРегистр",
        strict: true,
        explain: true,
      });
      assert(result.valid === false, `validate must reject missing metadata, got valid=true with detected=${JSON.stringify(result.detected_objects)}`);
      assert((result.errors || []).some((error) => error.code === "metadata_not_found"), `metadata_not_found error is missing: ${JSON.stringify(result.errors)}`);
      return { errors: result.errors };
    });

    await this.test("negative.run_missing_metadata_is_diagnostic", async () => {
      const result = await rawTool(this.client, "run_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Объект ИЗ РегистрСведений.MCP_НесуществующийРегистр",
        limit: 1,
      });
      assert(result.ok === false, "missing metadata query must fail");
      const parsedDetails = result.error?.details?.parsed_details;
      const validationDetails = Array.isArray(parsedDetails) ? parsedDetails : [];
      const hasMetadataNotFound = validationDetails.some((error) => error.code === "metadata_not_found")
        || result.error?.details?.raw_exception?.includes("metadata_not_found");
      const hasExecutionDiagnostic = result.error?.message?.includes("Таблица не найдена")
        || result.error?.details?.raw_exception?.includes("Таблица не найдена");
      assert(hasMetadataNotFound || hasExecutionDiagnostic, "must include missing-metadata or table-not-found diagnostics");
      return { errorCode: result.error?.code, message: result.error?.message, parsedDetails };
    });

    await this.test("negative.run_validate_before_run_false_is_ignored", async () => {
      const result = await rawTool(this.client, "run_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Объект ИЗ РегистрСведений.MCP_НесуществующийРегистр",
        validate_before_run: false,
        limit: 1,
      });
      assert(result.ok === false, "invalid query must fail even with validate_before_run=false");
      assert(result.error?.code === "query_validation_failed", `unexpected error code: ${result.error?.code}`);
      const parsedDetails = result.error?.details?.parsed_details;
      const validationDetails = Array.isArray(parsedDetails) ? parsedDetails : [];
      assert(validationDetails.some((error) => error.code === "metadata_not_found")
        || result.error?.details?.raw_exception?.includes("metadata_not_found"), "validation diagnostics must be present");
      return { errorCode: result.error?.code, parsedDetails };
    });

    await this.test("negative.validate_forbidden_keyword", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ Ссылка ИЗ ${fixture.full_name} ДЛЯ ИЗМЕНЕНИЯ`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "forbidden keyword query must be invalid");
      assert((result.errors || []).some((error) => error.code === "forbidden_keyword"), "forbidden_keyword error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.validate_invalid_imeya_keyword", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 10 Объект.Ссылка КАК Ссылка, КОЛИЧЕСТВО(Объект.Ссылка) КАК Количество ИЗ ${fixture.full_name} КАК Объект СГРУППИРОВАТЬ ПО Объект.Ссылка ИМЕЯ КОЛИЧЕСТВО(Объект.Ссылка) > 0`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "ИМЕЯ query must be invalid");
      assert((result.errors || []).some((error) => error.code === "invalid_1c_query_keyword"), "invalid_1c_query_keyword error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.get_accounting_entries_rejects_subconto_value_without_kind", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      const fixture = this.context.genericCatalog || this.context.genericDocument;
      if (!accountingRegister || !fixture) {
        return { skipped: true, reason: "no accounting register or reference fixture" };
      }
      const ref = await firstRefFromType(this.client, fixture.full_name);
      if (!ref) return { skipped: true, reason: "no reference row" };
      const result = await rawTool(this.client, "get_accounting_entries", {
        accounting_register: accountingRegister.name,
        subconto_side: "debit",
        subconto_value: toQueryRef(ref),
        limit: 5,
      });
      assert(result.ok === false, "subconto_value without subconto_kind must fail");
      assert(result.error?.code === "invalid_arguments", `unexpected code: ${result.error?.code}`);
      assert(String(result.error?.message || "").includes("subconto_kind"), "error must point to subconto_kind");
      return { error: result.error };
    });

    await this.test("negative.run_main_register_subconto_dtkt_is_smart_error", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const result = await rawTool(this.client, "run_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Хозрасчетный.СубконтоДт1 КАК Субконто ИЗ ${accountingRegister.fullName} КАК Хозрасчетный`,
        limit: 1,
      });
      assert(result.ok === false, "main accounting register СубконтоДт1 run must fail");
      assert(result.error_code === "subconto_wrong_table" || result.error?.error_code === "subconto_wrong_table", `smart error_code is missing: ${JSON.stringify(result)}`);
      assert((result.hint || result.error?.hint || "").includes("Субконто"), "smart hint must mention Субконто");
      assert((result.see_also || result.error?.see_also || "").includes(".Субконто"), "see_also must point to .Субконто table");
      assert(Array.isArray(result.validation_errors || result.error?.validation_errors), "validation_errors must be present");
      return { errorCode: result.error_code || result.error?.error_code, hint: result.hint || result.error?.hint };
    });

    await this.test("negative.validate_rejects_accounting_balance_vt_deref_params", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      if (!accountingRegister) return { skipped: true, reason: "no accounting register" };
      const query = `ВЫБРАТЬ ПЕРВЫЕ 1 Остатки.Счет КАК Счет ИЗ ${accountingRegister.fullName}.Остатки(&Дата, СчетДт.Код ПОДОБНО "01%") КАК Остатки`;
      const validation = await okTool(this.client, "validate_1c_query", {
        query,
        parameters: { Дата: { kind: "datetime", value: CONTRACT_PERIOD.end } },
        strict: true,
        explain: true,
      });
      assert(validation.valid === false, "Остатки virtual table params with dotted field dereference must be invalid");
      assert((validation.errors || []).some((error) => error.code === "vt_param_field_error"), `vt_param_field_error is missing: ${JSON.stringify(validation.errors)}`);

      const run = await rawTool(this.client, "run_1c_query", {
        query,
        parameters: { Дата: { kind: "datetime", value: CONTRACT_PERIOD.end } },
        validate_before_run: false,
        limit: 1,
      });
      assert(run.ok === false, "run_1c_query must fail before execution for invalid Остатки params");
      assert(run.error?.code === "query_validation_failed", `unexpected run error code: ${run.error?.code}`);
      return { validationErrors: validation.errors, runErrorCode: run.error?.code };
    });

    // issue #62: имя типа после ССЫЛКА и внутри ТИП(...) — не разыменование поля.
    await this.test("positive.validate_vt_param_type_check_forms", async () => {
      const accountingRegister = this.context.accountingRegister || await findAccountingRegister(this.client);
      const catalog = this.context.genericCatalog;
      if (!accountingRegister || !catalog) return { skipped: true, reason: "no accounting register or catalog fixture" };
      const forms = {
        refs: `Субконто1 ССЫЛКА ${catalog.full_name}`,
        type: `ТИПЗНАЧЕНИЯ(Субконто1) = ТИП(${catalog.full_name})`,
      };
      const checked = {};
      for (const [name, condition] of Object.entries(forms)) {
        // Условие по значению — в последней позиции (§2), не в позиции условия по счёту.
        const query = `ВЫБРАТЬ ПЕРВЫЕ 1 Данные.Счет КАК Счет `
          + `ИЗ ${accountingRegister.fullName}.Остатки(&Дата, , , ${condition}) КАК Данные`;
        const validation = await okTool(this.client, "validate_1c_query", {
          query,
          parameters: { Дата: { kind: "datetime", value: CONTRACT_PERIOD.end } },
          strict: true,
          explain: true,
        });
        assert(!(validation.errors || []).some((error) => error.code === "vt_param_field_error"),
          `${name}: имя типа принято за разыменование: ${JSON.stringify(validation.errors)}`);
        checked[name] = validation.valid;
      }
      return checked;
    });

    // issue #60: запятая в составном ИНДЕКСИРОВАТЬ ПО — не разделитель источников.
    await this.test("positive.validate_composite_index_by", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      // Только стандартные реквизиты: фикстура гарантирует supports_ref, но не Код/Наименование.
      const query = `ВЫБРАТЬ Источник.Ссылка КАК Ссылка, Источник.ПометкаУдаления КАК ПометкаУдаления `
        + `ПОМЕСТИТЬ ВТСоставнойИндекс ИЗ ${fixture.full_name} КАК Источник `
        + `ИНДЕКСИРОВАТЬ ПО Ссылка, ПометкаУдаления; `
        + `ВЫБРАТЬ ПЕРВЫЕ 1 ВТСоставнойИндекс.Ссылка ИЗ ВТСоставнойИндекс КАК ВТСоставнойИндекс`;
      const result = await okTool(this.client, "validate_1c_query", { query, strict: true, explain: true });
      assert(!(result.errors || []).some((error) => error.code === "unknown_query_source"),
        `второе поле составного индекса принято за источник: ${JSON.stringify(result.errors)}`);
      assert(result.valid === true, `composite index query must be valid: ${JSON.stringify(result.errors)}`);
      return { valid: result.valid };
    });

    // issue #60, защита: настоящий неизвестный источник после ИЗ по-прежнему отклоняется.
    await this.test("negative.validate_unknown_source_still_rejected", async () => {
      const result = await okTool(this.client, "validate_1c_query", {
        query: "ВЫБРАТЬ ПЕРВЫЕ 1 Т.Код КАК Код ИЗ НеобъявленнаяТаблицаКонтрактногоТеста КАК Т",
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "unknown source must stay invalid");
      assert((result.errors || []).some((error) => error.code === "unknown_query_source"),
        `unknown_query_source is missing: ${JSON.stringify(result.errors)}`);
      return { errors: result.errors };
    });

    // issue #61: DROP — англ. эквивалент УНИЧТОЖИТЬ, а не признак DDL.
    await this.test("positive.validate_drop_temp_table", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const body = (destroy) => `ВЫБРАТЬ Источник.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТПервая ИЗ ${fixture.full_name} КАК Источник; `
        + "ВЫБРАТЬ ВТПервая.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТВторая ИЗ ВТПервая КАК ВТПервая; "
        + `${destroy} ВТПервая; `
        + "ВЫБРАТЬ ПЕРВЫЕ 1 ВТВторая.Ссылка ИЗ ВТВторая КАК ВТВторая";
      const cyrillic = await okTool(this.client, "validate_1c_query", { query: body("УНИЧТОЖИТЬ"), strict: true, explain: true });
      assert(cyrillic.valid === true, `УНИЧТОЖИТЬ form must be valid: ${JSON.stringify(cyrillic.errors)}`);
      const english = await okTool(this.client, "validate_1c_query", { query: body("DROP"), strict: true, explain: true });
      assert(!(english.errors || []).some((error) => error.code === "forbidden_keyword"),
        `DROP must not be a forbidden keyword: ${JSON.stringify(english.errors)}`);
      assert(english.valid === true, `DROP form must be valid: ${JSON.stringify(english.errors)}`);
      return { cyrillic: cyrillic.valid, english: english.valid };
    });

    // issue #61, защита: уничтожение чего-либо кроме объявленной ВТ отклоняется.
    await this.test("negative.validate_drop_non_temp_table", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ Источник.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТПервая ИЗ ${fixture.full_name} КАК Источник; `
          + `DROP TABLE ${fixture.full_name}; `
          + "ВЫБРАТЬ ПЕРВЫЕ 1 ВТПервая.Ссылка ИЗ ВТПервая КАК ВТПервая",
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "DROP of a non-temporary table must stay invalid");
      assert((result.errors || []).some((error) => error.code === "drop_target_not_temporary_table"),
        `drop_target_not_temporary_table is missing: ${JSON.stringify(result.errors)}`);
      return { errors: result.errors };
    });

    await this.test("negative.validate_plain_batch_without_temp_tables", async () => {
      const first = this.context.genericCatalog;
      const second = this.context.genericDocument || this.context.catalogWithTabular || first;
      if (!first || !second) return { skipped: true, reason: "not enough query fixtures" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ ${first.full_name}; ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ ${second.full_name}`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "plain batch query without temp tables must be invalid");
      assert((result.errors || []).some((error) => error.code === "batch_query_forbidden"), "batch_query_forbidden error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.validate_temp_table_without_final_select", async () => {
      const fixture = this.context.genericCatalog;
      if (!fixture) return { skipped: true, reason: "no generic catalog fixture" };
      const result = await okTool(this.client, "validate_1c_query", {
        query: `ВЫБРАТЬ ПЕРВЫЕ 1 Объект.Ссылка КАК Ссылка ПОМЕСТИТЬ ВТОбъекты ИЗ ${fixture.full_name} КАК Объект`,
        strict: true,
        explain: true,
      });
      assert(result.valid === false, "temp table query without final SELECT must be invalid");
      assert((result.errors || []).some((error) => error.code === "temporary_table_package_required"), "temporary_table_package_required error is missing");
      return { errors: result.errors };
    });

    await this.test("negative.get_object_by_ref_bad_uuid", async () => {
      const fixture = this.context.genericCatalog || this.context.genericDocument;
      if (!fixture) return { skipped: true, reason: "no reference fixture" };
      const result = await rawTool(this.client, "get_object_by_ref", {
        type: fixture.full_name,
        uuid: "not-a-uuid",
      });
      assert(result.ok === false, "bad uuid must fail");
      assert(result.error?.code === "invalid_arguments", `unexpected code: ${result.error?.code}`);
      return { error: result.error };
    });

    await this.test("negative.unknown_tool", async () => {
      const result = await rawTool(this.client, "definitely_not_a_tool", {});
      assert(result.ok === false, "unknown tool must return ok=false");
      assert(result.error?.code, "unknown tool error code must be present");
      return { error: result.error };
    });

    await this.test("negative.parse_error_hides_internal_details", async () => {
      // Битый JSON → -32700. Проверяем, что внутренние детали (текст исключения платформы,
      // тело запроса) не утекают в error.data, а наружу идёт нейтральное сообщение + correlation_id.
      const response = await this.client.rawPost('{"jsonrpc":"2.0","id":1,"method":');
      assert(response.json, `parse error must return a JSON-RPC body, got: ${String(response.text).slice(0, 200)}`);
      const error = response.json.error;
      assert(error?.code === -32700, `expected -32700, got ${error?.code}`);
      assert(error.message === "Parse error", `error.message must stay neutral, got: ${error.message}`);
      const data = error.data || {};
      assert(!("raw_exception" in data), "error.data must not leak raw_exception");
      assert(!("request_body" in data), "error.data must not leak request_body");
      assert(typeof data.correlation_id === "string" && data.correlation_id.length > 0,
        "error.data.correlation_id must be present for support correlation");
      return { code: error.code, correlation_id: data.correlation_id };
    });

    await this.test("negative.internal_error_hides_internal_details", async () => {
      // resources/read с неизвестным uri детерминированно вызывает исключение маршрутизации
      // → -32603. Проверяем, что внутренние детали не утекают в error.data (F6, TC-20).
      const resp = await this.client.rawPost(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "1c://__no_such_resource__" },
      }));
      const error = resp.json?.error;
      assert(error?.code === -32603, `expected -32603, got ${error?.code}`);
      assert(error.message === "Internal error", `error.message must stay neutral, got: ${error.message}`);
      const data = error.data || {};
      assert(!("raw_exception" in data), "error.data must not leak raw_exception");
      assert(!("params" in data), "error.data must not leak params");
      assert(typeof data.correlation_id === "string" && data.correlation_id.length > 0,
        "error.data.correlation_id must be present for support correlation");
      return { code: error.code, correlation_id: data.correlation_id };
    });

    if (process.env.MCP_DENIED_TYPE) {
      await this.test("manual.denied_type_returns_access_denied", async () => {
        const result = await rawTool(this.client, "get_metadata_structure", {
          type: process.env.MCP_DENIED_TYPE,
        });
        assert(result.ok === false, "denied type must fail");
        assert(result.error?.code === "access_denied", `expected access_denied, got ${result.error?.code}`);
        assert(result.authorization?.retry_policy === "do_not_retry_same_request_without_reauth_or_permission_change", "missing retry policy");
        return { type: process.env.MCP_DENIED_TYPE, authorization: result.authorization };
      });
    }

    if (process.env.MCP_DENIED_REPORT) {
      await this.test("manual.denied_report_returns_access_denied", async () => {
        const result = await rawTool(this.client, "get_report_info", {
          report: process.env.MCP_DENIED_REPORT,
        });
        assert(result.ok === false, "denied report must fail");
        assert(result.error?.code === "access_denied", `expected access_denied, got ${result.error?.code}`);
        assert(result.authorization?.retry_policy === "do_not_retry_same_request_without_reauth_or_permission_change", "missing retry policy");
        return { report: process.env.MCP_DENIED_REPORT, authorization: result.authorization };
      });
    }
  }

  async crossChecks() {
    await this.test("crosscheck.every_listed_query_object_has_basic_structure_sample", async () => {
      const candidates = await okTool(this.client, "list_metadata_objects", {
        kinds: ["Справочник", "Документ", "РегистрСведений", "РегистрНакопления"],
        limit: 12,
        include_details: true,
      });
      const checked = [];
      const failures = [];
      for (const item of candidates.objects || []) {
        if (!item.supports_query) continue;
        const structure = await rawTool(this.client, "get_metadata_structure", {
          type: item.full_name,
          include_standard_attributes: false,
          include_tabular_sections: false,
        });
        checked.push(item.full_name);
        if (structure.ok !== true) {
          failures.push({ type: item.full_name, error: structure.error });
        }
      }
      assert(failures.length === 0, `metadata structure failures: ${JSON.stringify(failures)}`);
      return { checked };
    });
  }

  async queryExamplesTests() {
    // Сид-источник не хардкодится: ПланСчетов.Хозрасчетный есть только в
    // бухгалтерских конфигурациях, и на ЗУП пять кейсов падали «объект не
    // найден» (дефект фикстуры, не сервера). Берётся первый план счетов, а без
    // планов счетов — первый справочник: Код и Наименование есть у обоих видов.
    let seedSource = "";
    for (const kind of ["ПланСчетов", "Справочник"]) {
      const found = await rawTool(this.client, "list_metadata_objects", {
        kinds: [kind],
        limit: 1,
        include_details: false,
      });
      const item = (found?.objects ?? []).find((o) => o?.full_name);
      if (item) { seedSource = item.full_name; break; }
    }
    // Маркеры уникальны для прогона; suffix identifier-safe (только цифры).
    const ts = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const aliasName = `МАРКЕРАЛИАС${ts}`;
    const paramName = `МАРКЕРПАРАМ${ts}`;
    const markerLiteral = `КОНТРАКТ_МАРКЕР_${ts}`;
    const paramValue = `ZZZ_${ts}`;
    const seedQuery =
      `ВЫБРАТЬ ПЕРВЫЕ 3 Счета.Код КАК ${aliasName} ` +
      `ИЗ ${seedSource} КАК Счета ` +
      `ГДЕ Счета.Наименование <> "${markerLiteral}" И Счета.Код <> &${paramName}`;
    const seedArgs = { query: seedQuery, parameters: { [paramName]: paramValue }, limit: 3 };
    // Маркер-литерал/алиас/имя параметра из skeleton исчезают по построению,
    // поэтому маркерная группа ищется по устойчивым фрагментам канонического skeleton.
    const SKELETON_FRAGMENTS = [seedSource, "ПЕРВЫЕ 3", "&Строка1"];
    const findMarkerGroup = (result) =>
      (result.examples || []).find((ex) =>
        SKELETON_FRAGMENTS.every((frag) => String(ex.skeleton || "").includes(frag)));

    // Кейс 7: предусловие — ветвление по enabled.
    let enabled = false;
    await this.test("query_examples.precondition_enabled_flag", async () => {
      const probe = await okTool(this.client, "get_query_examples", {});
      assert(typeof probe.enabled === "boolean", "get_query_examples must return boolean enabled");
      enabled = probe.enabled === true;
      if (!enabled) {
        assert(probe.source_available === false, "disabled feature must report source_available:false");
        assert((probe.warnings || []).some((w) => String(w).includes("query_examples_disabled")),
          "disabled feature must warn query_examples_disabled");
      }
      return { enabled };
    });

    // Кейс 1: сид + выборка.
    await this.test("query_examples.seed_and_fetch", async () => {
      if (!enabled) return { skipped: "query_examples disabled" };
      const seed = await okTool(this.client, "run_1c_query", seedArgs);
      assert(Array.isArray(seed.rows) && seed.rows.length >= 1, "seed query must return rows");
      const result = await okTool(this.client, "get_query_examples",
        { object: seedSource, days_back: 7, limit: 20 });
      const group = findMarkerGroup(result);
      assert(group, "marker skeleton group must be present after seed");
      assert(typeof group.skeleton === "string" && group.skeleton.length > 0, "skeleton must be a non-empty string");
      assert(Array.isArray(group.tables) && group.tables.includes(seedSource),
        "tables must include seeded object");
      assert(typeof group.uses === "number" && group.uses >= 1, "uses must be >= 1");
      assert(typeof group.last_used === "string" && group.last_used.length > 0, "last_used must be present");
      return { uses: group.uses };
    });

    // Кейс 2: обезличивание — маркер не утекает нигде в JSON-ответе.
    await this.test("query_examples.anonymization_no_leak", async () => {
      if (!enabled) return { skipped: "query_examples disabled" };
      const result = await okTool(this.client, "get_query_examples",
        { object: seedSource, days_back: 7, limit: 20 });
      const json = JSON.stringify(result);
      for (const marker of [aliasName, paramName, markerLiteral, paramValue]) {
        assert(!json.includes(marker), `marker "${marker}" must not leak into response`);
      }
      const group = findMarkerGroup(result);
      assert(group, "marker group must still be found via skeleton fragments");
      assert(String(group.skeleton).includes("&Строка1"), "string literal must be replaced by &Строка placeholder");
      return {};
    });

    // Кейс 3: дедупликация — повтор идентичного сида растит uses, не число examples.
    await this.test("query_examples.dedup_increments_uses", async () => {
      if (!enabled) return { skipped: "query_examples disabled" };
      const before = findMarkerGroup(await okTool(this.client, "get_query_examples",
        { object: seedSource, days_back: 7, limit: 20 }));
      assert(before, "marker group must exist before re-seed");
      await okTool(this.client, "run_1c_query", seedArgs);
      const after = findMarkerGroup(await okTool(this.client, "get_query_examples",
        { object: seedSource, days_back: 7, limit: 20 }));
      assert(after, "marker group must exist after re-seed");
      assert(after.uses > before.uses, `uses must grow (before=${before.uses}, after=${after.uses})`);
      return { before: before.uses, after: after.uses };
    });

    // Кейс 4: схема ответа.
    await this.test("query_examples.response_schema", async () => {
      const result = await okTool(this.client, "get_query_examples", {});
      assert(typeof result.enabled === "boolean", "enabled:boolean present");
      assert(typeof result.source_available === "boolean", "source_available:boolean present");
      assert(result.period && typeof result.period === "object" && "from" in result.period && "to" in result.period,
        "period{from,to} present");
      assert(typeof result.scanned_events === "number", "scanned_events:number present");
      assert(Array.isArray(result.examples), "examples:array present");
      assert(!("next_cursor" in result), "next_cursor must be absent (cursor not supported)");
      return {};
    });

    // Кейс 5: невалидные аргументы — диагностичная ошибка.
    await this.test("query_examples.invalid_arguments", async () => {
      for (const bad of [{ limit: 0 }, { limit: 100 }, { days_back: 0 }]) {
        const res = await rawTool(this.client, "get_query_examples", bad);
        assert(res.ok === false, `${JSON.stringify(bad)} must be rejected`);
        assert(res.error && typeof res.error.code === "string", `${JSON.stringify(bad)} must return diagnostic error`);
      }
      return {};
    });

    // Кейс 6: shape ответа run_1c_query не изменился.
    await this.test("query_examples.run_1c_query_shape_unchanged", async () => {
      const q = await okTool(this.client, "run_1c_query", { query: `ВЫБРАТЬ ПЕРВЫЕ 1 Счета.Код КАК Код ИЗ ${seedSource} КАК Счета`, limit: 1 });
      for (const field of ["columns", "rows", "row_count"]) {
        assert(field in q, `run_1c_query result must still contain ${field}`);
      }
      assert(!("skeleton" in q) && !("skeleton_hash" in q), "run_1c_query result must not leak example fields");
      return {};
    });

    // §10 крит.16: неизвестный object → metadata_not_found, ЖР не сканируется (не зависит от enabled).
    await this.test("query_examples.unknown_object_metadata_not_found", async () => {
      const res = await rawTool(this.client, "get_query_examples", { object: `Справочник.НетТакогоОбъекта${ts}` });
      assert(res.ok === false, "unknown object must be rejected before scanning the event log");
      assert(res.error?.code === "metadata_not_found", `expected metadata_not_found, got ${res.error?.code}`);
      return {};
    });

    // §10 крит.9: only_with_rows=false показывает шаблоны с has_rows=false.
    await this.test("query_examples.only_with_rows_filter", async () => {
      if (!enabled) return { skipped: "query_examples disabled" };
      const zeroAlias = `МАРКЕРНОЛЬ${ts}`;
      const zeroMarker = `НЕТ_КОДА_${ts}`;
      const zeroQuery =
        `ВЫБРАТЬ ПЕРВЫЕ 1 Счета.Код КАК ${zeroAlias} ` +
        `ИЗ ${seedSource} КАК Счета ГДЕ Счета.Код = "${zeroMarker}"`;
      const zeroSeed = await okTool(this.client, "run_1c_query", { query: zeroQuery, limit: 1 });
      assert(zeroSeed.row_count === 0, "zero-row seed must return no rows (has_rows=false)");
      // ПЕРВЫЕ 1 отличает пустой шаблон от маркерного (ПЕРВЫЕ 3). Но обезличенный skeleton
      // zero-запроса не уникален для прогона (маркер-литерал -> &Строка1), поэтому фрагменты
      // могут совпасть с ПОСТОРОННИМ ПЕРВЫЕ-1-запросом другой сессии, вернувшим строки. Чтобы
      // тест не был хрупок к глобальному состоянию контура: выбираем ИМЕННО пустую группу по
      // row_count_max===0 (у сторонней rows-группы он >0; если тот же skeleton где-то вернул
      // строки — группа схлопнется с row_count_max>0 и мы её не выберем => корректный skip),
      // а скрытость проверяем по ТОЧНОМУ совпадению skeleton, а не по общим фрагментам.
      const ZERO_FRAGS = [seedSource, "ПЕРВЫЕ 1"];
      const findZero = (result) =>
        (result.examples || []).find((ex) =>
          ex.row_count_max === 0 && ZERO_FRAGS.every((f) => String(ex.skeleton || "").includes(f)));
      const withoutFilter = await okTool(this.client, "get_query_examples",
        { object: seedSource, days_back: 7, limit: 20, only_with_rows: false });
      const zero = findZero(withoutFilter);
      if (!zero) {
        // Не попал в топ-20 либо тот же skeleton где-то вернул строки — не заваливаем прогон (§11 устойчивость).
        return { skipped: "zero-row template not isolable in only_with_rows=false view (contour state)" };
      }
      assert(zero.config_version_match !== undefined, "example must carry config_version_match");
      const withFilter = await okTool(this.client, "get_query_examples",
        { object: seedSource, days_back: 7, limit: 20 });
      const stillVisible = (withFilter.examples || []).some((ex) => ex.skeleton === zero.skeleton);
      assert(!stillVisible, "has_rows=false template (row_count_max=0) must be hidden when only_with_rows=true (default)");
      return { verified: true };
    });
  }

  summary() {
    const passed = this.tests.filter((test) => test.status === "PASS").length;
    const failed = this.tests.filter((test) => test.status === "FAIL").length;
    const byClass = (name) => this.tests.filter((test) => test.status === "FAIL" && test.failure_class === name).length;
    const summary = {
      target: this.client.url,
      responseMode: this.options.responseMode || "server_default",
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      total: this.tests.length,
      passed,
      failed,
      // Раздельные счётчики: только assertion_failures означают дефект контракта.
      // Прогон с транспортными отказами недостоверен, но регрессом не является.
      assertion_failures: byClass("assertion"),
      transport_failures: byClass("transport"),
      fixture_missing_failures: byClass("fixture_missing"),
      transport_retries_recovered: this.client.recovered.length,
      transport_retries_attempted: this.client.transportRetries,
      recovered_calls: this.client.recovered,
      tests: this.tests,
    };
    console.log("");
    console.log(`Summary: ${passed} passed, ${failed} failed, ${this.tests.length} total`);
    console.log(`Failures by class: assertion ${summary.assertion_failures}`
      + `, transport ${summary.transport_failures}`
      + `, fixture_missing ${summary.fixture_missing_failures}`);
    if (summary.transport_retries_recovered > 0) {
      console.log(`Transport retries recovered: ${summary.transport_retries_recovered}`
        + ` (attempted ${summary.transport_retries_attempted})`);
    }
    if (summary.transport_failures + summary.fixture_missing_failures > 0 && summary.assertion_failures === 0) {
      console.log("ВНИМАНИЕ: провалы только транспортные — прогон недостоверен, но регресса контракта не показал.");
    }
    if (failed > 0) {
      console.log("Failures:");
      for (const test of this.tests.filter((item) => item.status === "FAIL")) {
        console.log(`- [${test.failure_class || "assertion"}] ${test.name}: ${test.error.message}`);
      }
    }
    return summary;
  }
}

async function findAccountingRegister(client) {
  const result = await okTool(client, "list_metadata_objects", {
    kinds: ["РегистрБухгалтерии"],
    limit: 10,
    include_details: false,
  });
  const items = (result.objects ?? []).filter((o) => o?.full_name);
  if (!items.length) return null;
  const toRegister = (item) => {
    const [, nameFromFullName = ""] = item.full_name.split(".");
    const name = item.name || nameFromFullName;
    return name ? { fullName: item.full_name, name } : null;
  };
  // Первый регистр по алфавиту не универсален: в ERP это КорректировкиНалоговойБазы,
  // у которого ресурса Сумма нет, — и все денежные тесты падали «Поле не найдено
  // СуммаОстаток» (14 ложных провалов, дефект фикстуры, не сервера). Предпочитаем
  // регистр, чьи ВТ публикуют СуммаОстаток; состав берём из живого
  // get_metadata_structure, а не из имён конкретной конфигурации.
  for (const item of items.slice(0, 5)) {
    const structure = await rawTool(client, "get_metadata_structure", {
      type: item.full_name,
      include_virtual_tables: true,
    });
    const vts = structure?.metadata?.register_schema?.virtual_tables || [];
    const balance = vts.find((v) => v.name === "Остатки")?.common_fields || [];
    if (balance.includes("СуммаОстаток")) {
      const register = toRegister(item);
      if (register) return register;
    }
  }
  return toRegister(items[0]);
}

async function findAccumulationRegister(client) {
  const result = await okTool(client, "list_metadata_objects", {
    kinds: ["РегистрНакопления"],
    limit: 1,
    include_details: false,
  });
  const item = result.objects?.[0];
  if (!item?.full_name) return null;
  const [, nameFromFullName = ""] = item.full_name.split(".");
  const name = item.name || nameFromFullName;
  if (!name) return null;
  return {
    fullName: item.full_name,
    name,
  };
}

async function findFirstMetadataObject(client, kinds, predicate, pageLimit = 50) {
  let cursor = "";
  for (let page = 0; page < 4; page += 1) {
    const result = await okTool(client, "list_metadata_objects", {
      kinds,
      limit: pageLimit,
      cursor,
      include_details: true,
    });
    for (const item of result.objects || []) {
      if (!item?.full_name) continue;
      const accepted = await predicate(item);
      if (accepted) {
        const [, nameFromFullName = ""] = item.full_name.split(".");
        return {
          ...item,
          fullName: item.full_name,
          name: item.name || nameFromFullName,
        };
      }
    }
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return null;
}

async function okTool(client, name, args) {
  const result = await rawTool(client, name, args);
  assert(result?.ok === true, `${name} did not return ok=true: ${JSON.stringify(result?.error || result || {}).slice(0, 1200)}`);
  return result;
}

async function rawTool(client, name, args) {
  const { result } = await client.callTool(name, args);
  assertToolResultEnvelope(result, name, client.responseMode);
  const unwrapped = unwrapToolResult(result);
  assertAuthContext(unwrapped, name);
  if (unwrapped?.ok === false) {
    assertErrorDiagnosticText(result, name);
    if (unwrapped.error?.code === "access_denied") {
      assert(unwrapped.authorization?.retry_policy === "do_not_retry_same_request_without_reauth_or_permission_change"
        || unwrapped.error?.authorization?.retry_policy === "do_not_retry_same_request_without_reauth_or_permission_change",
        `${name} access_denied must include retry policy`);
    }
  }
  return unwrapped;
}

function assertToolsListMode(tools, responseMode) {
  if (!responseMode) return;
  if (responseMode === "text_only") {
    const withSchema = tools.filter((tool) => tool.outputSchema);
    assert(withSchema.length === 0, `text_only tools/list must not declare outputSchema: ${withSchema.map((tool) => tool.name).join(", ")}`);
    return;
  }
  const withoutSchema = tools.filter((tool) => !tool.outputSchema);
  assert(withoutSchema.length === 0, `${responseMode} tools/list must declare outputSchema: ${withoutSchema.map((tool) => tool.name).join(", ")}`);
}

function assertToolResultEnvelope(result, toolName, responseMode) {
  if (!responseMode) return;
  if (!result || typeof result !== "object") {
    throw new Error(`${toolName} result envelope must be an object`);
  }
  const text = firstTextContent(result);
  if (responseMode === "text_only") {
    assert(!result.structuredContent, `${toolName} text_only must not include structuredContent`);
    assert(canParseJsonObject(text), `${toolName} text_only content[0].text must contain full JSON`);
    return;
  }
  assert(result.structuredContent && typeof result.structuredContent === "object", `${toolName} ${responseMode} must include structuredContent`);
  if (responseMode === "both") {
    if (result.isError) {
      assert((result.content || []).some((item) => item?.type === "text" && String(item.text || "").includes("Диагностика JSON:")),
        `${toolName} both error content must include JSON diagnostics`);
    } else {
      assert(String(text || "").includes("structuredContent="), `${toolName} both success text must duplicate structuredContent`);
    }
  }
}

function firstTextContent(result) {
  return result?.content?.find?.((item) => item?.type === "text" && typeof item.text === "string")?.text || "";
}

function canParseJsonObject(text) {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function unwrapToolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const textItem = result?.content?.find?.((item) => item?.type === "text" && typeof item.text === "string");
  if (textItem) {
    const text = textItem.text;
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return result;
    }
  }

  return result;
}

function makeContractPeriod() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    start: "2000-01-01T00:00:00",
    end: end.toISOString().slice(0, 19),
  };
}

function toQueryRef(ref) {
  return {
    kind: "ref",
    type: ref.type,
    uuid: ref.uuid,
  };
}

async function firstRefFromType(client, fullName) {
  const result = await rawTool(client, "run_1c_query", {
    query: `ВЫБРАТЬ ПЕРВЫЕ 1 Ссылка ИЗ ${fullName}`,
    limit: 1,
  });
  return result.rows?.[0]?.Ссылка || null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertAuthContext(result, toolName) {
  if (!result || typeof result !== "object" || !("ok" in result)) return;
  const ctx = result.auth_context;
  assert(ctx && typeof ctx === "object", `${toolName} must include auth_context`);
  assert(typeof ctx.user_name === "string", `${toolName} auth_context.user_name is missing`);
  assert(typeof ctx.identity_key === "string" && ctx.identity_key.length > 0, `${toolName} auth_context.identity_key is missing`);
  assert(ctx.cache_policy?.cacheable === false, `${toolName} auth_context.cache_policy.cacheable must be false`);
  assert(ctx.cache_policy?.revalidate_each_call === true, `${toolName} auth_context.cache_policy.revalidate_each_call must be true`);
}

function assertErrorDiagnosticText(toolResult, toolName) {
  const texts = (toolResult?.content || [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text);
  const hasDiagnosticText = texts.some((text) => text.includes("Диагностика JSON:"));
  const hasJsonText = texts.some((text) => {
    try {
      const parsed = JSON.parse(text);
      return parsed?.ok === false && parsed?.error;
    } catch {
      return false;
    }
  });
  const hasStructuredError = toolResult?.structuredContent?.ok === false && toolResult.structuredContent?.error;
  assert(hasDiagnosticText || hasJsonText || hasStructuredError, `${toolName} error content must expose JSON diagnostics`);
}

function assertRef(value, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object ref`);
  assert(typeof value.type === "string" && value.type.includes("."), `${label}.type is missing`);
  assert(typeof value.uuid === "string" && value.uuid.length >= 32, `${label}.uuid is missing`);
  assert("presentation" in value, `${label}.presentation is missing`);
}

function hasGuidance(result, id) {
  return Array.isArray(result?.domain_guidance)
    && result.domain_guidance.some((item) => item?.id === id);
}

function hasQueryGuidance(result, id) {
  return Array.isArray(result?.query_guidance)
    && result.query_guidance.some((item) => item?.id === id);
}

function hasGuidanceItem(items, id) {
  return Array.isArray(items)
    && items.some((item) => item?.id === id);
}

function hasInteractionHint(result, id) {
  return result?.interaction_hint?.id === id;
}

function requireContextRef(ref, name) {
  assert(ref, `fixture ${name} is missing`);
  assertRef(ref, name);
  return ref;
}

function formatError(error) {
  return {
    message: error?.message || String(error),
    rpcError: error?.rpcError,
    stack: error?.stack,
    // Цепочка cause обязательна в отчёте: у транспортных отказов сообщение верхнего
    // уровня всегда «fetch failed», а настоящая причина лежит в cause. Без неё
    // UND_ERR_CONNECT_TIMEOUT неотличим от ECONNRESET, и класс отказа приходится
    // угадывать — именно из-за этого пробела причину искали три прогона подряд.
    cause: causeChain(error),
    httpStatus: error?.httpStatus,
  };
}

// Плоская цепочка причин: код и сообщение каждого звена. Глубина ограничена —
// защита от циклических ссылок в cause.
function causeChain(error) {
  const chain = [];
  for (let current = error?.cause, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    chain.push({ code: current.code, message: String(current.message || "").slice(0, 200) });
  }
  return chain.length > 0 ? chain : undefined;
}

// Класс отказа. Три класса, и смешивать их нельзя: набор провалов сравнивается между
// прогонами, а транспортные отказы меняются от прогона к прогону и делают сравнение
// бессмысленным, если считать их вместе с ассертными.
//
// fixture_missing — следствие транспортного обрыва на discovery: кейс не смог получить
// фикстуру и упал с текстом «fixture ... is missing». По сообщению такой провал не
// отличить от настоящего дефекта, поэтому класс выделен отдельно.
function classifyFailure(error) {
  if (McpHttpClient.isTransportFailure(error)) return "transport";
  if (/fixture .* is missing|no .* fixture/i.test(String(error?.message || ""))) return "fixture_missing";
  return "assertion";
}

function printRow(row) {
  const status = row.status.padEnd(4);
  const elapsed = `${row.elapsedMs}ms`.padStart(7);
  if (row.status === "PASS") {
    const retry = row.transport_retry ? " <восстановлен после транспортного обрыва>" : "";
    console.log(`[${status}] ${elapsed} ${row.name}${retry}`);
  } else {
    const cls = row.failure_class && row.failure_class !== "assertion" ? ` <${row.failure_class}>` : "";
    console.log(`[${status}] ${elapsed} ${row.name}${cls} :: ${row.error.message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.modes.length > 0) {
    const summaries = [];
    for (const mode of options.modes) {
      const runOptions = {
        ...options,
        responseMode: mode,
        out: outPathForMode(options.out, mode),
        modes: [],
      };
      summaries.push(await runContract(runOptions));
    }
    const aggregate = {
      target: options.url,
      responseModes: options.modes,
      startedAt: summaries[0]?.startedAt,
      finishedAt: new Date().toISOString(),
      total: summaries.reduce((sum, item) => sum + item.total, 0),
      passed: summaries.reduce((sum, item) => sum + item.passed, 0),
      failed: summaries.reduce((sum, item) => sum + item.failed, 0),
      assertion_failures: summaries.reduce((sum, item) => sum + (item.assertion_failures || 0), 0),
      transport_failures: summaries.reduce((sum, item) => sum + (item.transport_failures || 0), 0),
      fixture_missing_failures: summaries.reduce((sum, item) => sum + (item.fixture_missing_failures || 0), 0),
      transport_retries_recovered: summaries.reduce((sum, item) => sum + (item.transport_retries_recovered || 0), 0),
      summaries,
    };
    if (options.out) {
      await writeReport(options.out, aggregate);
    }
    process.exitCode = exitCodeFor(aggregate);
    return;
  }
  const summary = await runContract(options);
  process.exitCode = exitCodeFor(summary);
}

// Код возврата различает дефект и недостоверный прогон:
//   0 — провалов нет;
//   1 — есть ассертные провалы, то есть дефект контракта;
//   3 — провалы только транспортные (и производные от них) — прогон недостоверен и
//       подлежит повтору, но регресса не показал. Отдельный код нужен, чтобы CI не
//       записывал нестабильность контура в дефекты кода.
function exitCodeFor(summary) {
  if ((summary.assertion_failures || 0) > 0) return 1;
  if ((summary.failed || 0) > 0) return 3;
  return 0;
}

async function runContract(options) {
  const client = new McpHttpClient(options);
  const runner = new ContractRunner(client, options);
  const summary = await runner.run();
  if (options.out) {
    await writeReport(options.out, summary);
  }
  return summary;
}

async function writeReport(path, data) {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Report written: ${out}`);
}

function outPathForMode(path, mode) {
  if (!path) return "";
  const extension = extname(path);
  if (!extension) return `${path}.${mode}`;
  return `${path.slice(0, -extension.length)}.${mode}${extension}`;
}

main().catch((error) => {
  console.error(formatError(error).message);
  if (error?.stack) console.error(error.stack);
  process.exitCode = 1;
});
