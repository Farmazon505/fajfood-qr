#!/usr/bin/env bash
set -euo pipefail

# Install a reviewed Git commit. Guest table data, credentials and URLs are
# deliberately outside the release archive. Run as root on faj-prod-selectel.
COMMIT=${1:?commit required}
ARCHIVE=${2:?Git archive required}
EXPECTED=${3:?current deployed commit required}
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ && "$EXPECTED" =~ ^[0-9a-f]{40}$ ]]
[[ "$(hostname)" == "faj-prod-selectel" ]]
ROOT=/opt/qrnastol
STAGE="/opt/qrnastol-releases/$COMMIT"
BACKUP="/opt/qrnastol-backups/$(date -u +%Y%m%dT%H%M%SZ)-$COMMIT"
exec 9>"$ROOT/.marketing-deploy.lock"
flock -n 9 || { echo "Another Qr release is active"; exit 1; }
gitqr() { git -c safe.directory="$ROOT" -C "$ROOT" "$@"; }
[[ "$(gitqr rev-parse HEAD)" == "$EXPECTED" ]]
gitqr diff --quiet
gitqr diff --cached --quiet
for marker in .deployed-commit .activated-commit; do
  if [[ -f "$ROOT/$marker" ]]; then [[ "$(cat "$ROOT/$marker")" == "$EXPECTED" ]]; fi
done
gitqr fetch origin main
[[ "$(gitqr rev-parse origin/main)" == "$COMMIT" ]]
gitqr merge-base --is-ancestor "$EXPECTED" "$COMMIT"
[[ ! -e "$STAGE" ]]
mkdir -p "$STAGE" "$BACKUP"
chmod 700 "$BACKUP"
tar -xzf "$ARCHIVE" -C "$STAGE"
chown -R qrnastol:qrnastol "$STAGE"
runuser -u qrnastol -- bash -c 'cd "$1"; npm ci --ignore-scripts; npm run build; npm test' -- "$STAGE"
fingerprint() {
  python3 - <<'PY'
import json,hashlib
data=json.load(open('/var/lib/qrnastol/app.json'))
tables=[{key:t.get(key) for key in ['id','slug','name','zone']} for t in data['tables']]
print(hashlib.sha256(json.dumps(tables,sort_keys=True,ensure_ascii=False).encode()).hexdigest())
PY
}
BEFORE=$(fingerprint)
printf '%s\n' "$BEFORE" > "$BACKUP/table-identity.sha256"
cp -a /var/lib/qrnastol/app.json "$BACKUP/app.json"
if [[ -f /var/lib/qrnastol/faj-work-outbox.json ]]; then cp -a /var/lib/qrnastol/faj-work-outbox.json "$BACKUP/"; fi
cp -a "$ROOT/dist" "$BACKUP/dist"
gitqr archive --format=tar.gz -o "$BACKUP/source.tgz" "$EXPECTED"

ACTIVATING=0
rollback() {
  local code=$?
  if [[ $code -ne 0 && $ACTIVATING == 1 ]]; then
    echo "Activation failed; restoring previous code (live guest data retained)"
    systemctl stop qrnastol || true
    gitqr reset --hard "$EXPECTED"
    # Only build output created during this activation is replaced.
    [[ "$(realpath "$ROOT/dist")" == "$ROOT/dist" ]]
    rm -rf -- "$ROOT/dist"
    cp -a "$BACKUP/dist" "$ROOT/dist"
    printf '%s\n' "$EXPECTED" > "$ROOT/.deployed-commit"
    printf '%s\n' "$EXPECTED" > "$ROOT/.activated-commit"
    chown -R qrnastol:qrnastol "$ROOT/dist"
    systemctl start qrnastol
  fi
  exit "$code"
}
trap rollback EXIT
[[ "$(gitqr rev-parse HEAD)" == "$EXPECTED" ]]
gitqr diff --quiet
ACTIVATING=1
systemctl stop qrnastol
gitqr merge --ff-only "$COMMIT"
[[ "$(realpath "$ROOT/dist")" == "$ROOT/dist" ]]
mv "$ROOT/dist" "$BACKUP/dist-activation"
cp -a "$STAGE/dist" "$ROOT/dist"
chown -R qrnastol:qrnastol "$ROOT/server" "$ROOT/shared" "$ROOT/src" "$ROOT/deploy" "$ROOT/dist"
printf '%s\n' "$COMMIT" > "$ROOT/.deployed-commit"
systemctl start qrnastol
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/api/ready > "$BACKUP/ready.json"; then break; fi
  sleep 1
done
python3 - "$BACKUP/ready.json" <<'PY'
import json,sys
data=json.load(open(sys.argv[1]))
assert data.get('ok') is True and data.get('tables') == 20 and data.get('publicBaseUrl') == 'https://qr.fajfood.ru', data
PY
systemctl is-active --quiet qrnastol
[[ "$(fingerprint)" == "$BEFORE" ]]
curl -fsS https://qr.fajfood.ru/api/ready > "$BACKUP/public-ready.json"
printf '%s\n' "$COMMIT" > "$ROOT/.activated-commit"
ACTIVATING=0
echo "Activated $COMMIT; QR identity unchanged: $BEFORE; backup: $BACKUP"
