// Приёмка снятия deny (PR #116, задача #114 пункт 2). Проверяет ровно то, что
// изменила эта правка, и ничего больше: матрица §8 остаётся за
// privacy_gate_probe.mjs, а контракт целиком — за mcp_contract_test.mjs.
//
// Контракт после правки: отказов нет ни в одной форме. Поэтому каждая проба
// двойная — «запрос принят» И «значение подменено». Одна половина ничего не
// доказывает: принятый запрос с открытым названием хуже отказа.
//
// Запуск (по контуру за раз либо все три подряд):
//   node scripts/privacy_drop_deny_probe.mjs
//   node scripts/privacy_drop_deny_probe.mjs --all
//   MCP_URL=https://host/BASE/hs/mcp/rpc node scripts/privacy_drop_deny_probe.mjs
//   --json reports/privacy_drop_deny_<контур>_2026-08-05.json
//
// Значения контура наружу не выводятся ни в консоль, ни в JSON: вердикт строится
// на структурном признаке замаскированности, а не на сверке с эталоном имён.
// Имена метаданных не захардкожены — закрытые типы берутся из живого
// get_current_user_context, носители закрытых ссылок ищутся интроспекцией.
//
// Транспорт node:https: undici рвёт connect на жёстких 10 с через VPN, что
// выглядит как «упал контур». Сертификат контура самоподписанный.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request } from "node:https";
import { URL } from "node:url";

const CONTOURS = {
  BUH_KORP: "https://laba-1c.astondevs.ru/BUH_KORP/hs/mcp/rpc",
  ZUP_CORP: "https://laba-1c.astondevs.ru/ZUP_CORP/hs/mcp/rpc",
  ERP_DEMO: "https://laba-1c.astondevs.ru/ERP_DEMO/hs/mcp/rpc",
};

// Ревизия, которую обязан вернуть контур с этой сборкой. Несовпадение означает,
// что деплой не дошёл, и весь прогон бессмысленен — тогда проба останавливается,
// а не выдаёт «зелёную» матрицу по старому коду.
// Значение переопределяется без правки файла: --revision <знач> или MCP_EXPECTED_REVISION.
// Захардкоженная константа делала пробу непригодной на следующий же день после
// деплоя — прогон вставал на разделе Р, и приёмку гоняли копией скрипта.
const revFlag = process.argv.indexOf("--revision");
const EXPECTED_REVISION =
  (revFlag > -1 ? process.argv[revFlag + 1] : "") ||
  process.env.MCP_EXPECTED_REVISION ||
  // Дефолт равен ревизии самой свежей сборки. Пин на пятидневной давности делал
  // ровно то, о чём предупреждает комментарий выше: раздел Р давал «ревизия не
  // совпала», остальные разделы уходили в SKIP, и проба выглядела честной, пропуская
  // при этом весь регресс. Волна 2 поднимает ревизию до .2 — поднимается и дефолт.
  "2026-08-10.4";

// Коды, которых в контракте больше нет. Появление любого — старая сборка.
const REMOVED_CODES = ["privacy_denied_field", "privacy_denied_autoorder", "privacy_config_error"];

const ALL = process.argv.includes("--all");
const jsonFlag = process.argv.indexOf("--json");
const JSON_OUT = jsonFlag > -1 ? process.argv[jsonFlag + 1] : "";
const BASIC = process.env.MCP_BASIC || "";

let URL_MCP = process.env.MCP_URL || CONTOURS.BUH_KORP;

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
  // Без заголовка версии протокола кастомные методы отдают -32601.
  "mcp-protocol-version": "2025-11-25",
};
if (BASIC) HEADERS.authorization = `Basic ${Buffer.from(BASIC).toString("base64")}`;

let rpcId = 0;

function rpc(method, params) {
  const target = new URL(URL_MCP);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
  const options = {
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: "POST",
    headers: { ...HEADERS, "content-length": Buffer.byteLength(payload) },
    rejectUnauthorized: false,
    timeout: 120000,
  };
  return new Promise((resolve) => {
    const req = request(options, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: text.slice(0, 500) });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, body: null, raw: String(err.message || err) }));
    req.write(payload);
    req.end();
  });
}

// Транспортные обрывы на этом контуре штатны: повтор решает задачу без всякого
// ожидания «восстановления», поэтому одиночный обрыв не должен давать SKIP.
async function callTool(name, args, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const { body, raw } = await rpc("tools/call", { name, arguments: args });
    if (raw && !body) {
      if (attempt === tries) return { ok: false, transport: raw };
      continue;
    }
    if (body?.error) return { ok: false, error: body.error };
    const structured = body?.result?.structuredContent;
    const isError = body?.result?.isError === true;
    if (structured) return { ok: true, data: structured, isError };
    const textPayload = body?.result?.content?.[0]?.text;
    try {
      return { ok: true, data: JSON.parse(textPayload ?? "null"), isError };
    } catch {
      return { ok: true, data: { raw: textPayload }, isError };
    }
  }
  return { ok: false, transport: "не удалось после повторов" };
}

const runQuery = (query, parameters, limit = 5) =>
  callTool("run_1c_query", parameters ? { query, parameters, limit } : { query, limit });

// ------------------------------------------------------- коды и признаки

const codesOf = (res) => [
  ...(res?.data?.validation?.errors ?? []).map((i) => i.code),
  ...(res?.data?.errors ?? []).map((i) => i.code),
  res?.error?.code ?? "",
  res?.data?.error?.code ?? "",
  res?.data?.code ?? "",
].filter(Boolean);

const textOf = (res) => JSON.stringify(res?.data ?? res?.error ?? {}).slice(0, 300);

// Признак отказа. Кроме кодов ловится и текст: старая сборка объясняла отказ
// словами «закрыто privacy-политикой (mode: deny)», и по коду её видно не всегда.
const refused = (res) =>
  codesOf(res).some((c) => REMOVED_CODES.includes(c)) || /privacy-политикой/.test(textOf(res));

const STRING_MASK = "XXXXXXX";
const DATE_MASK = "1900-01-01T00:00:00";

