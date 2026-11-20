import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

// Values created inside the vm context have another realm's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------ React stub
function flat(children) {
  return children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
}
function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: flat(children) }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (current) => ({ current }),
    useId: () => ':r1:',
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
}

function load() {
  let definition;
  const window = { __ModuleLoader__: { load(def) { definition = def; } } };
  vm.runInNewContext(source, { window }, { filename: 'client.js' });
  assert.ok(definition, 'client.js must call window.__ModuleLoader__.load');
  const required = [];
  const mod = definition.factory((name) => {
    required.push(name);
    assert.equal(name, 'react', 'client.js may only require react');
    return makeReact();
  });
  return { definition, mod, required };
}

const { definition, mod } = load();

// ------------------------------------------------------------------- fixtures
const catalogValue = {
  default: { provider: 'alpha', model: 'm1' },
  routableProviders: ['alpha', 'beta'],
  groups: [
    {
      id: 'alpha', name: 'Alpha',
      models: [
        { id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
        { id: 'm2', name: 'Model One' },
      ],
    },
    {
      id: 'beta', name: 'Beta',
      models: [{ id: 'b1', name: 'Beta One', reasoning: { efforts: [{ id: 'max', name: 'Max' }] } }],
    },
  ],
  failures: [],
};
const catalog = mod.normalizeCatalog(catalogValue);

function makeForm(name, value, order) {
  let snapshot = { status: 'ready', value, revision: 1, writable: true };
  const listeners = new Set();
  const form = {
    calls: [],
    behavior: undefined,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next) {
      snapshot = { ...snapshot, ...next };
      for (const listener of [...listeners]) listener();
    },
    async mutate(ops, revision) {
      form.calls.push({ ops: plain(ops), revision });
      if (order) order.push(name);
      if (form.behavior) return form.behavior(ops, revision);
      return form.apply(ops);
    },
    apply(ops) {
      const next = { ...snapshot.value };
      for (const op of ops) next[op.path[0]] = op.value;
      form.set({ value: next, revision: snapshot.revision + 1 });
      return true;
    },
  };
  return form;
}

async function setup({ models = {}, coordinatorMode = 'off', auth, catalogResult } = {}) {
  const order = [];
  const modelsForm = makeForm('models', { models, interrupt: true }, order);
  const modeForm = makeForm('mode', { coordinatorMode }, order);
  const authForm = auth === undefined ? undefined : makeForm('auth', auth.value, order);
  if (authForm && auth.status !== 'ready') authForm.set({ status: auth.status });
  const loads = [];
  const controller = mod.createController({
    models: modelsForm,
    mode: modeForm,
    auth: authForm,
    loadCatalog: catalogResult
      ? catalogResult
      : async () => { loads.push(1); return { ok: true, value: catalogValue }; },
  });
  await flush();
  return { controller, modelsForm, modeForm, authForm, order, loads };
}

const saved = {
  designer: { provider: 'alpha', model: 'm1', reasoningEffort: 'high' },
  researcher: { provider: 'beta', model: 'b1' },
};

// ------------------------------------------------------------- loader contract
test('registers one factory with the package id and requires only react', () => {
  const { definition: def, required } = load();
  assert.equal(def.id, 'dsh-specialist-team');
  assert.deepEqual(required, ['react']);
  assert.deepEqual(plain(mod.inject), ['slots', 'locale', 'remote', 'remote.session', 'configForms']);
  assert.equal(typeof mod.apply, 'function');
  assert.equal(definition.id, def.id);
});

