import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ShellModule } from '../shell/shell.module';
import { TasksModule } from '../tasks/tasks.module';
import { N8nController } from './n8n.controller';
import { N8nService } from './n8n.service';

@Module({
  imports: [ShellModule, HttpModule, TasksModule],
  controllers: [N8nController],
  providers: [N8nService],
})
export class N8nModule {}
