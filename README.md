# trained-assist-bugs-and-features-pipeline

Конвейер «пользователь сказал → GitHub issue → pull request» для агентов
[trained-assist](https://github.com/trained-assist/trained-assist-agent).

```
[1] приём   (trained-assist-agent)  MCP bug_or_feature_report → ~/users/<p>/projects/bugs-and-features/reports/<id>/
[2] триаж   (этот репо, крона VM)    opencode-агент: дубли + маппинг на сценарий → issue / комментарий → triage.json
[3] фиксер  (этот репо, Actions)     on: issues → оценка (лейблы) → если маленькое и однозначное → draft PR
```

Архитектура, ревью и план: [docs/bugs-and-features-pipeline-architecture-and-plan.md](docs/bugs-and-features-pipeline-architecture-and-plan.md).
Статус требований: [docs/requirements-log.md](docs/requirements-log.md).

## Контракты

| Файл | Кто пишет | Где |
|---|---|---|
| [`bug-feature-report.v1`](contracts/bug-feature-report.v1.schema.json) | MCP-инструмент агента | `reports/<id>/report.json` |
| [`bug-feature-triage.v1`](contracts/triage-result.v1.schema.json) | триаж (только он) | `reports/<id>/triage.json` |
| [`triage-decision.v1`](contracts/triage-decision.v1.schema.json) | триаж-агент | воркспейс триажа |
| [`fixer-assessment.v1`](contracts/fixer-assessment.v1.schema.json) | агент-оценщик фиксера | `$RUNNER_TEMP` |

## Стадия 2 — триаж (GCP VM)

Ставится деплоем `trained-assist-agent` (`scripts/deploy.sh`, только GCP): чекаут
`~/trained-assist-bugs-and-features-pipeline` + `ops/install-cron.sh` → `*/2 * * * * ops/triage-cron.sh`.

```bash
node src/triage.js --dry-run      # что ждёт триажа
node src/triage.js                # один проход (нужны GITHUB_ISSUES_TOKEN, LLM_LADDER_TOKEN)
ls ~/agent-data/bugs-and-features-pipeline/logs/   # логи только непустых проходов
```

| Env | По умолчанию | |
|---|---|---|
| `USERS_DIR` | `~/users` | корень профилей |
| `BF_TARGET_REPO` | `trained-assist/trained-assist-agent` | куда заводить issues |
| `BF_DATA_DIR` | `~/agent-data/bugs-and-features-pipeline` | клон целевого репо, выгрузка issues, воркспейсы |
| `PIPELINE_OPENCODE_MODEL` | `ladder/deepseek` | модель агента (провайдер из `opencode/ladder.json`) |
| `BF_MAX_PER_PASS` | `5` | отчётов за проход |

Повторить отчёт: удалить его `triage.json` (или поставить `"status":"retrying"`).

## Стадия 3 — фиксер (GitHub Actions)

В целевом репо:

```yaml
on:
  issues: { types: [opened, labeled] }
  workflow_dispatch: { inputs: { issue_number: { required: true } } }
jobs:
  fixer:
    if: github.event_name == 'workflow_dispatch' || github.event.action == 'opened' || github.event.label.name == 'fixer:retry'
    uses: trained-assist/trained-assist-bugs-and-features-pipeline/.github/workflows/fix-issue.yml@main
    with:
      issue_number: ${{ fromJSON(github.event.inputs.issue_number || github.event.issue.number) }}
      force: ${{ github.event_name == 'workflow_dispatch' || github.event.label.name == 'fixer:retry' }}
      setup_cmd: npm ci
      verify_cmd: npm run check && npm test
    secrets:
      llm_ladder_token: ${{ secrets.LLM_LADDER_TOKEN }}
      gh_token: ${{ secrets.AUTOFIX_PAT }}
```

Лейблы: `size:*`, `ambiguity:*`, `scope:in|out`, `fixer:auto|fixer:needs-human|fixer:pr-opened|fixer:failed`,
`needs-architect`. Управление: `fixer:retry` — перезапустить, `fixer:skip` — не трогать.
PR по умолчанию **draft** (`draft_pr: false` — обычный PR, в trained-assist-agent он авто-смёржится на зелёном CI).

## Разработка

```bash
npm test     # node:test, без зависимостей
npm run check
```

## Claude Code Instructions

- Зависимостей нет и не добавлять без нужды: чистый Node ≥ 20 (VM без `npm ci`).
- **Агент решает, код действует.** Агенты пишут только JSON-файлы (`decision.json`,
  `assessment.json`); всё, что меняет GitHub, делает код после валидации. Не давать агенту токен.
- Контракт отчёта меняется только версией (`bug-feature-report/v2`) + поддержка v1 в
  `src/report-store-fs.js`. Писатель контракта — `trained-assist-agent/src/bug-feature-reports.js`.
- Где лежат отчёты, знает только `src/report-store-fs.js` (переезд на GCS = новый store).
- Как запускается агент, знает только `src/opencode.js` (serverless-агенты = новый runner).
- `opencode run` всегда с закрытым stdin — иначе висит.
- Целевой репо публичный: всё, что уходит в issue, проходит `src/redact.js`.
- PR-флоу: ветка → PR → зелёный CI → merge. В `main` напрямую не пушить.
- Статусы требований — в `docs/requirements-log.md`.
