#!/usr/bin/env bash
# Router-free tmux recorder. Bash is intentional: this records Bun failures too.
# launchd pins Bash 5 and timeout; no TAP runtime or bus lock is consulted here.
[[ ${BASH_VERSINFO[0]} -ge 5 ]] || { echo 'tmux recorder: Bash 5 required' >&2; exit 2; }
export TZ=UTC
# launchd starts the tick with no locale; a tmux client outside $TMUX then
# sanitizes the tab separators in -F output to '_'. UTF-8 ctype keeps the tabs.
# The bare name "UTF-8" is a locale only on macOS. Elsewhere take the first
# UTF-8 ctype the host provides, checked in-process (a two-byte character
# counts as one) so the tick spawns nothing and Bash prints no locale warning.
if [[ -z ${LC_ALL:-} ]]; then
  if [[ -z ${LC_CTYPE:-} && $OSTYPE != darwin* ]]; then
    utf8_probe=$'\xc3\xa9'
    for utf8_ctype in C.UTF-8 en_US.UTF-8 UTF-8; do
      { LC_CTYPE=$utf8_ctype; } 2>/dev/null
      (( ${#utf8_probe} == 1 )) && break
    done
    export LC_CTYPE
    unset utf8_probe utf8_ctype
  else
    export LC_CTYPE=${LC_CTYPE:-UTF-8}
  fi
fi
umask 077
FLIGHT_DIR=${TMUX_FLIGHT_DIR:-$HOME/Library/Logs/tmux-flight}
LOG_DIR=${TMUX_FLIGHT_LOG_DIR:-$FLIGHT_DIR/server-logs}
RT_TIMEOUT_S=${TMUX_FLIGHT_RT_TIMEOUT_S:-3}
INVENTORY_SECONDS=${TMUX_FLIGHT_INVENTORY_SECONDS:-60}
INCIDENT_GAP=${TMUX_FLIGHT_INCIDENT_GAP_S:-600}
LOG_CAP=${TMUX_FLIGHT_LOG_CAP_BYTES:-2147483648}
TAIL_KEEP=${TMUX_FLIGHT_LOG_TAIL_BYTES:-268435456}
TIMEOUT=${TMUX_FLIGHT_TIMEOUT_BIN:-$(command -v timeout || command -v gtimeout)}
[[ -x $TIMEOUT ]] || { echo 'tmux recorder: timeout dependency unavailable' >&2; exit 2; }
for value in "$FLIGHT_DIR" "$LOG_DIR"; do
  [[ $value == /* && $value != *$'\n'* && $value != *$'\t'* ]] || { echo 'tmux recorder: directories must be absolute single-line paths' >&2; exit 2; }
done
for value in "$INVENTORY_SECONDS" "$INCIDENT_GAP" "$LOG_CAP" "$TAIL_KEEP"; do
  [[ $value =~ ^(0|[1-9][0-9]{0,11})$ ]] || { echo 'tmux recorder: invalid numeric setting' >&2; exit 2; }
done
[[ $RT_TIMEOUT_S =~ ^(([1-9]|[12][0-9])([.][0-9]+)?|30([.]0+)?|0?[.][1-9][0-9]*)$ ]] || exit 2
(( INVENTORY_SECONDS >= 1 && INVENTORY_SECONDS <= 86400 && INCIDENT_GAP <= 86400 && LOG_CAP > 0 && TAIL_KEEP > 0 )) || exit 2
action=${1:-help}; [[ $# -gt 0 ]] && shift
SOCK=(-L default)
if [[ ${1:-} == -L || ${1:-} == -S ]]; then
  [[ $# -ge 2 && -n $2 && $2 != *$'\n'* && $2 != *$'\t'* ]] || { echo 'tmux recorder: socket option needs one value' >&2; exit 2; }
  SOCK=("$1" "$2"); shift 2
fi
socket_key=${SOCK[0]}:${SOCK[1]}
socket_path=${SOCK[1]}
[[ ${SOCK[0]} == -L ]] && socket_path=${TMUX_TMPDIR:-/tmp}/tmux-$EUID/${SOCK[1]}
now=${EPOCHSECONDS}
printf -v stamp '%(%Y-%m-%dT%H:%M:%SZ)T' "$now"
printf -v day '%(%Y-%m-%d)T' "$now"
mkdir -p "$FLIGHT_DIR" "$LOG_DIR" || exit 2
claim=$FLIGHT_DIR/.tick-lock

# One winner may reclaim a claim, and only after observing its owner exited.
acquire() {
  if ! mkdir "$claim" 2>/dev/null; then
    local owner current
    read -r owner < "$claim/owner" 2>/dev/null || return 1
    [[ $owner =~ ^[0-9]+$ ]] || return 1
    kill -0 "$owner" 2>/dev/null && return 1
    "$TIMEOUT" -k 1 "$RT_TIMEOUT_S" ps -p "$owner" -o pid= > /dev/null 2>&1
    [[ $? == 1 ]] || return 1
    mkdir "$claim/recover" 2>/dev/null || return 1
    read -r current < "$claim/owner" 2>/dev/null
    if [[ $current != "$owner" ]]; then rmdir "$claim/recover"; return 1; fi
    clear_scratch || { rmdir "$claim/recover"; return 1; }
    rm -f "${claim:?}/owner"
    rmdir "$claim/recover" "$claim" 2>/dev/null || return 1
    mkdir "$claim" 2>/dev/null || return 1
  fi
  printf '%s\n' "$$" > "$claim/owner"
}
clear_scratch() {
  rm -f "${claim:?}/out" "${claim:?}/err" "${claim:?}/reduced" "${claim:?}/prior" "${claim:?}/observation" "${claim:?}/state"
}
release() {
  clear_scratch || return 1
  rm -f "${claim:?}/owner"
  rmdir "$claim" 2>/dev/null
}

# The child never inherits a command-substitution pipe: a stopped tmux server
# may retain that pipe after its client dies. Both descriptors are ordinary files.
bounded() {
  local duration=$1 out=$2; shift 2
  "$TIMEOUT" -k 1 "$duration" "$@" > "$out" 2> "$claim/err"
}
stat_field() {
  case $1 in
    size) stat -c %s "$2" 2>/dev/null || stat -f %z "$2" 2>/dev/null ;;
    mtime) stat -c %Y "$2" 2>/dev/null || stat -f %m "$2" 2>/dev/null ;;
  esac
}
read_state() {
  local version extra value
  IFS=$'\t' read -r version prev_time prev_alive prev_panes prev_pid last_inventory last_maintenance last_incident incident_count incident_bytes incident_overage prev_key extra < "$1" || return 1
  [[ $version == v1 && $prev_key == "$socket_key" && -z $extra ]] || return 1
  [[ $prev_alive == true || $prev_alive == false || $prev_alive == null ]] || return 1
  for value in "$prev_time" "$prev_pid" "$last_inventory" "$last_maintenance" "$last_incident" "$incident_count" "$incident_bytes" "$incident_overage"; do
    [[ $value =~ ^(0|[1-9][0-9]{0,11})$ ]] || return 1
  done
  [[ $prev_panes == null || $prev_panes =~ ^(0|[1-9][0-9]{0,8})$ ]]
}
prior_state() {
  read_state "$FLIGHT_DIR/.state" 2>/dev/null && return
  local yesterday real_socket=$socket_path
  printf -v yesterday '%(%Y-%m-%d)T' "$((now - 86400))"
  [[ -d ${socket_path%/*} ]] && real_socket=$(cd -P "${socket_path%/*}" && printf '%s/%s' "$PWD" "${socket_path##*/}")
  # Raw lines tolerate an incomplete append. Current day takes precedence.
  { tail -n 200 "$FLIGHT_DIR/$yesterday.jsonl" 2>/dev/null; printf '\n'; tail -n 200 "$FLIGHT_DIR/$day.jsonl" 2>/dev/null; } |
    jq -Rsc --arg key "$socket_key" --arg path "$socket_path" --arg real "$real_socket" --arg name "${SOCK[1]}" '
      def uint: type=="number" and .>=0 and .<1000000000000 and .==floor;
      [split("\n")[] | fromjson? |
       (if has("_state") then ._state | select(.socket==$key)
       else select(.sock==$path or .sock==$real or .sock==$name) |
         {socket:$key,time:(.ts|sub("\\.[0-9]+Z$";"Z")|fromdateiso8601),alive:.alive,panes:.panes,
          pid:(.server_pid|tonumber? // 0),inventory:0,maintenance:0,incident:0,count:0,bytes:0,overage:0} end)? |
       select(.alive==true or .alive==false or .alive==null) |
       select(.panes==null or (.panes|uint)) |
       select(all([.time,.pid,.inventory,.maintenance,.incident,.count,.bytes,.overage][];uint)) |
       ["v1",.time,.alive,.panes,.pid,.inventory,.maintenance,.incident,.count,.bytes,.overage,.socket] |
       map(if .==null then "null" else tostring end) | join("\t")] | last // empty' -r > "$claim/prior"
  if ! read_state "$claim/prior"; then
    prev_time=0 prev_alive=null prev_panes=null prev_pid=0 last_inventory=0 last_maintenance=0 last_incident=0 incident_count=0 incident_bytes=0 incident_overage=0
  fi
}

# The healthy fast probe: one tmux command chain and one reduction, no inventory.
probe() {
  local started=${EPOCHREALTIME/./} finished error
  bounded "$RT_TIMEOUT_S" "$claim/out" tmux "${SOCK[@]}" display -p $'S\t#{pid}\t#{socket_path}\t#{version}' \; \
    list-panes -a -F $'P\t#{session_id}\t#{window_id}\t#{pane_dead}\t#{history_size}' \; list-clients -F C
  probe_rc=$?
  finished=${EPOCHREALTIME/./}; rt_ms=$(( (finished - started) / 1000 ))
  alive=null pid=0 panes=null sessions=null windows=null clients=null dead=null maxhist=null
  sock=$socket_path
  if [[ $probe_rc == 124 || $probe_rc == 137 ]]; then rt_ms=-1; result=3; return; fi
  if [[ $probe_rc != 0 ]]; then
    error=$(<"$claim/err")
    case $error in *'no server running'*|*'No such file or directory'*|*'Connection refused'*) alive=false; result=4 ;; *) result=5 ;; esac
    return
  fi
  awk -F '\t' '
    $1=="S" && $2~/^[0-9]+$/ {pid=$2; sock=$3}
    $1=="P" {s[$2]=1; w[$3]=1; n++; dead+=$4; if($5>h)h=$5}
    $1=="C" {c++}
    END {for(i in s)ns++; for(i in w)nw++; if(pid)printf "%s\t%s\t%d\t%d\t%d\t%d\t%d\t%d\n",pid,sock,n,ns,nw,c,dead,h}
  ' "$claim/out" > "$claim/reduced"
  if IFS=$'\t' read -r pid sock panes sessions windows clients dead maxhist < "$claim/reduced" && [[ $maxhist =~ ^[0-9]+$ ]]; then alive=true; result=0
  else pid=0 panes=null sessions=null windows=null clients=null dead=null maxhist=null; result=5; fi
}

artifact() {
  local field=$1 dest=$2; shift 2
  if ! command -v "$1" >/dev/null 2>&1; then printf '%s: unavailable (%s missing)\n' "$field" "$1" >> "$incident_dir/note.txt"
  elif bounded 8 "$dest" "$@" && [[ -s $dest ]]; then printf '%s: ok (%s)\n' "$field" "${dest##*/}" >> "$incident_dir/note.txt"
  else printf '%s: unavailable (failed, empty or deadline)\n' "$field" >> "$incident_dir/note.txt"; fi
}
incident() {
  local reason=$1 target=0 resolution=unresolved candidate=$pid name log ext
  incident_dir=$FLIGHT_DIR/incident-${stamp//:/}-$BASHPID
  mkdir "$incident_dir" || return 1
  printf 'tap-tmux-v1\n' > "$incident_dir/.tap-owned"
  if [[ $alive == true && $pid -gt 0 ]]; then target=$pid; resolution='live socket answered'
  elif [[ $prev_pid -gt 0 ]] && kill -0 "$prev_pid" 2>/dev/null; then
    # Inspect only a PID still holding this exact socket; a stale PID is a filename,
    # never authority to sample a process. Canonicalize directory aliases in Bash.
    local real_socket=$socket_path real_name
    [[ -d ${socket_path%/*} ]] && real_socket=$(cd -P "${socket_path%/*}" && printf '%s/%s' "$PWD" "${socket_path##*/}")
    if bounded 3 "$claim/out" lsof -a -p "$prev_pid" -U -Fn; then
      while IFS= read -r name; do
        [[ $name == n/* ]] || continue
        name=${name#n}; name=${name%% type=*}
        real_name=$name
        [[ -d ${name%/*} ]] && real_name=$(cd -P "${name%/*}" && printf '%s/%s' "$PWD" "${name##*/}")
        if [[ $name == "$socket_path" || $real_name == "$real_socket" ]]; then target=$prev_pid; resolution='previous socket owner verified'; break; fi
      done < "$claim/out"
    fi
  fi
  local display_pid=$target
  [[ $target == 0 ]] && display_pid=unresolved
  printf 'reason: %s\ncaptured_at: %s\nsocket: %s\nserver_pid: %s\npid_resolution: %s\n' "$reason" "$stamp" "$socket_key" "$display_pid" "$resolution" > "$incident_dir/note.txt"
  if bounded 3 "$claim/out" tmux -V; then printf 'tmux: %s\n' "$(<"$claim/out")" >> "$incident_dir/note.txt"
  else printf 'tmux: unavailable (version query failed)\n' >> "$incident_dir/note.txt"; fi
  if bounded 3 "$claim/out" uptime; then printf 'uptime: %s\n' "$(<"$claim/out")" >> "$incident_dir/note.txt"
  else printf 'uptime: unavailable (query failed)\n' >> "$incident_dir/note.txt"; fi
  printf '# UNVERIFIED: all tmux processes; none is attributed to the target socket by this list.\n' > "$incident_dir/pgrep-tmux.txt"
  if bounded 3 "$claim/out" pgrep -lx tmux; then cat "$claim/out" >> "$incident_dir/pgrep-tmux.txt"
  else printf 'pgrep_tmux: unavailable (query failed or no process)\n' >> "$incident_dir/note.txt"; fi
  if [[ $target -gt 0 ]]; then
    if [[ -x /usr/bin/sample ]] && bounded 8 "$claim/out" /usr/bin/sample "$target" 5 -file "$incident_dir/sample.txt" && [[ -s $incident_dir/sample.txt ]]; then
      printf 'sample: ok (sample.txt)\n' >> "$incident_dir/note.txt"
    else printf 'sample: unavailable (macOS profiler missing, failed or empty)\n' >> "$incident_dir/note.txt"; fi
    artifact lsof "$incident_dir/lsof.txt" lsof -p "$target"
    artifact server_ps "$incident_dir/server-ps.txt" ps -p "$target" -o pid,ppid,stat,pcpu,rss,etime,command
  else printf 'sample: unavailable (unresolved pid)\nlsof: unavailable (unresolved pid)\nserver_ps: unavailable (unresolved pid)\n' >> "$incident_dir/note.txt"; fi
  artifact ps_tree "$incident_dir/ps-tree.txt" ps -axo pid,ppid,stat,pcpu,rss,etime,command
  ls -la "${socket_path%/*}" > "$incident_dir/sockets.txt" 2>&1
  local yesterday
  printf -v yesterday '%(%Y-%m-%d)T' "$((now - 86400))"
  { tail -n 60 "$FLIGHT_DIR/$day.jsonl" || tail -n 60 "$FLIGHT_DIR/$yesterday.jsonl"; } > "$incident_dir/flight-tail.jsonl" 2>/dev/null
  for candidate in "$pid" "$prev_pid"; do
    [[ $candidate -gt 0 ]] || continue
    for ext in log log.gz; do
      log=$LOG_DIR/tmux-server-$candidate.$ext
      [[ -f $log ]] || continue
      if [[ $ext == log ]]; then tail -n 400 "$log" > "$incident_dir/server-log-tail.txt"
      else gzip -dc "$log" | tail -n 400 > "$incident_dir/server-log-tail.txt"; fi
      printf 'server_log: %s\n' "$log" >> "$incident_dir/note.txt"
      last_incident=$now; incident_count=$((incident_count + 1)); return
    done
  done
  printf 'server_log: unavailable (no matching log)\n' >> "$incident_dir/note.txt"
  last_incident=$now; incident_count=$((incident_count + 1))
}

inventory() {
  rss=null pcpu=null load=null top=null inventory_sample=null
  (( now - last_inventory >= INVENTORY_SECONDS )) || return
  inventory_sample=$stamp; last_inventory=$now
  if [[ $alive == true ]] && bounded 3 "$claim/out" ps -p "$pid" -o rss=,pcpu=; then
    read -r rss pcpu < "$claim/out"
    [[ $rss =~ ^[0-9]+$ ]] || rss=null
    [[ $pcpu =~ ^[0-9]+([.][0-9]+)?$ ]] || pcpu=null
  fi
  local l1 l5 l15 raw
  if bounded 3 "$claim/out" sysctl -n vm.loadavg; then
    raw=$(<"$claim/out"); raw=${raw//[\{\}]/}; read -r l1 l5 l15 <<< "$raw"
  elif [[ -r /proc/loadavg ]]; then read -r l1 l5 l15 raw < /proc/loadavg; fi
  if [[ $l1 =~ ^[0-9.]+$ && $l5 =~ ^[0-9.]+$ && $l15 =~ ^[0-9.]+$ ]]; then load="[$l1,$l5,$l15]"; fi
  top_raw=''
  if bounded 3 "$claim/out" ps -Ao pcpu=,comm= -r || bounded 3 "$claim/out" ps -eo pcpu=,comm= --sort=-pcpu; then
    local line n=0
    while IFS= read -r line && (( n++ < 3 )); do top_raw+="$line"$'\n'; done < "$claim/out"
  fi
}
write_state() {
  printf 'v1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$alive" "$panes" "$identity_pid" "$last_inventory" "$last_maintenance" "$last_incident" "$incident_count" "$incident_bytes" "$incident_overage" "$socket_key" > "$claim/state"
  mv "$claim/state" "$FLIGHT_DIR/.state"
}
publish() {
  local inventory_at=null
  identity_pid=$pid; [[ $pid -gt 0 ]] || identity_pid=$prev_pid
  [[ $last_inventory -gt 0 ]] && printf -v inventory_at '%(%Y-%m-%dT%H:%M:%SZ)T' "$last_inventory"
  jq -cn --arg ts "$stamp" --arg sock "$sock" --arg key "$socket_key" --arg pid "$pid" \
    --argjson alive "$alive" --argjson rt "$rt_ms" --argjson panes "$panes" --argjson sessions "$sessions" \
    --argjson windows "$windows" --argjson clients "$clients" --argjson dead "$dead" --argjson hist "$maxhist" \
    --argjson rss "$rss" --argjson pcpu "$pcpu" --argjson load "$load" --arg top "${top_raw:-}" \
    --arg inv "$inventory_sample" --arg inv_at "$inventory_at" --argjson now "$now" --argjson inventory "$last_inventory" \
    --argjson maintenance "$last_maintenance" --argjson incident "$last_incident" --argjson count "$incident_count" \
    --argjson identity "$identity_pid" --argjson bytes "$incident_bytes" --argjson overage "$incident_overage" '
    {ts:$ts,sock:$sock,server_pid:$pid,alive:$alive,rt_ms:$rt,panes:$panes,sessions:$sessions,windows:$windows,
     clients:$clients,dead_panes:$dead,max_history:$hist,rss_kb:$rss,pcpu:$pcpu,fds:null,messages_tail:null,sock_mtime:null,
     load:$load,top_cpu:(if $top=="" then null else [$top|split("\n")[]|select(length>0)|capture("^ *(?<cpu>[0-9.]+) +(?<comm>.*)$")?|.cpu|=tonumber] end),
     inventory_sample_at:(if $inv_at=="null" then null else $inv_at end),inventory_sampled:($inv!="null"),
     _state:{socket:$key,time:$now,alive:$alive,panes:$panes,pid:$identity,inventory:$inventory,maintenance:$maintenance,incident:$incident,count:$count,bytes:$bytes,overage:$overage}}
  ' > "$claim/observation" || return 2
  cat "$claim/observation" >> "$FLIGHT_DIR/$day.jsonl" || return 2
  write_state || return 2
}

cap_live_logs() {
  local file owner size
  for file in "$LOG_DIR"/tmux-server-*.log; do
    [[ -f $file ]] || continue
    owner=${file##*/tmux-server-}; owner=${owner%.log}
    [[ $owner =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null || continue
    size=$(stat_field size "$file")
    if [[ $size =~ ^[0-9]+$ ]] && (( size > LOG_CAP )); then
      tail -c "$TAIL_KEEP" "$file" > "$file.tail-$now" && : > "$file"
    fi
  done
}
maintenance() {
  (( now - last_maintenance >= 3600 )) || return
  local file owner size total=0 index=0 mtime marker
  local -a bundles=() sizes=()
  for file in "$LOG_DIR"/tmux-server-*.log; do
    [[ -f $file ]] || continue
    owner=${file##*/tmux-server-}; owner=${owner%.log}
    [[ $owner =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null || gzip -q "$file" 2>/dev/null
  done
  find "$LOG_DIR" -type f -name '*.tail-*' ! -name '*.gz' -mmin +60 -exec gzip -q {} \;
  find "$LOG_DIR" -type f \( -name 'tmux-*.log*' -o -name '*.tail-*' \) -mtime +14 -delete
  find "$FLIGHT_DIR" -maxdepth 1 -type f -name '*.jsonl' -mtime +14 -delete
  for file in "$FLIGHT_DIR"/incident-*; do
    [[ -d $file && ! -L $file && -f $file/.tap-owned && ! -L $file/.tap-owned ]] || continue
    read -r marker < "$file/.tap-owned"; [[ $marker == tap-tmux-v1 ]] || continue
    read -r size _ < <(du -sk "$file"); [[ $size =~ ^[0-9]+$ ]] || continue
    bundles+=("$file"); sizes+=("$((size * 1024))"); total=$((total + size * 1024))
  done
  # Names sort in UTC creation order. Unmarked historical evidence is never ours.
  for file in "${bundles[@]}"; do
    (( ${#bundles[@]} - index > 5 )) || break
    mtime=$(stat_field mtime "$file/.tap-owned")
    [[ $mtime =~ ^[0-9]+$ ]] || { index=$((index + 1)); continue; }
    if (( total > 536870912 || now - mtime > 2592000 )); then
      find "$file" -depth -delete && total=$((total - sizes[index]))
    fi
    index=$((index + 1))
  done
  (( total <= 536870912 )) || printf 'tmux recorder: protected newest incidents exceed 512 MiB (%s bytes)\n' "$total" >&2
  incident_bytes=$total; incident_overage=0
  (( total <= 536870912 )) || incident_overage=$((total - 536870912))
  last_maintenance=$now
}

start_server() {
  probe
  if [[ $result != 4 ]]; then
    [[ $action == ensure && $result == 0 ]] && return 0
    echo 'tmux recorder: refusing to replace an answering, wedged or unobservable server' >&2; return 4
  fi
  (cd "$LOG_DIR" && bounded "$RT_TIMEOUT_S" "$claim/out" tmux "${SOCK[@]}" -vv new-session -d -s flight-keepalive -c "$HOME" \; set -s exit-empty off)
}
print_hook() {
  printf 'tmux() {\n  if [ "$#" -eq 0 ] || { [ "$1" != -L ] && [ "$1" != -S ]; }; then\n    command %q %q ensure >/dev/null 2>&1\n  fi\n  command tmux "$@"\n}\n' "$BASH" "${TMUX_FLIGHT_ENTRY:-${BASH_SOURCE[0]}}"
}

case $action in
  help|--help|-h) printf 'tmux recorder: watch-once | sample | incident [reason] | start-server | ensure | print-hook | status\n'; exit 0 ;;
  print-hook) print_hook; exit ;;
  watch-once|sample|incident|start-server|ensure|status) ;;
  *) echo "tmux recorder: unknown action: $action" >&2; exit 2 ;;
esac
acquire || exit 0
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
prior_state
case $action in
  start-server|ensure) start_server; exit $? ;;
  status) cat "$FLIGHT_DIR/.state"; exit $? ;;
esac
probe
if [[ $action == incident ]]; then incident "${*:-manual}"
elif [[ $action == watch-once ]] && (( now - last_incident >= INCIDENT_GAP )); then
  if [[ $result == 3 ]]; then incident 'auto-HANG: tmux deadline expired'
  elif [[ $result == 4 && $prev_alive == true ]]; then incident 'auto-DEATH: previous server is gone'
  elif [[ $result == 0 && $prev_panes != null ]] && (( prev_panes >= 6 && panes <= prev_panes / 2 )); then incident "auto-PANE-COLLAPSE: $prev_panes -> $panes"; fi
fi
inventory
publish || exit $?
cap_live_logs
maintenance
# Persist maintenance completion without another JSON conversion.
if [[ $last_maintenance != 0 ]]; then
  write_state || exit 2
fi
[[ ${1:-} == --stdout ]] && cat "$claim/observation"
exit "$result"
