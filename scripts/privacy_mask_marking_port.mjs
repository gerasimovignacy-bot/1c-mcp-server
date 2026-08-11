// JS-порт логики пометки колонок privacy (MCP_Query.bsl) + таблица кейсов H1–H10
// и парных проб R-6. Прогоняется офлайн, до деплоя: компилятора 1С на стороне
// разработки нет, а на контуре проверять можно только уже опубликованный код.
//
//   node scripts/privacy_mask_marking_port.mjs
//   node scripts/privacy_mask_marking_port.mjs --verbose
//
// Порт НЕ заменяет живую приёмку. Он отвечает на один вопрос: принимает ли
// решающая цепочка правильное решение на формах, которые живой прогон 05.08.2026
// показал открытыми. Метаданные и политика здесь — заглушки: у порта нет и не
// может быть настоящей конфигурации, поэтому проверяется логика ветвления, а не
// разрешение имён конкретного контура.
//
// Соответствие функциям BSL указано у каждой функции: расхождение порта и модуля
// хуже отсутствия порта, потому что даёт ложную уверенность.

const VERBOSE = process.argv.includes("--verbose");
// --legacy восстанавливает поведение ДО правки P-0 (карта решений по всем колонкам
// результата и запрет звёздочки буквальными подстроками). Прогон с этим флагом
// ОБЯЗАН давать FAIL на группе P0: порт, который зелен в обоих режимах, ничего не
// проверяет. Требование §11 ТЗ — порт должен быть различимым.
const LEGACY = process.argv.includes("--legacy");

// ---------------------------------------------------------------- заглушки

// Политика: закрытый справочник с псевдонимом типа и закрытым полем, открытый
// справочник, регистр с масками полей (без псевдонима — R-9) и справочник с
// единственной не-имя-подобной маской (цена R-9 фиксируется парным кейсом).
// Имена вымышленные — живых имён контура здесь быть не должно.
const CLOSED = "Справочник.ЗакрытыйТип";
const OPEN = "Справочник.ОткрытыйТип";
const MASKED_REG = "РегистрСведений.ЗакрытыйРегистр";
const MASKED_CAT = "Справочник.СМаскойКомментария";
// R-12/R-15: тип персон, подчинённый ему справочник (своей записи в политике
// НЕТ — её вводит правило подчинённости) и подчинённый НЕ-персоне, который
// закрываться не должен (парная проба G3‴).
const PERSON = "Справочник.ФизическиеЛица";
const PERSON_SUB = "Справочник.РодственникиФизическихЛиц";
const CLOSED_SUB = "Справочник.НоменклатураКонтрагентов";
// R-11/R-16: табличные части в форме А — так их строит ПолноеИмяТабличнойЧастиPrivacy.
const TP_CLOSED = `${CLOSED}.ТабличнаяЧасть.КонтактнаяИнформация`;
const TP_OPEN = `${OPEN}.ТабличнаяЧасть.КонтактнаяИнформация`;

// alias — у типа есть псевдоним (type_aliases): имя-подобные поля получают код.
// fields — маски полей (type_field_masks): строковая маска.
// person — тип закрыт легаси-механизмом персон (person_aliases включены).
const POLICY = {
  [CLOSED]: { alias: true, fields: ["Наименование", "НаименованиеПолное", "Код", "Представление"] },
  [MASKED_REG]: { alias: false, fields: ["Серия", "Номер", "КемВыдан"] },
  [MASKED_CAT]: { alias: false, fields: ["Комментарий"] },
  [PERSON]: { alias: false, person: true, fields: ["НаименованиеСлужебное", "ИНН"] },
};

// Метаданные: состав полей и ссылочность. Для порта достаточно знать, есть ли
// поле у типа и ведёт ли оно на другой тип.
//
// ТЧ здесь — ОТДЕЛЬНЫЕ типы, и в их составе НЕТ поля «Ссылка»: замер 07.08.2026
// на трёх конфигурациях показал, что СтандартныеРеквизиты всех 34 ТЧ содержат
// одно имя — НомерСтроки. Прежняя заглушка «у ТЧ есть Ссылка» брала это из
// документации платформы и давала порту ложную зелень там, где контур отдавал
// 0/5. Возврат к владельцу обеспечивает структурный вывод (R-16, часть 2).
const META = {
  [CLOSED]: { Наименование: null, Код: null, Ссылка: CLOSED, Владелец: null, Сумма: null },
  [OPEN]: { Наименование: null, Код: null, Ссылка: OPEN, Сумма: null },
  "Справочник.Подчиненный": { Наименование: null, Ссылка: "Справочник.Подчиненный", Владелец: CLOSED },
  // Представление — РЕСУРС регистра (замер BUH/ZUP/ERP), Наименования у него нет.
  [MASKED_REG]: { Серия: null, Номер: null, КемВыдан: null, ДатаВыдачи: null, Физлицо: CLOSED, Представление: null },
  [MASKED_CAT]: { Наименование: null, Код: null, Комментарий: null, Ссылка: MASKED_CAT },
  [PERSON]: { Наименование: null, Фамилия: null, Имя: null, Отчество: null, ИНН: null,
    НаименованиеСлужебное: null, МестоРождения: null, Ссылка: PERSON },
  [PERSON_SUB]: { Наименование: null, Фамилия: null, Имя: null, Отчество: null,
    НаименованиеСлужебное: null, СтепеньРодства: null, Владелец: PERSON, Ссылка: PERSON_SUB },
  [CLOSED_SUB]: { Наименование: null, Код: null, Владелец: CLOSED, Ссылка: CLOSED_SUB },
  [TP_CLOSED]: { Представление: null, Значение: null, ЗначенияПолей: null, НомерТелефона: null,
    Тип: null, Вид: null, ВидДляСписка: null, НомерСтроки: null },
  [TP_OPEN]: { Представление: null, Значение: null, Тип: null, Вид: null, НомерСтроки: null },
};

// Владельцы подчинённых справочников — источник правила R-12.
const OWNERS = {
  [PERSON_SUB]: [PERSON],
  [CLOSED_SUB]: [CLOSED],
  "Справочник.Подчиненный": [CLOSED],
};
// MCP_Security.ЭтоТипПерсоныLLM — сверка по префиксу нормализованного имени.
const isPersonType = (t) => String(t).toUpperCase().replace(/[\s_\-.]/g, "")
  .startsWith("СПРАВОЧНИКФИЗИЧЕСКИЕЛИЦА");
// MCP_Security.ЭтоПодчиненныйТипуПерсонPrivacy (R-12): подчинён ТИПУ ПЕРСОН.
// Подчинённые контрагентов правилом не закрываются — решение заказчика 06.08.
const isPersonSubordinate = (t) => !isPersonType(t)
  && (OWNERS[t] ?? []).some(isPersonType);
// MCP_Security.ЭтоТипПерсональногоНабораLLM
const isPersonSet = (t) => isPersonType(t) || isPersonSubordinate(t);
// MCP_Security.ЭтоТабличнаяЧастьПоИмениPrivacy
const isTabularPart = (t) => String(t).toUpperCase().includes(".ТАБЛИЧНАЯЧАСТЬ.");
// MCP_Security.ВладелецТабличнойЧастиПоИмениPrivacy — отсечение суффикса.
const tabularOwner = (t) => {
  const at = String(t).toUpperCase().lastIndexOf(".ТАБЛИЧНАЯЧАСТЬ.");
  return at < 0 ? "" : String(t).slice(0, at);
};

const normField = (s) => String(s).toUpperCase().replace(/[\s_\-.]/g, "");

// R-9: наследование включается у типов, где `Представление` ОБЪЯВЛЕНО полем.
// Заглушка сверена с живыми метаданными 06.08.2026 ТЕМ ЖЕ набором коллекций,
// каким читает движок (реквизиты + измерения + ресурсы + стандартные реквизиты):
// у паспортного регистра Представление есть ресурсом, у справочников нет.
// Сверка «по attributes» неэквивалентна и дважды дала зелёный порт при неверной
// посылке — в обе стороны.
const hasPresentationField = (type) => Boolean(META[type] && Object.keys(META[type])
  .some((f) => f.toUpperCase() === "ПРЕДСТАВЛЕНИЕ"));

// MCP_Security.ТипВЗакрытомНабореPrivacy: своя запись в политике либо
// легаси-механизм персон, включая подчинённых им справочников (R-12).
const typeInClosedSet = (type) => {
  if (!type || isTabularPart(type)) return false;
  if (POLICY[type]) return true;
  return isPersonSet(type) && Object.values(POLICY).some((p) => p.person);
};
// MCP_Security.ПолеИзНабораФИОPrivacy (R-15). МестоРождения НЕ входит — §6.6.
const FIO_SET = new Set(["ФАМИЛИЯ", "ИМЯ", "ОТЧЕСТВО", "ФИО", "ИНИЦИАЛЫ",
  "НАИМЕНОВАНИЕСЛУЖЕБНОЕ", "УТОЧНЕНИЕНАИМЕНОВАНИЯ"].map(normField));
// MCP_Security.ПолеВБеломСпискеЯдраPrivacy — ограничитель 4 (классы 4a…4d).
const CORE_WHITELIST = new Set(["КОД", "ТИП", "ВИД", "ВИДДЛЯСПИСКА", "НОМЕРСТРОКИ",
  "ПОМЕТКАУДАЛЕНИЯ", "ЭТОГРУППА", "ПРЕДОПРЕДЕЛЕННЫЙ", "ИМЯПРЕДОПРЕДЕЛЕННЫХДАННЫХ",
  "НАИМЕНОВАНИЕБАНКА", "НАИМЕНОВАНИЕОПЕРАТОРАПЕРЕВОДА", "НАИМЕНОВАНИЕНАЛОГОВОГООРГАНА",
  "НАИМЕНОВАНИЕОКВЭД", "НАИМЕНОВАНИЕОКОПФ", "НАИМЕНОВАНИЕОКФС",
  "МЕСТОРОЖДЕНИЯПРЕДСТАВЛЕНИЕ"].map(normField));
