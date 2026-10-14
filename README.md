# slopsquat-gate

A coding assistant opens a pull request that adds JWT auth to a FastAPI service. The diff
looks reasonable, and `requirements.txt` gains one line:

```diff
 requests==2.32.3
+fastapi-jwt-guardian-pro
```

The name sounds right, but no such package exists. The model made it up. That happens often: in
576,000 code samples from 16 models, at least 5.2% of the packages that commercial models
suggested did not exist, and 21.7% of those from open-source models. The study found 205,474
different made-up names ([Spracklen et al., USENIX Security 2025][paper]).

A made-up name is free for anyone to register. A researcher at Lasso Security noticed
models recommending `huggingface-cli`, a Python package that did not exist, and uploaded an
empty package under that name. In three months it had more than 30,000 authentic downloads, and
an Alibaba research repository told its readers to install it ([Lasso, March 2024][lasso]). Seth Larson
named the attack _slopsquatting_ ([via Simon Willison][name]).

`slopsquat-gate` runs on the pull request. It reads the manifests on both sides, takes the
dependencies the change adds, and asks the public registry whether each one exists and when it
was first published:

```console
$ npx slopsquat-gate
slopsquat-gate 0.1.0: HEAD (fb41127) against main (d2c20f3)
Packages first published less than 30 days ago fail.

  FAIL   pypi   fastapi-jwt-guardian-pro  requirements.txt  does not exist on pypi.org: a made-up name, and anyone can register it
  ok     npm    zod                       package.json      first published 2020-03-07

1 of 2 new dependencies failed.
$ echo $?
1
```

If someone has registered the name by the time you run it, it fails for its age instead, with a
line like `first published 2026-10-08, 6 days ago: newer than 30 days`.

## Use in GitHub Actions

It needs Node 18 or later and git. Run it before anything installs the dependencies: a squatted package runs its install script
the moment it is installed.

```yaml
name: dependencies
on: pull_request

permissions:
  contents: read

jobs:
  slopsquat-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the base branch is needed for the comparison
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx --yes slopsquat-gate
```

In a pull request, the base is `origin/$GITHUB_BASE_REF`; elsewhere it is `origin/main`. The
comparison starts from the merge base, like `base...head`, so changes that landed on the base
branch meanwhile are not counted. The result is also written to the job summary.

Locally, or for other CI systems:

```console
$ npx slopsquat-gate --base origin/develop --head my-branch
```

| Option | |
| --- | --- |
| `--base <ref>` | what the change is compared with |
| `--head <ref>` | the change to check (default `HEAD`) |
| `--min-age <days>` | fail packages first published fewer days ago (default 30; `0` turns it off) |
| `--config <file>` | read the policy from this file |
| `--json` | print the result as JSON |

Exit codes: `0` pass, `1` a new dependency failed, `2` a usage error, a manifest that cannot be
parsed, or a registry that could not be reached. A gate that cannot ask does not pass.

## What it checks

| Ecosystem | Manifests | Asked |
| --- | --- | --- |
| npm | `package.json`: `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` | `registry.npmjs.org/<name>`: `time.created` |
| PyPI | `requirements*.txt` (following `-r`), `pyproject.toml`: `[project]`, optional dependencies, `[dependency-groups]`, `[build-system]`, Poetry | `pypi.org/simple/<name>/` (JSON): the earliest `upload-time` of any file |
| crates.io | `Cargo.toml`: all dependency tables, target-specific and workspace ones included | `crates.io/api/v1/crates/<name>`: `created_at` |

A dependency is new when no manifest on the base side resolves the same package the same way.
Bumping a version or moving a dependency to another manifest is not new; `npm:` aliases are
followed to the package they install, and names are compared the way each registry compares
them (`Django_Rest.Framework` is `django-rest-framework`).

| Result | When |
| --- | --- |
| `FAIL` | the registry does not know the name |
| `FAIL` | first published less than `minAgeDays` ago |
| `FAIL` | npm replaced it with a [security holding package][holder] (`0.0.1-security`) after removing malware, PyPI [quarantined][quarantine] it, every version was unpublished, or it has no files |
| `warn` | deprecated ([npm][npm-deprecate], or the PyPI [project status][pep792]) |
| `warn` | not on the public registry, but another registry is configured that may hold it (see below) |
| `allow` | matches the allowlist; not sent anywhere |
| `skip` | git, URL, path, `workspace:` and `jsr:` dependencies, packages in this repository, and packages that resolve from a private registry. They are listed, not checked. |

Only package names leave the machine, and only to `registry.npmjs.org`, `pypi.org` and
`crates.io`, with a User-Agent that names this tool. crates.io is asked one crate per second,
as [its data access policy][crates-policy] asks.

## Private registries

The gate never fails a package only because a private registry is in use:

- An npm scope that `.npmrc` sends elsewhere (`@acme:registry=https://npm.acme.example/`) is
  skipped, and its names are never sent to the public registry. The nearest `.npmrc` above
  each `package.json` is read; only its `registry` lines are used, and auth lines are ignored.
