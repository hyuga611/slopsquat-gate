import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupPypi, normalizePypi, parsePyproject, parseRequirement, parseRequirements } from '../src/pypi.mjs';
import { fakeRegistry, pypiDoc } from './helpers.mjs';

test('names are normalized the way PyPI compares them', () => {
  assert.equal(normalizePypi('Django_REST.framework'), 'django-rest-framework');
  assert.equal(normalizePypi('zope..interface'), 'zope-interface');
});

test('dependency specifiers: versions, extras, markers and direct URLs', () => {
  assert.deepEqual(parseRequirement('requests'), { name: 'requests' });
  assert.deepEqual(parseRequirement('requests[socks,security] >= 2.8.1, == 2.8.*'), { name: 'requests' });
  assert.deepEqual(parseRequirement('pywin32 >=1.0 ; sys_platform == "win32"'), { name: 'pywin32' });
  assert.deepEqual(parseRequirement('name (>=1.0)'), { name: 'name' });
  assert.equal(parseRequirement('pip @ https://github.com/pypa/pip/archive/1.3.1.zip').skip, 'url');
  assert.equal(parseRequirement('-not-a-name'), null);
  assert.equal(parseRequirement('requests junk'), null);
});

test('requirements.txt: comments, continuations, per-requirement options and line numbers', () => {
  const r = parseRequirements(
    ['# pinned', 'requests==2.31.0  # http', 'numpy \\', '  >=1.26', 'flask --hash=sha256:abc \\', '    --hash=sha256:def', '', '%%%'].join('\n'),
    'requirements.txt',
    () => null,
  );
  assert.deepEqual(
    r.deps.map((d) => [d.name, d.spec]),
    [['requests', 'requests==2.31.0'], ['numpy', 'numpy   >=1.26'], ['flask', 'flask']],
  );
  assert.deepEqual(r.problems, ['requirements.txt:8: cannot read "%%%"']);
  assert.equal(r.mirror, undefined);
});

test('requirements.txt: -r follows the file relative to the one including it', () => {
  const files = { 'py/requirements/base.txt': 'django>=5\n-r ../common.txt\n', 'py/common.txt': 'celery\n' };
  const r = parseRequirements('-r requirements/base.txt\n--requirement=missing.txt\n', 'py/requirements-dev.txt', (p) => files[p] ?? null);
  assert.deepEqual(
    r.deps.map((d) => [d.name, d.file]),
    [['django', 'py/requirements/base.txt'], ['celery', 'py/common.txt']],
  );
  assert.deepEqual(r.problems, ['py/requirements-dev.txt:2: missing.txt is not in the repository']);
});

test('requirements.txt: editable installs, URLs and paths are not checked', () => {
  const r = parseRequirements(
    ['-e .', '-e git+https://github.com/u/r.git#egg=mylib', 'git+https://github.com/u/other.git', './vendor/pkg', 'https://example.com/x-1.0.tar.gz', 'pkg @ file:///tmp/pkg', 'C:\\wheels\\a-1.0-py3-none-any.whl'].join('\n'),
    'requirements.txt',
    () => null,
  );
  assert.deepEqual(
    r.deps.map((d) => [d.name, d.skip]),
    [['.', 'editable'], ['mylib', 'editable'], ['git+https://github.com/u/other.git', 'url'], ['./vendor/pkg', 'url'], ['https://example.com/x-1.0.tar.gz', 'url'], ['pkg', 'url'], ['C:\\wheels\\a-1.0-py3-none-any.whl', 'url']],
  );
  assert.deepEqual(r.problems, []);
});

test('requirements.txt: another index means a package missing from PyPI may live there', () => {
  const extra = parseRequirements('--extra-index-url https://user:token@pkgs.acme.example/simple\nacme-tools\n', 'requirements.txt', () => null);
  assert.equal(extra.mirror, 'pkgs.acme.example');
  assert.equal(parseRequirements('-i https://pypi.org/simple\nrequests\n', 'requirements.txt', () => null).mirror, undefined);
  assert.match(parseRequirements('--no-index\n--find-links ./wheels\nx\n', 'requirements.txt', () => null).mirror, /find-links/);
});