// MCP_Security.ПолеВЯдреИдентификацииPrivacy (R-13). Точное «Представление»
// решает ПредставлениеЗакрытоPrivacy, поэтому ядром оно не берётся. «Номер» в
// ядро НЕ входит — решение 07.08.2026.
const inIdentityCore = (type, field) => {
  const f = normField(field);
  if (!f || f === normField("Представление")) return false;
  if (!f.includes(normField("Наименование")) && !f.includes(normField("Представление"))) return false;
  if (CORE_WHITELIST.has(f)) return false;
  return typeInClosedSet(type);
};
// MCP_Security.КлассификаторСтрокиТЧPrivacy — ограничитель цены R-11.
const TP_CLASSIFIERS = new Set(["ТИП", "ВИД", "ВИДДЛЯСПИСКА", "НОМЕРСТРОКИ"].map(normField));

// MCP_Security.ПолеЗакрытоPrivacy + R-9: Представление наследует закрытость,
// когда у типа закрыт хотя бы один реквизит И `Представление` объявлено полем.
// Без второго условия признак был бы константой «любой тип из type_field_masks
// закрывает своё представление» — найдено ревью.
const fieldClosed = (type, field) => {
  // R-11: поля строки табличной части закрытого типа. Классификаторы открыты —
  // иначе телефон не отличить от адреса.
  if (isTabularPart(type)) {
    if (TP_CLASSIFIERS.has(normField(field))) return false;
    return typeInClosedSet(tabularOwner(type));
  }
  const p = POLICY[type];
  // R-12 + R-15: подчинённый типу персон закрыт по подчинённости — набор ФИО
  // правилом, набор масок унаследован от владельца.
  if (isPersonSet(type)) {
    if (FIO_SET.has(normField(field))) return true;
    if (["НАИМЕНОВАНИЕ", "ПРЕДСТАВЛЕНИЕ"].includes(normField(field))) return true;
    for (const owner of [type, ...(OWNERS[type] ?? [])]) {
      const op = POLICY[owner];
      if (op && op.fields.some((f) => normField(f) === normField(field))) return true;
    }
  }
  // R-13: ядро идентифицирующих полей — без записи в политике.
  if (inIdentityCore(type, field)) return true;
  if (!p) return false;
  if (p.fields.some((f) => normField(f) === normField(field))) return true;
  return ["ПРЕДСТАВЛЕНИЕ", "PRESENTATION"].includes(normField(field))
    && p.fields.length > 0 && hasPresentationField(type);
};
// MCP_Security.ПредставлениеЗакрытоPrivacy: псевдоним типа, имя-подобное поле в
// масках либо наследование R-9 (только там, где Представление — объявленное поле).
const presentationClosed = (type) => {
  // R-11: представление строки ТЧ несёт её содержимое целиком (адрес одной строкой).
  if (isTabularPart(type)) return typeInClosedSet(tabularOwner(type));
  if (isPersonSet(type)) return Object.values(POLICY).some((x) => x.person);
  const p = POLICY[type];
  if (!p) return false;
  return Boolean(p.alias) || (p.fields.length > 0 && hasPresentationField(type));
};
// MCP_Query.ПолеЕстьУИсточникаPrivacy
const fieldExists = (type, field) => {
  const fields = META[type];
  if (!fields) return false;
  const norm = (s) => String(s).toUpperCase();
  return Object.keys(fields).some((f) => norm(f) === norm(field))
    || ["НАИМЕНОВАНИЕ", "КОД", "ПРЕДСТАВЛЕНИЕ"].includes(norm(field));
};
// MCP_Query.СсылочныеТипыПоляPrivacy. Честная модель: у табличных частей поля
// «Ссылка» НЕТ (см. комментарий к META), поэтому здесь она не разрешается.
const refTypesOf = (type, field) => {
  const fields = META[type] ?? {};
  const key = Object.keys(fields).find((f) => f.toUpperCase() === String(field).toUpperCase());
  const target = key ? fields[key] : undefined;
  return target ? [target] : [];
};
// MCP_Query.ПолноеИмяТабличнойЧастиPrivacy — форма А, если сегмент называет ТЧ типа.
const tabularPartFullName = (type, segment) => {
  const candidate = `${type}.ТабличнаяЧасть.${segment}`;
  const key = Object.keys(META).find((t) => t.toUpperCase() === candidate.toUpperCase());
  return key ?? "";
};
// MCP_Query.ВладелецТабличнойЧастиСтруктурноPrivacy (R-16, часть 2): запасное
// правило — метаданные спрашиваются первыми, и только если «Ссылку» они не
// дали, владелец выводится отсечением суффикса и проверяется по метаданным.
const tabularOwnerStructural = (type) => {
  const owner = tabularOwner(type);
  if (!owner) return [];
  const key = Object.keys(META).find((t) => t.toUpperCase() === owner.toUpperCase());
  return key ? [key] : [];
};
// MCP_Query.ТипыСегментаPrivacy — единственный разрешатель сегментов пути.
// Через него теперь идут ОБА обходчика: и пометка колонок, и операнды (R-16,
// часть 1 — делегирование :7111).
function segmentTypes(currentTypes, segment) {
  const out = [];
  const push = (t) => { if (t && !out.includes(t)) out.push(t); };
  const ref = isRefSegment(segment);
  for (const type of currentTypes) {
    if (ref) {
      if (isTabularPart(type)) {
        const byMeta = refTypesOf(type, segment);
        (byMeta.length ? byMeta : tabularOwnerStructural(type)).forEach(push);
      } else push(type);
      continue;
    }
    const tp = tabularPartFullName(type, segment);
    if (tp) { push(tp); continue; }
    refTypesOf(type, segment).forEach(push);
  }
  return out;
}
// MCP_Query.ИмяИсточникаДляPrivacy: источник-табличная часть разрешается от
// самой ТЧ (её поля принадлежат строке, а не владельцу), а не от владельца.
const sourceTypeFor = (binding) => {
  if (!binding.full_name || !binding.third_segment) return binding.full_name;
  return tabularPartFullName(binding.full_name, binding.third_segment) || binding.full_name;
};

// -------------------------------------------------------------- лексика

// \b в JS — ASCII-граница и с кириллицей не работает: /\bВЫБРАТЬ\b/ не совпадает
// НИКОГДА. На этом порт с первого запуска дал 20 FAIL, включая контрольные формы,
// которые живьём работают. Границу задаём классом символов идентификатора.
const B = "(?<![0-9A-Za-zА-Яа-яЁё_])";
const A = "(?![0-9A-Za-zА-Яа-яЁё_])";
const word = (w, flags = "i") => new RegExp(B + w + A, flags);