test('client.js has no host client imports, JSX runtime or CRLF', () => {
  assert.ok(!source.includes('\r'));
  assert.ok(!/require\(['"]@deepseek-ai/.test(source));
  assert.ok(!/react\/jsx-runtime/.test(source));
});

// ------------------------------------------------------------ catalog -> rows
test('catalog rows keep ids when model names are duplicated', () => {
  const rows = mod.rowsFromCatalog({ designer: { provider: 'alpha', model: 'm1' } }, catalogValue);
  assert.equal(rows.length, 5);
  assert.deepEqual(plain(rows.map((row) => row.role)), ['designer', 'researcher', 'engineer', 'architect', 'verifier']);
  const designer = rows[0];
  assert.deepEqual(plain(designer.providerOptions.map((option) => option.value)), ['alpha', 'beta']);
  assert.deepEqual(plain(designer.modelOptions), [
    { value: 'm1', label: 'Model One (m1)' },
    { value: 'm2', label: 'Model One (m2)' },
  ]);
  assert.deepEqual(plain(rows[1].modelOptions), []);
});

test('effort choices are exactly the efforts the model reports', () => {
  assert.deepEqual(plain(mod.effortChoices(catalog, 'alpha', 'm1').map((choice) => choice.value)), ['low', 'high']);
  assert.deepEqual(plain(mod.effortChoices(catalog, 'alpha', 'm2')), []);
  assert.deepEqual(plain(mod.effortChoices(catalog, 'beta', 'b1').map((choice) => choice.value)), ['max']);
  assert.deepEqual(plain(mod.effortChoices(catalog, 'ghost', 'x')), []);
});

test('omitting the default effort removes the key and never writes an empty string', () => {
  let map = { designer: { provider: 'alpha', model: 'm1' } };
  map = mod.setEffort(map, 'designer', 'high', catalog);
  assert.equal(map.designer.reasoningEffort, 'high');
  map = mod.setEffort(map, 'designer', '', catalog);
  const value = plain(mod.buildModelsValue(map));
  assert.deepEqual(value, { designer: { provider: 'alpha', model: 'm1' } });
  assert.ok(!('reasoningEffort' in value.designer));
  assert.equal(mod.setEffort(map, 'designer', 'bogus', catalog).designer.reasoningEffort, undefined);
});

test('changing provider clears model and effort; changing model drops an unsupported effort', () => {
  const map = { designer: { provider: 'alpha', model: 'm1', reasoningEffort: 'high' } };
  const provider = mod.setProvider(map, 'designer', 'beta');
  assert.deepEqual(plain(provider.designer), { provider: 'beta', model: '' });
  assert.equal(mod.rowsFromCatalog(provider, catalogValue)[0].incomplete, true);
  assert.deepEqual(plain(mod.buildModelsValue(provider)), {});
  assert.deepEqual(plain(mod.setModel(provider, 'designer', 'b1', catalog).designer), { provider: 'beta', model: 'b1' });
  assert.deepEqual(plain(mod.setModel(map, 'designer', 'm2', catalog).designer), { provider: 'alpha', model: 'm2' });
  assert.equal(mod.setModel(map, 'designer', 'm1', catalog).designer.reasoningEffort, 'high');
  assert.equal(mod.setProvider(map, 'designer', '').designer, undefined);
  assert.deepEqual(plain(mod.setProvider(map, 'designer', 'alpha')), plain(map));
});

test('an unknown saved route stays visible as a disabled option with a warning flag', () => {
  const row = mod.describeRow('designer', { provider: 'gone', model: 'x', reasoningEffort: '' }, catalog, true, undefined);
  assert.equal(row.unknownRoute, true);
  assert.deepEqual(plain(row.providerOptions.at(-1)), { value: 'gone', label: 'gone', disabled: true, missing: true });
  assert.deepEqual(plain(row.modelOptions), [{ value: 'x', label: 'x', disabled: true, missing: true }]);
  const known = mod.describeRow('designer', { provider: 'alpha', model: 'm1', reasoningEffort: '' }, catalog, true, undefined);
  assert.equal(known.unknownRoute, false);
});

test('an unknown saved effort is never offered as a choice', () => {
  const row = mod.describeRow('designer', { provider: 'alpha', model: 'm1', reasoningEffort: 'turbo' }, catalog, true, undefined);
  assert.deepEqual(plain(row.effortOptions.map((option) => option.value)), ['low', 'high']);
  assert.equal(row.effortMissing, true);
  assert.equal(row.effortNote, 'unsupported');
  const noReasoning = mod.describeRow('designer', { provider: 'alpha', model: 'm2', reasoningEffort: 'turbo' }, catalog, true, undefined);
  assert.deepEqual(plain(noReasoning.effortOptions), []);
  assert.equal(noReasoning.effortNote, 'saved');
});

// ---------------------------------------------------------------- authorization
test('authorization compares exact [provider, model] pairs', () => {
  const ready = (value) => ({ status: 'ready', value });
  const allowed = ready({ enabled: true, allowedModels: [{ provider: 'a/b', model: 'c' }, { provider: 'alpha', model: 'm1' }] });
  assert.equal(mod.authorizationStatus(allowed, 'alpha', 'm1'), 'allowed');
  assert.equal(mod.authorizationStatus(allowed, 'a', 'b/c'), 'notAllowed');
  assert.equal(mod.authorizationStatus(allowed, 'a/b', 'c'), 'allowed');
  assert.equal(mod.authorizationStatus(ready({ enabled: false, allowedModels: [] }), 'alpha', 'm1'), 'disabled');
  assert.equal(mod.authorizationStatus({ status: 'unavailable' }, 'alpha', 'm1'), 'unknown');
  assert.equal(mod.authorizationStatus(undefined, 'alpha', 'm1'), 'unknown');
  assert.equal(mod.authorizationStatus(ready({ enabled: true }), 'alpha', 'm1'), 'unknown');
});

test('authorization problems only warn and never block autosave', async () => {
  const { controller, modelsForm } = await setup({
    models: saved,
    auth: { status: 'ready', value: { enabled: true, allowedModels: [] } },
  });
  const rows = controller.getState().models.rows;
  assert.equal(rows[0].auth, 'notAllowed');
  controller.clear('researcher');
  await flush();
  assert.equal(modelsForm.calls.length, 1);
  assert.equal(modelsForm.getSnapshot().value.models.researcher, undefined);
  assert.equal(controller.getState().models.rows[1].error, null);
  controller.dispose();
});

test('unreadable or disabled authorization yields a section notice, not a block', async () => {
  const unknown = await setup({ models: saved, auth: { status: 'unavailable' } });
  assert.equal(unknown.controller.getState().models.authNotice, 'unknown');
  const disabled = await setup({ models: saved, auth: { status: 'ready', value: { enabled: false, allowedModels: [] } } });
  assert.equal(disabled.controller.getState().models.authNotice, 'disabled');
  unknown.controller.dispose();
  disabled.controller.dispose();
});

// --------------------------------------------------------------- autosave
const row = (controller, role) => controller.getState().models.rows.find((item) => item.role === role);

function deferWrites(form) {
  const pending = [];
  form.behavior = (ops) => new Promise((resolve) => {
    pending.push({ land: () => resolve(form.apply(ops)), resolve });
  });
  return pending;
}

test('Clear immediately writes the complete sparse map and can remove the final route', async () => {
  const { controller, modelsForm, modeForm } = await setup({ models: saved });
  controller.clear('designer');
  assert.deepEqual(modelsForm.calls[0].ops, [
    { op: 'set', path: ['models'], value: { researcher: saved.researcher } },
  ]);
  await flush();
  controller.clear('researcher');
  assert.deepEqual(modelsForm.calls[1].ops, [{ op: 'set', path: ['models'], value: {} }]);
  await flush();
  assert.equal(modelsForm.getSnapshot().value.interrupt, true);
  assert.equal(modeForm.calls.length, 0);
  assert.equal(row(controller, 'designer').provider, '');
  assert.equal(row(controller, 'researcher').error, null);
  controller.dispose();
});

test('no-op model and mode edits do not write', async () => {
  const { controller, modelsForm, modeForm } = await setup({ models: saved });
  controller.setProvider('designer', 'alpha');
  controller.clear('engineer');
  await controller.setMode('off');
  assert.equal(modelsForm.calls.length, 0);
  assert.equal(modeForm.calls.length, 0);
  controller.dispose();
});

test('a complete route and each effort edit autosave immediately', async () => {
  const { controller, modelsForm } = await setup();
  controller.setProvider('engineer', 'alpha');
  assert.equal(row(controller, 'engineer').incomplete, true);
  assert.equal(modelsForm.calls.length, 0);
  controller.setModel('engineer', 'm1');
  assert.deepEqual(modelsForm.calls[0], {
    ops: [{ op: 'set', path: ['models'], value: { engineer: { provider: 'alpha', model: 'm1' } } }], revision: 1,
  });
  await flush();
  controller.setEffort('engineer', 'high');
  assert.deepEqual(modelsForm.calls[1].ops[0].value.engineer, { provider: 'alpha', model: 'm1', reasoningEffort: 'high' });
  await flush();
  controller.setEffort('engineer', '');
  assert.deepEqual(modelsForm.calls[2].ops[0].value.engineer, { provider: 'alpha', model: 'm1' });
  await flush();
  assert.equal(row(controller, 'engineer').error, null);
  controller.dispose();
});

test('an incomplete provider keeps the live route and does not block other rows or mode', async () => {
  const { controller, modelsForm, modeForm } = await setup({ models: saved });
  modelsForm.set({ revision: 7 });
  modeForm.set({ revision: 3 });
  controller.setProvider('designer', 'beta');
  assert.equal(row(controller, 'designer').provider, 'beta');
  assert.equal(row(controller, 'designer').incomplete, true);
  assert.equal(modelsForm.calls.length, 0);
  controller.clear('researcher');
  assert.deepEqual(modelsForm.calls[0], { ops: [{ op: 'set', path: ['models'], value: { designer: saved.designer } }], revision: 7 });
  await controller.setMode('full-power');
  assert.deepEqual(modeForm.calls[0], { ops: [{ op: 'set', path: ['coordinatorMode'], value: 'full-power' }], revision: 3 });
  assert.equal(controller.getState().mode.value, 'full-power');
  assert.equal(row(controller, 'designer').incomplete, true);
  assert.deepEqual(plain(modelsForm.getSnapshot().value.models), { designer: saved.designer });
  controller.setModel('designer', 'b1');
  assert.deepEqual(modelsForm.calls[1], {
    ops: [{ op: 'set', path: ['models'], value: { designer: { provider: 'beta', model: 'b1' } } }], revision: 8,
  });
  await flush();
  assert.equal(row(controller, 'designer').incomplete, false);
  controller.dispose();
});

test('clearing an incomplete provider also clears that role’s previous live route', async () => {
  const { controller, modelsForm } = await setup({ models: saved });
  controller.setProvider('designer', 'beta');
  controller.setProvider('designer', '');
  assert.deepEqual(modelsForm.calls[0].ops[0].value, { researcher: saved.researcher });
  await flush();
  assert.equal(row(controller, 'designer').provider, '');
  controller.dispose();
});

test('model writes serialize and merge the next row into the latest revision; mode does not wait', async () => {
  const { controller, modelsForm, modeForm } = await setup({ models: saved });
  const pending = deferWrites(modelsForm);
  controller.clear('designer');
  controller.setEffort('researcher', 'max');
  assert.equal(modelsForm.calls.length, 1);
  assert.equal(row(controller, 'designer').pending, true);
  assert.equal(row(controller, 'researcher').pending, true);
  await controller.setMode('full-power');
  assert.equal(modeForm.calls.length, 1);
  pending[0].land();
  const verifier = { provider: 'alpha', model: 'm2' };
  modelsForm.set({ revision: 9, value: { models: { researcher: saved.researcher, verifier } } });
  await flush();
  assert.deepEqual(modelsForm.calls[1], {
    ops: [{ op: 'set', path: ['models'], value: { researcher: { ...saved.researcher, reasoningEffort: 'max' }, verifier } }],
    revision: 9,
  });
  pending[1].land();
  await flush();
  assert.equal(row(controller, 'designer').pending, false);
  assert.equal(row(controller, 'researcher').effort, 'max');
  assert.equal(row(controller, 'verifier').model, 'm2');
  controller.dispose();
});

test('an external change to a queued row is not overwritten', async () => {
  const { controller, modelsForm } = await setup({ models: saved });
  const pending = deferWrites(modelsForm);
  controller.clear('designer');
  controller.setEffort('researcher', 'max');
  pending[0].land();
  modelsForm.set({ revision: 6, value: { models: { researcher: { provider: 'alpha', model: 'm2' } } } });
  await flush();
  assert.equal(modelsForm.calls.length, 1);
  assert.equal(row(controller, 'researcher').error, 'conflict');
  assert.equal(row(controller, 'researcher').model, 'm2');
  assert.equal(row(controller, 'designer').error, null);
  controller.dispose();
});

test('completing an incomplete selection does not overwrite a hidden external change to its row', async () => {
  const { controller, modelsForm } = await setup({ models: saved });
  controller.setProvider('designer', 'beta');
  modelsForm.set({ revision: 2, value: { models: { ...saved, designer: { provider: 'alpha', model: 'm2' } } } });
  controller.setModel('designer', 'b1');
  assert.equal(modelsForm.calls.length, 0);
  assert.equal(row(controller, 'designer').error, 'conflict');
  assert.equal(row(controller, 'designer').model, 'm2');
  controller.dispose();
});

test('a refused row restores the actual route without stopping the next row or mode', async () => {
  const { controller, modelsForm, modeForm } = await setup({ models: saved });
  const pending = deferWrites(modelsForm);
  controller.clear('designer');
  controller.clear('researcher');
  await controller.setMode('full-power');
  pending[0].resolve(false);
  await flush();
  assert.equal(modeForm.calls.length, 1);
  assert.equal(row(controller, 'designer').error, 'saveFailed');
  assert.equal(row(controller, 'designer').pending, false);
  assert.equal(row(controller, 'designer').provider, 'alpha');
  assert.equal(row(controller, 'designer').effort, 'high');
  assert.equal(row(controller, 'researcher').error, null);
  assert.deepEqual(modelsForm.calls[1].ops[0].value, { designer: saved.designer });
  pending[1].land();
  await flush();
  assert.equal(row(controller, 'researcher').provider, '');
  assert.equal(row(controller, 'designer').error, 'saveFailed');
  controller.dispose();
});

test('a refused write after revision moves shows the latest actual route and a conflict', async () => {
  const { controller, modelsForm } = await setup({ models: saved });
  modelsForm.behavior = async () => {
    modelsForm.set({ revision: 5, value: { models: { ...saved, designer: { provider: 'beta', model: 'b1' } } } });
    return false;
  };
  controller.clear('designer');
  await flush();
  assert.equal(modelsForm.calls[0].revision, 1);
  assert.equal(row(controller, 'designer').error, 'conflict');
  assert.equal(row(controller, 'designer').provider, 'beta');
  controller.dispose();
});

test('an acknowledged write must still be confirmed by the snapshot', async () => {
  const { controller, modelsForm } = await setup({ models: saved });
  modelsForm.behavior = async () => true;
  controller.clear('designer');
  await flush();
  assert.equal(row(controller, 'designer').error, 'saveFailed');
  assert.equal(row(controller, 'designer').provider, 'alpha');
  controller.dispose();
});

test('when the attempted value is already live, the row has no error', async () => {
  const { controller, modelsForm } = await setup({ models: saved });
  modelsForm.behavior = async (ops) => {
    modelsForm.apply(ops);
    return false;
  };
  controller.clear('designer');
  await flush();
  assert.equal(row(controller, 'designer').provider, '');
  assert.equal(row(controller, 'designer').error, null);
  controller.dispose();
});

test('mode stays at its confirmed value during a write, and rejection does not stop row saves', async () => {
  const { controller, modelsForm, modeForm } = await setup({ models: saved, coordinatorMode: 'strict' }); // legacy saved value reads as full-power
  const pending = deferWrites(modeForm);
  const attempt = controller.setMode('off');
  assert.equal(modeForm.calls.length, 1);
  assert.equal(controller.getState().mode.pending, true);
  assert.equal(controller.getState().mode.value, 'full-power');
  controller.clear('designer');
  assert.equal(modelsForm.calls.length, 1);
  pending[0].resolve(false);
  await attempt;
  assert.equal(controller.getState().mode.pending, false);
  assert.equal(controller.getState().mode.value, 'full-power');
  assert.equal(controller.getState().mode.error, 'saveFailed');
  const retry = controller.setMode('off');
  pending[1].land();
  await retry;
  assert.equal(controller.getState().mode.value, 'off');
  assert.equal(controller.getState().mode.error, null);
  controller.dispose();
});

test('read-only and unavailable sections cannot be edited', async () => {
  const { controller, modelsForm, modeForm } = await setup({ models: saved });
  modeForm.set({ status: 'unavailable', value: undefined });
  assert.equal(controller.getState().mode.available, false);
  await controller.setMode('full-power');
  modelsForm.set({ writable: false });
  controller.clear('designer');
  assert.equal(modeForm.calls.length, 0);
  assert.equal(modelsForm.calls.length, 0);
  assert.equal(row(controller, 'designer').provider, 'alpha');
  controller.dispose();
});

// -------------------------------------------------------- late results / reset
for (const reset of [false, true]) {
  test(`unmount ${reset ? 'cancels queued changes on disconnect' : 'finishes queued changes'}`, async () => {
    const { controller, modelsForm } = await setup({ models: saved });
    const pending = deferWrites(modelsForm);
    controller.clear('designer');
    controller.clear('researcher');
    controller.dispose();
    if (reset) controller.resetConnection();
    pending[0].land();
    await flush();
    assert.equal(modelsForm.calls.length, reset ? 1 : 2);
    if (!reset) {
      pending[1].land();
      await flush();
      assert.deepEqual(plain(modelsForm.getSnapshot().value.models), {});
    }
  });
}

test('late save results are ignored after dispose', async () => {
  const { controller, modelsForm } = await setup({ models: saved });
  let release;
  modelsForm.behavior = (ops) => new Promise((resolve) => { release = () => resolve(modelsForm.apply(ops)); });
  controller.clear('designer');
  assert.equal(row(controller, 'designer').pending, true);
  let notified = 0;
  controller.subscribe(() => { notified += 1; });
  controller.dispose();
  release();
  await flush();
  assert.equal(notified, 0);
});

test('a connection reset drops the draft and ignores the late save result', async () => {
  const { controller, modelsForm } = await setup({ models: saved });
  let release;
  modelsForm.behavior = (ops) => new Promise((resolve) => { release = () => resolve(modelsForm.apply(ops)); });
  controller.clear('designer');
  assert.equal(row(controller, 'designer').pending, true);
  controller.resetConnection();
  assert.equal(row(controller, 'designer').pending, false);
  assert.equal(row(controller, 'designer').provider, 'alpha');
  release();
  await flush();
  assert.equal(row(controller, 'designer').error, null);
  assert.equal(row(controller, 'designer').pending, false);
  controller.dispose();
});

test('adapter invalidations during a catalog load are coalesced into one follow-up', async () => {
  const pending = [];
  const { controller } = await setup({
    catalogResult: () => new Promise((resolve) => { pending.push(resolve); }),
  });
  controller.refreshCatalog();
  controller.refreshCatalog();
  assert.equal(pending.length, 1);
  pending[0]({ ok: true, value: catalogValue });
  await flush();
  assert.equal(pending.length, 2);
  assert.equal(controller.getState().catalog.status, 'loading');
  const small = { groups: [{ id: 'only', name: 'Only', models: [{ id: 'o1', name: 'O' }] }], failures: [] };
  pending[1]({ ok: true, value: small });
  await flush();
  assert.equal(pending.length, 2);
  assert.deepEqual(plain(row(controller, 'designer').providerOptions.map((option) => option.value)), ['only']);
  controller.dispose();
});

test('a catalog response from before a connection reset is ignored', async () => {
  const pending = [];
  const { controller } = await setup({
    models: saved,
    catalogResult: () => new Promise((resolve) => { pending.push(resolve); }),
  });
  assert.equal(controller.getState().catalog.status, 'loading');
  controller.resetConnection();
  assert.equal(pending.length, 2);
  const small = { groups: [{ id: 'only', name: 'Only', models: [{ id: 'o1', name: 'O' }] }], failures: [] };
  pending[1]({ ok: true, value: small });
  await flush();
  pending[0]({ ok: true, value: catalogValue });
  await flush();
  assert.deepEqual(plain(controller.getState().models.rows[2].providerOptions.map((option) => option.value)), ['only']);
  controller.dispose();
});

test('a catalog response after dispose is ignored', async () => {
  const pending = [];
  const { controller } = await setup({ catalogResult: () => new Promise((resolve) => { pending.push(resolve); }) });
  let notified = 0;
  controller.subscribe(() => { notified += 1; });
  controller.dispose();
  pending[0]({ ok: true, value: catalogValue });
  await flush();
  assert.equal(notified, 0);
});

test('catalog failure disables pickers, allows Retry and keeps Clear working', async () => {
  let ok = false;
  const { controller, modelsForm } = await setup({
    models: saved,
    catalogResult: async () => (ok ? { ok: true, value: catalogValue } : { ok: false }),
  });
  assert.equal(controller.getState().catalog.status, 'error');
  controller.setProvider('engineer', 'alpha');
  assert.equal(modelsForm.calls.length, 0);
  controller.clear('designer');
  await flush();
  assert.equal(row(controller, 'designer').provider, '');
  ok = true;
  await controller.retryCatalog();
  assert.equal(controller.getState().catalog.status, 'ready');
  controller.setProvider('engineer', 'alpha');
  assert.equal(row(controller, 'engineer').incomplete, true);
  assert.equal(modelsForm.calls.length, 1);
  controller.dispose();
});

test('hub forwards invalidations to open controllers only', async () => {
  const hub = mod.createHub();
  const loads = [];
  const modelsForm = makeForm('models', { models: {} });
  const modeForm = makeForm('mode', { coordinatorMode: 'off' });
  const controller = mod.createController({
    models: modelsForm, mode: modeForm, hub,
    loadCatalog: async () => { loads.push(1); return { ok: true, value: catalogValue }; },
  });
  await flush();
  assert.equal(loads.length, 1);
  hub.refresh();
  await flush();
  assert.equal(loads.length, 2);
  hub.reset();
  await flush();
  assert.equal(loads.length, 3);
  controller.dispose();
  hub.refresh();
  hub.reset();
  await flush();
  assert.equal(loads.length, 3);
});

// ------------------------------------------------------------------ apply(ctx)
test('model and mode changes sharing dsh-team save against fresh revisions', async () => {
  const form = makeForm('dsh-team', { models: { researcher: { provider: 'alpha', model: 'm1' } }, coordinatorMode: 'off' });
  const controller = mod.createController({ models: form, mode: form, loadCatalog: async () => ({ ok: true, value: catalogValue }) });
  let release;
  const first = new Promise(resolve => { release = resolve; });
  form.behavior = async (ops, revision) => {
    if (form.calls.length === 1) await first;
    assert.equal(revision, form.getSnapshot().revision);
    return form.apply(ops);
  };
  controller.clear('researcher');
  const modeChange = controller.setMode('full-power');
  assert.equal(form.calls.length, 1);
  release();
  await modeChange;
  assert.deepEqual(form.calls.map(call => call.revision), [1, 2]);
  assert.deepEqual(plain(form.getSnapshot().value), { models: {}, coordinatorMode: 'full-power' });
  controller.dispose();
});

test('only the bundle registers a settings entry', () => {
  const forms = {};
  const events = {};
  const registered = [];
  const dictionaries = [];
  let served;
  let owner;
  const ctx = {
    effect(fn) { return fn(); },
    locale: { register(ns, dicts) { dictionaries.push({ ns, dicts }); return () => {}; } },
    remote: {
      $on(name, fn) { events[name] = fn; return () => {}; },
      session: { modelCatalog: async () => ({ ok: true, value: catalogValue }) },
    },
    on(name, fn) { events[name] = fn; return () => {}; },
    configForms: {
      get(ns) { return forms[ns] ?? (forms[ns] = makeForm(ns, {})); },
      whileServed(namespaces, register) { served = namespaces; return register(new Set(namespaces)); },
    },
    slots: {
      inject(name, callback) { owner = name; return callback(); },
      register(options, component) { registered.push({ options, component }); return () => {}; },
    },
  };
  mod.apply(ctx);
  assert.equal(dictionaries[0].ns, 'specialistTeam.settings');
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh']);
  assert.deepEqual(plain(served), ['dsh-team']);
  assert.equal(owner, 'plugins.bundle.config');
  assert.equal(registered.length, 1);
  const bundle = registered.find(item => item.options.name === 'plugins.bundle.config');
  assert.equal(bundle.options.key, 'dsh-specialist-team');
  const card = bundle.component({ view: 'page', t: key => mod.dictionaries.zh[key] });
  assert.equal(card.type, 'details');
  assert.deepEqual(card.children.map(child => child.type), ['summary', 'style']);
  assert.equal(card.children[0].type, 'summary');
  assert.equal(card.children[0].children[0].children[0], '专家模型设置');
  assert.equal(bundle.options.locale, 'specialistTeam.settings');
  assert.deepEqual(Object.keys(events).sort(), ['connection/reset', 'llm/adapters-updated']);
  events['llm/adapters-updated']();
  events['connection/reset']();
});

// ------------------------------------------------------------------- rendering
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
  return { ...node, children: node.children.map(expand) };
}
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, predicate, found)); return found; }
  if (predicate(node)) found.push(node);
  node.children.forEach((child) => findAll(child, predicate, found));
  return found;
}
function translator(lang) {
  return (key, params) => String(mod.dictionaries[lang][key] ?? key).replace(/\{(\w+)\}/g, (_m, name) => params?.[name] ?? `{${name}}`);
}

