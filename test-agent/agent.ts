import Anthropic from "@anthropic-ai/sdk";
import { chromium, Browser, Page } from "playwright";

const client = new Anthropic();
const BASE_URL = process.env.BASE_URL || "http://localhost:8888";

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "screenshot",
    description:
      "Take a screenshot of the current page. Use this to see what is on screen before deciding what to do.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "navigate",
    description: "Navigate the browser to a URL.",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "click",
    description: "Click an element. Prefer CSS selectors like #id or .class.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector" },
        text: {
          type: "string",
          description:
            "Optional: click the first element whose visible text contains this string",
        },
      },
      required: [],
    },
  },
  {
    name: "type",
    description: "Focus an input and type text into it.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector for the input" },
        text: { type: "string" },
        clear: {
          type: "boolean",
          description: "Clear existing value first (default true)",
        },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "press",
    description: "Press a keyboard key. Examples: n, c, f, t, ?, Escape, Enter",
    input_schema: {
      type: "object" as const,
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "wait",
    description: "Wait for a number of milliseconds.",
    input_schema: {
      type: "object" as const,
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "evaluate",
    description:
      "Run JavaScript in the page context and return the result as a string.",
    input_schema: {
      type: "object" as const,
      properties: {
        code: { type: "string", description: "JS expression to evaluate" },
      },
      required: ["code"],
    },
  },
  {
    name: "assert",
    description:
      "Record a test assertion (pass or fail). Always call this to document what you verified.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Short test name" },
        passed: { type: "boolean" },
        detail: {
          type: "string",
          description: "What you observed (whether pass or fail)",
        },
      },
      required: ["name", "passed", "detail"],
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

type Result = { passed: boolean; name: string; detail: string };
const results: Result[] = [];

