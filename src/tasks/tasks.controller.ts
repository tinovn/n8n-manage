import { Controller, Get, Param } from '@nestjs/common';
import { TasksService } from './tasks.service';

@Controller('api/tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get(':taskId')
  getTaskStatus(@Param('taskId') taskId: string) {
    return this.tasksService.get(taskId);
  }
}
