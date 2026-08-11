// Приёмка запрос-гейта privacy по матрицам ТЗ
// doc/TZ_dev_privacy_gate_type_resolution_fixes.md (issues #103–#113).
//
// Матрица подмены (§8 ТЗ, режим mask — основной курс):
//   М — значение ОБЯЗАНО быть подменено, и строки при этом обязаны вернуться;
//   О — подмена ОБЯЗАНА не срабатывать на открытых типах.
// Критерий двойной: запрос вернул строки И реальных данных в них нет.
//
// Матрица §6 (обязан отказать) снята: с 05.08.2026 отказов нет ни в одной форме,
// её пробы стали пробами подмены §8.1. §7 остаётся и означает теперь «форма
// обязана выполниться»: появление кодов privacy_denied_* или privacy_config_error
// означает старую сборку, а не настройку.
//
// Значения контура наружу не выводятся ни в консоль, ни в JSON: вердикт строится
// на признаке замаскированности, а не на сравнении с эталоном имён.
//
// Имена метаданных не захардкожены: закрытые типы берутся из живого
// get_current_user_context, документ-носитель закрытой ссылки и подчинённый
// справочник ищутся интроспекцией. Фикстуры регистра бухгалтерии (счёт, дата)
// задаются переменными окружения — без них группа B уходит в SKIP, а не
// притворяется пройденной.
//
// Запуск:
//   node scripts/privacy_gate_probe.mjs
//   node scripts/privacy_gate_probe.mjs --json reports/privacy_gate_probe.json
//   MCP_URL=https://host/BASE/hs/mcp/rpc ACC_ACCOUNT=60.01 PROBE_DATE=2026-07-01 node scripts/privacy_gate_probe.mjs
//
// Транспорт node:https: undici рвёт connect на жёстких 10 с через VPN, что
// выглядит как «упал контур». Сертификат контура самоподписанный.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "node:https";
import { URL } from "node:url";

const URL_MCP = process.env.MCP_URL || "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc";
const ACC_REGISTER = process.env.ACC_REGISTER || "РегистрБухгалтерии.Хозрасчетный";
const ACC_PLAN = process.env.ACC_PLAN || "ПланСчетов.Хозрасчетный";
// Счёт с субконто ЗАКРЫТОГО типа — для парной пробы Д-3: подмена обязана остаться.
const ACC_CLOSED = process.env.ACC_CLOSED || "60.01";
// Счёт с субконто ОТКРЫТОГО типа — ложная подмена обязана исчезнуть.
const ACC_OPEN = process.env.ACC_OPEN || "10.01";
const ACC_ACCOUNT = process.env.ACC_ACCOUNT || "60.01";
const PROBE_DATE = process.env.PROBE_DATE || "2026-07-01";
const jsonFlag = process.argv.indexOf("--json");
const JSON_OUT = jsonFlag > -1 ? process.argv[jsonFlag + 1] : "";

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  "mcp-protocol-version": "2025-11-25",
};

let rpcId = 0;

function rpc(method, params) {
  const target = new URL(URL_MCP);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  return new Promise((resolve) => {
    const req = request({
      hostname: target.hostname,
      port: target.port || 443,
      path: target.pathname + target.search,
      method: "POST",
      headers: { ...HEADERS, "content-length": Buffer.byteLength(payload) },
      rejectUnauthorized: false,
      timeout: 120000,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        try {
          resolve({ body: JSON.parse(text) });
        } catch {
          resolve({ body: null, raw: text.slice(0, 500) });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ body: null, raw: String(err.message || err) }));
    req.write(payload);
    req.end();
  });
}

async function callTool(name, args) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { body, raw } = await rpc("tools/call", { name, arguments: args });
    if (!body && raw) {
      if (attempt === 3) return { ok: false, transport: raw };
      await new Promise((s) => setTimeout(s, 5000));
      continue;
    }
    if (body?.error) return { ok: false, error: body.error };
    const structured = body?.result?.structuredContent;
    const isError = body?.result?.isError === true;
    if (structured) return { ok: true, data: structured, isError };
    try {
      return { ok: true, data: JSON.parse(body?.result?.content?.[0]?.text ?? "null"), isError };
    } catch {
      return { ok: true, data: { raw: body?.result?.content?.[0]?.text }, isError };
    }
  }
  return { ok: false, transport: "не удалось выполнить вызов" };
}

const PRIVACY_CODES = ["privacy_denied_field", "privacy_denied_autoorder", "privacy_config_error"];

const codesOf = (res) => [
  ...(res?.data?.validation?.errors ?? []).map((i) => i.code),
  ...(res?.data?.errors ?? []).map((i) => i.code),
  res?.error?.code ?? "",
  res?.data?.error?.code ?? "",
  res?.data?.code ?? "",
].filter(Boolean);

// Текст ошибки инструмента: privacy-код приходит и внутри data.error.details.
const textOf = (res) => JSON.stringify(res?.data ?? res?.error ?? {}).slice(0, 400);
const deniedByPrivacy = (res) => codesOf(res).some((c) => PRIVACY_CODES.includes(c))
  || /privacy-политикой/.test(textOf(res));

async function runQuery(query, parameters, limit = 5) {
  const args = { query, limit };
  if (parameters) args.parameters = parameters;
  return callTool("run_1c_query", args);
}

// ------------------------------------------------------------------ отчёт

const results = [];
let passed = 0, failed = 0, skipped = 0, notApplicable = 0;

function record(section, name, verdict, detail) {
  results.push({ section, name, verdict, detail });
  if (verdict === "PASS") passed += 1;
  else if (verdict === "FAIL") failed += 1;
  else if (verdict === "N/A") notApplicable += 1;
  else skipped += 1;
  // N/A отделён от SKIP намеренно: SKIP означает «проверить не удалось» и требует
  // разбора, N/A — «проверять нечем по существу» (форму отвергает платформа либо
  // в политике нет подходящего поля). Смешивать их — значит прятать первое во втором.
  const mark = verdict === "PASS" ? "OK  " : verdict === "FAIL" ? "FAIL" : verdict === "N/A" ? "N/A " : "SKIP";
  console.log(`${mark} | ${section} | ${name}${detail ? `\n       ${detail}` : ""}`);
}

// §7: отказ запрещён. Ошибка не privacy (пустая выборка, отсутствующий счёт) —
// SKIP: проба про ложный отказ гейта, а не про наличие данных в базе.
async function mustPass(section, code, query, parameters, extra) {
  const res = await runQuery(query, parameters);
  if (!res.ok) return record(section, code, "SKIP", `транспорт: ${res.transport ?? JSON.stringify(res.error)}`);
  if (deniedByPrivacy(res)) {
    return record(section, code, "FAIL", `ЛОЖНЫЙ ОТКАЗ: ${codesOf(res).join(", ")} ${textOf(res)}`);
  }
  if (res.isError) return record(section, code, "SKIP", `ошибка не privacy: ${textOf(res)}`);
  const detail = extra ? extra(res.data) : `строк: ${(res.data?.rows ?? []).length}`;
  record(section, code, "PASS", detail);
}

// Форма со звёздочкой запрещена волной 1 (P-0, PR #125): до неё через
// `ВЫБРАТЬ ПЕРВЫЕ N *` и `SELECT TOP N *` уходили открытыми поля политики.
// Пробы, которые раньше требовали от этой формы ИСПОЛНИМОСТИ, перевёрнуты, а не
// удалены: удалить — значит потерять способность матрицы заметить, что запрет
// вернулся обратно. Требование теперь — отказ, и отказ ИМЕННО запретом звёздочки:
// «ошибка не privacy» ушла бы в SKIP и выглядела бы как отсутствие доказательства.
//
// Код ищется в тексте ответа, а не через codesOf: предвалидатор отдаёт его в
// data.error_code и data.validation_errors[].code, которых codesOf не читает.
async function mustRejectWildcard(section, code, query) {
  const res = await runQuery(query);
  if (!res.ok) {
    return record(section, code, "SKIP", `транспорт: ${res.transport ?? JSON.stringify(res.error)}`);
  }
  const текст = textOf(res);
  if (res.isError && /wildcard_select_forbidden/.test(текст)) {
    return record(section, code, "PASS", "отклонена предвалидатором: wildcard_select_forbidden");
  }
  if (res.isError) {
    return record(section, code, "FAIL", `отклонена, но НЕ запретом звёздочки: ${текст}`);
  }
  record(section, code, "FAIL",
    "ЗАПРЕТ ЗВЁЗДОЧКИ СНЯТ: форма исполнилась."
    + " До PR #125 через неё уходили открытыми поля политики — см. B7'");
}

