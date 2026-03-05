export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  createdAt: Date;
  finishedAt?: Date;
  result?: any;
  error?: string;
}
