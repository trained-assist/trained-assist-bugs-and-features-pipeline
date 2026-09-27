# Bugs & Features pipeline — архитектура и план (2026-09-27)

Сквозной процесс «пользователь сказал → issue → pull request» для агентов trained-assist.
Документ — источник истины по архитектуре; статус требований — в `docs/requirements-log.md`.

## 0. Что уже было и почему переделываем

К 2026-09-27 в `trained-assist-agent` уже существовали все три стадии, но «не доделанные»:

| Было | Проблема (проверено на проде 2026-09-27) |
|------|-------------------------------------------|
| `/bug_or_feature` → сессия в проекте `bugs-and-features`, LLM сам пишет `reports/<id>/` + строку в `index.jsonl` по инструкции в PROFILE.md | LLM пишет контракт «от руки» и дрейфует: у `aleksandrl-iquarus` три отчёта (24–25.09) записаны с `dir: "reports/<id>"`, сборщик склеивал `reports/reports/<id>` → «report folder missing», **ни один не стал issue** |
| Intake делал `setActiveProjectId(bugs-and-features)` | Текущий проект пользователя переключался на «Баги и фичи»; следующая новая сессия без пина ещё и **пинила** чат к нему |
| `src/bugs-collector.js` (крона */2) — один LLM-вызов → issue | Нет сравнения со старыми issues (дубли), нет маппинга на сценарии |
| `src/issue-fixer.js` (крона hourly: queue → gate → execute) | Не по событию; gate падал по таймауту (#1618, #1631 — 27.09); крон запускался из **рабочей** копии `~/trained-assist-agent` (её чекаутят сессии), а не из релиза |
| PR фиксера | `ci.yml` авто-мержит любой не-draft PR на зелёном CI — «человек ревьюит» на деле не выполнялось |
| Нет MCP-инструмента и нет веба | Агенты не знали, что баг можно зарепортить; веб не мог выбрать проект «Баги и фичи» (`/web/project-create` запрещал тип `bugs`) |

## 1. Архитектура (три стадии, три абстракции)

```
 Пользователь (TG /bug_or_feature · веб: проект «Баги и фичи» · любой агент по ходу работы)
        │  обычная сессия на дефолтном движке чата (claude/codex/opencode — как у пользователя)
        ▼
 [1] INTAKE — trained-assist-agent (минимум кода)
     MCP-инструмент bug_or_feature_report  ──► ~/users/<profile>/projects/bugs-and-features/
     (детерминированная запись, атомарно)          reports/<YYYY-MM-DD>-<slug>/report.json (+attachments/, transcript.md)
        │  артефакт = «как сказал пользователь»
        ▼
 [2] TRIAGE — этот репо, крона на GCP VM (*/2 мин)
     для каждого отчёта без triage.json: спавн opencode-агента (уровень master, ladder `deepseek`)
     в воркспейсе: отчёт + клон целевого репо (docs/user-scenarios) + выгрузка issues
     → decision.json (новый / дубль / мусор, kind, сценарий) → код делает issue или комментарий
     → пишет triage.json обратно в папку отчёта (пользователь и агенты видят статус)
        │  артефакт = GitHub issue в trained-assist/trained-assist-agent
        ▼
 [3] FIXER — этот репо, reusable workflow в GitHub Actions, по событию issues.opened
     assess (opencode-агент читает репо + сценарии) → labels + комментарий-вердикт
     если scope:in + маленькое + однозначное → execute: opencode правит код, verify (npm test) ×3
     → push + DRAFT pull request «Closes #N» (человек переводит в ready → CI авто-мерж)
        │  артефакт = pull request
```

Абстракции не зависят от хранилища: **отчёт (артефакт пользователя) → issue → PR**. Когда папки
переедут в Google Cloud Storage, меняется только `src/report-store-fs.js` (list/read/write triage),
контракт `contracts/bug-feature-report.v1.schema.json` остаётся.

### Где что живёт

| Что | Репо | Почему там |
|-----|------|-----------|
| MCP-инструмент `bug_or_feature_report`, проект `bugs-and-features`, `/bug_or_feature`, веб-список проектов | `trained-assist-agent` | Это рантайм агента: инструмент должен быть в каждой сессии, проект — в папке пользователя |
| Контракт отчёта v1 (JSON Schema) | этот репо | Потребитель владеет контрактом; агент пишет по нему |
| Триаж (крона VM) | этот репо | Нужен доступ к `~/users/*/projects/bugs-and-features` — только VM; тот же юзер `vova`, свой чекаут `~/trained-assist-bugs-and-features-pipeline` |
| Фиксер (Actions) | этот репо (reusable workflow) + 15-строчный вызывающий workflow в целевом репо | По событию без вебхук-сервера; секреты организации (`LLM_LADDER_TOKEN`, `AUTOFIX_PAT`) уже доступны; тот же паттерн, что `pr-autofix` |

Деплой триажа на VM: `trained-assist-agent/scripts/deploy.sh` клонирует/обновляет этот репо
(как sibling) и вызывает `ops/install-cron.sh` отсюда. Зависимостей нет (чистый Node ≥ 20),
`npm ci` не нужен.

## 2. Архитектурное ревью исходной идеи

- **Папка нужна — да.** Это durable «входящий ящик» между рантаймом агента и внешним процессом:
  переживает рестарты, видна пользователю и агентам, не требует очереди/БД. Переезд на GCS —
  смена адаптера, не архитектуры. Упрощение: **никакого `index.jsonl`** — единственный источник
  истины `reports/<id>/report.json`, статус обработки — `triage.json` рядом. Два источника истины
  (индекс + папка) и породили баг с `reports/reports/`.
- **LLM не пишет контракт руками.** Интейк-агент разговаривает с пользователем (уточняет, что
  случилось), а файл пишет **инструмент**. Инструмент пишет во временную папку и делает
  `rename` — отчёт появляется атомарно, «тихий гейт» (ждать 3 минуты, пока допишется) для новых
  отчётов не нужен (оставлен только для legacy-отчётов без `schema`).
- **Триаж — агент, а не один вызов.** Сравнение со старыми issues и маппинг на сценарий требуют
  поиска по сотням issues и файлам сценариев — это работа агента с инструментами (grep/read),
  а не одного промпта. Но **агент решает, код действует**: агент пишет `decision.json`, код
  валидирует и сам создаёт issue/комментарий. Агенту не нужен GitHub-токен.
- **Фиксер по событию — через GitHub Actions, не через вебхук на VM.** `on: issues` — это и есть
  вебхук, только без публичного эндпоинта, секрета подписи и сервиса. Фиксеру не нужны данные
  VM: нужен код репо, модель и тесты — всё есть в раннере. Это же будущий «serverless-агент».
- **PR фиксера — draft.** Иначе `ci.yml` авто-мержит его на зелёном CI без человека. Переключатель
  `draft: false` во входах workflow, если владелец решит доверять фиксеру.
- **Не переусложнено ли?** Три стадии = три разных владельца артефакта и три разных триггера
  (сессия пользователя / файловый ящик / событие GitHub). Слить их нельзя без потери
  изолированности: интейк не должен иметь GitHub-доступ, триаж — права на запись в код, фиксер —
  доступ к папкам пользователей. Упрощено внутри стадий: нет индекса, нет state-файла сборщика,
  нет очереди `fixer:queued`, нет отдельной крон-стадии gate.
- **Маппинг на сценарии — логика плейбуков, не плейбук.** В `software-engineering-playbooks`
  шаги `define-use-case` (feature) и `bug-context` (debugging) начинаются с «найди существующий
  сценарий в `docs/user-scenarios/`, расширь, а не пиши новый». Триаж делает ровно это, но
  статично: `scenario.match = existing | extends | new | none`. Сценарии сам триаж не пишет —
  это остаётся шагу плейбука при реализации.

## 3. Контракты

### 3.1 Отчёт v1 — `reports/<id>/report.json`

См. `contracts/bug-feature-report.v1.schema.json`. Ключевые поля:
`schema:"bug-feature-report/v1"`, `id`, `kind: bug|feature`, `title`, `summary`,
`userWords` (дословно как сказал пользователь), `stepsToReproduce/expected/actual` (для бага),
`severity`, `area`, `status:"open"`, `createdAt`,
`reporter{profile, channel: telegram|web|agent}`, `source{sessionId, projectId, chatId}`,
`attachments[]` (имена файлов в `attachments/`).

### 3.2 Результат триажа — `reports/<id>/triage.json`

`{schema:"bug-feature-triage/v1", status: filed|duplicate|skipped|retrying|filed-fallback,
issue:{number,url}|null, duplicateOf, scenario{path,match,note}, kind, attempts, at, reason}`.
Пишет только пайплайн. Наличие `triage.json` со статусом ≠ `retrying` = отчёт обработан.
Legacy: отчёт, записанный в `collector/state.json` старого сборщика, считается обработанным.

### 3.3 Решение триаж-агента — `decision.json` (воркспейс, не папка пользователя)

См. `contracts/triage-decision.v1.schema.json`: `action: new|duplicate|skip`, `duplicate_of`,
`kind`, `title`, `body` (markdown, по-русски), `scenario{path,match,note}`, `area`, `severity`,
`reason`.

### 3.4 Вердикт фиксера — `assessment.json`

См. `contracts/fixer-assessment.v1.schema.json`: `scope: in|out`, `scenario`, `size: XS..XL`,
`ambiguity: low|medium|high`, `fixable: bool`, `plan`, `reason`. Консервативное правило в коде:
`auto` только при `scope=in` ∧ `size∈{XS,S}` ∧ `ambiguity=low` ∧ `fixable=true`; модель может
только понизить, не повысить.

## 4. Модели

Сейчас задача — чтобы процесс заработал, не экономия. Обе стадии используют opencode с
провайдером `ladder` (`opencode/ladder.json` → `https://llm-ladder.trainedassist.store/v1`,
модель `deepseek` — ладдер общего назначения: OpenCode Go → OpenRouter). Переопределяется
`PIPELINE_OPENCODE_MODEL`. Проверено 2026-09-27 на VM: `opencode run -m ladder/deepseek`
с инструментами работает (важно: stdin закрыт — иначе `opencode run` висит).
Следующий шаг — serverless-агенты вместо локального спавна opencode (не в этом плане).

## 5. План реализации

| # | Шаг | Где | Статус |
|---|-----|-----|--------|
| 1 | Контракты v1 (report, triage, decision, assessment) | этот репо | см. requirements-log |
| 2 | `bug_or_feature_report` MCP-инструмент + `src/bug-feature-reports.js` (атомарная запись, создаёт проект если нет) | agent | |
| 3 | PROFILE проекта «Баги и фичи» управляется кодом: «уточни → вызови инструмент», без ручной записи файлов | agent | |
| 4 | Проект «Баги и фичи» — side-project: не становится активным и не пинится (TG и веб) | agent | |
| 5 | Подсказка всем агентам про инструмент (per-run блок инструментов) | agent | |
| 6 | Веб: «Баги и фичи» всегда в `/web/projects`, `bugs` разрешён в `/web/project-create` | agent | |
| 7 | Триаж: report-store, воркспейс, opencode-агент, decision → issue/комментарий, triage.json, fallback-шаблон после 3 неудач | этот репо | |
| 8 | Крона триажа + деплой через `deploy.sh` agent-репо | оба | |
| 9 | Фиксер: reusable workflow `fix-issue.yml` (assess → execute → draft PR) | этот репо | |
| 10 | Вызывающий workflow `issue-fixer.yml` в agent-репо; заменяет `issue-triage.yml` (фиксер ставит те же `size:*`/`ambiguity:*`/`needs-architect`) | agent | |
| 11 | Удалить из agent-репо `bugs-collector.js`, `issue-fixer.js`, их кроны/тесты/runbook | agent | |

## 6. Открытые вопросы (приняты значения по умолчанию)

1. **PR фиксера — draft** (по умолчанию). Альтернатива — обычный PR с авто-мержем на зелёном CI.
2. **Фиксер оценивает каждый новый issue** в agent-репо (не только из пайплайна) и заменяет старый
   `issue-triage.yml`. Исключения: `needs-architect`, `epic`, `fixer:skip`. Ручной перезапуск —
   лейбл `fixer:retry` или `workflow_dispatch`.
3. **Уведомление пользователя** о том, что по его отчёту создан issue / PR смёрджен — не в этой
   итерации; статус лежит в `triage.json` в его папке.
4. **Все issues — в `trained-assist/trained-assist-agent`** (как сказано: «пока в общем агентском»).
   Для доменных репо (`*-skill`) — позже: `area` из решения триажа → целевой репо.
5. **Сессия «Баги и фичи» после отчёта** продолжает жить обычными правилами сессий (4 ч / новая
   тема); активный проект чата при этом не меняется — следующая новая сессия идёт в прежний проект.

## 7. Приватность

Целевой репо `trained-assist-agent` **публичный**. Триаж-агенту велено не переносить персональные
данные; код дополнительно прогоняет всё, что уходит в issue/комментарий, через `src/redact.js`
(e-mail, телефоны, токены). В issue остаётся имя профиля (`alice`) — это идентификатор, не ПДн.
Если нужно строже — issues в приватный репо, в публичный только ссылка (решение владельца).

## 8. Проверка готовности (приёмка)

- [ ] TG `/bug_or_feature` → описание → ▶️ → `reports/<id>/report.json`; активный проект чата не изменился
- [ ] Любой агент вызывает `bug_or_feature_report` → папка отчёта появилась (проект создан, если не было)
- [ ] Веб: проект «Баги и фичи» в списке → сообщение → папка отчёта
- [ ] Крона: ≤ 4 мин → `triage.json` + issue (или комментарий к дублю) со сценарием
- [ ] Issue opened → Actions: лейблы + вердикт; для XS/S однозначного — draft PR
- [ ] 3 застрявших отчёта `aleksandrl-iquarus` (24–25.09) заведены