// MCP_Query.ЯвляетсяСимволомИдентификатора
const isIdentChar = (c) => /[0-9A-Za-zА-Яа-яЁё_]/.test(c);
// MCP_Query.ПрочитатьИдентификатор
function readIdent(text, i) {
  let out = "";
  while (i <= text.length && isIdentChar(text[i - 1] ?? "")) { out += text[i - 1]; i++; }
  return out;
}
// MCP_Query.ПропуститьПробелы — возвращает 1-based позицию первого значащего
function skipSpaces(text, i) {
  while (i <= text.length && /\s/.test(text[i - 1])) i++;
  return i;
}
// MCP_Query.УдалитьПробельныеСимволыPrivacy
const stripWs = (s) => String(s).replace(/\s+/g, "");
// MCP_Query.ЭтоЦепочкаИдентификаторовPrivacy
const isIdentChain = (s) => /^&?[A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*(\.[A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*)*$/.test(s);
// MCP_Query.СтрокаИзЦифрPrivacy
const isDigits = (s) => /^\d+$/.test(String(s));
// MCP_Query.ЭтоСегментСсылкиPrivacy
const isRefSegment = (s) => ["ССЫЛКА", "REF"].includes(String(s).toUpperCase());

// MCP_Query.ЭтоКлючевоеСловоВыраженияPrivacy — список держать синхронным с BSL
const EXPR_KEYWORDS = new Set(("ВЫБОР,КОГДА,ТОГДА,ИНАЧЕ,КОНЕЦ,ЕСТЬ,NULL,НЕ,И,ИЛИ,ПОДОБНО,ССЫЛКА,"
  + "ИСТИНА,ЛОЖЬ,КАК,МЕЖДУ,В,ИЕРАРХИИ,УБЫВ,ВОЗР,РАЗЛИЧНЫЕ,ПЕРВЫЕ,"
  + "CASE,WHEN,THEN,ELSE,END,IS,NOT,AND,OR,LIKE,REFS,TRUE,FALSE,AS,BETWEEN,IN,"
  + "HIERARCHY,DESC,ASC,DISTINCT,TOP,ТИП,TYPE,ЗНАЧЕНИЕ,VALUE").split(","));

// ------------------------------------------------- карта источников и проекция

// Упрощённый порт КартаАлиасовЗапроса: разбирает ИЗ/СОЕДИНЕНИЕ вида
// «<ПолноеИмя|ВТ> [КАК <алиас>]». Для кейсов порта этого достаточно; в модуле
// разбор устойчивее (вложенность, пакеты, подзапросы).
// Маркер источника-подзапроса — MCP_Query.МаркерИсточникаПодзапроса.
const SUBQUERY = "<подзапрос>";

// Вырезает встроенные подзапросы источника и регистрирует их привязки так же, как
// КартаАлиасовЗапроса: псевдоним подзапроса ЕСТЬ в карте, а full_name у него
// пустой, и источники самого подзапроса тоже попадают в карту (#108).
//
// Порт обязан это повторять: без регистрации псевдонима порт считал бы Т.Поле
// неразрешённым операндом и был бы «зелёным» по другой причине, чем модуль, —
// расхождение хуже отсутствия порта.
function extractSubquerySources(section, sources, bindings) {
  let rest = "";
  let i = 0;
  while (i < section.length) {
    if (section[i] !== "(") { rest += section[i]; i++; continue; }
    let depth = 0, j = i;
    for (; j < section.length; j++) {
      if (section[j] === "(") depth++;
      else if (section[j] === ")") { depth--; if (!depth) break; }
    }
    const inner = section.slice(i + 1, j);
    i = j + 1;
    if (!word("(?:ВЫБРАТЬ|SELECT)").test(inner)) { rest += `(${inner})`; continue; }
    const tail = section.slice(i);
    const alias = tail.match(new RegExp(`^\\s*(?:${B}(?:КАК|AS)${A}\\s+)?([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*)`, "i"));
    if (alias) {
      const binding = { raw: SUBQUERY, alias: alias[1], full_name: "", third_segment: "" };
      sources.push(binding);
      bindings.set(alias[1].toUpperCase(), binding);
      i += alias[0].length;
    }
    // Источники самого подзапроса — в ту же карту.
    const innerMap = sourceMap(inner);
    for (const s of innerMap.sources) {
      sources.push(s);
      if (!bindings.has((s.alias || s.raw).toUpperCase())) {
        bindings.set((s.alias || s.raw).toUpperCase(), s);
      }
    }
  }
  return rest;
}

function sourceMap(command) {
  const sources = [];
  const bindings = new Map();
  // Раздел источников идёт от ИЗ до терминатора (ГДЕ, СГРУППИРОВАТЬ, …). Внутри
  // разделителями служат запятая и слова соединений: ЛексемыИсточников в модуле
  // делает то же самое, и запятая там полноправный разделитель — без этого
  // соединение через запятую (проба П4) не давало бы привязок, а R-4 закрыл бы
  // открытую колонку. Порт обязан повторять это, иначе он «зелёный» вслепую.
  const fromAt = command.search(word("(?:ИЗ|FROM)"));
  if (fromAt < 0) return { sources, bindings, gave_up: false, reason: "no_sources_detected" };
  let section = command.slice(fromAt).replace(/^\s*(ИЗ|FROM)\s*/i, "");
  // Подзапросы вырезаются ДО поиска терминатора: ГДЕ и УПОРЯДОЧИТЬ внутри
  // подзапроса обрезали бы раздел на его середине, и псевдоним подзапроса,
  // стоящий за скобкой, в карту не попал бы.
  section = extractSubquerySources(section, sources, bindings);
  const stop = section.search(word("(?:ГДЕ|WHERE|СГРУППИРОВАТЬ|GROUP|УПОРЯДОЧИТЬ|ORDER|ИМЕЮЩИЕ|HAVING"
    + "|ОБЪЕДИНИТЬ|UNION|ИТОГИ|TOTALS|ИНДЕКСИРОВАТЬ|INDEX|ПОМЕСТИТЬ|INTO|УНИЧТОЖИТЬ|DROP)"));
  if (stop >= 0) section = section.slice(0, stop);

  const parts = section
    .split(new RegExp(`,|${B}(?:ЛЕВОЕ|ПРАВОЕ|ВНУТРЕННЕЕ|ПОЛНОЕ|ВНЕШНЕЕ|СОЕДИНЕНИЕ|LEFT|RIGHT|INNER|FULL|OUTER|JOIN)${A}`, "gi"))
    .map((s) => s.replace(new RegExp(`${B}ПО${A}[\\s\\S]*$`, "i"), ""))
    .map((s) => s.replace(new RegExp(`${B}ON${A}[\\s\\S]*$`, "i"), ""))
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const m = part.match(new RegExp(
      `^([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_.]*)\\s*(?:${B}(?:КАК|AS)${A}\\s+([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*))?`, "i"));
    if (!m) continue;
    const raw = m[1];
    const alias = m[2] ?? "";
    // Источник из трёх сегментов — табличная часть: Справочник.X.КонтактнаяИнформация.
    const parts = raw.split(".");
    const head = parts.length >= 3 ? parts.slice(0, 2).join(".") : raw;
    const third = parts.length >= 3 ? parts[2] : "";
    const full = META[head] ? head : (head.includes(".") ? head : "");
    const binding = { raw, alias, full_name: full, third_segment: third };
    sources.push(binding);
    bindings.set((alias || raw).toUpperCase(), binding);
  }
  return { sources, bindings, gave_up: false, reason: "" };
}

// Порт ЭлементыПроекцииPrivacy: элементы списка выборки по запятым нулевой
// глубины, с отсечением КАК <имя> и модификаторов ПЕРВЫЕ/РАЗЛИЧНЫЕ.
function projectionItems(command) {
  const start = command.search(word("(?:ВЫБРАТЬ|SELECT)"));
  if (start < 0) return [];
  let head = command.slice(start).replace(/^\s*(ВЫБРАТЬ|SELECT)\s*/i, "");
  head = head.replace(/^\s*(РАЗЛИЧНЫЕ|DISTINCT)\s+/i, "");
  head = head.replace(/^\s*(ПЕРВЫЕ|TOP)\s+\d+\s*/i, "");
  // Граница списка выборки на нулевой глубине.
  let depth = 0, end = head.length;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && isIdentChar(c) && !isIdentChar(head[i - 1] ?? "")) {
      const w = readIdent(head, i + 1).toUpperCase();
      if (["ИЗ", "FROM", "ПОМЕСТИТЬ", "INTO", "СГРУППИРОВАТЬ", "УПОРЯДОЧИТЬ", "ГДЕ", "ИТОГИ"].includes(w)) {
        end = i; break;
      }
      i += Math.max(0, w.length - 1);
    }
  }
  const list = head.slice(0, end);
  const items = [];
  depth = 0;
  let acc = "";
  for (const c of list) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) { items.push(acc); acc = ""; continue; }
    acc += c;
  }
  if (acc.trim()) items.push(acc);
  return items.map((raw) => {
    const m = raw.match(/^([\s\S]*?)\s+(?:КАК|AS)\s+([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*)\s*$/i);
    const expression = (m ? m[1] : raw).trim();
    const column = m ? m[2] : stripWs(expression).split(".").pop();
    return { expression, column };
  });
}

// Порт ПутиАдресованныеАлиасуPrivacy: пути, адресованные псевдонимом, на любой
// глубине. Границы идентификатора с обеих сторон обязательны.
function pathsForAlias(text, alias) {
  const out = [];
  if (!alias) return out;
  const up = text.toUpperCase();
  const needle = alias.toUpperCase();
  let from = 0;
  for (;;) {
    const at = up.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    const prev = at > 0 ? text[at - 1] : "";
    if (isIdentChar(prev) || prev === "." || prev === "&") continue;
    if (isIdentChar(text[at + needle.length] ?? "")) continue;
    let i = skipSpaces(text, at + needle.length + 1);
    if (text[i - 1] !== ".") continue;
    const path = [];
    while (text[i - 1] === ".") {
      i = skipSpaces(text, i + 1);
      const seg = readIdent(text, i);
      if (!seg) break;
      path.push(seg);
      i = skipSpaces(text, i + seg.length);
    }
    if (path.length) out.push(path);
  }
  return out;
}

// Порт ГолыеИдентификаторыВыраженияPrivacy
function bareIdentifiers(fragment) {
  const out = [];
  const seen = new Set();
  let i = 1;
  const len = fragment.length;
  while (i <= len) {
    const c = fragment[i - 1];
    if (!isIdentChar(c)) { i++; continue; }
    const word = readIdent(fragment, i);
    if (!word) { i++; continue; }
    const next = i + word.length;
    const prev = i > 1 ? fragment[i - 2] : "";
    const tailAt = skipSpaces(fragment, next);
    const significant = tailAt <= len ? fragment[tailAt - 1] : "";
    if (prev !== "." && prev !== "&" && significant !== "." && significant !== "("
      && !isDigits(word) && !EXPR_KEYWORDS.has(word.toUpperCase()) && !seen.has(word.toUpperCase())) {
      seen.add(word.toUpperCase());
      out.push(word);
    }
    i = next;
  }
  return out;
}

// ------------------------------------------------------------ решение

const mark = (type, field, derived = false) => ({ type_name: type, field_name: field, derived });

// Порт ПодменаПутиОтТипаPrivacy
function markPathFromType(type, path) {
  let fieldIndex = -1;
  for (let i = 0; i < path.length; i++) if (!isRefSegment(path[i])) fieldIndex = i;
  if (fieldIndex < 0) return null;
  let current = [type];
  for (let i = 0; i < fieldIndex; i++) {
    const next = segmentTypes(current, path[i]);
    if (!next.length) return null;
    current = next;
  }
  const field = path[fieldIndex];
  for (const t of current) if (fieldClosed(t, field)) return mark(t, field);
  return null;
}

// Порт ПодменаОдиночногоИдентификатораPrivacy (R-1)
function markBareIdentifier(name, map, ctx) {
  const field = String(name).trim();
  if (!field || field.startsWith("&") || isDigits(field)) return null;
  const path = [field];
  const sources = map.sources;
  if (sources.length === 1) return markSourceByField(sources[0], field, path, ctx, false);
  for (const s of sources) {
    const hit = markSourceByField(s, field, path, ctx, true);
    if (hit) return hit;
  }
  return null;
}

// Порт ПодменаИсточникаПоПолюPrivacy
function markSourceByField(binding, field, path, ctx, checkExists) {
  if (binding.full_name) {
    const sourceType = sourceTypeFor(binding);
    if (checkExists && !fieldExists(sourceType, field)) return null;
    return markPathFromType(sourceType, path);
  }
  const cols = ctx.marked.get(binding.raw.toUpperCase());
  if (cols) {
    const inherited = cols.get(field.toUpperCase());
    if (inherited) return mark(inherited.type_name, inherited.field_name, inherited.derived);
  }
  return null;
}

