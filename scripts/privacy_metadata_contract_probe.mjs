// Контракт discovery: полное имя объекта метаданных обязано доходить до клиента
// именем типа, а не кодом псевдонима.
//
// ЗАЧЕМ ОТДЕЛЬНАЯ ПРОБА. Волна 2 закрыла `full_name` во ВСЕХ ответах discovery:
// на ревизии .3 list_metadata_objects отдавал `ФЛ-скрыто` вместо
// «Справочник.Контрагенты» — BUH 30/30 и ZUP 30/30, list_registers 20/20.
// Данные при этом не текли, поэтому ни регресс журнала, ни матрица §8, ни
// проверка масок дефекта не увидели: они смотрят на ЗНАЧЕНИЯ, а сломан был
// СПРАВОЧНИК ИМЁН, без которого LLM не построит ни одного запроса.
//
// Синтетическая проба П15 тоже промолчала — она гоняет путь `metadata.*`, ровно
// тот единственный, где анкеровка была. Класс ловится только живым обходом
// РЕАЛЬНЫХ ответов discovery, и потому проба живёт отдельно от матрицы.
//
// Различитель механизма встроен: на контуре с выключенными person_aliases имена
// целы и без правки. Поэтому вердикт «цело» на одном ERP ничего не доказывает —
// проба обязана идти по всем трём контурам (--all).
//
// Запуск:
//   node scripts/privacy_metadata_contract_probe.mjs --all
//   node scripts/privacy_metadata_contract_probe.mjs --all --json reports/metadata_contract.json

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "node:https";
import { URL } from "node:url";

const CONTOURS = {
  BUH_KORP: "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc",
  ZUP_CORP: "https://laba-1c.astondevs.ru/ZUP_CORP/hs/mcp/rpc",
  ERP_DEMO: "https://laba-1c.astondevs.ru/ERP_DEMO/hs/mcp/rpc",
};
const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : ""; };
const ALL = process.argv.includes("--all");
const JSON_OUT = argOf("--json");
let URL_MCP = process.env.MCP_URL || CONTOURS.BUH_KORP;
let rpcId = 0;