// ------------------------------------------------------------- фикстуры

const fixtures = {
  closed: "", closedPrefix: "", owned: "", docType: "", docAttr: "",
  refUuid: "", accountingReady: false, policyOff: false, engineRevision: "",
  openCatalog: "", openDoc: "", openDocAttr: "",
  // Режим mask: свой набор фикстур — политика может содержать и mask, и deny.
  maskClosed: "", maskField: "", maskFieldNames: [], maskDoc: "", maskDocAttr: "",
  maskRefUuid: "", maskMarkers: [], maskOff: true, personTypes: [],
  accountUuid: "", maskNonNameFields: [], openRefType: "", openRefUuid: "",
};

const STRING_MASK = "XXXXXXX";
const DATE_MASK = "1900-01-01T00:00:00";

// Признак замаскированности (§2 ТЗ): префикс псевдонима, строковая или датовая
// маска, суффикс -скрыто. Проверять по признаку обязательно — сверка со списком
// известных имён принимает за маску любое значение, которого нет в эталоне, и
// именно эта ошибка искажала первое измерение.
function isMaskedValue(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.every(isMaskedValue);
  if (typeof value === "object") {
    // Ссылка и перечисление: подменяется представление, тип и uuid остаются.
    if ("presentation" in value) return isMaskedValue(value.presentation);
    return Object.values(value).every(isMaskedValue);
  }
  const text = String(value);
  if (!text.length) return true;
  if (text === STRING_MASK || text === DATE_MASK) return true;
  if (text.endsWith("скрыто")) return true;
  return fixtures.maskMarkers.some((prefix) => prefix && text.startsWith(prefix));
}

const nonEmpty = (value) => value !== null && value !== undefined && value !== "";

// §8.1: значение обязано быть подменено, и строки обязаны вернуться. Сами
// значения не печатаются — только счётчики.
async function mustMask(section, code, column, query, parameters) {
  const res = await runQuery(query, parameters, 10);
  if (!res.ok) return record(section, code, "SKIP", `транспорт: ${res.transport ?? JSON.stringify(res.error)}`);
  if (deniedByPrivacy(res)) {
    return record(section, code, "FAIL", `ОТКАЗ вместо подмены: ${codesOf(res).join(", ")}`);
  }
  if (res.isError) return record(section, code, "SKIP", `ошибка не privacy: ${textOf(res)}`);
  const rows = res.data?.rows ?? [];
  if (!rows.length) return record(section, code, "SKIP", "0 строк — подменять нечего");
  const values = rows.map((row) => row[column]);
  const masked = values.filter(isMaskedValue).length;
  record(section, code, masked === values.length ? "PASS" : "FAIL",
    `замаскировано ${masked}/${values.length}, колонка ${column} (значения не выводятся)`);
}

// §8.2: подмена не должна срабатывать лишнего. Пустые значения из подсчёта
// исключены — пустое неотличимо от скрытого и дало бы ложный FAIL.
async function mustNotMask(section, code, column, query, parameters) {
  const res = await runQuery(query, parameters, 10);
  if (!res.ok) return record(section, code, "SKIP", `транспорт: ${res.transport ?? JSON.stringify(res.error)}`);
  if (deniedByPrivacy(res)) {
    return record(section, code, "FAIL", `ОТКАЗ на открытом типе: ${codesOf(res).join(", ")}`);
  }
  if (res.isError) return record(section, code, "SKIP", `ошибка не privacy: ${textOf(res)}`);
  const values = (res.data?.rows ?? []).map((row) => row[column]).filter(nonEmpty);
  if (!values.length) return record(section, code, "SKIP", "все значения пусты — судить не о чем");
  const masked = values.filter(isMaskedValue).length;
  record(section, code, masked === 0 ? "PASS" : "FAIL",
    masked === 0
      ? `открыто ${values.length}/${values.length}, колонка ${column}`
      : `подменено ${masked}/${values.length} — подмена сработала лишнего`);
}

async function discover() {
  const ctx = await callTool("get_current_user_context", {});
  const p = ctx.data?.privacy;
  if (!p) {
    record("политика", "get_current_user_context содержит privacy", "FAIL",
      `контур не отвечает или код не задеплоен: ${ctx.transport ?? textOf(ctx)}`);
    return false;
  }
  console.log(`Контур: ${URL_MCP}`);
  console.log(`engine_revision=${p.engine_revision ?? "<нет>"}, enabled=${p.enabled}\n`);

  fixtures.engineRevision = p.engine_revision ?? "";
  await discoverMask(p);

  // mode из контракта убран: закрывает тип сам факт записи в политике.
  const aliasEntries = p.type_aliases?.entries ?? [];
  const maskEntries = p.type_field_masks?.entries ?? [];
  if (!aliasEntries.length && !maskEntries.length) {
    // Политика без записей по типам (например контур, где значимы только
    // person_aliases). Правки разбора запроса меняют ЛЮБОЙ запрос, а карта
    // источников используется и pre-flight проверками вне privacy, поэтому
    // набор форм §7 гоняется всё равно.
    record("политика", "записи по типам", "SKIP",
      "политика без записей type_aliases/type_field_masks: гоняем только формы запросов (§7)");
    fixtures.policyOff = true;
    return true;
  }

  // Закрытый справочник с данными: на нём строятся почти все пробы.
  for (const entry of [...aliasEntries, ...maskEntries]) {
    if (!entry.type.startsWith("Справочник.")) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Р ИЗ ${entry.type} КАК Т`, null, 1);
    const uuid = probe.data?.rows?.[0]?.Р?.uuid;
    if (uuid) {
      fixtures.closed = entry.type;
      fixtures.closedPrefix = entry.prefix ?? "";
      fixtures.refUuid = uuid;
      break;
    }
  }
  if (!fixtures.closed) {
    record("политика", "закрытый справочник с данными", "SKIP",
      "ни один закрытый тип не вернул строк: §7 неприменима, матрица подмены идёт своим набором");
    fixtures.policyOff = true;
    return true;
  }

  // Подчинённый закрытый справочник — для проб через Владелец (в1, в2, ц5).
  for (const entry of [...aliasEntries, ...maskEntries]) {
    if (entry.type === fixtures.closed || !entry.type.startsWith("Справочник.")) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Владелец КАК В ИЗ ${entry.type} КАК Т`, null, 1);
    if (probe.data?.rows?.[0]?.В?.uuid) { fixtures.owned = entry.type; break; }
  }

  // Документ с реквизитом закрытого типа — носитель ссылки для ц3/ц6/д2/A6.
  const docs = (await callTool("list_metadata_objects", { kinds: ["Документ"], limit: 40 })).data?.objects ?? [];
  for (const doc of docs.slice(0, 25)) {
    if (!doc.full_name) continue;
    const meta = await callTool("get_metadata_structure", { type: doc.full_name });
    const attr = (meta.data?.metadata?.attributes ?? []).find((a) =>
      String(a.type ?? "").includes(fixtures.closed) || String(a.types ?? "").includes(fixtures.closed));
    if (!attr) continue;
    const probe = await runQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 1 Д.${attr.name} КАК Р ИЗ ${doc.full_name} КАК Д ГДЕ Д.${attr.name} <> ЗНАЧЕНИЕ(${fixtures.closed}.ПустаяСсылка)`,
      null, 1);
    if (probe.data?.rows?.[0]?.Р?.uuid) { fixtures.docType = doc.full_name; fixtures.docAttr = attr.name; break; }
  }

  console.log(`фикстуры: закрытый=${fixtures.closed}, подчинённый=${fixtures.owned || "нет"},`
    + ` документ=${fixtures.docType || "нет"}.${fixtures.docAttr || ""},`
    + ` регистр=${fixtures.accountingReady ? `${ACC_REGISTER} счёт ${ACC_ACCOUNT}` : "нет"}\n`);
  return true;
}

// uuid ссылки счёта по коду. Пустая строка — счёта нет.
async function accountRefUuid(code) {
  const res = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 1 С.Ссылка КАК Р ИЗ ${ACC_PLAN} КАК С ГДЕ С.Код = &Код`,
    { Код: { kind: "string", value: code } }, 1);
  return res.data?.rows?.[0]?.Р?.uuid ?? "";
}

