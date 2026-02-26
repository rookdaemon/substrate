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
});
