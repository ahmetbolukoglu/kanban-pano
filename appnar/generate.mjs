// AppNar factory — runs inside the generated repository's GitHub Actions.
//
//   node appnar/generate.mjs <plan|logic|ui|docs|verify>
//
// Each phase calls a language model, writes files, checks them and commits.
// The AI key is the repo owner's own (Gemini or Groq). It is fetched at run
// time from AppNar with this workflow's GitHub OIDC token, so no secret is
// stored in the repository. An AI_API_KEY repository secret overrides that.
// Zero dependencies; Node 22+.
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORK = 'appnar/.work';
const MAX_FIX_ROUNDS = 3;

// ───────────────────────────── model access ─────────────────────────────

// `models` are fallbacks only: the live model list is read at start (see
// discoverModels), because providers retire model ids every few months.
const PROVIDERS = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    models: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    maxTokens: 16000,
    extra: {},
    gapMs: 6500, // free tier: about 10 requests per minute
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    maxTokens: 8000,
    extra: {},
    gapMs: 2500,
  },
};

export function makeProvider(name, key) {
  const def = PROVIDERS[name];
  if (!def) throw new Error(`unknown AI provider "${name}"`);
  if (!key) throw new Error(`no API key for ${name}`);
  return { name, key, ...def, models: [...def.models] };
}