// Порт ПодменаЦепочкиPrivacy
function markChain(chain, map, ctx) {
  if (!isIdentChain(chain)) return null;
  const seg = chain.split(".");
  if (seg.length < 2) return markBareIdentifier(seg[0], map, ctx);
  const path = seg.slice(1);
  if (seg[0].startsWith("&")) {
    const types = ctx.parameters.get(seg[0].slice(1).toUpperCase());
    if (!types) return null;
    for (const t of types) { const hit = markPathFromType(t, path); if (hit) return hit; }
    return null;
  }
  const binding = map.bindings.get(seg[0].toUpperCase());
  if (!binding) return null;
  if (binding.full_name) return markPathFromType(sourceTypeFor(binding), path);
  const cols = ctx.marked.get(binding.raw.toUpperCase());
  if (cols && path.length === 1) {
    const inherited = cols.get(path[0].toUpperCase());
    return inherited ? mark(inherited.type_name, inherited.field_name, inherited.derived) : null;
  }
  return null;
}

// Порт ПодменаПредставленияPrivacy + ТипыАргументаПредставленияPrivacy
function markPresentation(expr, map, ctx) {
  const re = /(ПРЕДСТАВЛЕНИЕССЫЛКИ|ПРЕДСТАВЛЕНИЕ|REFPRESENTATION|PRESENTATION)\s*\(/gi;
  let m;
  while ((m = re.exec(expr))) {
    let depth = 1, i = m.index + m[0].length;
    let arg = "";
    while (i < expr.length && depth > 0) {
      if (expr[i] === "(") depth++;
      else if (expr[i] === ")") { depth--; if (!depth) break; }
      arg += expr[i]; i++;
    }
    const chained = markChain(stripWs(arg), map, ctx);
    if (chained) return chained;
    for (const t of presentationArgTypes(stripWs(arg), map, ctx)) {
      if (presentationClosed(t)) return mark(t, "Представление");
    }
  }
  return null;
}

function presentationArgTypes(chain, map, ctx) {
  if (!isIdentChain(chain)) return [];
  if (chain.startsWith("&")) return ctx.parameters.get(chain.slice(1).toUpperCase()) ?? [];
  const seg = chain.split(".");
  if (seg.length < 2) return bareIdentifierTypes(seg[0], map);
  const binding = map.bindings.get(seg[0].toUpperCase());
  if (!binding || !binding.full_name) return [];
  let current = [sourceTypeFor(binding)];
  for (const s of seg.slice(1)) {
    current = segmentTypes(current, s);
    if (!current.length) return [];
  }
  return current;
}

// Порт ТипыГологоИдентификатораPrivacy
function bareIdentifierTypes(name, map) {
  const out = [];
  const field = String(name).trim();
  if (!field || field.startsWith("&")) return out;
  const fulls = map.sources.filter((s) => s.full_name).map(sourceTypeFor);
  for (const full of fulls) {
    if (fulls.length > 1 && !fieldExists(full, field)) continue;
    for (const r of segmentTypes([full], field)) if (!out.includes(r)) out.push(r);
  }
  return out;
}

// Порт ПодменаОперандовВыраженияPrivacy (R-2 + R-3 + R-7)
function markOperands(expr, map, ctx) {
  const fragment = String(expr).trim();
  if (!fragment) return null;
  for (const s of map.sources) {
    if (!s.full_name || !s.alias) continue;
    for (const path of pathsForAlias(fragment, s.alias)) {
      const hit = markPathFromType(sourceTypeFor(s), path);
      if (hit) { hit.derived = true; return hit; }
    }
  }
  // R-7: операнд — колонка временной таблицы. Прямое обращение ВТ.Х закрыто
  // наследованием пометки, а выражение над ним снимало маску (девятая форма,
  // открыта живьём на трёх контурах). В BSL добавляется и разрешение по схеме
  // колонок ВТ для разыменования ссылочной колонки — у порта модели схемы нет,
  // ветка покрыта настольной трассировкой.
  for (const s of map.sources) {
    if (s.full_name || !s.alias) continue;
    const cols = ctx.marked.get(s.raw.toUpperCase());
    if (!cols) continue;
    for (const path of pathsForAlias(fragment, s.alias)) {
      if (path.length !== 1) continue;
      const inherited = cols.get(path[0].toUpperCase());
      if (inherited) return mark(inherited.type_name, inherited.field_name, true);
    }
  }
  for (const [name, types] of ctx.parameters) {
    for (const path of pathsForAlias(fragment, "&" + name)) {
      for (const t of types) {
        const hit = markPathFromType(t, path);
        if (hit) { hit.derived = true; return hit; }
      }
    }
  }
  for (const name of bareIdentifiers(fragment)) {
    const hit = markBareIdentifier(name, map, ctx);
    if (hit) { hit.derived = true; return hit; }
  }
  return null;
}

// Порт ПодменаВыраженияПроекцииPrivacy
function markExpression(expr, map, ctx) {
  if (!String(expr).trim()) return null;
  return markChain(stripWs(expr), map, ctx)
    ?? markPresentation(expr, map, ctx)
    ?? markOperands(expr, map, ctx);
}

// Порт КорниПутейВыраженияPrivacy
const META_KINDS = new Set(["СПРАВОЧНИК", "ДОКУМЕНТ", "КОНСТАНТА", "ПЕРЕЧИСЛЕНИЕ", "РЕГИСТРСВЕДЕНИЙ",
  "РЕГИСТРНАКОПЛЕНИЯ", "РЕГИСТРБУХГАЛТЕРИИ", "РЕГИСТРРАСЧЕТА", "ПЛАНСЧЕТОВ", "ПЛАНВИДОВХАРАКТЕРИСТИК",
  "ПЛАНВИДОВРАСЧЕТА", "ПЛАНОБМЕНА", "БИЗНЕСПРОЦЕСС", "ЗАДАЧА", "ЖУРНАЛДОКУМЕНТОВ"]);

function pathRoots(fragment) {
  const out = [];
  const seen = new Set();
  let i = 1;
  const len = fragment.length;
  while (i <= len) {
    if (!isIdentChar(fragment[i - 1])) { i++; continue; }
    const w = readIdent(fragment, i);
    if (!w) { i++; continue; }
    const next = i + w.length;
    const tailAt = skipSpaces(fragment, next);
    const significant = tailAt <= len ? fragment[tailAt - 1] : "";
    const prev = i > 1 ? fragment[i - 2] : "";
    if (significant === "." && prev !== ".") {
      const root = prev === "&" ? "&" + w : w;
      const afterAs = /(?:КАК|AS)\s*$/i.test(fragment.slice(0, i - 1));
      if (!META_KINDS.has(w.toUpperCase()) && !afterAs && !EXPR_KEYWORDS.has(w.toUpperCase())
        && !seen.has(root.toUpperCase())) {
        seen.add(root.toUpperCase());
        out.push(root);
      }
    }
    i = next;
  }
  return out;
}

// Порт ИдентификаторПривязанPrivacy
function identifierBound(field, map, ctx) {
  const sources = map.sources;
  if (!sources.length) return true;
  if (sources.length === 1 && sources[0].full_name) return true;
  for (const s of sources) {
    if (s.full_name) { if (fieldExists(sourceTypeFor(s), field)) return true; continue; }
    const cols = ctx.marked.get(s.raw.toUpperCase());
    if (cols && cols.has(field.toUpperCase())) return true;
  }
  return false;
}

// Порт ЕстьНеразрешенныйОперандPrivacy
function hasUnresolvedOperand(expr, map, ctx) {
  const fragment = String(expr).trim();
  if (!fragment) return false;
  for (const root of pathRoots(fragment)) {
    if (root.startsWith("&")) {
      if (!ctx.parameters.has(root.slice(1).toUpperCase())) return true;
      continue;
    }
    if (!map.bindings.has(root.toUpperCase())) return true;
  }
  for (const name of bareIdentifiers(fragment)) {
    if (!identifierBound(name, map, ctx)) return true;
  }
  return false;
}

// Порт ЕстьЗакрытыйИсточникВКомандеPrivacy
function hasClosedSource(map, ctx) {
  for (const s of map.sources) {
    if (!s.full_name) {
      const cols = ctx.marked.get(s.raw.toUpperCase());
      if (cols && cols.size) return true;
      continue;
    }
    if (presentationClosed(sourceTypeFor(s))) return true;
    if ((POLICY[s.full_name]?.fields ?? []).length) return true;
    if (isPersonSet(s.full_name)) return true;
  }
  return false;
}

// Порт ЭтоЗвездочкаПроекцииPrivacy
const isProjectionStar = (expr) => {
  const f = stripWs(expr);
  return f === "*" || (f.length > 1 && f.endsWith(".*"));
};

// Порт КолонкаВременнойТаблицыИзвестнаPrivacy. Схемы колонок ВТ у порта нет
// (СхемаКолонокВременныхТаблицPrivacy опирается на метаданные контура), поэтому
// здесь остаются два источника знания из трёх: пометка и осмотр. Для кейсов порта
// этого достаточно — третий источник знание только РАСШИРЯЕТ.
function vtColumnKnown(raw, column, ctx) {
  const key = raw.toUpperCase();
  const marks = ctx.marked.get(key);
  if (marks && marks.has(column.toUpperCase())) return true;
  const examined = ctx.examinedTables.get(key);
  return Boolean(examined && examined.get(column.toUpperCase())?.examined);
}

// Порт ЕстьОперандБезСоставаПолейPrivacy (P-0 п. 4a)
function hasOperandWithoutFieldSet(expr, map, ctx) {
  const fragment = String(expr).trim();
  if (!fragment) return false;
  for (const s of map.sources) {
    if (s.full_name || !s.alias) continue;
    for (const path of pathsForAlias(fragment, s.alias)) {
      if (s.raw === SUBQUERY) return true;
      if (path.length === 1) {
        if (!vtColumnKnown(s.raw, path[0], ctx)) return true;
        continue;
      }
      // Разыменование колонки ВТ: без схемы ВТ порт про такой путь ничего не знает.
      if (!vtColumnKnown(s.raw, path[0], ctx)) return true;
    }
  }
  return false;
}

// Порт ВыражениеОсмотреноPrivacy
function expressionExamined(expr, map, ctx) {
  const fragment = String(expr).trim();
  if (!fragment) return false;
  if (isProjectionStar(fragment)) return false;
  return !hasOperandWithoutFieldSet(fragment, map, ctx);
}

// Порт ЗакрытыеКолонкиКомандыPrivacy (одна ветка, без ОБЪЕДИНИТЬ) + R-4 + P-0
function markCommand(command, ctx) {
  const map = sourceMap(command);
  const closedSource = hasClosedSource(map, ctx);
  const result = new Map();
  const examined = new Map();
  const items = projectionItems(command);
  // Порт ПроверитьПолнотуПроекцииPrivacy
  if (word("(?:ВЫБРАТЬ|SELECT)").test(command)
    && (!items.length || items.some((i) => isProjectionStar(i.expression)))) {
    ctx.parseComplete = false;
  }
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item.column) continue;
    let m = markExpression(item.expression, map, ctx);
    let unresolved = false;
    let isExamined = true;
    if (!m) {
      unresolved = hasUnresolvedOperand(item.expression, map, ctx);
      isExamined = !unresolved && expressionExamined(item.expression, map, ctx);
    }
    // R-4 — только при НЕразрешённом операнде. «Разобрали и вышло, что открыто»
    // закрывать нельзя: это класс Д-3, молча испорченная аналитика.
    if (!m && closedSource && unresolved) { m = mark("", "", true); isExamined = true; }
    // Порт ОтметитьОсмотрКолонкиPrivacy: у ветки ОБЪЕДИНИТЬ решает конъюнкция.
    const key = item.column.toUpperCase();
    const prev = examined.get(key);
    if (prev) prev.examined = prev.examined && isExamined;
    else examined.set(key, { examined: isExamined, index, projection_count: items.length });
    if (m) result.set(key, m);
  }
  return { marks: result, examined };
}