// Параметры бухгалтерских проб. Счёт — ссылка, иначе ноль строк без ошибки.
function accountingParams(extra) {
  return {
    Дата: { kind: "datetime", value: `${PROBE_DATE}T00:00:00` },
    Счет: { kind: "ref", type: ACC_PLAN, uuid: fixtures.accountUuid },
    ...(extra ?? {}),
  };
}

// Синоним типа: контур публикует тип реквизита документа синонимом
// («Контрагент»), а не полным именем, поэтому поиск по полному имени не находил
// ни одного документа и семь проб уходили в SKIP.
async function typeSynonym(fullName) {
  const meta = await callTool("get_metadata_structure", { type: fullName });
  return String(meta.data?.metadata?.synonym ?? "").trim();
}

// Фикстуры режима mask. Признаки подмены собираются из самой политики, поэтому
// имена префиксов не захардкожены и переносятся между контурами.
async function discoverMask(privacy) {
  // Регистр бухгалтерии: остатки на дату по счёту. Фикстура нужна обеим матрицам
  // (субконто в §6, открытые типы в §8.2), поэтому берётся здесь — discoverMask
  // вызывается независимо от состава политики.
  //
  // Счёт передаётся ССЫЛКОЙ. Строка в «Счет В ИЕРАРХИИ (&Счет)» не приводится к
  // ссылке и даёт НОЛЬ СТРОК БЕЗ ОШИБКИ — фикстура молча оказывалась пустой, и
  // группа проб уходила в SKIP как «нет остатков».
  fixtures.accountUuid = await accountRefUuid(ACC_ACCOUNT);
  if (fixtures.accountUuid) {
    const ост = await runQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 1 О.Субконто1 КАК С ИЗ ${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`,
      accountingParams(), 1);
    fixtures.accountingReady = Array.isArray(ост.data?.rows) && ост.data.rows.length > 0;
    if (!fixtures.accountingReady) {
      record("фикстуры", `остатки ${ACC_REGISTER} счёт ${ACC_ACCOUNT} на ${PROBE_DATE}`, "SKIP",
        "ссылка счёта получена, но остатков нет — задайте ACC_ACCOUNT/PROBE_DATE");
    }
  } else {
    record("фикстуры", `ссылка счёта ${ACC_ACCOUNT}`, "SKIP",
      `счёт не найден в ${ACC_PLAN} — задайте ACC_ACCOUNT/ACC_PLAN`);
  }

  fixtures.maskMarkers = [
    ...(privacy.type_aliases?.entries ?? []).map((e) => e.prefix),
    privacy.person_aliases?.physical_person_prefix,
    privacy.person_aliases?.employee_prefix,
    privacy.person_aliases?.user_prefix,
    privacy.organization_aliases?.prefix,
  ].filter(Boolean);

  // Типы персон определяются кодом по имени, списка в конфиге нет — набор
  // кандидатов повторяет то же правило (ЭтоТипПерсоныLLM). Отсутствующий в
  // конфигурации тип даёт ошибку запроса и уходит в SKIP, а не в FAIL.
  if (privacy.person_aliases?.enabled) {
    for (const type of ["Справочник.ФизическиеЛица", "Справочник.Сотрудники", "Справочник.Пользователи"]) {
      const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Р ИЗ ${type} КАК Т`, null, 1);
      if (probe.data?.rows?.[0]?.Р?.uuid) fixtures.personTypes.push(type);
    }
  }

  const maskAliases = (privacy.type_aliases?.entries ?? []).filter((e) => e.mode !== "deny");
  const maskFields = (privacy.type_field_masks?.entries ?? []).filter((e) => e.mode !== "deny");
  fixtures.maskOff = !maskAliases.length && !maskFields.length && !fixtures.personTypes.length;
  if (fixtures.maskOff) {
    record("политика", "типы с mode: mask", "SKIP", "в политике нет записей режима mask");
    return;
  }

  // Справочник режима mask с данными: на нём строится основная часть матрицы.
  for (const entry of [...maskAliases, ...maskFields]) {
    if (!entry.type.startsWith("Справочник.")) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Р ИЗ ${entry.type} КАК Т`, null, 1);
    const uuid = probe.data?.rows?.[0]?.Р?.uuid;
    if (!uuid) continue;
    fixtures.maskClosed = entry.type;
    fixtures.maskRefUuid = uuid;
    break;
  }
  if (!fixtures.maskClosed && fixtures.personTypes.length) {
    // Политика может состоять из одних персон (ЗУП): тогда основной фикстурой
    // становится справочник персон — он закрыт легаси-псевдонимами.
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Р ИЗ ${fixtures.personTypes[0]} КАК Т`, null, 1);
    fixtures.maskClosed = fixtures.personTypes[0];
    fixtures.maskRefUuid = probe.data?.rows?.[0]?.Р?.uuid ?? "";
  }

  // Поле из type_field_masks у выбранного типа: проба М2 требует именно его —
  // поле, прямо перечисленное в политике, живьём уходило открытым.
  // Контур публикует перечень полей в ключе fields (ИнформацияМасокПолейТиповLLM);
  // field_names — имя во внутренней структуре политики, наружу оно не выходит.
  const own = maskFields.find((e) => e.type === fixtures.maskClosed);
  fixtures.maskFieldNames = own?.fields ?? own?.field_names ?? [];
  fixtures.maskField = fixtures.maskFieldNames.find((name) => name !== "Наименование") ?? "";

  // Документ с реквизитом закрытого типа — носитель для М5, М6, М7, М8, О4.
  //
  // Тип реквизита сверяется и по полному имени, и по СИНОНИМУ типа: контур
  // публикует его синонимом («Контрагент»), поэтому поиск только по полному имени
  // не находил ничего никогда. Окончательный отбор — отбором
  // ЗНАЧЕНИЕ(<тип>.ПустаяСсылка): он принимается платформой только если реквизит
  // действительно этого типа, и это самая надёжная проверка.
  if (fixtures.maskClosed) {
    const synonym = await typeSynonym(fixtures.maskClosed);
    const shortName = fixtures.maskClosed.split(".").pop();
    const marks = [fixtures.maskClosed, shortName, synonym].filter(Boolean).map((s) => s.toLowerCase());
    const docs = (await callTool("list_metadata_objects", { kinds: ["Документ"], limit: 60 })).data?.objects ?? [];
    for (const doc of docs.slice(0, 30)) {
      if (!doc.full_name) continue;
      const meta = await callTool("get_metadata_structure", { type: doc.full_name });
      const candidates = (meta.data?.metadata?.attributes ?? []).filter((a) => {
        const text = [a.type, a.types, a.type_description, a.value_types]
          .map((v) => (Array.isArray(v) ? v.join(",") : String(v ?? ""))).join(",").toLowerCase();
        return marks.some((m) => text.includes(m));
      });
      let found = false;
      for (const attr of candidates) {
        const probe = await runQuery(
          `ВЫБРАТЬ ПЕРВЫЕ 1 Д.${attr.name} КАК Р ИЗ ${doc.full_name} КАК Д`
          + ` ГДЕ Д.${attr.name} <> ЗНАЧЕНИЕ(${fixtures.maskClosed}.ПустаяСсылка)`, null, 1);
        if (probe.data?.rows?.[0]?.Р?.uuid) {
          fixtures.maskDoc = doc.full_name;
          fixtures.maskDocAttr = attr.name;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!fixtures.maskDoc) {
      record("фикстуры", "документ с реквизитом закрытого типа", "SKIP",
        `ни один документ не дал непустой реквизит типа ${fixtures.maskClosed}`
        + ` (искали по полному имени, короткому имени и синониму «${synonym || "нет"}»)`);
    }
  }

  // Ссылка ОТКРЫТОГО типа — для парной пробы Д-1 (О11): подмена не должна
  // срабатывать на параметре открытого типа в запросе без ИЗ.
  const открытые = (await callTool("list_metadata_objects", { kinds: ["Справочник"], limit: 40 }))
    .data?.objects ?? [];
  const закрытыеКлючи = [
    ...(privacy.type_aliases?.entries ?? []).map((e) => e.type),
    ...(privacy.type_field_masks?.entries ?? []).map((e) => e.type),
    ...fixtures.personTypes,
  ].map((t) => String(t).toLowerCase());
  for (const item of открытые.slice(0, 20)) {
    if (!item.full_name || закрытыеКлючи.includes(item.full_name.toLowerCase())) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Р ИЗ ${item.full_name} КАК Т`, null, 1);
    const uuid = probe.data?.rows?.[0]?.Р?.uuid;
    if (uuid) {
      fixtures.openRefType = item.full_name;
      fixtures.openRefUuid = uuid;
      break;
    }
  }

  // Вид поля маски по метаданным: проба М18 обязана судить о типизации подстановки
  // только на ДАТОВЫХ и ЧИСЛОВЫХ полях масок. По имени этого не определить —
  // НаименованиеПолное имя-подобное, и М2 требует закрыть его кодом псевдонима,
  // то есть проба по имени противоречила бы М2.
  fixtures.maskNonNameFields = [];
  if (fixtures.maskClosed && fixtures.maskFieldNames.length) {
    const meta = await callTool("get_metadata_structure", { type: fixtures.maskClosed });
    const attrs = meta.data?.metadata?.attributes ?? [];
    for (const name of fixtures.maskFieldNames) {
      const attr = attrs.find((a) => String(a.name ?? "").toLowerCase() === name.toLowerCase());
      const kind = [attr?.type, attr?.type_description, attr?.value_types]
        .map((v) => (Array.isArray(v) ? v.join(",") : String(v ?? ""))).join(",").toLowerCase();
      if (/дата|date|число|number/.test(kind)) fixtures.maskNonNameFields.push(name);
    }
  }

  console.log(`фикстуры mask: тип=${fixtures.maskClosed || "нет"}, поле маски=${fixtures.maskField || "нет"},`
    + ` документ=${fixtures.maskDoc || "нет"}.${fixtures.maskDocAttr || ""},`
    + ` персоны=${fixtures.personTypes.join(", ") || "нет"}, признаки=${fixtures.maskMarkers.join(" ") || "нет"}\n`);
}

// ---------------------------------------------------------------- пробы

// §8.1 и §8.2: подмена обязана срабатывать и обязана не срабатывать лишнего.
async function sectionMask() {
  const S = "§8.1 обязан подменить";
  const O = "§8.2 не должен подменять";
  const { maskClosed: closed, maskDoc, maskDocAttr, maskField, maskRefUuid } = fixtures;

  if (!closed) {
    return record(S, "матрица подмены", "SKIP", "нет типа режима mask с данными");
  }
  const DOC = maskDoc ? `${maskDoc} КАК Док` : "";

  await mustMask(S, "М1 К.Наименование", "Н",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.Наименование КАК Н ИЗ ${closed} КАК К`);
  if (maskField) {
    await mustMask(S, `М2 К.${maskField} (поле в type_field_masks)`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 К.${maskField} КАК Н ИЗ ${closed} КАК К`);
  } else {
    record(S, "М2 поле из type_field_masks", "SKIP", "у типа нет масок полей сверх наименования");
  }
  // M-02: решение принимается по выражению, поэтому имя колонки роли не играет.
  await mustMask(S, "М3 К.Наименование КАК Х (переименование)", "Х",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.Наименование КАК Х ИЗ ${closed} КАК К`);
  await mustMask(S, "М4 ПРЕДСТАВЛЕНИЕ(К.Ссылка)", "Н",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕ(К.Ссылка) КАК Н ИЗ ${closed} КАК К`);

  if (maskDoc) {
    await mustMask(S, `М5 Док.${maskDocAttr}.Наименование`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 Док.${maskDocAttr}.Наименование КАК Н ИЗ ${DOC}`);
    await mustMask(S, `М6 (Док.${maskDocAttr}).Наименование`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 (Док.${maskDocAttr}).Наименование КАК Н ИЗ ${DOC}`);
    await mustMask(S, `М8 Т.Р.Наименование через ПОМЕСТИТЬ`, "Н",
      `ВЫБРАТЬ Док.${maskDocAttr} КАК Р ПОМЕСТИТЬ ВТ_М ИЗ ${DOC}`
      + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 Т.Р.Наименование КАК Н ИЗ ВТ_М КАК Т`);
    await mustMask(S, `М8' Т.Аналитика.Наименование (переименованная колонка ВТ)`, "Н",
      `ВЫБРАТЬ Док.${maskDocAttr} КАК Аналитика ПОМЕСТИТЬ ВТ_М2 ИЗ ${DOC}`
      + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 Т.Аналитика.Наименование КАК Н ИЗ ВТ_М2 КАК Т`);
    await mustMask(S, `М8'' наименование материализовано в ВТ`, "Н",
      `ВЫБРАТЬ Док.${maskDocAttr}.Наименование КАК Н ПОМЕСТИТЬ ВТ_М3 ИЗ ${DOC}`
      + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 Т.Н КАК Н ИЗ ВТ_М3 КАК Т`);
    await mustMask(S, `М7 ВЫРАЗИТЬ(Док.${maskDocAttr} КАК закрытый).Наименование`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 ВЫРАЗИТЬ(Док.${maskDocAttr} КАК ${closed}).Наименование КАК Н ИЗ ${DOC}`);
  } else {
    record(S, "М5/М6/М7/М8 через документ", "SKIP", "не нашли документ с реквизитом закрытого типа");
  }

  if (maskRefUuid) {
    await mustMask(S, "М9 ПРЕДСТАВЛЕНИЕ(&Реф) без ИЗ", "Н", "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(&Реф) КАК Н",
      { Реф: { kind: "ref", type: closed, uuid: maskRefUuid } });
    await mustMask(S, "М9' ПРЕДСТАВЛЕНИЕССЫЛКИ(&Реф) без ИЗ", "Н",
      "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕССЫЛКИ(&Реф) КАК Н",
      { Реф: { kind: "ref", type: closed, uuid: maskRefUuid } });
    // Парная проба Д-1: разбор запроса без ИЗ не должен подменять параметр
    // ОТКРЫТОГО типа. Пустая карта источников не разрешает идентификаторы в тип,
    // и единственным источником типа остаётся объявленный клиентом.
    if (fixtures.openRefType && fixtures.openRefUuid) {
      await mustNotMask(O, "О11 ПРЕДСТАВЛЕНИЕ(&РефОткрытого) без ИЗ", "Н",
        "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(&Реф) КАК Н",
        { Реф: { kind: "ref", type: fixtures.openRefType, uuid: fixtures.openRefUuid } });
    } else {
      record(O, "О11 параметр открытого типа без ИЗ", "SKIP", "не получили ссылку открытого типа");
    }
    await mustNotMask(O, "О10 ВЫБРАТЬ &Строка КАК Имя (не ссылка)", "Имя",
      "ВЫБРАТЬ &Строка КАК Имя", { Строка: { kind: "string", value: "контрольное-значение" } });
  } else {
    record(S, "М9 ссылка-параметр", "SKIP", "не получили uuid закрытого объекта");
  }

  // Формы, которые отвергает САМА платформа: проверять на них нечего, и SKIP с
  // текстом «ошибка не privacy» выглядел бы как непроверенное требование.
  record(S, "М9'' &Реф.Наименование", "N/A",
    "платформа отвергает разыменование параметра на этапе разбора;"
    + " канал #110 состоит только из функций представления над параметром");

  // М10 (#113): через табличную часть читалось наименование ВЛАДЕЛЬЦА.
  const tabular = (await callTool("get_metadata_structure", { type: closed })).data?.metadata?.tabular_parts ?? [];
  const tabularName = tabular[0]?.name ?? (typeof tabular[0] === "string" ? tabular[0] : "");
  if (tabularName) {
    await mustMask(S, `М10 К.${tabularName}.Ссылка.Наименование`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 К.${tabularName}.Ссылка.Наименование КАК Н ИЗ ${closed} КАК К`);
    // О3: поля строки табличной части — свои, наименованием владельца не являются.
    await mustNotMask(O, `О3 К.${tabularName}.Представление`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 К.${tabularName}.Представление КАК Н ИЗ ${closed} КАК К`);
  } else {
    record(S, "М10/О3 через табличную часть", "SKIP", "у закрытого типа нет табличных частей");
  }

  // М11: ФИО персон. Обязателен на каждом контуре — это основной класс данных.
  for (const type of fixtures.personTypes) {
    await mustMask(S, `М11 ${type}.Наименование`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Наименование КАК Н ИЗ ${type} КАК Т`);
    await mustMask(S, `М11 ${type}.Ссылка (представление)`, "Р",
      `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Ссылка КАК Р ИЗ ${type} КАК Т`);
  }
  if (!fixtures.personTypes.length) {
    record(S, "М11 персоны", "SKIP", "person_aliases выключены либо справочники персон пусты");
  }

  record(S, "М12 задачи 15 и 22 журнала", "SKIP",
    "прогон журнала — отдельная сессия после деплоя (§8.3)");

  // М13 (M-02.4): наименование материализовано в ВТ. Схема типов такой случай не
  // покрывает по построению — у строковой колонки набор типов пуст.
  await mustMask(S, "М13 наименование материализовано в ВТ", "Н",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.Наименование КАК Н ПОМЕСТИТЬ ВТ_Мат ИЗ ${closed} КАК К`
    + `\n;\nВЫБРАТЬ Т.Н КАК Н ИЗ ВТ_Мат КАК Т`);

  // М14 (M-02.2): имя колонки задаёт первая ветка, закрытое значение — вторая.
  if (fixtures.openCatalog) {
    await mustMask(S, "М14 ОБЪЕДИНИТЬ ВСЕ: закрытый тип во второй ветке", "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 3 О.Наименование КАК Н ИЗ ${fixtures.openCatalog} КАК О`
      + `\nОБЪЕДИНИТЬ ВСЕ\nВЫБРАТЬ ПЕРВЫЕ 3 К.Наименование КАК Н ИЗ ${closed} КАК К`);
  }

  // М15 (M-02.3): скалярный подзапрос в списке выборки.
  await mustMask(S, "М15 скалярный подзапрос над закрытым наименованием", "Н",
    `ВЫБРАТЬ ПЕРВЫЕ 3 (ВЫБРАТЬ ПЕРВЫЕ 1 К.Наименование ИЗ ${closed} КАК К) КАК Н`
    + ` ИЗ ${closed} КАК В`);

  // М16 (M-02.1): у запроса нет ИЗ, и раньше его проекция не разбиралась вовсе.
  if (maskRefUuid) {
    await mustMask(S, "М16 ПРЕДСТАВЛЕНИЕ(&Реф) КАК Имя без ИЗ", "Имя",
      "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(&Реф) КАК Имя",
      { Реф: { kind: "ref", type: closed, uuid: maskRefUuid } });
  }

  // М17 (M-03.2 п.3): два объекта одного закрытого типа в строке. Код чужого
  // объекта хуже скрытого значения — клиент соединил бы разные объекты в один.
  const two = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 5 К1.Наименование КАК Н, К2.Ссылка КАК Р2 ИЗ ${closed} КАК К1,`
    + ` ${closed} КАК К2`, null, 5);
  if (!two.ok || two.isError) {
    record(S, "М17 два объекта одного типа в строке", "SKIP",
      `запрос не выполнился: ${two.transport ?? textOf(two)}`);
  } else {
    const rows = two.data?.rows ?? [];
    const values = rows.map((row) => row.Н);
    const masked = values.filter(isMaskedValue).length;
    const совпало = rows.filter((row) => String(row.Н) === String(row.Р2?.presentation)).length;
    record(S, "М17 два объекта одного типа в строке",
      masked === values.length && values.length > 0 && совпало === 0 ? "PASS" : "FAIL",
      `замаскировано ${masked}/${values.length}, совпало с кодом чужого объекта: ${совпало}`);
  }

  // М18 (M-03.3): вид подстановки решает поле. Код псевдонима в колонке-ДАТЕ или
  // ЧИСЛОВОЙ ломает типизацию у клиента — только на них проба и осмысленна.
  //
  // Отбирать «неименные» поля по имени нельзя: НаименованиеПолное имя-подобное, и
  // М2 обязывает закрыть его кодом псевдонима. Проба по имени противоречила бы М2
  // и давала ложный FAIL — так и вышло на BUH. Вид поля берётся из метаданных.
  const masksOwn = fixtures.maskNonNameFields;
  if (masksOwn.length) {
    const выборка = masksOwn.map((name, i) => `К.${name} КАК П${i}`).join(", ");
    const res18 = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 5 ${выборка} ИЗ ${closed} КАК К`, null, 5);
    if (!res18.ok || res18.isError) {
      record(S, "М18 типизация подстановки у неименных полей", "SKIP",
        `запрос не выполнился: ${res18.transport ?? textOf(res18)}`);
    } else {
      const rows = res18.data?.rows ?? [];
      let кодВНеименном = 0;
      for (const row of rows) {
        for (let i = 0; i < masksOwn.length; i += 1) {
          const v = row[`П${i}`];
          if (typeof v !== "string") continue;
          if (fixtures.maskMarkers.some((p) => p && v.startsWith(p))) кодВНеименном += 1;
        }
      }
      record(S, "М18 типизация подстановки у неименных полей",
        кодВНеименном === 0 ? "PASS" : "FAIL",
        `полей ${masksOwn.length}, строк ${rows.length}, кодов псевдонима в неименных: ${кодВНеименном}`);
    }
  } else {
    record(S, "М18 типизация подстановки у неименных полей", "N/A",
      "в политике нет масок на датовые и числовые поля закрытого типа —"
      + " проверять типизацию подстановки не на чем (на ZUP такие есть: паспортные записи)");
  }

  // М17' (парная к Д-2, тот же класс): Родитель — другой объект того же закрытого
  // типа и единственная ссылка в строке. Фолбэк «одна ссылка типа» дал бы
  // наименованию код группы.
  const res17b = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.Наименование КАК Н, К.Родитель КАК Род ИЗ ${closed} КАК К`
    + ` ГДЕ К.Родитель <> ЗНАЧЕНИЕ(${closed}.ПустаяСсылка)`, null, 5);
  if (!res17b.ok || res17b.isError) {
    record(S, "М17' наименование и Родитель того же типа", "SKIP",
      `запрос не выполнился: ${res17b.transport ?? textOf(res17b)}`);
  } else {
    const rows = res17b.data?.rows ?? [];
    if (!rows.length) {
      record(S, "М17' наименование и Родитель того же типа", "SKIP", "нет строк с непустым Родителем");
    } else {
      const masked = rows.filter((r) => isMaskedValue(r.Н)).length;
      const чужой = rows.filter((r) => r.Род?.presentation && String(r.Н) === String(r.Род.presentation)).length;
      record(S, "М17' наименование и Родитель того же типа",
        masked === rows.length && чужой === 0 ? "PASS" : "FAIL",
        `замаскировано ${masked}/${rows.length}, совпало с кодом родителя: ${чужой}`);
    }
  }

  // Д-3, парные пробы. Пометка ставится по СТАТИЧЕСКОМУ составному типу субконто,
  // а фактический тип значения бывает открытым. Обе стороны обязательны: сужение
  // проверки требует доказать, что закрытое осталось закрытым.
  if (fixtures.accountingReady) {
    const остОткр = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const uuidОткр = await accountRefUuid(ACC_OPEN);
    const uuidЗакр = await accountRefUuid(ACC_CLOSED);
    // Ссылка выбирается РЯДОМ с представлением — только тогда фактический тип
    // известен. Без неё консервативная подмена остаётся правильным поведением.
    if (uuidОткр) {
      await mustNotMask(O, `О12 ПРЕДСТАВЛЕНИЕ(О.Субконто1) на счёте ${ACC_OPEN} (открытый тип)`, "Н",
        `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕ(О.Субконто1) КАК Н, О.Субконто1 КАК С ИЗ ${остОткр}`,
        { Дата: { kind: "datetime", value: `${PROBE_DATE}T00:00:00` },
          Счет: { kind: "ref", type: ACC_PLAN, uuid: uuidОткр } });
    } else {
      record(O, `О12 открытые субконто счёта ${ACC_OPEN}`, "SKIP", "счёт не найден, задайте ACC_OPEN");
    }
    if (uuidЗакр) {
      await mustMask(S, `М20 ПРЕДСТАВЛЕНИЕ(О.Субконто1) на счёте ${ACC_CLOSED} (закрытый тип)`, "Н",
        `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕ(О.Субконто1) КАК Н, О.Субконто1 КАК С ИЗ ${остОткр}`,
        { Дата: { kind: "datetime", value: `${PROBE_DATE}T00:00:00` },
          Счет: { kind: "ref", type: ACC_PLAN, uuid: uuidЗакр } });
    } else {
      record(S, `М20 закрытые субконто счёта ${ACC_CLOSED}`, "SKIP", "счёт не найден, задайте ACC_CLOSED");
    }
    // Форма без ссылки в проекции: фактический тип неизвестен, подмена обязана
    // остаться — это заявленная граница фикса, а не дефект.
    await mustMask(S, "М21 представление субконто без ссылки в проекции", "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕ(О.Субконто1) КАК Н ИЗ ${остОткр}`, accountingParams());
  } else {
    record(S, "М20/М21/О12 составное субконто", "SKIP", "нет остатков для фикстуры");
  }

  // М19: известная граница механизма — у вычисления типа нет. Фиксируем факт,
  // а не выносим вердикт: это §12 ТЗ, а не дефект.
  const calc = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.Наименование + "" КАК Н ИЗ ${closed} КАК К`, null, 5);
  if (!calc.ok || calc.isError) {
    record(S, "М19 вычисление над закрытым наименованием", "SKIP",
      `запрос не выполнился: ${calc.transport ?? textOf(calc)}`);
  } else {
    const values = (calc.data?.rows ?? []).map((row) => row.Н).filter(nonEmpty);
    const masked = values.filter(isMaskedValue).length;
    record(S, "М19 вычисление над закрытым наименованием", "SKIP",
      `граница механизма: замаскировано ${masked}/${values.length};`
      + " тип вычисления не выводится, значение уходит открытым (§12)");
  }

  // ------------------------------------------------------------------ §8.2
  if (maskDoc) {
    await mustNotMask(O, `О4 Док.${maskDocAttr}.ПометкаУдаления`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 Док.${maskDocAttr}.ПометкаУдаления КАК Н ИЗ ${DOC}`);
  }
  if (fixtures.accountingReady) {
    const ost = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const par = { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` },
      Счет: { kind: "string", value: ACC_ACCOUNT } };
    await mustNotMask(O, "О1 (О.Организация).Наименование — открытый тип", "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 (О.Организация).Наименование КАК Н ИЗ ${ost}`, par);
    await mustNotMask(O, "О2 ПРЕДСТАВЛЕНИЕ(О.Счет) — план счетов", "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕ(О.Счет) КАК Н ИЗ ${ost}`, par);
    // О5, форма задачи 19: цепочка ВТ→ВТ на открытых типах.
    await mustNotMask(O, "О5 задача 19: Т.Счет.Наименование через цепочку ВТ", "НазваниеСчета",
      `ВЫБРАТЬ О.Счет КАК Счет, О.Валюта КАК Валюта ПОМЕСТИТЬ ВТ_Ост ИЗ ${ost}`
      + `\n;\nВЫБРАТЬ Т.Счет КАК Счет, Т.Валюта КАК Валюта ПОМЕСТИТЬ ВТ_Свод ИЗ ВТ_Ост КАК Т`
      + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 С.Счет.Код КАК КодСчета, С.Счет.Наименование КАК НазваниеСчета,`
      + ` С.Валюта.Код КАК КодВалюты ИЗ ВТ_Свод КАК С`, par);
  } else {
    record(O, "О1/О2/О5 через регистр бухгалтерии", "SKIP", "нет остатков для фикстуры");
  }

  // О7 (M-03.1): ссылку подменять значением нельзя — потеряются uuid и
  // navigation_url, по которым пользователь расшифровывает псевдоним.
  const ref = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.Ссылка КАК Р ИЗ ${closed} КАК К`, null, 5);
  if (!ref.ok || ref.isError) {
    record(O, "О7 ссылка сохраняет uuid", "SKIP", `запрос не выполнился: ${ref.transport ?? textOf(ref)}`);
  } else {
    const rows = ref.data?.rows ?? [];
    const сUuid = rows.filter((row) => row.Р && typeof row.Р === "object" && row.Р.uuid).length;
    const представленияПодменены = rows.filter((row) => isMaskedValue(row.Р?.presentation)).length;
    record(O, "О7 ссылка сохраняет uuid, подменено только представление",
      rows.length > 0 && сUuid === rows.length && представленияПодменены === rows.length
        ? "PASS" : "FAIL",
      `строк ${rows.length}, с uuid ${сUuid}, представлений подменено ${представленияПодменены}`);
  }

  if (fixtures.openCatalog) {
    // О8 — контроль к М15: подзапрос над открытым типом подменять нельзя.
    await mustNotMask(O, "О8 скалярный подзапрос над открытым типом", "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 3 (ВЫБРАТЬ ПЕРВЫЕ 1 О.Наименование ИЗ ${fixtures.openCatalog} КАК О) КАК Н`
      + ` ИЗ ${fixtures.openCatalog} КАК В`);
    // О9 — прежде контроль к M-02.6 («у ВЫБРАТЬ * один элемент проекции и много
    // колонок, позиционное сопоставление применяться не должно»). После P-0 форма
    // до сопоставления не доходит: её отклоняет предвалидатор. Проверять на ней
    // «не подменяет» больше нечего, но требование отказа — есть.
    await mustRejectWildcard(O, "О9 ВЫБРАТЬ * из ОТКРЫТОГО справочника отклоняется",
      `ВЫБРАТЬ ПЕРВЫЕ 5 * ИЗ ${fixtures.openCatalog} КАК К`);
  }
  // О10 — контроль к M-02.1: у запроса без ИЗ проекция теперь разбирается, но
  // открытое значение подменять всё равно нельзя.
  await mustNotMask(O, "О10 запрос без ИЗ над открытым значением", "Имя",
    "ВЫБРАТЬ &Строка КАК Имя", { Строка: { kind: "string", value: "открытое значение" } });

  // О6: стабильность псевдонима в одном ответе. Одно и то же выражение в двух
  // колонках обязано дать одно значение, иначе соединение строк у клиента развалится.
  const stab = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 10 К.Ссылка КАК Р, К.Наименование КАК Н1, К.Наименование КАК Н2 ИЗ ${closed} КАК К`,
    null, 10);
  if (!stab.ok || stab.isError) {
    record(O, "О6 стабильность псевдонима", "SKIP", `запрос не выполнился: ${stab.transport ?? textOf(stab)}`);
  } else {
    const rows = stab.data?.rows ?? [];
    const поКолонкам = rows.every((row) => String(row.Н1) === String(row.Н2));
    const поОбъектам = new Map();
    let расхождений = 0;
    for (const row of rows) {
      const uuid = row.Р?.uuid;
      if (!uuid) continue;
      if (поОбъектам.has(uuid) && поОбъектам.get(uuid) !== String(row.Н1)) расхождений += 1;
      поОбъектам.set(uuid, String(row.Н1));
    }
    record(O, "О6 один объект — один псевдоним",
      поКолонкам && расхождений === 0 ? "PASS" : "FAIL",
      `строк ${rows.length}, колонки совпали: ${поКолонкам}, расхождений по объектам: ${расхождений}`);
  }
}

async function section7() {
  const { closed, docType, docAttr, refUuid } = fixtures;
  const S = "§7 обязан работать";
  const par = { Реф: { kind: "ref", type: closed, uuid: refUuid } };

  if (fixtures.accountingReady) {
    const ost = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const parAcc = { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` }, Счет: { kind: "string", value: ACC_ACCOUNT } };
    await mustPass(S, "B1 ПРЕДСТАВЛЕНИЕ(О.Организация)", `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(О.Организация) КАК Н ИЗ ${ost}`, parAcc);
    await mustPass(S, "B2 ПРЕДСТАВЛЕНИЕ(О.Счет)", `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(О.Счет) КАК Н ИЗ ${ost}`, parAcc);
    await mustPass(S, "B3 ПРЕДСТАВЛЕНИЕ(Т.Организация) через ВТ",
      `ВЫБРАТЬ О.Организация КАК Организация ПОМЕСТИТЬ ВТ_О ИЗ ${ost}\n;\nВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(Т.Организация) КАК Н ИЗ ВТ_О КАК Т`, parAcc);
    await mustPass(S, "B4 сама ссылка О.Субконто2", `ВЫБРАТЬ ПЕРВЫЕ 3 О.Субконто2 КАК С ИЗ ${ost}`, parAcc);
    await mustPass(S, "B5 ВЫРАЗИТЬ без разыменования",
      `ВЫБРАТЬ ПЕРВЫЕ 3 ВЫРАЗИТЬ(О.Субконто1 КАК ${closed}) КАК С ИЗ ${ost}`, parAcc);
    await mustPass(S, "B10 отбор по ссылке-параметру",
      `ВЫБРАТЬ ПЕРВЫЕ 3 О.Субконто1 КАК С ИЗ ${ost} ГДЕ О.Субконто1 = &Реф`,
      { ...parAcc, ...par });
  } else {
    record(S, "B1–B5, B10 через регистр бухгалтерии", "SKIP", "нет остатков для фикстуры");
  }

  if (docType) {
    await mustPass(S, `B6 Док.${docAttr}.ПометкаУдаления`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 Док.${docAttr}.ПометкаУдаления КАК Н ИЗ ${docType} КАК Док`);
    // B15/B16 (#112): скобки без разыменования и разыменование незакрытого поля
    // обязаны работать — иначе отказ получит почти любой боевой запрос.
    await mustPass(S, `B15 (Док.${docAttr}) — скобки без разыменования`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}) КАК Р ИЗ ${docType} КАК Док`);
    await mustPass(S, `B16 (Док.${docAttr}).ПометкаУдаления — поле не закрыто`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}).ПометкаУдаления КАК Н ИЗ ${docType} КАК Док`);
    await mustPass(S, "B8 чтение колонки ВТ без разыменования",
      `ВЫБРАТЬ Док.${docAttr} КАК Р ПОМЕСТИТЬ ВТ_Р ИЗ ${docType} КАК Док\n;\nВЫБРАТЬ ПЕРВЫЕ 3 Т.Р КАК Р ИЗ ВТ_Р КАК Т`);
  } else {
    record(S, "B6/B8 через документ", "SKIP", "не нашли документ с реквизитом закрытого типа");
  }

  await mustPass(S, "B9 ссылка-параметр в выводе", "ВЫБРАТЬ &Реф КАК Р", par, (data) => {
    const p = data?.rows?.[0]?.Р?.presentation;
    return `presentation=${JSON.stringify(p)}${fixtures.closedPrefix && String(p).startsWith(fixtures.closedPrefix)
      ? " (псевдоним)" : " — проверьте, что это псевдоним, а не имя"}`;
  });
  if (fixtures.accountingReady) {
    const ost3 = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const par3 = { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` }, Счет: { kind: "string", value: ACC_ACCOUNT } };
    // B13 стоит ниже, рядом с остальными контролями R-04 варианта 2.
    await mustPass(S, "B14 (СУММА(О.СуммаОстаток)) — скобки без разыменования",
      `ВЫБРАТЬ (СУММА(О.СуммаОстаток)) КАК С ИЗ ${ost3}`, par3);
  }
  await mustPass(S, "B11 УПОРЯДОЧИТЬ ПО ссылке без АВТОУПОРЯДОЧИВАНИЕ",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.Ссылка КАК Р ИЗ ${closed} КАК К УПОРЯДОЧИТЬ ПО К.Ссылка`);
  // Табличная часть закрытого типа: её поля — свои, закрытыми полями владельца
  // не проверяются. Прямая проверка, что снятие fail-open (R-03) не задело их.
  const tabular = (await callTool("get_metadata_structure", { type: closed })).data?.metadata?.tabular_parts ?? [];
  const tabularName = (tabular[0]?.name) ?? (typeof tabular[0] === "string" ? tabular[0] : "");
  if (tabularName) {
    await mustPass(S, `B12 К.${tabularName}.Представление (табличная часть закрытого типа)`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 К.${tabularName}.Представление КАК Н ИЗ ${closed} КАК К`);
    // Обратная сторона B12: исключение табличных частей из R-03 не должно
    // распространяться на хвост за сегментом Ссылка — она ведёт НА ВЛАДЕЛЬЦА,
    // и это его закрытые поля. Живьём эти формы отдавали вложенную таблицу с
    // настоящими наименованиями. Отказа больше нет — значение обязано быть
    // подменено, а строки обязаны вернуться.
    const T = "§8.1 обязан подменить";
    await mustMask(T, `т4 К.${tabularName}.Ссылка.Наименование`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 К.${tabularName}.Ссылка.Наименование КАК Н ИЗ ${closed} КАК К`);
    await mustMask(T, `т6 К.${tabularName}.Ссылка.НаименованиеПолное`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 К.${tabularName}.Ссылка.НаименованиеПолное КАК Н ИЗ ${closed} КАК К`);
    await mustMask(T, `т5 Т.Ссылка.Наименование из ${tabularName} как источника`, "Н",
      `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Ссылка.Наименование КАК Н ИЗ ${closed}.${tabularName} КАК Т`);
    await mustPass(S, `B19 К.${tabularName}.Ссылка (сама ссылка владельца)`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 К.${tabularName}.Ссылка КАК Р ИЗ ${closed} КАК К`);
  } else {
    record(S, "B12 табличная часть закрытого типа", "SKIP", "у закрытого типа нет табличных частей");
  }
  await mustRejectWildcard(S, "B7 ВЫБРАТЬ * из ЗАКРЫТОГО справочника отклоняется",
    `ВЫБРАТЬ ПЕРВЫЕ 3 * ИЗ ${closed} КАК К`);

  // I (#112): правило про скобки не должно задевать открытые типы и скобки без
  // разыменования — иначе отказ получит почти любой боевой запрос с ВТ.
  if (fixtures.accountingReady) {
    const ost = `${ACC_REGISTER}.Остатки(&Дата, Счет В ИЕРАРХИИ (&Счет), , ) КАК О`;
    const parAcc = { Дата: { kind: "date", value: `${PROBE_DATE}T00:00:00` }, Счет: { kind: "string", value: ACC_ACCOUNT } };
    await mustPass(S, "B13 (О.Организация).Наименование — открытый тип",
      `ВЫБРАТЬ ПЕРВЫЕ 3 (О.Организация).Наименование КАК Н ИЗ ${ost}`, parAcc);
    // R-04 вариант 2, главный контроль: разыменование колонок ВТ открытых типов.
    // Форма задачи 19 журнала — цепочка ВТ→ВТ, на которой вариант 1 давал
    // ложный отказ, потому что виды субконто плана счетов делали закрытый тип
    // «достижимым» в любом бухгалтерском запросе (§0.1 п.4).
    await mustPass(S, "B17 задача 19: Т.Счет.Код и Т.Валюта.Код через цепочку ВТ",
      `ВЫБРАТЬ О.Счет КАК Счет, О.Валюта КАК Валюта ПОМЕСТИТЬ ВТ_Ост ИЗ ${ost}`
      + `\n;\nВЫБРАТЬ Т.Счет КАК Счет, Т.Валюта КАК Валюта ПОМЕСТИТЬ ВТ_Свод ИЗ ВТ_Ост КАК Т`
      + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 С.Счет.Код КАК КодСчета, С.Счет.Наименование КАК НазваниеСчета,`
      + ` С.Валюта.Код КАК КодВалюты ИЗ ВТ_Свод КАК С`, parAcc);
    await mustPass(S, "B18 ПРЕДСТАВЛЕНИЕ колонки ВТ открытого типа",
      `ВЫБРАТЬ О.Организация КАК Орг ПОМЕСТИТЬ ВТ_Орг ИЗ ${ost}`
      + `\n;\nВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(Т.Орг) КАК Н ИЗ ВТ_Орг КАК Т`, parAcc);
    await mustPass(S, "B14 (СУММА(О.СуммаОстаток)) без разыменования",
      `ВЫБРАТЬ (СУММА(О.СуммаОстаток)) КАК С ИЗ ${ost}`, parAcc);
  } else {
    record(S, "B13/B14 через регистр бухгалтерии", "SKIP", "нет остатков для фикстуры");
  }
  if (docType) {
    await mustPass(S, `B15 (Док.${docAttr}) без разыменования`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}) КАК Р ИЗ ${docType} КАК Док`);
    await mustPass(S, `B16 (Док.${docAttr}).ПометкаУдаления — поле не закрыто`,
      `ВЫБРАТЬ ПЕРВЫЕ 3 (Док.${docAttr}).ПометкаУдаления КАК Н ИЗ ${docType} КАК Док`);
  } else {
    record(S, "B15/B16 через документ", "SKIP", "не нашли документ с реквизитом закрытого типа");
  }
}

// Формы запросов, которые обязаны проходить независимо от политики privacy.
// Смысл набора — второй контур из §7 ТЗ: правки меняют разбор любого запроса, а
// карта источников используется и pre-flight проверками вне privacy, поэтому
// подзапрос-источник, временная таблица, разыменование в скобках и функции с
// пробелами должны работать и там, где закрывать нечего.
async function sectionShapes() {
  const S = "формы запросов (любая политика)";

  // Открытый справочник с данными: фикстура для форм.
  const catalogs = (await callTool("list_metadata_objects", { kinds: ["Справочник"], limit: 40 })).data?.objects ?? [];
  for (const item of catalogs.slice(0, 15)) {
    if (!item.full_name) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Р ИЗ ${item.full_name} КАК Т`, null, 1);
    if (probe.data?.rows?.[0]?.Р?.uuid) { fixtures.openCatalog = item.full_name; break; }
  }
  if (!fixtures.openCatalog) {
    return record(S, "фикстура: справочник с данными", "SKIP", "не нашли непустой справочник");
  }
  const К = fixtures.openCatalog;
  console.log(`фикстура форм: ${К}\n`);

  await mustPass(S, "путь с разыменованием через Ссылка",
    `ВЫБРАТЬ ПЕРВЫЕ 3 Т.Ссылка.Наименование КАК Н ИЗ ${К} КАК Т`);
  // Родитель есть только у иерархического справочника: проверяем наличие поля
  // отдельно, иначе SKIP выглядит как дефект гейта.
  const hier = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Родитель КАК Р ИЗ ${К} КАК Т`, null, 1);
  if (hier.isError) {
    record(S, "путь через Родитель", "SKIP", `${К} не иерархический — формы с Родитель проверяются на BUH`);
  } else {
    await mustPass(S, "путь через Родитель",
      `ВЫБРАТЬ ПЕРВЫЕ 3 Т.Родитель.Наименование КАК Н ИЗ ${К} КАК Т`);
  }
  await mustPass(S, "ПРЕДСТАВЛЕНИЕ(Т.Ссылка)",
    `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК Н ИЗ ${К} КАК Т`);
  await mustPass(S, "ПРЕДСТАВЛЕНИЕ ( Т.Ссылка ) — пробелы вокруг аргумента",
    `ВЫБРАТЬ ПЕРВЫЕ 3 ПРЕДСТАВЛЕНИЕ ( Т.Ссылка ) КАК Н ИЗ ${К} КАК Т`);
  await mustPass(S, "подзапрос-источник и чтение его колонки",
    `ВЫБРАТЬ ПЕРВЫЕ 3 П.Р КАК Р ИЗ (ВЫБРАТЬ Т.Ссылка КАК Р ИЗ ${К} КАК Т) КАК П`);
  await mustPass(S, "подзапрос-источник и разыменование его колонки",
    `ВЫБРАТЬ ПЕРВЫЕ 3 П.Р.Наименование КАК Н ИЗ (ВЫБРАТЬ Т.Ссылка КАК Р ИЗ ${К} КАК Т) КАК П`);
  // Псевдоним не «В»: это зарезервированное слово языка запросов (В (…)).
  await mustPass(S, "временная таблица и разыменование её колонки",
    `ВЫБРАТЬ Т.Ссылка КАК Р ПОМЕСТИТЬ ВТ_Ф ИЗ ${К} КАК Т\n;\nВЫБРАТЬ ПЕРВЫЕ 3 Т2.Р.Наименование КАК Н ИЗ ВТ_Ф КАК Т2`);
  await mustPass(S, "временная таблица: чтение колонки без разыменования",
    `ВЫБРАТЬ Т.Ссылка КАК Р ПОМЕСТИТЬ ВТ_Ф2 ИЗ ${К} КАК Т\n;\nВЫБРАТЬ ПЕРВЫЕ 3 Т2.Р КАК Р ИЗ ВТ_Ф2 КАК Т2`);
  await mustPass(S, "разыменование выражения в скобках (#112)",
    `ВЫБРАТЬ ПЕРВЫЕ 3 (Т.Ссылка).Наименование КАК Н ИЗ ${К} КАК Т`);
  await mustPass(S, "разыменование после ВЫРАЗИТЬ",
    `ВЫБРАТЬ ПЕРВЫЕ 3 ВЫРАЗИТЬ(Т.Ссылка КАК ${К}).Наименование КАК Н ИЗ ${К} КАК Т`);
  await mustPass(S, "АВТОУПОРЯДОЧИВАНИЕ",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Ссылка КАК Р ИЗ ${К} КАК Т УПОРЯДОЧИТЬ ПО Т.Ссылка АВТОУПОРЯДОЧИВАНИЕ`);
  await mustPass(S, "ОБЪЕДИНИТЬ ВСЕ с представлением в ветке",
    `ВЫБРАТЬ ПЕРВЫЕ 2 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК Н ИЗ ${К} КАК Т`
    + `\nОБЪЕДИНИТЬ ВСЕ\nВЫБРАТЬ ПЕРВЫЕ 2 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК Н ИЗ ${К} КАК Т`);
}

// ------------------------------------------------------------------ main

(async () => {
  const ready = await discover();
  if (ready) {
    await sectionShapes();
    if (!fixtures.maskOff) {
      await sectionMask();
    }
    if (!fixtures.policyOff) {
      await section7();
    }
  }

  console.log(`\nИтог: PASS ${passed}, FAIL ${failed}, SKIP ${skipped}, N/A ${notApplicable}`);
  if (failed > 0) {
    console.log("FAIL в §8.1 — личные данные уходят открытыми; FAIL в §8.2 — подмена"
      + " сработала на открытом типе и молча испортила аналитику;"
      + " FAIL в §7 — форма, которая обязана выполняться, не выполнилась.");
  }
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({
      url: URL_MCP, fixtures, summary: { passed, failed, skipped, notApplicable }, results,
    }, null, 2), "utf8");
    console.log(`JSON: ${JSON_OUT}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
})();
