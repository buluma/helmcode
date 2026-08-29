import * as Schema from "effect/Schema";

/**
 * A Linear GraphQL request failed at the transport, HTTP, or GraphQL layer.
 */
export class LinearApiError extends Schema.TaggedErrorClass<LinearApiError>()("LinearApiError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    return `Linear ${this.operation} failed: ${this.detail}`;
  }
}

export class LinearNotConfiguredError extends Schema.TaggedErrorClass<LinearNotConfiguredError>()(
  "LinearNotConfiguredError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Linear is not configured: ${this.detail}`;
  }
}

export const LinearError = Schema.Union([LinearApiError, LinearNotConfiguredError]);
export type LinearError = typeof LinearError.Type;
