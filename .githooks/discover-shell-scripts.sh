#!/usr/bin/env sh
# etymd: shell script discovery for the pre-push shellcheck step. Two calls per commit:
#   discover-shell-scripts.sh --skips <scratch> <ls-tree record>...
#   discover-shell-scripts.sh --commit <scratch> <tree> <commit> <commit>:<path>...
# The first counts the changed paths that are symlinks or submodule entries. The second reads
# the candidates `git grep` found with a line starting `#!`, and classifies each by its FIRST
# line. Verdicts land in the scratch: scripts (NUL-delimited matches) and one dot per decision
# into count / zsh-count / skip-count, tallied by the hook after the pipeline. Each script found
# is written into <tree> at its path, so the checker reads it there.
#
# Every byte comes from git's object store as the raw blob — `git cat-file blob`, which
# applies no eol, text or filter attribute. A checkout converts: under `eol=crlf` the shebang
# line ends in a carriage return, the match below fails, and the script leaves the checked set
# without a word. Only the entries handed in are read, never the whole commit.
#
# A symlink or submodule entry has no script bytes of its own — a link's target is a tracked
# path checked under its own name — so it is a disclosed skip, never a block. A candidate that
# cannot be read fails, naming the path: coverage would otherwise silently shrink.
#
# The match/error protocol: grep reports "no match" as 1 and a failure as 2 or more, and only
# the first is a verdict. Letting a failure fall through would pass a broken matcher as "not a
# shell script" — the exact silent coverage-shrink the fail-closed rules exist to prevent. The
# status is captured on the grep's own line (`|| st=$?`), so no command added later can come
# between the grep and the check and silently replace the status being read.
case ${1-} in
  (--skips)
    # Records only: a symlink or submodule entry is counted, everything else is left to the
    # candidate pass. Builtins only — this loop sees every changed path.
    work=$2
    shift 2
    for record do
      case ${record%% *} in
        (100644|100755) ;;
        (*) printf . >> "$work/skip-count" || exit 1 ;;
      esac
    done
    exit 0 ;;
  (--commit)
    [ $# -ge 4 ] || exit 1 ;;
  (*)
    echo "etymd: discover-shell-scripts.sh expects --commit or --skips; the pre-push beside it is older than this classifier — run 'etymd gates'" >&2
    exit 1 ;;
esac
work=$2
tree=$3
sha=$4
shift 4
for entry do
  file=${entry#"$sha":}
  # 4096 bytes bound the classifying read — a binary with no newline would otherwise be copied
  # whole into the next step. The second head restores line-1-only semantics, so a shebang
  # embedded on a LATER line of a document cannot match the patterns below.
  git cat-file blob "$sha:$file" > "$work/blob" && head -c 4096 "$work/blob" > "$work/head-bytes" || {
    echo "etymd: cannot read tracked file for shellcheck: $file" >&2
    exit 1
  }
  head -n 1 "$work/head-bytes" > "$work/first-line" || exit 1
  st=0
  grep -qE "^#!.*[/ ](ba|da)?sh( |$)" "$work/first-line" || st=$?
  case $st in
    (0)
      case $file in
        (*/*) dir=${file%/*} ;;
        (*) dir=. ;;
      esac
      mkdir -p -- "$tree/$dir" && mv -- "$work/blob" "$tree/$file" || {
        echo "etymd: cannot stage tracked file for shellcheck: $file" >&2
        exit 1
      }
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
# etymd:generated pack-v17 e4aaa066070f03eb