// Порт КолонкиДляПодменыPrivacy: пакет команд, пометки и осмотр ВТ переносятся дальше.
function markQuery(query, parameters = new Map()) {
  const ctx = { marked: new Map(), examinedTables: new Map(), parameters, parseComplete: true };
  let last = { marks: new Map(), examined: new Map() };
  for (const command of query.split(";")) {
    if (!command.trim()) continue;
    last = markCommand(command, ctx);
    const into = command.match(new RegExp(`${B}(?:ПОМЕСТИТЬ|INTO)${A}\\s+([A-Za-zА-Яа-яЁё_][0-9A-Za-zА-Яа-яЁё_]*)`, "i"));
    if (into) {
      ctx.marked.set(into[1].toUpperCase(), last.marks);
      ctx.examinedTables.set(into[1].toUpperCase(), last.examined);
    }
  }
  return { marks: last.marks, examined: last.examined, parseComplete: ctx.parseComplete };
}

// Порт вердикта первого эшелона (privacy_column_decisions в
// ВыполнитьЗапросСОграничениями + КолонкаОткрытаПервымЭшелономLLM).
//   «закрыто»      — пометка есть, значение подменяется в запросном пути;
//   «открыто»      — вердикт выдан и он «открыто»: второй эшелон подавлен;
//   «вердикта нет» — карта не выдана либо колонки в ней нет: работает второй эшелон.
// ЛЕГАСИ (--legacy) воспроизводит поведение до P-0: карта по всем колонкам
// результата, вердикт из наличия пометки. Порт ОБЯЗАН различать эти два режима —
// зелёный порт при мёртвом коде на этом проекте уже случался.
function verdict(query, column, parameters) {
  const { marks, examined, parseComplete } = markQuery(query, parameters ?? new Map());
  const key = column.toUpperCase();
  if (marks.has(key)) return "закрыто";
  if (LEGACY) return "открыто";
  if (!parseComplete) return "вердикта нет";
  return examined.get(key)?.examined ? "открыто" : "вердикта нет";
}

// Порт СодержитWildcardSelect (второй рубеж). ЛЕГАСИ — шесть буквальных подстрок
// и `.*`, ровно как до правки.
function wildcardForbidden(query) {
  if (LEGACY) {
    const norm = ` ${query.replace(/\s+/g, " ").toUpperCase()} `;
    return [" ВЫБРАТЬ * ", " ВЫБРАТЬ РАЗРЕШЕННЫЕ * ", " ВЫБРАТЬ РАЗЛИЧНЫЕ * ",
      " SELECT * ", " SELECT ALLOWED * ", " SELECT DISTINCT * "].some((s) => norm.includes(s))
      || query.includes(".*");
  }
  const MODS = ["ВЫБРАТЬ", "SELECT", "РАЗЛИЧНЫЕ", "DISTINCT", "РАЗРЕШЕННЫЕ", "ALLOWED"];
  for (let at = query.indexOf("*"); at >= 0; at = query.indexOf("*", at + 1)) {
    let i = at - 1;
    while (i >= 0 && /\s/.test(query[i])) i--;
    if (i < 0) continue;
    const ch = query[i];
    if (ch === "." || ch === ",") return true;
    if (!isIdentChar(ch)) continue;
    const wordBefore = wordEndingAt(query, i);
    if (MODS.includes(wordBefore.toUpperCase())) return true;
    if (!isDigits(wordBefore)) continue;
    let j = i - wordBefore.length;
    while (j >= 0 && /\s/.test(query[j])) j--;
    if (j < 0) continue;
    if (["ПЕРВЫЕ", "TOP"].includes(wordEndingAt(query, j).toUpperCase())) return true;
  }
  return false;
}

// Порт СловоДоПозиции: слово, кончающееся в 0-based позиции i включительно.
function wordEndingAt(text, i) {
  let start = i;
  while (start >= 0 && isIdentChar(text[start])) start--;
  return text.slice(start + 1, i + 1);
}

// Порт МаскаПоляДляLLM + ПодменаЗначенияPrivacy для строкового значения:
// что окажется в колонке. Нужен для R-3 — маска против кода псевдонима.
// Код псевдонима возможен только у типа с псевдонимом (type_aliases): у типа,
// закрытого одними масками полей, кода нет — любое его поле получает маску.
function substitution(markRecord) {
  if (!markRecord) return "открыто";
  if (markRecord.derived) return "маска";
  if (!POLICY[markRecord.type_name]?.alias) return "маска";
  const nameLike = ["", "Наименование", "НаименованиеПолное", "Код", "Представление"];
  return nameLike.includes(markRecord.field_name) ? "код псевдонима" : "маска";
}

// ------------------------------------------------------------------ кейсы

const refParam = new Map([["РЕФ", [CLOSED]]]);

// Встроенный подзапрос источника — носитель форм P-0 и A-2. Объявлен здесь, а не
// у VERDICT_CASES: на него ссылаются и кейсы вида подстановки в CASES.
const SUB = `(ВЫБРАТЬ Т0.НаименованиеПолное КАК НаименованиеПолное, Т0.Ссылка КАК Ссылка`
  + ` ИЗ ${CLOSED} КАК Т0)`;