test('pyproject.toml: [project], optional dependencies, dependency groups and the build backend', () => {
  const r = parsePyproject(`
[project]
name = "my-app"
dependencies = ["httpx>=0.27", "rich"]
[project.optional-dependencies]
cli = ["typer[all]"]
[dependency-groups]
test = ["pytest", {include-group = "lint"}]
lint = ["ruff"]
[build-system]
requires = ["hatchling"]
`);
  assert.deepEqual(r.names, ['my-app']);
  assert.deepEqual(r.deps.map((d) => d.name), ['httpx', 'rich', 'typer', 'pytest', 'ruff', 'hatchling']);
  assert.deepEqual(r.problems, []);
});

test('pyproject.toml: Poetry dependencies, groups and sources', () => {
  const r = parsePyproject(`
[tool.poetry]
name = "legacy"
[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"
mylib = { git = "https://github.com/u/mylib.git" }
sibling = { path = "../sibling", develop = true }
internal = { version = "^1", source = "acme" }
pinned = { version = "^1", source = "PyPI" }
[tool.poetry.group.dev.dependencies]
pytest = "^8"
[[tool.poetry.source]]
name = "acme"
url = "https://pkgs.acme.example/simple/"
priority = "supplemental"
`);
  assert.deepEqual(r.names, ['legacy']);
  assert.deepEqual(
    r.deps.map((d) => [d.name, d.skip]),
    [['requests', undefined], ['mylib', 'git'], ['sibling', 'path'], ['internal', 'private'], ['pinned', undefined], ['pytest', undefined]],
  );
  assert.equal(r.mirror, 'pkgs.acme.example');
});

test('pyproject.toml: uv sources send a package to git, a path, the workspace or an index', () => {
  const r = parsePyproject(`
[project]
name = "root"
dependencies = ["Member_Pkg", "forked", "torch", "httpx"]
[tool.uv.sources]
member-pkg = { workspace = true }
forked = { git = "https://github.com/u/forked" }
torch = [{ index = "pytorch-cu121", marker = "sys_platform == 'linux'" }]
[[tool.uv.index]]
name = "pytorch-cu121"
url = "https://download.pytorch.org/whl/cu121"
explicit = true
`);
  assert.deepEqual(
    r.deps.map((d) => [d.name, d.skip]),
    [['Member_Pkg', 'workspace'], ['forked', 'git'], ['torch', 'private'], ['httpx', undefined]],
  );
  assert.equal(r.mirror, 'download.pytorch.org');
});

test('pyproject.toml: an unreadable specifier is a problem, malformed TOML an error', () => {
  assert.deepEqual(parsePyproject('[project]\ndependencies = ["ok", "not ok!"]\n').problems, ['[project] dependencies: cannot read "not ok!"']);
  assert.throws(() => parsePyproject('[project\n'));
});

test('lookup: the first upload is the earliest file of any release, asked in the JSON simple API', async () => {
  const fetch = fakeRegistry({
    pypi: { 'django-rest-framework': pypiDoc('2019-05-01T00:00:00.000000Z', '2014-02-03T04:05:06.123456Z', '2024-01-01T00:00:00Z') },
  });
  const facts = await lookupPypi('Django_Rest.Framework', fetch);
  assert.equal(facts.created, '2014-02-03T04:05:06.123Z');
  assert.equal(fetch.calls[0].url, 'https://pypi.org/simple/django-rest-framework/');
  assert.equal(fetch.calls[0].headers.accept, 'application/vnd.pypi.simple.v1+json');
});

test('lookup: missing, quarantined, deprecated and empty projects', async () => {
  const fetch = fakeRegistry({
    pypi: {
      bad: { meta: { 'api-version': '1.4' }, 'project-status': { status: 'quarantined' }, files: [] },
      old: { ...pypiDoc('2010-01-01T00:00:00Z'), 'project-status': { status: 'deprecated', reason: 'use new' } },
      empty: pypiDoc(),
    },
  });
  assert.deepEqual(await lookupPypi('nope', fetch), { found: false });
  assert.equal((await lookupPypi('bad', fetch)).quarantined, true);
  assert.equal((await lookupPypi('old', fetch)).deprecated, 'use new');
  const empty = await lookupPypi('empty', fetch);
  assert.equal(empty.empty, true);
  assert.equal(empty.created, undefined);
});
