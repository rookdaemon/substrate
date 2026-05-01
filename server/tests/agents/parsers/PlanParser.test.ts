import {
  PlanParser,
  TaskStatus,
  TriggerEvaluator,
} from "../../../src/agents/parsers/PlanParser";

const SIMPLE_PLAN = `# Plan

## Current Goal
Build the login feature

## Tasks
- [ ] Design login form
- [ ] Implement backend auth
- [x] Set up database
`;

const NESTED_PLAN = `# Plan

## Current Goal
Build the app

## Tasks
- [ ] Frontend
  - [ ] Login page
  - [x] Home page
- [ ] Backend
  - [ ] Auth API
  - [ ] User API
    - [ ] GET /users
    - [x] POST /users
`;

const ALL_COMPLETE = `# Plan

## Current Goal
Ship v1

## Tasks
- [x] Build frontend
- [x] Build backend
- [x] Deploy
`;

const EMPTY_PLAN = `# Plan

## Current Goal
Figure out what to do

## Tasks
`;

const DEFERRED_PLAN = `# Plan

## Current Goal
Build with conditions

## Tasks
- [~] Deploy app: WHEN \`exit 0\`
- [ ] Write docs
`;

const DEFERRED_PLAN_BLOCKED = `# Plan

## Current Goal
Build with conditions

## Tasks
- [~] Deploy app: WHEN \`exit 1\`
- [ ] Write docs
`;

const NO_TASKS_SECTION = `# Plan

## Current Goal
Just thinking
`;

const DEFERRED_PLAN_MULTI = `# Plan

## Current Goal
Wait for external events

## Tasks
- [ ] Regular task
- [~] Wait for PRs: WHEN \`gh pr list --state open | grep -q foo\`. Review them.
- [x] Done task
`;

const DEFERRED_ONLY_PLAN = `# Plan

## Current Goal
All deferred

## Tasks
- [~] Waiting task: WHEN \`true\`. Do stuff.
`;

const BLOCKED_PLAN = `# Plan

## Current Goal
Blocked by infra

## Tasks
- [ ] Fix infra **BLOCKED** waiting on Ollama recovery
- [ ] Write docs
`;

const BLOCKED_UNTIL_PLAN = `# Plan

## Current Goal
Waiting on deployment

## Tasks
- [ ] Deploy app blocked-until: 2026-03-15
- [ ] Write release notes
`;

const ALL_BLOCKED_PLAN = `# Plan

## Current Goal
Everything blocked

## Tasks
- [ ] Task A **BLOCKED**
- [ ] Task B blocked-until: tomorrow
`;

const BLOCKED_UNTIL_ANNOTATION_PLAN = `# Plan

## Current Goal
Rate-limited canary

## Tasks
- [ ] Canary calibration cycle <!-- blockedUntil: 2026-03-12T16:03Z -->
- [ ] Write docs
`;

const BLOCKED_UNTIL_STALE_PLAN = `# Plan

## Current Goal
Stale annotation

## Tasks
- [ ] Old blocked task <!-- blockedUntil: 2020-01-01T00:00Z -->
- [ ] Other task
`;

const BLOCKED_UNTIL_MALFORMED_PLAN = `# Plan

## Current Goal
Malformed annotation

## Tasks
- [ ] Malformed task <!-- blockedUntil: not-a-date -->
- [ ] Other task
`;

const BLOCKED_UNTIL_ABSENT_PLAN = `# Plan

## Current Goal
No annotation

## Tasks
- [ ] Normal task
- [ ] Other task
`;

