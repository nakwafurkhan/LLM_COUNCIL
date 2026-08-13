/**
 * Zod validation middleware.
 *
 * Every route input goes through this against a schema from shared/schemas.js.
 * A malformed body is a 400 with a field-level list — never a 500 from a
 * downstream null-deref.
 *
 * The parsed (and therefore defaulted + coerced) value replaces the raw input,
 * so handlers only ever see validated data.
 */
import { ValidationError } from "../lib/errors.js";

function toFields(zodError) {
  return zodError.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * @param {import("zod").ZodTypeAny} schema
 * @param {"body"|"query"|"params"} source
 */
export function validate(schema, source = "body") {
  return function validateMiddleware(req, _res, next) {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      return next(new ValidationError(`Invalid request ${source}`, toFields(result.error)));
    }
    // req.query is a getter on Express 5; assign to a parallel field instead.
    if (source === "query") req.validatedQuery = result.data;
    else req[source] = result.data;
    next();
  };
}

/** Validate params and body in one pass when a route needs both. */
export function validateAll({ body, query, params }) {
  const steps = [
    params && validate(params, "params"),
    query && validate(query, "query"),
    body && validate(body, "body"),
  ].filter(Boolean);

  return function validateAllMiddleware(req, res, next) {
    let i = 0;
    const run = (err) => {
      if (err || i >= steps.length) return next(err);
      steps[i++](req, res, run);
    };
    run();
  };
}
