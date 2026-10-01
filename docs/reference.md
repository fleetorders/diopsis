# Command reference

Every command and flag. The [README](../README.md#everyday-use) walks through the everyday
ones; [configuration.md](configuration.md) lists the config keys.

| Command | What it does |
|---|---|
| `diopsis init` | Scaffold config, git settings and a CI recipe; print what the matrix costs |
| `diopsis run` | Verify against committed baselines *(default command)* |
| `diopsis update` | Regenerate baselines |
| `diopsis accept [story-id...]` | Adopt the last run's output, for the named stories or wholesale |
| `diopsis report` | Open the last report |
| `diopsis doctor` | Audit the setup |
| `diopsis prune` | List baselines no capture would write any more; `--yes` deletes and stages them |
| `diopsis merge [dir…]` | Merge sharded runs into one report and one verdict |
| `diopsis trace <file…>` | Show which stories a file reaches, or why it forces a full run |
| `diopsis diff [base]` | Report the baseline changes this branch makes against `base` (default `origin/main`) |
| `diopsis --version` | Print the installed version |

| Flag | Applies to | Effect |
|---|---|---|
| `--grep <text>` | `run`, `update` | Only stories whose id contains `<text>` |
| `--keep` | `run`, `update` | Keep the generated Playwright project for inspection |
| `--force` | `init` | Overwrite an existing config |
| `--lfs` | `init` | Set the baselines up for Git LFS |
| `--no-stage` | `accept` | Write the files without staging them in git |
| `--changed [base]` | `run` | Capture only the stories the changes since `base` can affect |
| `--shard <i>/<n>` | `run` | Capture one shard of the matrix, split by story |
| `--from <dir>` | `accept` | Accept from a merged or downloaded run instead of the output directory |
| `--open` | `diff` | Open the report when it is written |
| `--platform <token>` | `diff` | Only baselines of one platform, e.g. `linux-x64` |
| `--json` | `doctor` | Print the audit as one JSON document, for a CI step to read |
| `-- <args>` | `run`, `update` | Pass the rest to Playwright, e.g. `--workers=2` |

A flag given to a command it does not belong to is refused rather than ignored. The config is
checked when it loads, and every problem is reported at once with the key and the value it
had; `viewports` must name a `default` set, and an empty one means only tagged stories are
captured.


## `diopsis doctor`

`diopsis doctor` audits all of it:

```console
$ npx diopsis doctor

Diopsis doctor

  · Baseline image is pinned
      mcr.microsoft.com/playwright:v1.62.1-jammy — the CI job must name this exact image.
  · 7 stories → 13 captures
      Widths default: 320, 1280
  · 13 baselines, 116 KB
      Every intentional change adds another set to history permanently — this figure only grows.
  · Every baseline carries a platform and architecture
      This machine writes darwin-arm64.
  · No orphaned baselines for this platform
  · Baselines are marked unmergeable in .gitattributes

Everything checks out.
```

It also reports baselines for stories that no longer exist, baselines missing a platform suffix,
a `.gitignore` that excludes your baselines, and another tool's ignore attribute left behind by
a migration.

