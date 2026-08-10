import type {
  CommentFloorPage,
  CommentFloorProgress,
  CommentRecord,
} from "./types";

export const COMMENT_FLOOR_PAGE_SIZE = 40;

export interface ProcessCommentFloorsOptions {
  roots: readonly CommentRecord[];
  threads: CommentFloorProgress[];
  fetchPage: (
    root: CommentRecord,
    thread: CommentFloorProgress,
  ) => Promise<CommentFloorPage>;
  /** Persist matching rows before the thread cursor is allowed to advance. */
  persistPage: (
    root: CommentRecord,
    thread: CommentFloorProgress,
    page: CommentFloorPage,
  ) => Promise<void>;
  /** Persist the advanced thread cursor/count after every successful page. */
  checkpointPage: (
    root: CommentRecord,
    thread: CommentFloorProgress,
    page: CommentFloorPage,
  ) => Promise<void>;
  /** Stop after the current page has been durably checkpointed. */
  shouldStopAfterPage?: (
    root: CommentRecord,
    thread: CommentFloorProgress,
    page: CommentFloorPage,
  ) => boolean;
}

export function normalizeCommentFloorThreads(value: unknown): CommentFloorProgress[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid comment floor checkpoint.");
  const parents = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid comment floor checkpoint.");
    }
    const thread = raw as Partial<CommentFloorProgress>;
    if (
      typeof thread.parentCommentId !== "string" || thread.parentCommentId.length === 0 ||
      parents.has(thread.parentCommentId) ||
      !Number.isInteger(thread.nextTime) || thread.nextTime! < -1 ||
      !Number.isInteger(thread.pageNo) || thread.pageNo! < 1 ||
      !Number.isInteger(thread.pagesProcessed) || thread.pagesProcessed! < 0 ||
      !Number.isInteger(thread.repliesProcessed) || thread.repliesProcessed! < 0 ||
      (thread.declaredReplies !== undefined &&
        (!Number.isInteger(thread.declaredReplies) || thread.declaredReplies < 0)) ||
      typeof thread.done !== "boolean"
    ) {
      throw new Error("Invalid comment floor checkpoint.");
    }
    parents.add(thread.parentCommentId);
    return {
      parentCommentId: thread.parentCommentId,
      nextTime: thread.nextTime!,
      pageNo: thread.pageNo!,
      pagesProcessed: thread.pagesProcessed!,
      repliesProcessed: thread.repliesProcessed!,
      declaredReplies: thread.declaredReplies,
      done: thread.done,
    };
  });
}

export function pendingCommentFloorRoots(threads: readonly CommentFloorProgress[]): CommentRecord[] {
  return threads
    .filter((thread) => !thread.done)
    .map((thread) => ({
      commentId: thread.parentCommentId,
      userId: "",
      content: "",
    }));
}

export function commentFloorsComplete(threads: readonly CommentFloorProgress[] | undefined): boolean {
  return (threads ?? []).every((thread) => thread.done);
}

/**
 * Resumes each discovered floor one page at a time. Only hasMore=false owns
 * completion: upstream replyCount/totalCount can be stale after moderation.
 */
export async function processCommentFloors(options: ProcessCommentFloorsOptions): Promise<void> {
  for (const root of options.roots) {
    let thread = options.threads.find((candidate) => candidate.parentCommentId === root.commentId);
    if (!thread && !root.replyCount) continue;
    if (!thread) {
      thread = {
        parentCommentId: root.commentId,
        nextTime: -1,
        pageNo: 1,
        pagesProcessed: 0,
        repliesProcessed: 0,
        declaredReplies: root.replyCount,
        done: false,
      };
      options.threads.push(thread);
    }
    thread.declaredReplies ??= root.replyCount;
    if (thread.done) continue;
    while (!thread.done) {
      const page = await options.fetchPage(root, thread);
      if (page.parentCommentId !== thread.parentCommentId) {
        throw new Error(`Comment floor parent mismatch for ${thread.parentCommentId}.`);
      }
      await options.persistPage(root, thread, page);
      thread.pagesProcessed += 1;
      thread.repliesProcessed += page.comments.length;
      if (page.hasMore) {
        if (!Number.isInteger(page.nextTime) || page.nextTime! <= thread.nextTime) {
          throw new Error(`Comment floor ${thread.parentCommentId} did not advance its time cursor.`);
        }
        thread.nextTime = page.nextTime!;
        thread.pageNo += 1;
      } else {
        thread.done = true;
      }
      await options.checkpointPage(root, thread, page);
      if (options.shouldStopAfterPage?.(root, thread, page)) return;
    }
  }
}