const fixtures = {
  revision: "",
  policyPresent: false,
  configErrors: [],
  configWarnings: [],
  markers: [],          // префиксы псевдонимов, включая легаси
  closed: "",           // закрытый справочник с данными
  closedNameField: "",  // имя-подобное поле закрытого типа
  nameFieldCandidates: [],
  refUuid: "",
  owned: "",            // подчинённый справочник закрытого типа
  openCatalog: "",      // справочник вне политики
  numericMaskField: "", // числовое поле, перечисленное в масках
  maskRegisterEntry: null, // запись type_field_masks вида РегистрСведений.* (R-8/R-9)
  policyTypes: [],      // все типы политики — для проверки ссылок в строках
  emergency: false,
};

// Пустое значение маской НЕ считается: для «числа не закрываются» и для парных
// проб нужно различать «подменено» и «стёрто». В privacy_gate_probe.mjs пустое
// считается замаскированным — там это уместно, здесь дало бы ложный PASS.
function looksMasked(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "object") {
    if ("presentation" in value) return looksMasked(value.presentation);
    return Object.values(value).some(looksMasked);
  }
  const text = String(value);
  if (!text.length) return false;
  if (text === STRING_MASK || text === DATE_MASK) return true;
  if (text.endsWith("скрыто")) return true;
  return fixtures.markers.some((p) => p && text.startsWith(p));
}

// ------------------------------------------------------------------ отчёт

let results = [];
let passed = 0, failed = 0, skipped = 0, notApplicable = 0;

function record(section, name, verdict, detail) {
  results.push({ contour: currentName, section, name, verdict, detail });
  if (verdict === "PASS") passed += 1;
  else if (verdict === "FAIL") failed += 1;
  else if (verdict === "N/A") notApplicable += 1;
  else skipped += 1;
  // N/A отделён от SKIP намеренно: SKIP — «проверить не удалось», требует
  // разбора; N/A — «проверять нечем по существу» (в политике нет подходящего
  // поля, форму отвергает платформа). Смешивать значит прятать первое во втором.
  const mark = verdict === "PASS" ? "OK  " : verdict === "FAIL" ? "FAIL" : verdict === "N/A" ? "N/A " : "SKIP";
  console.log(`${mark} | ${section} | ${name}${detail ? `\n       ${detail}` : ""}`);
}

const check = (section, name, ok, detail) => record(section, name, ok ? "PASS" : "FAIL", detail);

let currentName = "";

// Двойная проба: форма обязана быть ПРИНЯТА и значение обязано быть ПОДМЕНЕНО.
async function acceptedAndMasked(section, name, column, query, parameters) {
  const validation = await callTool("validate_1c_query", parameters ? { query, parameters } : { query });
  if (!validation.ok) return record(section, name, "SKIP", `транспорт: ${validation.transport ?? ""}`);
  if (refused(validation)) {
    return record(section, `${name} — принят`, "FAIL",
      `ОТКАЗ, которого не должно быть: ${codesOf(validation).join(", ")} ${textOf(validation)}`);
  }
  record(section, `${name} — принят`, "PASS", "");

  const run = await runQuery(query, parameters, 10);
  if (!run.ok) return record(section, `${name} — подмена`, "SKIP", `транспорт: ${run.transport ?? ""}`);
  if (refused(run)) {
    return record(section, `${name} — подмена`, "FAIL", `ОТКАЗ на исполнении: ${textOf(run)}`);
  }
  if (run.isError) {
    // Ошибка не privacy (форма недопустима платформой, пустая выборка) — это не
    // провал подмены, но и не проверка: разбирать вручную.
    return record(section, `${name} — подмена`, "SKIP", `ошибка не privacy: ${textOf(run)}`);
  }
  const rows = run.data?.rows ?? [];
  if (!rows.length) return record(section, `${name} — подмена`, "SKIP", "ноль строк, нет фикстуры");

  const values = rows.map((r) => r[column]);
  const заполненных = values.filter((v) => v !== null && v !== undefined && v !== "").length;
  const подменённых = values.filter(looksMasked).length;
  if (заполненных === 0) {
    return record(section, `${name} — подмена`, "SKIP", `строк ${rows.length}, все значения пусты`);
  }
  check(section, `${name} — подмена`, подменённых === заполненных,
    `строк ${rows.length}, заполненных ${заполненных}, подменённых ${подменённых}`);
}

// Парная проба: значение открытого типа обязано остаться ОТКРЫТЫМ. Без этой
// половины «стало разрешено» ничего не доказывает — подмена наугад ломает
// аналитику молча, и именно так уже ломались дашборды (Д-3).
async function acceptedAndOpen(section, name, column, query, parameters) {
  const run = await runQuery(query, parameters, 10);
  if (!run.ok) return record(section, name, "SKIP", `транспорт: ${run.transport ?? ""}`);
  if (refused(run)) return record(section, name, "FAIL", `ОТКАЗ: ${textOf(run)}`);
  if (run.isError) return record(section, name, "SKIP", `ошибка не privacy: ${textOf(run)}`);
  const rows = run.data?.rows ?? [];
  if (!rows.length) return record(section, name, "SKIP", "ноль строк, нет фикстуры");
  const values = rows.map((r) => r[column]).filter((v) => v !== null && v !== undefined && v !== "");
  if (!values.length) return record(section, name, "SKIP", "все значения пусты");
  const подменённых = values.filter(looksMasked).length;
  check(section, name, подменённых === 0,
    подменённых === 0 ? `строк ${rows.length}, открыты все` : `ЛОЖНАЯ ПОДМЕНА в ${подменённых} из ${values.length}`);
}

// ------------------------------------------------------------- фикстуры

