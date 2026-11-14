# How git reaches these hooks

Everything in this directory except this file and the `*.local` guards is etymd's generated
gate pack (see the `etymd:generated` stamps at the end of each file). `etymd gates` installs
the pack and points git at it by setting `core.hooksPath` to `.githooks` — that setting is
machine-local, which is why git runs these hooks in this checkout and not in a plain clone;
there they sit inert until `etymd gates` runs again or you set `core.hooksPath` by hand. Of
the checks inside, only the `screen` calls need etymd — the shell correctness and audit
checks in `pre-push` need nothing but their tools being on PATH. A later `etymd gates` run
overwrites the generated hooks (it asks before clobbering hand-edited ones), so fixes to them
belong upstream in etymd's pack; your own guards go in `pre-push.local`, `pre-commit.local`
or `commit-msg.local`, which etymd never reads, writes or regenerates.
<!-- etymd:generated pack-v28 f5e69569e5fabfb1 -->
