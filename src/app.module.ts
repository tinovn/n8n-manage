import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ShellModule } from './shell/shell.module';
import { N8nModule } from './n8n/n8n.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [ShellModule, N8nModule, TasksModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