async function runTool(
  name: string,
  input: Record<string, unknown>,
  page: Page
): Promise<string> {
  switch (name) {
    case "screenshot": {
      const buf = await page.screenshot({ type: "png" });
      // Return as base64 so Claude can see it via vision
      return `data:image/png;base64,${buf.toString("base64")}`;
    }

    case "navigate": {
      await page.goto(input.url as string, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      return `Navigated to ${input.url}`;
    }

    case "click": {
      if (input.text) {
        await page
          .locator(`text=${input.text}`)
          .first()
          .click({ timeout: 5000 });
      } else {
        await page.click(input.selector as string, { timeout: 5000 });
      }
      await page.waitForTimeout(300);
      return `Clicked ${input.selector ?? input.text}`;
    }

    case "type": {
      const sel = input.selector as string;
      if (input.clear !== false) await page.fill(sel, "");
      await page.type(sel, input.text as string, { delay: 40 });
      return `Typed into ${sel}`;
    }

    case "press": {
      await page.keyboard.press(input.key as string);
      await page.waitForTimeout(300);
      return `Pressed ${input.key}`;
    }

    case "wait": {
      await page.waitForTimeout(input.ms as number);
      return `Waited ${input.ms}ms`;
    }

    case "evaluate": {
      const val = await page.evaluate(input.code as string);
      return String(val ?? "undefined");
    }

    case "assert": {
      const r: Result = {
        name: input.name as string,
        passed: input.passed as boolean,
        detail: input.detail as string,
      };
      results.push(r);
      const icon = r.passed ? "✓" : "✗";
      console.log(`  ${icon} ${r.name}: ${r.detail}`);
      return r.passed ? "PASS" : "FAIL";
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

async function runAgent(page: Page, scenario: string, label: string): Promise<void> {
  console.log(`\n${'═'.repeat(60)}\n${label}\n${'─'.repeat(60)}`);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: scenario,
    },
  ];

  // Agentic loop — Claude calls tools until it stops
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      tools: TOOLS,
      messages,
      system: `You are a QA agent testing a web app called Task Planner at ${BASE_URL}.
Use screenshot often to see what's on screen. Use assert to record every check you make.
Be thorough. When done testing, stop calling tools and summarise the results.`,
    });

    // Collect tool use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    // If Claude stopped or there are no tools, we're done
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      const textBlock = response.content.find((b) => b.type === "text");
      if (textBlock && "text" in textBlock) console.log(textBlock.text);
      break;
    }

    // Add assistant message
    messages.push({ role: "assistant", content: response.content });

    // Execute all tools and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      let output: string;
      try {
        output = await runTool(
          block.name,
          block.input as Record<string, unknown>,
          page
        );
      } catch (err) {
        output = `ERROR: ${(err as Error).message}`;
      }

      // Screenshots need to be sent as image content
      if (block.name === "screenshot" && output.startsWith("data:image")) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: output.replace("data:image/png;base64,", ""),
              },
            },
          ],
        });
      } else {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// ─── Test scenarios ───────────────────────────────────────────────────────────

const SCENARIOS = [
  // ── 1. Page load ────────────────────────────────────────────────────────────
  `Navigate to ${BASE_URL} and take a screenshot.
   Assert: the page loads (not blank/error), the header is visible, and at least one main navigation tab (Tasks/Calendar/Kanban/Stats/Settings) is present.`,

  // ── 2. Keyboard shortcuts ────────────────────────────────────────────────────
  `Make sure the page is at ${BASE_URL}. Click somewhere on the empty page background to ensure nothing is focused.
   Test each keyboard shortcut:
   - Press 'n' → new task modal should open. Screenshot. Press Escape to close.
   - Press 'c' → daily check-in view should open. Screenshot. Press Escape or navigate back.
   - Press 'f' → focus mode picker should open. Screenshot. Press Escape to close.
   - Press 't' → should switch to the Task Planner tab. Screenshot.
   - Press '?' → keyboard shortcuts overlay should appear listing shortcut keys. Screenshot. Press Escape to close.
   Assert each: either it worked or it failed, with what you observed.`,

  // ── 3. Add a task (full fields) ──────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Press 'n' to open the Add Task modal.
   Screenshot to see all available fields. Then:
   1. Type "Agent test task" into the title field.
   2. If a Notes/Description field exists, type "Added by test agent".
   3. If a Priority dropdown exists, set it to High.
   4. If a Deadline date picker exists, pick any future date.
   5. Click Save (or the primary save button).
   Assert: the modal closes and "Agent test task" appears somewhere in the task list.`,

  // ── 4. Edit and delete a task ────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Find the task titled "Agent test task" created earlier.
   1. Click its edit button (pencil icon or Edit button on the card).
   2. Screenshot the edit modal.
   3. Change the title to "Agent test task EDITED".
   4. Save it.
   5. Assert the updated title "Agent test task EDITED" is visible in the list.
   6. Now find that task and delete it (trash/delete button, confirm if prompted).
   7. Assert the task is gone from the list.`,

  // ── 5. Subtasks ──────────────────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Press 'n' to open a new task.
   1. Enter title "Subtask parent task".
   2. Find and click the "Subtasks" tab inside the modal.
   3. Screenshot the subtasks panel.
   4. Add two subtasks: "Sub 1" and "Sub 2".
   5. Save the task.
   6. Find "Subtask parent task" in the list and assert a subtask badge (e.g. "0/2") is visible.
   7. Clean up: delete the task.`,

  // ── 6. Starred tasks ─────────────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Press 'n' to add a task titled "Star me task". Save it.
   1. Find "Star me task" in the list.
   2. Click its star/heart icon to star it.
   3. Screenshot and assert the star icon changed state (filled vs outline, or color change).
   4. Click it again to unstar.
   5. Assert it returned to unstarred state.
   6. Delete the task.`,

  // ── 7. Bucket management ─────────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Open the Buckets modal (look for a "Buckets" button in the header or a folder icon).
   1. Screenshot the current bucket list.
   2. Add a new bucket named "Agent Test Bucket" (find the name input and Add button).
   3. Assert "Agent Test Bucket" appears in the bucket list.
   4. Find that bucket and rename it to "Renamed Bucket" (look for a rename/edit button).
   5. Assert the rename worked.
   6. Delete "Renamed Bucket".
   7. Assert it's gone.
   8. Close the modal.`,

  // ── 8. Tab navigation ────────────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Test each main navigation tab:
   1. Click the Calendar tab → screenshot, assert a month/grid view appears.
   2. Click the Kanban tab → screenshot, assert columns (To Do / In Progress / Done or similar) appear.
   3. Click the Stats tab → screenshot, assert charts or stats are visible.
   4. Click the Export tab → screenshot, assert export buttons (CSV etc.) are visible.
   5. Click Settings tab or the gear button → screenshot, assert settings options appear.
   6. Navigate back to the Tasks tab.
   Assert each tab switch either works or fails with what you observed.`,

  // ── 9. Settings – name and theme ─────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Open Settings (gear icon or Settings tab).
   1. Screenshot the settings page.
   2. Find the "Name" or username input field. Change the name to "Test User Agent". Save it.
   3. Assert the name was accepted (toast, or heading changes).
   4. Find the theme selector. Click a different theme (e.g. "Obsidian" or "Amber").
   5. Screenshot after theme change and assert the page colors changed.
   6. Switch back to the original/default theme.`,

  // ── 10. Pomodoro timer ────────────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Find the Pomodoro timer (it may be in the Focus view or always visible).
   If it's not visible, press 'f' to open focus mode.
   1. Screenshot the timer area.
   2. Find and click the "1 min" preset button.
   3. Assert the timer shows 1:00.
   4. Click the Start button.
   5. Wait 3 seconds.
   6. Assert the timer is counting down (less than 1:00).
   7. Click Pause/Stop.
   8. Assert the timer stopped.
   9. Click Reset.`,

  // ── 11. Daily check-in flow ───────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Press 'n' and add a task called "Check-in test task". Save.
   Now start the daily check-in (press 'c' or click the red Daily check-in button).
   1. Screenshot the check-in card view.
   2. Assert a task card is shown with title, action buttons (Skip / Done / Update).
   3. Click "Skip" on the first card.
   4. Assert it moves to the next card or shows completion.
   5. Press Escape or look for a way to exit check-in.
   6. Delete "Check-in test task" afterwards.`,

  // ── 12. Search / filter ───────────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Add a uniquely-named task: "ZZZ unique search test ZZZ". Save.
   1. Find the search input (usually a text box at the top of the task list).
   2. Type "ZZZ unique" into it.
   3. Screenshot and assert only "ZZZ unique search test ZZZ" is visible (other tasks filtered out).
   4. Clear the search input.
   5. Assert all tasks are shown again.
   6. Delete "ZZZ unique search test ZZZ".`,

  // ── 13. Data export ───────────────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Click the Export tab.
   1. Screenshot the export page.
   2. Look for a "Save data" or "Export JSON" button and assert it exists.
   3. Look for a "CSV" export button and assert it exists.
   4. Assert the export tab loaded without errors.`,

  // ── 14. Feedback modal ────────────────────────────────────────────────────────
  `Navigate to ${BASE_URL}. Find and open the Feedback modal (look in settings or a feedback button/link).
   1. Screenshot the modal.
   2. Assert it has a message textarea and a submit button.
   3. Select a feedback type if a selector is present.
   4. Type "Test feedback from agent" in the message area.
   5. Close the modal without submitting (press Escape or Cancel).
   Assert the modal opened and closed correctly.`,
];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: false, slowMo: 100 });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const LABELS = [
      "1. Page load",
      "2. Keyboard shortcuts",
      "3. Add a task (full fields)",
      "4. Edit and delete a task",
      "5. Subtasks",
      "6. Starred tasks",
      "7. Bucket management",
      "8. Tab navigation",
      "9. Settings – name and theme",
      "10. Pomodoro timer",
      "11. Daily check-in flow",
      "12. Search / filter",
      "13. Data export",
      "14. Feedback modal",
    ];
    for (let i = 0; i < SCENARIOS.length; i++) {
      await runAgent(page, SCENARIOS[i], LABELS[i] ?? `Scenario ${i + 1}`);
    }

    // Summary
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    console.log(`\n══════════════════════════════`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log(`\nFailed:`);
      results.filter((r) => !r.passed).forEach((r) => console.log(`  ✗ ${r.name}: ${r.detail}`));
    }
  } finally {
    await browser?.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
