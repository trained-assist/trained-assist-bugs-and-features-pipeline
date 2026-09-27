# Requirements log — bugs-and-features pipeline

- [реализовано] Контракт отчёта v1 (`contracts/bug-feature-report.v1.schema.json`), результат триажа в папке отчёта (`triage.json`) — один источник правды, без `index.jsonl`
- [реализовано] Триаж (стадия 2): крона */2 на GCP VM, opencode-агент (`ladder/deepseek`) ищет дубли в выгрузке issues и мапит на `docs/user-scenarios` (логика `define-use-case`); код заводит issue / комментирует дубль; 3 попытки → шаблон, отчёт не теряется
- [реализовано] Legacy-отчёты (до v1): тихий гейт 2 мин, уже заведённые старым сборщиком (`collector/state.json`) не дублируются
- [реализовано] Маскировка персональных данных перед публичным репо (`src/redact.js`)
- [реализовано] Фиксер (стадия 3): reusable workflow `fix-issue.yml`, событийно (`issues`), оценка → лейблы + вердикт; auto только scope:in ∧ XS/S ∧ ambiguity:low ∧ fixable; verify ×3; draft PR
- [реализовано] Фиксер заменяет `issue-triage.yml` агентского репо (ставит те же `size:*`/`ambiguity:*`/`needs-architect`)
- [планируется] Уведомление автора отчёта (Telegram) — issue заведён / PR смёржен (данные уже в `triage.json`)
- [планируется] Serverless-агенты вместо локального `opencode run` (заменить `src/opencode.js`)
- [планируется] Хранилище отчётов в Google Cloud Storage (новый store рядом с `report-store-fs.js`)
- [планируется] Маршрутизация issues в доменные репо (`*-skill`) по `area`
- [отклонено] Вебхук-сервер на VM для фиксера — GitHub Actions `on: issues` уже событийный, без публичного эндпоинта
- [отклонено] Писать отчёт LLM-ом по инструкции в PROFILE.md — дрейф контракта (3 отчёта потеряны 24–25.09), пишет детерминированный MCP-инструмент
