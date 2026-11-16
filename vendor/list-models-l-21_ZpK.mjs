import z from "@deepseek-ai/schemastery";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { scopeOf } from "@deepseek-ai/dsh-scope";
z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required()
});
/**
* Stable identity for one provider/model pair.
* @param route - Exact provider/model route.
* @returns Opaque key for equality checks.
*/
function modelRouteKey(route) {
	return `${route.provider}\0${route.model}`;
}
/**
* Reject malformed or duplicate route policy entries at a durable or configuration boundary.
* @param routes - Candidate exact routes to validate.
* @returns an assertion that the candidate is a validated exact-route array.
*/
function assertAllowedModelRoutes(routes) {
	if (!Array.isArray(routes)) throw new Error("subagent model selection requires an array of routes");
	const seen = /* @__PURE__ */ new Set();
	const candidates = routes;
	for (const candidate of candidates) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || !("provider" in candidate) || typeof candidate.provider !== "string" || !("model" in candidate) || typeof candidate.model !== "string" || candidate.provider.length === 0 || candidate.model.length === 0) throw new Error("subagent model selection requires non-empty provider and model ids");
		const route = {
			provider: candidate.provider,
			model: candidate.model
		};
		const key = modelRouteKey(route);
		if (seen.has(key)) throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`);
		seen.add(key);
	}
}
/**
* Whether a call explicitly selects any child LLM value.
* @param request - Model-facing route fields from the tool call.
* @returns Whether at least one route or effort field is present.
*/
function hasDelegationModelRequest(request) {
	return request.provider !== void 0 || request.model !== void 0 || request.reasoning_effort !== void 0;
}
/** Reject an empty model-facing route value at the tool JSON boundary. */
function assertNonEmpty(value, field) {
	if (value !== void 0 && value.length === 0) throw new Error(`child LLM \`${field}\` must be non-empty`);
}
/**
* Merge model-supplied selection fields over configured child defaults.
* Provider and model form one route and must be supplied together. Changing
* that route without an effort clears the configured route-owned effort.
* @param parentOptions - Current parent values that supply missing child values.
* @param configured - Tool-instance child defaults.
* @param request - Model-facing route override.
* @param enabled - Whether this tool instance permits model-facing selection.
* @returns Child Agent options, preserving omission when no layer contributes one.
*/
function requestedAgentOptions(parentOptions, configured, request, enabled) {
	if (!hasDelegationModelRequest(request)) return configured;
	if (!enabled) throw new Error("child model selection is disabled for this tool instance");
	assertNonEmpty(request.provider, "provider");
	assertNonEmpty(request.model, "model");
	assertNonEmpty(request.reasoning_effort, "reasoning_effort");
	if (request.provider === void 0 !== (request.model === void 0)) throw new Error("child LLM `provider` and `model` must be supplied together");
	const baselineProvider = configured?.provider ?? parentOptions.provider;
	const baselineModel = configured?.model ?? parentOptions.model;
	const routeChanged = request.provider !== void 0 && (request.provider !== baselineProvider || request.model !== baselineModel);
	const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {};
	return {
		...routeChanged && request.reasoning_effort === void 0 ? configuredWithoutReasoning : configured,
		...request.provider === void 0 ? {} : {
			provider: request.provider,
			model: request.model
		},
		...request.reasoning_effort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) }
	};
}
/**
* Enforce a settings-owned route list at the operation that creates the child.
* Pure inheritance remains outside this policy because no model-facing choice
* occurred; any explicit route or effort field must resolve to an allowed route.
* @param policy - Selection authority captured for this Session.
* @param parentOptions - Current parent values that supply missing child values.
* @param requested - Effective child options after request/config merging.
* @param request - Model-facing selection fields from the tool call.
*/
function assertAllowedModelSelection(policy, parentOptions, requested, request) {
	if (policy === void 0 || !hasDelegationModelRequest(request)) return;
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	if (policy.routes.some((route) => route.provider === provider && route.model === model)) return;
	throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`);
}
/**
* Whether configured Agent options require route validation before delegation.
* @param options - Tool-instance child defaults.
* @returns Whether configured provider, model, or effort values must be resolved.
*/
function hasConfiguredLlmSelection(options) {
	return options?.provider !== void 0 || options?.model !== void 0 || options?.reasoningEffort !== void 0;
}
/**
* Resolve an effective child route through its live adapter before the child is
* created. The LLM runtime owns provider lookup, exact-model metadata, effort
* validation, and adapter defaults.
* @param llm - Live LLM runtime.
* @param parentOptions - Current parent values whose compatible fields the child inherits.
* @param requested - Per-child options after request/config merging.
* @param signal - Tool-call cancellation signal.
* @param inheritParentReasoningEffort - Whether an omitted effort may inherit from the parent route.
*/
async function preflightChildLlmRoute(llm, parentOptions, requested, signal, inheritParentReasoningEffort = true) {
	const provider = requested?.provider ?? parentOptions.provider;
	const model = requested?.model ?? parentOptions.model;
	if (provider === void 0 || model === void 0) throw new Error("cannot select child LLM values without an effective provider and model");
	const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model;
	const reasoningEffort = requested?.reasoningEffort ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : void 0);
	await llm.resolveCallConfig({
		provider,
		model,
		...reasoningEffort === void 0 ? {} : { reasoningEffort }
	}, signal);
}
/** Host-only projection of the durable model-selection policy. */
const subagentModelSelectionProjectionDefinition = {
	key: "subagentModelSelectionPolicy",
	stateVersion: 1,
	stateSchema: z$1.array(z$1.object({
		provider: z$1.string().min(1),
		model: z$1.string().min(1)
	}).strict()).min(1).nullable(),
	init: () => null,
	apply: (policy, event) => {
		if (policy !== null || event.type !== "subagent/model-selection-policy") return policy;
		const { allowedModels } = event.data;
		assertAllowedModelRoutes(allowedModels);
		if (allowedModels.length === 0) throw new Error("subagent/model-selection-policy requires at least one route");
		return allowedModels;
	}
};
/**
* Read the exact route list captured for a model-selectable definition.
* @param projections - registry that owns the policy projection.
* @param session - session whose durable decision is read.
* @returns a detached route list, or undefined for the fixed-route definition.
*/
function subagentModelSelectionPolicy(projections, session) {
	return projections.stateOf(session, "subagentModelSelectionPolicy")?.map((route) => ({ ...route }));
}
/**
* Append the route policy once, before its definition can reach a model request.
* @param projections - registry that owns the policy projection.
* @param session - session receiving the model-selectable definition.
* @param allowedModels - exact routes the definition may select explicitly.
*/
function recordSubagentModelSelection(projections, session, allowedModels) {
	if (subagentModelSelectionPolicy(projections, session) !== void 0) return;
	session.append("subagent/model-selection-policy", { allowedModels: allowedModels.map((route) => ({ ...route })) });
}
/**
* Resolve and record the immutable child-model policy for a Session.
* Existing Sessions without a saved policy remain disabled; fresh roots sample
* Host settings and child Sessions inherit the parent's recorded policy.
* @param ctx - Context carrying projections and optional Host settings and Sessions.
* @param session - Session whose selection authority is initialized or restored.
* @param enabled - Whether the consuming tool supports model selection.
* @returns Recorded authority, or undefined when selection is disabled.
*/
function selectSubagentModelSelection(ctx, session, enabled) {
	if (!enabled) return void 0;
	const settings = ctx.get("subagentModelSelection");
	if (settings === void 0) throw new Error("child model selection requires the subagent-model-selection-settings Host service");
	const freshSession = session.firstLiveSeq === 0 && session.eventAt(SessionSeq(0))?.type !== "session/end-seed";
	let allowedModels = subagentModelSelectionPolicy(ctx.sessionProjections, session);
	if (allowedModels === void 0) {
		const parentId = session.header.origin === "subagent" ? session.header.parentSession : void 0;
		if (parentId !== void 0) {
			const sessions = ctx.get("sessions");
			if (sessions === void 0) throw new Error("tool-subagent: child model-selection inheritance requires the Session registry");
			const parent = sessions.get(parentId);
			allowedModels = parent === void 0 ? void 0 : subagentModelSelectionPolicy(ctx.sessionProjections, parent);
		} else if (freshSession) {
			const current = settings.current();
			allowedModels = current.enabled ? current.allowedModels : void 0;
		}
	}
	if (allowedModels !== void 0) recordSubagentModelSelection(ctx.sessionProjections, session, allowedModels);
	return allowedModels === void 0 ? void 0 : { routes: allowedModels };
}
//#endregion
//#region packages/subagent/tool-subagent/src/list-models.ts
/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_UNLOADING = 5;
/** Resolve one registered provider with a model-correctable diagnostic. */
function registeredProvider(llm, policy, providerId) {
	const providers = llm.listProviders();
	const provider = providers.find((candidate) => candidate.id === providerId);
	if (provider !== void 0) return provider;
	const available = providers.filter((candidate) => policy.routes.some((route) => route.provider === candidate.id)).map((candidate) => candidate.id).join(", ") || "(none)";
	throw new Error(`LLM provider "${providerId}" is not registered; available providers: ${available}`);
}
/** Render one advertised or resolved model. */
function modelLine(provider, model) {
	return `${provider}/${model.id} — ${model.name}${model.description === void 0 ? "" : `: ${model.description}`}`;
}
/** Read the requested provider, advertised models, or exact-model efforts. */
async function listSubagentModels(ctx, policy, request, signal) {
	const llm = ctx.get("llm");
	if (llm === void 0) throw new Error("cannot discover child LLM routes because the `llm` service is unavailable");
	if (request.model !== void 0 && request.provider === void 0) throw new Error("`model` requires `provider`");
	if (request.provider === void 0) {
		const providers = llm.listProviders().filter((provider) => policy.routes.some((route) => route.provider === provider.id));
		return providers.length === 0 ? "(no LLM providers)" : providers.map((provider) => `${provider.id} — ${provider.name}`).join("\n");
	}
	if (request.provider.length === 0) throw new Error("`provider` must be non-empty");
	const allowedRoutes = policy.routes.filter((route) => route.provider === request.provider);
	if (allowedRoutes.length === 0) throw new Error(`LLM provider "${request.provider}" is not allowed for this Session`);
	const provider = registeredProvider(llm, policy, request.provider);
	if (request.model === void 0) {
		const models = (await llm.listModels(provider.id)).filter((model) => allowedRoutes.some((route) => route.model === model.id));
		return models.length === 0 ? `(no advertised models for ${provider.id})` : models.map((model) => modelLine(provider.id, model)).join("\n");
	}
	if (request.model.length === 0) throw new Error("`model` must be non-empty");
	if (!allowedRoutes.some((route) => route.model === request.model)) throw new Error(`child LLM route "${provider.id}/${request.model}" is not allowed for this Session`);
	const model = await llm.resolveModelInfo(provider.id, request.model, signal);
	const efforts = model.reasoning?.efforts.map((effort) => `${effort.id}${model.reasoning?.defaultEffort === effort.id ? " (default)" : ""} — ${effort.name}` + (effort.description === void 0 ? "" : `: ${effort.description}`)).join("\n") || "(no advertised reasoning efforts)";
	return `${modelLine(provider.id, model)}\nReasoning efforts:\n${efforts}`;
}
/**
* Keep discovery available while this delegation-tool instance is mounted.
* @param ctx - Context whose tool registry owns the discovery definition.
* @param policy - Route policy captured for this Session.
* @returns Disposer that releases this consumer and any registration it owns.
*/
function registerListSubagentModels(ctx, policy) {
	const definition = defineTool({
		name: "list_subagent_models",
		description: "Discover LLM routes for subagents without changing the current Agent. Call with no arguments to list registered providers, with `provider` to list its advertised models, or with `provider` and `model` to inspect that exact model and its reasoning efforts. Catalog membership is advisory: an adapter may accept an unlisted model id. Use the returned ids with a delegation tool's `provider`, `model`, and `reasoning_effort` fields.",
		parameters: {
			provider: {
				type: "string",
				description: "Registered LLM provider id. Omit to list providers."
			},
			model: {
				type: "string",
				description: "Exact model id to inspect. Requires provider; omit to list that provider's advertised models."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, result) => [{
				type: "text",
				text: result
			}]
		},
		execute(args, exec) {
			return listSubagentModels(ctx, policy, args, exec.signal);
		}
	});
	return ctx.effect(() => {
		let disposed = false;
		let mounting = false;
		let unregister;
		const reconcile = () => {
			if (disposed || mounting || ctx.fiber.state === FIBER_UNLOADING || ctx.fiber.uid === null || ctx.tools.get(definition.name, scopeOf(ctx)) !== void 0) return;
			mounting = true;
			try {
				unregister = ctx.tools.register(definition);
			} finally {
				mounting = false;
			}
		};
		const stopWatching = ctx.on("tools/change", reconcile);
		reconcile();
		return () => {
			disposed = true;
			stopWatching();
			return unregister?.();
		};
	});
}
//#endregion
export { hasConfiguredLlmSelection as a, requestedAgentOptions as c, assertAllowedModelSelection as i, selectSubagentModelSelection as n, hasDelegationModelRequest as o, subagentModelSelectionProjectionDefinition as r, preflightChildLlmRoute as s, registerListSubagentModels as t };
