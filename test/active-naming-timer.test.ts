import assert from "node:assert/strict";
import test from "node:test";
import { ActiveNamingTimer, type ScheduledTask, type TaskScheduler } from "../src/index.ts";

class FakeTask implements ScheduledTask {
  cancelled = false;
  unreferenced = false;

  constructor(readonly callback: () => void) {}

  cancel(): void {
    this.cancelled = true;
  }

  unref(): void {
    this.unreferenced = true;
  }

  fire(): void {
    if (!this.cancelled) this.callback();
  }
}

function fakeScheduler(): { schedule: TaskScheduler; tasks: FakeTask[]; delays: number[] } {
  const tasks: FakeTask[] = [];
  const delays: number[] = [];
  return {
    tasks,
    delays,
    schedule: (delayMs, callback) => {
      delays.push(delayMs);
      const task = new FakeTask(callback);
      tasks.push(task);
      return task;
    },
  };
}

test("ActiveNamingTimer schedules one unreferenced callback", () => {
  const fake = fakeScheduler();
  const timer = new ActiveNamingTimer(fake.schedule);
  let calls = 0;

  assert.equal(timer.schedule(60_000, () => calls++), true);
  assert.equal(timer.schedule(10, () => calls++), false);
  assert.deepEqual(fake.delays, [60_000]);
  assert.equal(fake.tasks[0]?.unreferenced, true);
  assert.equal(timer.scheduled, true);

  fake.tasks[0]?.fire();
  assert.equal(calls, 1);
  assert.equal(timer.scheduled, false);
});

test("ActiveNamingTimer cancellation prevents the callback and permits rescheduling", () => {
  const fake = fakeScheduler();
  const timer = new ActiveNamingTimer(fake.schedule);
  let calls = 0;

  timer.schedule(60_000, () => calls++);
  timer.cancel();
  assert.equal(fake.tasks[0]?.cancelled, true);
  assert.equal(timer.scheduled, false);

  fake.tasks[0]?.fire();
  assert.equal(calls, 0);
  assert.equal(timer.schedule(30_000, () => calls++), true);
});