const CASES = [
  // H-матрица: живой прогон 05.08.2026 показал H1–H6, H8, H10 ОТКРЫТЫМИ.
  ["H0 контроль Т.Поле", `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Наименование КАК П ИЗ ${CLOSED} КАК Т`, "П", "код псевдонима"],
  ["H1 без псевдонима", `ВЫБРАТЬ ПЕРВЫЕ 5 Наименование КАК П ИЗ ${CLOSED}`, "П", "код псевдонима"],
  ["H2 ПОДСТРОКА", `ВЫБРАТЬ ПЕРВЫЕ 5 ПОДСТРОКА(Т.Наименование, 1, 20) КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H3 конкатенация", `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Наименование + "" КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H4 ЕСТЬNULL", `ВЫБРАТЬ ПЕРВЫЕ 5 ЕСТЬNULL(Т.Наименование, "") КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H5 ВЫБОР", `ВЫБРАТЬ ПЕРВЫЕ 5 ВЫБОР КОГДА ИСТИНА ТОГДА Т.Наименование ИНАЧЕ "" КОНЕЦ КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H6 агрегат", `ВЫБРАТЬ МАКСИМУМ(Т.Наименование) КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["H8 ПОМЕСТИТЬ без псевдонима",
    `ВЫБРАТЬ Наименование КАК Н ПОМЕСТИТЬ ВТ ИЗ ${CLOSED};ВЫБРАТЬ ВТ.Н КАК П ИЗ ВТ КАК ВТ`, "П", "код псевдонима"],
  ["H8' ПОМЕСТИТЬ и выбор оба без псевдонима",
    `ВЫБРАТЬ Наименование КАК Н ПОМЕСТИТЬ ВТ ИЗ ${CLOSED};ВЫБРАТЬ Н КАК П ИЗ ВТ`, "П", "код псевдонима"],
  ["H9 СГРУППИРОВАТЬ ПО",
    `ВЫБРАТЬ Т.Наименование КАК П ИЗ ${CLOSED} КАК Т СГРУППИРОВАТЬ ПО Т.Наименование`, "П", "код псевдонима"],
  ["H10 псевдоним типа без квалификатора", `ВЫБРАТЬ Наименование КАК П ИЗ ${CLOSED}`, "П", "код псевдонима"],
  ["H11 контроль псевдонима", `ВЫБРАТЬ Т.Наименование КАК П ИЗ ${CLOSED} КАК Т`, "П", "код псевдонима"],
  // Комбинации, найденные при разборе: выражение над голым именем и представление
  // без квалификатора — тот же класс, в измеренной таблице их не было.
  ["K1 ПОДСТРОКА(голое имя)", `ВЫБРАТЬ ПОДСТРОКА(Наименование, 1, 20) КАК П ИЗ ${CLOSED}`, "П", "маска"],
  ["K2 ПРЕДСТАВЛЕНИЕ(Ссылка) без псевдонима", `ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Ссылка) КАК П ИЗ ${CLOSED}`, "П", "код псевдонима"],
  ["K3 разыменование владельца",
    `ВЫБРАТЬ Д.Владелец.Наименование КАК П ИЗ Справочник.Подчиненный КАК Д`, "П", "код псевдонима"],
  ["K4 ПОДСТРОКА от разыменования владельца",
    `ВЫБРАТЬ ПОДСТРОКА(Д.Владелец.Наименование, 1, 5) КАК П ИЗ Справочник.Подчиненный КАК Д`, "П", "маска"],
  // R-4 срабатывает на НЕразрешённом операнде: поле, которого нет ни у одного из
  // нескольких источников. Так выглядит неполнота нашего взгляда на метаданные —
  // поле может оказаться закрытым, и открывать его наугад нельзя.
  ["K5 R-4: неизвестное поле при нескольких источниках, один закрыт",
    `ВЫБРАТЬ ПОДСТРОКА(НеизвестноеПоле, 1, 5) КАК П ИЗ ${CLOSED} КАК Т СОЕДИНЕНИЕ ${OPEN} КАК О`, "П", "маска"],
  ["K6 R-4 не трогает литерал", `ВЫБРАТЬ "текст" КАК П ИЗ ${CLOSED} КАК Т`, "П", "открыто"],
  ["K7 R-4 не трогает агрегат по звёздочке", `ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК П ИЗ ${CLOSED} КАК Т`, "П", "открыто"],
  ["K8 R-4 не трогает ЗНАЧЕНИЕ(<тип>.ПустаяСсылка)",
    `ВЫБРАТЬ ЗНАЧЕНИЕ(${OPEN}.ПустаяСсылка) КАК П ИЗ ${CLOSED} КАК Т`, "П", "открыто"],
  // R-6, парные пробы: обязаны остаться ОТКРЫТЫМИ.
  ["R6-1 выражение над открытым типом, закрытых источников нет",
    `ВЫБРАТЬ ПОДСТРОКА(О.Наименование, 1, 20) КАК П ИЗ ${OPEN} КАК О`, "П", "открыто"],
  ["R6-2 голое имя открытого типа, закрытых источников нет",
    `ВЫБРАТЬ Наименование КАК П ИЗ ${OPEN}`, "П", "открыто"],
  ["R6-3 голое имя есть только у открытого источника",
    `ВЫБРАТЬ Сумма КАК П ИЗ ${OPEN} КАК О СОЕДИНЕНИЕ ${CLOSED} КАК З`, "П", "открыто"],
  ["R6-4 квалифицированное поле открытого типа при закрытом соседе",
    `ВЫБРАТЬ О.Наименование КАК П ИЗ ${OPEN} КАК О СОЕДИНЕНИЕ ${CLOSED} КАК З`, "П", "открыто"],
  ["R6-5 выражение над открытым полем при закрытом соседе — R-4 не должен накрыть",
    `ВЫБРАТЬ ПОДСТРОКА(О.Наименование, 1, 20) КАК П ИЗ ${OPEN} КАК О СОЕДИНЕНИЕ ${CLOSED} КАК З`, "П", "открыто"],
  ["R6-6 закрытое и открытое имя одной строкой (П4) — закрытое",
    `ВЫБРАТЬ З.Наименование КАК Закрытое, О.Наименование КАК Открытое ИЗ ${CLOSED} КАК З, ${OPEN} КАК О`,
    "Закрытое", "код псевдонима"],
  ["R6-7 закрытое и открытое имя одной строкой (П4) — открытое",
    `ВЫБРАТЬ З.Наименование КАК Закрытое, О.Наименование КАК Открытое ИЗ ${CLOSED} КАК З, ${OPEN} КАК О`,
    "Открытое", "открыто"],
  // Д-2 (R-7): девятая форма — выражение над колонкой ВТ. Прямое обращение
  // закрыто (это H8), обёртка в функцию снимала маску на трёх контурах.
  ["A7 ПОДСТРОКА над закрытой колонкой ВТ",
    `ВЫБРАТЬ Т.Наименование КАК Х ПОМЕСТИТЬ ВТ ИЗ ${CLOSED} КАК Т;ВЫБРАТЬ ПОДСТРОКА(ВТ.Х, 1, 20) КАК П ИЗ ВТ КАК ВТ`,
    "П", "маска"],
  ["A7-2 ЕСТЬNULL над закрытой колонкой ВТ",
    `ВЫБРАТЬ Т.Наименование КАК Х ПОМЕСТИТЬ ВТ ИЗ ${CLOSED} КАК Т;ВЫБРАТЬ ЕСТЬNULL(ВТ.Х, "") КАК П ИЗ ВТ КАК ВТ`,
    "П", "маска"],
  ["A7' то же над колонкой ВТ из открытого типа — парная",
    `ВЫБРАТЬ О.Наименование КАК Х ПОМЕСТИТЬ ВТО ИЗ ${OPEN} КАК О;ВЫБРАТЬ ПОДСТРОКА(ВТО.Х, 1, 20) КАК П ИЗ ВТО КАК ВТО`,
    "П", "открыто"],
  // Д-4 (R-9): Представление наследует закрытость от любого закрытого реквизита.
  ["R9-1 Представление регистра с масками полей",
    `ВЫБРАТЬ Т.Представление КАК П ИЗ ${MASKED_REG} КАК Т`, "П", "маска"],
  ["R9-2 поле из масок регистра",
    `ВЫБРАТЬ Т.Серия КАК П ИЗ ${MASKED_REG} КАК Т`, "П", "маска"],
  ["R9-3 открытое поле регистра остаётся открытым",
    `ВЫБРАТЬ Т.ДатаВыдачи КАК П ИЗ ${MASKED_REG} КАК Т`, "П", "открыто"],
  // Парные к R-9: у СПРАВОЧНИКА с единственной не-имя-подобной маской не
  // закрывается ничего лишнего — ни имя, ни код, ни представление. Раньше
  // представление закрывалось (признак был константой «есть маски»), и это
  // ломало группировку по представлению, не добавляя защиты: имя достаётся
  // напрямую. Различитель — существует ли Представление как реквизит типа.
  // R9-4 ПЕРЕРАЗБИТ 07.08.2026 вместе с R-13, и вердикт изменён осознанно.
  // Прежнее ожидание «Наименование открыто» держалось на доводе «закрывать
  // представление бессмысленно, имя достаётся напрямую». R-13 закрывает само
  // имя у ЛЮБОГО типа закрытого набора, и довод больше не применим к имени.
  // Цель R9-4 при этом НЕ откатывается и проверяется соседними половинами:
  // признак наследования Представления не стал константой «есть маски» —
  // R9-5 и R9-6 обязаны остаться открытыми. Оснастка замера цены считает так
  // же (privacy_r13_cost.mjs: ИМЯ_ПОДОБНЫЕ добавляются в «закрыто» только при
  // имя-подобном поле в записи), поэтому +3/+1/+3 этим не сдвигается.
  ["R9-4 имя типа с одной маской Комментарий — закрыто ЯДРОМ R-13",
    `ВЫБРАТЬ Т.Наименование КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "маска"],
  ["R9-5 код того же типа — открыт",
    `ВЫБРАТЬ Т.Код КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "открыто"],
  ["R9-6 ПРЕДСТАВЛЕНИЕ ссылки того же типа — тоже открыто",
    `ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(Т.Ссылка) КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "открыто"],
  ["R9-7 сама маска при этом работает",
    `ВЫБРАТЬ Т.Комментарий КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "маска"],

  // ---- R-16: разыменование сквозь табличную часть от шапки (§4.18) ----
  // Живьём на `.3`: G11 открыт 0/5 на BUH и ERP, т5 закрыт 5/5. Порт до правки
  // показывал на этих формах зелень, потому что его заглушка давала ТЧ поле
  // «Ссылка», которого у табличных частей нет ни на одной конфигурации.
  ["G11 путь от шапки сквозь ТЧ: <шапка>.<ТЧ>.Ссылка.Наименование",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.КонтактнаяИнформация.Ссылка.Наименование КАК П ИЗ ${CLOSED} КАК К`,
    "П", "код псевдонима"],
  ["G11-2 то же на НаименованиеПолное",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.КонтактнаяИнформация.Ссылка.НаименованиеПолное КАК П ИЗ ${CLOSED} КАК К`,
    "П", "код псевдонима"],
  ["G11' парная: тот же путь от ОТКРЫТОГО типа — открыт",
    `ВЫБРАТЬ ПЕРВЫЕ 5 О.КонтактнаяИнформация.Ссылка.Наименование КАК П ИЗ ${OPEN} КАК О`,
    "П", "открыто"],
  ["G11'' т5: Т.Ссылка.Наименование из ТЧ-ИСТОЧНИКА — работающий путь не смещён",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Ссылка.Наименование КАК П ИЗ ${TP_CLOSED.replace(".ТабличнаяЧасть.", ".")} КАК Т`,
    "П", "код псевдонима"],
  ["G11''' НомерСтроки после структурного разрешения — остаётся открытым",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.НомерСтроки КАК П ИЗ ${TP_CLOSED.replace(".ТабличнаяЧасть.", ".")} КАК Т`,
    "П", "открыто"],
  // ---- R-11: собственные поля строки табличной части (§4.13) ----
  // Адрес уходит пятью полями сразу; закрыть одно Представление недостаточно.
  ["G2 поле ТЧ закрытого типа от шапки: Значение",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.КонтактнаяИнформация.Значение КАК П ИЗ ${CLOSED} КАК К`, "П", "маска"],
  ["G2-2 поле ТЧ от ТЧ-источника: ЗначенияПолей",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.ЗначенияПолей КАК П ИЗ ${TP_CLOSED.replace(".ТабличнаяЧасть.", ".")} КАК Т`,
    "П", "маска"],
  ["G2-3 телефон в той же ТЧ",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.НомерТелефона КАК П ИЗ ${TP_CLOSED.replace(".ТабличнаяЧасть.", ".")} КАК Т`,
    "П", "маска"],
  ["G2' парная: та же ТЧ у ОТКРЫТОГО типа — значения как есть",
    `ВЫБРАТЬ ПЕРВЫЕ 5 О.КонтактнаяИнформация.Значение КАК П ИЗ ${OPEN} КАК О`, "П", "открыто"],
  ["G2'' классификаторы закрытой ТЧ остаются открытыми: Вид",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.КонтактнаяИнформация.Вид КАК П ИЗ ${CLOSED} КАК К`, "П", "открыто"],
  ["G2''' классификатор Тип — тоже открыт",
    `ВЫБРАТЬ ПЕРВЫЕ 5 К.КонтактнаяИнформация.Тип КАК П ИЗ ${CLOSED} КАК К`, "П", "открыто"],
  // ---- R-12/R-15: подчинённые справочники персон (§4.14, §4.17) ----
  ["G3 подчинённый персоне: Фамилия закрыта правилом, записи в политике нет",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Фамилия КАК П ИЗ ${PERSON_SUB} КАК Т`, "П", "маска"],
  ["G14' подчинённый персоне: Наименование — ядро R-13",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Наименование КАК П ИЗ ${PERSON_SUB} КАК Т`, "П", "маска"],
  ["G14'-2 подчинённый персоне: НаименованиеСлужебное — подстрока ядра",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.НаименованиеСлужебное КАК П ИЗ ${PERSON_SUB} КАК Т`, "П", "маска"],
  ["G14'' подчинённый персоне: Имя — держится ТОЛЬКО на R-15",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Имя КАК П ИЗ ${PERSON_SUB} КАК Т`, "П", "маска"],
  ["G3' классификатор подчинённого: СтепеньРодства — открыт",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.СтепеньРодства КАК П ИЗ ${PERSON_SUB} КАК Т`, "П", "открыто"],
  ["G3''' подчинённый НЕ персоне (номенклатура контрагентов) — открыт",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Наименование КАК П ИЗ ${CLOSED_SUB} КАК Т`, "П", "открыто"],
  ["G10 набор ФИО у самого типа персон: Отчество",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Отчество КАК П ИЗ ${PERSON} КАК Т`, "П", "маска"],
  ["G10' §6.6: МестоРождения остаётся ОТКРЫТЫМ по решению заказчика",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.МестоРождения КАК П ИЗ ${PERSON} КАК Т`, "П", "открыто"],
  // ---- R-13: ядро и его ограничители (§4.15) ----
  // Подстановка — МАСКА, а не код псевдонима, и это не недоработка: по M-03.3
  // вид подстановки решает поле, а не наличие псевдонима у типа. Код означает
  // «это тот самый объект» и служит для соединения строк; РасширенноеПредставлениеИНН
  // именем объекта не является, и код в такой колонке склеивал бы строки.
  ["G4-син подстрока ядра: РасширенноеПредставлениеИНН закрывается маской",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.РасширенноеПредставлениеИНН КАК П ИЗ ${CLOSED} КАК Т`, "П", "маска"],
  ["G5 белый список 4a: Код остаётся открытым у типа БЕЗ псевдонима",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.Код КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "открыто"],
  ["G5' 4b чужой субъект: НаименованиеБанка — открыт",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.НаименованиеБанка КАК П ИЗ ${CLOSED} КАК Т`, "П", "открыто"],
  ["G5'-2 4c классификатор: НаименованиеОКВЭД — открыт",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.НаименованиеОКВЭД КАК П ИЗ ${CLOSED} КАК Т`, "П", "открыто"],
  ["G5'-3 4d §6.6: МестоРожденияПредставление — открыто",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.МестоРожденияПредставление КАК П ИЗ ${PERSON} КАК Т`, "П", "открыто"],
  ["G4-номер ядро НЕ содержит Номер: поля с ним не закрываются правилом",
    `ВЫБРАТЬ ПЕРВЫЕ 5 Т.НомерДоговора КАК П ИЗ ${MASKED_CAT} КАК Т`, "П", "открыто"],
  ["G4' ограничитель 2: ядро не трогает тип вне закрытого набора",
    `ВЫБРАТЬ ПЕРВЫЕ 5 О.НаименованиеПолное КАК П ИЗ ${OPEN} КАК О`, "П", "открыто"],
  // A-2, продолжение: ВИД подстановки на голом имени из подзапроса. «Закрыто»
  // одинаково у прямой пометки и у R-4, поэтому механизм различает только вид —
  // и пиньгуется здесь, а не в VERDICT_CASES. Разбор механизмов — там же, у
  // кейсов P0-F1-*.
  ["F1-5 голое имя из подзапроса, поле ОБЪЯВЛЕНО в метаданных: прямая пометка",
    `ВЫБРАТЬ Наименование КАК П ИЗ ${SUB} КАК Т`, "П", "код псевдонима"],
  ["F1-6 то же без псевдонима подзапроса: единственный источник забирает имя",
    `ВЫБРАТЬ Наименование КАК П ИЗ ${SUB}`, "П", "код псевдонима"],
  ["F1-7 голое имя, поля в метаданных НЕТ: страховка R-4, маска",
    `ВЫБРАТЬ НаименованиеПолное КАК П ИЗ ${SUB} КАК Т`, "П", "маска"],
];

// Кейс с параметром задаётся отдельно: у него свой набор типов параметров.
const PARAM_CASES = [
  ["P1 ПРЕДСТАВЛЕНИЕ(&Реф) без ИЗ", "ВЫБРАТЬ ПРЕДСТАВЛЕНИЕ(&Реф) КАК П", "П", "код псевдонима"],
  ["P2 ПОДСТРОКА(&Реф.Наименование)", "ВЫБРАТЬ ПОДСТРОКА(&Реф.Наименование, 1, 5) КАК П", "П", "маска"],
];

// ------------------------------------------------- P-0: вердикт и второй рубеж
//
// Таблица форм из §2.7 ТЗ, замеренная живьём 10.08.2026 на BUH. Порт проверяет два
// независимых рубежа по каждой форме: выдан ли вердикт «открыто» (звено 3 — сам
// дефект) и отклоняет ли форму предвалидатор (звено 1 — второй рубеж).
//
// Ключевое: «вердикта нет» — это НЕ «закрыто». Значение закрывает второй эшелон,
// и порт про него ничего сказать не может: у него нет ни ответа, ни политики
// маскировщика. Порт отвечает ровно за то, что первый эшелон больше не глушит
// второй там, где сам ничего не видел.
const VERDICT_CASES = [
  // ---- формы, которые текли: вердикт «открыто» обязан исчезнуть ----
  ["P0-1 звёздочка ПЕРВЫЕ N", `ВЫБРАТЬ ПЕРВЫЕ 3 * ИЗ ${CLOSED} КАК Т`, "НАИМЕНОВАНИЕ", "вердикта нет"],
  ["P0-2 SELECT TOP N *", `SELECT TOP 3 * FROM ${CLOSED} КАК Т`, "НАИМЕНОВАНИЕ", "вердикта нет"],
  ["P0-3 ПЕРВЫЕ N РАЗЛИЧНЫЕ *", `ВЫБРАТЬ ПЕРВЫЕ 3 РАЗЛИЧНЫЕ * ИЗ ${CLOSED} КАК Т`,
    "НАИМЕНОВАНИЕ", "вердикта нет"],
  ["P0-4 подзапрос в ИЗ, без звёздочки",
    `ВЫБРАТЬ Т.НаименованиеПолное КАК П ИЗ ${SUB} КАК Т`, "П", "вердикта нет"],
  ["P0-5 подзапрос + Ссылка рядом: поле политики",
    `ВЫБРАТЬ Т.НаименованиеПолное КАК П, Т.Ссылка КАК Р ИЗ ${SUB} КАК Т`, "П", "вердикта нет"],
  ["P0-5' та же форма: колонка ссылки",
    `ВЫБРАТЬ Т.НаименованиеПолное КАК П, Т.Ссылка КАК Р ИЗ ${SUB} КАК Т`, "Р", "вердикта нет"],
  ["P0-6 соединение с подзапросом",
    `ВЫБРАТЬ П.НаименованиеПолное КАК П ИЗ ${OPEN} КАК О ЛЕВОЕ СОЕДИНЕНИЕ ${SUB} КАК П`
    + ` ПО О.Ссылка = П.Ссылка`, "П", "вердикта нет"],
  ["P0-7 подзапрос в подзапросе, два уровня",
    `ВЫБРАТЬ Т.НаименованиеПолное КАК П ИЗ (ВЫБРАТЬ В.НаименованиеПолное КАК НаименованиеПолное`
    + ` ИЗ ${SUB} КАК В) КАК Т`, "П", "вердикта нет"],
  ["P0-8 неосмотренность переживает ПОМЕСТИТЬ",
    `ВЫБРАТЬ Т.НаименованиеПолное КАК Н ПОМЕСТИТЬ ВТ ИЗ ${SUB} КАК Т;`
    + ` ВЫБРАТЬ ВТ.Н КАК П ИЗ ВТ КАК ВТ`, "П", "вердикта нет"],
  // ---- контроль «закрыто лишнее»: вердикт обязан ОСТАТЬСЯ ----
  ["P0-9 контроль: прямое поле закрытого типа — закрыто",
    `ВЫБРАТЬ Т.НаименованиеПолное КАК П ИЗ ${CLOSED} КАК Т`, "П", "закрыто"],
  ["P0-10 контроль: поле открытого типа — вердикт «открыто» на месте",
    `ВЫБРАТЬ О.НаименованиеПолное КАК П ИЗ ${OPEN} КАК О`, "П", "открыто"],
  ["P0-11 контроль: открытая колонка ВТ — вердикт «открыто» переживает ПОМЕСТИТЬ",
    `ВЫБРАТЬ О.Сумма КАК С ПОМЕСТИТЬ ВТ ИЗ ${OPEN} КАК О; ВЫБРАТЬ ВТ.С КАК П ИЗ ВТ КАК ВТ`,
    "П", "открыто"],
  ["P0-12 регресс ОБЪЕДИНИТЬ: ветка с именованным источником закрывает колонку",
    `ВЫБРАТЬ Т.НаименованиеПолное КАК П ИЗ ${CLOSED} КАК Т`
    + ` ОБЪЕДИНИТЬ ВСЕ ВЫБРАТЬ В.НаименованиеПолное КАК П ИЗ ${SUB} КАК В`, "П", "закрыто"],
  ["P0-13 регресс пакета: транзитивная пометка ВТ держится",
    `ВЫБРАТЬ Т.НаименованиеПолное КАК Н ПОМЕСТИТЬ ВТ ИЗ ${CLOSED} КАК Т;`
    + ` ВЫБРАТЬ ВТ.Н КАК П ИЗ ВТ КАК ВТ`, "П", "закрыто"],
  ["P0-14 контроль: запрос без ИЗ решение принимает",
    `ВЫБРАТЬ 1 КАК П`, "П", "открыто"],
  // ---- A-2: класс F-1 (потеря квалификатора) НЕ переоткрыт правкой ----
  //
  // Колонка подзапроса, названная БЕЗ псевдонима источника. Правка P-0 делает
  // неосмотренной колонку, адресованную псевдонимом подзапроса, — и мимо этого
  // условия проходит форма, где псевдонима в выражении нет вовсе. Ожидание всё
  // равно «закрыто», и держится оно ДРУГИМИ механизмами. Их надо назвать, иначе
  // следующая правка снимет их как случайные.
  //
  // ОБЩИЙ КОРЕНЬ ОБОИХ МЕХАНИЗМОВ ОДИН: источники самого подзапроса попадают в
  // ТУ ЖЕ карту (#108, КартаАлиасовЗапроса разбирает внутрь скобок). Отсюда
  // сразу два следствия — голое имя разрешается против ЗАКРЫТОГО внутреннего
  // типа, и `ЕстьЗакрытыйИсточникВКомандеPrivacy` истинен. Тронешь это — упадут
  // оба механизма разом, и класс F-1 переоткроется через подзапрос.
  //
  // Дальше расходится, и это видно по ВИДУ подстановки (кейсы F1-5…F1-7 в CASES
  // пиньгуют именно её, потому что «закрыто» одно и то же у обоих путей):
  //   • поле объявлено в метаданных → голое имя разрешается против внутреннего
  //     источника, работает ПРЯМАЯ пометка, подстановка — КОД псевдонима. Это
  //     путь живого контура: у `Справочник.Контрагенты` `НаименованиеПолное`
  //     реквизит есть;
  //   • поле в метаданных не объявлено (в заглушке порта `НаименованиеПолное`
  //     в META отсутствует, хотя в POLICY он есть) → операнд неразрешён, и
  //     срабатывает консервативный дефолт R-4, подстановка — МАСКА.
  // Оба пути дают «закрыто», и это не совпадение: R-4 и есть страховка ровно на
  // случай неполноты нашего взгляда на метаданные.
  //
  // Отдельно про F1-3, «подзапрос без псевдонима»: `ДобавитьПривязкуПодзапроса`
  // привязку НЕ регистрирует — адресовать его колонки нечем. Здесь это
  // БЕЗОПАСНО и по третьей причине: единственным источником команды остаётся
  // внутренний закрытый тип, а единственный источник забирает любое имя
  // (`ИдентификаторПривязанPrivacy`). Правка, которая «починит» эту ветку
  // регистрацией псевдонима, превратит один источник в два и снимет это
  // правило — проверять придётся заново, а не «оно и так работало».
  ["P0-F1-1 (A-2 R-1) голое имя из подзапроса",
    `ВЫБРАТЬ НаименованиеПолное КАК П ИЗ ${SUB} КАК Т`, "П", "закрыто"],
  ["P0-F1-2 (A-2 R-2) то же с ПЕРВЫЕ N",
    `ВЫБРАТЬ ПЕРВЫЕ 3 НаименованиеПолное КАК П ИЗ ${SUB} КАК Т`, "П", "закрыто"],
  ["P0-F1-3 (A-2 R-3) подзапрос БЕЗ псевдонима",
    `ВЫБРАТЬ НаименованиеПолное КАК П ИЗ ${SUB}`, "П", "закрыто"],
  ["P0-F1-4 (A-2 R-4) выражение над голым именем из подзапроса",
    `ВЫБРАТЬ ПОДСТРОКА(НаименованиеПолное, 1, 10) КАК П ИЗ ${SUB} КАК Т`, "П", "закрыто"],
];

// Второй рубеж: предвалидатор. «отклонена» — wildcard_select_forbidden.
const BAN_CASES = [
  ["B0-1 ВЫБРАТЬ *", `ВЫБРАТЬ * ИЗ ${CLOSED} КАК Т`, true],
  ["B0-2 ВЫБРАТЬ ПЕРВЫЕ 3 РАЗЛИЧНЫЕ *", `ВЫБРАТЬ ПЕРВЫЕ 3 РАЗЛИЧНЫЕ * ИЗ ${CLOSED} КАК Т`, true],
  ["B0-3 ВЫБРАТЬ ПЕРВЫЕ 3 К.*", `ВЫБРАТЬ ПЕРВЫЕ 3 К.* ИЗ ${CLOSED} КАК К`, true],
  ["B0-4 пакет со звёздочкой",
    `ВЫБРАТЬ * ПОМЕСТИТЬ ВТ ИЗ ${CLOSED} КАК Т; ВЫБРАТЬ * ИЗ ВТ КАК ВТ`, true],
  ["B0-5 SELECT TOP 3 *", `SELECT TOP 3 * FROM ${CLOSED} КАК Т`, true],
  ["B0-6 SELECT DISTINCT *", `SELECT DISTINCT * FROM ${CLOSED} КАК Т`, true],
  ["B0-7 РАЗРЕШЕННЫЕ *", `ВЫБРАТЬ РАЗРЕШЕННЫЕ * ИЗ ${CLOSED} КАК Т`, true],
  ["B0-8 звёздочка вторым элементом", `ВЫБРАТЬ Т.Код, * ИЗ ${CLOSED} КАК Т`, true],
  ["B0-9 звёздочка в подзапросе списка выборки",
    `ВЫБРАТЬ (ВЫБРАТЬ * ИЗ ${CLOSED} КАК В) КАК П ИЗ ${OPEN} КАК О`, true],
  // Контроль ложных отказов: умножение и КОЛИЧЕСТВО(*) звёздочкой проекции не являются.
  ["B0-10 контроль: умножение поля на число",
    `ВЫБРАТЬ 3 * О.Сумма КАК П ИЗ ${OPEN} КАК О`, false],
  ["B0-11 контроль: умножение двух полей",
    `ВЫБРАТЬ О.Сумма * О.Сумма КАК П ИЗ ${OPEN} КАК О`, false],
  ["B0-12 контроль: КОЛИЧЕСТВО(*)", `ВЫБРАТЬ КОЛИЧЕСТВО(*) КАК П ИЗ ${OPEN} КАК О`, false],
  ["B0-13 контроль: ПЕРВЫЕ N без звёздочки",
    `ВЫБРАТЬ ПЕРВЫЕ 3 О.Сумма КАК П ИЗ ${OPEN} КАК О`, false],
  ["B0-14 контроль: умножение после закрывающей скобки",
    `ВЫБРАТЬ (О.Сумма + 1) * 2 КАК П ИЗ ${OPEN} КАК О`, false],
];

let pass = 0, fail = 0;
function run(name, query, column, expected, parameters) {
  const marks = markQuery(query, parameters ?? new Map()).marks;
  const got = substitution(marks.get(column.toUpperCase()));
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "OK  " : "FAIL"} | ${name}\n       ожидали «${expected}», получили «${got}»`
    + (VERBOSE ? `\n       ${query.replace(/\s+/g, " ")}` : ""));
}

function runVerdict(name, query, column, expected) {
  const got = verdict(query, column);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? "OK  " : "FAIL"} | ${name}\n       ожидали «${expected}», получили «${got}»`
    + (VERBOSE ? `\n       ${query.replace(/\s+/g, " ")}` : ""));
}

