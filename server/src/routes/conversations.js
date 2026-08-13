/**
 * Chat and Quick endpoints.
 *
 * One router serves both modes; the mode lives on the conversation, so there
 * is no second copy of any of this for quick.
 */
import { Router } from "express";
import { z } from "zod";

import {
  createConversationSchema,
  listConversationsQuerySchema,
  postMessageSchema,
  regenerateMessageSchema,
  objectIdSchema,
} from "../../../shared/schemas.js";
import { validate, validateAll } from "../middleware/validate.js";
import { createSseStream } from "../lib/sse.js";
import { createConversationService } from "../services/conversation.js";
import { isAppError } from "../lib/errors.js";

const idParams = z.object({ id: objectIdSchema });

export function conversationsRouter({ config, llm, logger }) {
  const router = Router();
  const service = createConversationService({ config, llm });

  /** Shape a conversation for the wire. */
  const toDto = (c) => ({
    id: String(c._id ?? c.id),
    mode: c.mode,
    title: c.title,
    model: c.model,
    messageCount: c.messageCount,
    totalCostUsd: c.totalCostUsd,
    archivedAt: c.archivedAt ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });

  const toMessageDto = (m) => ({
    id: String(m._id ?? m.id),
    role: m.role,
    content: m.content,
    model: m.model,
    promptTokens: m.promptTokens,
    completionTokens: m.completionTokens,
    costUsd: m.costUsd,
    estimatedUsage: m.estimatedUsage,
    latencyMs: m.latencyMs,
    interrupted: m.interrupted,
    createdAt: m.createdAt,
  });

  router.post("/conversations", validate(createConversationSchema), async (req, res, next) => {
    try {
      const conversation = await service.createConversation(req.body);
      res.status(201).json(toDto(conversation));
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/conversations",
    validate(listConversationsQuerySchema, "query"),
    async (req, res, next) => {
      try {
        const items = await service.listConversations(req.validatedQuery);
        res.json({ items: items.map(toDto) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/conversations/:id", validate(idParams, "params"), async (req, res, next) => {
    try {
      const conversation = await service.getConversation(req.params.id);
      res.json(toDto(conversation));
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/conversations/:id/messages",
    validate(idParams, "params"),
    async (req, res, next) => {
      try {
        // Confirms existence, so a bad id is a 404 rather than an empty list.
        await service.getConversation(req.params.id);
        const messages = await service.listMessages(req.params.id);
        res.json({ items: messages.map(toMessageDto) });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * Post a turn.
   *
   * `stream: true` (the default) upgrades the response to SSE. The non-stream
   * path exists because tests, scripts and non-browser callers should not have
   * to speak SSE to use the API.
   */
  router.post(
    "/conversations/:id/messages",
    validateAll({ params: idParams, body: postMessageSchema }),
    async (req, res, next) => {
      const { content, model, stream } = req.body;

      if (!stream) {
        try {
          const { message, conversation } = await service.sendMessage(req.params.id, {
            content,
            model,
            logger: req.log,
          });
          return res.status(201).json({
            message: toMessageDto(message),
            conversation: toDto(conversation),
          });
        } catch (err) {
          return next(err);
        }
      }

      // Validate before taking over the response: once SSE headers are sent we
      // can no longer produce a clean JSON error.
      let iterator;
      const abort = new AbortController();
      try {
        await service.getConversation(req.params.id);
        iterator = service.streamMessage(req.params.id, {
          content,
          model,
          signal: abort.signal,
          logger: req.log,
        });
      } catch (err) {
        return next(err);
      }

      const sse = createSseStream(req, res);
      sse.onAbort(() => abort.abort());

      try {
        for await (const chunk of iterator) {
          if (chunk.type === "delta") {
            if (!sse.send("delta", { text: chunk.text })) break;
          } else if (chunk.type === "done") {
            sse.send("message", {
              messageId: String(chunk.messageId ?? ""),
              content: chunk.content,
              model: chunk.model,
              usage: chunk.usage,
              latencyMs: chunk.latencyMs,
              interrupted: Boolean(chunk.interrupted),
            });
          }
        }
        sse.done({ ok: true });
      } catch (err) {
        req.log?.error({ err }, "stream failed");
        // The response is already committed as SSE, so the error has to travel
        // as a terminal event rather than a status code.
        sse.fail({
          code: isAppError(err) ? err.code : "INTERNAL_ERROR",
          message: isAppError(err) && err.expose ? err.message : "The model stream failed.",
        });
      }
    },
  );

  router.post(
    "/conversations/:id/regenerate",
    validateAll({ params: idParams, body: regenerateMessageSchema }),
    async (req, res, next) => {
      try {
        const { message, conversation } = await service.regenerate(req.params.id, {
          model: req.body.model,
          logger: req.log,
        });
        res.json({ message: toMessageDto(message), conversation: toDto(conversation) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/conversations/:id/archive",
    validate(idParams, "params"),
    async (req, res, next) => {
      try {
        res.json(toDto(await service.archiveConversation(req.params.id)));
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete("/conversations/:id", validate(idParams, "params"), async (req, res, next) => {
    try {
      res.json(await service.deleteConversation(req.params.id));
    } catch (err) {
      next(err);
    }
  });

  logger?.debug("conversations router mounted");
  return router;
}
