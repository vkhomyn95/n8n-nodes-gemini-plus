#!/usr/bin/env bash
#
# Збірка та доставка ноди Gemini Plus в локальний n8n.
# Розташування в проєкті: scripts/deploy.sh
#
#   scripts/deploy.sh              збірка + копіювання + перезапуск локального n8n
#   scripts/deploy.sh pack         збірка + архів для ручного перенесення на прод
#   scripts/deploy.sh --rollback   повернути попередню версію локально
#
# Прапорці: --no-restart, --force (ігнорувати розбіжність версії n8n)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="n8n-nodes-gemini-plus"
STAGE_ROOT="$ROOT/.deploy"
STAGE="$STAGE_ROOT/$PKG"

# ---------- конфіг (можна перевизначити у .deploy.env) ----------
EXPECTED_N8N_VERSION="2.28.5"
LOCAL_DIR="/stor/n8n_data/custom"      # папка custom локального n8n на хості
LOCAL_CONTAINER="n8n"

if [[ -f "$ROOT/.deploy.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/.deploy.env"
fi

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

MODE="deploy"; RESTART=1; FORCE=0
for arg in "$@"; do
  case "$arg" in
    pack)         MODE="pack" ;;
    --rollback)   MODE="rollback" ;;
    --no-restart) RESTART=0 ;;
    --force)      FORCE=1 ;;
    -h|--help)    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "Невідомий аргумент: $arg" ;;
  esac
done

DEST="$LOCAL_DIR/$PKG"
BACKUP_BASE="$(dirname "$LOCAL_DIR")/custom-backups"   # поза папкою custom, щоб n8n не завантажив копію
BACKUP="$BACKUP_BASE/$PKG.prev"
SUDO=""; if [[ $EUID -ne 0 ]]; then SUDO="sudo"; fi

restart_container() {
  if (( ! RESTART )); then
    warn "Перезапуск пропущено (--no-restart)."
    return 0
  fi
  log "Перезапуск контейнера '$LOCAL_CONTAINER'"
  docker restart "$LOCAL_CONTAINER" >/dev/null
  sleep 10
  log "Рядки логів із помилками за останні 40 с (порожньо = добре)"
  docker logs --since 40s "$LOCAL_CONTAINER" 2>&1 | grep -iE 'error|cannot find|failed' | tail -n 15 || true
}

# ---------- відкат ----------
if [[ "$MODE" == "rollback" ]]; then
  log "Відкат до попередньої версії"
  [[ -d "$BACKUP" ]] || die "Немає резервної копії: $BACKUP"
  $SUDO rsync -a --delete "$BACKUP/" "$DEST/"
  $SUDO chown -R 1000:1000 "$DEST"
  restart_container
  exit 0
fi

# ---------- перевірка версії n8n (лише для deploy) ----------
if [[ "$MODE" == "deploy" ]]; then
  log "1/4 Перевірка версії n8n у контейнері '$LOCAL_CONTAINER'"
  VER="$(docker exec "$LOCAL_CONTAINER" n8n --version | tr -d '\r')" \
    || die "Не вдалося виконати docker exec у '$LOCAL_CONTAINER'. Контейнер запущено?"
  echo "Версія n8n: $VER (нода зібрана під $EXPECTED_N8N_VERSION)"
  if [[ "$VER" != "$EXPECTED_N8N_VERSION" ]]; then
    warn "Версія n8n відрізняється від очікуваної."
    (( FORCE )) || die "Зупинено. Запустіть з --force, якщо це свідомо."
  fi
fi

# ---------- збірка ----------
log "2/4 Збірка TypeScript"
cd "$ROOT"
[[ -d node_modules ]] || npm install --legacy-peer-deps
npm run build

# ---------- пакет із runtime-залежностями ----------
log "3/4 Підготовка пакета (dist + production node_modules)"
mkdir -p "$STAGE"
rsync -a --delete "$ROOT/dist/" "$STAGE/dist/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"

LOCK_HASH="$(sha256sum "$ROOT/package-lock.json" | cut -d' ' -f1)"
OLD_HASH="$(cat "$STAGE_ROOT/.lockhash" 2>/dev/null || true)"
if [[ ! -d "$STAGE/node_modules" || "$LOCK_HASH" != "$OLD_HASH" ]]; then
  echo "Залежності змінились (або їх ще немає): npm ci --omit=dev"
  ( cd "$STAGE" && rm -rf node_modules && npm ci --omit=dev --legacy-peer-deps )
  echo "$LOCK_HASH" > "$STAGE_ROOT/.lockhash"
else
  echo "Залежності без змін, використовую кеш."
fi
date -Is > "$STAGE/DEPLOYED_AT"

# ---------- pack: архів для ручного перенесення ----------
if [[ "$MODE" == "pack" ]]; then
  ARCHIVE="$STAGE_ROOT/$PKG.tar.gz"
  tar -czf "$ARCHIVE" -C "$STAGE_ROOT" "$PKG"
  log "Готово: $ARCHIVE"
  echo "Перенесення на прод вручну: див. розділ «Прод» у README."
  exit 0
fi

# ---------- доставка у локальний n8n ----------
log "4/4 Копіювання в $DEST"
$SUDO mkdir -p "$DEST" "$BACKUP_BASE"
$SUDO rsync -a --delete "$DEST/" "$BACKUP/"      # резервна копія попередньої версії
$SUDO rsync -a --delete "$STAGE/" "$DEST/"
$SUDO chown -R 1000:1000 "$DEST" "$BACKUP_BASE"  # uid 1000 = користувач node в контейнері
restart_container

log "Готово. Відкат: scripts/deploy.sh --rollback"