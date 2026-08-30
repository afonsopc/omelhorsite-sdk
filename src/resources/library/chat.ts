/** The `library.chat` namespace: the streaming study assistant, its payloads, limits and helpers. */

import { OmsApiError, OmsError } from "../../errors";
import { Resource, supportsResponseStreaming } from "../../http";
import type { RequestOptions } from "../../types";
import type { BookId } from "./types";
import { idSegment } from "./types";

/**
 * Requests per minute allowed against `POST /books/:id/chat`.
 *
 * Keyed on the `Authorization` header when there is one, and on the client IP
 * when there is not - so a cookie-authenticated web client shares one budget
 * with every other visitor behind the same address. Over it: `429`.
 */
export const BOOK_CHAT_RATE_LIMIT_PER_MINUTE = 15;

/**
 * Largest chat request body the server agrees to parse: 512 KiB. Over it,
 * `413`.
 *
 * This is a bound on what is PARSED, not on what reaches the model - the model
 * caps below are applied afterwards.
 */
export const BOOK_CHAT_MAX_BODY_BYTES = 524_288;

/**
 * Characters of {@link BookChatContext.text} the assistant will read.
 *
 * Silently truncated server-side, not refused. Sending a whole chapter costs
 * the bytes and buys nothing past this point.
 */
export const BOOK_CHAT_MAX_CONTEXT_CHARS = 12_000;

/** Turns of history the assistant reads, newest kept. */
export const BOOK_CHAT_MAX_HISTORY_MESSAGES = 12;

/** Characters kept per history turn. */
export const BOOK_CHAT_MAX_MESSAGE_CHARS = 4_000;

/** Characters kept across the whole history. */
export const BOOK_CHAT_MAX_HISTORY_CHARS = 8_000;

/** One turn of the conversation, as the client remembers it. */
export interface BookChatTurn {
  /**
   * Only `"user"` and `"assistant"` reach the model: everything else is
   * dropped, precisely so a client cannot inject a `"system"` turn into our
   * own framing.
   */
  readonly role: "user" | "assistant";
  readonly content: string;
}

/**
 * The passage the question is about. The CLIENT decides what that is - the
 * current selection, the chapter on screen, or whatever its search index
 * retrieved - and the server only frames it.
 */
export interface BookChatContext {
  readonly kind: "selection" | "chapter" | "passages";
  /** Chapter or section title, for the framing line. Truncated to 200 chars. */
  readonly title?: string;
  /** Truncated to {@link BOOK_CHAT_MAX_CONTEXT_CHARS} server-side, in silence. */
  readonly text: string;
}

/** Arguments for {@link BookChatNamespace.stream} and {@link BookChatNamespace.ask}. */
export interface BookChatInput {
  /**
   * The whole conversation, oldest first, INCLUDING the question being asked.
   * There is no server-side session: what you do not send did not happen.
   */
  readonly messages: readonly BookChatTurn[];
  /** The passage in front of the reader. Omit it and the assistant is told so. */
  readonly context?: BookChatContext | null;
}

/**
 * One decoded SSE frame from the chat stream.
 *
 * Exactly one field is set per frame. `delta` carries text to append, `done`
 * marks a complete answer, and `error` is a failure that happened AFTER the
 * `200` was written.
 */
export interface BookChatEvent {
  readonly delta?: string;
  readonly done?: boolean;
  readonly error?: string;
}

/** Why a chat stream failed. See {@link BookChatError}. */
export type BookChatFailureReason =
  /** The server wrote an `error` frame: generation failed after the 200. */
  | "assistant_unavailable"
  /** The stream ended without a `done` frame, so the answer is cut short. */
  | "truncated";

/**
 * The chat stream failed AFTER the response status was written.
 *
 * This is not an {@link OmsApiError}, and that is the whole point of it
 * existing. The server writes `200` and the SSE headers before the
 * model has produced a single token, so anything that goes wrong from then on -
 * the inference sidecar erroring, the proxy dropping a stream that went quiet -
 * arrives INSIDE a successful response. Code that decides success by status
 * alone reports a truncated answer, or an empty one, as a complete reply.
 *
 * `code` is `"server_error"`, so `error.retryable` is `true`: asking again is
 * the right move for both reasons, subject to
 * {@link BOOK_CHAT_RATE_LIMIT_PER_MINUTE}.
 */
export class BookChatError extends OmsError {
  static override readonly errorName: string = "BookChatError";

  /** Which of the two post-200 failures this is. */
  readonly reason: BookChatFailureReason;
  /** Text already yielded before the failure. Usually worth showing, marked as incomplete. */
  readonly partial: string;