- A default `registry=` that is not npmjs.org is usually a mirror of it, so packages are still
  asked about publicly. One the public registry does not know is a `warn`, not a `FAIL`.
- The same holds for `--index-url` / `--extra-index-url` in requirements files, Poetry sources
  and uv indexes. A package pinned to a named index other than PyPI, or a crate with
  `registry = "..."`, is skipped.

Unscoped internal names are sent to the public registry like any other name. To keep them in,
put them in a scope that `.npmrc` sends to your registry, or list them in `allow`.

## Configuration

`.slopsquat.json` at the root of the repository:

```json
{
  "allow": ["@acme/*", "pypi:acme-tools", "crates:acme-*"],
  "ignore": ["test/fixtures/"],
  "minAgeDays": 30
}
```

- `allow`: names that pass without being asked about: a brand-new internal package, or a young
  one you have reviewed. `*` is a wildcard; a `npm:`, `pypi:` or `crates:` prefix limits an
  entry to one ecosystem.
- `ignore`: manifests to leave out, as path globs (`**` crosses directories, a trailing `/`
  means everything below).
- `minAgeDays`: the age threshold; `--min-age` overrides it.

The file is read from the base branch, not from the change: a pull request cannot wave its own
new dependency through by adding it to `allow`. A change to the file applies once it is merged.
`--config <file>` reads another file instead.

## What it does not do

- **Typosquats.** `expresss` or `reqeusts` look like popular packages but may be years old.
  Telling them apart needs a list of popular names, which would either go stale in this
  package or need another network call. The tools below do it.
- **Malware.** Nothing is downloaded or analysed. A name registered long before the pull
  request passes the age check.
- **Vulnerabilities** in packages that do exist.
- **Lockfiles and transitive dependencies.** Only what the manifests declare is read.
- Other ecosystems: Go, Maven, RubyGems, NuGet and the rest.

## Compared with

- [npm `min-release-age`][npm-age] (in days, off by default) and
  [pnpm `minimumReleaseAge`][pnpm-age] (pnpm 10.16, in minutes, a day by default since pnpm 11)
  refuse to install versions younger than the threshold. They cover every version, including
  updates of old packages, at install time. This gate looks only at packages a change adds, at
  their first publication, and also fails names that do not exist, before anything is installed.
- [Aikido Safe Chain][safe-chain] wraps npm, pnpm, yarn, bun, pip, uv, Poetry and others with a
  local proxy that blocks known malware, and suppresses versions younger than 48 hours by
  default. It works where packages are installed; this gate works on the pull request.
- [Socket][socket] is a service with a GitHub app and a CLI that analyses packages across the
  dependency tree; it has written about [slopsquatting][socket-slop] and flags packages with
  few downloads ([Unpopular package][socket-unpopular]).
- [npq][npq] asks before `npm install`: among other checks, it warns about packages created
  less than 22 days ago and about typosquats. It is interactive and covers npm.
- [GuardDog][guarddog] scans packages for malware with heuristics, typosquatting among them.
- [dependency-review-action][dra] reviews dependency changes in pull requests for known
  vulnerabilities and licenses; its documentation does not mention whether a package exists or
  how old it is.
- Phylum analysed newly published packages; [Veracode acquired its technology][phylum] in 2025.

Use this gate next to them. It has no account, no service and no dependencies, and fails a
pull request at review time with one line per reason.

## Limits

- The first-publish date is what the registry reports: npm's `time.created`, the earliest
  file upload on PyPI, crates.io's `created_at`.
- npm keeps `time` only in the full package document, which is several megabytes for large
  packages. It is fetched once per new dependency.
- If the base branch is not in the clone, the gate stops with exit code 2. In GitHub Actions,
  check out with `fetch-depth: 0`.

## License

MIT

[paper]: https://arxiv.org/abs/2406.10279
[lasso]: https://www.lasso.security/blog/ai-package-hallucinations
[name]: https://simonwillison.net/2025/Apr/12/andrew-nesbitt/
[holder]: https://github.com/npm/security-holder
[quarantine]: https://blog.pypi.org/posts/2024-12-30-quarantine/
[pep792]: https://peps.python.org/pep-0792/
[npm-deprecate]: https://docs.npmjs.com/cli/v11/commands/npm-deprecate
[crates-policy]: https://crates.io/data-access
[npm-age]: https://docs.npmjs.com/cli/v11/using-npm/config#min-release-age
[pnpm-age]: https://pnpm.io/settings/dependency-resolution
[safe-chain]: https://github.com/AikidoSec/safe-chain
[socket]: https://github.com/SocketDev/socket-cli
[socket-slop]: https://socket.dev/blog/slopsquatting-how-ai-hallucinations-are-fueling-a-new-class-of-supply-chain-attacks
[socket-unpopular]: https://socket.dev/alerts/unpopularPackage
[npq]: https://github.com/lirantal/npq
[guarddog]: https://github.com/DataDog/guarddog
[dra]: https://github.com/actions/dependency-review-action
[phylum]: https://www.veracode.com/press-release/veracode-acquires-phylum-inc-technology-to-transform-software-supply-chain-security/
