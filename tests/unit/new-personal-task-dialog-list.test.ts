// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createPersonalTask = vi.hoisted(() => vi.fn());
const createTask = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/tasks/actions", () => ({ createPersonalTask, createTask }));
vi.mock("@/app/(app)/tasks/repeat-picker", () => ({
  NO_REPEAT: "none",
  RepeatPicker: () => null,
  saveRepeatAfterCreate: vi.fn(async () => undefined),
}));
vi.mock("@/components/ui/rich-text-editor", () => ({ RichTextEditor: () => null }));

import { NewPersonalTaskDialog } from "@/app/(app)/tasks/new-personal-task-dialog";

/**
 * THE LIST ON SCREEN IS THE LIST THE TASK GOES IN.
 *
 * `/tasks?list=A` to `/tasks?list=B` is one page with a different search param,
 * so this dialog stays mounted and only its props change. Its list used to be
 * seeded into state on mount: the first list opened was right, and every list
 * after it showed its own name while posting the first one's id. For somebody
 * who works in both departments the server accepts that pair, so the task was
 * filed under the other team with no error at all.
 */
const ACADS = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMISSIONS = "aaaaaaaa-0000-4000-8000-000000000002";

const lists = [
  { id: ACADS, name: "Acads list", department_id: "dept-acads" },
  { id: ADMISSIONS, name: "Admissions list", department_id: "dept-admissions" },
];

const dialog = (defaultListId: string | null) =>
  createElement(NewPersonalTaskDialog, {
    lists,
    colleagues: [],
    departmentId: "dept-acads",
    selfId: "me",
    defaultListId,
  });

async function addTask(title: string) {
  fireEvent.click(screen.getByRole("button", { name: /new task/i }));
  const input = await screen.findByLabelText(/what are you working on/i);
  fireEvent.change(input, { target: { value: title } });
  fireEvent.submit(input.closest("form")!);
}

describe("NewPersonalTaskDialog files into the list being read", () => {
  beforeEach(() => {
    createPersonalTask.mockReset();
    createPersonalTask.mockResolvedValue({ ok: true, data: { taskId: "task" } });
  });

  afterEach(cleanup);

  it("the first list opened", async () => {
    render(dialog(ADMISSIONS));
    await addTask("First");

    await waitFor(() => expect(createPersonalTask).toHaveBeenCalledTimes(1));
    expect(createPersonalTask.mock.calls[0]![0].list_id).toBe(ADMISSIONS);
  });

  it("a second list, moved to without leaving the page", async () => {
    const view = render(dialog(ACADS));
    view.rerender(dialog(ADMISSIONS));
    await addTask("Second");

    await waitFor(() => expect(createPersonalTask).toHaveBeenCalledTimes(1));
    expect(createPersonalTask.mock.calls[0]![0].list_id).toBe(ADMISSIONS);
  });

  it("no list after a list: the picker, at No list", async () => {
    const view = render(dialog(ACADS));
    view.rerender(dialog(null));
    await addTask("Unlisted");

    await waitFor(() => expect(createPersonalTask).toHaveBeenCalledTimes(1));
    expect(createPersonalTask.mock.calls[0]![0].list_id).toBeNull();
  });
});
