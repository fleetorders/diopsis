#!/usr/bin/env sh
# etymd: shell script discovery for the pre-push shellcheck step. Arguments: the scratch
# directory the hook created, then the tracked paths to classify (NUL-delimited on the hook's
# side, positional here). Verdicts land in the scratch: scripts (NUL-delimited matches) and one
# dot per decision into count / zsh-count / skip-count, tallied by the hook after the pipeline.
#
# The hook runs it from inside a commit materialised from git's object store, so paths resolve
# against that tree, never the working tree. A path with nothing readable behind it — a
# submodule entry, a dangling symlink — cannot lie about its contents, so it is a disclosed
# skip, never a block. A regular file
# that EXISTS but cannot be read is the other branch — coverage would silently shrink, so it
# fails, naming the path.
#
# The match/error protocol: grep reports "no match" as 1 and a failure as 2 or more, and only
# the first is a verdict. Letting a failure fall through would pass a broken matcher as "not a
# shell script" — the exact silent coverage-shrink the fail-closed rules exist to prevent. The
# status is captured on the grep's own line (`|| st=$?`), so no command added later can come
# between the grep and the check and silently replace the status being read.
work=$1
shift
for file do
  if [ ! -f "./$file" ]; then
    printf . >> "$work/skip-count" || exit 1
    continue
  fi
  # 4096 bytes bound the read — a binary with no newline would otherwise be copied whole
  # into the scratch on every push. The second head restores line-1-only semantics, so a
  # shebang embedded on a LATER line of a document cannot match the patterns below.
  head -c 4096 "./$file" > "$work/head-bytes" || {
    echo "etymd: cannot read tracked file for shellcheck: $file" >&2
    exit 1
  }
  head -n 1 "$work/head-bytes" > "$work/first-line" || exit 1
  st=0
  grep -qE "^#!.*[/ ](ba|da)?sh( |$)" "$work/first-line" || st=$?
  case $st in
    (0)
      printf "./%s\0" "$file" >> "$work/scripts" || exit 1
      printf . >> "$work/count" || exit 1 ;;
    (1)
      st=0
      grep -qE "^#!.*[/ ]zsh( |$)" "$work/first-line" || st=$?
      case $st in
        (0) printf . >> "$work/zsh-count" || exit 1 ;;
        (1) ;;
        (*) exit 1 ;;
      esac ;;
    (*) exit 1 ;;
  esac
done
# etymd:generated pack-v16 80660a7c1ece935e
