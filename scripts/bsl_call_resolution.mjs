#!/usr/bin/env node
// Разрешение вызовов BSL-модуля: во что указывает каждое «Имя(».
//
// Опечатка в имени вызываемой функции — самая дорогая ошибка при публикации:
// модуль компилируется, а падает в рантайме на конкретной ветке, которую
// проверяющий может не пройти. Проверка разбирает все вызовы и делит их на
// разрешённые и неизвестные.
//
// Вызов считается разрешённым, если он:
//   • объявлен в этом же модуле;
//   • квалифицирован именем модуля (МодульX.Метод) — тогда проверяет 1С;
//   • встречается хотя бы в одном другом модуле репозитория, то есть у него
//     есть рабочий прецедент (платформенные СтрНайти, Сред, ВРег и прочие).
//
// Использование: node scripts/bsl_call_resolution.mjs <модуль.bsl> [<корень src>]

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const target = process.argv[2];
const root = process.argv[3] || "src";
if (!target) {
  console.error("Usage: node scripts/bsl_call_resolution.mjs <файл.bsl> [<корень src>]");
  process.exit(2);
}

const WORD = "\\p{L}\\p{N}_";

function strip(text) {
  return text
    .split(/\r?\n/)
    .map((l) => {
      let out = "";
      let q = false;
      for (const ch of l) {
        if (ch === '"') { q = !q; out += '"'; continue; }
        out += q ? " " : ch;
      }
      return out.replace(/\/\/.*$/, "");
    })
    .join("\n");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".bsl")) out.push(p);
  }
  return out;
}

// Имена, вызываемые без точки перед ними.
// «Новый ОписаниеТипов(...)» — конструктор типа, а не вызов функции: имя типа
// проверяет платформа, и в список вызовов оно попадать не должно.
const NEW_RE = /Новый[ \t]+$/iu;
function callNames(clean) {
  const re = new RegExp(`(?<![${WORD}.])([\\p{L}_][${WORD}]*)[ \\t]*\\(`, "gu");
  const out = [];
  for (const m of clean.matchAll(re)) {
    if (NEW_RE.test(clean.slice(Math.max(0, m.index - 10), m.index))) continue;
    out.push({ name: m[1], index: m.index });
  }
  return out;
}

function declaredIn(clean) {
  const re = new RegExp(`^[ \\t]*(?:Функция|Процедура)[ \\t]+([${WORD}]+)`, "gimu");
  return new Set([...clean.matchAll(re)].map((m) => m[1].toUpperCase()));
}

// Конструкции языка, за которыми скобка есть, но вызовом они не являются.
const KEYWORDS = new Set([
  "ЕСЛИ", "ИНАЧЕЕСЛИ", "ПОКА", "ДЛЯ", "ВОЗВРАТ", "И", "ИЛИ", "НЕ",
  "ФУНКЦИЯ", "ПРОЦЕДУРА", "НОВЫЙ", "ВЫЗВАТЬИСКЛЮЧЕНИЕ", "ТОГДА", "ЦИКЛ",
]);

// Слепое пятно критерия «прецедент в другом модуле»: платформенная функция,
// использованная во всём репозитории ровно один раз, прецедента не имеет и
// выглядит неразрешённой. Ниже — те, что сверены вручную по синтакс-помощнику
// и вдобавок работают в уже опубликованных модулях. Список пополнять только
// после такой сверки: иначе проверка перестанет ловить опечатки в именах.
const PLATFORM_GLOBALS = new Set([
  "СИМВОЛ",          // MCP_Query: Символ(160) — неразрывный пробел
  "ТЕКУЩАЯДАТА",     // MCP_Tools_Impl
  "НАЙТИПОССЫЛКАМ",  // MCP_Tools_Impl
  "ИМЯКОМПЬЮТЕРА",   // MCP_Tools_Impl
  // Сверено 05.08.2026 через MCP-коннектор 1csyntax (синтакс-помощник),
  // get_quick_reference — обе присутствуют в справке платформы:
  //   ЗаполнитьЗначенияСвойств(<Приемник>, <Источник>, <СписокСвойств>, <ИсключаяСвойства>)
  //   ПравоДоступа(<Право>, <ОбъектМетаданных>, <Пользователь/Роль>, <СтандартныйРеквизит…>)
  // До сверки обе годами показывались как «неразрешённые», и каждая сессия
  // заново доказывала, что это слепое пятно критерия, а не дефект кода.
  "ЗАПОЛНИТЬЗНАЧЕНИЯСВОЙСТВ",  // MCP_Query
  "ПРАВОДОСТУПА",              // MCP_Security
]);

const targetClean = strip(readFileSync(target, "utf8"));
const local = declaredIn(targetClean);

// Прецеденты: имена, вызываемые в остальных модулях репозитория.
const precedent = new Map();
for (const f of walk(root)) {
  if (f.replace(/\\/g, "/").endsWith(target.replace(/\\/g, "/"))) continue;
  const c = strip(readFileSync(f, "utf8"));
  for (const { name } of callNames(c)) {
    const k = name.toUpperCase();
    if (!precedent.has(k)) precedent.set(k, f);
  }
}

const lineStarts = [0];
for (let i = 0; i < targetClean.length; i++) if (targetClean[i] === "\n") lineStarts.push(i + 1);
const lineOf = (idx) => lineStarts.filter((s) => s <= idx).length;

const stats = { local: 0, keyword: 0, precedent: 0, platform: 0 };
const unknown = new Map();
for (const { name, index } of callNames(targetClean)) {
  const k = name.toUpperCase();
  if (KEYWORDS.has(k)) { stats.keyword++; continue; }
  if (local.has(k)) { stats.local++; continue; }
  if (precedent.has(k)) { stats.precedent++; continue; }
  if (PLATFORM_GLOBALS.has(k)) { stats.platform++; continue; }
  if (!unknown.has(name)) unknown.set(name, lineOf(index));
}

console.log(`  вызовов: локальных ${stats.local}, с прецедентом в репозитории ${stats.precedent}`
  + `, платформенных из сверенного списка ${stats.platform}, конструкций языка ${stats.keyword}`);
if (unknown.size === 0) {
  console.log("  ✔ неразрешённых имён нет");
  process.exit(0);
}
console.log(`  ✘ неразрешённых имён: ${unknown.size} — проверить вручную по синтакс-помощнику`);
for (const [name, ln] of unknown) console.log(`     ${target}:${ln}  ${name}(`);
process.exit(1);