test('the page renders labelled controls and an autosaving switch without Save/Discard', async () => {
  const { controller } = await setup({ models: saved });
  const render = (lang) => expand(mod.PageBody({ t: translator(lang), controller }));
  let tree = render('en');
  const selects = findAll(tree, (node) => node.type === 'select');
  assert.equal(selects.length, 15);
  assert.ok(selects.every((node) => typeof node.props['aria-label'] === 'string' && node.props['aria-label'].length > 0));
  assert.equal(selects[0].props['aria-label'], 'Designer: Provider');
  assert.equal(selects[0].props.value, 'alpha');
  const zh = findAll(render('zh'), (node) => node.type === 'select');
  assert.equal(zh[0].props['aria-label'], '设计师：提供方');
  const switches = findAll(tree, (node) => node.props.role === 'switch');
  assert.equal(switches.length, 1);
  assert.equal(switches[0].props['aria-checked'], false);
  assert.ok(switches[0].props['aria-labelledby'] && switches[0].props['aria-describedby']);
  const button = (name) => findAll(tree, (node) => node.type === 'button' && node.children.includes(name))[0];
  assert.equal(button('Save'), undefined);
  assert.equal(button('Discard'), undefined);
  await controller.setMode('full-power');
  tree = render('en');
  assert.equal(findAll(tree, (node) => node.props.role === 'switch')[0].props['aria-checked'], true);
  assert.equal(button('Save'), undefined);
  assert.equal(button('Discard'), undefined);
  const style = findAll(tree, (node) => node.type === 'style');
  assert.equal(style.length, 1);
  controller.dispose();
});

