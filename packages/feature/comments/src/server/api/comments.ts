/**
 * /api/comments — P8+ migration
 *
 * Code-comment CRUD (GET/POST/PUT/DELETE).
 */
import { Effect } from "effect"
import {
  getCommentsFilePath,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import {
  FSError,
  NotFoundError,
  ValidationError,
} from "@cockpit/effect-core"

export interface CodeComment {
  id: string
  filePath: string
  startLine: number
  endLine: number
  content: string
  selectedText?: string
  createdAt: number
  updatedAt?: number
}

interface CommentsData {
  comments: CodeComment[]
}

const readComments = (
  cwd: string
): Effect.Effect<CommentsData, FSError> =>
  Effect.tryPromise({
    try: () =>
      readJsonFile<CommentsData>(getCommentsFilePath(cwd), {
        comments: [],
      }),
    catch: (cause) =>
      new FSError({ path: getCommentsFilePath(cwd), op: "read", cause }),
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd")
    const filePath = sp.get("filePath")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const data = yield* readComments(cwd)
    if (filePath) {
      return ok({
        comments: data.comments.filter((c) => c.filePath === filePath),
      })
    }
    return ok(data)
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      filePath?: string
      startLine?: number
      endLine?: number
      content?: string
      selectedText?: string
    }
    if (
      !body.cwd ||
      !body.filePath ||
      body.startLine === undefined ||
      body.endLine === undefined ||
      body.content === undefined
    ) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|filePath|startLine|endLine|content",
          reason: "missing",
        })
      )
    }
    const { cwd, filePath, startLine, endLine, content, selectedText } = body
    const path = getCommentsFilePath(cwd)
    const newComment: CodeComment = {
      id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      filePath,
      startLine,
      endLine,
      content,
      ...(selectedText ? { selectedText } : {}),
      createdAt: Date.now(),
    }
    // Locked read-modify-write so concurrent comment adds/deletes don't clobber each other.
    yield* Effect.tryPromise({
      try: () =>
        withFileLock(path, async () => {
          const data = await readJsonFile<CommentsData>(path, { comments: [] })
          data.comments.push(newComment)
          await writeJsonFile(path, data)
        }),
      catch: (cause) => new FSError({ path, op: "write", cause }),
    })
    return ok({ comment: newComment })
  })
)

export const PUT = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      id?: string
      content?: string
    }
    if (!body.cwd || !body.id || body.content === undefined) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|id|content",
          reason: "missing",
        })
      )
    }
    const { cwd, id, content } = body
    const path = getCommentsFilePath(cwd)
    const updated = yield* Effect.tryPromise({
      try: () =>
        withFileLock(path, async () => {
          const data = await readJsonFile<CommentsData>(path, { comments: [] })
          const idx = data.comments.findIndex((c) => c.id === id)
          if (idx === -1) return null
          data.comments[idx] = {
            ...data.comments[idx],
            content,
            updatedAt: Date.now(),
          }
          await writeJsonFile(path, data)
          return data.comments[idx]
        }),
      catch: (cause) => new FSError({ path, op: "write", cause }),
    })
    if (!updated) {
      return yield* Effect.fail(new NotFoundError({ resource: "comment", id }))
    }
    return ok({ comment: updated })
  })
)

export const DELETE = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd")
    const id = sp.get("id")
    const all = sp.get("all")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const path = getCommentsFilePath(cwd)
    if (all === "true") {
      yield* Effect.tryPromise({
        try: () => withFileLock(path, () => writeJsonFile(path, { comments: [] })),
        catch: (cause) => new FSError({ path, op: "write", cause }),
      })
      return ok({ success: true })
    }
    if (!id) {
      return yield* Effect.fail(
        new ValidationError({ field: "id", reason: "missing" })
      )
    }
    const removed = yield* Effect.tryPromise({
      try: () =>
        withFileLock(path, async () => {
          const data = await readJsonFile<CommentsData>(path, { comments: [] })
          const idx = data.comments.findIndex((c) => c.id === id)
          if (idx === -1) return false
          data.comments.splice(idx, 1)
          await writeJsonFile(path, data)
          return true
        }),
      catch: (cause) => new FSError({ path, op: "write", cause }),
    })
    if (!removed) {
      return yield* Effect.fail(new NotFoundError({ resource: "comment", id }))
    }
    return ok({ success: true })
  })
)
