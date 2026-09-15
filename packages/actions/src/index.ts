import {
  DomainInvariantError,
  type ActionId,
  type CorrelationId,
  type EntityId,
  type SimTime,
} from "@hobbo/domain";

export type ActionOrigin =
  | "player"
  | "rule"
  | "utility"
  | "llm"
  | "replay"
  | "system";

export interface ActionRequest {
  readonly actionId: ActionId;
  readonly actorId: EntityId;
  readonly origin: ActionOrigin;
  readonly requestedAt: SimTime;
  readonly correlationId: CorrelationId;
  readonly input: unknown;
}

export interface ActionContext<TWorldState = unknown> {
  readonly actorId: EntityId;
  readonly simTime: SimTime;
  readonly worldState: Readonly<TWorldState>;
}

export type ActionValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export interface ActionDefinition<TWorldState = unknown> {
  readonly id: ActionId;
  readonly label: string;
  readonly description?: string;
  validate(
    context: ActionContext<TWorldState>,
    input: unknown,
  ): ActionValidation;
}

export type ActionValidationResult<TWorldState = unknown> =
  | {
      readonly ok: true;
      readonly request: ActionRequest;
      readonly definition: ActionDefinition<TWorldState>;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly request: ActionRequest;
    };

export class ActionRegistry<TWorldState = unknown> {
  #definitions = new Map<string, ActionDefinition<TWorldState>>();

  register(definition: ActionDefinition<TWorldState>): void {
    const key = String(definition.id);
    if (this.#definitions.has(key)) {
      throw new DomainInvariantError(`Action already registered: ${key}`);
    }
    this.#definitions.set(key, definition);
  }

  get(actionId: ActionId): ActionDefinition<TWorldState> | undefined {
    return this.#definitions.get(String(actionId));
  }

  list(): readonly ActionDefinition<TWorldState>[] {
    return [...this.#definitions.values()];
  }

  validate(
    request: ActionRequest,
    context: ActionContext<TWorldState>,
  ): ActionValidationResult<TWorldState> {
    if (request.actorId !== context.actorId) {
      return {
        ok: false,
        code: "actor_mismatch",
        message: "Action request actor does not match validation context",
        request,
      };
    }

    const definition = this.get(request.actionId);
    if (definition === undefined) {
      return {
        ok: false,
        code: "unknown_action",
        message: `Unknown action: ${request.actionId}`,
        request,
      };
    }

    const validation = definition.validate(context, request.input);
    if (!validation.ok) {
      return {
        ...validation,
        request,
      };
    }

    return {
      ok: true,
      request,
      definition,
    };
  }
}
