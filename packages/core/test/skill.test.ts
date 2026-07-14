import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Flag } from "@opencode-ai/core/flag/flag"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.live("enterprise mode ignores URL sources while retaining embedded skills", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = Flag.OPENCODE_ENTERPRISE_MODE
        Flag.OPENCODE_ENTERPRISE_MODE = true
        pulls = 0
        return original
      }),
      () =>
        Effect.gen(function* () {
          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "url", url: "hTtPs://example.test/skills/" })
            editor.source({
              type: "embedded",
              skill: SkillV2.Info.make({
                name: "bundled",
                location: AbsolutePath.make("/bundled/SKILL.md"),
                content: "# Bundled",
              }),
            })
          })

          expect(yield* skill.sources()).toEqual([
            {
              type: "embedded",
              skill: SkillV2.Info.make({
                name: "bundled",
                location: AbsolutePath.make("/bundled/SKILL.md"),
                content: "# Bundled",
              }),
            },
          ])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["bundled"])
          expect(pulls).toBe(0)
        }),
      (original) =>
        Effect.sync(() => {
          Flag.OPENCODE_ENTERPRISE_MODE = original
        }),
    ),
  )

  it.live("enterprise mode does not expose skills cached from an earlier URL source", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const original = Flag.OPENCODE_ENTERPRISE_MODE
            Flag.OPENCODE_ENTERPRISE_MODE = false
            return original
          }),
          () =>
            Effect.gen(function* () {
              yield* Effect.promise(async () => {
                await fs.mkdir(path.join(tmp.path, "remote"), { recursive: true })
                await write(tmp.path, "remote", "Remote cached skill")
              })
              const url = "https://example.test/cached/"
              urls.set(url, [AbsolutePath.make(tmp.path)])
              const skill = yield* SkillV2.Service
              yield* skill.transform((editor) => editor.source({ type: "url", url }))
              expect((yield* skill.list()).map((item) => item.name)).toEqual(["remote"])

              Flag.OPENCODE_ENTERPRISE_MODE = true
              expect(yield* skill.sources()).toEqual([])
              expect(yield* skill.list()).toEqual([])
            }),
          (original) =>
            Effect.sync(() => {
              Flag.OPENCODE_ENTERPRISE_MODE = original
            }),
        ),
      ),
    ),
  )

  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )
})