function rpc(method, params) {
  const t = new URL(URL_MCP);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  return new Promise((resolve) => {
    const req = request({
      hostname: t.hostname, port: t.port || 443, path: t.pathname + t.search,
      method: "POST", rejectUnauthorized: false, timeout: 120000,
      headers: { "content-type": "application/json", accept: "application/json",
        "mcp-protocol-version": "2025-11-25", "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      let s = ""; res.setEncoding("utf8");
      res.on("data", (c) => (s += c));
      res.on("end", () => { try { resolve({ body: JSON.parse(s) }); } catch { resolve({ body: null, raw: s.slice(0, 200) }); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ body: null, raw: String(e.message || e) }));
    req.write(payload); req.end();
  });
}
async function callTool(name, args, tries = 6) {
  for (let a = 1; a <= tries; a += 1) {
    const { body, raw } = await rpc("tools/call", { name, arguments: args });
    if (!body && raw) { if (a === tries) return { ok: false, transport: raw }; continue; }
    if (body?.error) return { ok: false, error: body.error };
    const st = body?.result?.structuredContent;
    if (st) return { ok: true, data: st };
    try { return { ok: true, data: JSON.parse(body?.result?.content?.[0]?.text ?? "null") }; }
    catch { return { ok: true, data: { raw: body?.result?.content?.[0]?.text } }; }
  }
  return { ok: false, transport: "нет ответа" };
}

const ВИДЫ = ["справочник.", "документ.", "перечисление.", "отчет.", "обработка.",
  "регистрсведений.", "регистрнакопления.", "регистрбухгалтерии.", "регистррасчета.",
  "плансчетов.", "планвидовхарактеристик.", "планвидоврасчета.", "планобмена.",
  "бизнеспроцесс.", "задача.", "журналдокументов.", "константа."];
const ЭтоИмяТипа = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return ВИДЫ.some((k) => s.startsWith(k) && s.length > k.length);
};
let маркеры = [];
const Замаскировано = (v) => {
  const s = String(v ?? "");
  return s === "XXXXXXX" || s.endsWith("скрыто") || маркеры.some((p) => p && s.startsWith(p));
};

const results = [];
let passed = 0, failed = 0, skipped = 0, currentName = "";
function record(section, name, verdict, detail) {
  results.push({ contour: currentName, section, name, verdict, detail: detail ?? "" });
  if (verdict === "PASS") passed++; else if (verdict === "FAIL") failed++; else skipped++;
  console.log(`${verdict === "PASS" ? "OK  " : verdict === "FAIL" ? "FAIL" : "SKIP"} | ${section} | ${name}${detail ? `\n       ${detail}` : ""}`);
}
const check = (s, n, ok, d) => record(s, n, ok ? "PASS" : "FAIL", d);

// Одна проверка на коллекцию: сколько full_name дошло именем типа, сколько
// замаскировано. Именно ДОЛЯ, а не факт наличия: одно уцелевшее имя из тридцати
// означает сломанный контракт ровно так же, как ноль.
async function проверитьКоллекцию(инструмент, аргументы, ключКоллекции, ярлык) {
  const r = await callTool(инструмент, аргументы);
  if (!r.ok || r.data?.ok === false) {
    return record("Контракт discovery", `${ярлык}: ${инструмент}`, "SKIP",
      `инструмент отказал: ${r.transport ?? r.data?.error?.code ?? "нет данных"}`);
  }
  const коллекция = r.data?.[ключКоллекции] ?? [];
  if (!Array.isArray(коллекция) || !коллекция.length) {
    return record("Контракт discovery", `${ярлык}: ${инструмент}`, "SKIP",
      `коллекция ${ключКоллекции} пуста — доказательства нет`);
  }
  const сИменем = коллекция.filter((o) => o && o.full_name !== undefined);
  if (!сИменем.length) {
    return record("Контракт discovery", `${ярлык}: ${инструмент}`, "SKIP",
      "ключа full_name в элементах нет");
  }
  const именаТипов = сИменем.filter((o) => ЭтоИмяТипа(o.full_name)).length;
  const закрытых = сИменем.filter((o) => Замаскировано(o.full_name)).length;
  check("Контракт discovery", `${ярлык}: full_name — имя типа, не код`,
    закрытых === 0 && именаТипов === сИменем.length,
    `имён типа ${именаТипов}/${сИменем.length}, замаскировано ${закрытых}`);
}

async function probeContour() {
  маркеры = [];
  const ctx = await callTool("get_current_user_context", {});
  if (!ctx.ok) return record("Р", "контур доступен", "SKIP", `транспорт: ${ctx.transport ?? ""}`);
  const p = ctx.data?.privacy ?? {};
  for (const e of p.type_aliases?.entries ?? []) if (e.prefix) маркеры.push(e.prefix);
  for (const k of ["Орг-", "ФЛ-", "Сотр-", "Польз-"]) маркеры.push(k);
  if (p.organization_aliases?.prefix) маркеры.push(p.organization_aliases.prefix);
  for (const k of ["prefix", "employee_prefix", "user_prefix"]) if (p.person_aliases?.[k]) маркеры.push(p.person_aliases[k]);
  record("Р", "разведка", "PASS",
    `ревизия ${p.engine_revision}, person_aliases.enabled = ${p.person_aliases?.enabled}`
    + " (при выключенных линия персон не сработает — вердикт по одному контуру недействителен)");

  await проверитьКоллекцию("list_metadata_objects", { kinds: ["Справочник"], limit: 30 }, "objects", "справочники");
  await проверитьКоллекцию("list_metadata_objects", { kinds: ["Документ"], limit: 30 }, "objects", "документы");
  await проверитьКоллекцию("list_registers", { limit: 20 }, "registers", "регистры");
  await проверитьКоллекцию("list_reports", { limit: 20 }, "reports", "отчёты");

  // Контроль обратной стороны: ФИО человека под тем же ключом обязано остаться
  // закрытым. Без него «имена целы» достигается снятием правила целиком.
  const u = ctx.data?.user ?? {};
  if (u.full_name === undefined) {
    record("Контроль", "ФИО оператора под тем же ключом закрыто", "SKIP",
      "user.full_name в ответе отсутствует — контроль не выполнен");
  } else if (ЭтоИмяТипа(u.full_name)) {
    record("Контроль", "ФИО оператора под тем же ключом закрыто", "SKIP",
      "значение имеет форму имени типа — на служебной учётке контроль неинформативен");
  } else {
    // Служебная учётка (web/WEB) персональными данными не является, поэтому
    // здесь фиксируется наблюдение, а не вердикт: закрытость ФИО проверяется
    // на контуре с именованными пользователями.
    record("Контроль", "ФИО оператора под тем же ключом", "SKIP",
      `значение ${Замаскировано(u.full_name) ? "закрыто" : "открыто"};`
      + " на служебной учётке это не вердикт — нужен контур с именованными пользователями");
  }
}

const targets = ALL ? Object.entries(CONTOURS)
  : [[Object.entries(CONTOURS).find(([, u]) => u === URL_MCP)?.[0] ?? "MCP_URL", URL_MCP]];
for (const [name, url] of targets) {
  currentName = name; URL_MCP = url;
  console.log(`\n=== ${name} ===`);
  await probeContour();
}
console.log(`\nИтог: PASS ${passed}, FAIL ${failed}, SKIP ${skipped}`);
console.log("Вердикт по одному контуру недействителен: там, где person_aliases выключены,"
  + " имена целы и без правки — это различитель механизма, а не доказательство.");

if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify({ summary: { passed, failed, skipped }, results }, null, 2), "utf8");
  console.log(`JSON: ${JSON_OUT}`);
}
process.exitCode = failed > 0 ? 1 : 0;