describe("PlanParser", () => {
  describe("parseCurrentGoal", () => {
    it("extracts the current goal text", () => {
      const goal = PlanParser.parseCurrentGoal(SIMPLE_PLAN);
      expect(goal).toBe("Build the login feature");
    });

    it("returns empty string when no current goal section", () => {
      const goal = PlanParser.parseCurrentGoal("# Plan\n\nJust text.");
      expect(goal).toBe("");
    });

    it("trims whitespace from goal", () => {
      const md = "# Plan\n\n## Current Goal\n  Spaces around  \n\n## Tasks";
      const goal = PlanParser.parseCurrentGoal(md);
      expect(goal).toBe("Spaces around");
    });
  });

  describe("parseTasks", () => {
    it("parses top-level unchecked tasks as PENDING", () => {
      const tasks = PlanParser.parseTasks(SIMPLE_PLAN);
      expect(tasks[0].title).toBe("Design login form");
      expect(tasks[0].status).toBe(TaskStatus.PENDING);
      expect(tasks[0].id).toBe("task-1");
    });

    it("parses checked tasks as COMPLETE", () => {
      const tasks = PlanParser.parseTasks(SIMPLE_PLAN);
      const dbTask = tasks.find((t) => t.title === "Set up database");
      expect(dbTask).toBeDefined();
      expect(dbTask!.status).toBe(TaskStatus.COMPLETE);
    });

    it("assigns sequential IDs", () => {
      const tasks = PlanParser.parseTasks(SIMPLE_PLAN);
      expect(tasks.map((t) => t.id)).toEqual(["task-1", "task-2", "task-3"]);
    });

    it("parses nested tasks with dot-notation IDs", () => {
      const tasks = PlanParser.parseTasks(NESTED_PLAN);
      const frontend = tasks.find((t) => t.id === "task-1");
      expect(frontend).toBeDefined();
      expect(frontend!.children).toHaveLength(2);
      expect(frontend!.children[0].id).toBe("task-1.1");
      expect(frontend!.children[0].title).toBe("Login page");
      expect(frontend!.children[1].id).toBe("task-1.2");
      expect(frontend!.children[1].title).toBe("Home page");
      expect(frontend!.children[1].status).toBe(TaskStatus.COMPLETE);
    });

    it("parses deeply nested tasks", () => {
      const tasks = PlanParser.parseTasks(NESTED_PLAN);
      const backend = tasks.find((t) => t.id === "task-2");
      expect(backend).toBeDefined();
      const userApi = backend!.children.find((t) => t.id === "task-2.2");
      expect(userApi).toBeDefined();
      expect(userApi!.children).toHaveLength(2);
      expect(userApi!.children[0].id).toBe("task-2.2.1");
      expect(userApi!.children[0].title).toBe("GET /users");
      expect(userApi!.children[1].id).toBe("task-2.2.2");
      expect(userApi!.children[1].status).toBe(TaskStatus.COMPLETE);
    });

    it("returns empty array when no tasks", () => {
      expect(PlanParser.parseTasks(EMPTY_PLAN)).toEqual([]);
    });

    it("returns empty array when no tasks section", () => {
      expect(PlanParser.parseTasks(NO_TASKS_SECTION)).toEqual([]);
    });

    it("parses [~] tasks as DEFERRED with trigger extracted", () => {
      const tasks = PlanParser.parseTasks(DEFERRED_PLAN);
      expect(tasks[0].status).toBe(TaskStatus.DEFERRED);
      expect(tasks[0].trigger).toBe("exit 0");
    });
  });

  describe("findNextActionable", () => {
    it("returns the first PENDING leaf task (depth-first)", async () => {
      const tasks = PlanParser.parseTasks(NESTED_PLAN);
      const next = await PlanParser.findNextActionable(tasks);
      expect(next).toBeDefined();
      expect(next!.id).toBe("task-1.1");
      expect(next!.title).toBe("Login page");
    });

    it("skips completed tasks", async () => {
      const tasks = PlanParser.parseTasks(SIMPLE_PLAN);
      const next = await PlanParser.findNextActionable(tasks);
      expect(next!.title).toBe("Design login form");
    });

    it("returns null when all tasks are complete", async () => {
      const tasks = PlanParser.parseTasks(ALL_COMPLETE);
      expect(await PlanParser.findNextActionable(tasks)).toBeNull();
    });

    it("returns null when there are no tasks", async () => {
      expect(await PlanParser.findNextActionable([])).toBeNull();
    });

    it("skips deferred tasks when no evaluator is provided", async () => {
      const tasks = PlanParser.parseTasks(DEFERRED_PLAN);
      const next = await PlanParser.findNextActionable(tasks);
      expect(next!.title).toBe("Write docs");
    });

    it("activates a deferred task when evaluator returns true", async () => {
      const evaluator: TriggerEvaluator = { evaluate: async () => true };
      const tasks = PlanParser.parseTasks(DEFERRED_PLAN);
      const next = await PlanParser.findNextActionable(tasks, evaluator);
      expect(next).toBeDefined();
      expect(next!.status).toBe(TaskStatus.DEFERRED);
      expect(next!.trigger).toBe("exit 0");
    });

    it("skips deferred task when evaluator returns false", async () => {
      const evaluator: TriggerEvaluator = { evaluate: async () => false };
      const tasks = PlanParser.parseTasks(DEFERRED_PLAN_BLOCKED);
      const next = await PlanParser.findNextActionable(tasks, evaluator);
      expect(next!.title).toBe("Write docs");
    });
  });

  describe("markComplete", () => {
    it("toggles a task from [ ] to [x]", () => {
      const updated = PlanParser.markComplete(SIMPLE_PLAN, "task-1");
      expect(updated).toContain("- [x] Design login form");
    });

    it("does not change already complete tasks", () => {
      const updated = PlanParser.markComplete(SIMPLE_PLAN, "task-3");
      expect(updated).toContain("- [x] Set up database");
      expect(updated).toBe(SIMPLE_PLAN);
    });

    it("marks nested tasks complete", () => {
      const updated = PlanParser.markComplete(NESTED_PLAN, "task-1.1");
      expect(updated).toContain("- [x] Login page");
    });

    it("throws for unknown task ID", () => {
      expect(() => PlanParser.markComplete(SIMPLE_PLAN, "task-99")).toThrow(
        "Task task-99 not found"
      );
    });
  });

  describe("markBlockedUntil", () => {
    it("adds a blockedUntil annotation to a task", () => {
      const blockedUntil = new Date("2026-05-02T05:00:00.000Z");
      const updated = PlanParser.markBlockedUntil(SIMPLE_PLAN, "task-2", blockedUntil);
      expect(updated).toContain(
        "- [ ] Implement backend auth <!-- blockedUntil: 2026-05-02T05:00:00.000Z -->"
      );
    });

    it("replaces an existing blockedUntil annotation", () => {
      const plan = `# Plan\n\n## Tasks\n- [ ] Send report <!-- blockedUntil: 2026-05-01T05:00:00.000Z -->\n`;
      const updated = PlanParser.markBlockedUntil(plan, "task-1", new Date("2026-05-02T05:00:00.000Z"));
      expect(updated).toContain("<!-- blockedUntil: 2026-05-02T05:00:00.000Z -->");
      expect(updated).not.toContain("2026-05-01T05:00:00.000Z");
    });

    it("throws for unknown task ID", () => {
      expect(() => PlanParser.markBlockedUntil(SIMPLE_PLAN, "task-99", new Date())).toThrow(
        "Task task-99 not found"
      );
    });
  });

  describe("isComplete", () => {
    it("returns true when all tasks are complete", () => {
      const tasks = PlanParser.parseTasks(ALL_COMPLETE);
      expect(PlanParser.isComplete(tasks)).toBe(true);
    });

    it("returns false when some tasks are pending", () => {
      const tasks = PlanParser.parseTasks(SIMPLE_PLAN);
      expect(PlanParser.isComplete(tasks)).toBe(false);
    });

    it("returns true for empty task list", () => {
      expect(PlanParser.isComplete([])).toBe(true);
    });
  });

  describe("isEmpty", () => {
    it("returns true for empty task list", () => {
      expect(PlanParser.isEmpty([])).toBe(true);
    });

    it("returns false when tasks exist", () => {
      const tasks = PlanParser.parseTasks(SIMPLE_PLAN);
      expect(PlanParser.isEmpty(tasks)).toBe(false);
    });
  });

  describe("deferred tasks ([~])", () => {
    describe("parseTasks", () => {
      it("parses [~] tasks as DEFERRED", () => {
        const tasks = PlanParser.parseTasks(DEFERRED_PLAN_MULTI);
        const deferred = tasks.find((t) => t.title.startsWith("Wait for PRs"));
        expect(deferred).toBeDefined();
        expect(deferred!.status).toBe(TaskStatus.DEFERRED);
      });

      it("extracts trigger from WHEN `...` syntax", () => {
        const tasks = PlanParser.parseTasks(DEFERRED_PLAN_MULTI);
        const deferred = tasks.find((t) => t.title.startsWith("Wait for PRs"));
        expect(deferred!.trigger).toBe(
          "gh pr list --state open | grep -q foo"
        );
      });

      it("leaves trigger undefined when no WHEN clause", () => {
        const tasks = PlanParser.parseTasks(SIMPLE_PLAN);
        expect(tasks[0].trigger).toBeUndefined();
      });
    });

    describe("findNextActionable", () => {
      it("skips DEFERRED tasks when no evaluator provided", async () => {
        const tasks = PlanParser.parseTasks(DEFERRED_PLAN_MULTI);
        const next = await PlanParser.findNextActionable(tasks);
        expect(next).toBeDefined();
        expect(next!.title).toBe("Regular task");
      });

      it("returns null when only DEFERRED tasks remain and no evaluator", async () => {
        const tasks = PlanParser.parseTasks(DEFERRED_ONLY_PLAN);
        expect(await PlanParser.findNextActionable(tasks)).toBeNull();
      });

      it("activates a DEFERRED task when evaluator returns true", async () => {
        const tasks = PlanParser.parseTasks(DEFERRED_ONLY_PLAN);
        const evaluator: TriggerEvaluator = { evaluate: async () => true };
        const next = await PlanParser.findNextActionable(tasks, evaluator);
        expect(next).toBeDefined();
        expect(next!.status).toBe(TaskStatus.DEFERRED);
        expect(next!.title).toContain("Waiting task");
      });

      it("keeps skipping when evaluator returns false", async () => {
        const tasks = PlanParser.parseTasks(DEFERRED_ONLY_PLAN);
        const evaluator: TriggerEvaluator = { evaluate: async () => false };
        expect(await PlanParser.findNextActionable(tasks, evaluator)).toBeNull();
      });

      it("skips DEFERRED tasks without a trigger even with evaluator", async () => {
        const plan = `# Plan\n\n## Current Goal\nTest\n\n## Tasks\n- [~] No condition here\n`;
        const tasks = PlanParser.parseTasks(plan);
        const evaluator: TriggerEvaluator = { evaluate: async () => true };
        expect(await PlanParser.findNextActionable(tasks, evaluator)).toBeNull();
      });
    });

    describe("markComplete", () => {
      it("marks a DEFERRED task as complete ([~] → [x])", () => {
        const updated = PlanParser.markComplete(DEFERRED_PLAN_MULTI, "task-2");
        expect(updated).toContain("- [x] Wait for PRs");
        expect(updated).not.toContain("- [~] Wait for PRs");
      });
    });

    describe("isComplete", () => {
      it("returns false when DEFERRED tasks exist", () => {
        const tasks = PlanParser.parseTasks(DEFERRED_ONLY_PLAN);
        expect(PlanParser.isComplete(tasks)).toBe(false);
      });
    });
  });

  describe("blocked tasks (**BLOCKED** / blocked-until:)", () => {
    describe("parseTasks", () => {
      it("parses task with **BLOCKED** marker as BLOCKED status", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_PLAN);
        expect(tasks[0].status).toBe(TaskStatus.BLOCKED);
      });

      it("parses task with blocked-until: marker as BLOCKED status", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_PLAN);
        expect(tasks[0].status).toBe(TaskStatus.BLOCKED);
      });

      it("leaves non-blocked tasks as PENDING", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_PLAN);
        expect(tasks[1].status).toBe(TaskStatus.PENDING);
      });

      it("preserves the full title including the BLOCKED marker", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_PLAN);
        expect(tasks[0].title).toContain("**BLOCKED**");
      });
    });

    describe("findNextActionable", () => {
      it("skips BLOCKED tasks — does not dispatch them", async () => {
        const tasks = PlanParser.parseTasks(BLOCKED_PLAN);
        const next = await PlanParser.findNextActionable(tasks);
        expect(next).toBeDefined();
        expect(next!.title).toBe("Write docs");
      });

      it("skips tasks with blocked-until: marker", async () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_PLAN);
        const next = await PlanParser.findNextActionable(tasks);
        expect(next).toBeDefined();
        expect(next!.title).toBe("Write release notes");
      });

      it("returns null when all tasks are BLOCKED", async () => {
        const tasks = PlanParser.parseTasks(ALL_BLOCKED_PLAN);
        const next = await PlanParser.findNextActionable(tasks);
        expect(next).toBeNull();
      });
    });

    describe("findBlockedTasks", () => {
      it("returns all BLOCKED tasks", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_PLAN);
        const blocked = PlanParser.findBlockedTasks(tasks);
        expect(blocked).toHaveLength(1);
        expect(blocked[0].title).toContain("**BLOCKED**");
      });

      it("returns empty array when no tasks are blocked", () => {
        const tasks = PlanParser.parseTasks(SIMPLE_PLAN);
        expect(PlanParser.findBlockedTasks(tasks)).toHaveLength(0);
      });

      it("returns multiple blocked tasks", () => {
        const tasks = PlanParser.parseTasks(ALL_BLOCKED_PLAN);
        const blocked = PlanParser.findBlockedTasks(tasks);
        expect(blocked).toHaveLength(2);
      });
    });
  });

  describe("appendTasksToExistingPlan", () => {
    it("appends tasks to existing ## Tasks section", () => {
      const result = PlanParser.appendTasksToExistingPlan(SIMPLE_PLAN, ["- [ ] New task"]);
      expect(result).toContain("- [ ] New task");
      expect(result).toContain("- [ ] Design login form");
    });

    it("preserves multi-line ## Current Goal section intact", () => {
      const plan = [
        "# Plan",
        "",
        "## Current Goal",
        "Line one of the goal",
        "Line two of the goal",
        "Line three — 250+ lines of operational record",
        "",
        "## Tasks",
        "- [x] Done task",
      ].join("\n");

      const result = PlanParser.appendTasksToExistingPlan(plan, ["- [ ] New task"]);

      expect(result).toContain("Line one of the goal");
      expect(result).toContain("Line two of the goal");
      expect(result).toContain("Line three — 250+ lines of operational record");
      expect(result).toContain("- [ ] New task");
    });

    it("empty existing produces valid plan structure (bootstrap case)", () => {
      const result = PlanParser.appendTasksToExistingPlan("", ["- [ ] First task"]);
      expect(result).toBe("# Plan\n\n## Tasks\n- [ ] First task\n");
    });

    it("whitespace-only existing is treated as bootstrap case", () => {
      const result = PlanParser.appendTasksToExistingPlan("   \n  ", ["- [ ] First task"]);
      expect(result).toBe("# Plan\n\n## Tasks\n- [ ] First task\n");
    });

    it("creates ## Tasks section when none exists", () => {
      const plan = "# Plan\n\n## Notes\nSome notes.";
      const result = PlanParser.appendTasksToExistingPlan(plan, ["- [ ] New task"]);
      expect(result).toContain("## Tasks");
      expect(result).toContain("- [ ] New task");
      expect(result).toContain("## Notes");
    });

    it("inserts tasks before a section that follows ## Tasks", () => {
      const plan = [
        "# Plan",
        "",
        "## Tasks",
        "- [x] Existing",
        "",
        "## Notes",
        "Keep this.",
      ].join("\n");

      const result = PlanParser.appendTasksToExistingPlan(plan, ["- [ ] New task"]);

      expect(result).toContain("- [ ] New task");
      expect(result).toContain("## Notes");
      // New task must appear before ## Notes
      expect(result.indexOf("- [ ] New task")).toBeLessThan(result.indexOf("## Notes"));
    });
  });

  describe("blockedUntil HTML comment annotation (<!-- blockedUntil: ISO8601 -->)", () => {
    const FUTURE = new Date("2026-03-12T17:00Z"); // after the annotation timestamp
    const BEFORE = new Date("2026-03-12T15:00Z"); // before the annotation timestamp

    describe("parseTasks", () => {
      it("parses blockedUntil date from inline HTML comment", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_ANNOTATION_PLAN);
        expect(tasks[0].blockedUntil).toBeDefined();
        expect(tasks[0].blockedUntil).toEqual(new Date("2026-03-12T16:03Z"));
      });

      it("leaves blockedUntil undefined when annotation is absent", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_ABSENT_PLAN);
        expect(tasks[0].blockedUntil).toBeUndefined();
      });

      it("leaves blockedUntil undefined when annotation is malformed", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_MALFORMED_PLAN);
        expect(tasks[0].blockedUntil).toBeUndefined();
      });

      it("parses stale blockedUntil dates correctly", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_STALE_PLAN);
        expect(tasks[0].blockedUntil).toEqual(new Date("2020-01-01T00:00Z"));
      });

      it("does not set BLOCKED status from blockedUntil annotation", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_ANNOTATION_PLAN);
        expect(tasks[0].status).toBe(TaskStatus.PENDING);
      });
    });

    describe("findNextActionable with now parameter", () => {
      it("skips task when now < blockedUntil (future annotation)", async () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_ANNOTATION_PLAN);
        const next = await PlanParser.findNextActionable(tasks, undefined, BEFORE);
        expect(next).toBeDefined();
        expect(next!.title).toBe("Write docs");
      });

      it("dispatches task when now >= blockedUntil (stale annotation)", async () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_STALE_PLAN);
        const next = await PlanParser.findNextActionable(tasks, undefined, FUTURE);
        expect(next).toBeDefined();
        expect(next!.title).toContain("Old blocked task");
      });

      it("dispatches task normally when annotation is absent", async () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_ABSENT_PLAN);
        const next = await PlanParser.findNextActionable(tasks, undefined, BEFORE);
        expect(next).toBeDefined();
        expect(next!.title).toBe("Normal task");
      });

      it("dispatches task normally when annotation is malformed (fail-open)", async () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_MALFORMED_PLAN);
        const next = await PlanParser.findNextActionable(tasks, undefined, BEFORE);
        expect(next).toBeDefined();
        expect(next!.title).toContain("Malformed task");
      });

      it("dispatches normally when now parameter is omitted (backwards-compatible)", async () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_ANNOTATION_PLAN);
        const next = await PlanParser.findNextActionable(tasks);
        expect(next).toBeDefined();
        expect(next!.title).toContain("Canary calibration cycle");
      });
    });

    describe("findTimeBlockedTasks", () => {
      it("returns tasks with blockedUntil in the future", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_ANNOTATION_PLAN);
        const blocked = PlanParser.findTimeBlockedTasks(tasks, BEFORE);
        expect(blocked).toHaveLength(1);
        expect(blocked[0].title).toContain("Canary calibration cycle");
      });

      it("returns empty array when blockedUntil is in the past (stale)", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_STALE_PLAN);
        const blocked = PlanParser.findTimeBlockedTasks(tasks, FUTURE);
        expect(blocked).toHaveLength(0);
      });

      it("returns empty array when no annotation present", () => {
        const tasks = PlanParser.parseTasks(BLOCKED_UNTIL_ABSENT_PLAN);
        const blocked = PlanParser.findTimeBlockedTasks(tasks, BEFORE);
        expect(blocked).toHaveLength(0);
      });
    });
  });
});