/** "gemini-3.8-flash" → [3, 8]; used to sort model ids newest first. */
function versionOf(id) {
  const m = id.match(/(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
}

/**
 * Picks the best Gemini text models the key can use, newest Flash first, then
 * Flash-Lite. Skips previews, experiments and image/audio/embedding variants.
 */
export function pickGeminiModels(list) {
  const ok = list
    .filter((m) => (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
    .map((m) => String(m.name ?? '').replace(/^models\//, ''))
    .filter((id) => /^gemini-[\d.]+-flash(-lite)?$/.test(id));
  const byVersion = (a, b) => {
    const [a1, a2] = versionOf(a);
    const [b1, b2] = versionOf(b);
    return b1 - a1 || b2 - a2;
  };
  const flash = ok.filter((id) => !id.endsWith('-lite')).sort(byVersion);
  const lite = ok.filter((id) => id.endsWith('-lite')).sort(byVersion);
  return [...flash.slice(0, 2), ...lite.slice(0, 1)];
}

/** Puts the models this key can actually use first; keeps the static list as a backstop. */
export async function discoverModels(provider, fetcher = fetch) {
  try {
    if (provider.name === 'gemini') {
      const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(provider.key)}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return provider;
      const live = pickGeminiModels((await res.json()).models ?? []);
      if (live.length) provider.models = [...new Set([...live, ...provider.models])];
    } else if (provider.name === 'groq') {
      const res = await fetcher('https://api.groq.com/openai/v1/models', {
        headers: { Authorization: `Bearer ${provider.key}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return provider;
      const ids = new Set(((await res.json()).data ?? []).map((m) => m.id));
      const known = provider.models.filter((id) => ids.has(id));
      if (known.length) provider.models = known;
    }
  } catch {
    // Discovery is best effort; the static list still works.
  }
  return provider;
}

/**
 * Finds the AI keys: a repo secret first, otherwise ask AppNar with an OIDC
 * token. Returns the primary provider; any others ride along as `fallbacks`.
 */
export async function resolveProvider(spec, env = process.env, fetcher = fetch) {
  if (env.AI_API_KEY) return makeProvider(env.AI_PROVIDER || 'gemini', env.AI_API_KEY);
  if (env.GEMINI_API_KEY) return makeProvider('gemini', env.GEMINI_API_KEY);
  if (!spec.keyEndpoint) throw new Error('No AI key: set an AI_API_KEY repository secret or rebuild from AppNar.');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('No OIDC token available: the workflow needs `permissions: id-token: write`.');
  }
  const oidcRes = await fetcher(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=appnar`, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!oidcRes.ok) throw new Error(`could not get an OIDC token: HTTP ${oidcRes.status}`);
  const { value } = await oidcRes.json();
  const res = await fetcher(spec.keyEndpoint, { method: 'POST', headers: { Authorization: `Bearer ${value}` } });
  if (res.status === 404) {
    throw new Error('Your AppNar account has no AI key yet. Add one in AppNar → Settings → AI, then press "Rebuild".');
  }
  if (!res.ok) throw new Error(`AppNar key service answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const keys = Array.isArray(body.keys) && body.keys.length ? body.keys : [{ provider: body.provider, apiKey: body.apiKey }];
  if (env.GITHUB_ACTIONS) for (const k of keys) console.log(`::add-mask::${k.apiKey}`);
  const [primary, ...rest] = keys.map((k) => makeProvider(k.provider, k.apiKey));
  return { ...primary, fallbacks: rest };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polite pause between calls so free-tier rate limits are not hit. */
const pause = (provider) => sleep(provider.gapMs ?? 4000);

/** A 429 that will not clear by waiting: the daily free quota is used up. */
export function isDailyQuota(body) {
  return /PerDay|per day|daily/i.test(body);
}

/** Seconds the provider asks us to wait ("retry-after" header or Gemini's retryDelay). */
function retryAfter(res, body, attempt) {
  const header = Number(res.headers.get('retry-after'));
  if (header > 0) return header;
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(Number(m[1]));
  return 15 * (attempt + 1);
}

/**
 * One chat completion. Retries short rate limits, then falls back across the
 * provider's models and finally across fallback providers (e.g. Gemini → Groq).
 */
export async function chat(provider, system, user, { json = false, fetcher = fetch } = {}) {
  const chain = [provider, ...(provider.fallbacks ?? [])];
  const errors = [];
  for (const p of chain) {
    let rejected = false;
    const models = [...p.models];
    models: for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      // Optional parameters (JSON mode, provider extras) are dropped once if the
      // provider chokes on them; plain chat completions are the most compatible.
      let plain = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        let res;
        try {
          res = await fetcher(p.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(180_000),
            body: JSON.stringify({
              model,
              temperature: 0.4,
              max_tokens: p.maxTokens,
              ...(plain ? {} : (p.extra ?? {})),
              ...(json && !plain ? { response_format: { type: 'json_object' } } : {}),
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            }),
          });
        } catch (e) {
          // Network drop or timeout: same treatment as a 5xx.
          errors.push(`${p.name}/${model}: network error: ${e instanceof Error ? (e.cause?.message ?? e.message) : String(e)}`);
          console.log(`  ${errors.at(-1)}`);
          if (attempt === 3) break;
          await sleep(10_000 * (attempt + 1));
          continue;
        }
        const body = await res.text().catch(() => '');
        if (res.ok) {
          let data = null;
          try {
            data = JSON.parse(body);
          } catch {
            errors.push(`${p.name}/${model}: response is not JSON: ${body.slice(0, 120)}`);
            break;
          }
          const text = data?.choices?.[0]?.message?.content;
          if (typeof text === 'string' && text.trim()) {
            if (p !== provider) console.log(`  answered by fallback ${p.name}/${model}`);
            return text;
          }
          errors.push(`${p.name}/${model}: empty response (finish_reason: ${data?.choices?.[0]?.finish_reason ?? 'unknown'})`);
          break;
        }
        errors.push(`${p.name}/${model}: HTTP ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
        console.log(`  ${errors.at(-1)}`);
        if (res.status === 401 || res.status === 403) {
          rejected = true;
          break models; // a bad key fails every model of this provider
        }
        if (res.status === 429 && isDailyQuota(body)) {
          console.log(`  ${p.name}/${model}: daily free quota used up; trying the next option`);
          break; // waiting will not help today
        }
        if (res.status === 404) {
          // Retired model: providers usually name the replacement ("use models/x instead").
          const suggested = body
            .match(/models\/[\w.-]+/g)
            ?.map((s) => s.slice('models/'.length).replace(/\.+$/, ''))
            .find((id) => id !== model && !models.includes(id));
          if (suggested) {
            console.log(`  ${p.name}/${model} is retired; trying ${suggested}`);
            models.splice(mi + 1, 0, suggested);
          }
          break;
        }
        if (!plain && (res.status === 400 || res.status === 500)) {
          plain = true;
          console.log(`  ${p.name}/${model}: retrying without optional parameters`);
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt === 3) break;
          const wait = Math.min(retryAfter(res, body, attempt), 45);
          console.log(`  ${p.name}/${model}: HTTP ${res.status}; retrying in ${wait}s`);
          await sleep(wait * 1000);
          continue;
        }
        break; // other 4xx (e.g. unknown model): try the next model
      }
    }
    if (rejected) console.log(`  ${p.name}: the key was rejected`);
  }
  const all = errors.join('\n');
  if (errors.every((e) => / HTTP 40[13] /.test(e))) {
    throw new Error(`The AI key was rejected. Check it in AppNar → Settings → AI.\n${all}`);
  }
  if (/HTTP 429/.test(all)) {
    throw new Error(`The free AI quota is used up for now. Try again later, or add a Groq key as a fallback in AppNar → Settings → AI.\n${all}`);
  }
  throw new Error(`Model call failed:\n${all}`);
}

// ───────────────────────────── parsing helpers ─────────────────────────────

/** Removes a surrounding ``` fence if the model added one. */
export function stripFence(text) {
  const m = text.trim().match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : text).trim() + '\n';
}

/** Parses "=== FILE: path ===" blocks. Unknown paths are ignored. */
export function parseFiles(text, allowed) {
  const out = {};
  const re = /^=== FILE: (.+?) ===\s*$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const path = m[1].trim();
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(m.index + m[0].length, end);
    if (allowed.includes(path)) out[path] = stripFence(body);
  });
  return out;
}

export function parseJson(text) {
  const t = text.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model did not return JSON');
  return JSON.parse(t.slice(start, end + 1));
}

/** Names imported from ./logic.js by the UI module. */
export function importedNames(appJs) {
  const names = new Set();
  for (const m of appJs.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/logic\.js['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

/** Element ids the script looks up that the HTML does not define. */
export function missingIds(appJs, html) {
  const defined = new Set([...html.matchAll(/\sid=["']([\w-]+)["']/g)].map((m) => m[1]));
  const used = new Set();
  for (const m of appJs.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) used.add(m[1]);
  for (const m of appJs.matchAll(/querySelector(?:All)?\(\s*['"]#([\w-]+)['"]\s*\)/g)) used.add(m[1]);
  return [...used].filter((id) => !defined.has(id));
}

export function exportedNamesFromSource(logicJs) {
  const names = new Set();
  for (const m of logicJs.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of logicJs.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (alias) names.add(alias);
    }
  }
  return [...names];
}

// ───────────────────────────── io helpers ─────────────────────────────

async function readText(path) {
  return existsSync(path) ? readFile(path, 'utf8') : '';
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function git(...args) {
  execFileSync('git', args, { stdio: 'inherit' });
}

function commit(message, paths) {
  git('add', '--', ...paths);
  const staged = spawnSync('git', ['diff', '--cached', '--quiet']);
  if (staged.status === 0) {
    console.log(`  nothing to commit for "${message}"`);
    return;
  }
  git('commit', '-m', message);
  git('push', 'origin', 'HEAD');
}

function runTests() {
  // A parent test runner's context would swallow the child's exit code.
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', 'tests/*.test.js'], { encoding: 'utf8', timeout: 120_000, env });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

function checkSyntax(path) {
  const r = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || r.stdout || 'syntax error').slice(0, 1500);
}

const tail = (s, n) => (s.length > n ? `…${s.slice(-n)}` : s);

// ───────────────────────────── prompts ─────────────────────────────

const LANG = { tr: 'Turkish', en: 'English' };

function rules(spec) {
  return `You are a senior front-end engineer building a small, polished, production-quality web app.
Hard rules:
- Plain HTML, CSS and JavaScript ES modules. No frameworks, no build step, no CDN, no external requests.
- Data persists in localStorage. Everything works offline.
- All user-facing text is in ${LANG[spec.language] ?? 'English'}. Code identifiers and comments are in English.
- Accessible: semantic HTML, labels for inputs, visible focus, keyboard usable, sufficient contrast.
- Responsive from 360px phones to desktops. Supports light and dark (prefers-color-scheme).
- Brand accent color: ${spec.accent || '#39d353'}.`;
}

function specBlock(spec, plan) {
  return `App request:
- Name: ${spec.name}
- Category: ${spec.category}
- Description: ${spec.description}
- Requested features: ${(spec.features ?? []).join('; ') || '(choose sensible ones)'}
${plan ? `\nPlan:\n${JSON.stringify(plan, null, 1)}` : ''}`;
}

// ───────────────────────────── phases ─────────────────────────────

async function loadSpec() {
  const spec = JSON.parse(await readFile('appnar/spec.json', 'utf8'));
  if (!spec.name || !spec.description) throw new Error('appnar/spec.json needs name and description');
  return spec;
}

async function loadPlan() {
  return JSON.parse(await readFile(`${WORK}/plan.json`, 'utf8'));
}

async function phasePlan(provider, spec) {
  const text = await chat(
    provider,
    `${rules(spec)}\nYou are planning the app. Answer with one JSON object only.`,
    `${specBlock(spec)}

Return JSON with exactly these keys:
{
  "title": "display name",
  "tagline": "one sentence value proposition",
  "features": ["5 to 7 concrete user-facing features"],
  "data_model": "short description of the stored records and fields",
  "screens": ["main UI regions, top to bottom"],
  "logic_api": [{"name": "camelCaseFunction", "signature": "(args) => result", "purpose": "what it does"}],
  "test_cases": ["8 to 12 behaviours the unit tests must check"]
}
logic_api lists 6 to 12 PURE functions (no DOM, no storage, no Date.now inside; pass time in) that hold all business rules: validation, create/update/delete on arrays of records, filtering, sorting, totals, statistics, import/export, etc.`,
    { json: true },
  );
  const plan = parseJson(text);
  if (!Array.isArray(plan.logic_api) || plan.logic_api.length === 0) throw new Error('plan has no logic_api');
  await write(`${WORK}/plan.json`, JSON.stringify(plan, null, 2));

  const md = `# ${plan.title}

> ${plan.tagline}

## Features
${plan.features.map((f) => `- ${f}`).join('\n')}

## Data model
${plan.data_model}

## Screens
${plan.screens.map((s) => `- ${s}`).join('\n')}

## Core logic (\`src/logic.js\`)
| Function | Signature | Purpose |
|---|---|---|
${plan.logic_api.map((f) => `| \`${f.name}\` | \`${f.signature}\` | ${f.purpose} |`).join('\n')}

## Test plan
${plan.test_cases.map((t) => `- [ ] ${t}`).join('\n')}
`;
  await write('docs/PLAN.md', md);
  commit('docs: add product plan', ['docs/PLAN.md']);
}

async function phaseLogic(provider, spec) {
  const plan = await loadPlan();
  const FILES = ['src/logic.js', 'tests/logic.test.js'];
  const format = `Answer with exactly two blocks and nothing else:
=== FILE: src/logic.js ===
<code>
=== FILE: tests/logic.test.js ===
<code>`;

  const first = await chat(
    provider,
    rules(spec),
    `${specBlock(spec, plan)}

Write:
1. src/logic.js — an ES module exporting every function in plan.logic_api (same names). Pure functions only: no DOM, no localStorage, no Date.now()/Math.random() inside (accept them as parameters). Never mutate inputs; return new arrays/objects. Validate inputs and throw Error with a clear message on invalid data. Under 180 lines.
2. tests/logic.test.js — tests using only "node:test" and "node:assert/strict", importing from "../src/logic.js". Cover plan.test_cases, including edge cases. Under 140 lines.

${format}`,
  );
  let files = parseFiles(first, FILES);
  for (const f of FILES) if (!files[f]) throw new Error(`model did not return ${f}`);
  for (const f of FILES) await write(f, files[f]);

  let result = runTests();
  for (let round = 1; !result.ok && round <= MAX_FIX_ROUNDS; round++) {
    const testsOnly = round === MAX_FIX_ROUNDS;
    console.log(`  tests failed; fix round ${round}${testsOnly ? ' (tests only)' : ''}`);
    await pause(provider);
    const fixed = await chat(
      provider,
      rules(spec),
      `The unit tests fail. ${testsOnly ? 'Assume src/logic.js is correct and fix ONLY the tests so they match its documented behaviour.' : 'Fix the bug, in the code or in a wrong test.'}

=== FILE: src/logic.js ===
${files['src/logic.js']}
=== FILE: tests/logic.test.js ===
${files['tests/logic.test.js']}

Test output:
${tail(result.output, 3500)}

${format}`,
    );
    const next = parseFiles(fixed, FILES);
    if (testsOnly) delete next['src/logic.js'];
    files = { ...files, ...next };
    for (const f of FILES) await write(f, files[f]);
    result = runTests();
  }
  if (!result.ok) {
    console.error(tail(result.output, 4000));
    throw new Error('unit tests still fail after fix rounds');
  }
  console.log(result.output.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join('\n'));
  commit('feat: core logic with unit tests', FILES);
}

async function phaseUi(provider, spec) {
  const plan = await loadPlan();
  const logic = await readFile('src/logic.js', 'utf8');
  const exported = exportedNamesFromSource(logic);
  const api = plan.logic_api.map((f) => `${f.name}${f.signature.startsWith('(') ? f.signature : `: ${f.signature}`} — ${f.purpose}`).join('\n');

  // 1) Markup and styles.
  const shell = await chat(
    provider,
    rules(spec),
    `${specBlock(spec, plan)}

Write the markup and styles.
- index.html: complete document, lang attribute, <meta name="viewport">, <title>, <link rel="stylesheet" href="styles.css">, and <script type="module" src="src/app.js"></script>. Give every element the script will touch a unique, descriptive id. Include an empty state, a form for creating records, the list/board/table area, and a footer line "Built with AppNar".
- styles.css: modern, clean design system with CSS custom properties, light and dark themes, comfortable spacing, rounded cards, subtle shadows, hover/focus states, smooth but reduced-motion-aware transitions, mobile-first responsive layout. Under 260 lines.

Answer with exactly two blocks:
=== FILE: index.html ===
<code>
=== FILE: styles.css ===
<code>`,
  );
  const sf = parseFiles(shell, ['index.html', 'styles.css']);
  if (!sf['index.html'] || !sf['styles.css']) throw new Error('model did not return index.html and styles.css');
  await write('index.html', sf['index.html']);
  await write('styles.css', sf['styles.css']);
  await pause(provider);

  // 2) Behaviour, checked against the markup and the logic exports.
  const ask = (extra = '') =>
    chat(
      provider,
      rules(spec),
      `${specBlock(spec, plan)}

Write src/app.js: the ES module that wires the UI.
- import { ... } from './logic.js' — available exports: ${exported.join(', ')}
- Logic API:
${api}
- Use ONLY element ids that exist in this index.html:
${tail(sf['index.html'], 5000)}
- Load/save state in localStorage under the key "${spec.slug || 'app'}:v1" with try/catch; render from state; event delegation for lists; show friendly validation messages; confirm before destructive actions.
- Under 220 lines. Output only the JavaScript code.${extra}`,
    );

  let appJs = stripFence(await ask());
  for (let round = 1; round <= MAX_FIX_ROUNDS; round++) {
    await write('src/app.js', appJs);
    const problems = [];
    const syntax = checkSyntax('src/app.js');
    if (syntax) problems.push(`Syntax error:\n${syntax}`);
    const unknown = importedNames(appJs).filter((n) => !exported.includes(n));
    if (unknown.length) problems.push(`Imports that logic.js does not export: ${unknown.join(', ')}`);
    const missing = missingIds(appJs, sf['index.html']);
    if (missing.length) problems.push(`Ids used but not present in index.html: ${missing.join(', ')}`);
    if (problems.length === 0) break;
    if (round === MAX_FIX_ROUNDS) throw new Error(`src/app.js still has problems:\n${problems.join('\n')}`);
    console.log(`  app.js problems; fix round ${round}:\n${problems.join('\n')}`);
    await pause(provider);
    appJs = stripFence(await ask(`\n\nYour previous attempt had these problems — fix them:\n${problems.join('\n')}`));
  }
  commit('feat: user interface', ['index.html', 'styles.css', 'src/app.js']);
}

async function phaseDocs(provider, spec, env = process.env) {
  const plan = await loadPlan();
  const repo = env.GITHUB_REPOSITORY ?? `owner/${spec.slug}`;
  const [owner, name] = repo.split('/');
  const demo = `https://${owner}.github.io/${name}/`;
  const tr = spec.language === 'tr';

  const intro = stripFence(
    await chat(
      provider,
      rules(spec),
      `${specBlock(spec, plan)}

Write the opening of README.md in ${LANG[spec.language] ?? 'English'}: a short paragraph about the problem it solves and who it is for, then a "## ${tr ? 'Özellikler' : 'Features'}" bullet list (with one emoji per bullet). Markdown only, no title, no installation section. Under 30 lines.`,
    ),
  );

  const readme = `# ${plan.title}

[![AppNar Factory](https://github.com/${repo}/actions/workflows/appnar.yml/badge.svg)](https://github.com/${repo}/actions/workflows/appnar.yml)
[![Live demo](https://img.shields.io/badge/${tr ? 'canl%C4%B1_demo' : 'live_demo'}-online-39d353)](${demo})
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

> ${plan.tagline}

**${tr ? 'Canlı demo' : 'Live demo'}:** ${demo}

${intro.trim()}

## ${tr ? 'Nasıl çalışır' : 'How it works'}

\`\`\`mermaid
flowchart LR
  UI["index.html + styles.css"] --> APP["src/app.js<br/>${tr ? 'arayüz ve durum' : 'UI and state'}"]
  APP --> LOGIC["src/logic.js<br/>${tr ? 'saf iş kuralları' : 'pure business rules'}"]
  APP --> LS[("localStorage")]
  TESTS["tests/logic.test.js"] --> LOGIC
\`\`\`

## ${tr ? 'Yerelde çalıştır' : 'Run locally'}

\`\`\`bash
git clone https://github.com/${repo}.git
cd ${name}
npx serve .        # ${tr ? 'veya herhangi bir statik sunucu' : 'or any static server'}
npm test
\`\`\`

${tr ? 'Bağımlılık yok: düz HTML, CSS ve JavaScript modülleri.' : 'No dependencies: plain HTML, CSS and JavaScript modules.'}

## ${tr ? 'Proje yapısı' : 'Project structure'}

\`\`\`
index.html          ${tr ? 'sayfa iskeleti' : 'page markup'}
styles.css          ${tr ? 'tasarım, açık/koyu tema' : 'design system, light/dark'}
src/app.js          ${tr ? 'arayüz ve kalıcı durum' : 'UI wiring and persistence'}
src/logic.js        ${tr ? 'saf fonksiyonlar (test edilir)' : 'pure functions (unit tested)'}
tests/              ${tr ? 'node:test birim testleri' : 'node:test unit tests'}
docs/PLAN.md        ${tr ? 'ürün planı' : 'product plan'}
\`\`\`

## ${tr ? 'Lisans' : 'License'}

MIT © ${new Date().getFullYear()} ${owner}

---
<sub>${tr ? 'Bu repo' : 'This repository was generated with'} [AppNar](https://github.com/topics/appnar)${tr ? ' ile üretildi.' : '.'}</sub>
`;
  await write('README.md', readme);
  await write(
    'LICENSE',
    `MIT License

Copyright (c) ${new Date().getFullYear()} ${owner}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  );
  commit('docs: readme and license', ['README.md', 'LICENSE']);
}

/** Final gate: tests green, files present; copies the site into dist/ for Pages. */
async function phaseVerify() {
  for (const f of ['index.html', 'styles.css', 'src/app.js', 'src/logic.js', 'tests/logic.test.js', 'README.md']) {
    if (!(await readText(f)).trim()) throw new Error(`${f} is missing`);
  }
  const result = runTests();
  if (!result.ok) {
    console.error(tail(result.output, 4000));
    throw new Error('unit tests fail');
  }
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist', { recursive: true });
  for (const f of ['index.html', 'styles.css', 'src']) await cp(f, `dist/${f}`, { recursive: true });
  await writeFile('dist/.nojekyll', '');
  console.log('  site ready in dist/');
}

// ───────────────────────────── entry ─────────────────────────────

export async function main(phase) {
  const spec = await loadSpec();
  const provider = phase === 'verify' ? null : await resolveProvider(spec);
  if (provider) {
    for (const p of [provider, ...(provider.fallbacks ?? [])]) await discoverModels(p);
    const chain = [provider, ...(provider.fallbacks ?? [])].map((p) => `${p.name} (${p.models.join(', ')})`).join(' → ');
    console.log(`AppNar · ${phase} · ${chain}`);
  }
  await mkdir(WORK, { recursive: true });
  switch (phase) {
    case 'plan':
      return phasePlan(provider, spec);
    case 'logic':
      return phaseLogic(provider, spec);
    case 'ui':
      return phaseUi(provider, spec);
    case 'docs':
      return phaseDocs(provider, spec);
    case 'verify':
      return phaseVerify();
    default:
      throw new Error(`unknown phase "${phase}"`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((e) => {
    // Multi-line annotation (GitHub workflow-command escaping) so the whole reason
    // reaches the run summary and AppNar, not just the first line.
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 3000);
    console.error(`::error title=AppNar ${process.argv[2] ?? ''}::${msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
    process.exit(1);
  });
}