  constructor(message: string, reason: BookChatFailureReason, partial: string, url?: string) {
    super(message, "server_error", { method: "POST", ...(url === undefined ? {} : { url }), attempts: 1 });
    this.reason = reason;
    this.partial = partial;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), reason: this.reason, partialLength: this.partial.length };
  }
}

/**
 * True when this error is the assistant refusing because every generation slot
 * is taken.
 *
 * The server fails closed rather than queueing - a caller parked waiting for
 * a slot would be holding the very server thread the slots exist to protect -
 * so the answer is `503` with `"The assistant is busy, try again in a moment"`.
 * It is transient and it is NOT a rate limit: the caller did nothing wrong and
 * `Retry-After` is not sent, so back off on your own and try again.
 */
export function isBookChatBusy(error: unknown): boolean {
  return error instanceof OmsApiError && error.status === 503;
}

/**
 * Whether {@link BookChatNamespace.stream} will deliver this answer in pieces
 * on THIS runtime.
 *
 * `true` in a browser and in Bun, `false` in React Native, whose `fetch` hands
 * the whole body over at the end and has no `ReadableStream` at all. Both
 * paths reach the same endpoint and produce the same final text; only the
 * arrival differs, and this is the question to ask before a UI promises a
 * typing indicator. A typing indicator that never types is worse than a
 * spinner that admits it is waiting.
 *
 * Read it at the point of use, never cached at module load: a host may install
 * a polyfill after the SDK is imported.
 */
export function bookChatIsIncremental(): boolean {
  return supportsResponseStreaming();
}

/** Options for {@link BookChatNamespace.stream} and {@link BookChatNamespace.ask}. */
export interface BookChatStreamOptions extends RequestOptions {
  /**
   * How long to wait for the NEXT piece of the answer before giving up, in
   * milliseconds. Defaults to the transport's 45 seconds; `0` disables it.
   *
   * A silence limit, not a total: an answer that keeps producing runs as long
   * as it likes. It exists because a stalled sidecar once answered `200` and
   * then said nothing for two minutes at a time, and `await reader.read()` has
   * no deadline of its own, so the chat panel span for as long as the tab
   * stayed open. `timeoutMs` cannot cover this: it is disposed the moment the
   * headers arrive, or no stream could outlive it.
   *
   * It has to sit well clear of a cold model's first token - the 8B model has
   * to be paged in before it can answer - which is why 45 seconds and not five.
   *
   * IGNORED on the buffered path (React Native), where there is one read and
   * the caller's `signal` is what bounds it.
   */
  readonly silenceTimeoutMs?: number;
}

/**
 * The `library.chat` namespace: the reader's study assistant.
 *
 * `POST /books/:id/chat` is the only STREAMING endpoint in the whole API.
 *
 * ## What it costs, and why it refuses rather than queues
 *
 * One request parks a server thread for the whole generation, tens of seconds
 * on the local model. The server caps how many generations run at once and
 * FAILS CLOSED when they are all taken - a caller parked waiting for a slot
 * would be holding the very thread the slots exist to protect. That refusal is
 * a `503`; see {@link isBookChatBusy}. On top of it, one client may only START
 * {@link BOOK_CHAT_RATE_LIMIT_PER_MINUTE} generations a minute, so a loop
 * cannot take whatever slot frees up next.
 *
 * ## The client owns the conversation
 *
 * There is no server-side session and no history storage. Every request carries
 * the whole conversation and the passage the question is about; what you do not
 * send did not happen. The server owns the framing and the caps, and it drops
 * any role other than `user` and `assistant` so a client cannot inject a
 * `system` turn into our own prompt.
 */
