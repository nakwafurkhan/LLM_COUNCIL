/**
 * Chat and Quick.
 *
 * These are ONE service with two parameter sets, not two handlers. The brief's
 * requirement — and the reason it matters — is that a bug fixed in chat is
 * fixed in quick automatically, and neither can silently drift from the other.
 * The only differences between the modes are declared in MODE_PROFILES below;
 * every line of logic past that point is shared.
 */
import { Conversation } from "../models/Conversation.js";
import { Message } from "../models/Message.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { resolveModel } from "./llm/index.js";

/**
 * The complete set of differences between the two modes.
 *
 * If you find yourself adding an `if (mode === "quick")` anywhere else in this
 * file, it belongs here instead.
 */
export function modeProfiles(config) {
  return {
    chat: {
      model: config.CHAT_MODEL,
      maxTokens: config.CHAT_MAX_TOKENS,
      timeoutMs: config.MESH_TIMEOUT_MS,
      systemPrompt:
        "You are a thoughtful assistant. Give complete, well-reasoned answers. " +
        "Show your reasoning when it helps the reader judge the answer.",
    },
    quick: {
      model: config.QUICK_MODEL,
      maxTokens: config.QUICK_MAX_TOKENS,
      timeoutMs: config.QUICK_TIMEOUT_MS,
      systemPrompt:
        "You are a fast, terse assistant. Answer in as few words as the question " +
        "genuinely needs. No preamble, no restating the question, no filler.",
    },
  };
}