test('effort picker is disabled for models without reasoning efforts and incomplete rows', async () => {
  const { controller } = await setup({ models: { designer: { provider: 'alpha', model: 'm2' } } });
  controller.setProvider('engineer', 'beta');
  const tree = expand(mod.PageBody({ t: translator('en'), controller }));
  const byLabel = (label) => findAll(tree, (node) => node.type === 'select' && node.props['aria-label'] === label)[0];
  assert.equal(byLabel('Designer: Reasoning effort').props.disabled, true);
  assert.equal(byLabel('Engineer: Reasoning effort').props.disabled, true);
  assert.equal(byLabel('Engineer: Model').props.disabled, false);
  assert.equal(byLabel('Researcher: Model').props.disabled, true);
  controller.dispose();
});

test('a saved effort can be cleared without clearing a model that no longer supports it', async () => {
  const { controller, modelsForm } = await setup({ models: { designer: { provider: 'alpha', model: 'm2', reasoningEffort: 'high' } } });
  const effortPicker = () => findAll(expand(mod.PageBody({ t: translator('en'), controller })),
    node => node.type === 'select' && node.props['aria-label'] === 'Designer: Reasoning effort')[0];
  assert.equal(effortPicker().props.value, 'high');
  assert.equal(effortPicker().props.disabled, false);
  effortPicker().props.onChange({ target: { value: '' } });
  await flush();
  assert.deepEqual(plain(modelsForm.getSnapshot().value.models), { designer: { provider: 'alpha', model: 'm2' } });
  assert.equal(effortPicker().props.disabled, true);
  controller.dispose();
});