export class BookChatNamespace extends Resource {
  /**
   * `POST /books/:id/chat` - asks the assistant and yields the answer as it
   * arrives.
   *
   * Yields TEXT DELTAS, already unwrapped from their SSE frames: concatenating
   * everything this yields is the complete answer. Framing is handled here
   * because a chunk is not a frame - a `data:` line can arrive split across two
   * network chunks - and every client that tried to parse the raw stream itself
   * got that wrong at least once.
   *
   * ## The two runtimes do not deliver the same way, and the difference is real
   *
   * - **browser and Bun**: one yield per delta, as the model produces it. A
   *   typing UI works, and abandoning the loop (a `break`, or an early
   *   `return`) cancels the reader, closes the connection, and the server
   *   notices the disconnect and RELEASES ITS GENERATION SLOT. Stopping early
   *   genuinely stops the work.
   * - **React Native**: ONE yield, containing the entire answer, after the
   *   server has finished generating. RN's `fetch` is `XMLHttpRequest` under a
   *   shim, the whole body is accumulated natively and handed over at the end,
   *   and `response.body` does not exist. This is not a gap to polyfill.
   *   Consequences to design around: a typing indicator will sit still and then
   *   snap to the finished answer, so ask {@link bookChatIsIncremental} and
   *   show a spinner instead; and `break`ing out of the loop cancels NOTHING,
   *   because the request already completed - only an `AbortSignal` can stop
   *   the work, and only by tearing down the whole request.
   *
   * The final text is identical on both. Nothing is lost, nothing is
   * reordered, and no chunk boundary is invented to make one look like the
   * other.
   *
   * ## A `200` does not mean the answer worked
   *
   * The status and the SSE headers are written before the model has produced a
   * token, so every later failure is in-band. Two of them, both raised as
   * {@link BookChatError} with the text already yielded attached:
   *
   * - an `error` frame (`reason: "assistant_unavailable"`) - the inference
   *   client raised, and the upstream message is deliberately withheld because
   *   it can carry the sidecar's internals;
   * - the stream ending without a `done` frame (`reason: "truncated"`) - the
   *   proxy dropped a stream that went quiet, or the connection was cut
   *   mid-answer. Returning quietly here would report a half-answer as a
   *   complete one, which is the whole reason the `done` frame exists.
   *
   * @example
   * ```ts
   * let answer = "";
   * for await (const delta of oms.library.chat.stream(bookId, { messages, context })) {
   *   answer += delta;
   *   render(answer);            // one paint per delta, or one paint on RN
   * }
   * ```
   *
   * @throws {OmsAuthError} 401 `"Session required"` when anonymous.
   * @throws {OmsApiError} 404 `"Book not found"` when the book is not viewable;
   *   413 `"Request too big"` over {@link BOOK_CHAT_MAX_BODY_BYTES}; 429 over
   *   {@link BOOK_CHAT_RATE_LIMIT_PER_MINUTE}; 503 when every generation slot
   *   is taken ({@link isBookChatBusy}).
   * @throws {BookChatError} for either post-`200` failure. Check `reason` and
   *   `partial`.
   * @throws {OmsTimeoutError} when the stream goes quiet for
   *   {@link BookChatStreamOptions.silenceTimeoutMs}. Streaming path only.
   */
  async *stream(
    bookId: BookId,
    input: BookChatInput,
    options: BookChatStreamOptions = {},
  ): AsyncGenerator<string, void, undefined> {
    const path = `/books/${idSegment(bookId)}/chat`;
    const body: Record<string, unknown> = { messages: [...input.messages] };
    if (input.context !== undefined) body["context"] = input.context;

    let buffer = "";
    let produced = "";

    for await (const chunk of this.http.streamText("POST", path, { ...options, body })) {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;

        const data = line.slice("data:".length).trim();
        if (data.length === 0) continue;

        let event: BookChatEvent;
        try {
          event = JSON.parse(data) as BookChatEvent;
        } catch {
          // A partial or unrecognised frame. Never fatal: the buffer above
          // already guarantees whole lines, so this is the server having
          // written something we do not model, not a split payload.
          continue;
        }

        if (event.error !== undefined) {
          throw new BookChatError(
            "The assistant failed while answering. The request itself succeeded - this arrived inside a 200.",
            "assistant_unavailable",
            produced,
            this.http.url(path),
          );
        }
        if (event.delta !== undefined && event.delta.length > 0) {
          produced += event.delta;
          yield event.delta;
        }
        // The one frame that means the answer is complete. Returning here runs
        // this generator's `finally` chain, which cancels the reader and lets
        // the server release its generation slot.
        if (event.done === true) return;
      }
    }

    throw new BookChatError(
      "The answer stopped without the frame that marks it finished, so it is cut short. The connection was dropped " +
        "mid-generation - usually the proxy giving up on a stream that went quiet.",
      "truncated",
      produced,
      this.http.url(path),
    );
  }

  /**
   * The same call as {@link stream}, waited out and handed back as one string.
   *
   * For anywhere a partial answer has nowhere to go. It is exactly `stream`
   * drained into a buffer, so it raises the same
   * errors for the same reasons - including {@link BookChatError} on a
   * truncated stream, which is the case a naive `await response.text()` would
   * hand back as a successful half-answer.
   *
   * It does NOT make the request cheaper or faster anywhere. On a browser and
   * on Bun the answer still streams in and is merely accumulated here; on React
   * Native it was going to arrive in one piece regardless. Choose it because
   * the CALLER has no use for pieces, never as a way to avoid streaming.
   */
  async ask(bookId: BookId, input: BookChatInput, options: BookChatStreamOptions = {}): Promise<string> {
    let answer = "";
    for await (const delta of this.stream(bookId, input, options)) answer += delta;
    return answer;
  }
}
