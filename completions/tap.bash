# TAP completion for Bash 3.2 and later. It needs no bash-completion package:
#   eval "$(tap completion bash)"
# TAP's candidate producer owns the command, flag and target grammar and the
# authority reads, so this adapter carries no command list of its own.
_tap_completion() {
  local cur="${COMP_WORDS[COMP_CWORD]}" head="${COMP_LINE:0:COMP_POINT}"
  local rows candidate description file files=0
  local -a words
  COMPREPLY=()
  # With the cursor inside a word, complete the text to its left.
  while [ -n "$cur" ] && [ "${head%"$cur"}" = "$head" ]; do cur="${cur%?}"; done
  words=("${COMP_WORDS[@]}")
  words[COMP_CWORD]="$cur"
  rows="$(command tap completion candidates --cursor "$((COMP_CWORD + 1))" -- "${words[@]}" 2>/dev/null)" || return 0
  # Registration uses nospace, so each finished word carries its own trailing
  # space and a directory can end in a slash instead.
  while IFS=$'\t' read -r candidate description; do
    [ -n "$candidate" ] || continue
    if [ "$candidate" = $'\x1fFILES' ]; then files=1; continue; fi
    COMPREPLY[${#COMPREPLY[@]}]="$candidate "
  done <<< "$rows"
  [ "$files" = 1 ] || return 0
  # A body-file word is unquoted or sits in an open quote. Readline keeps the
  # opening quote and closes it after a single match, so a quoted reply is
  # escaped for that quote and carries no closing quote and no trailing space.
  local typed="$cur" open="" quoted path end
  local home_prefix="~/" bs='\' sq="'" dq='"' dollar='$' tick='`' mark=$'\001'
  case "$typed" in
    # Inside double quotes the typed text may already carry the four escapes a
    # reply uses; file names are matched against the text they stand for.
    "$dq"*) open="$dq"; typed=${typed#"$dq"}
      typed=${typed//"$bs$bs"/"$mark"}; typed=${typed//"$bs$dq"/"$dq"}; typed=${typed//"$bs$dollar"/"$dollar"}
      typed=${typed//"$bs$tick"/"$tick"}; typed=${typed//"$mark"/"$bs"} ;;
    "$sq"*) open="$sq"; typed="${typed#"$sq"}" ;;
    *) typed="${typed//\\/}" ;;
  esac
  # A tilde inside quotes is not a home directory.
  if [ -n "$open" ]; then case "$typed" in "$home_prefix"*) return 0 ;; esac; fi
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    path="$file"; end=" "
    case "$open" in
      "$dq") end=""; quoted=${file//"$bs"/"$bs$bs"}; quoted=${quoted//"$dq"/"$bs$dq"}; quoted=${quoted//"$dollar"/"$bs$dollar"}; quoted=${quoted//"$tick"/"$bs$tick"} ;;
      "$sq") end=""; quoted=${file//"$sq"/"$sq$bs$sq$sq"} ;;
      *) case "$file" in
           # A leading ~/ stays unquoted so the shell still expands it.
           "$home_prefix"*) quoted="$home_prefix$(printf '%q' "${file#"$home_prefix"}")"; path="$HOME/${file#"$home_prefix"}" ;;
           *) quoted="$(printf '%q' "$file")" ;;
         esac ;;
    esac
    if [ -d "$path" ]; then COMPREPLY[${#COMPREPLY[@]}]="$quoted/"
    else COMPREPLY[${#COMPREPLY[@]}]="$quoted$end"
    fi
  done <<< "$(compgen -f -- "$typed")"
  return 0
}
complete -o nospace -F _tap_completion tap
