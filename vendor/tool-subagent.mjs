import { a as hasConfiguredLlmSelection, c as requestedAgentOptions, i as assertAllowedModelSelection, n as selectSubagentModelSelection, o as hasDelegationModelRequest, r as subagentModelSelectionProjectionDefinition, s as preflightChildLlmRoute, t as registerListSubagentModels } from "./list-models-l-21_ZpK.mjs";
import z from "@deepseek-ai/schemastery";
import { assertSubagentMaxDepth, delegationDepthOf, parentAgentOptionsForDelegation } from "@deepseek-ai/dsh-subagent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { scopeChainOf, scopeOf } from "@deepseek-ai/dsh-scope";
//#region packages/subagent/tool-subagent/src/preset-selection.ts
/** Validates configured references and resolves model input against the allowlist. */
var SubagentPresetSelection = class {
	config;
	descriptions = [];
	constructor(config) {
		this.config = config;
		const { agentPreset, allowedAgentPresets } = config;
		if (allowedAgentPresets === void 0) return;
		if (new Set(allowedAgentPresets).size !== allowedAgentPresets.length) throw new Error("tool-subagent: allowedAgentPresets contains duplicate preset ids");
		if (agentPreset !== void 0 && !allowedAgentPresets.includes(agentPreset)) throw new Error("tool-subagent: agentPreset must be included in allowedAgentPresets");
	}
	/** Whether this tool requires the preset service and an independently composing provider. */
	get configured() {
		return this.config.agentPreset !== void 0 || this.config.allowedAgentPresets !== void 0;
	}
	/** Preset ids advertised in the model parameter. */
	get choices() {
		return this.config.allowedAgentPresets;
	}
	/** Model-visible selection guidance and configured preset descriptions. */
	get description() {
		return `Agent preset for this child. ${this.config.agentPreset === void 0 ? "Omit to inherit the parent agent's current preset." : `Omit to use ${this.config.agentPreset}.`}` + (this.descriptions.length === 0 ? "" : ` Available presets: ${this.descriptions.join("; ")}`);
	}
	/**
	* Read configured preset declarations before publishing the tool; mounting validates their activation.
	* @param ctx - Tool composition containing the preset service.
	*/
	async validate(ctx) {
		const presets = ctx.get("agentPresets");
		if (presets === void 0) throw new Error("tool-subagent: agent preset selection requires the agent-presets service");
		const ids = new Set([...this.config.agentPreset === void 0 ? [] : [this.config.agentPreset], ...this.config.allowedAgentPresets ?? []]);
		const descriptions = [];
		for (const id of ids) {
			const preset = await presets.readDocument(id);
			if (this.choices?.includes(id) && preset.description !== void 0) descriptions.push(`${id}: ${preset.description}`);
		}
		this.descriptions = descriptions;
	}
	/**
	* Reject independent selection for providers that inherit conversation history or lack support.
	* @param provider - Currently registered delegation provider.
	*/
	assertProvider(provider) {
		if (this.configured && (!provider.capabilities.agentPreset || provider.inheritsParentContext)) throw new Error(`tool-subagent: provider "${provider.name}" does not support independent agent preset selection`);
	}
	/**
	* Validate model input and apply the deployment default.
	* @param request - Model-supplied tool arguments.
	* @returns Selected preset id, or omission to inherit the parent.
	*/
	resolve(request) {
		const id = request.agent_preset;
		if (id === void 0) return this.config.agentPreset;
		if (this.choices === void 0) throw new Error("agent_preset selection is disabled for this tool instance");
		if (typeof id !== "string" || !this.choices.includes(id)) throw new Error(`agent_preset must be one of: ${this.choices.join(", ")}`);
		return id;
	}
};
//#endregion
//#region packages/subagent/tool-subagent/src/index.ts
/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_UNLOADING = 5;
const name = "tool-subagent";
const inject = [
	"tools",
	"subagents",
	"systemPrompt",
	"sessionProjections"
];
const delegationTools = /* @__PURE__ */ new Set();
const Config = z.object({
	provider: z.string().required(),
	toolName: z.string().default("subagent"),
	modelSelectionSettings: z.boolean().default(false),
	agentOptions: z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.string().min(1),
		maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
	}).default(void 0),
	agentPreset: z.string().min(1),
	allowedAgentPresets: z.array(z.string().min(1)).min(1).default(void 0),
	maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const("provider-managed")])
});
/**
* Model-facing wording from the provider's conversation-history descriptor
* ({@link SubagentProvider.inheritsParentContext}).
* A fresh child needs a standalone prompt; a forked child already sees the
* conversation's completed turns — telling the model to restate everything
* (or, worse, that the child "does not see this conversation") would be false
* for a fork.
* @param inheritsConversation - whether the child's conversation is seeded
*   with the parent's completed turns; this says nothing about tool, service,
*   scope, or authority inheritance.
* @returns the tool `description` and the `prompt` parameter description.
*/
function providerWording(inheritsConversation) {
	if (inheritsConversation) return {
		description: "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. You receive its result, not its intermediate steps.",
		promptDescription: "The task for the subagent. It already sees this conversation's completed turns, so build on them freely and state only what is new."
	};
	return {
		description: "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps.",
		promptDescription: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
	};
}
/**
* Install one delegation-tool composition.
* Standing preset choices are validated for each Agent before its tool is installed.
* @param ctx - Context that owns the registrations.
* @param config - delegation-tool configuration.
* @param session - unpublished Session supplied by a direct Agent setup; omit for a standing composition.
*/
async function apply(ctx, config, session) {
	for (const field of ["persona", "toolFilter"]) if (Object.hasOwn(config, field)) throw new Error(`tool-subagent: ${field} is no longer supported; configure persona and tool plugins in an Agent Preset and select it with agentPreset (spawn only)`);
	const presets = new SubagentPresetSelection(config);
	if (presets.configured && ctx.get("agentPresets") === void 0) throw new Error("tool-subagent: agent preset selection requires the agent-presets service");
	if (config.maxDepth !== "provider-managed") assertSubagentMaxDepth(config.maxDepth);
	const toolName = config.toolName ?? "subagent";
	const modelSelectionCapable = config.modelSelectionSettings === true;
	ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition);
	const assertSubagentProviderConfiguration = (subagentProvider) => {
		presets.assertProvider(subagentProvider);
		if (ctx.subagents.resolveMaxDepth(config.maxDepth) !== void 0 && !subagentProvider.capabilities.depthLimit) throw new Error(`tool-subagent: provider "${subagentProvider.name}" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: 'provider-managed' to leave the recursion budget to the provider`);
		if (config.agentOptions !== void 0 && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child agentOptions`);
		if (modelSelectionCapable && !subagentProvider.capabilities.agentOptions) throw new Error(`tool-subagent: provider "${subagentProvider.name}" does not support child model selection`);
	};
	ctx.on("subagent/provider-added", (subagentProvider) => {
		if (subagentProvider.name === config.provider) assertSubagentProviderConfiguration(subagentProvider);
	});
	const initialProvider = ctx.subagents.getProvider(config.provider);
	if (initialProvider !== void 0) assertSubagentProviderConfiguration(initialProvider);
	const install = (runtimeCtx, modelSelectionPolicy) => {
		const modelSelectionEnabled = modelSelectionPolicy !== void 0;
		if (modelSelectionPolicy !== void 0) registerListSubagentModels(runtimeCtx, modelSelectionPolicy);
		let mounted;
		const mount = (subagentProvider) => {
			assertSubagentProviderConfiguration(subagentProvider);
			const wording = providerWording(subagentProvider.inheritsParentContext);
			const providerRouteDefaults = subagentProvider.agentRouteDefaults;
			const choiceDescription = !modelSelectionEnabled ? "" : (providerRouteDefaults !== void 0 ? " Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and this provider's route defaults. Supply `provider` and `model` together after using `list_subagent_models` to inspect advertised routes and efforts. Changing the effective route without naming an effort uses the selected model's default effort." : " Child LLM selection is optional. Omit `provider`, `model`, and `reasoning_effort` to use configured child defaults and inherit compatible missing values from the parent Agent. Supply `provider` and `model` together after using `list_subagent_models` to inspect advertised routes and efforts. Changing the effective route without naming an effort uses the selected model's default effort.") + (subagentProvider.inheritsParentContext ? " Changing the route can prevent provider-side reuse of the inherited conversation prefix." : "");
			const definition = defineTool({
				name: toolName,
				description: wording.description + " This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes." + (subagentProvider.prepareContinuable !== void 0 ? " The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes." : " The completion notice includes its final answer. This backend does not accept follow-up messages.") + choiceDescription,
				parameters: {
					cwd: {
						type: "string",
						description: "Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent."
					},
					description: {
						type: "string",
						required: true,
						description: "A short (3-5 word) description of the delegated task, for display."
					},
					prompt: {
						type: "string",
						required: true,
						description: wording.promptDescription
					},
					...presets.choices === void 0 ? {} : { agent_preset: {
						type: "string",
						enum: [...presets.choices],
						description: presets.description
					} },
					...modelSelectionEnabled ? {
						provider: {
							type: "string",
							description: providerRouteDefaults !== void 0 ? "LLM provider route for the child. Supply together with model; omit both to use configured child defaults or this provider's route defaults." : "LLM provider route for the child. Supply together with model; omit both to use configured child defaults or inherit the parent route."
						},
						model: {
							type: "string",
							description: providerRouteDefaults !== void 0 ? "Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or this provider's route defaults." : "Model id interpreted by provider. Supply together with provider; omit both to use configured child defaults or inherit the parent route."
						},
						reasoning_effort: {
							type: "string",
							description: providerRouteDefaults !== void 0 ? "Adapter-owned reasoning effort for the effective child route. Omit to use a compatible configured effort or the selected model's default." : "Adapter-owned reasoning effort for the effective child route. Omit to inherit a compatible configured/parent effort or use a newly selected model's default."
						}
					} : {}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							kind: {
								type: "string",
								required: true,
								const: "activation"
							},
							subagentId: {
								type: "string",
								required: true
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: `started subagent ${value.subagentId}`
					}]
				},
				isConcurrencySafe: () => true,
				async execute(args, exec) {
					const parent = exec.agent;
					if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");
					const agentPreset = presets.resolve(args);
					const modelRequest = args;
					const parentOptions = parentAgentOptionsForDelegation(parent);
					const requiresRoutePreflight = hasDelegationModelRequest(modelRequest) || hasConfiguredLlmSelection(config.agentOptions);
					const requestedChildAgentOptions = requestedAgentOptions(parentOptions, requiresRoutePreflight && providerRouteDefaults !== void 0 ? {
						...providerRouteDefaults,
						...config.agentOptions
					} : config.agentOptions, modelRequest, modelSelectionEnabled);
					assertAllowedModelSelection(modelSelectionPolicy, parentOptions, requestedChildAgentOptions, modelRequest);
					if (requiresRoutePreflight) {
						const llm = runtimeCtx.get("llm");
						if (llm === void 0) throw new Error("cannot resolve the selected child LLM route because the `llm` service is unavailable");
						await preflightChildLlmRoute(llm, parentOptions, requestedChildAgentOptions, exec.signal, providerRouteDefaults === void 0);
						if (runtimeCtx.subagents.getProvider(config.provider) !== subagentProvider) throw new Error(`subagent provider "${config.provider}" changed while resolving the child LLM route; retry the delegation`);
					}
					exec.signal.throwIfAborted();
					const maxDepth = runtimeCtx.subagents.resolveMaxDepth(config.maxDepth);
					const request = {
						...args.cwd === void 0 ? {} : { cwd: args.cwd },
						prompt: [{
							type: "text",
							text: args.prompt
						}],
						parent,
						...agentPreset === void 0 ? {} : { agentPreset },
						...requestedChildAgentOptions !== void 0 ? { agentOptions: requestedChildAgentOptions } : {},
						...maxDepth !== void 0 ? { maxDepth } : {}
					};
					return {
						kind: "activation",
						subagentId: (await runtimeCtx.subagents.startActivation({
							provider: config.provider,
							label: args.description,
							request,
							signal: exec.signal,
							delivery: "parent"
						})).childId
					};
				}
			});
			mounted = {
				subagentProvider,
				definition,
				disposeTool: runtimeCtx.effect(() => {
					const unregister = runtimeCtx.tools.register(definition);
					delegationTools.add(definition);
					return () => {
						delegationTools.delete(definition);
						unregister();
					};
				})
			};
		};
		runtimeCtx.on("subagent/provider-added", (subagentProvider) => {
			if (subagentProvider.name === config.provider && mounted === void 0) mount(subagentProvider);
		});
		runtimeCtx.on("subagent/provider-removed", (name) => {
			if (name !== config.provider || mounted === void 0) return;
			mounted.disposeTool();
			mounted = void 0;
		});
		const present = runtimeCtx.subagents.getProvider(config.provider);
		if (present !== void 0) mount(present);
		else runtimeCtx.logger.info(`subagent provider "${config.provider}" not registered yet; the "${config.toolName ?? "subagent"}" tool will register when it appears`);
		runtimeCtx.systemPrompt.section({
			name: `tool:${toolName}`,
			order: runtimeCtx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
			text: (context) => {
				if (mounted === void 0) return "";
				const visible = [...delegationTools].filter((tool) => runtimeCtx.tools.get(tool.name, context.scope) === tool).map((tool) => tool.name).sort();
				if (visible[0] !== toolName) return "";
				return `Start independent delegations with ${visible.map((name) => `\`${name}\``).join(" or ")} together in one assistant message and continue useful work while they run.`;
			}
		});
		runtimeCtx.systemPrompt.context({
			name: `tool:${toolName}:depth`,
			order: runtimeCtx.systemPrompt.getContextOrder("SUBAGENT_DELEGATION"),
			text: (context) => {
				if (context.agent === void 0 || mounted === void 0 || runtimeCtx.tools.get(toolName, context.scope) !== mounted.definition) return "";
				const maxDepth = runtimeCtx.subagents.resolveMaxDepth(config.maxDepth);
				if (maxDepth === void 0) return "";
				const depth = delegationDepthOf(context.agent);
				if (depth < maxDepth) return "";
				return `Delegation depth for \`${toolName}\`: current ${depth}, maximum ${maxDepth}, remaining levels 0. Do not call \`${toolName}\` at this depth; carry out the work directly.`;
			}
		});
	};
	const compositionScope = scopeOf(ctx);
	if (presets.configured && (session !== void 0 || compositionScope === void 0)) await presets.validate(ctx);
	if (!modelSelectionCapable && (!presets.configured || session !== void 0 || compositionScope === void 0)) {
		install(ctx, void 0);
		return;
	}
	const settings = ctx.get("subagentModelSelection");
	if (modelSelectionCapable && settings === void 0) throw new Error("tool-subagent: `modelSelectionSettings` requires @deepseek-ai/dsh-tool-subagent/model-selection-settings in the Host scope");
	const selectForSession = (target) => selectSubagentModelSelection(ctx, target, modelSelectionCapable);
	if (session !== void 0) {
		install(ctx, selectForSession(session));
		return;
	}
	if (compositionScope === void 0) throw new Error("tool-subagent: standing `modelSelectionSettings` requires a scoped preset Context");
	const agents = ctx.get("agents");
	/* v8 ignore next -- shipped preset compositions always include the Agent registry. */
	if (agents === void 0) throw new Error("tool-subagent: standing `modelSelectionSettings` requires the Agent registry");
	const scopedInstalls = /* @__PURE__ */ new Map();
	const installing = /* @__PURE__ */ new WeakSet();
	let stopped = false;
	const belongsToComposition = (candidate) => scopeChainOf(scopeOf(candidate.ctx)).includes(compositionScope);
	const installScoped = (candidate) => {
		if (stopped || ctx.fiber.state === FIBER_UNLOADING || ctx.fiber.uid === null) return;
		const existing = scopedInstalls.get(candidate);
		if (existing !== void 0) return existing;
		if (installing.has(candidate)) return;
		installing.add(candidate);
		let fiber;
		try {
			const policy = selectForSession(candidate.session);
			fiber = candidate.ctx.inject([
				"tools",
				"subagents",
				"systemPrompt"
			], async (runtimeCtx) => {
				if (presets.configured) await presets.validate(ctx);
				install(runtimeCtx, policy);
			});
		} finally {
			installing.delete(candidate);
		}
		scopedInstalls.set(candidate, fiber);
		return fiber;
	};
	const removeScoped = (candidate) => {
		const fiber = scopedInstalls.get(candidate);
		if (fiber === void 0) return;
		scopedInstalls.delete(candidate);
		/* v8 ignore next 3 -- Cordis Fiber disposal contains registration cleanup failures; this is the final diagnostic sink. */
		fiber.dispose().catch((error) => {
			ctx.logger.warn(`tool-subagent: failed to remove recomposed Agent "${candidate.id}" definitions: ${String(error)}`);
		});
	};
	const reconcileComposedAgents = () => {
		for (const candidate of agents.list()) if (belongsToComposition(candidate)) installScoped(candidate);
		else removeScoped(candidate);
	};
	ctx.on("agent/created", async ({ agent: created }) => {
		await installScoped(created);
	});
	ctx.on("agent/disposed", ({ agent: disposed }) => {
		removeScoped(disposed);
	});
	ctx.on("tools/change", reconcileComposedAgents);
	ctx.effect(() => async () => {
		stopped = true;
		const fibers = [...scopedInstalls.values()];
		scopedInstalls.clear();
		await Promise.all(fibers.map((fiber) => fiber.dispose()));
	});
	reconcileComposedAgents();
}
//#endregion
export { Config, apply, inject, name };