test('a missing namespace disables only its own section', async () => {
  const { controller, modeForm } = await setup({ models: saved });
  modeForm.set({ status: 'unavailable', value: undefined });
  const tree = expand(mod.PageBody({ t: translator('en'), controller }));
  assert.equal(findAll(tree, (node) => node.props.role === 'switch').length, 0);
  assert.equal(findAll(tree, (node) => node.type === 'select').length, 15);
  assert.ok(findAll(tree, (node) => node.children.includes(mod.dictionaries.en.unavailable)).length > 0);
  controller.dispose();
});

// ------------------------------------------------------- strings, manifest
test('en and zh dictionaries have identical keys and placeholders', () => {
  const { en, zh } = mod.dictionaries;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en.${key}`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh.${key}`);
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), key);
  }
  for (const role of mod.ROLES) assert.ok(`role.${role}` in en);
});

test('every string key used by client.js exists in both dictionaries', () => {
  const keys = new Set([...source.matchAll(/\bt\('([A-Za-z.]+)'/g)].map((match) => match[1]).filter((key) => !key.endsWith('.')));
  for (const key of ['saveFailed', 'conflict', 'provider', 'model', 'effort', 'clear']) keys.add(key);
  for (const key of keys) {
    assert.ok(key in mod.dictionaries.en, `en.${key}`);
    assert.ok(key in mod.dictionaries.zh, `zh.${key}`);
  }
});

test('package.json exposes the browser half and keeps the existing manifest', () => {
  const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.ok(!raw.includes('\r'));
  const pkg = JSON.parse(raw);
  assert.equal(pkg.exports['./client'], './client.js');
  for (const key of ['.', './package.json', './locale/*.json']) assert.ok(key in pkg.exports, key);
  assert.ok(!('./team' in pkg.exports));
  assert.ok(!('./tools' in pkg.exports));
  assert.ok(!pkg.files.includes('vendor'));
  assert.ok(pkg.files.includes('client.js'));
  for (const entry of ['src', 'locale/*.json', 'docs', 'cordis.patch.yml']) assert.ok(pkg.files.includes(entry), entry);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
    '@deepseek-ai/dsh-api-remotes',
  ]);
  assert.equal(pkg.name, definition.id);
  assert.equal(pkg.scripts.test, 'node --test test/*.test.mjs');
  assert.ok(fs.existsSync(path.join(root, pkg.exports['./client'])));
});

test('locale files keep their meta', () => {
  for (const lang of ['en', 'zh']) {
    const json = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${lang}.json`), 'utf8'));
    assert.equal(typeof json.meta.title, 'string');
    assert.equal(typeof json.meta.description, 'string');
  }
});
