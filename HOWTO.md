# n8n-nodes-gemini-plus

Кастомна нода n8n **Gemini Plus**: повна копія вбудованої ноди Google Gemini, яку можна доопрацьовувати (Interactions API, `thinking_level`), поки цього немає у вбудованій ноді.

**Статус:** зараз це копія оригіналу (старий `generateContent`), перейменована в `geminiPlus`. Заплановано: перехід `helpers/baseAnalyze.ts` на `POST /v1beta/interactions` та опція Thinking Level.

## Походження

| | |
|---|---|
| Джерело | `n8n-io/n8n`, тег `n8n@2.28.5`, `packages/@n8n/nodes-langchain/nodes/vendors/GoogleGemini` |
| Версія n8n (прод і локально) | `2.28.5` |
| Node.js у контейнері | 24.x |
| Credential | вбудований `googlePalmApi` (власний не потрібен) |

**Відмінності від оригіналу:** перейменовано (`GeminiPlus`, `geminiPlus`, `GeminiPlusType`); `@utils/helpers` замінено власним `helpers/connectedTools.ts` (підключення AI-інструментів у Text працює без `@langchain/core`); `tsconfig` піднято до `es2022`; тести не копіювалися; залежності вказано явно (`@google/genai@1.19.0`, `mime-types@3.0.2`, `zod`, `zod-to-json-schema`).

## Локальна розробка

Вимоги: Node.js 24, npm, rsync, Docker, локальний n8n `2.28.5` з томом `/stor/n8n_data:/home/node/.n8n`.

```bash
npm install --legacy-peer-deps     # прапорець потрібен через конфлікт eslint у starter
chmod +x scripts/deploy.sh
scripts/deploy.sh                  # збірка + копіювання + перезапуск
```

Скрипт перевіряє версію n8n, збирає TypeScript, готує пакет (`dist` + production `node_modules`), зберігає попередню версію в `custom-backups/`, копіює в `/stor/n8n_data/custom/n8n-nodes-gemini-plus/` і перезапускає контейнер. Шляхи та назву контейнера можна змінити в `.deploy.env`.

| Команда | Дія |
|---|---|
| `scripts/deploy.sh` | деплой у локальний n8n |
| `scripts/deploy.sh pack` | зібрати архів `.deploy/n8n-nodes-gemini-plus.tar.gz` для прода |
| `scripts/deploy.sh --rollback` | повернути попередню версію локально |
| `--no-restart`, `--force` | не перезапускати; ігнорувати розбіжність версії n8n |

Рекомендований `.gitignore`: `node_modules/`, `dist/`, `.deploy/`, `.deploy.env`.

## Прод (вручну)

Схема така сама, як локально: на проді том `/stor/n8n_data:/home/node/.n8n`, а n8n шукає кастомні ноди в підпапці `custom`. Змінювати compose чи образ не потрібно.

1. Локально: `scripts/deploy.sh pack` і перенесіть `.deploy/n8n-nodes-gemini-plus.tar.gz` на сервер.
2. На сервері перевірте версію: `docker exec n8n n8n --version` має дати `2.28.5`.
3. Збережіть стару версію (якщо вона є) **поза** папкою `custom`: `mv /stor/n8n_data/custom/n8n-nodes-gemini-plus /stor/n8n_data/custom-backups/`. Якщо залишити копію всередині `custom`, n8n завантажить її як другу ноду.
4. Розпакуйте й виставте права:
   ```bash
   mkdir -p /stor/n8n_data/custom
   tar -xzf n8n-nodes-gemini-plus.tar.gz -C /stor/n8n_data/custom/
   chown -R 1000:1000 /stor/n8n_data/custom
   ```
5. Перезапустіть: `docker restart n8n`, потім `docker logs n8n` і перевірте відсутність помилок. Відкат: повернути стару папку з `custom-backups` і знову перезапустити.
6. Лише після цього імпортуйте або активуйте воркфлоу, що використовують Gemini Plus.

Перед першим деплоєм перегляньте `Dockerfile` і `.env` прода: чи немає там `N8N_CUSTOM_EXTENSIONS` або інших налаштувань шляху кастомних нод.

## Тонкощі

1. **Прив'язка до версії n8n.** Нода використовує внутрішні типи n8n. Після оновлення n8n склонуйте новий тег (`git clone --depth 1 --branch n8n@НОВА_ВЕРСІЯ --filter=blob:none --sparse https://github.com/n8n-io/n8n.git`, `git sparse-checkout set packages/@n8n/nodes-langchain/nodes/vendors/GoogleGemini`), порівняйте через `diff -ru`, оновіть версії залежностей і `EXPECTED_N8N_VERSION`.
2. **Не змінюйте `name: 'geminiPlus'`.** Воркфлоу, що використовують ноду, перестануть її знаходити. Тип ноди в експортованому JSON матиме службовий префікс (імовірно `CUSTOM.geminiPlus`, перевірте); локально й на проді нода має завантажуватися однаково.
3. **`Cannot find module 'n8n-workflow'`.** Він не вкладається в пакет, його надає n8n. Якщо така помилка з'явиться, додайте в `environment` контейнера `NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules`.
4. **Нативні модулі.** Залежності ноди чисто JavaScript, тому збірка з ноутбука працює на сервері. Якщо додасте пакет із нативними модулями, перевірте: `find .deploy -name "*.node"`.
5. **Перезапуск n8n** перериває активні виконання й робить вебхуки недоступними на кілька секунд. На проді робіть це у спокійний час.
6. **`npm audit`** показує десятки вразливостей, імовірно в dev-інструментах (`@n8n/node-cli`, `eslint`), які на сервер не потрапляють. Перевірка runtime: `npm audit --omit=dev`.
7. **Git.** `.git` зі starter було видалено: зробіть `git init` і зафіксуйте базову версію до змін, щоб було видно різницю з оригіналом.
8. **Ліцензія.** Код n8n під Sustainable Use License: для внутрішнього використання змінювати можна, публікувати чи розповсюджувати комерційно варто лише після читання умов.