async function discover() {
  const ctx = await callTool("get_current_user_context", {});
  if (!ctx.ok) {
    record("Р развёртывание", "get_current_user_context", "SKIP",
      `контур недоступен: ${ctx.transport ?? JSON.stringify(ctx.error)}`);
    return false;
  }
  const p = ctx.data?.privacy;
  if (!p) {
    record("Р развёртывание", "блок privacy в ответе", "FAIL", "блока нет — MCP_Tools старый");
    return false;
  }

  fixtures.revision = p.engine_revision ?? "";
  fixtures.configErrors = p.config_errors ?? [];
  fixtures.configWarnings = p.config_warnings ?? [];
  fixtures.emergency = fixtures.configErrors.length > 0;

  // Р1 — доказательство деплоя. Дальше идти смысла нет: на старой сборке
  // «принят» означал бы не снятие deny, а его отсутствие в политике.
  check("Р развёртывание", `engine_revision = ${EXPECTED_REVISION}`,
    fixtures.revision === EXPECTED_REVISION, `получено: ${fixtures.revision || "нет"}`);
  if (fixtures.revision !== EXPECTED_REVISION) {
    record("Р развёртывание", "остальные пробы", "SKIP",
      "ревизия не совпала: прогон на старой сборке ничего не доказывает");
    return false;
  }

  const aliases = p.type_aliases?.entries ?? [];
  const masks = p.type_field_masks?.entries ?? [];

  // Р2 — поле mode ушло из публикуемого контракта.
  const withMode = [...aliases, ...masks].filter((e) => e.mode !== undefined).length;
  check("Р развёртывание", "поля mode нет в опубликованных записях", withMode === 0,
    withMode === 0 ? "" : `записей с mode: ${withMode} — контракт не обновлён`);

  // Р3 — аварийный режим: наблюдаем, не устраиваем. Как его вызвать намеренно —
  // в doc/testplan_privacy_drop_deny_2026-08-05.md, раздел «Аварийный режим».
  record("Р развёртывание", "аварийный режим", fixtures.emergency ? "PASS" : "N/A",
    fixtures.emergency
      ? `config_errors: ${fixtures.configErrors.length} — секция не прочитана, ждём максимальную маску`
      : "config_errors пуст: политика читается, аварийный режим проверяется отдельно вручную");

  fixtures.policyPresent = aliases.length > 0 || masks.length > 0;
  fixtures.policyTypes = [...aliases, ...masks].map((e) => String(e.type)).filter(Boolean);
  fixtures.maskRegisterEntry =
    masks.find((e) => String(e.type).startsWith("РегистрСведений.")) ?? null;
  for (const e of aliases) if (e.prefix) fixtures.markers.push(e.prefix);
  // Легаси-псевдонимы задают префикс не в type_aliases.
  for (const legacy of ["Орг-", "ФЛ-", "Сотр-", "Польз-"]) fixtures.markers.push(legacy);
  const orgPrefix = p.organization_aliases?.prefix;
  if (orgPrefix) fixtures.markers.push(orgPrefix);
  for (const key of ["prefix", "employee_prefix", "user_prefix"]) {
    const v = p.person_aliases?.[key];
    if (v) fixtures.markers.push(v);
  }

  if (!fixtures.policyPresent) {
    record("Р развёртывание", "записи политики по типам", "SKIP",
      "политика без type_aliases/type_field_masks: подменять нечего, матрица К неприменима");
    return true;
  }

  // Закрытый справочник с данными: на нём строится почти всё.
  const NAME_FIELDS = ["Наименование", "НаименованиеПолное", "Код"];
  for (const e of [...aliases, ...masks]) {
    if (!String(e.type).startsWith("Справочник.")) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Р ИЗ ${e.type} КАК Т`, null, 1);
    const uuid = probe.data?.rows?.[0]?.Р?.uuid;
    if (!uuid) continue;
    fixtures.closed = e.type;
    fixtures.refUuid = uuid;
    const fields = (masks.find((m) => m.type === e.type)?.fields ?? []);
    fixtures.closedNameField = fields.find((f) => NAME_FIELDS.includes(f)) || "Наименование";
    // Кандидаты имя-подобных полей по порядку предпочтения. Нужны там, где
    // платформа требует поле ОГРАНИЧЕННОЙ длины: конкатенация, агрегат и
    // группировка по строке неограниченной длины не выполняются вовсе, и на ЗУП
    // из-за этого три формы уходили в SKIP. Длину метаданные не публикуют,
    // поэтому подходящее поле выбирается пробой, а не задаётся руками.
    fixtures.nameFieldCandidates = [
      ...fields.filter((f) => NAME_FIELDS.includes(f)),
      ...NAME_FIELDS.filter((f) => !fields.includes(f)),
    ];
    // Числовое поле масок ищем среди перечисленных: тип берём из метаданных.
    const md = await callTool("get_metadata_structure", { type: e.type });
    const attrs = md.data?.metadata?.attributes ?? [];
    for (const f of fields) {
      const a = attrs.find((x) => String(x.name).toLowerCase() === String(f).toLowerCase());
      const types = a?.value_types ?? a?.types ?? [];
      const тип = Array.isArray(types) ? types.join(",") : String(types);
      if (/Число|Number|Булево|Boolean/i.test(тип)) { fixtures.numericMaskField = f; break; }
    }
    break;
  }
  if (!fixtures.closed) {
    record("Р развёртывание", "закрытый справочник с данными", "SKIP",
      "ни один закрытый справочник не вернул строк");
    return true;
  }

  // Подчинённый справочник закрытого типа — носитель разыменования Владелец.
  // Документные реквизиты чаще составные, и на них проверяется другое (Д-3).
  const catalogs = await callTool("list_metadata_objects", { kinds: ["Справочник"], limit: 100 });
  const objects = catalogs.data?.objects ?? [];
  const closedLower = String(fixtures.closed).toLowerCase();
  for (const o of objects) {
    if (!o.full_name || String(o.full_name).toLowerCase() === closedLower) continue;
    const md = await callTool("get_metadata_structure", { type: o.full_name });
    const owners = md.data?.metadata?.owners ?? md.data?.metadata?.owner_types ?? [];
    const список = Array.isArray(owners) ? owners.map(String) : [String(owners)];
    // Синоним типа контур публикует в ЕДИНСТВЕННОМ числе, поэтому сверяем
    // вхождение в обе стороны, а не равенство полных имён.
    const свой = список.some((t) => {
      const a = t.toLowerCase(), b = closedLower;
      return a.includes(b) || b.includes(a.replace(/^справочник\./, ""));
    });
    if (!свой) continue;
    const probe = await runQuery(`ВЫБРАТЬ ПЕРВЫЕ 1 Д.Ссылка КАК Р ИЗ ${o.full_name} КАК Д`, null, 1);
    if (probe.data?.rows?.length) { fixtures.owned = o.full_name; break; }
  }

  // Открытый справочник с данными — для парных проб.
  const закрытые = [...aliases, ...masks].map((e) => String(e.type).toLowerCase());
  for (const o of objects) {
    if (!o.full_name || закрытые.includes(String(o.full_name).toLowerCase())) continue;
    const probe = await runQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 1 Т.Наименование КАК П ИЗ ${o.full_name} КАК Т ГДЕ Т.Наименование <> ""`, null, 1);
    if (probe.data?.rows?.length && probe.data.rows[0].П) { fixtures.openCatalog = o.full_name; break; }
  }

  console.log(`\nФикстуры: закрытый ${fixtures.closed}, поле ${fixtures.closedNameField},`
    + ` подчинённый ${fixtures.owned || "нет"}, открытый ${fixtures.openCatalog || "нет"},`
    + ` числовое поле масок ${fixtures.numericMaskField || "нет"}\n`);
  return true;
}