function runBan(name, query, expected) {
  const got = wildcardForbidden(query);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  const текст = (v) => (v ? "отклонена" : "пропущена");
  console.log(`${ok ? "OK  " : "FAIL"} | ${name}\n       ожидали «${текст(expected)}»,`
    + ` получили «${текст(got)}»` + (VERBOSE ? `\n       ${query.replace(/\s+/g, " ")}` : ""));
}

for (const [name, query, column, expected] of CASES) run(name, query, column, expected);
for (const [name, query, column, expected] of PARAM_CASES) run(name, query, column, expected, refParam);
console.log("\n--- P-0: вердикт первого эшелона по формам §2.7 ---");
for (const [name, query, column, expected] of VERDICT_CASES) runVerdict(name, query, column, expected);
console.log("\n--- P-0: второй рубеж, запрет звёздочки ---");
for (const [name, query, expected] of BAN_CASES) runBan(name, query, expected);

console.log(`\nИтог порта${LEGACY ? " (ЛЕГАСИ, поведение до P-0)" : ""}: PASS ${pass}, FAIL ${fail}`);
if (LEGACY) {
  console.log("Режим --legacy обязан давать FAIL: он воспроизводит дефект. Ноль FAIL здесь"
    + " означает, что порт не проверяет правку.");
}
console.log("Порт проверяет ветвление решения, а не разрешение имён живого контура:"
  + " метаданные и политика здесь заглушки. Живая приёмка обязательна.");
process.exitCode = fail > 0 ? 1 : 0;
