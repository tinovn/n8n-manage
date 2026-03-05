import { Injectable, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Task, TaskStatus } from './task.model';

@Injectable()
export class TasksService {
  private tasks = new Map<string, Task>();

  create(description: string): Task {
    const task: Task = {
      id: uuidv4(),
      description,
      status: TaskStatus.PENDING,
      createdAt: new Date(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new NotFoundException(`Task with ID '${taskId}' not found.`);
    }
    return task;
  }

  update(taskId: string, status: TaskStatus, data?: { result?: any; error?: string }) {
    const task = this.get(taskId);
    task.status = status;
    if (data?.result) task.result = data.result;
    if (data?.error) task.error = data.error;
    if (status === TaskStatus.COMPLETED || status === TaskStatus.FAILED) {
      task.finishedAt = new Date();
    }
    this.tasks.set(taskId, task);
  }

  getRecentTasksSummary(limit = 3) {
    const summary: Record<string, Task[]> = {
      pending: [],
      running: [],
      completed: [],
      failed: [],
    };
    const sortedTasks = Array.from(this.tasks.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    for (const task of sortedTasks) {
      const statusKey = task.status;
      if (summary[statusKey] && summary[statusKey].length < limit) {
        summary[statusKey].push(task);
      }
    }
    return summary;
  }
}
