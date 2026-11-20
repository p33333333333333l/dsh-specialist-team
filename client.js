// Browser half of dsh-specialist-team: the "Specialist models" configuration page.
// Plain JavaScript on purpose (React.createElement, no JSX, no bundler). The
// factory result carries the pure helpers and autosave controller so
// tests can drive them without a browser.
window.__ModuleLoader__.load({
  id: 'dsh-specialist-team',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------- constants
    const NS = 'specialistTeam.settings';
    const MODELS_NS = 'dsh-team';
    const MODE_NS = MODELS_NS;
    const AUTH_NS = 'subagent-model-selection-settings';
    const ROLES = ['designer', 'researcher', 'engineer', 'architect', 'verifier'];
    const SERVICES = ['slots', 'locale', 'remote', 'remote.session', 'configForms'];

    // ------------------------------------------------------------------ strings
    const en = {
      settingsTitle: 'Specialist model settings',
      title: 'Specialist models',
      summary: 'Choose a model route for each specialist role and switch full-power mode.',
      modelsIntro: 'Without a role preference or an explicit model choice, specialists use the Lead model. Changes apply to new specialists.',
      provider: 'Provider',
      model: 'Model',
      effort: 'Reasoning effort',
      inherit: 'No preference (inherit Lead)',
      selectModel: 'Select a model',
      defaultEffort: 'No effort preference',
      clear: 'Clear',
      coordinator: 'Full-power mode',
      coordinatorHelp: 'Off (default): the Lead can work directly and call specialists as needed. On: the Lead only splits and dispatches work, group coordinators keep specialists busy, and questions go to the direct superior first. Subagent depth rises to 3 and running subagents to 100 while on. More specialists at once means higher model costs.',
      saving: 'Saving…',
      conflict: 'Settings changed elsewhere. Review the current value and try again.',
      saveFailed: 'Could not save this change. The current value is shown.',
      incompleteRow: 'Choose a model, or clear this row.',
      loading: 'Loading models…',
      loadFailed: 'Models could not be loaded.',
      retry: 'Retry',
      catalogPartial: 'Some model providers could not be loaded; their saved routes can show as unavailable.',
      catalogEmpty: 'The current catalog lists no models.',
      catalogWarning: 'This route is not currently advertised.',
      unavailableOption: 'not currently advertised',
      authWarning: 'This route is not in the current authorized list; existing sessions can have a different list.',
      authDisabled: 'Model selection for subagents is turned off in Subagent settings, so a specialist route may be rejected. Existing sessions can differ.',
      authorizationUnknown: 'The authorized model list cannot be read, so authorization cannot be verified.',
      unavailable: 'This setting is not available because its plugin entry is not loaded.',
      readOnly: 'This deployment stores settings read-only.',
      loadingSettings: 'Loading settings…',
      fieldFor: '{role}: {field}',
      effortUnsupported: 'Saved reasoning effort “{effort}” is not listed for this provider and model.',
      effortSaved: 'Saved reasoning effort: {effort}',
      'role.designer': 'Designer',
      'role.researcher': 'Researcher',
      'role.engineer': 'Engineer',
      'role.architect': 'Architect',
      'role.verifier': 'Verifier',
      'duty.designer': 'Designs layouts and interactions.',
      'duty.researcher': 'Finds sources and checks evidence.',
      'duty.engineer': 'Implements features and writes tests.',
      'duty.architect': 'Diagnoses problems and weighs design options.',
      'duty.verifier': 'Runs independent checks and reports defects.',
    };
    const zh = {
      settingsTitle: '专家模型设置',
      title: '专用模型',
      summary: '选择各专家的模型和推理强度，或切换火力全开模式。',
      modelsIntro: '未设角色偏好且派工时未指定模型时，沿用主代理模型。修改仅对新启动的专家生效。',
      provider: '提供方',
      model: '模型',
      effort: '推理强度',
      inherit: '无偏好（继承 Lead）',
      selectModel: '选择模型',
      defaultEffort: '不指定推理强度',
      clear: '清除',
      coordinator: '火力全开模式',
      coordinatorHelp: '关闭（默认）：按需派工，主代理可以自己处理任务。开启：主代理只拆分和派发任务，组长让专家同时工作，有问题先问直属上级。开启期间子代理深度提高到 3、同时运行的子代理提高到 100。同时运行的专家更多，模型费用也更高。',
      saving: '保存中…',
      conflict: '设置已在其他位置更新，请查看当前值后重试。',
      saveFailed: '无法保存此次修改，当前显示的是实际设置。',
      incompleteRow: '请选择模型，或清除此行。',
      loading: '正在加载模型…',
      loadFailed: '无法加载模型。',
      retry: '重试',
      catalogPartial: '部分模型提供方暂时无法加载，已保存的路由可能显示为不可用。',
      catalogEmpty: '当前目录未列出模型。',
      catalogWarning: '此路由当前未在模型目录中公布。',
      unavailableOption: '当前未公布',
      authWarning: '此路由不在当前授权列表中；已有会话可能使用不同列表。',
      authDisabled: '子智能体设置中已关闭模型选择，专家使用的路由可能被拒绝；已有会话可能不同。',
      authorizationUnknown: '无法读取授权模型列表，因此无法核实授权。',
      unavailable: '该设置当前不可用，因为对应的插件条目未加载。',
      readOnly: '本部署的设置为只读。',
      loadingSettings: '正在加载设置…',
      fieldFor: '{role}：{field}',
      effortUnsupported: '当前提供方未为此模型列出已保存的推理强度“{effort}”。',
      effortSaved: '已保存的推理强度：{effort}',
      'role.designer': '设计师',
      'role.researcher': '研究员',
      'role.engineer': '工程师',
      'role.architect': '架构师',
      'role.verifier': '验收员',
      'duty.designer': '设计界面布局与交互',
      'duty.researcher': '查找资料，核对证据',
      'duty.engineer': '实现功能，编写测试',
      'duty.architect': '诊断问题，权衡技术方案',
      'duty.verifier': '独立验收，报告缺陷',
    };
    const dictionaries = { en, zh };

    // ------------------------------------------------------------ pure helpers
    function isObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
    function isText(value) {
      return typeof value === 'string' && value.length > 0;
    }

    /** Give each item a display label; duplicate or empty names fall back to name (id). */
    function labelItems(items) {
      const counts = new Map();
      for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + 1);
      return items.map((item) => ({
        ...item,
        label: !item.name || item.name === item.id ? item.id
          : counts.get(item.name) === 1 ? item.name : item.name + ' (' + item.id + ')',
      }));
    }

    /** Normalize a modelCatalog() value into providers > models > efforts, keeping ids exact. */
    function normalizeCatalog(value) {
      const groups = isObject(value) && Array.isArray(value.groups) ? value.groups : [];
      const providers = [];
      const seen = new Set();
      for (const group of groups) {
        if (!isObject(group) || !isText(group.id) || seen.has(group.id)) continue;
        seen.add(group.id);
        const models = [];
        const modelIds = new Set();
        for (const model of Array.isArray(group.models) ? group.models : []) {
          if (!isObject(model) || !isText(model.id) || modelIds.has(model.id)) continue;
          modelIds.add(model.id);
          const efforts = [];
          const rawEfforts = isObject(model.reasoning) && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [];
          for (const effort of rawEfforts) {
            if (!isObject(effort) || !isText(effort.id) || efforts.some((entry) => entry.id === effort.id)) continue;
            efforts.push({
              id: effort.id,
              name: isText(effort.name) ? effort.name : effort.id,
              description: typeof effort.description === 'string' ? effort.description : undefined,
            });
          }
          models.push({ id: model.id, name: isText(model.name) ? model.name : model.id, efforts: labelItems(efforts) });
        }
        providers.push({ id: group.id, name: isText(group.name) ? group.name : group.id, models: labelItems(models) });
      }
      return {
        providers: labelItems(providers),
        partial: isObject(value) && Array.isArray(value.failures) && value.failures.length > 0,
      };
    }

    const EMPTY_CATALOG = { providers: [], partial: false };

    function findProvider(catalog, provider) {
      return catalog.providers.find((entry) => entry.id === provider);
    }
    function findModel(catalog, provider, model) {
      const entry = findProvider(catalog, provider);
      return entry === undefined ? undefined : entry.models.find((candidate) => candidate.id === model);
    }
    /** Exactly the efforts the model reports; none when the model has no reasoning block. */
    function effortChoices(catalog, provider, model) {
      const entry = findModel(catalog, provider, model);
      return entry === undefined ? [] : entry.efforts.map((effort) => ({ value: effort.id, label: effort.label, description: effort.description }));
    }
    function effortSupported(catalog, provider, model, effort) {
      return effortChoices(catalog, provider, model).some((choice) => choice.value === effort);
    }

    // ---- models map (sparse: role -> {provider, model, reasoningEffort?})
    function cloneModels(map) {
      return isObject(map) ? JSON.parse(JSON.stringify(map)) : {};
    }
    function orderedKeys(map) {
      const others = Object.keys(map).filter((key) => !ROLES.includes(key)).sort();
      return ROLES.filter((role) => Object.prototype.hasOwnProperty.call(map, role)).concat(others);
    }
    function normalizeEntry(entry) {
      if (!isObject(entry) || !isText(entry.provider) || !isText(entry.model)) return undefined;
      const out = { provider: entry.provider, model: entry.model };
      if (isText(entry.reasoningEffort)) out.reasoningEffort = entry.reasoningEffort;
      return out;
    }
    /** The complete sparse map to write: complete rows only, never undefined/empty strings. */
    function buildModelsValue(map) {
      const out = {};
      if (!isObject(map)) return out;
      for (const key of orderedKeys(map)) {
        const entry = normalizeEntry(map[key]);
        if (entry !== undefined) out[key] = entry;
      }
      return out;
    }
    function sameEntry(left, right) {
      return JSON.stringify(normalizeEntry(left)) === JSON.stringify(normalizeEntry(right));
    }
    function entryOf(map, role) {
      const entry = isObject(map) && isObject(map[role]) ? map[role] : {};
      return {
        provider: typeof entry.provider === 'string' ? entry.provider : '',
        model: typeof entry.model === 'string' ? entry.model : '',
        reasoningEffort: typeof entry.reasoningEffort === 'string' ? entry.reasoningEffort : '',
      };
    }
    /** Changing provider clears model and effort; an empty provider removes the row. */
    function setProvider(map, role, provider) {
      const next = cloneModels(map);
      if (!isText(provider)) {
        delete next[role];
      } else if (!(isObject(next[role]) && next[role].provider === provider)) {
        next[role] = { provider, model: '' };
      }
      return next;
    }
    /** Changing model keeps the effort only when the new model offers it. */
    function setModel(map, role, model, catalog) {
      const next = cloneModels(map);
      const current = next[role];
      if (!isObject(current) || !isText(current.provider)) return next;
      if (!isText(model)) {
        next[role] = { provider: current.provider, model: '' };
        return next;
      }
      const entry = { provider: current.provider, model };
      if (isText(current.reasoningEffort) && effortSupported(catalog || EMPTY_CATALOG, current.provider, model, current.reasoningEffort)) {
        entry.reasoningEffort = current.reasoningEffort;
      }
      next[role] = entry;
      return next;
    }
    /** Empty effort means "use the model default": the key is omitted, never written empty. */
    function setEffort(map, role, effort, catalog) {
      const next = cloneModels(map);
      const current = next[role];
      if (!isObject(current) || !isText(current.provider) || !isText(current.model)) return next;
      if (!isText(effort)) {
        delete current.reasoningEffort;
      } else if (effortSupported(catalog || EMPTY_CATALOG, current.provider, current.model, effort)) {
        current.reasoningEffort = effort;
      }
      return next;
    }
    function clearRole(map, role) {
      const next = cloneModels(map);
      delete next[role];
      return next;
    }

    // ---- authorization hint (read-only; never blocks a save)
    function authorizationStatus(snapshot, provider, model) {
      if (!isObject(snapshot) || snapshot.status !== 'ready' || !isObject(snapshot.value)) return 'unknown';
      const value = snapshot.value;
      if (typeof value.enabled !== 'boolean' || !Array.isArray(value.allowedModels)) return 'unknown';
      if (!value.enabled) return 'disabled';
      const key = JSON.stringify([provider, model]);
      const allowed = value.allowedModels.some((route) => isObject(route) && JSON.stringify([route.provider, route.model]) === key);
      return allowed ? 'allowed' : 'notAllowed';
    }

    // ---- snapshots of the two namespaces
    function currentModels(snapshot) {
      return snapshot.status === 'ready' && isObject(snapshot.value) && isObject(snapshot.value.models) ? snapshot.value.models : {};
    }
    function currentMode(snapshot) {
      return snapshot.status === 'ready' && isObject(snapshot.value) && ['strict', 'full-power'].includes(snapshot.value.coordinatorMode) ? 'full-power' : 'off';
    }

    /** One row's view: selected values, option lists and warnings, derived from the catalog. */
    function describeRow(role, entry, catalog, catalogReady, authSnapshot) {
      const provider = entry.provider;
      const model = entry.model;
      const effort = entry.reasoningEffort;
      const knownProvider = provider ? findProvider(catalog, provider) : undefined;
      const knownModel = knownProvider && model ? knownProvider.models.find((candidate) => candidate.id === model) : undefined;
      const missingLabel = (id) => (catalogReady ? { id, missing: true } : { id, missing: false });
      const providerOptions = catalog.providers.map((entryProvider) => ({ value: entryProvider.id, label: entryProvider.label }));
      if (provider && !knownProvider) providerOptions.push({ value: provider, label: provider, disabled: true, missing: missingLabel(provider).missing });
      const modelOptions = knownProvider ? knownProvider.models.map((entryModel) => ({ value: entryModel.id, label: entryModel.label })) : [];
      if (model && !knownModel) modelOptions.push({ value: model, label: model, disabled: true, missing: missingLabel(model).missing });
      const effortOptions = knownModel ? effortChoices(catalog, provider, model) : [];
      const complete = Boolean(provider && model);
      const effortKnown = effort ? effortOptions.some((choice) => choice.value === effort) : true;
      let effortNote = '';
      if (effort && !effortKnown) effortNote = knownModel && effortOptions.length > 0 ? 'unsupported' : 'saved';
      const unknownRoute = catalogReady && complete && (!knownProvider || !knownModel);
      return {
        role,
        provider,
        model,
        effort,
        complete,
        incomplete: Boolean(provider) && !model,
        unknownRoute,
        providerOptions,
        modelOptions,
        effortOptions,
        effortMissing: Boolean(effort) && !effortKnown,
        effortNote,
        auth: complete ? authorizationStatus(authSnapshot, provider, model) : 'none',
      };
    }

    /** Rows from a models map and a raw catalog value (convenience for callers without a controller). */
    function rowsFromCatalog(map, catalogValue, authSnapshot) {
      const catalog = normalizeCatalog(catalogValue);
      return ROLES.map((role) => describeRow(role, entryOf(map, role), catalog, true, authSnapshot));
    }

    // -------------------------------------------------------------- controller
    /** Fan-out of host invalidations to the controllers of open pages. */
    function createHub() {
      const controllers = new Set();
      return {
        add(controller) {
          controllers.add(controller);
          return () => { controllers.delete(controller); };
        },
        refresh() {
          for (const controller of [...controllers]) controller.refreshCatalog();
        },
        reset() {
          for (const controller of [...controllers]) controller.resetConnection();
        },
      };
    }

    /**
     * Autosave controller for the page. `deps`:
     *   models, mode: config forms ({getSnapshot, subscribe, mutate}) for dsh-team
     *   auth: read-only form of subagent-model-selection-settings (optional)
     *   loadCatalog: () => Promise<{ok, value}>
     *   hub: optional createHub() instance
     */
    function createController(deps) {
      const { models, mode, auth, loadCatalog, hub } = deps;
      const listeners = new Set();
      const modelEdits = new Map();
      const modelErrors = new Map();
      let modelSaving = false;
      let modelSave;
      let modeSave;
      let modeSaving = false;
      let modeError = null;
      let catalog = { status: 'idle', value: EMPTY_CATALOG };
      let disposed = false;
      let writeGeneration = 0;
      let catalogGeneration = 0;
      let catalogRefreshPending = false;
      let state;

      function project() {
        const ms = models.getSnapshot();
        const ds = mode.getSnapshot();
        const authSnapshot = auth ? auth.getSnapshot() : undefined;
        const catalogReady = catalog.status === 'ready';
        const actual = currentModels(ms);
        const rows = ROLES.map((role) => {
          const edit = modelEdits.get(role);
          return {
            ...describeRow(role, entryOf(edit ? { [role]: edit.entry } : actual, role), catalog.value, catalogReady, authSnapshot),
            pending: edit?.pending === true,
            error: modelErrors.get(role) ?? null,
          };
        });
        const modelsAvailable = ms.status === 'ready';
        const modeAvailable = ds.status === 'ready';
        const writableModels = modelsAvailable && ms.writable === true;
        const writableMode = modeAvailable && ds.writable === true;
        const complete = rows.filter((row) => row.complete);
        let authNotice = null;
        if (complete.length > 0) {
          if (complete.some((row) => row.auth === 'unknown')) authNotice = 'unknown';
          else if (complete.some((row) => row.auth === 'disabled')) authNotice = 'disabled';
        }
        return {
          models: {
            available: modelsAvailable,
            loading: ms.status === 'loading',
            writable: writableModels,
            rows,
            authNotice,
          },
          mode: {
            available: modeAvailable,
            loading: ds.status === 'loading',
            writable: writableMode,
            value: currentMode(ds),
            pending: modeSaving,
            error: modeError,
          },
          catalog: { status: catalog.status, partial: catalog.value.partial, empty: catalogReady && catalog.value.providers.length === 0 },
        };
      }
      function publish() {
        if (disposed) return;
        state = project();
        for (const listener of [...listeners]) listener();
      }

      const unsubscribers = [models.subscribe(onFormChange), mode.subscribe(onFormChange)];
      if (auth) unsubscribers.push(auth.subscribe(onFormChange));
      function onFormChange() {
        publish();
      }
      let leaveHub = () => {};

      // -- catalog
      async function loadCatalogNow() {
        if (disposed || catalog.status === 'loading') return;
        const generation = catalogGeneration;
        catalog = { status: 'loading', value: catalog.value };
        publish();
        let response;
        try {
          response = await loadCatalog();
        } catch (_error) {
          response = undefined;
        }
        if (disposed || generation !== catalogGeneration) return;
        if (catalogRefreshPending) {
          catalogRefreshPending = false;
          catalog = { status: 'idle', value: catalog.value };
          return loadCatalogNow();
        }
        catalog = response && response.ok
          ? { status: 'ready', value: normalizeCatalog(response.value) }
          : { status: 'error', value: catalog.value };
        publish();
      }
      function refreshCatalog() {
        if (disposed) return;
        if (catalog.status === 'loading') {
          catalogRefreshPending = true;
          return;
        }
        loadCatalogNow();
      }
      function resetConnection() {
        writeGeneration += 1;
        if (disposed) { leaveHub(); return; }
        modelEdits.clear();
        modelErrors.clear();
        modelSaving = false;
        modelSave = undefined;
        modeSaving = false;
        modeSave = undefined;
        modeError = null;
        catalog = { status: 'idle', value: EMPTY_CATALOG };
        catalogGeneration += 1;
        catalogRefreshPending = false;
        loadCatalogNow();
      }

      // -- autosave
      function writable(snapshot) {
        return snapshot.status === 'ready' && snapshot.writable === true;
      }
      async function mutate(form, op, revision) {
        try {
          // The refreshed snapshot, not the boolean, tells us what actually landed.
          await form.mutate([op], revision);
        } catch (_error) {
          // A failed request can still have landed; inspect the snapshot below.
        }
      }
      function writeError(snapshot, revision) {
        return snapshot.status === 'ready' && snapshot.revision !== revision ? 'conflict' : 'saveFailed';
      }
      async function saveModels() {
        if (modelSaving) return;
        modelSaving = true;
        const generation = writeGeneration;
        if (models === mode && modeSave) await modeSave;
        while (generation === writeGeneration) {
          const pending = [...modelEdits].find(([, edit]) => edit.pending);
          if (!pending) break;
          const [role, { base, entry }] = pending;
          const before = models.getSnapshot();
          const actual = currentModels(before);
          let error = null;
          if (before.status !== 'ready') {
            error = 'saveFailed';
          } else if (!sameEntry(actual[role], entry)) {
            if (!writable(before)) {
              error = 'saveFailed';
            } else if (!sameEntry(actual[role], base)) {
              error = 'conflict';
            } else {
              // The form writes the whole map. Merge just this row and pin that snapshot's revision.
              const value = buildModelsValue({ ...actual, [role]: entry });
              const revision = before.revision;
              await mutate(models, { op: 'set', path: ['models'], value }, revision);
              if (generation !== writeGeneration) return;
              const after = models.getSnapshot();
              if (after.status !== 'ready' || !sameEntry(currentModels(after)[role], entry)) {
                error = writeError(after, revision);
              }
            }
          }
          modelEdits.delete(role);
          if (error) modelErrors.set(role, error);
          publish();
        }
        if (generation === writeGeneration) modelSaving = false;
        if (disposed) leaveHub();
      }
      function editModelRow(role, change) {
        const snapshot = models.getSnapshot();
        if (disposed || !writable(snapshot) || !ROLES.includes(role)) return;
        const edit = modelEdits.get(role);
        if (edit?.pending) return;
        const actual = currentModels(snapshot)[role];
        const base = edit ? edit.base : actual;
        const entry = change({ [role]: edit ? edit.entry : actual })[role];
        modelErrors.delete(role);
        if (entry && !isText(entry.model)) {
          modelEdits.set(role, { entry, base, pending: false });
        } else if (sameEntry(entry, actual)) {
          modelEdits.delete(role);
        } else {
          modelEdits.set(role, { entry, base, pending: true });
          if (!modelSaving) modelSave = saveModels();
        }
        publish();
      }
      function setProviderOf(role, provider) {
        if (catalog.status === 'ready') editModelRow(role, (map) => setProvider(map, role, provider));
      }
      function setModelOf(role, model) {
        if (catalog.status === 'ready') editModelRow(role, (map) => setModel(map, role, model, catalog.value));
      }
      function setEffortOf(role, effort) {
        if (catalog.status === 'ready') editModelRow(role, (map) => setEffort(map, role, effort, catalog.value));
      }
      function clearOf(role) {
        editModelRow(role, (map) => clearRole(map, role));
      }
      async function setMode(value) {
        const before = mode.getSnapshot();
        if (disposed || modeSaving || !writable(before) || (value !== 'off' && value !== 'full-power') || value === currentMode(before)) return;
        const generation = writeGeneration;
        modeSaving = true;
        modeError = null;
        modeSave = (async () => {
          if (models === mode && modelSaving) await modelSave;
          if (generation !== writeGeneration) return;
          const latest = mode.getSnapshot();
          if (currentMode(latest) === value) return;
          if (!writable(latest) || currentMode(latest) !== currentMode(before)) {
            modeError = writeError(latest, before.revision);
            return;
          }
          await mutate(mode, { op: 'set', path: ['coordinatorMode'], value }, latest.revision);
          if (generation !== writeGeneration) return;
          const after = mode.getSnapshot();
          if (after.status !== 'ready' || currentMode(after) !== value) modeError = writeError(after, latest.revision);
        })();
        publish();
        await modeSave;
        if (generation !== writeGeneration) return;
        modeSave = undefined;
        modeSaving = false;
        publish();
      }

      function dispose() {
        if (disposed) return;
        disposed = true;
        catalogGeneration += 1;
        for (const off of unsubscribers) off();
        if (!modelSaving) leaveHub();
        listeners.clear();
      }

      const api = {
        getState: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        setProvider: setProviderOf,
        setModel: setModelOf,
        setEffort: setEffortOf,
        clear: clearOf,
        setMode,
        retryCatalog: loadCatalogNow,
        refreshCatalog,
        resetConnection,
        dispose,
      };
      if (hub) leaveHub = hub.add(api);
      state = project();
      loadCatalogNow();
      return api;
    }

    // ---------------------------------------------------------------------- UI
    const CSS = [
      '.dst-root{display:grid;gap:16px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.dst-section{display:grid;gap:10px;min-width:0;padding:4px 0}',
      '.dst-heading{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dst-hint,.dst-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dst-warn{margin:0;font-size:12px;color:var(--dsw-alias-state-warn-label)}',
      '.dst-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.dst-catalog-error{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.dst-rows{display:grid;margin:0;padding:0;list-style:none;container-type:inline-size}',
      '.dst-row{display:grid;grid-template-columns:minmax(72px,1fr) minmax(0,5fr);align-items:center;gap:8px 12px;min-width:0;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dst-row>p{grid-column:1/-1}',
      '.dst-role{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dst-fields{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1.4fr) minmax(0,.8fr) auto;gap:8px;align-items:end}',
      '@container (max-width:700px){.dst-row{grid-template-columns:minmax(0,1fr)}}',
      '@container (max-width:500px){.dst-fields{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.dst-fields>.dst-button{justify-self:end}}',
      '@container (max-width:320px){.dst-fields{grid-template-columns:minmax(0,1fr)}}',
      '.dst-field{display:grid;gap:4px;min-width:0}',
      '.dst-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dst-select{box-sizing:border-box;width:100%;min-width:0;height:28px;padding:0 6px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}',
      '.dst-select:disabled{opacity:.6;cursor:not-allowed}',
      '.dst-select:focus-visible,.dst-button:focus-visible,.dst-switch:focus-visible{outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dst-button{height:28px;padding:0 12px;font:inherit;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);cursor:pointer}',
      '.dst-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4)}',
      '.dst-button:disabled{opacity:.5;cursor:not-allowed}',
      '.dst-link{padding:0;color:var(--dsw-alias-brand-primary);background:none;border:0;cursor:pointer;font:inherit}',
      '@container (min-width:701px){.dst-row:not(:first-child) .dst-label{display:none}.dst-row:first-child{align-items:end}}',
      '.dst-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px}',
      '.dst-switch-copy{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 12px;min-width:0}',
      '.dst-switch-label{font-weight:600}',
      '.dst-switch{flex:none;display:inline-flex;align-items:center;padding:0;background:none;border:0;cursor:pointer}',
      '.dst-switch:disabled{opacity:.5;cursor:not-allowed}',
      '.dst-track{position:relative;display:inline-block;width:32px;height:18px;border-radius:9px;background:var(--dsw-alias-border-l4);transition:background .15s}',
      '.dst-track[data-on=true]{background:var(--dsw-alias-brand-primary)}',
      '.dst-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);transition:transform .15s}',
      '.dst-track[data-on=true] .dst-thumb{transform:translateX(14px)}',
      '@media (prefers-reduced-motion:reduce){.dst-track,.dst-thumb{transition:none}}',
    ].join('');

    function optionLabel(t, option) {
      return option.missing ? option.label + ' · ' + t('unavailableOption') : option.label;
    }

    function Select(props) {
      const { t, label, value, options, onChange, disabled, placeholder, current } = props;
      const items = [h('option', { key: '', value: '' }, placeholder)];
      if (current) items.push(h('option', { key: '__current', value: current.value, disabled: true }, current.label));
      for (const option of options) {
        items.push(h('option', { key: option.value, value: option.value, disabled: option.disabled === true, title: option.description || undefined }, optionLabel(t, option)));
      }
      return h('label', { className: 'dst-field' },
        h('span', { className: 'dst-label' }, props.fieldLabel),
        h('select', {
          className: 'dst-select',
          'aria-label': label,
          value,
          disabled,
          onChange: (event) => onChange(event.target.value),
        }, items));
    }

    function Row(props) {
      const { t, controller, row, state } = props;
      const roleLabel = t('role.' + row.role);
      const locked = !state.models.writable || row.pending;
      const pickersLocked = locked || state.catalog.status !== 'ready';
      const name = (field) => t('fieldFor', { role: roleLabel, field: t(field) });
      const effortLocked = pickersLocked || !row.complete || (row.effortOptions.length === 0 && !row.effort);
      const effortCurrent = row.effortMissing
        ? { value: row.effort, label: row.effort + ' · ' + t('unavailableOption') }
        : undefined;
      const notes = [];
      if (row.pending) notes.push(h('p', { key: 'pending', className: 'dst-note', role: 'status' }, t('saving')));
      if (row.error) notes.push(h('p', { key: 'error', className: 'dst-error', role: 'alert' }, t(row.error)));
      if (row.incomplete) notes.push(h('p', { key: 'incomplete', className: 'dst-error' }, t('incompleteRow')));
      if (row.unknownRoute) notes.push(h('p', { key: 'catalog', className: 'dst-warn' }, t('catalogWarning')));
      if (row.auth === 'notAllowed') notes.push(h('p', { key: 'auth', className: 'dst-warn' }, t('authWarning')));
      if (row.effortNote === 'unsupported') notes.push(h('p', { key: 'effort', className: 'dst-note' }, t('effortUnsupported', { effort: row.effort })));
      if (row.effortNote === 'saved') notes.push(h('p', { key: 'effort', className: 'dst-note' }, t('effortSaved', { effort: row.effort })));
      return h('li', { className: 'dst-row', 'data-role': row.role },
        h('div', { className: 'dst-role' },
          h('strong', null, roleLabel),
          h('p', { className: 'dst-hint' }, t('duty.' + row.role))),
        h('div', { className: 'dst-fields' },
          h(Select, {
            t, fieldLabel: t('provider'), label: name('provider'), value: row.provider, options: row.providerOptions, disabled: pickersLocked,
            placeholder: t('inherit'), onChange: (value) => controller.setProvider(row.role, value),
          }),
          h(Select, {
            t, fieldLabel: t('model'), label: name('model'), value: row.model, options: row.modelOptions, disabled: pickersLocked || !row.provider,
            placeholder: t('selectModel'), onChange: (value) => controller.setModel(row.role, value),
          }),
          h(Select, {
            t, fieldLabel: t('effort'), label: name('effort'), value: row.effort, options: row.effortOptions, disabled: effortLocked,
            placeholder: t('defaultEffort'), current: effortCurrent, onChange: (value) => controller.setEffort(row.role, value),
          }),
          h('button', {
            type: 'button', className: 'dst-button', 'aria-label': name('clear'), disabled: locked || !row.provider,
            onClick: () => controller.clear(row.role),
          }, t('clear'))),
        notes);
    }

    function ModelsSection(props) {
      const { t, controller, state, headingId } = props;
      const parts = [h('h3', { key: 'h', className: 'dst-heading', id: headingId }, t('title'))];
      if (state.models.loading) {
        parts.push(h('p', { key: 'l', className: 'dst-hint', role: 'status' }, t('loadingSettings')));
        return h('section', { className: 'dst-section', 'aria-labelledby': headingId }, parts);
      }
      if (!state.models.available) {
        parts.push(h('p', { key: 'u', className: 'dst-warn', role: 'status' }, t('unavailable')));
        return h('section', { className: 'dst-section', 'aria-labelledby': headingId }, parts);
      }
      parts.push(h('p', { key: 'i', className: 'dst-hint' }, t('modelsIntro')));
      if (!state.models.writable) parts.push(h('p', { key: 'ro', className: 'dst-note' }, t('readOnly')));
      if (state.catalog.status === 'loading' || state.catalog.status === 'idle') {
        parts.push(h('p', { key: 'c', className: 'dst-hint', role: 'status' }, t('loading')));
      }
      if (state.catalog.status === 'error') {
        parts.push(h('div', { key: 'ce', className: 'dst-catalog-error', role: 'alert' },
          h('span', null, t('loadFailed')),
          h('button', { type: 'button', className: 'dst-link', onClick: controller.retryCatalog }, t('retry'))));
      }
      if (state.catalog.partial) parts.push(h('p', { key: 'cp', className: 'dst-note' }, t('catalogPartial')));
      if (state.catalog.empty) parts.push(h('p', { key: 'ce2', className: 'dst-note' }, t('catalogEmpty')));
      if (state.models.authNotice === 'unknown') parts.push(h('p', { key: 'an', className: 'dst-warn' }, t('authorizationUnknown')));
      if (state.models.authNotice === 'disabled') parts.push(h('p', { key: 'ad', className: 'dst-warn' }, t('authDisabled')));
      parts.push(h('ul', { key: 'rows', className: 'dst-rows', 'aria-labelledby': headingId },
        state.models.rows.map((row) => h(Row, { key: row.role, t, controller, row, state }))));
      return h('section', { className: 'dst-section', 'aria-labelledby': headingId }, parts);
    }

    function ModeSection(props) {
      const { t, controller, state, labelId, helpId } = props;
      if (state.mode.loading) return null;
      if (!state.mode.available) {
        return h('section', { className: 'dst-section' }, h('p', { className: 'dst-warn', role: 'status' }, t('unavailable')));
      }
      const on = state.mode.value === 'full-power';
      const locked = !state.mode.writable || state.mode.pending;
      return h('section', { className: 'dst-section' },
        h('div', { className: 'dst-switch-row' },
          h('div', { className: 'dst-switch-copy' },
            h('span', { className: 'dst-switch-label', id: labelId }, t('coordinator')),
            h('span', { className: 'dst-hint', id: helpId }, t('coordinatorHelp'))),
          h('button', {
            type: 'button', className: 'dst-switch', role: 'switch', 'aria-checked': on,
            'aria-labelledby': labelId, 'aria-describedby': helpId, disabled: locked,
            onClick: () => controller.setMode(on ? 'off' : 'full-power'),
          }, h('span', { className: 'dst-track', 'data-on': on, 'aria-hidden': 'true' }, h('span', { className: 'dst-thumb' })))),
        state.mode.pending && h('p', { className: 'dst-note', role: 'status' }, t('saving')),
        state.mode.error && h('p', { className: 'dst-error', role: 'alert' }, t(state.mode.error)));
    }

    function PageBody(props) {
      const { t, controller } = props;
      const state = React.useSyncExternalStore(controller.subscribe, controller.getState);
      const uid = React.useId();
      return h('div', { className: 'dst-root', 'data-specialist-team-settings': true },
        h('style', null, CSS),
        h(ModelsSection, { t, controller, state, headingId: uid + '-models' }),
        h(ModeSection, { t, controller, state, labelId: uid + '-mode', helpId: uid + '-mode-help' }));
    }

    /** Owns one controller per open page; local selections are dropped when the page is left. */
    function PageHost(props) {
      const [controller, setController] = React.useState(null);
      React.useEffect(() => {
        const created = createController(props.createDeps());
        setController(created);
        return () => { created.dispose(); };
      }, []);
      return controller === null
        ? h('p', { className: 'dst-hint', role: 'status' }, props.t('loadingSettings'))
        : h(PageBody, { t: props.t, controller });
    }

    function makePage(createDeps) {
      return function SpecialistModelsPage(props) {
        if (props.view === 'summary') return props.t('summary');
        return h(PageHost, { t: props.t, createDeps });
      };
    }

    // ------------------------------------------------------------------ mount
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-specialist-team: dictionaries');
      const hub = createHub();
      ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { hub.refresh(); }), 'dsh-specialist-team: adapter invalidations');
      ctx.effect(() => ctx.on('connection/reset', () => { hub.reset(); }), 'dsh-specialist-team: connection generation');
      const Page = makePage(() => ({
        models: ctx.configForms.get(MODELS_NS),
        mode: ctx.configForms.get(MODE_NS),
        auth: ctx.configForms.get(AUTH_NS),
        loadCatalog: () => ctx.remote.session.modelCatalog(),
        hub,
      }));
      function BundleSettings(props) {
        const [opened, setOpened] = React.useState(false);
        return h('details', { className: 'dst-panel', onToggle: event => { if (event.currentTarget.open) setOpened(true); } },
          h('summary', null, h('strong', null, props.t('settingsTitle')), h('span', null, props.t('summary'))),
          h('style', null, `
            .dst-panel{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-3)}
            .dst-panel:hover,.dst-panel[open]{border-color:var(--dsw-alias-label-dimmed)}
            .dst-panel[open]{background:var(--dsw-alias-bg-layer-2)}
            .dst-panel>summary{position:relative;display:grid;gap:4px;padding:14px 44px 14px 16px;cursor:pointer;list-style:none;border-radius:inherit}
            .dst-panel>summary::-webkit-details-marker{display:none}
            .dst-panel>summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
            .dst-panel>summary>span{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
            .dst-panel>summary::after{content:'';position:absolute;right:18px;top:50%;width:6px;height:6px;border:solid var(--dsw-alias-label-tertiary);border-width:0 1px 1px 0;transform:translateY(-70%) rotate(45deg)}
            .dst-panel[open]>summary::after{transform:translateY(-30%) rotate(225deg)}
            .dst-panel>.dst-root{gap:0;margin:0 16px;padding-bottom:8px}
            .dst-panel .dst-section{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0}
            .dst-panel[open]>summary>span,.dst-panel .dst-heading{display:none}
            .dst-panel .dst-section:first-of-type{border-top:0;padding-top:0}
            .dst-panel .dst-section:has(.dst-rows){padding-bottom:0}
          `),
          opened ? h(Page, props) : null);
      }
      ctx.effect(() => ctx.configForms.whileServed([MODELS_NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: 'dsh-specialist-team', locale: NS,
      }, BundleSettings))), 'dsh-specialist-team: bundle settings');
    }

    return {
      inject: SERVICES,
      apply,
      // constants and pure helpers (exercised by test/client.test.mjs)
      NS, MODELS_NS, MODE_NS, AUTH_NS, ROLES, dictionaries,
      normalizeCatalog, labelItems, effortChoices, describeRow, rowsFromCatalog, authorizationStatus,
      buildModelsValue, entryOf,
      setProvider, setModel, setEffort, clearRole,
      createHub, createController, makePage, PageBody,
    };
  },
});