export function createConversationService({ config, llm }) {
  const profiles = modeProfiles(config);

  function profileFor(mode) {
    const profile = profiles[mode];
    if (!profile) throw new ValidationError(`Unknown mode "${mode}"`);
    return profile;
  }

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  async function getConversation(id) {
    const conversation = await Conversation.findById(id);
    if (!conversation) throw new NotFoundError(`Conversation ${id} not found`);
    return conversation;
  }

  async function listConversations({ mode, includeArchived, limit }) {
    const filter = {};
    if (mode) filter.mode = mode;
    if (!includeArchived) filter.archivedAt = null;
    return Conversation.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();
  }

  async function listMessages(conversationId) {
    return Message.find({ conversationId, supersededAt: null }).sort({ createdAt: 1 }).lean();
  }

  /* ---------------------------------------------------------------- */
  /* Context assembly                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Build the transcript to send upstream.
   *
   * Rolling window plus rolling summary, rather than the whole history
   * forever: an unbounded transcript is what makes a long thread quietly cost
   * more on every single turn until it hits the context limit and fails.
   */
  async function buildTranscript(conversation, { profile }) {
    const window = config.CHAT_CONTEXT_WINDOW;

    const recent = await Message.find({
      conversationId: conversation._id,
      supersededAt: null,
    })
      .sort({ createdAt: -1 })
      .limit(window)
      .lean();

    recent.reverse();

    const messages = [{ role: "system", content: profile.systemPrompt }];

    if (conversation.summary) {
      messages.push({
        role: "system",
        content: `Summary of earlier turns in this conversation:\n${conversation.summary}`,
      });
    }

    for (const m of recent) {
      messages.push({ role: m.role, content: m.content });
    }

    return messages;
  }

  /**
   * Fold aged-out turns into the rolling summary.
   *
   * Best-effort: a summarisation failure must never fail the user's actual
   * request, so it is logged and skipped rather than thrown.
   */
  async function maybeSummarize(conversation, { logger }) {
    if (conversation.messageCount < config.CHAT_SUMMARY_TRIGGER) return;

    const window = config.CHAT_CONTEXT_WINDOW;
    const older = await Message.find({
      conversationId: conversation._id,
      supersededAt: null,
    })
      .sort({ createdAt: 1 })
      .limit(Math.max(0, conversation.messageCount - window))
      .lean();

    if (older.length === 0) return;

    const transcript = older.map((m) => `${m.role}: ${m.content}`).join("\n");

    try {
      const { content } = await llm.askModel({
        model: config.QUICK_MODEL, // summarising is not worth frontier pricing
        messages: [
          {
            role: "system",
            content:
              "Summarise this conversation excerpt. Preserve decisions, facts, names, " +
              "numbers and open questions. Drop pleasantries. Be compact.",
          },
          {
            role: "user",
            content: conversation.summary
              ? `Existing summary:\n${conversation.summary}\n\nNew turns:\n${transcript}`
              : transcript,
          },
        ],
        maxTokens: 512,
        timeoutMs: config.QUICK_TIMEOUT_MS,
      });

      conversation.summary = content;
      conversation.summarizedUpTo = older.at(-1).createdAt;
      await conversation.save();
    } catch (err) {
      logger?.warn(
        { err, conversationId: conversation._id },
        "summarisation failed; continuing",
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Writes                                                            */
  /* ---------------------------------------------------------------- */

  async function createConversation({ mode = "chat", title, model }) {
    const profile = profileFor(mode);
    return Conversation.create({
      mode,
      title: title || "New conversation",
      model: resolveModel(model, profile.model, config.allowedModels),
    });
  }

  async function appendUserMessage(conversation, content) {
    const message = await Message.create({
      conversationId: conversation._id,
      role: "user",
      content,
    });

    // First user turn names the conversation.
    if (conversation.messageCount === 0) {
      conversation.title = Conversation.deriveTitle(content);
    }
    conversation.messageCount += 1;
    await conversation.save();

    return message;
  }

  async function persistAssistantMessage(
    conversation,
    { content, model, usage, latencyMs, interrupted = false },
  ) {
    const message = await Message.create({
      conversationId: conversation._id,
      role: "assistant",
      content,
      model,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      costUsd: usage?.costUsd ?? 0,
      estimatedUsage: Boolean(usage?.estimated),
      latencyMs,
      interrupted,
    });

    conversation.messageCount += 1;
    conversation.totalCostUsd = round6(conversation.totalCostUsd + (usage?.costUsd ?? 0));
    await conversation.save();

    return message;
  }

  /**
   * Non-streaming turn. Same context assembly and persistence as the streaming
   * path — only the transport differs.
   */
  async function sendMessage(conversationId, { content, model, logger }) {
    const conversation = await getConversation(conversationId);
    const profile = profileFor(conversation.mode);
    const chosenModel = resolveModel(model, conversation.model, config.allowedModels);

    await appendUserMessage(conversation, content);
    const messages = await buildTranscript(conversation, { profile });

    const result = await llm.askModel({
      model: chosenModel,
      messages,
      maxTokens: profile.maxTokens,
      timeoutMs: profile.timeoutMs,
    });

    const assistant = await persistAssistantMessage(conversation, {
      content: result.content,
      model: chosenModel,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });

    await maybeSummarize(conversation, { logger });

    return { conversation, message: assistant };
  }

  /**
   * Streaming turn.
   *
   * Yields the same chunk shapes the adapter does, and persists on completion.
   * If `signal` aborts mid-stream the partial text is still written, flagged
   * `interrupted` — the user watched those tokens arrive, so losing them on
   * reload would be a worse lie than keeping them.
   */
  async function* streamMessage(conversationId, { content, model, signal, logger }) {
    const conversation = await getConversation(conversationId);
    const profile = profileFor(conversation.mode);
    const chosenModel = resolveModel(model, conversation.model, config.allowedModels);

    await appendUserMessage(conversation, content);
    const messages = await buildTranscript(conversation, { profile });

    let accumulated = "";
    let finalChunk = null;
    const startedAt = Date.now();

    try {
      for await (const chunk of llm.streamModel({
        model: chosenModel,
        messages,
        maxTokens: profile.maxTokens,
        timeoutMs: profile.timeoutMs,
        signal,
      })) {
        if (chunk.type === "delta") {
          accumulated += chunk.text;
          yield chunk;
        } else if (chunk.type === "done") {
          finalChunk = chunk;
        }
        if (signal?.aborted) break;
      }
    } finally {
      // `finally` so an abort, a throw, or a clean finish all persist.
      const interrupted = Boolean(signal?.aborted) || !finalChunk;
      if (accumulated || finalChunk) {
        const assistant = await persistAssistantMessage(conversation, {
          content: finalChunk?.content ?? accumulated,
          model: chosenModel,
          usage: finalChunk?.usage,
          latencyMs: finalChunk?.latencyMs ?? Date.now() - startedAt,
          interrupted,
        });
        finalChunk = {
          ...(finalChunk ?? { type: "done" }),
          messageId: assistant._id,
          interrupted,
        };
      }
    }

    await maybeSummarize(conversation, { logger });

    if (finalChunk) yield finalChunk;
  }

  /** Drop the last assistant turn and answer again. */
  async function regenerate(conversationId, { model, logger }) {
    const conversation = await getConversation(conversationId);
    const last = await Message.findOne({
      conversationId: conversation._id,
      role: "assistant",
      supersededAt: null,
    }).sort({ createdAt: -1 });

    if (!last) throw new NotFoundError("Nothing to regenerate yet");

    last.supersededAt = new Date();
    await last.save();
    conversation.messageCount = Math.max(0, conversation.messageCount - 1);
    await conversation.save();

    const profile = profileFor(conversation.mode);
    const chosenModel = resolveModel(model, conversation.model, config.allowedModels);
    const messages = await buildTranscript(conversation, { profile });

    const result = await llm.askModel({
      model: chosenModel,
      messages,
      maxTokens: profile.maxTokens,
      timeoutMs: profile.timeoutMs,
    });

    const assistant = await persistAssistantMessage(conversation, {
      content: result.content,
      model: chosenModel,
      usage: result.usage,
      latencyMs: result.latencyMs,
    });

    logger?.info({ conversationId, model: chosenModel }, "regenerated last turn");
    return { conversation, message: assistant };
  }

  async function archiveConversation(id) {
    const conversation = await getConversation(id);
    conversation.archivedAt = new Date();
    await conversation.save();
    return conversation;
  }

  async function deleteConversation(id) {
    const conversation = await getConversation(id);
    await Message.deleteMany({ conversationId: conversation._id });
    await conversation.deleteOne();
    return { deleted: true, id };
  }

  return {
    profiles,
    createConversation,
    getConversation,
    listConversations,
    listMessages,
    buildTranscript,
    sendMessage,
    streamMessage,
    regenerate,
    archiveConversation,
    deleteConversation,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