// ------------------------- К: формы, которые прежде получали отказ

async function sectionCodes() {
  const S = "К отказов больше нет";
  const { closed, closedNameField: NF, owned, refUuid } = fixtures;
  if (!closed) return record(S, "матрица К", "SKIP", "нет закрытого справочника с данными");
  const реф = { Реф: { kind: "ref", type: closed, uuid: refUuid } };

  await acceptedAndMasked(S, `К1 выбор ${NF}`, "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${NF} КАК П ИЗ ${closed} КАК Т`);
  await acceptedAndMasked(S, "К2 обращение без псевдонима", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ${NF} КАК П ИЗ ${closed}`);
  await acceptedAndMasked(S, "К3 ПРЕДСТАВЛЕНИЕ(Ссылка)", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК П ИЗ ${closed} КАК Т`);
  await acceptedAndMasked(S, "К4 ПРЕДСТАВЛЕНИЕССЫЛКИ(Ссылка)", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕССЫЛКИ(Т.Ссылка) КАК П ИЗ ${closed} КАК Т`);
  await acceptedAndMasked(S, "К5 ВЫРАЗИТЬ(Ссылка КАК тип).имя", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ВЫРАЗИТЬ(Т.Ссылка КАК ${closed}).${NF} КАК П ИЗ ${closed} КАК Т`);
  await acceptedAndMasked(S, "К6 УПОРЯДОЧИТЬ ПО закрытому полю", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${NF} КАК П ИЗ ${closed} КАК Т УПОРЯДОЧИТЬ ПО Т.${NF}`);
  // Оракул: принят намеренно, это записанная граница решения, а не дефект.
  await acceptedAndMasked(S, "К7 ГДЕ ПОДОБНО по закрытому полю (оракул, принятая граница)", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${NF} КАК П ИЗ ${closed} КАК Т ГДЕ Т.${NF} ПОДОБНО "%а%"`);
  await acceptedAndMasked(S, "К8 АВТОУПОРЯДОЧИВАНИЕ (был privacy_denied_autoorder)", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${NF} КАК П ИЗ ${closed} КАК Т АВТОУПОРЯДОЧИВАНИЕ`);
  await acceptedAndMasked(S, "К9 через ПОМЕСТИТЬ (временная таблица)", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Ссылка КАК Р ПОМЕСТИТЬ ВТЗакрытые ИЗ ${closed} КАК Т`
    + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 ВТ.Р.${NF} КАК П ИЗ ВТЗакрытые КАК ВТ`);
  await acceptedAndMasked(S, "К10 ОБЪЕДИНИТЬ ВСЕ, представление в обеих ветках", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 2 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК П ИЗ ${closed} КАК Т`
    + `\nОБЪЕДИНИТЬ ВСЕ\nВЫБРАТЬ ПЕРВЫЕ 2 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК П ИЗ ${closed} КАК Т`);
  // Запрос БЕЗ ИЗ: тот самый Д-1. Тип ссылки объявлен параметром.
  await acceptedAndMasked(S, "К11 ПРЕДСТАВЛЕНИЕ(&Реф) без ИЗ (Д-1)", "П",
    "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(&Реф) КАК П", реф);

  if (owned) {
    await acceptedAndMasked(S, "К12 разыменование Владелец.имя", "П",
      `ВЫБРАТЬ ПЕРВЫЕ 5 Д.Владелец.${NF} КАК П ИЗ ${owned} КАК Д`);
    await acceptedAndMasked(S, "К13 Владелец.Ссылка.имя (хвост за Ссылка)", "П",
      `ВЫБРАТЬ ПЕРВЫЕ 5 Д.Владелец.Ссылка.${NF} КАК П ИЗ ${owned} КАК Д`);
  } else {
    record(S, "К12/К13 разыменование владельца", "SKIP",
      "не нашли подчинённый справочник закрытого типа с данными");
  }
}

// ------------------------- H: класс обходов формой записи (ТЗ column_resolution)

async function sectionBypass() {
  const S = "H обходы формой записи";
  const { closed, closedNameField: NF, refUuid } = fixtures;
  if (!closed) return record(S, "матрица H", "SKIP", "нет закрытого справочника с данными");
  const реф = { Реф: { kind: "ref", type: closed, uuid: refUuid } };

  // Формы, которые живой прогон 05.08.2026 показал ОТКРЫТЫМИ на всех трёх
  // контурах: обращение без псевдонима и любое выражение над закрытым полем.
  await acceptedAndMasked(S, "H1 обращение без псевдонима", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ${NF} КАК П ИЗ ${closed}`);
  await acceptedAndMasked(S, "H2 ПОДСТРОКА(поле)", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ПОДСТРОКА(Т.${NF}, 1, 20) КАК П ИЗ ${closed} КАК Т`);
  // Формы, требующие поля ОГРАНИЧЕННОЙ длины: перебираем кандидатов, пока
  // платформа не примет запрос. Иначе на контуре с неограниченным наименованием
  // три пробы уходят в SKIP и класс остаётся непроверенным.
  await maskedWithSuitableField(S, "H3 конкатенация с пустой строкой",
    (f) => `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${f} + "" КАК П ИЗ ${closed} КАК Т`);
  await acceptedAndMasked(S, "H4 ЕСТЬNULL(поле, \"\")", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ЕСТЬNULL(Т.${NF}, "") КАК П ИЗ ${closed} КАК Т`);
  await acceptedAndMasked(S, "H5 ВЫБОР КОГДА … ТОГДА поле", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ВЫБОР КОГДА ИСТИНА ТОГДА Т.${NF} ИНАЧЕ "" КОНЕЦ КАК П ИЗ ${closed} КАК Т`);
  await maskedWithSuitableField(S, "H6 МАКСИМУМ(поле)",
    (f) => `ВЫБРАТЬ МАКСИМУМ(Т.${f}) КАК П ИЗ ${closed} КАК Т`);
  await acceptedAndMasked(S, "H8 ПОМЕСТИТЬ без псевдонима, затем выбор из ВТ", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ${NF} КАК Н ПОМЕСТИТЬ ВТОбход ИЗ ${closed}`
    + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 ВТ.Н КАК П ИЗ ВТОбход КАК ВТ`);
  await acceptedAndMasked(S, "H8' ПОМЕСТИТЬ и выбор оба без псевдонима", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ${NF} КАК Н ПОМЕСТИТЬ ВТОбход2 ИЗ ${closed}`
    + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 Н КАК П ИЗ ВТОбход2`);
  await maskedWithSuitableField(S, "H9 СГРУППИРОВАТЬ ПО закрытому полю",
    (f) => `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${f} КАК П ИЗ ${closed} КАК Т СГРУППИРОВАТЬ ПО Т.${f}`);
  // Комбинации: выражение над голым именем и представление без квалификатора.
  await acceptedAndMasked(S, "H13 ПОДСТРОКА(голое имя)", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ПОДСТРОКА(${NF}, 1, 20) КАК П ИЗ ${closed}`);
  await acceptedAndMasked(S, "H14 ПРЕДСТАВЛЕНИЕ(Ссылка) без псевдонима", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕ(Ссылка) КАК П ИЗ ${closed}`);
  await acceptedAndMasked(S, "H15 ПОДСТРОКА(&Реф.имя) без ИЗ", "П",
    `ВЫБРАТЬ ПОДСТРОКА(&Реф.${NF}, 1, 20) КАК П`, реф);
  // Д-2 (R-7), девятая форма: выражение над колонкой ВТ. Прямое обращение ВТ.Х
  // закрыто наследованием пометки (это H8), обёртка в функцию снимала маску на
  // всех трёх контурах — BUH 0/5, ZUP 0/2, ERP 0/5 на ревизии 2026-08-05.2.
  await acceptedAndMasked(S, "A7 ПОДСТРОКА над закрытой колонкой ВТ", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${NF} КАК Х ПОМЕСТИТЬ ВТДевятая ИЗ ${closed} КАК Т`
    + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 ПОДСТРОКА(ВТ.Х, 1, 20) КАК П ИЗ ВТДевятая КАК ВТ`);
  await acceptedAndMasked(S, "A7-2 ЕСТЬNULL над закрытой колонкой ВТ", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${NF} КАК Х ПОМЕСТИТЬ ВТДевятая2 ИЗ ${closed} КАК Т`
    + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 ЕСТЬNULL(ВТ.Х, "") КАК П ИЗ ВТДевятая2 КАК ВТ`);

  // R-3: производное значение обязано получить МАСКУ, а не код псевдонима — код
  // означает «это тот самый объект», и одинаковые обрезки склеили бы строки,
  // которых в данных нет. Проверяется формой значения, а не фактом закрытия.
  const derived = await runQuery(
    `ВЫБРАТЬ ПЕРВЫЕ 5 ПОДСТРОКА(Т.${NF}, 1, 20) КАК П ИЗ ${closed} КАК Т`, null, 5);
  const derivedRows = derived.data?.rows ?? [];
  if (!derivedRows.length) record(S, "R-3 производное значение получает маску", "SKIP", "ноль строк");
  else {
    const значения = derivedRows.map((r) => r.П).filter((v) => v !== null && v !== undefined && v !== "");
    const масок = значения.filter((v) => String(v) === STRING_MASK).length;
    const кодов = значения.filter((v) => policyPrefixes().some((p) => String(v).startsWith(p))).length;
    check(S, "R-3 производное значение получает маску, а не код псевдонима",
      значения.length > 0 && масок === значения.length,
      `значений ${значения.length}, масок ${масок}, кодов псевдонима ${кодов}`);
  }
}

// Префиксы псевдонимов из политики — для отличения кода от маски.
const policyPrefixes = () => fixtures.markers.filter(Boolean);

// Проба, которой нужно поле ограниченной длины. Кандидаты перебираются, пока
// платформа не выполнит запрос; отчёт называет сработавшее поле, чтобы вердикт
// был воспроизводим. Ни один кандидат не подошёл — SKIP с перечнем попыток, а не
// молчаливый пропуск: непокрытая форма обязана быть видна.
async function maskedWithSuitableField(section, name, buildQuery) {
  const кандидаты = fixtures.nameFieldCandidates.length
    ? fixtures.nameFieldCandidates
    : [fixtures.closedNameField];
  const отказы = [];
  for (const поле of кандидаты) {
    const run = await runQuery(buildQuery(поле), null, 10);
    if (!run.ok) { отказы.push(`${поле}: транспорт`); continue; }
    if (refused(run)) {
      return record(section, `${name} (${поле})`, "FAIL", `ОТКАЗ: ${textOf(run)}`);
    }
    if (run.isError) { отказы.push(`${поле}: ${textOf(run).slice(0, 80)}`); continue; }
    const rows = run.data?.rows ?? [];
    if (!rows.length) { отказы.push(`${поле}: ноль строк`); continue; }
    const значения = rows.map((r) => r.П).filter((v) => v !== null && v !== undefined && v !== "");
    if (!значения.length) { отказы.push(`${поле}: все значения пусты`); continue; }
    const подменённых = значения.filter(looksMasked).length;
    return check(section, `${name} (${поле})`, подменённых === значения.length,
      `строк ${rows.length}, заполненных ${значения.length}, подменённых ${подменённых}`);
  }
  record(section, name, "SKIP", `ни одно имя-подобное поле не подошло — ${отказы.join("; ")}`);
}

// ------------------------- И: инструменты кроме run_1c_query

async function sectionTools() {
  const S = "И инструменты";
  const { closed, refUuid } = fixtures;
  if (!closed) return record(S, "матрица И", "SKIP", "нет закрытого справочника");

  // search_objects отдаёт matches[].ref — ObjectRef с presentation (§7.10 спеки).
  const search = await callTool("search_objects", { query: "а", types: [closed], limit: 3 });
  if (!search.ok) record(S, "И1 search_objects по имени закрытого типа", "SKIP", `транспорт: ${search.transport ?? ""}`);
  else if (refused(search)) record(S, "И1 search_objects по имени закрытого типа", "FAIL", `ОТКАЗ: ${textOf(search)}`);
  else {
    const matches = search.data?.matches ?? [];
    const представления = matches.map((m) => m.ref?.presentation).filter((v) => v !== undefined && v !== "");
    if (!matches.length) record(S, "И1 search_objects: принят и результат подменён", "SKIP", "ноль совпадений");
    else if (!представления.length) {
      record(S, "И1 search_objects: принят и результат подменён", "SKIP",
        `совпадений ${matches.length}, ни одного presentation в ответе`);
    } else {
      const открытых = представления.filter((v) => !looksMasked(v)).length;
      check(S, "И1 search_objects: принят и результат подменён", открытых === 0,
        `совпадений ${matches.length}, представлений ${представления.length}, открытых ${открытых}`);
    }
  }

  // get_object_by_ref: type и uuid ВЕРХНЕГО уровня, не вложенный ref.
  // Выход — object.ref (ObjectRef) + object.standard_fields / object.fields.
  const byRef = await callTool("get_object_by_ref", { type: closed, uuid: refUuid });
  if (!byRef.ok) record(S, "И2 get_object_by_ref", "SKIP", `транспорт: ${byRef.transport ?? ""}`);
  else if (refused(byRef)) record(S, "И2 get_object_by_ref", "FAIL", `ОТКАЗ: ${textOf(byRef)}`);
  else if (byRef.isError || byRef.data?.found === false) {
    record(S, "И2 get_object_by_ref", "SKIP", `объект не получен: ${textOf(byRef)}`);
  } else {
    const o = byRef.data?.object ?? {};
    const имя = o.ref?.presentation;
    check(S, "И2 get_object_by_ref: представление подменено",
      имя !== undefined && имя !== "" && looksMasked(имя),
      имя === undefined ? "presentation в ответе нет — разобрать вручную" : "");
    // Имя-подобные поля объекта — второй канал того же имени.
    const поля = { ...(o.standard_fields ?? {}), ...(o.fields ?? {}) };
    const именные = Object.entries(поля).filter(([k]) =>
      /^(наименование|наименованиеполное|полноенаименование|краткоенаименование|код|представление|name|description|code)$/i
        .test(String(k).replace(/[\s_-]/g, "")));
    const заполненные = именные.filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (!заполненные.length) {
      record(S, "И2 имя-подобные поля объекта подменены", "SKIP", "заполненных имя-подобных полей в ответе нет");
    } else {
      const открытых = заполненные.filter(([, v]) => !looksMasked(v)).length;
      check(S, "И2 имя-подобные поля объекта подменены", открытых === 0,
        `имя-подобных полей ${заполненные.length}, открытых ${открытых}`);
    }
  }

  // Второй эшелон в чистом виде: версии объекта хранят ПРЕЖНИЕ имена, и этот
  // инструмент в приёмках не проверялся ни разу (#114 раздел G). Аргумент —
  // target: {type, uuid}, оба обязательны.
  const hist = await callTool("get_object_history", { target: { type: closed, uuid: refUuid }, limit: 3 });
  if (!hist.ok) record(S, "И3 get_object_history", "SKIP", `транспорт: ${hist.transport ?? ""}`);
  else if (refused(hist)) record(S, "И3 get_object_history", "FAIL", `ОТКАЗ: ${textOf(hist)}`);
  else if (hist.isError) record(S, "И3 get_object_history", "N/A", `инструмент вернул ошибку: ${textOf(hist)}`);
  else {
    const версии = hist.data?.versions ?? hist.data?.history ?? hist.data?.events ?? [];
    if (!версии.length) record(S, "И3 get_object_history: прежние имена не уходят", "N/A", "версий и событий нет");
    else {
      // Вердикт автоматом дать нельзя: состав версии произвольный, и «нет
      // признака маски» здесь не равно утечке. Отдаём на ручной разбор с
      // указанием, где смотреть, — молча зачесть в PASS было бы обманом.
      record(S, "И3 get_object_history: прежние имена не уходят", "SKIP",
        `версий/событий ${версии.length}: разобрать вручную — искать имя-подобные ключи`
        + " и presentation внутри каждой версии");
    }
  }
}

// ------------------------- Ч: числа и булево не закрываются

async function sectionNumbers() {
  const S = "Ч числа открыты";
  const { closed, numericMaskField } = fixtures;
  if (!closed) return record(S, "матрица Ч", "SKIP", "нет закрытого справочника");

  if (!numericMaskField) {
    record(S, "Ч1 числовое поле масок возвращается как есть", "N/A",
      "в политике нет числового или булева поля закрытого типа —"
      + " добавить его настройкой, см. testplan раздел «Числа»");
  } else {
    const run = await runQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 5 Т.${numericMaskField} КАК Ч ИЗ ${closed} КАК Т`
      + ` ГДЕ Т.${numericMaskField} <> 0`, null, 5);
    const rows = run.data?.rows ?? [];
    if (!rows.length) record(S, "Ч1 числовое поле масок возвращается как есть", "SKIP", "ноль строк");
    else {
      const числа = rows.map((r) => r.Ч).filter((v) => typeof v === "number").length;
      check(S, "Ч1 числовое поле масок возвращается как есть", числа === rows.length,
        `строк ${rows.length}, чисел ${числа} — null или строка означает, что число закрыли`);
    }
    const текстПредупреждений = fixtures.configWarnings.join(" ");
    check(S, "Ч2 парсер предупредил, что маска на числовое поле не действует",
      /числовое или булево/.test(текстПредупреждений),
      /числовое или булево/.test(текстПредупреждений) ? "" : "предупреждения нет — правка парсера не работает");
  }

  // Агрегат по закрытому типу: числа не должны стать null ни в каком виде.
  const agg = await runQuery(`ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК К ИЗ ${closed} КАК Т`, null, 1);
  const к = agg.data?.rows?.[0]?.К;
  check(S, "Ч3 агрегат по закрытому типу возвращает число", typeof к === "number",
    typeof к === "number" ? "" : `получено: ${к === null ? "null" : typeof к}`);
}

// ------------------------- Г: строки регистра из политики (R-8, R-9)

// Регистр сведений с масками полей — носитель Д-3 и Д-4: строка регистра должна
// маскироваться НАБОРОМ РЕГИСТРА (R-8), а её Представление — наследовать
// закрытость (R-9). Условие (б) из П1 — «набор физлица к строке не применён» —
// снаружи неотличимо и остаётся приёмке с админской кнопкой «Карта закрытости».
async function sectionRegister() {
  const S = "Г регистр из политики";
  const запись = fixtures.maskRegisterEntry;
  if (!запись) {
    return record(S, "регистр сведений в type_field_masks", "SKIP",
      "в политике нет записи РегистрСведений.* — пробы R-8/R-9 по регистру гонять не на чем");
  }

  const рег = await callTool("get_register_records", {
    register_type: "РегистрСведений",
    register: запись.type,
    mode: "records",
    limit: 5,
  });
  if (!рег.ok) return record(S, "get_register_records", "SKIP", `транспорт: ${рег.transport ?? ""}`);
  if (refused(рег)) return record(S, "get_register_records", "FAIL", `ОТКАЗ: ${textOf(рег)}`);
  if (рег.isError) return record(S, "get_register_records", "SKIP", `ошибка не privacy: ${textOf(рег)}`);
  const rows = рег.data?.rows ?? рег.data?.records ?? [];
  if (!rows.length) return record(S, "get_register_records", "SKIP", "ноль записей — нет фикстуры");

  // R-8, условие (а): поля из записи политики, встретившиеся в строках,
  // замаскированы. До правки на контуре с закрытым физлицом тип строки
  // подменялся справочником физлиц, и маски регистра не применялись вовсе.
  const нормКлюч = (s) => String(s).toUpperCase().replace(/[\s_\-.]/g, "");
  const поляПолитики = (запись.fields ?? []).map(нормКлюч);
  let заполнено = 0, подменено = 0;
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!поляПолитики.includes(нормКлюч(key))) continue;
      if (value === null || value === undefined || value === "") continue;
      заполнено += 1;
      if (looksMasked(value)) подменено += 1;
    }
  }
  if (!заполнено) record(S, "Г1 маски регистра применены к строкам (R-8)", "SKIP",
    "поля из политики в записях пусты либо не выбраны");
  else check(S, "Г1 маски регистра применены к строкам (R-8)", подменено === заполнено,
    `заполненных ${заполнено}, подменённых ${подменено}`);

  // R-9: Представление строки наследует закрытость от закрытых реквизитов.
  const сПредставлением = rows.filter((r) =>
    Object.keys(r).some((k) => нормКлюч(k) === "ПРЕДСТАВЛЕНИЕ" || нормКлюч(k) === "PRESENTATION"));
  if (!сПредставлением.length) {
    record(S, "Г2 Представление строки замаскировано (R-9)", "SKIP", "ключа Представление в записях нет");
  } else {
    const открытых = сПредставлением.filter((r) => {
      const k = Object.keys(r).find((x) => нормКлюч(x) === "ПРЕДСТАВЛЕНИЕ" || нормКлюч(x) === "PRESENTATION");
      const v = r[k];
      return v !== null && v !== undefined && v !== "" && !looksMasked(v);
    }).length;
    check(S, "Г2 Представление строки замаскировано (R-9)", открытых === 0,
      `строк с представлением ${сПредставлением.length}, открытых ${открытых}`);
  }

  // Гейт R-8 срабатывает у любого ответа, в корне которого лежит `register` ИЛИ
  // `accounting_register` — а его кладут ещё пять бухгалтерских инструментов.
  // Раздел выше покрывает только РегистрСведений, поэтому здесь один вызов по
  // бухгалтерии: субконто закрытого типа обязано остаться подменённым.
  const проводки = await callTool("get_accounting_entries", {
    period_from: "2024-01-01", period_to: "2026-12-31", limit: 10,
  });
  if (!проводки.ok) record(S, "Г4 бухгалтерский инструмент: субконто подменено", "SKIP",
    `транспорт: ${проводки.transport ?? ""}`);
  else if (refused(проводки)) record(S, "Г4 бухгалтерский инструмент: субконто подменено", "FAIL",
    `ОТКАЗ: ${textOf(проводки)}`);
  else if (проводки.isError) record(S, "Г4 бухгалтерский инструмент: субконто подменено", "SKIP",
    `ошибка не privacy: ${textOf(проводки)}`);
  else {
    const проводкиСтроки = проводки.data?.rows ?? проводки.data?.entries ?? [];
    const закрытыеТипыПолитики = fixtures.policyTypes ?? [];
    let ссылок = 0, подменено = 0;
    for (const row of проводкиСтроки) {
      for (const v of Object.values(row)) {
        if (!v || typeof v !== "object" || !v.type) continue;
        if (!закрытыеТипыПолитики.some((t) => String(t).toLowerCase() === String(v.type).toLowerCase())) continue;
        ссылок += 1;
        if (v.presentation === undefined || v.presentation === "" || looksMasked(v.presentation)) подменено += 1;
      }
    }
    if (!ссылок) record(S, "Г4 бухгалтерский инструмент: субконто подменено", "SKIP",
      `строк ${проводкиСтроки.length}, ссылок закрытых типов нет`);
    else check(S, "Г4 бухгалтерский инструмент: субконто подменено", подменено === ссылок,
      `строк ${проводкиСтроки.length}, ссылок ${ссылок}, подменено ${подменено}`);
  }

  // R-8, условие (в): ссылка-измерение закрытого типа подменена по СВОИМ
  // type/uuid. Судим только по типам из политики — персонные семейства без
  // записи в политике оценивает приёмка.
  const закрытыеТипы = fixtures.policyTypes ?? [];
  let ссылокЗакрытых = 0, ссылокПодменено = 0;
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (!value || typeof value !== "object" || !value.type) continue;
      if (!закрытыеТипы.some((t) => String(t).toLowerCase() === String(value.type).toLowerCase())) continue;
      ссылокЗакрытых += 1;
      if (value.presentation === undefined || value.presentation === ""
        || looksMasked(value.presentation)) ссылокПодменено += 1;
    }
  }
  if (!ссылокЗакрытых) record(S, "Г3 ссылка закрытого типа в строке подменена по своим type/uuid", "SKIP",
    "ссылок закрытых типов политики в записях нет");
  else check(S, "Г3 ссылка закрытого типа в строке подменена по своим type/uuid",
    ссылокПодменено === ссылокЗакрытых, `ссылок ${ссылокЗакрытых}, подменено ${ссылокПодменено}`);
}

// ------------------------- П: парные пробы, лишнего не подменять

async function sectionPaired() {
  const S = "П парные, не подменять лишнее";
  const { closed, openCatalog, closedNameField: NF } = fixtures;
  if (!openCatalog) return record(S, "матрица П", "SKIP", "не нашли открытый справочник с данными");

  await acceptedAndOpen(S, "П1 открытый справочник: Наименование открыто", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Наименование КАК П ИЗ ${openCatalog} КАК Т ГДЕ Т.Наименование <> ""`);
  await acceptedAndOpen(S, "П2 ПРЕДСТАВЛЕНИЕ ссылки открытого типа открыто", "П",
    `ВЫБРАТЬ ПЕРВЫЕ 5 ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК П ИЗ ${openCatalog} КАК Т`);
  if (closed) {
    // Одноимённое поле открытого источника рядом с закрытым: принадлежность
    // решается по источнику, а не по вхождению имени в текст запроса.
    await acceptedAndOpen(S, "П3 одноимённое поле открытого источника рядом с закрытым", "П",
      `ВЫБРАТЬ ПЕРВЫЕ 5 О.Наименование КАК П ИЗ ${openCatalog} КАК О`
      + ` ЛЕВОЕ СОЕДИНЕНИЕ ${closed} КАК З ПО ЛОЖЬ ГДЕ О.Наименование <> ""`);

    // R-6, ограничитель R-4 п. 1: правило «нераспознанное закрываем» не должно
    // накрывать открытые типы только потому, что рядом в запросе есть закрытый.
    // Без этой пробы R-4 повторил бы класс Д-3 — молча испорченную аналитику.
    await acceptedAndOpen(S, "П5 выражение над открытым полем при закрытом соседе", "П",
      `ВЫБРАТЬ ПЕРВЫЕ 5 ПОДСТРОКА(О.Наименование, 1, 20) КАК П`
      + ` ИЗ ${openCatalog} КАК О, ${closed} КАК З ГДЕ О.Наименование <> ""`);
    await acceptedAndOpen(S, "П6 голое имя открытого типа при закрытом соседе", "П",
      `ВЫБРАТЬ ПЕРВЫЕ 5 О.Наименование КАК П`
      + ` ИЗ ${openCatalog} КАК О, ${closed} КАК З ГДЕ О.Наименование <> ""`);
    // Парная к A7 (R-7): выражение над колонкой ВТ, построенной из ОТКРЫТОГО
    // типа, обязано остаться открытым — разрешение операндов по пометкам ВТ не
    // должно закрывать всё, что прошло через ПОМЕСТИТЬ.
    await acceptedAndOpen(S, "П7 ПОДСТРОКА над колонкой ВТ из открытого типа", "П",
      `ВЫБРАТЬ ПЕРВЫЕ 5 О.Наименование КАК Х ПОМЕСТИТЬ ВТОткрытая ИЗ ${openCatalog} КАК О`
      + ` ГДЕ О.Наименование <> ""`
      + `\n;\nВЫБРАТЬ ПЕРВЫЕ 5 ПОДСТРОКА(ВТ.Х, 1, 20) КАК П ИЗ ВТОткрытая КАК ВТ`);
    // П4 — самая сильная проба: закрытое и открытое имя в ОДНОЙ строке. Обе
    // половины сразу: одно значение обязано быть подменено, другое обязано
    // остаться открытым. Соединение по запятой, а не ЛЕВОЕ ПО ЛОЖЬ: при ПО ЛОЖЬ
    // закрытая сторона всегда NULL, и проба не проверяла бы ничего.
    const mixed = await runQuery(
      `ВЫБРАТЬ ПЕРВЫЕ 5 З.${NF} КАК Закрытое, О.Наименование КАК Открытое`
      + ` ИЗ ${closed} КАК З, ${openCatalog} КАК О`
      + ` ГДЕ О.Наименование <> "" И З.${NF} <> ""`, null, 5);
    if (!mixed.ok) record(S, "П4 закрытое и открытое имя в одной строке", "SKIP", `транспорт: ${mixed.transport ?? ""}`);
    else if (refused(mixed)) record(S, "П4 закрытое и открытое имя в одной строке", "FAIL", `ОТКАЗ: ${textOf(mixed)}`);
    else if (mixed.isError) record(S, "П4 закрытое и открытое имя в одной строке", "SKIP", `ошибка не privacy: ${textOf(mixed)}`);
    else {
      const rows = mixed.data?.rows ?? [];
      if (!rows.length) record(S, "П4 закрытое и открытое имя в одной строке", "SKIP", "ноль строк");
      else {
        const закрытыхПодменено = rows.filter((r) => looksMasked(r.Закрытое)).length;
        const открытыхОткрыто = rows.filter((r) => !looksMasked(r.Открытое)).length;
        check(S, "П4 закрытое подменено, открытое открыто — в одной строке",
          закрытыхПодменено === rows.length && открытыхОткрыто === rows.length,
          `строк ${rows.length}, закрытых подменено ${закрытыхПодменено},`
          + ` открытых осталось открытыми ${открытыхОткрыто}`);
      }
    }
  }
}

// ------------------------------------------------------------------ main

async function runContour(name, url) {
  currentName = name;
  URL_MCP = url;
  console.log(`\n${"=".repeat(70)}\nКонтур: ${name} — ${url}\n${"=".repeat(70)}`);
  const ready = await discover();
  if (!ready) return;
  await sectionCodes();
  await sectionBypass();
  await sectionTools();
  await sectionNumbers();
  await sectionRegister();
  await sectionPaired();
}

(async () => {
  const план = ALL
    ? Object.entries(CONTOURS)
    : [[Object.entries(CONTOURS).find(([, u]) => u === URL_MCP)?.[0] ?? "MCP_URL", URL_MCP]];

  for (const [name, url] of план) await runContour(name, url);

  console.log(`\nИтог: PASS ${passed}, FAIL ${failed}, SKIP ${skipped}, N/A ${notApplicable}`);
  if (failed > 0) {
    console.log("FAIL в К — сборка отказывает там, где отказов больше нет (или деплой неполный);"
      + " FAIL в П — подмена сработала на открытом типе и молча испортила аналитику;"
      + " FAIL в Ч — число закрыли, значение стёрто;"
      + " FAIL в Р — задеплоена не та ревизия.");
  }
  if (JSON_OUT) {
    mkdirSync(dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({
      expected_revision: EXPECTED_REVISION,
      summary: { passed, failed, skipped, notApplicable },
      results,
    }, null, 2), "utf8");
    console.log(`JSON: ${JSON_OUT}`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
})();
